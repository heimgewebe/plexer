import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { lock } from 'proper-lockfile';
import { config } from './config';
import { FailedEvent, PlexerEvent, PlexerDeliveryReport } from './types';
import { CONSUMERS } from './consumers';

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
      console.log(`Found ${processingFiles.length} orphaned processing files. Recovering...`);

      let release;
      try {
        release = await lock(lockFile, { retries: 3 });
        // Ensure FAILED_LOG exists
        try { await fs.access(failedLog); } catch { await fs.writeFile(failedLog, ''); }

        for (const file of processingFiles) {
          const filePath = path.join(dataDir, file);
          try {
            const content = await fs.readFile(filePath, 'utf8');
            // Append content directly
            await fs.appendFile(failedLog, content);
            await fs.unlink(filePath);
          } catch (e) {
            console.error(`Failed to recover orphaned file ${file}:`, e);
          }
        }
      } catch (e) {
        console.error('Failed to lock during recovery:', e);
      } finally {
        if (release) await release();
      }
    }

    // 2. Metrics Scan
    // Ensure FAILED_LOG exists for reading
    try { await fs.access(failedLog); } catch { await fs.writeFile(failedLog, ''); }

    let releaseScan;
    let lineCount = 0;
    let minNext = Infinity;
    const now = Date.now();
    let rNow = 0;

    try {
      // Lock for read to support multi-instance / safe startup
      releaseScan = await lock(lockFile, { retries: 3 });

      const fileHandle = await fs.open(failedLog, 'r');
      for await (const line of fileHandle.readLines()) {
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
      await fileHandle.close();
    } catch (e) {
      console.error('Failed to lock/read FAILED_LOG during metrics scan:', e);
    } finally {
      if (releaseScan) await releaseScan();
    }

    failedCount = lineCount;
    retryableNowCount = rNow;
    nextDueAt = minNext === Infinity ? null : new Date(minNext).toISOString();
  } catch (err) {
    console.error('Error during startup initialization:', err);
  }
}

export async function saveFailedEvent(
  event: PlexerEvent,
  consumerKey: string,
  error: string,
): Promise<void> {
  await ensureDataDir();
  await ensureLockFile();

  const failedLog = getFailedLogPath();
  const lockFile = getLockFilePath();

  const failedEvent: FailedEvent = {
    consumerKey,
    event,
    retryCount: 0,
    lastAttempt: new Date().toISOString(),
    // Initial: 30s + jitter
    nextAttempt: new Date(
      Date.now() + 30000 + Math.random() * 5000,
    ).toISOString(),
    error,
  };

  if (!validateFailedEvent(failedEvent)) {
    console.error(
      'FailedEvent validation failed:',
      validateFailedEvent.errors,
      failedEvent,
    );
    // Don't save invalid events
    return;
  }

  const line = JSON.stringify(failedEvent) + '\n';

  // Ensure file exists for appending
  try {
    await fs.access(failedLog);
  } catch {
    await fs.writeFile(failedLog, '');
  }

  let release;
  try {
    release = await lock(lockFile, { retries: 3 });
    await fs.appendFile(failedLog, line, 'utf8');
    failedCount++;
    lastError = error;
    // Update nextDueAt if this is sooner
    const n = new Date(failedEvent.nextAttempt).getTime();
    if (!nextDueAt || n < new Date(nextDueAt).getTime()) {
      nextDueAt = failedEvent.nextAttempt;
    }
  } catch (err) {
    console.error('[Reliability] Dropped event due to lock failure:', err);
  } finally {
    if (release) await release();
  }
}

export async function retryFailedEvents(): Promise<void> {
  lastRetryAt = new Date().toISOString();
  await ensureDataDir();
  await ensureLockFile();

  const dataDir = getDataDir();
  const failedLog = getFailedLogPath();
  const lockFile = getLockFilePath();

  // Ensure file exists
  try {
    await fs.access(failedLog);
  } catch {
    await fs.writeFile(failedLog, '');
    return;
  }

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

    const fileHandle = await fs.open(processingFile, 'r');
    for await (const line of fileHandle.readLines()) {
      if (!line.trim()) continue;

      let entry: FailedEvent;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const nextTime = new Date(entry.nextAttempt).getTime();

      if (nextTime <= now) {
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
          const jitter = Math.random() * 1000;
          entry.nextAttempt = new Date(now + backoff + jitter).toISOString();
          entry.error = !consumer ? 'Consumer configuration missing' : 'Consumer URL missing';

          remainingEvents.push(entry);
          continue;
        }

        try {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          if (consumer.token) {
            if (consumer.authKind === 'x-auth') {
                headers['X-Auth'] = consumer.token;
            } else if (consumer.authKind === 'bearer') {
                headers['Authorization'] = `Bearer ${consumer.token}`;
            }
          }

          const res = await fetch(consumer.url!, {
            method: 'POST',
            headers,
            body: JSON.stringify(entry.event),
          });

          if (!res.ok) {
            let msg = `${res.status} ${res.statusText}`;
            if (res.status === 401 || res.status === 403)
              msg += ' (token rejected)';
            throw new Error(msg);
          }

          console.log(
            `[Retry] Successfully forwarded event ${entry.event.type} to ${consumer.label}`,
          );
          // Success: do nothing, it's removed from queue (processing file deleted later)
        } catch (err) {
          entry.retryCount++;
          entry.lastAttempt = new Date().toISOString();
          const backoff = Math.min(
            Math.pow(2, entry.retryCount) * 60 * 1000,
            24 * 60 * 60 * 1000,
          );
          const jitter = Math.random() * 10000; // up to 10s jitter
          entry.nextAttempt = new Date(now + backoff + jitter).toISOString();
          entry.error = err instanceof Error ? err.message : String(err);
          lastError = entry.error;

          console.warn(
            `[Retry] Failed to forward to ${consumer.label}: ${entry.error}`,
          );

          remainingEvents.push(entry);
        }
      } else {
        // Not time yet -> Re-queue
        remainingEvents.push(entry);
      }
    }

    // Cleanup processing file
    await fs.unlink(processingFile);

    // Batch write remaining events
    if (remainingEvents.length > 0) {
      await batchAppendEvents(remainingEvents);
    }

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
    console.error('[Reliability] Error processing failed events:', err);
  } finally {
    if (release) await release();
  }
}

async function batchAppendEvents(entries: FailedEvent[]) {
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    let release;
    try {
        release = await lock(getLockFilePath(), { retries: 3 });
        await fs.appendFile(getFailedLogPath(), lines, 'utf8');
    } catch(e) {
        console.error('Failed to batch requeue events', e);
    } finally {
        if(release) await release();
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
