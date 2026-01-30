
import fsPromises from 'fs/promises';
import fs from 'fs';
import readline from 'readline';
import { Readable, Writable } from 'stream';
import { lock } from 'proper-lockfile';

/**
 * Logger Mock Strategy:
 * Jest automatically hoists jest.mock calls to the top of the block.
 * This ensures the logger is mocked before any imports (like ../delivery) use it.
 * Note: Modules under test must not use the logger at the top-level (outside functions),
 * otherwise the mock might not apply correctly or could lead to initialization order issues.
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
  link: jest.fn(),
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
import { logger } from '../logger';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// Import subject under test
import { saveFailedEvent, retryFailedEvents, initDelivery } from '../delivery';

describe('Delivery Reliability', () => {
  let mockStream: any;
  let mockRl: any;
  let mockLockRelease: any;
  let mockDestStream: Writable;

  // Access mocks
  const mockAppendFile = fsPromises.appendFile as jest.Mock;
  const mockWriteFile = fsPromises.writeFile as jest.Mock;
  const mockAccess = fsPromises.access as jest.Mock;
  const mockRename = fsPromises.rename as jest.Mock;
  const mockUnlink = fsPromises.unlink as jest.Mock;
  const mockReaddir = fsPromises.readdir as jest.Mock;
  const mockReadFile = fsPromises.readFile as jest.Mock;
  const mockMkdir = fsPromises.mkdir as jest.Mock;
  const mockStat = fsPromises.stat as jest.Mock;
  const mockLink = fsPromises.link as jest.Mock;
  const mockCopyFile = fsPromises.copyFile as jest.Mock;

  const mockCreateReadStream = fs.createReadStream as jest.Mock;
  const mockCreateWriteStream = fs.createWriteStream as jest.Mock;
  const mockPipeline = require('stream/promises').pipeline as jest.Mock;
  const mockCreateInterface = readline.createInterface as jest.Mock;
  const mockLock = lock as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

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
    mockLink.mockResolvedValue(undefined);
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
    // Mock createWriteStream to return a valid Writable stub to avoid misleading tests
    mockDestStream = new Writable({ write: (c, e, cb) => cb() });
    mockCreateWriteStream.mockReturnValue(mockDestStream);

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

      expect(mockAppendFile).toHaveBeenCalledWith(
        expect.stringContaining('failed_forwards.jsonl'),
        expect.stringContaining('"consumerKey":"test-consumer"'),
        'utf8'
      );
      expect(mockLock).toHaveBeenCalled();
      expect(mockLockRelease).toHaveBeenCalled();
    });

    it('should not append invalid event (missing fields)', async () => {
       const invalidEvent = { type: 'test' } as any; // Invalid

       // Pass invalid event (schema check happens inside saveFailedEvent)
       await saveFailedEvent(invalidEvent, 'test-consumer', 'err');

       expect(mockAppendFile).not.toHaveBeenCalled();
    });
  });

  describe('retryFailedEvents', () => {
    it('should forward due events successfully and remove them', async () => {
      // Mock renaming success
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

      // Mock fetch success
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      await retryFailedEvents();

      // Should verify lock -> rename -> write empty -> unlock
      expect(mockRename).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalledWith(expect.stringContaining('failed_forwards.jsonl'), '');

      // Should fetch
      expect(mockFetch).toHaveBeenCalledWith(
        'http://test.local',
        expect.objectContaining({ method: 'POST' })
      );

      // Should NOT re-append (success means removed from queue)
      expect(mockAppendFile).not.toHaveBeenCalled();

      // Should clean up processing file
      expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('processing.'));

      // Verify resource cleanup
      expect(mockRl.close).toHaveBeenCalled();
      expect(mockStream.destroy).toHaveBeenCalled();
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

      // Mock fetch failure
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Error'
      });

      await retryFailedEvents();

      // Should attempt fetch
      expect(mockFetch).toHaveBeenCalled();

      // Should re-append with incremented retry count
      expect(mockCreateWriteStream).toHaveBeenCalledWith(
        expect.stringContaining('failed_forwards.jsonl'),
        expect.objectContaining({ flags: 'a', encoding: 'utf8' }),
      );
      expect(mockPipeline).toHaveBeenCalled();

      // Inspect streamed content (Source-side verification since pipeline is mocked)
      // Use filter + pop to get the LAST call associated with our dest stream
      const pipelineCalls = mockPipeline.mock.calls.filter((call: any[]) => call[1] === mockDestStream);
      const pipelineCall = pipelineCalls.pop(); // Get last call
      expect(pipelineCall).toBeDefined();
      const readable = pipelineCall[0] as Readable;
      const chunks = [];
      for await (const chunk of readable) chunks.push(chunk);
      const content = chunks.join('');

      expect(content).toContain('"retryCount":1');

      // Cleanup
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

      // Should re-append unchanged (or at least preserved)
      expect(mockCreateWriteStream).toHaveBeenCalledWith(
        expect.stringContaining('failed_forwards.jsonl'),
        expect.objectContaining({ flags: 'a', encoding: 'utf8' }),
      );
      expect(mockPipeline).toHaveBeenCalled();

      // Inspect streamed content (Source-side verification since pipeline is mocked)
      const pipelineCalls = mockPipeline.mock.calls.filter((call: any[]) => call[1] === mockDestStream);
      const pipelineCall = pipelineCalls.pop();
      expect(pipelineCall).toBeDefined();
      const readable = pipelineCall[0] as Readable;
      const chunks = [];
      for await (const chunk of readable) chunks.push(chunk);
      const content = chunks.join('');

      expect(content).toContain('"retryCount":0');
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

      // Mock fetch failure (500)
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

      // Inspect streamed content (Source-side verification since pipeline is mocked)
      const pipelineCalls = mockPipeline.mock.calls.filter((call: any[]) => call[1] === mockDestStream);
      const pipelineCall = pipelineCalls.pop();
      expect(pipelineCall).toBeDefined();
      const readable = pipelineCall[0] as Readable;
      const chunks = [];
      for await (const chunk of readable) chunks.push(chunk);
      const content = chunks.join('');

      const savedLines = content.trim().split('\n');
      const savedEvent = JSON.parse(savedLines[0]); // Should be the only event

      const nextAttemptTime = new Date(savedEvent.nextAttempt).getTime();
      expect(nextAttemptTime).toBeGreaterThan(now);
    });

    it('should handle stream errors gracefully during retry', async () => {
        // Mock renaming success
        mockRename.mockResolvedValue(undefined);

        // Setup a stream that emits error
        mockStream.on.mockImplementation((event: string, cb: Function) => {
            if (event === 'error') {
                // Trigger callback immediately (synchronously)
                cb(new Error('Stream failure'));
            }
        });

        // Ensure generator allows the error to propagate
        mockRl[Symbol.asyncIterator].mockReturnValue((async function*() {
            // Yield nothing; keep pending so the error event (via Promise.race) wins the race.
            // Use a short timeout (50ms) to ensure we don't hang CI if the error fails to trigger.
            await new Promise(r => setTimeout(r, 50));
        })());

        await retryFailedEvents();

        // Expect lock release to be called (finally block)
        expect(mockLockRelease).toHaveBeenCalled();

        // Expect logger error to be called with specific error
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.any(Error) }),
            expect.stringContaining('Error processing failed events')
        );

        // Expect processing file NOT to be unlinked (crash recovery logic)
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

        // Lock -> Read orphan -> Append to failed log -> Unlink orphan -> Unlock
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
        (logger.error as jest.Mock).mockClear();
        mockReaddir.mockResolvedValue(['processing.123.jsonl']);
        mockPipeline.mockRejectedValueOnce(new Error('Pipeline error'));

        await initDelivery();

        // Lock -> Pipeline Error -> Log Error -> Unlock (No Unlink)
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
        // Ensure no orphans so we focus on scan
        mockReaddir.mockResolvedValue([]);

        // Mock failed log existence
        mockAccess.mockResolvedValue(undefined);

        // Run init
        await initDelivery();

        // Should lock
        expect(mockLock).toHaveBeenCalled();

        // Should copy (snapshot)
        expect(mockCopyFile).toHaveBeenCalledWith(
            expect.stringContaining('failed_forwards.jsonl'),
            expect.stringContaining('snapshot.')
        );

        // Should create read stream for snapshot
        expect(mockCreateReadStream).toHaveBeenCalledWith(
            expect.stringContaining('snapshot.')
        );

        // Should release lock
        expect(mockLockRelease).toHaveBeenCalled();

        // Should unlink snapshot
        expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('snapshot.'));
    });

    it('should handle copy failure gracefully', async () => {
        mockReaddir.mockResolvedValue([]);
        mockAccess.mockResolvedValue(undefined);

        // Copy fails
        mockCopyFile.mockRejectedValueOnce(new Error('Disk full'));

        await initDelivery();

        // Should try copy
        expect(mockCopyFile).toHaveBeenCalled();

        // Should log error
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.any(Error) }),
            expect.stringContaining('Failed to lock or copy FAILED_LOG')
        );

        // Should NOT process snapshot
        expect(mockCreateReadStream).not.toHaveBeenCalledWith(
            expect.stringContaining('snapshot.')
        );

        // Should still clean up (though nothing to unlink if copy failed, the try/finally block handles this)
        // Actually, if copy fails, snapshotPath is set but file might not exist.
        // The finally block attempts to unlink snapshotPath if variable is set.
        // Since we assigned snapshotPath before copy, it will try to unlink.
        expect(mockUnlink).toHaveBeenCalled();
    });
  });
});
