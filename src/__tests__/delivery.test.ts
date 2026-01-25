import fs from 'fs/promises';
import { createReadStream } from 'fs';
import readline from 'readline';
import { saveFailedEvent, getDeliveryMetrics, retryFailedEvents, initDelivery } from '../delivery';

// Mock fs/promises
jest.mock('fs/promises');

// Mock fs (non-promise) for createReadStream
jest.mock('fs', () => ({
  createReadStream: jest.fn(),
  promises: jest.requireActual('fs/promises'), // Keep promises accessible if needed via default import
}));

// Mock readline
jest.mock('readline');

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

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('Delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('saveFailedEvent', () => {
    it('should append failed event to file', async () => {
      const event = { type: 'test', source: 'src', payload: {} };
      (fs.appendFile as jest.Mock).mockResolvedValue(undefined);
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.access as jest.Mock).mockResolvedValue(undefined);

      await saveFailedEvent(event, 'test-consumer', 'some error');

      expect(fs.appendFile).toHaveBeenCalledWith(
        expect.stringContaining('failed_forwards.jsonl'),
        expect.stringContaining('"consumerKey":"test-consumer"'),
        'utf8'
      );
    });

    it('should not save invalid event', async () => {
       const invalidEvent = { type: 'test' } as any;
       await saveFailedEvent(invalidEvent, 'test-consumer', 'err');
       expect(fs.appendFile).not.toHaveBeenCalled();
    });
  });

  // Helper to mock readLinesSafe behavior via createReadStream + readline
  const mockReadLines = (lines: string[]) => {
    const mockStream = {
      on: jest.fn(),
      destroy: jest.fn(),
    };
    (createReadStream as jest.Mock).mockReturnValue(mockStream);

    const mockRl = {
      [Symbol.asyncIterator]: jest.fn().mockReturnValue((async function* () {
        for (const line of lines) {
          yield line;
        }
      })()),
      on: jest.fn(),
      close: jest.fn(),
    };
    (readline.createInterface as jest.Mock).mockReturnValue(mockRl);

    return { mockStream, mockRl };
  };

  describe('retryFailedEvents', () => {
    it('should process due events and remove them on success', async () => {
      const now = Date.now();
      const dueEvent = {
        consumerKey: 'test-consumer',
        event: { type: 'test', source: 'src', payload: {} },
        retryCount: 0,
        lastAttempt: new Date(now - 10000).toISOString(),
        nextAttempt: new Date(now - 5000).toISOString(),
        error: 'prev error'
      };

      const futureEvent = {
        ...dueEvent,
        nextAttempt: new Date(now + 100000).toISOString()
      };

      (fs.stat as jest.Mock).mockResolvedValue({ size: 100 });
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.rename as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.unlink as jest.Mock).mockResolvedValue(undefined);

      mockReadLines([JSON.stringify(dueEvent), JSON.stringify(futureEvent)]);

      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await retryFailedEvents();

      expect(mockFetch).toHaveBeenCalledTimes(1);

      expect(fs.appendFile).toHaveBeenCalled();
      const appendCalls = (fs.appendFile as jest.Mock).mock.calls;
      const dataAppend = appendCalls.find(call => call[0].includes('failed_forwards.jsonl') && call[1]);
      expect(dataAppend).toBeDefined();
      expect(dataAppend[1]).toContain(futureEvent.nextAttempt);

      expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('processing.'));
    });

    it('should update backoff on failure', async () => {
      const now = Date.now();
      const dueEvent = {
        consumerKey: 'test-consumer',
        event: { type: 'test', source: 'src', payload: {} },
        retryCount: 0,
        lastAttempt: new Date(now - 10000).toISOString(),
        nextAttempt: new Date(now - 5000).toISOString(),
        error: 'prev error'
      };

      (fs.stat as jest.Mock).mockResolvedValue({ size: 100 });
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.rename as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.unlink as jest.Mock).mockResolvedValue(undefined);

      mockReadLines([JSON.stringify(dueEvent)]);

      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Error' });

      await retryFailedEvents();

      expect(mockFetch).toHaveBeenCalledTimes(1);

      const appendCalls = (fs.appendFile as jest.Mock).mock.calls;
      const dataAppend = appendCalls.find(call => call[0].includes('failed_forwards.jsonl') && call[1]);

      expect(dataAppend).toBeDefined();
      const savedLines = dataAppend[1];
      const savedEvent = JSON.parse(savedLines.trim());

      expect(savedEvent.retryCount).toBe(1);
      expect(new Date(savedEvent.nextAttempt).getTime()).toBeGreaterThan(now);
    });
  });

  describe('initDelivery', () => {
    it('should recover orphaned processing files', async () => {
      (fs.readdir as jest.Mock).mockResolvedValue(['processing.123.jsonl']);
      (fs.readFile as jest.Mock).mockResolvedValue('{"some":"content"}\n');
      (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
      (fs.access as jest.Mock).mockResolvedValue(undefined);

      // We also mock the readLinesSafe call inside metrics scan to do nothing or throw
      // But initDelivery catches errors.
      // For this test, we care about recovery logic which happens BEFORE metrics scan.
      // We can make metrics scan fail or empty.
      mockReadLines([]); // Empty

      await initDelivery();

      expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining('processing.123.jsonl'), 'utf8');

      expect(fs.appendFile).toHaveBeenCalledWith(
        expect.stringContaining('failed_forwards.jsonl'),
        expect.anything()
      );

      expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('processing.123.jsonl'));
    });
  });

  describe('Contract Validation', () => {
    it('should have validators', () => {
       const { validateDeliveryReport, validateEventEnvelope } = require('../delivery');
       expect(typeof validateDeliveryReport).toBe('function');
       expect(typeof validateEventEnvelope).toBe('function');
    });
  });
});
