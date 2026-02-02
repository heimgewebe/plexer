
import { Readable, Writable } from 'stream';

/**
 * Logger Mock Strategy:
 * Jest automatically hoists jest.mock calls to the top of the block.
 */

// Mock fs/promises with explicit factory
jest.mock('fs/promises', () => ({
  appendFile: jest.fn(),
  writeFile: jest.fn(),
  access: jest.fn(),
  rename: jest.fn(),
  unlink: jest.fn(),
  readdir: jest.fn(),
  readFile: jest.fn(),
  mkdir: jest.fn(),
  stat: jest.fn(),
  copyFile: jest.fn(),
}));

// Mock fs (createReadStream, createWriteStream)
jest.mock('fs', () => ({
  createReadStream: jest.fn(),
  createWriteStream: jest.fn(),
}));

// Mock stream/promises
jest.mock('stream/promises', () => ({
  pipeline: jest.fn(),
}));

// Mock readline
jest.mock('readline', () => ({
  createInterface: jest.fn(),
}));

// Mock proper-lockfile
jest.mock('proper-lockfile', () => ({
  lock: jest.fn(),
}));

// Mock consumers
jest.mock('../consumers', () => ({
  CONSUMERS: [
    { key: 'test-consumer', label: 'Test Consumer', url: 'http://test.local', token: 'token', authKind: 'bearer' },
  ],
}));

// Mock logger
jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe('Delivery Reliability', () => {
  // Module under test
  let delivery: any;
  let saveFailedEvent: any;
  let retryFailedEvents: any;
  let initDelivery: any;
  let flushFailedWrites: any;
  let logger: any;

  // Mocks
  let mockAppendFile: jest.Mock;
  let mockWriteFile: jest.Mock;
  let mockAccess: jest.Mock;
  let mockRename: jest.Mock;
  let mockUnlink: jest.Mock;
  let mockReaddir: jest.Mock;
  let mockReadFile: jest.Mock;
  let mockMkdir: jest.Mock;
  let mockStat: jest.Mock;
  let mockCopyFile: jest.Mock;
  let mockCreateReadStream: jest.Mock;
  let mockCreateWriteStream: jest.Mock;
  let mockPipeline: jest.Mock;
  let mockCreateInterface: jest.Mock;
  let mockLock: jest.Mock;

  let mockStream: any;
  let mockRl: any;
  let mockLockRelease: any;
  let mockDestStream: Writable;

  beforeEach(() => {
    // RESET MODULES to ensure fresh state (writeQueue, isFlushing)
    jest.resetModules();
    jest.clearAllMocks();

    // Re-acquire mocks from the fresh modules
    // Note: jest.mock factories run again, creating NEW jest.fn() instances
    const fsP = require('fs/promises');
    mockAppendFile = fsP.appendFile;
    mockWriteFile = fsP.writeFile;
    mockAccess = fsP.access;
    mockRename = fsP.rename;
    mockUnlink = fsP.unlink;
    mockReaddir = fsP.readdir;
    mockReadFile = fsP.readFile;
    mockMkdir = fsP.mkdir;
    mockStat = fsP.stat;
    mockCopyFile = fsP.copyFile;

    const fs = require('fs');
    mockCreateReadStream = fs.createReadStream;
    mockCreateWriteStream = fs.createWriteStream;

    const streamP = require('stream/promises');
    mockPipeline = streamP.pipeline;

    const readline = require('readline');
    mockCreateInterface = readline.createInterface;

    const properLockfile = require('proper-lockfile');
    mockLock = properLockfile.lock;

    const loggerModule = require('../logger');
    logger = loggerModule.logger;

    // Re-import subject
    delivery = require('../delivery');
    saveFailedEvent = delivery.saveFailedEvent;
    retryFailedEvents = delivery.retryFailedEvents;
    initDelivery = delivery.initDelivery;
    flushFailedWrites = delivery.flushFailedWrites;

    // --- SETUP MOCK BEHAVIORS ---

    // Default fs/promises behavior
    mockAccess.mockResolvedValue(undefined); // Files exist by default
    mockStat.mockResolvedValue({ size: 100 }); // File has content by default
    mockReaddir.mockResolvedValue([]); // No orphan files by default
    mockMkdir.mockResolvedValue(undefined);
    mockAppendFile.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue('');
    mockCopyFile.mockResolvedValue(undefined);

    // Setup proper-lockfile
    mockLockRelease = jest.fn();
    mockLock.mockResolvedValue(mockLockRelease);

    // Setup stream/readline mocks
    mockStream = {
      on: jest.fn(),
      destroy: jest.fn(),
    };
    mockCreateReadStream.mockReturnValue(mockStream);
    // Mock createWriteStream to return a valid Writable stub
    mockDestStream = new Writable({ write: (c, e, cb) => cb() });
    mockCreateWriteStream.mockReturnValue(mockDestStream);

    // Explicitly resolve pipeline to avoid hangs
    mockPipeline.mockResolvedValue(undefined);

    mockRl = {
      on: jest.fn(),
      close: jest.fn(),
      [Symbol.asyncIterator]: jest.fn(),
    };

    // Default empty iterator
    const emptyGenerator = async function* () {};
    mockRl[Symbol.asyncIterator].mockReturnValue(emptyGenerator());

    mockCreateInterface.mockReturnValue(mockRl);
  });

  const mockReadLines = (lines: string[]) => {
    const generator = async function* () {
      for (const line of lines) {
        yield line;
      }
    };
    mockRl[Symbol.asyncIterator].mockReturnValue(generator());
  };

  describe('saveFailedEvent', () => {
    it('should append valid failed event to log', async () => {
      const event = { type: 'test', source: 'src', payload: {} };

      await saveFailedEvent(event, 'test-consumer', 'some error');

      // Now uses batchAppendEvents which uses createWriteStream + pipeline
      expect(mockCreateWriteStream).toHaveBeenCalledWith(
        expect.stringContaining('failed_forwards.jsonl'),
        expect.objectContaining({ flags: 'a', encoding: 'utf8' })
      );

      // Verify content via pipeline source
      const pipelineCalls = mockPipeline.mock.calls.filter((call: any[]) => call[1] === mockDestStream);
      const pipelineCall = pipelineCalls.pop();
      expect(pipelineCall).toBeDefined();
      const readable = pipelineCall[0] as Readable;
      const chunks = [];
      for await (const chunk of readable) chunks.push(chunk);
      const content = chunks.join('');

      expect(content).toContain('"consumerKey":"test-consumer"');
      expect(mockLock).toHaveBeenCalled();
      expect(mockLockRelease).toHaveBeenCalled();
    });

    it('should not append invalid event (missing fields)', async () => {
       const invalidEvent = { type: 'test' } as any; // Invalid

       // Pass invalid event (schema check happens inside saveFailedEvent)
       await saveFailedEvent(invalidEvent, 'test-consumer', 'err');

       expect(mockCreateWriteStream).not.toHaveBeenCalled();
    });

    it('should wait for flushFailedWrites to drain the queue', async () => {
        // Arrange: Add item to queue (mock lock delay to simulate active flush)
        let resolveLock: ((val: any) => void) | undefined;
        // Use mockImplementationOnce on the FRESH mockLock
        mockLock.mockImplementationOnce(() => new Promise(resolve => { resolveLock = resolve; }));

        const event = { type: 'test', source: 'src', payload: {} };
        const savePromise = saveFailedEvent(event, 'test-consumer', 'err');

        // Act: call flushFailedWrites
        const flushPromise = flushFailedWrites();

        // Assert: Flush should not be done yet
        const raceResult = await Promise.race([
          flushPromise.then(() => 'flush'),
          Promise.resolve('pending')
        ]);
        expect(raceResult).toBe('pending');

        // Wait for lock to be acquired
        let attempts = 0;
        while (!resolveLock && attempts < 20) {
            await new Promise(r => setTimeout(r, 10));
            attempts++;
        }

        if (!resolveLock) {
            throw new Error('Timeout waiting for lock acquisition - mockLock was not called');
        }

        // Resolve lock -> allows processWriteQueue to finish
        resolveLock(mockLockRelease);

        await flushPromise;
        await savePromise;

        expect(mockCreateWriteStream).toHaveBeenCalled();
    });
  });

  describe('retryFailedEvents', () => {
    it('should forward due events successfully and remove them', async () => {
      mockRename.mockResolvedValue(undefined);

      const dueEvent = {
        consumerKey: 'test-consumer',
        event: { type: 't', source: 's', payload: {} },
        retryCount: 0,
        nextAttempt: new Date(Date.now() - 1000).toISOString(), // Due
        lastAttempt: new Date().toISOString(),
        error: 'prev error'
      };

      mockReadLines([JSON.stringify(dueEvent)]);

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      await retryFailedEvents();

      expect(mockRename).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalledWith(expect.stringContaining('failed_forwards.jsonl'), '');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://test.local',
        expect.objectContaining({ method: 'POST' })
      );
      expect(mockAppendFile).not.toHaveBeenCalled();
      expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('processing.'));
    });

    it('should increment retry count and requeue on failure', async () => {
      const dueEvent = {
        consumerKey: 'test-consumer',
        event: { type: 't', source: 's', payload: {} },
        retryCount: 0,
        nextAttempt: new Date(Date.now() - 1000).toISOString(), // Due
        lastAttempt: new Date().toISOString(),
        error: 'prev error'
      };

      mockReadLines([JSON.stringify(dueEvent)]);

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Error'
      });

      await retryFailedEvents();

      expect(mockFetch).toHaveBeenCalled();
      expect(mockCreateWriteStream).toHaveBeenCalledWith(
        expect.stringContaining('failed_forwards.jsonl'),
        expect.objectContaining({ flags: 'a', encoding: 'utf8' }),
      );
      expect(mockPipeline).toHaveBeenCalled();

      const pipelineCalls = mockPipeline.mock.calls.filter((call: any[]) => call[1] === mockDestStream);
      const pipelineCall = pipelineCalls.pop();
      expect(pipelineCall).toBeDefined();
      const readable = pipelineCall[0] as Readable;
      const chunks = [];
      for await (const chunk of readable) chunks.push(chunk);
      const content = chunks.join('');

      expect(content).toContain('"retryCount":1');
      expect(mockUnlink).toHaveBeenCalled();
    });

    it('should requeue future events without attempting fetch', async () => {
      const futureEvent = {
        consumerKey: 'test-consumer',
        event: { type: 't', source: 's', payload: {} },
        retryCount: 0,
        nextAttempt: new Date(Date.now() + 100000).toISOString(), // Future
        lastAttempt: new Date().toISOString(),
        error: 'prev error',
      };

      mockReadLines([JSON.stringify(futureEvent)]);

      await retryFailedEvents();

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockCreateWriteStream).toHaveBeenCalledWith(
        expect.stringContaining('failed_forwards.jsonl'),
        expect.objectContaining({ flags: 'a', encoding: 'utf8' }),
      );
    });

    it('should ensure nextAttempt is strictly in the future after a failed retry', async () => {
      const now = Date.now();
      const dueEvent = {
        consumerKey: 'test-consumer',
        event: { type: 't', source: 's', payload: {} },
        retryCount: 0,
        nextAttempt: new Date(now - 1000).toISOString(), // Due
        lastAttempt: new Date().toISOString(),
        error: 'prev error',
      };

      mockReadLines([JSON.stringify(dueEvent)]);

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Error',
      });

      await retryFailedEvents();

      expect(mockCreateWriteStream).toHaveBeenCalledWith(
        expect.stringContaining('failed_forwards.jsonl'),
        expect.any(Object),
      );

      const pipelineCalls = mockPipeline.mock.calls.filter((call: any[]) => call[1] === mockDestStream);
      const pipelineCall = pipelineCalls.pop();
      expect(pipelineCall).toBeDefined();
      const readable = pipelineCall[0] as Readable;
      const chunks = [];
      for await (const chunk of readable) chunks.push(chunk);
      const content = chunks.join('');

      const savedLines = content.trim().split('\n');
      const savedEvent = JSON.parse(savedLines[0]);

      const nextAttemptTime = new Date(savedEvent.nextAttempt).getTime();
      expect(nextAttemptTime).toBeGreaterThan(now);
    });

    it('should handle stream errors gracefully during retry', async () => {
        mockRename.mockResolvedValue(undefined);

        mockStream.on.mockImplementation((event: string, cb: Function) => {
            if (event === 'error') {
                cb(new Error('Stream failure'));
            }
        });

        mockRl[Symbol.asyncIterator].mockReturnValue((async function*() {
            await new Promise(r => setTimeout(r, 50));
        })());

        await retryFailedEvents();

        expect(mockLockRelease).toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.any(Error) }),
            expect.stringContaining('Error processing failed events')
        );
        expect(mockUnlink).not.toHaveBeenCalled();
    });
  });

  describe('initDelivery', () => {
    beforeEach(() => {
       mockPipeline.mockClear();
       mockCreateReadStream.mockClear();
       mockCreateWriteStream.mockClear();

       mockCreateReadStream.mockReturnValue(Readable.from(['x']));
       mockCreateWriteStream.mockReturnValue(new Writable({ write: (c, e, cb) => cb() }));
    });

    it('should recover orphaned processing files', async () => {
        mockReaddir.mockResolvedValue(['processing.123.jsonl']);
        mockPipeline.mockResolvedValue(undefined);

        await initDelivery();

        expect(mockLock).toHaveBeenCalled();
        expect(mockCreateReadStream).toHaveBeenCalledWith(expect.stringContaining('processing.123.jsonl'));
        expect(mockCreateWriteStream).toHaveBeenCalledWith(
            expect.stringContaining('failed_forwards.jsonl'),
            { flags: 'a' }
        );
        expect(mockPipeline).toHaveBeenCalled();
        expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('processing.123.jsonl'));
        expect(mockLockRelease).toHaveBeenCalled();
    });

    it('should handle pipeline failure during orphan recovery', async () => {
        // We use the fresh logger instance here
        (logger.error as jest.Mock).mockClear();
        mockReaddir.mockResolvedValue(['processing.123.jsonl']);
        mockPipeline.mockRejectedValueOnce(new Error('Pipeline error'));

        await initDelivery();

        expect(mockLock).toHaveBeenCalled();
        expect(mockPipeline).toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.any(Error) }),
            expect.stringContaining('Failed to recover orphaned file')
        );
        expect(mockUnlink).not.toHaveBeenCalledWith(expect.stringContaining('processing.123.jsonl'));
        expect(mockLockRelease).toHaveBeenCalled();
    });

    it('should scan metrics using a file copy (snapshot)', async () => {
        mockReaddir.mockResolvedValue([]);
        mockAccess.mockResolvedValue(undefined);

        await initDelivery();

        expect(mockLock).toHaveBeenCalled();
        expect(mockCopyFile).toHaveBeenCalledWith(
            expect.stringContaining('failed_forwards.jsonl'),
            expect.stringContaining('snapshot.')
        );
        expect(mockCreateReadStream).toHaveBeenCalledWith(
            expect.stringContaining('snapshot.')
        );
        expect(mockCreateReadStream).not.toHaveBeenCalledWith(
            expect.stringContaining('failed_forwards.jsonl')
        );
        expect(mockLockRelease).toHaveBeenCalled();
        expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('snapshot.'));
    });

    it('should handle copy failure gracefully', async () => {
        (logger.error as jest.Mock).mockClear();
        mockUnlink.mockClear();
        mockCreateReadStream.mockClear();
        mockCopyFile.mockClear();

        mockReaddir.mockResolvedValue([]);
        mockAccess.mockResolvedValue(undefined);

        mockCopyFile.mockRejectedValueOnce(new Error('Disk full'));

        await initDelivery();

        expect(mockCopyFile).toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.any(Error) }),
            expect.stringContaining('Failed to lock or copy FAILED_LOG')
        );
        expect(mockCreateReadStream).not.toHaveBeenCalledWith(
            expect.stringContaining('snapshot.')
        );
        const unlinkedSnapshot = mockUnlink.mock.calls.some((args: any[]) =>
            String(args[0]).includes('snapshot.')
        );
        expect(unlinkedSnapshot).toBe(false);
        expect(mockLockRelease).toHaveBeenCalled();
    });

    it('should handle lock failure gracefully', async () => {
        (logger.error as jest.Mock).mockClear();
        mockCopyFile.mockClear();

        mockReaddir.mockResolvedValue([]);
        mockAccess.mockResolvedValue(undefined);

        mockLock.mockRejectedValueOnce(new Error('Lock contention'));

        await initDelivery();

        expect(mockLock).toHaveBeenCalledWith(
            expect.stringContaining('failed_forwards.lock'),
            expect.objectContaining({ retries: 3 })
        );
        expect(mockCopyFile).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.any(Error) }),
            expect.stringContaining('Failed to lock or copy FAILED_LOG')
        );
    });
  });
});
