import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import readline from 'readline';
import path from 'path';
import { randomUUID } from 'crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { lock } from 'proper-lockfile';
import { config } from './config';
import { FailedEvent, PlexerEvent, PlexerDeliveryReport } from './types';
import { CONSUMERS } from './consumers';
import { getAuthHeaders } from './auth';
import { logger } from './logger';
import { HTTP_REQUEST_TIMEOUT_MS } from './constants';
// NOTE: p-limit v3 is used because it supports CommonJS. v4+ is ESM-only.
import pLimit from 'p-limit';

let lastError: string | null = null;
let lastRetryAt: string | null = null;
let failedCount = 0;
let retryableNowCount = 0;
let nextDueAt: string | null = null;

const ajv = new Ajv({ strict: true });
addFormats(ajv);

// Load vendored schemas
import failedEventSchema from './vendor/schemas/plexer/failed_event.v1.schema.json';
import deliveryReportSchema from './vendor/schemas/plexer/delivery.report.v1.schema.json';
import eventEnvelopeSchema from './vendor/schemas/plexer/event.envelope.v1.schema.json';

const validateFailedEvent = ajv.compile(failedEventSchema);
export const validateDeliveryReport = ajv.compile(deliveryReportSchema);
export const validateEventEnvelope = ajv.compile(eventEnvelopeSchema);

function detach(emitter: any, event: string, listener: (...args: any[]) => void) {
  if (typeof emitter.off === 'function') {
    emitter.off(event, listener);
  } else if (typeof emitter.removeListener === 'function') {
    emitter.removeListener(event, listener);
  }
}

async function* readLinesSafe(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath);
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  let streamErr: unknown | null = null;
  const onErr = (e: unknown) => {
    if (streamErr === null) streamErr = e;
    rl.close();
  };

  stream.on('error', onErr);
  rl.on('error', onErr);

  try {
    for await (const line of rl) {
      yield line;
    }
    if (streamErr) throw streamErr;
  } finally {
    detach(stream, 'error', onErr);
    detach(rl, 'error', onErr);
    rl.close();
    stream.destroy();
  }
}

function getDataDir() {
  return path.resolve(config.dataDir);
}

function getFailedLogPath() {
  return path.join(getDataDir(), 'failed_forwards.jsonl');
}

function getLockFilePath() {
  return path.join(getDataDir(), 'failed_forwards.lock');
}

async function ensureDataDir() {
  try {
    await fs.mkdir(getDataDir(), { recursive: true });
  } catch {}
}

async function ensureLockFile() {
  try {
    await fs.access(getLockFilePath());
  } catch {
    await fs.writeFile(getLockFilePath(), '');
  }
}

// Initial startup: crash recovery and metrics scan
export async function initDelivery(): Promise<void> {
  try {
    await ensureDataDir();
    await ensureLockFile();

    const dataDir = getDataDir();
    const failedLog = getFailedLogPath();
    const lockFile = getLockFilePath();

    // 1. Crash Recovery: Check for orphaned processing files
    const files = await fs.readdir(dataDir);
    const processingFiles = files.filter((f) => f.startsWith('processing.') && f.endsWith('.jsonl'));

    if (processingFiles.length > 0) {
      logger.info(`Found ${processingFiles.length} orphaned processing files. Recovering...`);

      let release;
      try {
        release = await lock(lockFile, { retries: 3 });
        for (const file of processingFiles) {
          const filePath = path.join(dataDir, file);
          try {
            // Crash-recovery should be byte-preserving: append orphaned JSONL as-is.
            // We intentionally stream Buffers (no encoding) to avoid re-encoding/transcoding.
            await pipeline(
              createReadStream(filePath),
              createWriteStream(failedLog, { flags: 'a' })
            );
            await fs.unlink(filePath);
          } catch (e) {
            logger.error({ err: e, file }, `Failed to recover orphaned file ${file}`);
          }
        }
      } catch (e) {
        logger.error({ err: e }, 'Failed to lock during recovery');
      } finally {
        if (release) await release();
      }
    }

    // 2. Metrics Scan
    // Ensure FAILED_LOG exists for reading
    try { await fs.access(failedLog); } catch { await fs.writeFile(failedLog, ''); }

    let lineCount = 0;
    let minNext = Infinity;
    const now = Date.now();
    let rNow = 0;
    let snapshotPath: string | null = null;

    try {
      // Lock to snapshot the file via copy
      // We use copyFile to ensure a consistent point-in-time snapshot.
      let releaseScan;
      try {
        releaseScan = await lock(lockFile, { retries: 3 });
        const candidatePath = path.join(dataDir, `snapshot.${randomUUID()}.jsonl`);
        await fs.copyFile(failedLog, candidatePath);
        snapshotPath = candidatePath;
      } catch (e) {
        logger.error({ err: e }, 'Failed to lock or copy FAILED_LOG during metrics scan');
      } finally {
        if (releaseScan) await releaseScan();
      }

      if (snapshotPath) {
        try {
            for await (const line of readLinesSafe(snapshotPath)) {
                if (!line.trim()) continue;
                lineCount++;
                try {
                const e = JSON.parse(line) as FailedEvent;
                const n = new Date(e.nextAttempt).getTime();
                if (!isNaN(n)) {
                    if (n < minNext) minNext = n;
                    if (n <= now) rNow++;
                }
                } catch {}
            }
        } catch (e) {
             logger.error({ err: e }, 'Failed to scan snapshot during metrics scan');
        }
      }
    } finally {
      if (snapshotPath) {
        try { await fs.unlink(snapshotPath); } catch {}
      }
    }

    failedCount = lineCount;
    retryableNowCount = rNow;
    nextDueAt = minNext === Infinity ? null : new Date(minNext).toISOString();
  } catch (err) {
    logger.error({ err }, 'Error during startup initialization');
  }
}

interface QueueItem {
  entry: FailedEvent;
  resolve: () => void;
}

const writeQueue: QueueItem[] = [];
let isFlushing = false;
let flushScheduled = false;
const flushWaiters: (() => void)[] = [];

function scheduleFlush() {
  if (isFlushing || flushScheduled) return;
  flushScheduled = true;
  setImmediate(() => {
    flushScheduled = false;
    void processWriteQueue().catch((err) => {
      logger.error({ err }, '[Reliability] processWriteQueue crashed');
    });
  });
}

/**
 * Ensures all pending writes in the queue are flushed to disk.
 * Useful for graceful shutdowns and tests.
 * Writes are batched in-memory; call flushFailedWrites() on shutdown or before retry rotation.
 */
export async function flushFailedWrites(): Promise<void> {
  if (writeQueue.length === 0 && !isFlushing) return;
  return new Promise<void>((resolve) => {
    flushWaiters.push(resolve);
    scheduleFlush();
  });
}

function notifyFlushWaitersIfDrained() {
  if (!isFlushing && writeQueue.length === 0 && flushWaiters.length > 0) {
    flushWaiters.forEach((resolve) => resolve());
    flushWaiters.length = 0;
  }
}

async function processWriteQueue() {
  if (isFlushing || writeQueue.length === 0) {
    notifyFlushWaitersIfDrained();
    return;
  }
  isFlushing = true;

  const batch = writeQueue.splice(0, writeQueue.length);
  const events = batch.map((i) => i.entry);

  try {
    await ensureDataDir();
    await ensureLockFile();
    await batchAppendEvents(events);

    failedCount += events.length;
    for (const e of events) {
      lastError = e.error;
      const n = new Date(e.nextAttempt).getTime();
      if (!nextDueAt || n < new Date(nextDueAt).getTime()) {
        nextDueAt = e.nextAttempt;
      }
    }

    batch.forEach((i) => i.resolve());
  } catch (err) {
    logger.error({ err }, '[Reliability] Dropped batch events due to lock failure');
    // Resolve anyway to match previous behavior (best-effort)
    batch.forEach((i) => i.resolve());
  } finally {
    isFlushing = false;
    if (writeQueue.length > 0) {
      scheduleFlush();
    } else {
      notifyFlushWaitersIfDrained();
    }
  }
}

export async function saveFailedEvent(
  event: PlexerEvent,
  consumerKey: string,
  error: string,
): Promise<void> {
  const failedEvent: FailedEvent = {
    consumerKey,
    event,
    retryCount: 0,
    lastAttempt: new Date().toISOString(),
    // Initial: 30s + 0-10s jitter (consistent with other retry logic)
    nextAttempt: new Date(
      Date.now() + 30000 + Math.random() * 10000,
    ).toISOString(),
    error,
  };

  if (!validateFailedEvent(failedEvent)) {
    logger.error(
      { errors: validateFailedEvent.errors, failedEvent },
      'FailedEvent validation failed',
    );
    // Don't save invalid events
    return;
  }

  // Best-effort: we never reject the promise to the caller, effectively
  // making it fire-and-forget but with backpressure support if they await it.
  return new Promise<void>((resolve) => {
    writeQueue.push({ entry: failedEvent, resolve });
    scheduleFlush();
  });
}

export async function retryFailedEvents(): Promise<void> {
  // Ensure we flush any in-memory events before rotating the log file
  await flushFailedWrites();

  lastRetryAt = new Date().toISOString();
  await ensureDataDir();
  await ensureLockFile();

  const dataDir = getDataDir();
  const failedLog = getFailedLogPath();
  const lockFile = getLockFilePath();

  let release;
  let processingFile: string | null = null;

  try {
    // 1. Lock the lockfile
    release = await lock(lockFile, { retries: 3 });

    // Check size/existence before rename to avoid empty file churn
    const stats = await fs.stat(failedLog).catch(() => null);
    if (!stats || stats.size === 0) {
      failedCount = 0;
      retryableNowCount = 0;
      nextDueAt = null;
      return;
    }

    // 2. Rename to unique processing file
    processingFile = path.join(dataDir, `processing.${randomUUID()}.jsonl`);
    await fs.rename(failedLog, processingFile);

    // 3. Create new empty FAILED_LOG so saveFailedEvent can continue working
    await fs.writeFile(failedLog, '');

    // 4. Release lock immediately to allow new events to be saved
    await release();
    release = null;

    // 5. Process the renamed file (processingFile) using streaming
    const remainingEvents: FailedEvent[] = [];
    const now = Date.now();

    if (!processingFile) {
        throw new Error('[Reliability] Processing file not defined despite lock acquisition');
    }

    // Use parallelization to increase retry throughput
    const limit = pLimit(config.retryConcurrency);
    // Use a Set to track active promises for sliding window backpressure
    const activePromises = new Set<Promise<void>>();
    const windowSize = config.retryBatchSize; // legacy name: used as sliding-window size (buffer)

    for await (const line of readLinesSafe(processingFile)) {
      if (!line.trim()) continue;

      let entry: FailedEvent;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const nextTime = new Date(entry.nextAttempt).getTime();

      if (nextTime <= now) {
        // Backpressure: Wait BEFORE adding if too many active promises
        while (activePromises.size >= windowSize) {
          await Promise.race(activePromises);
        }

        const promise = limit(async (): Promise<FailedEvent | null> => {
          try {
            const attemptNow = Date.now();
            // Try to send
            const consumer = CONSUMERS.find((c) => c.key === entry.consumerKey);
            if (!consumer || !consumer.url) {
              // Backoff
              entry.retryCount++;
              // Jitter backoff
              const backoff = Math.min(
                Math.pow(2, entry.retryCount) * 60 * 1000,
                24 * 60 * 60 * 1000,
              );
              // 0-10s jitter
              const jitter = Math.random() * 10000;
              entry.nextAttempt = new Date(attemptNow + backoff + jitter).toISOString();
              entry.error = !consumer ? 'Consumer configuration missing' : 'Consumer URL missing';

              // Metrics fallback
              entry.lastAttempt = new Date().toISOString();

              return entry;
            }

            try {
              const headers: Record<string, string> = {
                'Content-Type': 'application/json',
              };
              if (consumer.token) {
                Object.assign(headers, getAuthHeaders(consumer.authKind, consumer.token, consumer.key));
              }

              const res = await fetch(consumer.url!, {
                method: 'POST',
                headers,
                body: JSON.stringify(entry.event),
                signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
              });

              if (!res.ok) {
                let msg = `${res.status} ${res.statusText}`;
                if (res.status === 401 || res.status === 403)
                  msg += ' (token rejected)';
                throw new Error(msg);
              }

              logger.info(
                { type: entry.event.type, label: consumer.label },
                `[Retry] Successfully forwarded event ${entry.event.type} to ${consumer.label}`,
              );
              // Success: return null to indicate removal
              return null;
            } catch (err) {
              entry.retryCount++;
              entry.lastAttempt = new Date().toISOString();
              const backoff = Math.min(
                Math.pow(2, entry.retryCount) * 60 * 1000,
                24 * 60 * 60 * 1000,
              );
              // 0-10s jitter
              const jitter = Math.random() * 10000;
              entry.nextAttempt = new Date(attemptNow + backoff + jitter).toISOString();
              entry.error = err instanceof Error ? err.message : String(err);
              lastError = entry.error;

              logger.warn(
                { label: consumer.label, error: entry.error },
                `[Retry] Failed to forward to ${consumer.label}: ${entry.error}`,
              );

              return entry;
            }
          } catch (e) {
            // Safety net: ensure we never reject, effectively "requeue" the entry
            logger.error({ err: e }, '[Reliability] Uncaught error in retry task');
            return entry;
          }
        });

        // Wrap to handle removal from Set upon completion (robust cleanup)
        const wrapper = promise
          .then((res) => {
            if (res) remainingEvents.push(res);
          })
          // promise never rejects now, but keep catch as defensive programming
          .catch((err) => {
            logger.error({ err }, '[Reliability] Retry wrapper error (should never happen)');
          })
          .finally(() => {
            activePromises.delete(wrapper);
          });
        activePromises.add(wrapper);
      } else {
        // Not time yet -> Re-queue
        remainingEvents.push(entry);
      }
    }

    // Wait for all remaining active promises to complete
    if (activePromises.size > 0) {
      await Promise.all(activePromises);
    }

    // Batch write remaining events first (crash safety)
    if (remainingEvents.length > 0) {
      await batchAppendEvents(remainingEvents);
    }

    // THEN cleanup processing file
    await fs.unlink(processingFile);

    // Reset global metrics based on remaining events
    let minNext = Infinity;
    let rNow = 0;
    const nowAfter = Date.now();

    for (const e of remainingEvents) {
       const n = new Date(e.nextAttempt).getTime();
       if (!isNaN(n)) {
          if (n < minNext) minNext = n;
          if (n <= nowAfter) rNow++;
       }
    }

    failedCount = remainingEvents.length;
    retryableNowCount = rNow;
    nextDueAt = minNext === Infinity ? null : new Date(minNext).toISOString();

  } catch (err) {
    logger.error({ err }, '[Reliability] Error processing failed events');
    // IMPORTANT: If we crash here (e.g. during batchAppendEvents),
    // we DO NOT unlink processingFile.
    // initDelivery will pick it up next time.
  } finally {
    if (release) await release();
  }
}

async function batchAppendEvents(entries: FailedEvent[]) {
  // Stream-based implementation to avoid memory spike from large string concatenation
  const iterator = function* () {
    for (const entry of entries) {
      yield JSON.stringify(entry) + '\n';
    }
  };

  let release;
  try {
    release = await lock(getLockFilePath(), { retries: 3 });
    await pipeline(
      Readable.from(iterator()),
      createWriteStream(getFailedLogPath(), { flags: 'a', encoding: 'utf8' }),
    );
  } catch (e) {
    // Re-throw to prevent processing file deletion
    throw e;
  } finally {
    if (release) await release();
  }
}

export function getDeliveryMetrics(pendingCount: number): PlexerDeliveryReport {
  return {
    counts: {
      pending: pendingCount,
      failed: failedCount,
    },
    last_error: lastError,
    last_retry_at: lastRetryAt,
    retryable_now: retryableNowCount,
    next_due_at: nextDueAt,
  };
}

export function getNextDueAt(): string | null {
  return nextDueAt;
}
