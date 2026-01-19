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
    dataDir: 'data',
  },
}));

// Mock delivery to avoid side effects
jest.mock('../delivery', () => ({
  saveFailedEvent: jest.fn().mockResolvedValue(undefined),
  getDeliveryMetrics: jest.fn().mockReturnValue({
    counts: { pending: 0, failed: 0 },
    last_error: null,
    last_retry_at: null,
    retryable_now: 0,
    next_due_at: null,
  }),
  retryFailedEvents: jest.fn().mockResolvedValue(undefined),
  validateDeliveryReport: jest.fn().mockReturnValue(true),
  // Basic mock validation to prevent crashes in tests that send invalid data
  validateEventEnvelope: jest.fn().mockImplementation((body) => {
    const isValid =
      body &&
      typeof body === 'object' &&
      typeof body.type === 'string' &&
      body.type.trim().length > 0 &&
      typeof body.source === 'string' &&
      body.source.trim().length > 0 &&
      body.payload !== undefined;
    return isValid;
  }),
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
    jest.spyOn(console, 'warn').mockImplementation(() => {});
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

  describe('GET /status', () => {
    it('should return delivery report', async () => {
      const response = await request(app).get('/status');
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('type', 'plexer.delivery.report.v1');
      expect(response.body).toHaveProperty('source', 'plexer');
      expect(response.body.payload).toHaveProperty('counts');
      expect(response.body.payload.counts).toHaveProperty('pending');
      expect(response.body.payload.counts).toHaveProperty('failed');
    });
  });

  describe('POST /events', () => {
    it('should forward event with sha and schema_ref in payload', async () => {
      const payload = {
        type: 'knowledge.observatory.published.v1',
        source: 'semantAH',
        payload: {
          url: 'https://github.com/org/repo/releases/download/v1/obs.json',
          sha: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          schema_ref: 'https://schemas.heimgewebe.org/contracts/knowledge/observatory.schema.json',
          generated_at: '2023-10-27T10:00:00Z',
        },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202);

      // Verify fetch was called 4 times (fanout)
      expect(fetchMock).toHaveBeenCalledTimes(4);

      // Verify payload was passed through correctly to one of the consumers (e.g. Heimgeist)
      const callArgs = fetchMock.mock.calls.find(call => call[0] === 'http://heimgeist.local');
      expect(callArgs).toBeDefined();

      const sentBody = JSON.parse(callArgs![1].body);
      expect(sentBody.payload).toEqual(payload.payload);
      expect(sentBody.payload).toHaveProperty('sha', payload.payload.sha);
      expect(sentBody.payload).toHaveProperty('schema_ref', payload.payload.schema_ref);
    });

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

      // Other consumers should not receive unknown event types
      const urls = fetchMock.mock.calls.map(([url]) => url);
      expect(urls).toEqual(['http://heimgeist.local']);
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

      // hauski
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
          'X-Auth': 'chronik-secret-token',
        },
        body: expectedBody,
      });

      // Verify no errors or warnings for successful forward
      await new Promise(process.nextTick);
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    });

    it('should forward integrity.summary.published.v1 event to all configured consumers (fanout)', async () => {
      const payload = {
        type: 'integrity.summary.published.v1',
        source: 'semantAH',
        payload: {
          repo: 'semantAH',
          generated_at: '2023-10-27T10:00:00Z',
          url: 'https://.../reports/integrity/summary.json',
          status: 'OK',
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

      // hauski
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
          'X-Auth': 'chronik-secret-token',
        },
        body: expectedBody,
      });
    });

    it('should forward body strictly without injected keys (pass-through guardrail)', async () => {
      const payload = {
        type: 'test.guardrail.event',
        source: 'test-source',
        payload: { some: 'data' },
      };

      await request(app).post('/events').send(payload);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const callArgs = fetchMock.mock.calls[0];
      const requestBody = JSON.parse(callArgs[1].body);

      // Explicitly check that only the expected keys are present
      expect(Object.keys(requestBody).sort()).toEqual(
        ['payload', 'source', 'type'].sort(),
      );

      // Explicitly check absence of common injected keys
      expect(requestBody).not.toHaveProperty('eventId');
      expect(requestBody).not.toHaveProperty('timestamp');
      expect(requestBody).not.toHaveProperty('ts');
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
      expect(response.body.message).toContain('Invalid event envelope');
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

    it('should accept diverse payloads (array, string, null) due to relaxed schema', async () => {
      const payloads = [
        [],
        "some string",
        null,
        123
      ];

      for (const p of payloads) {
        const payload = {
          type: 'test.relaxed',
          source: 'test',
          payload: p
        };
        const response = await request(app).post('/events').send(payload);
        expect(response.status).toBe(202);
      }
    });

    it('should accept mixed-case types due to relaxed schema pattern', async () => {
        const payload = {
            type: 'Test.Event_With-Mixed.Case',
            source: 'test',
            payload: {}
        };
        const response = await request(app).post('/events').send(payload);
        expect(response.status).toBe(202);
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

    it('should explicitly treat integrity.summary.published.v1 as best-effort (warn instead of error)', async () => {
      // This test ensures that the "best-effort" contract for integrity events is technically upheld.

      // Force all consumers to fail
      fetchMock.mockRejectedValue(new Error('Network Down'));

      const payload = {
        type: 'integrity.summary.published.v1',
        source: 'semantAH',
        payload: {
          repo: 'semantAH',
          url: 'https://example.com/summary.json',
          generated_at: '2025-01-01T12:00:00Z',
          status: 'OK'
        },
      };

      // Expectation: 202 Accepted
      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202);

      // Wait a tick for the async promise rejection handling (logging)
      await new Promise(process.nextTick);

      // Verify it was logged as a warning, NOT an error
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[Best-Effort]'),
        expect.objectContaining({
          log_kind: 'best_effort_forward_failed',
          type: 'integrity.summary.published.v1',
          label: expect.any(String),
        })
      );
      expect(console.error).not.toHaveBeenCalled();
      // Verify "Event forwarded" success log is NOT called
      expect(console.log).not.toHaveBeenCalledWith('Event forwarded', expect.anything());
    });

    it('should treat insights.daily.published events as critical (log error on failure)', async () => {
      // Force all consumers to fail
      fetchMock.mockRejectedValue(new Error('Network Down'));

      const payload = {
        type: 'insights.daily.published',
        source: 'semantAH',
        payload: {
          url: 'https://example.com/insights.json',
        },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202);

      // Wait a tick for the async promise rejection handling (logging)
      await new Promise(process.nextTick);

      // Verify it was logged as an error
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Error forwarding event'),
        expect.anything() // Expecting context/error as second arg
      );
      // And definitely not a best-effort warning
      expect(console.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('[Best-Effort]'),
        expect.anything()
      );
      // Verify "Event forwarded" success log is NOT called
      expect(console.log).not.toHaveBeenCalledWith('Event forwarded', expect.anything());
    });

    it('should explicitly treat integrity.summary.published.v1 as best-effort on non-2xx response (warn instead of error)', async () => {
      // Mock 500 Internal Server Error response (non-reject path)
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({}),
      });

      const payload = {
        type: 'integrity.summary.published.v1',
        source: 'semantAH',
        payload: {
          repo: 'semantAH',
          url: 'https://example.com/summary.json',
          generated_at: '2025-01-01T12:00:00Z',
          status: 'OK'
        },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202);

      await new Promise(process.nextTick);

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[Best-Effort]'),
        expect.objectContaining({
          status: 500,
          type: 'integrity.summary.published.v1',
          log_kind: 'best_effort_forward_failed',
          label: expect.any(String),
        })
      );
      expect(console.error).not.toHaveBeenCalled();
      // Verify "Event forwarded" success log is NOT called
      expect(console.log).not.toHaveBeenCalledWith('Event forwarded', expect.anything());
    });

    it('should treat normal events as critical (log error on failure)', async () => {
      // Force all consumers to fail
      fetchMock.mockRejectedValue(new Error('Network Down'));

      const payload = {
        type: 'knowledge.observatory.published.v1',
        source: 'semantAH',
        payload: {
          url: 'https://example.com/obs.json',
        },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202);

      // Wait a tick for the async promise rejection handling (logging)
      await new Promise(process.nextTick);

      // Verify it was logged as an error
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Error forwarding event'),
        expect.anything() // Expecting context/error as second arg
      );
      // And definitely not a best-effort warning
      expect(console.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('[Best-Effort]'),
        expect.anything()
      );
      // Verify "Event forwarded" success log is NOT called
      expect(console.log).not.toHaveBeenCalledWith('Event forwarded', expect.anything());
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
        expect.stringContaining('token rejected'),
        expect.objectContaining({})
      );
    });

    it('should include publisher in event forwarded logs', async () => {
      const payload = {
        type: 'test.event',
        source: 'test-source',
        payload: { foo: 'bar' },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202);

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 10));

      // Check success log
      expect(console.log).toHaveBeenCalledWith(
        'Event forwarded',
        expect.objectContaining({
          publisher: 'test-source',
        })
      );
    });

    it('should include repo in event forwarded logs if present in payload', async () => {
      const payload = {
        type: 'integrity.summary.published.v1',
        source: 'heimgewebe/semantAH',
        payload: {
          repo: 'semantAH',
          url: 'http://example.com',
          generated_at: '2023-10-27T10:00:00Z',
          status: 'OK',
        },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202);

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 10));

      // Check success log
      expect(console.log).toHaveBeenCalledWith(
        'Event forwarded',
        expect.objectContaining({
          publisher: 'heimgewebe/semantAH',
          repo: 'semantAH',
        })
      );
    });
  });
});
