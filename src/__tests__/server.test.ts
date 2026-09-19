import request from 'supertest';
import { createServer, processEvent } from '../server';
import { config } from '../config';

// Mock logger
jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
import { logger } from '../logger';

// Mock config
jest.mock('../config', () => ({
  config: {
    port: 3000,
    host: '0.0.0.0',
    environment: 'test',
    plexerToken: 'test-plexer-token',
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
jest.mock('../delivery', () => {
  const actual = jest.requireActual('../delivery');
  return {
    saveFailedEvent: jest.fn().mockResolvedValue({ status: 'persisted' }),
    getDeliveryMetrics: jest.fn().mockReturnValue({
      counts: { pending: 0, failed: 0 },
      last_error: null,
      last_retry_at: null,
      retryable_now: 0,
      next_due_at: null,
    }),
    retryFailedEvents: jest.fn().mockResolvedValue(undefined),
    validateDeliveryReport: jest.fn().mockReturnValue(true),
    // Use the real validator so this test always reflects the actual schema — no manual drift.
    validateEventEnvelope: actual.validateEventEnvelope,
  };
});

describe('Server', () => {
  const app = createServer();
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock global fetch
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    global.fetch = fetchMock;
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

  describe('processEvent', () => {
    it('should process event correctly (internal logic)', async () => {
        const event = {
            type: 'test.internal',
            source: 'test',
            payload: {}
        };
        // Verify it resolves successfully
        await expect(processEvent(event)).resolves.toBeUndefined();
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
          schema_ref: 'https://schemas.heimgewebe.org/contracts/knowledge.observatory.schema.json',
          generated_at: '2023-10-27T10:00:00Z',
        },
      };

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(202);
      await new Promise(process.nextTick);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const callArgs = fetchMock.mock.calls.find(call => call[0] === 'http://leitstand.local');
      expect(callArgs).toBeDefined();

      const sentBody = JSON.parse(callArgs![1].body);
      expect(sentBody.payload).toEqual(payload.payload);
      expect(sentBody.payload).toHaveProperty('sha', payload.payload.sha);
      expect(sentBody.payload).toHaveProperty('schema_ref', payload.payload.schema_ref);
      expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual(
        ['http://chronik.local', 'http://leitstand.local'].sort(),
      );
    });
    it('should not implicitly forward unknown event types after deleted-consumer cutover', async () => {
      const payload = {
        type: 'test.event',
        source: 'test-suite',
        payload: { foo: 'bar' },
      };

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'accepted' });
      await new Promise(process.nextTick);

      expect(fetchMock).not.toHaveBeenCalled();
    });
    it('should forward knowledge.observatory.published.v1 only to surviving configured consumers', async () => {
      const payload = {
        type: 'knowledge.observatory.published.v1',
        source: 'test-suite',
        payload: {
          url: 'https://github.com/org/repo/releases/download/v1/obs.json',
        },
      };

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'accepted' });
      await new Promise(process.nextTick);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const expectedBody = JSON.stringify(payload);
      expect(fetchMock).toHaveBeenCalledWith('http://leitstand.local', expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer leitstand-secret-token',
        },
        body: expectedBody,
      }));
      expect(fetchMock).toHaveBeenCalledWith('http://chronik.local', expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth': 'chronik-secret-token',
        },
        body: expectedBody,
      }));
      const urls = fetchMock.mock.calls.map(([url]) => url);
      expect(urls).not.toContain('http://heimgeist.local');
      expect(urls).not.toContain('http://hauski.local');
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });
    it('should forward integrity.summary.published.v1 only to surviving configured consumers', async () => {
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

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'accepted' });
      await new Promise(process.nextTick);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const expectedBody = JSON.stringify(payload);
      expect(fetchMock).toHaveBeenCalledWith('http://leitstand.local', expect.objectContaining({
        body: expectedBody,
      }));
      expect(fetchMock).toHaveBeenCalledWith('http://chronik.local', expect.objectContaining({
        body: expectedBody,
      }));
      const urls = fetchMock.mock.calls.map(([url]) => url);
      expect(urls).not.toContain('http://heimgeist.local');
      expect(urls).not.toContain('http://hauski.local');
    });
    it('should forward body strictly without injected keys (pass-through guardrail)', async () => {
      const payload = {
        type: 'knowledge.observatory.published.v1',
        source: 'test-source',
        payload: { some: 'data' },
      };

      await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      await new Promise(process.nextTick);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const callArgs = fetchMock.mock.calls.find(call => call[0] === 'http://leitstand.local');
      expect(callArgs).toBeDefined();
      const requestBody = JSON.parse(callArgs![1].body);

      expect(Object.keys(requestBody).sort()).toEqual(
        ['payload', 'source', 'type'].sort(),
      );
      expect(requestBody).not.toHaveProperty('eventId');
      expect(requestBody).not.toHaveProperty('timestamp');
      expect(requestBody).not.toHaveProperty('ts');
    });
    it('should log payload size instead of preview in Received event', async () => {
      const payload = {
        type: 'test.event',
        source: 'test-suite',
        payload: { data: 'a'.repeat(300) },
      };

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(202);
      await new Promise(process.nextTick);
      expect(fetchMock).not.toHaveBeenCalled();

      const calls = (logger.info as jest.Mock).mock.calls;
      const receivedEventLog = calls.find(args => args[1] === 'Received event');
      expect(receivedEventLog).toBeDefined();
      const logContext = receivedEventLog![0];
      expect(logContext.type).toBe('test.event');
      expect(logContext.source).toBe('test-suite');
      expect(logContext.payload_size).toBeGreaterThan(300);
      expect(logContext.payload_size_kind).toBe('json');
      expect(logContext.payload).toBeUndefined();
    });
    it('should log payload_size as null and kind as unavailable for non-JSON payloads', async () => {
      // Bypassing body parsing to test the internal processEvent logic with a function
      const payloadWithFunction = {
        type: 'test.unsafe',
        source: 'test',
        payload: () => {}, // JSON.stringify returns undefined
      };

      // @ts-ignore
      await processEvent(payloadWithFunction);

      const calls = (logger.info as jest.Mock).mock.calls;
      const receivedEventLog = calls.find(args => args[1] === 'Received event');
      expect(receivedEventLog).toBeDefined();

      const logContext = receivedEventLog![0];
      expect(logContext.payload_size).toBeNull();
      expect(logContext.payload_size_kind).toBe('unavailable');
    });

    it('should trim whitespace from type and source before routing', async () => {
      const payload = {
        type: '   padded.event  ',
        source: '  padded-source ',
        payload: { foo: 'bar' },
      };

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(202);
      await new Promise(process.nextTick);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'padded.event',
          source: 'padded-source',
        }),
        'Received event',
      );
    });
    it('should handle one surviving consumer failure gracefully (fire and forget)', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

      const payload = {
        type: 'knowledge.observatory.published.v1',
        source: 'test-suite',
        payload: { foo: 'bar' },
      };

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(202);
      await new Promise(process.nextTick);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ log_kind: 'best_effort_forward_failed' }),
        expect.stringContaining('[Best-Effort]'),
      );
      expect(logger.error).not.toHaveBeenCalled();
    });
    it('should reject missing type', async () => {
      const payload = {
        source: 'test-suite',
        payload: { foo: 'bar' },
      };

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Type and source must be strings');
    });

    it('should reject missing source', async () => {
      const payload = {
        type: 'test.event',
        payload: { foo: 'bar' },
      };

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Type and source must be strings');
    });

    it('should reject missing payload', async () => {
      const payload = {
        type: 'test.event',
        source: 'test-suite',
      };

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(400);
    });

    it('should reject empty strings', async () => {
      const payload = {
        type: '   ',
        source: '   ',
        payload: {},
      };

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(400);
    });

    it('should reject very long type', async () => {
      const payload = {
        type: 'a'.repeat(257),
        source: 'test-suite',
        payload: {},
      };

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(400);
    });

    it('should reject very long source', async () => {
      const payload = {
        type: 'test.event',
        source: 'a'.repeat(257),
        payload: {},
      };

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(400);
    });

    it('should reject type with characters forbidden by schema pattern (e.g. slash)', async () => {
      // The real validator enforces ^[A-Za-z0-9._-]+$ on the normalised type.
      // The old partial mock only checked non-empty + maxLength and would have accepted this.
      const payload = {
        type: 'bad/type',
        source: 'test-suite',
        payload: {},
      };

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Invalid event envelope');
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

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
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
        const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
        expect(response.status).toBe(202);
      }
    });

    it('should normalize mixed-case broadcast types to lowercase', async () => {
      const payload = {
        type: 'Knowledge.Observatory.Published.V1',
        source: 'test',
        payload: {},
      };

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(202);
      await new Promise(process.nextTick);

      const callArgs = fetchMock.mock.calls.find(call => call[0] === 'http://leitstand.local');
      expect(callArgs).toBeDefined();
      const sentBody = JSON.parse(callArgs![1].body);
      expect(sentBody.type).toBe('knowledge.observatory.published.v1');
    });
    it('should accept insights.daily.published without resurrecting a deleted implicit consumer', async () => {
      const payload = {
        type: 'insights.daily.published',
        source: 'semantAH',
        payload: {
          ts: '2025-01-01',
          url: 'https://github.com/heimgewebe/semantAH/releases/download/insights-daily/insights.daily.json',
          generated_at: '2025-01-01T06:00:00Z',
        },
      };

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(202);
      await new Promise(process.nextTick);
      expect(fetchMock).not.toHaveBeenCalled();

      expect(JSON.stringify(payload.payload).length).toBeLessThan(1000);
      expect(payload.payload.url).toMatch(
        /^https:\/\/github\.com\/heimgewebe\/semantAH\/releases\/download\/insights-daily\//,
      );
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
      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(202);

      // Wait a tick for the async promise rejection handling (logging)
      await new Promise(process.nextTick);

      // Verify it was logged as a warning, NOT an error
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          log_kind: 'best_effort_forward_failed',
          type: 'integrity.summary.published.v1',
          label: expect.any(String),
        }),
        expect.stringContaining('[Best-Effort]')
      );
      expect(logger.error).not.toHaveBeenCalled();
      // Verify "Event forwarded" success log is NOT called
      expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), 'Event forwarded');
    });

    it('should not resurrect a retired critical consumer for insights.daily.published', async () => {
      fetchMock.mockRejectedValue(new Error('Network Down'));
      const payload = {
        type: 'insights.daily.published',
        source: 'semantAH',
        payload: { url: 'https://example.com/insights.json' },
      };

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(202);
      await new Promise(process.nextTick);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('[Best-Effort]'),
      );
      expect(logger.error).not.toHaveBeenCalled();
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

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(202);

      await new Promise(process.nextTick);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 500,
          type: 'integrity.summary.published.v1',
          log_kind: 'best_effort_forward_failed',
          label: expect.any(String),
        }),
        expect.stringContaining('[Best-Effort]')
      );
      expect(logger.error).not.toHaveBeenCalled();
      // Verify "Event forwarded" success log is NOT called
      expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), 'Event forwarded');
    });

    it('should drop and log error for events with non-JSON-encodable payloads (e.g. functions)', async () => {
      // Ensure mock state is clean for this test
      fetchMock.mockClear();

      // We can't send a function over HTTP JSON, so we have to bypass supertest/express body parsing
      // and call processEvent directly to test this edge case in the logic layer.
      const payloadWithFunction = {
        type: 'test.unsafe',
        source: 'test',
        payload: () => {}, // JSON.stringify returns undefined
      };

      // @ts-ignore - explicitly testing invalid payload type
      await processEvent(payloadWithFunction);

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          payloadType: 'function',
        }),
        expect.stringContaining('Payload serialized to undefined; dropping event')
      );

      // Verify no fetch was attempted
      expect(fetchMock).not.toHaveBeenCalled();
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
    it('should log "token rejected" as a best-effort warning for surviving observers', async () => {
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

      await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ log_kind: 'best_effort_forward_failed' }),
        expect.stringContaining('token rejected'),
      );
      expect(logger.error).not.toHaveBeenCalled();
    });
    it('should include publisher in surviving broadcast success logs', async () => {
      const payload = {
        type: 'knowledge.observatory.published.v1',
        source: 'test-source',
        payload: { foo: 'bar' },
      };

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(202);
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          publisher: 'test-source',
        }),
        'Event forwarded',
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

      const response = await request(app).post('/events').set('Authorization', 'Bearer test-plexer-token').send(payload);
      expect(response.status).toBe(202);

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 10));

      // Check success log
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          publisher: 'heimgewebe/semantAH',
          repo: 'semantAH',
        }),
        'Event forwarded'
      );
    });
  });
});
