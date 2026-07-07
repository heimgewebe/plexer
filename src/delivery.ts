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
import { deliverToChronikAgentLedger } from './chronik';
import {
  HTTP_REQUEST_TIMEOUT_MS,
  INITIAL_RETRY_DELAY_MS,
  RETRY_JITTER_MAX_MS,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  LOCK_RETRIES,
} from './constants';
// NOTE: p-limit v3 is used because it supports CommonJS. v4+ is ESM-only.
import pLimit from 'p-limit';

let lastError: string | null = null;
let lastRetryAt: string | null = null;
let failedCount = 0;
let retryableNowCount = 0;
let nextDueAt: string | null = null;

const CHRONIK_AGENT_LEDGER_CONSUMER_KEY = 'chronik-agent-ledger';

// Critical-sink (Chronik agent.ledger) diagnostics — a strict subset of the queue.
// Internal observability only; NOT part of the plexer.delivery.report.v1 contract
// and NOT a signal for producers to stop sending (Plexer keeps buffering when degraded).
let criticalQueuedCount = 0;
let criticalRetryableNowCount = 0;
let criticalNextDueAt: string | null = null;
let lastCriticalError: string | null = null;
let lastCriticalDeliveredAt: string | null = null;

/** Coerce a queue entry's `error` to a usable string, or null. Type-safe: a
 *  corrupted queue line with a non-string error never becomes last_error. */
function extractErrorString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// Single source of truth for *summarizing* the critical (Chronik agent.ledger)
// subset of the queue from a scan, so every authoritative recompute (init and
// post-retry) folds identically — especially on `lastError`, which is
// reconstructed from the queue, not tracked ad hoc. The incremental write path
// uses recordQueuedEvent() instead (a delta, not a summary).
interface CriticalAccumulator {
  queued: number;
  retryableNow: number;
  minNext: number;
  lastError: string | null;
  // lastAttempt (ms) of the entry that provided lastError; -Infinity if none.
  // Used to prefer the most recently attempted open entry's error.
  lastErrorAt: number;
}

function newCriticalAccumulator(): CriticalAccumulator {
  return { queued: 0, retryableNow: 0, minNext: Infinity, lastError: null, lastErrorAt: -Infinity };
}

function foldCriticalEntry(acc: CriticalAccumulator, entry: FailedEvent, nowMs: number): void {
  if (entry.consumerKey !== CHRONIK_AGENT_LEDGER_CONSUMER_KEY) return;
  acc.queued++;
  const err = extractErrorString(entry.error);
  if (err !== null) {
    // Recency rank for choosing which open entry's error to surface:
    //   1. valid lastAttempt, else 2. valid nextAttempt, else 3. scan order (ties).
    const at = new Date(entry.lastAttempt).getTime();
    const nn = new Date(entry.nextAttempt).getTime();
    const rank = !isNaN(at) ? at : (!isNaN(nn) ? nn : -Infinity);
    if (acc.lastError === null || rank >= acc.lastErrorAt) {
      acc.lastError = err;
      acc.lastErrorAt = rank;
    }
  }
  const n = new Date(entry.nextAttempt).getTime();
  if (isNaN(n)) return;
  if (n <= nowMs) acc.retryableNow++;
  if (n < acc.minNext) acc.minNext = n;
}

/** Incremental delta for one newly-queued event (write path). Keeps the write
 *  path a single defined path rather than ad-hoc mutation, and guards the global
 *  nextDueAt against an unparseable nextAttempt (matching the critical path). */
function recordQueuedEvent(e: FailedEvent, nowMs: number): void {
  failedCount++;
  lastError = e.error;
  const n = new Date(e.nextAttempt).getTime();
  if (Number.isFinite(n)) {
    const curMs = nextDueAt === null ? Infinity : new Date(nextDueAt).getTime();
    if (!Number.isFinite(curMs) || n < curMs) nextDueAt = e.nextAttempt;
  }
  if (e.consumerKey !== CHRONIK_AGENT_LEDGER_CONSUMER_KEY) return;
  criticalQueuedCount++;
  const err = extractErrorString(e.error);
  if (err !== null) lastCriticalError = err;
  if (Number.isFinite(n)) {
    const curCritMs = criticalNextDueAt === null ? Infinity : new Date(criticalNextDueAt).getTime();
    if (!Number.isFinite(curCritMs) || n < curCritMs) criticalNextDueAt = e.nextAttempt;
    if (n <= nowMs) criticalRetryableNowCount++;
  }
}

function applyCriticalAccumulator(acc: CriticalAccumulator): void {
  criticalQueuedCount = acc.queued;
  criticalRetryableNowCount = acc.retryableNow;
  criticalNextDueAt = acc.minNext === Infinity ? null : new Date(acc.minNext).toISOString();
  // Invariant: an empty critical queue has no outstanding failure to report.
  lastCriticalError = acc.queued === 0 ? null : acc.lastError;
}

// ---------------------------------------------------------------------------
// In-process queue-state mutex.
//
// proper-lockfile serializes *file* mutations (including across processes) but
// NOT the in-memory metric counters. Because retryFailedEvents() releases the
// file lock before awaiting delivery, a concurrent processWriteQueue() can
// persist a new event and bump counters mid-retry; the retry's final recompute
// would then clobber that update. This mutex serializes the counter-touching
// sections of processWriteQueue() and retryFailedEvents() (and initDelivery()),
// so counters always reflect the persisted queue.
//
// Lock ordering rule (must hold everywhere to avoid deadlock): acquire this
// mutex BEFORE any proper-lockfile file lock; never acquire it while already
// holding a file lock.
let queueStateChain: Promise<unknown> = Promise.resolve();
function withQueueState<T>(fn: () => Promise<T>): Promise<T> {
  const result = queueStateChain.then(() => fn());
  // Keep the chain alive even if fn rejects, so the mutex never deadlocks.
  queueStateChain = result.then(() => undefined, () => undefined);
  return result;
}

interface QueueScan {
  lineCount: number;
  retryableNow: number;
  minNext: number;
  critical: CriticalAccumulator;
}

function newQueueScan(): QueueScan {
  return { lineCount: 0, retryableNow: 0, minNext: Infinity, critical: newCriticalAccumulator() };
}

// Fold a single queue file (already a stable point-in-time source, e.g. a
// snapshot copy). NOTE: `lineCount` counts every non-empty line, including
// unparseable ones, so failedCount == "lines in the queue file". Corrupt lines
// are not folded into the critical/due metrics. A dedicated corrupt_lines signal
// is a possible follow-up, out of scope for this slice.
async function scanQueueFile(filePath: string, nowMs: number): Promise<QueueScan> {
  const scan = newQueueScan();
  for await (const line of readLinesSafe(filePath)) {
    if (!line.trim()) continue;
    scan.lineCount++;
    let entry: FailedEvent;
    try {
      entry = JSON.parse(line) as FailedEvent;
    } catch {
      continue; // corrupt line: counted as a line, but not folded
    }
    const n = new Date(entry.nextAttempt).getTime();
    if (!isNaN(n)) {
      if (n < scan.minNext) scan.minNext = n;
      if (n <= nowMs) scan.retryableNow++;
    }
    foldCriticalEntry(scan.critical, entry, nowMs);
  }
  return scan;
}

// Authoritative recompute source used by init, the early retry reset and the
// final retry recompute. Takes the proper-lockfile file lock, copies the live
// queue to a point-in-time snapshot, releases the lock, then scans the snapshot.
// This keeps the scan consistent with the file-level (incl. cross-process) lock
// that guards every queue mutation. Callers must hold withQueueState so the
// counter apply is atomic vs the in-process write path. Returns null (do NOT
// apply / do NOT clobber counters) if the snapshot could not be taken.
async function scanQueueSnapshot(nowMs: number): Promise<QueueScan | null> {
  const dataDir = getDataDir();
  const failedLog = getFailedLogPath();
  const lockFile = getLockFilePath();
  await ensureDataDir();
  await ensureLockFile();

  let snapshotPath: string | null = null;
  let release;
  try {
    release = await lock(lockFile, { retries: LOCK_RETRIES });
    // Ensure the source exists so copyFile does not throw on a fresh queue.
    try { await fs.access(failedLog); } catch { await fs.writeFile(failedLog, ''); }
    const candidate = path.join(dataDir, `snapshot.${randomUUID()}.jsonl`);
    await fs.copyFile(failedLog, candidate);
    snapshotPath = candidate;
  } catch (e) {
    logger.error({ err: e }, 'Failed to snapshot queue for metrics scan');
    return null; // keep prior counters rather than clobbering to zero
  } finally {
    if (release) await release();
  }

  try {
    return await scanQueueFile(snapshotPath, nowMs);
  } catch (e) {
    logger.error({ err: e }, 'Failed to scan queue snapshot');
    return null;
  } finally {
    try { await fs.unlink(snapshotPath); } catch {}
  }
}

function applyQueueScan(scan: QueueScan): void {
  failedCount = scan.lineCount;
  retryableNowCount = scan.retryableNow;
  nextDueAt = scan.minNext === Infinity ? null : new Date(scan.minNext).toISOString();
  applyCriticalAccumulator(scan.critical);
}

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
        release = await lock(lockFile, { retries: LOCK_RETRIES });
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

    // 2. Metrics Scan — authoritative snapshot scan under the queue-state mutex,
    // so a concurrent save cannot land between the point-in-time copy and the
    // counter apply. Mutex is acquired before the file lock (inside the helper).
    await withQueueState(async () => {
      const scan = await scanQueueSnapshot(Date.now());
      if (scan) applyQueueScan(scan);
    });
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

    // Persist + count under the queue-state mutex so this update is atomic with
    // respect to retryFailedEvents()'s final recompute (mutex before file lock).
    await withQueueState(async () => {
      await batchAppendEvents(events);
      const nowMs = Date.now();
      for (const e of events) recordQueuedEvent(e, nowMs);
    });

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
      Date.now() + INITIAL_RETRY_DELAY_MS + Math.random() * RETRY_JITTER_MAX_MS,
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


export async function saveFailedChronikAgentLedgerEvent(
  event: unknown,
  error: string,
): Promise<void> {
  return saveFailedEvent(
    {
      type: 'agent.run.ledger.v1',
      source: 'plexer',
      payload: event,
    },
    CHRONIK_AGENT_LEDGER_CONSUMER_KEY,
    error,
  );
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
    release = await lock(lockFile, { retries: LOCK_RETRIES });

    // Check size/existence before rename to avoid empty file churn
    const stats = await fs.stat(failedLog).catch(() => null);
    if (!stats || stats.size === 0) {
      // Release the file lock BEFORE taking the mutex (lock ordering), then
      // recompute authoritatively under the mutex. This serializes the reset
      // with the write path and re-reads the queue, so an event written between
      // the stat above and here is not clobbered to zero.
      await release();
      release = null;
      await withQueueState(async () => {
        const scan = await scanQueueSnapshot(Date.now());
        if (scan) applyQueueScan(scan);
      });
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

    // Use parallelization to increase retry throughput
    const limit = pLimit(Math.max(1, config.retryConcurrency));
    // Use a Set to track active wrapper promises (void) for sliding window backpressure & cleanup
    const activePromises = new Set<Promise<void>>();
    // Ensure windowSize is at least 1 to prevent deadlock; limits active retry tasks (backpressure)
    const windowSize = Math.max(1, config.retryBatchSize);

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
            if (entry.consumerKey === CHRONIK_AGENT_LEDGER_CONSUMER_KEY) {
              const result = await deliverToChronikAgentLedger(entry.event.payload);

              if (result.status === 'delivered') {
                lastCriticalDeliveredAt = new Date().toISOString();
                // last_error is NOT cleared here: other critical events may remain
                // queued. The final recompute below derives it from remainingEvents.
                logger.info(
                  { type: entry.event.type, label: 'Chronik agent.ledger' },
                  '[Retry] Successfully forwarded event to Chronik agent.ledger',
                );
                return null;
              }

              if (
                !result.retryable &&
                result.status !== 'skipped' &&
                result.statusCode !== 401 &&
                result.statusCode !== 403
              ) {
                logger.error(
                  { type: entry.event.type, status: result.status, error: result.error },
                  '[Retry] Dropping permanent Chronik agent.ledger failure',
                );
                return null;
              }

              entry.retryCount++;
              entry.lastAttempt = new Date().toISOString();
              const backoff = Math.min(
                Math.pow(2, entry.retryCount) * RETRY_BACKOFF_BASE_MS,
                RETRY_BACKOFF_MAX_MS,
              );
              const jitter = Math.random() * RETRY_JITTER_MAX_MS;
              entry.nextAttempt = new Date(attemptNow + backoff + jitter).toISOString();
              entry.error = result.error ?? result.status;
              lastError = entry.error;
              // lastCriticalError is derived from remainingEvents in the final recompute.

              logger.warn(
                { error: entry.error, retryCount: entry.retryCount },
                '[Retry] Failed to forward to Chronik agent.ledger; event requeued',
              );

              return entry;
            }

            const consumer = CONSUMERS.find((c) => c.key === entry.consumerKey);
            if (!consumer || !consumer.url) {
              const reason = !consumer ? 'Consumer configuration missing' : 'Consumer URL missing';
              // Backoff
              entry.retryCount++;
              // Exponential backoff: first retry uses 2x base delay (intentional: 2^1 * base)
              const backoff = Math.min(
                Math.pow(2, entry.retryCount) * RETRY_BACKOFF_BASE_MS,
                RETRY_BACKOFF_MAX_MS,
              );
              // 0-10s jitter
              const jitter = Math.random() * RETRY_JITTER_MAX_MS;
              entry.nextAttempt = new Date(attemptNow + backoff + jitter).toISOString();
              entry.error = reason;

              // Metrics fallback
              entry.lastAttempt = new Date().toISOString();

              logger.error(
                {
                  consumerKey: entry.consumerKey,
                  eventType: entry.event.type,
                  reason,
                  retryCount: entry.retryCount,
                  nextAttempt: entry.nextAttempt,
                },
                '[Retry] Consumer configuration error; event requeued',
              );

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
              // Exponential backoff: first retry uses 2x base delay (intentional: 2^1 * base)
              const backoff = Math.min(
                Math.pow(2, entry.retryCount) * RETRY_BACKOFF_BASE_MS,
                RETRY_BACKOFF_MAX_MS,
              );
              // 0-10s jitter
              const jitter = Math.random() * RETRY_JITTER_MAX_MS;
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

    // Persist remaining events and recompute metrics under the queue-state mutex.
    // The file lock was released at step 4, so events queued during delivery are
    // already in failedLog; recomputing from that live file (not just
    // remainingEvents) means those concurrent writes are NOT lost. The mutex
    // makes the append + rescan + apply atomic vs processWriteQueue's counting.
    // (Mutex acquired before the file lock inside batchAppendEvents.)
    await withQueueState(async () => {
      // Batch write remaining events first (crash safety)
      if (remainingEvents.length > 0) {
        await batchAppendEvents(remainingEvents);
      }

      // THEN cleanup processing file
      await fs.unlink(processingFile!);

      // Authoritative recompute from a locked snapshot of the live queue file
      // (remaining + any events persisted concurrently during this retry run).
      const scan = await scanQueueSnapshot(Date.now());
      if (scan) applyQueueScan(scan);
    });

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
    release = await lock(getLockFilePath(), { retries: LOCK_RETRIES });
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

export type CriticalSinkStatus = 'ready' | 'degraded' | 'unconfigured';

export interface CriticalSinkReadiness {
  /**
   * ready: sink configured and no operational events waiting for it.
   * degraded: sink configured but agent.ledger events are queued (undelivered).
   * unconfigured: no CHRONIK_URL, so the critical sink is not wired.
   */
  status: CriticalSinkStatus;
  critical_sink: string;
  /**
   * How `status` is derived. `queue_state` = inferred from Plexer's local
   * delivery queue, NOT from a live call to Chronik. This distinction matters:
   * `ready` means "no agent.ledger backlog buffered", not "Chronik is reachable".
   */
  status_basis: 'queue_state';
  /** Whether Plexer actively probed Chronik to derive `status`. Always false today. */
  active_probe: boolean;
  configured: boolean;
  queued: number;
  /** Count of due critical entries as of the last queue scan (snapshot, may lag). */
  retryable_now: number;
  next_due_at: string | null;
  /**
   * Live-computed: whether `next_due_at` is already in the past. Unlike
   * `retryable_now` (a scan snapshot), this stays accurate between retry runs.
   */
  due_now: boolean;
  last_error: string | null;
  /** Process-local: reset on restart, not reconstructed from persistent history. */
  last_delivered_at: string | null;
}

/**
 * Internal diagnostic for the critical Chronik agent.ledger sink.
 *
 * Derived purely from local queue state (no active Chronik probe). This is
 * Plexer's own observability surface, NOT the vendored plexer.delivery.report.v1
 * contract, and NOT a producer gate: a degraded or unconfigured sink does not
 * mean producers should stop — Plexer keeps buffering operational events for
 * retry (relay degrades without changing task truth). It is likewise NOT a
 * Kubernetes/load-balancer readinessProbe: pulling Plexer out of rotation while
 * it is correctly buffering would defeat the queue.
 *
 * `configured` intentionally tracks only CHRONIK_URL: the sink is "wired" once a
 * URL exists. A missing CHRONIK_TOKEN is an auth detail that surfaces as
 * `degraded` (401 -> queued), not as `unconfigured`.
 */
export function getCriticalSinkReadiness(): CriticalSinkReadiness {
  const configured = !!config.chronikUrl;
  let status: CriticalSinkStatus;
  if (!configured) {
    status = 'unconfigured';
  } else if (criticalQueuedCount > 0) {
    status = 'degraded';
  } else {
    status = 'ready';
  }

  const nowMs = Date.now();
  const dueAtMs = criticalNextDueAt === null ? NaN : new Date(criticalNextDueAt).getTime();
  const dueNow = Number.isFinite(dueAtMs) && dueAtMs <= nowMs;

  return {
    status,
    critical_sink: 'chronik.agent.ledger',
    status_basis: 'queue_state',
    active_probe: false,
    configured,
    queued: criticalQueuedCount,
    retryable_now: criticalRetryableNowCount,
    next_due_at: criticalNextDueAt,
    due_now: dueNow,
    last_error: lastCriticalError,
    last_delivered_at: lastCriticalDeliveredAt,
  };
}
