import request from 'supertest';
import { createServer } from '../server';

describe('Server', () => {
  const app = createServer();

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
    it('should accept valid event', async () => {
      const payload = {
        type: 'test.event',
        source: 'test-suite',
        payload: { foo: 'bar' },
      };

      const response = await request(app).post('/events').send(payload);
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: 'accepted' });
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
  });
});
