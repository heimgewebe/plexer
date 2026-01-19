import fs from 'fs/promises';
import { saveFailedEvent, getDeliveryMetrics } from '../delivery';

// Mock fs
jest.mock('fs/promises');

// Mock proper-lockfile
jest.mock('proper-lockfile', () => ({
  lock: jest.fn().mockResolvedValue(() => Promise.resolve()),
}));

// Mock consumers
jest.mock('../consumers', () => ({
  CONSUMERS: [
    { key: 'test-consumer', label: 'Test Consumer', url: 'http://test.local', token: 'token', authKind: 'bearer' },
  ],
}));

describe('Delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('saveFailedEvent', () => {
    it('should append failed event to file', async () => {
      const event = { type: 'test', source: 'src', payload: {} };
      (fs.appendFile as jest.Mock).mockResolvedValue(undefined);
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.access as jest.Mock).mockResolvedValue(undefined); // File exists

      await saveFailedEvent(event, 'test-consumer', 'some error');

      // Now we expect lock to be called on lock file, and append to jsonl
      // Since lock mock is global, we assume it works.
      // We verify appendFile is called correctly.
      expect(fs.appendFile).toHaveBeenCalledWith(
        expect.stringContaining('failed_forwards.jsonl'),
        expect.stringContaining('"consumerKey":"test-consumer"'),
        'utf8'
      );
    });

    it('should not save invalid event (missing consumerKey implied args)', async () => {
       // saveFailedEvent interface requires consumerKey, so TS prevents missing it,
       // but we can test invalid payload structure passed in event
       const invalidEvent = { type: 'test' } as any; // Missing source/payload

       await saveFailedEvent(invalidEvent, 'test-consumer', 'err');

       expect(fs.appendFile).not.toHaveBeenCalled();
    });
  });

  describe('getDeliveryMetrics', () => {
    it('should return metrics', () => {
      const metrics = getDeliveryMetrics(5);
      expect(metrics.counts.pending).toBe(5);
      expect(metrics.counts.failed).toBeDefined();
      expect(metrics).toHaveProperty('retryable_now');
      expect(metrics).toHaveProperty('next_due_at');
    });
  });

  describe('initDelivery', () => {
    // Basic test to ensure it runs without error in mock env
    it('should run initialization sequence', async () => {
      // Logic is hard to test due to mocked fs/lockfile, but we can call it
      const { initDelivery } = require('../delivery');
      await expect(initDelivery()).resolves.not.toThrow();
    });
  });
});
