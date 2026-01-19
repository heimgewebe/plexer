import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import Ajv from 'ajv';
import { lock } from 'proper-lockfile';
import { config } from './config';
import { FailedEvent, PlexerEvent, PlexerDeliveryReport } from './types';
import { CONSUMERS } from './consumers';

const DATA_DIR = path.resolve(config.dataDir);
const FAILED_LOG = path.join(DATA_DIR, 'failed_forwards.jsonl');

let lastError: string | null = null;
let lastRetryAt: string | null = null;
let failedCount = 0;
let retryableNowCount = 0;
let nextDueAt: string | null = null;

const ajv = new Ajv({ strict: true });

// Load vendored schemas
import failedEventSchema from './contracts/failed_event.v1.schema.json';
import deliveryReportSchema from './contracts/delivery.report.v1.schema.json';

const validateFailedEvent = ajv.compile(failedEventSchema);
export const validateDeliveryReport = ajv.compile(deliveryReportSchema);

async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {}
}

// Initial startup: crash recovery and metrics scan
(async () => {
  try {
    await ensureDataDir();

    // 1. Crash Recovery: Check for orphaned processing files
    const files = await fs.readdir(DATA_DIR);
    const processingFiles = files.filter((f) => f.startsWith('processing.') && f.endsWith('.jsonl'));

    if (processingFiles.length > 0) {
      console.log(`Found ${processingFiles.length} orphaned processing files. Recovering...`);

      // Ensure FAILED_LOG exists
      try { await fs.access(FAILED_LOG); } catch { await fs.writeFile(FAILED_LOG, ''); }

      let release;
      try {
        release = await lock(FAILED_LOG, { retries: 3 });
        for (const file of processingFiles) {
          const filePath = path.join(DATA_DIR, file);
          try {
            const content = await fs.readFile(filePath, 'utf8');
            // Append content directly
            await fs.appendFile(FAILED_LOG, content);
            await fs.unlink(filePath);
          } catch (e) {
            console.error(`Failed to recover orphaned file ${file}:`, e);
          }
        }
      } catch (e) {
        console.error('Failed to lock FAILED_LOG during recovery:', e);
      } finally {
        if (release) await release();
      }
    }

    // 2. Metrics Scan
    try {
      await fs.access(FAILED_LOG);
    } catch {
      await fs.writeFile(FAILED_LOG, '');
    }

    const content = await fs.readFile(FAILED_LOG, 'utf8').catch(() => '');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    failedCount = lines.length;
    // Scan for metrics
    let minNext = Infinity;
    const now = Date.now();
    let rNow = 0;

    for (const line of lines) {
      try {
        const e = JSON.parse(line) as FailedEvent;
        const n = new Date(e.nextAttempt).getTime();
        if (!isNaN(n)) {
          if (n < minNext) minNext = n;
          if (n <= now) rNow++;
        }
      } catch {}
    }
    retryableNowCount = rNow;
    nextDueAt = minNext === Infinity ? null : new Date(minNext).toISOString();
  } catch (err) {
    console.error('Error during startup initialization:', err);
  }
})();

export async function saveFailedEvent(
  event: PlexerEvent,
  consumerKey: string,
  error: string,
): Promise<void> {
  await ensureDataDir();

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

  // Ensure file exists for locking
  try {
    await fs.access(FAILED_LOG);
  } catch {
    await fs.writeFile(FAILED_LOG, '');
  }

  let release;
  try {
    release = await lock(FAILED_LOG, { retries: 3 });
    await fs.appendFile(FAILED_LOG, line, 'utf8');
    failedCount++;
    lastError = error;
    // Update nextDueAt if this is sooner
    const n = new Date(failedEvent.nextAttempt).getTime();
    if (!nextDueAt || n < new Date(nextDueAt).getTime()) {
      nextDueAt = failedEvent.nextAttempt;
    }
  } catch (err) {
    console.error('Failed to acquire lock for saving event:', err);
  } finally {
    if (release) await release();
  }
}

export async function retryFailedEvents(): Promise<void> {
  lastRetryAt = new Date().toISOString();
  await ensureDataDir();

  // Ensure file exists
  try {
    await fs.access(FAILED_LOG);
  } catch {
    await fs.writeFile(FAILED_LOG, '');
    return;
  }

  let release;
  let processingFile: string | null = null;

  try {
    // 1. Lock the main file
    release = await lock(FAILED_LOG, { retries: 3 });
    const content = await fs.readFile(FAILED_LOG, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    if (lines.length === 0) {
      failedCount = 0;
      retryableNowCount = 0;
      nextDueAt = null;
      return; // Finally block releases lock
    }

    // 2. Rename to unique processing file
    processingFile = path.join(DATA_DIR, `processing.${randomUUID()}.jsonl`);
    await fs.rename(FAILED_LOG, processingFile);

    // 3. Create new empty FAILED_LOG so saveFailedEvent can continue working
    await fs.writeFile(FAILED_LOG, '');

    // 4. Release lock immediately to allow new events to be saved
    await release();
    release = null;

    // 5. Process the renamed file (processingFile)
    const remainingEvents: FailedEvent[] = [];
    const now = Date.now();
    let minNext = Infinity;
    let rNow = 0;

    for (const line of lines) {
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
        if (!consumer) {
          // Backoff
          entry.retryCount++;
          // Jitter backoff
          const backoff = Math.min(
            Math.pow(2, entry.retryCount) * 60 * 1000,
            24 * 60 * 60 * 1000,
          );
          const jitter = Math.random() * 1000;
          entry.nextAttempt = new Date(now + backoff + jitter).toISOString();
          entry.error = 'Consumer configuration missing';

          remainingEvents.push(entry);
          updateMetrics(entry);
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
          updateMetrics(entry);
        }
      } else {
        // Not time yet -> Re-queue
        remainingEvents.push(entry);
        updateMetrics(entry);
      }
    }

    function updateMetrics(e: FailedEvent) {
       const n = new Date(e.nextAttempt).getTime();
       if (!isNaN(n)) {
          if (n < minNext) minNext = n;
          if (n <= Date.now()) rNow++;
       }
    }

    // Cleanup processing file
    await fs.unlink(processingFile);

    // Batch write remaining events
    if (remainingEvents.length > 0) {
      await batchAppendEvents(remainingEvents);
    }

    // Reset global metrics based on remaining events
    failedCount = remainingEvents.length;
    retryableNowCount = rNow;
    nextDueAt = minNext === Infinity ? null : new Date(minNext).toISOString();

  } catch (err) {
    console.error('Error processing failed events:', err);
  } finally {
    if (release) await release();
  }
}

async function batchAppendEvents(entries: FailedEvent[]) {
    const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    let release;
    try {
        release = await lock(FAILED_LOG, { retries: 3 });
        await fs.appendFile(FAILED_LOG, lines, 'utf8');
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
