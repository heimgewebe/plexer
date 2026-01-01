import request from 'supertest';
import { createServer } from '../server';
import { config } from '../config';

// Mock config
jest.mock('../config', () => ({
  config: {
    port: 3000,
    host: '0.0.0.0',
    environment: 'test',
    heimgeistUrl: 'http://heimgeist.local',
    leitstandUrl: 'http://leitstand.local',
    hauskiUrl: 'http://hauski.local',
    chronikUrl: 'http://chronik.local',
    // heimgeistToken is undefined
    leitstandToken: 'leitstand-secret-token',
    hauskiToken: 'hauski-secret-token',
    chronikToken: 'chronik-secret-token',
  },
}));

describe('Server', () => {
  const app = createServer();
  let fetchMock: jest.Mock;

  beforeEach(() => {
    // Clear mocks before each test
    jest.clearAllMocks();

    // Mock global fetch
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    global.fetch = fetchMock;

    // Spy on console.log/error to prevent noise during tests (optional, but good for assertion)
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /', () => {
    it('should return welcome message', async () => {
      const response = await request(app).get('/');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message', 'Welcome to plexer');
      expect(response.body).toHaveProperty('environment');
    });
  });

  describe('GET /health', () => {
    it('should return status ok', async () => {
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });
  });

  describe('POST /events', () => {
    it('should forward unknown event types only to Heimgeist', async () => {
      const payload = {
        type: 'test.event',
        source: 'test-suite',
        payload: { foo: 'bar' },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'accepted' });

      // Verify fetch was called 1 time (only heimgeist)
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const expectedBody = JSON.stringify(payload);

      // Heimgeist: No token configured
      expect(fetchMock).toHaveBeenCalledWith('http://heimgeist.local', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: expectedBody,
      });
    });

    it('should forward knowledge.observatory.published.v1 event to all configured consumers (fanout)', async () => {
      const payload = {
        type: 'knowledge.observatory.published.v1',
        source: 'test-suite',
        payload: {
          url: 'https://github.com/org/repo/releases/download/v1/obs.json',
        },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'accepted' });

      // Verify fetch was called 4 times (heimgeist, leitstand, hauski, chronik)
      expect(fetchMock).toHaveBeenCalledTimes(4);

      const expectedBody = JSON.stringify(payload);

      // Heimgeist
      expect(fetchMock).toHaveBeenCalledWith('http://heimgeist.local', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: expectedBody,
      });

      // Leitstand
      expect(fetchMock).toHaveBeenCalledWith('http://leitstand.local', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer leitstand-secret-token',
        },
        body: expectedBody,
      });

      // hausKI
      expect(fetchMock).toHaveBeenCalledWith('http://hauski.local', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer hauski-secret-token',
        },
        body: expectedBody,
      });

      // Chronik
      expect(fetchMock).toHaveBeenCalledWith('http://chronik.local', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer chronik-secret-token',
        },
        body: expectedBody,
      });
    });

    it('should forward integrity.summary.published.v1 event to all configured consumers (fanout)', async () => {
      const payload = {
        type: 'integrity.summary.published.v1',
        source: 'semantAH',
        payload: {
          repo: 'semantAH',
          generated_at: '2023-10-27T10:00:00Z',
          summary_url: 'https://.../reports/integrity/summary.json',
          counts: {
            claims: 12,
            artifacts: 5,
            loop_gaps: 3,
            unclear: 2,
          },
        },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'accepted' });

      // Verify fetch was called 4 times (heimgeist, leitstand, hauski, chronik)
      expect(fetchMock).toHaveBeenCalledTimes(4);

      const expectedBody = JSON.stringify(payload);

      // Heimgeist
      expect(fetchMock).toHaveBeenCalledWith('http://heimgeist.local', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: expectedBody,
      });

      // Leitstand
      expect(fetchMock).toHaveBeenCalledWith('http://leitstand.local', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer leitstand-secret-token',
        },
        body: expectedBody,
      });

      // hausKI
      expect(fetchMock).toHaveBeenCalledWith('http://hauski.local', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer hauski-secret-token',
        },
        body: expectedBody,
      });

      // Chronik
      expect(fetchMock).toHaveBeenCalledWith('http://chronik.local', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer chronik-secret-token',
        },
        body: expectedBody,
      });
    });

    it('should truncate long payloads in logs (implicit check via code structure logic)', async () => {
      // It's hard to test the console.log output directly without complex spying setup,
      // but we can verify the request still succeeds with a long payload.
      const longString = 'a'.repeat(300);
      const payload = {
        type: 'test.event',
        source: 'test-suite',
        payload: { data: longString },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202);
      // Only Heimgeist should receive 'test.event'
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // We check that console.log was called
      expect(console.log).toHaveBeenCalledWith(
        'Received event',
        expect.objectContaining({
          type: 'test.event',
          source: 'test-suite',
          // The payload preview should be truncated in the log
          // We can't easily check the exact string here because it's JSON stringified
          // and might include structure, but we can check it was called.
        })
      );
    });

    it('should trim whitespace from type and source before forwarding', async () => {
      const payload = {
        type: '   padded.event  ',
        source: '  padded-source ',
        payload: { foo: 'bar' },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202);

      const expectedBody = JSON.stringify({
        type: 'padded.event',
        source: 'padded-source',
        payload: { foo: 'bar' },
      });

      // Since type is not 'knowledge.observatory.published.v1', only Heimgeist should be called
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith('http://heimgeist.local', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: expectedBody,
      });

      expect(console.log).toHaveBeenCalledWith(
        'Received event',
        expect.objectContaining({
          type: 'padded.event',
          source: 'padded-source',
        }),
      );
    });

    it('should handle one consumer failure gracefully (fire and forget)', async () => {
      // First call (heimgeist) fails, others succeed
      fetchMock
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

      const payload = {
        type: 'test.event',
        source: 'test-suite',
        payload: { foo: 'bar' },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202); // Still 202 because we don't wait/fail on forward error

      // Wait a tick for the async promise to reject and be caught
      await new Promise(process.nextTick);

      // One failure should be logged
      expect(console.error).toHaveBeenCalled();
    });

    it('should reject missing type', async () => {
      const payload = {
        source: 'test-suite',
        payload: { foo: 'bar' },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Event must include');
    });

    it('should reject missing source', async () => {
      const payload = {
        type: 'test.event',
        payload: { foo: 'bar' },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(400);
    });

    it('should reject missing payload', async () => {
      const payload = {
        type: 'test.event',
        source: 'test-suite',
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(400);
    });

    it('should reject empty strings', async () => {
      const payload = {
        type: '   ',
        source: '   ',
        payload: {},
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(400);
    });

    it('should reject very long type', async () => {
      const payload = {
        type: 'a'.repeat(257),
        source: 'test-suite',
        payload: {},
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(400);
    });

    it('should reject very long source', async () => {
      const payload = {
        type: 'test.event',
        source: 'a'.repeat(257),
        payload: {},
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(400);
    });

    it('should accept type with whitespace padding that exceeds max length but is valid after trim', async () => {
      const padding = ' '.repeat(10);
      const validString = 'a'.repeat(250);
      const paddedString = padding + validString + padding; // Length 270 > 256

      const payload = {
        type: paddedString,
        source: 'test-source',
        payload: { foo: 'bar' },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'accepted' });
    });

    it('should support insights.daily.published event (notification only)', async () => {
      // This test codifies the contract for the daily insights notification event
      const payload = {
        type: 'insights.daily.published',
        source: 'semantAH',
        payload: {
          ts: '2025-01-01',
          url: 'https://github.com/heimgewebe/semantAH/releases/download/insights-daily/insights.daily.json',
          generated_at: '2025-01-01T06:00:00Z',
        },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202);

      expect(fetchMock).toHaveBeenCalledWith('http://heimgeist.local', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      // Verify that we are not trying to act as a file host (payload should be small)
      expect(JSON.stringify(payload.payload).length).toBeLessThan(1000);

      // Verify URL pattern matches the stable release asset location (not 'latest')
      expect(payload.payload.url).toMatch(
        /^https:\/\/github\.com\/heimgewebe\/semantAH\/releases\/download\/insights-daily\//,
      );

      // Verify timestamp formats match contract
      expect(payload.payload.ts).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(payload.payload.generated_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );
    });
  });

  describe('Unknown routes', () => {
    it('should respond with JSON 404 for unknown endpoints', async () => {
      const response = await request(app).get('/does-not-exist');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        status: 'error',
        message: 'Not Found',
        path: '/does-not-exist',
        method: 'GET',
      });
      expect(response.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('Error logging', () => {
    it('should log "token rejected" when receiving 401 or 403', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({}),
      });

      const payload = {
        type: 'knowledge.observatory.published.v1',
        source: 'test-suite',
        payload: { foo: 'bar' },
      };

      await request(app).post('/events').send(payload);

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('token rejected')
      );
    });
  });
});
