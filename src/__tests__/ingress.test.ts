import request from 'supertest';

const mockConfig: Record<string, unknown> = {
  environment: 'test',
  plexerToken: 'ingress-secret-token',
  dataDir: 'data',
  ingressRateWindowMs: 60_000,
  ingressPerClientRateLimit: 20,
  ingressGlobalRateLimit: 20,
  ingressPerClientMaxInFlight: 2,
  ingressGlobalMaxInFlight: 4,
  ingressMaxClients: 8,
};

jest.mock('../config', () => ({ config: mockConfig }));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../chronik', () => ({ deliverToChronikAgentLedger: jest.fn() }));
jest.mock('../delivery', () => {
  const actual = jest.requireActual('../delivery');
  return {
    saveFailedEvent: jest.fn().mockResolvedValue({ status: 'persisted' }),
    saveFailedChronikAgentLedgerEvent: jest.fn().mockResolvedValue({ status: 'persisted' }),
    getDeliveryMetrics: jest.fn().mockReturnValue({
      counts: { pending: 0, failed: 0 },
      last_error: null,
      last_retry_at: null,
      retryable_now: 0,
      next_due_at: null,
    }),
    getCriticalSinkReadiness: jest.fn().mockReturnValue({ status: 'ready' }),
    validateDeliveryReport: jest.fn().mockReturnValue(true),
    validateEventEnvelope: actual.validateEventEnvelope,
  };
});

import { createServer } from '../server';
import { deliverToChronikAgentLedger } from '../chronik';
import { logger } from '../logger';
import {
  BoundedIngressRateLimitStore,
  hasValidBearerAuthorization,
  IngressAdmissionController,
} from '../ingress';

const deliverMock = deliverToChronikAgentLedger as jest.MockedFunction<
  typeof deliverToChronikAgentLedger
>;
const AUTH = 'Bearer ingress-secret-token';

describe('Ingress authentication and admission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockConfig, {
      plexerToken: 'ingress-secret-token',
      ingressRateWindowMs: 60_000,
      ingressPerClientRateLimit: 20,
      ingressGlobalRateLimit: 20,
      ingressPerClientMaxInFlight: 2,
      ingressGlobalMaxInFlight: 4,
      ingressMaxClients: 8,
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
    deliverMock.mockResolvedValue({ status: 'delivered', retryable: false, statusCode: 202 });
  });

  it('accepts the established Authorization Bearer contract on both ingress routes', async () => {
    const app = createServer();
    const legacy = await request(app)
      .post('/events')
      .set('Authorization', AUTH)
      .send({ type: 'test.event', source: 'producer', payload: {} });
    const v1 = await request(app)
      .post('/v1/events')
      .set('Authorization', AUTH)
      .send({ kind: 'agent.run.completed', data: { result: 'completed' } });

    expect(legacy.status).toBe(202);
    expect(v1.status).toBe(202);
  });

  it.each([
    ['missing authorization', undefined, undefined],
    ['wrong bearer token', 'Authorization', 'Bearer wrong-token'],
    ['X-Auth compatibility is disabled', 'X-Auth', 'ingress-secret-token'],
  ])('fails closed for %s', async (_label, header, value) => {
    const app = createServer();
    let test = request(app).post('/events');
    if (header && value) test = test.set(header, value);
    const response = await test.send({ type: 'test.event', source: 'producer', payload: {} });

    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.body).toMatchObject({ retryable: false });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('ingress-secret-token');
  });

  it('returns a retryable service error when ingress auth is unconfigured', async () => {
    mockConfig.plexerToken = undefined;
    const app = createServer();
    const response = await request(app)
      .post('/events')
      .set('Authorization', AUTH)
      .send({ type: 'test.event', source: 'producer', payload: {} });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ retryable: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns deterministic 429 and Retry-After when the fixed-window rate is exceeded', async () => {
    Object.assign(mockConfig, {
      ingressPerClientRateLimit: 2,
      ingressGlobalRateLimit: 2,
    });
    const app = createServer();
    const payload = { type: 'test.event', source: 'producer', payload: {} };
    expect((await request(app).post('/events').set('Authorization', AUTH).send(payload)).status).toBe(202);
    expect((await request(app).post('/events').set('Authorization', AUTH).send(payload)).status).toBe(202);

    const excess = await request(app).post('/events').set('Authorization', AUTH).send(payload);
    expect(excess.status).toBe(429);
    expect(Number(excess.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(excess.body).toEqual({
      status: 'error',
      message: 'Too Many Requests',
      retryable: true,
      retry_after_seconds: Number(excess.headers['retry-after']),
      reason: 'rate_limit',
    });
  });

  it('applies per-client in-flight backpressure without accepting unbounded work', async () => {
    Object.assign(mockConfig, {
      ingressPerClientMaxInFlight: 1,
      ingressGlobalMaxInFlight: 1,
    });
    let releaseDelivery!: () => void;
    deliverMock.mockImplementation(() => new Promise((resolve) => {
      releaseDelivery = () => resolve({ status: 'delivered', retryable: false, statusCode: 202 });
    }));
    const app = createServer();
    const event = { kind: 'agent.run.completed', data: { result: 'completed' } };
    const first = request(app)
      .post('/v1/events')
      .set('Authorization', AUTH)
      .send(event)
      .then((response) => response);

    while (deliverMock.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const second = await request(app)
      .post('/v1/events')
      .set('Authorization', AUTH)
      .send(event);
    expect(second.status).toBe(429);
    expect(second.body.reason).toBe('backpressure');
    expect(second.headers['retry-after']).toBe('1');

    releaseDelivery();
    expect((await first).status).toBe(202);
  });
});

describe('Ingress admission controller bounds', () => {
  const limits = {
    windowMs: 1_000,
    perClientRateLimit: 2,
    globalRateLimit: 3,
    perClientMaxInFlight: 1,
    globalMaxInFlight: 2,
    maxClients: 1,
  };

  it('keeps client tracking bounded and reuses capacity after a window expires', () => {
    const controller = new IngressAdmissionController(limits);
    expect(controller.admitRate('client-a', 100)).toEqual({ accepted: true });
    expect(controller.admitRate('client-b', 100)).toMatchObject({
      accepted: false,
      reason: 'client_capacity',
      retryAfterSeconds: 1,
    });
    expect(controller.getClientStateCount()).toBe(1);

    expect(controller.admitRate('client-b', 1_000)).toEqual({ accepted: true });
    expect(controller.getClientStateCount()).toBe(1);
  });

  it('compares only a well-formed Bearer credential', () => {
    expect(hasValidBearerAuthorization('Bearer token', 'token')).toBe(true);
    expect(hasValidBearerAuthorization('bearer token', 'token')).toBe(true);
    expect(hasValidBearerAuthorization('Bearer token extra', 'token')).toBe(false);
    expect(hasValidBearerAuthorization('token', 'token')).toBe(false);
    expect(hasValidBearerAuthorization(undefined, 'token')).toBe(false);
  });

  it('adapts global rejection to the recognized rate-limit store contract', () => {
    const controller = new IngressAdmissionController({
      ...limits,
      perClientRateLimit: 5,
      globalRateLimit: 2,
      maxClients: 2,
    });
    const store = new BoundedIngressRateLimitStore(controller);
    expect(store.increment('client-a').totalHits).toBe(1);
    expect(store.increment('client-b').totalHits).toBe(1);
    // Global capacity is exhausted although client-a remains below its own 5.
    expect(store.increment('client-a').totalHits).toBe(6);
  });
});
