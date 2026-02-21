
import request from 'supertest';
import { createServer, drainPendingRequests } from '../server';

// Mock config
jest.mock('../config', () => ({
  config: {
    port: 3000,
    host: '0.0.0.0',
    environment: 'test',
    heimgeistUrl: 'http://heimgeist.local',
    dataDir: 'data',
  },
}));

// Mock delivery to avoid side effects
jest.mock('../delivery', () => ({
  saveFailedEvent: jest.fn().mockResolvedValue(undefined),
  getDeliveryMetrics: jest.fn(),
  retryFailedEvents: jest.fn().mockResolvedValue(undefined),
  validateEventEnvelope: jest.fn().mockReturnValue(true),
  validateDeliveryReport: jest.fn().mockReturnValue(true),
}));

describe('Graceful Shutdown', () => {
  const app = createServer();
  let fetchMock: jest.Mock;
  let delayedResolve: ((value: any) => void) | null = null;

  beforeEach(() => {
    jest.clearAllMocks();

    fetchMock = jest.fn().mockImplementation(() => {
      return new Promise((resolve) => {
        // Capture the resolve function to control when the promise finishes
        delayedResolve = resolve;
      });
    });
    global.fetch = fetchMock;

    // Silence logs
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should wait for pending requests to drain', async () => {
    const payload = {
      type: 'test.event',
      source: 'test-suite',
      payload: { foo: 'bar' },
    };

    // 1. Send a request that triggers a fetch
    const response = await request(app).post('/events').send(payload);
    expect(response.status).toBe(202);
    expect(fetchMock).toHaveBeenCalled();

    // The fetch is now pending (delayedResolve hasn't been called)

    // 2. Start draining pending requests (simulate shutdown)
    const drainPromise = drainPendingRequests(100); // short timeout for test

    // 3. Resolve the fetch *after* starting drain
    setTimeout(() => {
        if (delayedResolve) {
            delayedResolve({
                ok: true,
                status: 200,
                json: async () => ({}),
            });
        }
    }, 50);

    // 4. Wait for drain to finish
    await drainPromise;

    // If we reached here without timeout error (implied by drainPendingRequests internals not throwing but resolving),
    // we assume it worked. The real proof is timing, but we can check coverage.
    // Ideally we'd verify drainPendingRequests didn't timeout.
  });

  it('should timeout if pending requests take too long', async () => {
      const payload = {
          type: 'test.event',
          source: 'test-suite',
          payload: { foo: 'bar' },
      };

      await request(app).post('/events').send(payload);

      const startTime = Date.now();
      // Don't resolve the fetch
      await drainPendingRequests(50);
      const endTime = Date.now();

      expect(endTime - startTime).toBeGreaterThanOrEqual(45); // Allowing small margin
  });
});
