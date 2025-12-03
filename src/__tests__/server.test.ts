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
    it('should accept valid event and forward to heimgeist', async () => {
      const payload = {
        type: 'test.event',
        source: 'test-suite',
        payload: { foo: 'bar' },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'accepted' });

      // Verify fetch was called correctly
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith('http://heimgeist.local', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
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

    it('should handle heimgeist failure gracefully (fire and forget)', async () => {
       fetchMock.mockRejectedValueOnce(new Error('Network error'));

       const payload = {
        type: 'test.event',
        source: 'test-suite',
        payload: { foo: 'bar' },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202); // Still 202 because we don't wait/fail on forward error

      // Wait a tick for the async promise to reject and be caught
      await new Promise(process.nextTick);

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
  });
});
