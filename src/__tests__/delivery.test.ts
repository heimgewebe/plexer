import fs from 'fs/promises';
import { createReadStream } from 'fs';
import readline from 'readline';
import { EventEmitter } from 'events';
import { saveFailedEvent, getDeliveryMetrics, initDelivery } from '../delivery';

// Mock fs/promises
jest.mock('fs/promises', () => ({
  access: jest.fn(),
  mkdir: jest.fn(),
  writeFile: jest.fn(),
  appendFile: jest.fn(),
  readdir: jest.fn(),
  readFile: jest.fn(),
  unlink: jest.fn(),
  rename: jest.fn(),
  stat: jest.fn(),
  open: jest.fn(),
}));

// Mock proper-lockfile
jest.mock('proper-lockfile', () => ({
  lock: jest.fn().mockResolvedValue(() => Promise.resolve()),
}));

// Mock fs (stream)
jest.mock('fs', () => ({
  createReadStream: jest.fn(),
}));

// Mock readline
jest.mock('readline', () => ({
  createInterface: jest.fn(),
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

      await saveFailedEvent(event as any, 'test-consumer', 'some error');

      expect(fs.appendFile).toHaveBeenCalledWith(
        expect.stringContaining('failed_forwards.jsonl'),
        expect.stringContaining('"consumerKey":"test-consumer"'),
        'utf8'
      );
    });

    it('should not save invalid event (missing consumerKey implied args)', async () => {
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
    it('should run initialization sequence without error', async () => {
      // Setup mocks for initDelivery
      (fs.readdir as jest.Mock).mockResolvedValue([]); // No orphan files
      (fs.access as jest.Mock).mockResolvedValue(undefined); // failed log exists

      // Mock Stream/Readline for metrics scan
      const mockStream = new EventEmitter();
      (mockStream as any).destroy = jest.fn();
      (createReadStream as jest.Mock).mockReturnValue(mockStream);

      const mockRl = {
        [Symbol.asyncIterator]: jest.fn().mockReturnValue({
          next: jest.fn().mockResolvedValue({ done: true, value: undefined })
        }),
        on: jest.fn(),
        close: jest.fn(),
      };
      (readline.createInterface as jest.Mock).mockReturnValue(mockRl);

      await expect(initDelivery()).resolves.not.toThrow();

      expect(fs.readdir).toHaveBeenCalled();
      expect(createReadStream).toHaveBeenCalled();
      expect(readline.createInterface).toHaveBeenCalled();
    });

    it('should recover orphaned files', async () => {
       (fs.readdir as jest.Mock).mockResolvedValue(['processing.123.jsonl']);
       (fs.readFile as jest.Mock).mockResolvedValue('{"some":"data"}');
       (fs.appendFile as jest.Mock).mockResolvedValue(undefined);
       (fs.unlink as jest.Mock).mockResolvedValue(undefined);

       // Mock Stream/Readline for metrics scan (empty)
      const mockStream = new EventEmitter();
      (mockStream as any).destroy = jest.fn();
      (createReadStream as jest.Mock).mockReturnValue(mockStream);

      const mockRl = {
        [Symbol.asyncIterator]: jest.fn().mockReturnValue({
           next: jest.fn().mockResolvedValue({ done: true, value: undefined })
        }),
        on: jest.fn(),
        close: jest.fn(),
      };
      (readline.createInterface as jest.Mock).mockReturnValue(mockRl);

       await initDelivery();

       expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining('processing.123.jsonl'), 'utf8');
       expect(fs.appendFile).toHaveBeenCalledWith(expect.stringContaining('failed_forwards.jsonl'), '{"some":"data"}');
       expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('processing.123.jsonl'));
    });
  });

  describe('Contract Validation (Strict Mode)', () => {
    it('should successfully compile all schemas in strict mode', () => {
      const { validateDeliveryReport, validateEventEnvelope } = require('../delivery');
      expect(typeof validateDeliveryReport).toBe('function');
      expect(typeof validateEventEnvelope).toBe('function');
    });
  });
});
