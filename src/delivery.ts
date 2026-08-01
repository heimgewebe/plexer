import Ajv from 'ajv';
import addFormats from 'ajv-formats';
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
} from './constants';
// NOTE: p-limit v3 is used because it supports CommonJS. v4+ is ESM-only.
import pLimit from 'p-limit';
import {
  failedForwardStore,
  QueueClaim,
  StoredQueueLine,
} from './failedForwardStore';

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
  // e.error is a validated string (FailedEvent schema; saveFailedEvent takes a
  // string), so this preserves the existing typed aggregate last_error semantics.
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
// so counters are not clobbered by SAME-PROCESS write/retry interleavings.
// Counters remain process-local snapshots: a second Plexer process could mutate
// the file after this process's snapshot, leaving these counters to lag until
// the next scan (cross-process FILE consistency is proper-lockfile's job).
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

function foldStoredLine(scan: QueueScan, line: StoredQueueLine, nowMs: number): void {
  if (!line.nonEmpty) return;
  scan.lineCount++;
  const entry = line.entry;
  if (!entry) return;
  const n = new Date(entry.nextAttempt).getTime();
  if (!isNaN(n)) {
    if (n < scan.minNext) scan.minNext = n;
    if (n <= nowMs) scan.retryableNow++;
  }
  foldCriticalEntry(scan.critical, entry, nowMs);
}

// Authoritative locked scan across the active file and every retry archive.
async function scanQueueState(nowMs: number): Promise<QueueScan | null> {
  const scan = newQueueScan();
  try {
    await failedForwardStore.scan((line) => foldStoredLine(scan, line, nowMs));
    return scan;
  } catch (e) {
    logger.error({ err: e }, 'Failed to scan failed-forward store');
    return null;
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

// Initial startup: crash recovery and metrics scan
export async function initDelivery(): Promise<void> {
  try {
    const retention = await failedForwardStore.initialize();
    if (
      retention.corruptDropped > 0 ||
      retention.expiredDropped > 0 ||
      retention.quotaDropped > 0
    ) {
      logger.warn({
        corrupt_dropped: retention.corruptDropped,
        expired_dropped: retention.expiredDropped,
        quota_dropped: retention.quotaDropped,
      }, '[Reliability] Normalized failed-forward retention on startup');
    }

    await withQueueState(async () => {
      const scan = await scanQueueState(Date.now());
      if (scan) applyQueueScan(scan);
    });
  } catch (err) {
    logger.error({ err }, 'Error during startup initialization');
  }
}

export type FailedEventSaveResult =
  | { status: 'persisted' }
  | { status: 'rejected'; reason: 'invalid' | 'quota' | 'io' };

interface QueueItem {
  entry: FailedEvent;
  bytes: number;
  resolve: (result: FailedEventSaveResult) => void;
}

const writeQueue: QueueItem[] = [];
let queuedBytes = 0;
let queuedEntries = 0;
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
    await withQueueState(async () => {
      const results = await failedForwardStore.append(events);
      const nowMs = Date.now();
      results.forEach((result, index) => {
        if (result.status === 'persisted') {
          recordQueuedEvent(events[index], nowMs);
          batch[index].resolve({ status: 'persisted' });
        } else {
          logger.warn(
            { consumer_key: events[index].consumerKey },
            '[Reliability] Rejected failed event at retention quota',
          );
          batch[index].resolve({ status: 'rejected', reason: 'quota' });
        }
      });
    });
  } catch (err) {
    logger.error({ err }, '[Reliability] Dropped batch events due to lock failure');
    batch.forEach((i) => i.resolve({ status: 'rejected', reason: 'io' }));
  } finally {
    queuedBytes = Math.max(0, queuedBytes - batch.reduce((sum, item) => sum + item.bytes, 0));
    queuedEntries = Math.max(0, queuedEntries - batch.length);
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
): Promise<FailedEventSaveResult> {
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
      { errors: validateFailedEvent.errors, consumer_key: consumerKey },
      'FailedEvent validation failed',
    );
    return { status: 'rejected', reason: 'invalid' };
  }

  const bytes = Buffer.byteLength(JSON.stringify(failedEvent), 'utf8') + 1;
  const maxBytes = config.failedForwardsMaxBytes ?? 16 * 1024 * 1024;
  const maxEntries = config.failedForwardsMaxEntries ?? 10_000;
  // Reserve before scheduling the flush so the in-memory staging queue itself
  // cannot exceed the same hard byte/entry totals as durable persistence.
  if (
    bytes > maxBytes ||
    queuedBytes + bytes > maxBytes ||
    queuedEntries + 1 > maxEntries
  ) {
    logger.warn(
      { consumer_key: consumerKey },
      '[Reliability] Rejected failed event at in-memory retention quota',
    );
    return { status: 'rejected', reason: 'quota' };
  }

  queuedBytes += bytes;
  queuedEntries++;
  return new Promise<FailedEventSaveResult>((resolve) => {
    writeQueue.push({ entry: failedEvent, bytes, resolve });
    scheduleFlush();
  });
}


export async function saveFailedChronikAgentLedgerEvent(
  event: unknown,
  error: string,
): Promise<FailedEventSaveResult> {
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

let retryStateChain: Promise<unknown> = Promise.resolve();

export function retryFailedEvents(): Promise<void> {
  const result = retryStateChain.then(() => runRetryFailedEvents());
  retryStateChain = result.then(() => undefined, () => undefined);
  return result;
}

function boundedRetryLine(
  entry: FailedEvent,
  originalRaw: string,
  originalBytes: number,
): string {
  const updated = JSON.stringify(entry);
  if (Buffer.byteLength(updated, 'utf8') + 1 <= originalBytes) return updated;
  logger.warn(
    { consumer_key: entry.consumerKey },
    '[Reliability] Retry metadata growth exceeded archive slot; preserving original record',
  );
  return originalRaw;
}

async function runRetryFailedEvents(): Promise<void> {
  await flushFailedWrites();
  lastRetryAt = new Date().toISOString();
  let claim: QueueClaim | null = null;
  try {
    claim = await failedForwardStore.claimNext();
    if (!claim) {
      await withQueueState(async () => {
        const scan = await scanQueueState(Date.now());
        if (scan) applyQueueScan(scan);
      });
      return;
    }

    const remainingLines = new Map<number, string>();
    const now = Date.now();
    const maxAgeMs = config.failedForwardsMaxAgeMs ?? 7 * 24 * 60 * 60 * 1_000;
    let lineIndex = 0;
    let corruptDropped = 0;
    let expiredDropped = 0;

    const limit = pLimit(Math.max(1, config.retryConcurrency));
    const activePromises = new Set<Promise<void>>();
    const windowSize = Math.max(1, config.retryBatchSize);

    for await (const line of failedForwardStore.readClaim(claim)) {
      if (!line.nonEmpty) continue;
      const currentIndex = lineIndex++;
      const entry = line.entry;
      if (!entry || line.raw === null) {
        corruptDropped++;
        continue;
      }
      if (now - Date.parse(entry.lastAttempt) > maxAgeMs) {
        expiredDropped++;
        continue;
      }
      const originalRaw = line.raw;
      const originalBytes = line.bytes;

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

        const wrapper = promise
          .then((res) => {
            if (res) {
              remainingLines.set(
                currentIndex,
                boundedRetryLine(res, originalRaw, originalBytes),
              );
            }
          })
          .catch((err) => {
            logger.error({ err }, '[Reliability] Retry wrapper error (should never happen)');
            remainingLines.set(currentIndex, originalRaw);
          })
          .finally(() => {
            activePromises.delete(wrapper);
          });
        activePromises.add(wrapper);
      } else {
        remainingLines.set(currentIndex, originalRaw);
      }
    }

    // Wait for all remaining active promises to complete
    if (activePromises.size > 0) {
      await Promise.all(activePromises);
    }

    await withQueueState(async () => {
      const orderedLines = [...remainingLines.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, line]) => line);
      await failedForwardStore.replaceClaim(claim!, orderedLines);
      claim = null;
      if (corruptDropped > 0 || expiredDropped > 0) {
        logger.warn({
          corrupt_dropped: corruptDropped,
          expired_dropped: expiredDropped,
        }, '[Reliability] Removed non-retryable archive records');
      }
      const scan = await scanQueueState(Date.now());
      if (scan) applyQueueScan(scan);
    });
  } catch (err) {
    if (claim) await failedForwardStore.abandonClaim(claim);
    logger.error({ err }, '[Reliability] Error processing failed events');
    // A failed replacement intentionally leaves the archive untouched. It will
    // be retried after restart or on the next run; no accepted record is lost.
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
