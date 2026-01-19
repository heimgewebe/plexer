import fs from 'fs/promises';
import { saveFailedEvent, getDeliveryMetrics } from '../delivery';

// Mock fs
jest.mock('fs/promises');

// Mock consumers
jest.mock('../consumers', () => ({
  CONSUMERS: [
    { key: 'test-consumer', label: 'Test Consumer', url: 'http://test.local', token: 'token' },
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

      await saveFailedEvent(event, 'test-consumer', 'some error');

      expect(fs.appendFile).toHaveBeenCalledWith(
        expect.stringContaining('failed_forwards.jsonl'),
        expect.stringContaining('"consumerKey":"test-consumer"'),
        'utf8'
      );
    });
  });

  describe('getDeliveryMetrics', () => {
    it('should return metrics', () => {
      const metrics = getDeliveryMetrics(5);
      expect(metrics.counts.pending).toBe(5);
      expect(metrics.counts.failed).toBeDefined();
    });
  });
});
