import fs from 'fs/promises';
import { Readable } from 'stream';

// Mock fs/promises
jest.mock('fs/promises');

// Set up mocks for createReadStream and readline before importing delivery
const mockCreateReadStream = jest.fn();
const mockCreateInterface = jest.fn();

// Mock fs (for createReadStream)
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  createReadStream: (...args: any[]) => mockCreateReadStream(...args),
}));

// Mock readline
jest.mock('readline', () => ({
  ...jest.requireActual('readline'),
  createInterface: (...args: any[]) => mockCreateInterface(...args),
}));

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

// Now import delivery after all mocks are set up
import { saveFailedEvent, retryFailedEvents, initDelivery } from '../delivery';

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Helper to mock readLinesSafe via createReadStream and readline
function mockReadLines(lines: string[]) {
  // Create a mock stream with EventEmitter methods
  const mockStream = new Readable();
  mockStream._read = () => {}; // Implement _read
  
  // Push all lines and end stream
  process.nextTick(() => {
    for (const line of lines) {
      mockStream.push(line + '\n');
    }
    mockStream.push(null);
  });
  
  mockCreateReadStream.mockReturnValue(mockStream);
  
  // Mock readline.createInterface to return proper async iterator with EventEmitter methods
  const mockRl = {
    close: jest.fn(),
    on: jest.fn().mockReturnThis(),
    [Symbol.asyncIterator]: async function* () {
      for (const line of lines) {
        yield line;
      }
    }
  };
  mockCreateInterface.mockReturnValue(mockRl);
  
  return mockStream;
}

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

      // Mock fs.stat to simulate file exists
      (fs.stat as jest.Mock).mockResolvedValue({ size: 100 });
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.rename as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.unlink as jest.Mock).mockResolvedValue(undefined);

      // Mock readLinesSafe via createReadStream and readline
      mockReadLines([
        JSON.stringify(dueEvent),
        JSON.stringify(futureEvent)
      ]);

      // Mock fetch success
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await retryFailedEvents();

      // Should have tried to fetch dueEvent
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Should have requeued futureEvent but NOT dueEvent
      // We expect one append call for the remaining (future) events
      // Note: Implementation calls batchAppendEvents, which calls appendFile
      expect(fs.appendFile).toHaveBeenCalled();
      const appendCalls = (fs.appendFile as jest.Mock).mock.calls;
      // Filter for the call to failed_forwards.jsonl
      const dataAppend = appendCalls.find(call => call[0].includes('failed_forwards.jsonl') && call[1]);
      expect(dataAppend).toBeDefined();
      expect(dataAppend[1]).toContain(futureEvent.nextAttempt);
      // Should NOT contain the dueEvent (as it was successful) (checking via nextAttempt or unique prop)
      // Since dueEvent and futureEvent are identical except nextAttempt, checking existence of future's nextAttempt is key.

      // Ensure processing file was unlinked
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

      // Mock fs
      (fs.stat as jest.Mock).mockResolvedValue({ size: 100 });
      (fs.access as jest.Mock).mockResolvedValue(undefined);
      (fs.rename as jest.Mock).mockResolvedValue(undefined);
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.unlink as jest.Mock).mockResolvedValue(undefined);

      // Mock readLinesSafe via createReadStream and readline
      mockReadLines([JSON.stringify(dueEvent)]);

      // Mock fetch failure
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Error' });

      await retryFailedEvents();

      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Should have requeued dueEvent with updated backoff
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
      (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
      (fs.unlink as jest.Mock).mockResolvedValue(undefined);
      
      // Mock metrics scan with empty readLines
      mockReadLines([]);

      await initDelivery();

      // Should read orphaned file
      expect(fs.readFile).toHaveBeenCalledWith(expect.stringContaining('processing.123.jsonl'), 'utf8');

      // Should append content to failed log
      expect(fs.appendFile).toHaveBeenCalledWith(
        expect.stringContaining('failed_forwards.jsonl'),
        expect.anything()
      );

      // Should unlink orphaned file
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
