import request from 'supertest';
import { createServer } from '../server';
import { validateEventEnvelope } from '../delivery';

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

describe('Error Handling', () => {
  const app = createServer();

  beforeEach(() => {
    jest.clearAllMocks();
    // Silence console.error for expected errors
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return 400 Bad Request for invalid JSON', async () => {
    const response = await request(app)
      .post('/events')
      .set('Content-Type', 'application/json')
      .send('{ "invalid": json, }');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      status: 'error',
      message: 'Invalid JSON',
    });
  });

  it('should return 500 for actual internal errors', async () => {
    // We can simulate an internal error by mocking the route logic or causing a crash
    // Since we mocked validateEventEnvelope, we can make it throw
    (validateEventEnvelope as unknown as jest.Mock).mockImplementationOnce(() => {
      throw new Error('Simulated Crash');
    });

    const response = await request(app)
      .post('/events')
      .set('Content-Type', 'application/json')
      .send({
        type: 'test.event',
        source: 'test',
        payload: { foo: 'bar' }
      });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      status: 'error',
      message: 'Internal Server Error',
    });
  });
});
