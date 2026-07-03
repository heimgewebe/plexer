import request from 'supertest';
import { createServer } from '../server';
import { deliverToChronikAgentLedger } from '../chronik';

jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../chronik', () => ({ deliverToChronikAgentLedger: jest.fn() }));

describe('POST /v1/events', () => {
  const app = createServer();
  const deliverMock = deliverToChronikAgentLedger as jest.MockedFunction<typeof deliverToChronikAgentLedger>;

  beforeEach(() => jest.clearAllMocks());

  it('accepts allowed agent run events', async () => {
    deliverMock.mockResolvedValue({ status: 'delivered', retryable: false, statusCode: 202 });
    const event = { kind: 'agent.run.completed', data: { result: 'completed' } };

    const response = await request(app).post('/v1/events').send(event);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ status: 'accepted' });
    expect(deliverMock).toHaveBeenCalledWith(event);
  });

  it('rejects unsupported kinds', async () => {
    const response = await request(app)
      .post('/v1/events')
      .send({ kind: 'repo.review.gate.v1', data: { result: 'ok' } });

    expect(response.status).toBe(422);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('rejects unsupported top-level keys', async () => {
    const response = await request(app)
      .post('/v1/events')
      .send({ kind: 'agent.run.started', extra: 'nope' });

    expect(response.status).toBe(422);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('rejects disallowed data keys', async () => {
    const response = await request(app)
      .post('/v1/events')
      .send({ kind: 'agent.run.started', data: { raw_log: 'nope' } });

    expect(response.status).toBe(422);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('rejects oversized events', async () => {
    const response = await request(app)
      .post('/v1/events')
      .send({ kind: 'agent.run.completed', data: { summary: 'x'.repeat(9000) } });

    expect(response.status).toBe(413);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('maps retryable Chronik failures to 503', async () => {
    deliverMock.mockResolvedValue({ status: 'retryable_failure', retryable: true });

    const response = await request(app)
      .post('/v1/events')
      .send({ kind: 'agent.run.blocked', data: { blocker_code: 'chronik_down' } });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ retryable: true });
  });

  it('maps permanent Chronik failures to 502', async () => {
    deliverMock.mockResolvedValue({ status: 'permanent_failure', retryable: false, statusCode: 400 });

    const response = await request(app)
      .post('/v1/events')
      .send({ kind: 'agent.run.started', data: { summary: 'started' } });

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({ retryable: false });
  });
});
