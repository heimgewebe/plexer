import request from 'supertest';
import { createServer } from '../server';
import { deliverToChronikAgentLedger } from '../chronik';
import { saveFailedChronikAgentLedgerEvent } from '../delivery';

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../chronik', () => ({ deliverToChronikAgentLedger: jest.fn() }));
jest.mock('../delivery', () => ({
  saveFailedEvent: jest.fn().mockResolvedValue(undefined),
  saveFailedChronikAgentLedgerEvent: jest.fn().mockResolvedValue(undefined),
  getDeliveryMetrics: jest.fn(),
  validateDeliveryReport: jest.fn(),
  validateEventEnvelope: jest.fn(),
}));

describe('POST /v1/events', () => {
  const app = createServer();
  const deliverMock = deliverToChronikAgentLedger as jest.MockedFunction<typeof deliverToChronikAgentLedger>;
  const saveMock = saveFailedChronikAgentLedgerEvent as jest.MockedFunction<typeof saveFailedChronikAgentLedgerEvent>;

  beforeEach(() => jest.clearAllMocks());

  it('accepts allowed events', async () => {
    deliverMock.mockResolvedValue({ status: 'delivered', retryable: false, statusCode: 202 });
    const event = { kind: 'agent.run.completed', data: { result: 'completed' } };
    const response = await request(app).post('/v1/events').send(event);
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: 'accepted' });
    expect(deliverMock).toHaveBeenCalledWith(event);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('rejects unsupported kinds', async () => {
    const response = await request(app).post('/v1/events').send({ kind: 'repo.review.gate.v1' });
    expect(response.status).toBe(422);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('rejects unsupported top level keys', async () => {
    const response = await request(app).post('/v1/events').send({ kind: 'agent.run.started', extra: 'x' });
    expect(response.status).toBe(422);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('rejects invalid reference shapes', async () => {
    const response = await request(app).post('/v1/events').send({ kind: 'agent.run.completed', evidence_refs: [{ detail: 'x' }] });
    expect(response.status).toBe(422);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('rejects invalid data values', async () => {
    const response = await request(app).post('/v1/events').send({ kind: 'agent.run.completed', data: { summary: 123 } });
    expect(response.status).toBe(422);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('queues retryable delivery failures', async () => {
    deliverMock.mockResolvedValue({ status: 'retryable_failure', retryable: true, error: 'retry' });
    const event = { kind: 'agent.run.blocked', data: { blocker_code: 'chronik_down' } };
    const response = await request(app).post('/v1/events').send(event);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: 'queued', retryable: true });
    expect(saveMock).toHaveBeenCalledWith(event, 'retry');
  });

  it('maps permanent delivery failures to 502', async () => {
    deliverMock.mockResolvedValue({ status: 'permanent_failure', retryable: false, statusCode: 400 });
    const response = await request(app).post('/v1/events').send({ kind: 'agent.run.started', data: { summary: 'started' } });
    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({ retryable: false });
    expect(saveMock).not.toHaveBeenCalled();
  });
});
