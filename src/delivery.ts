import fs from 'fs/promises';
import path from 'path';
import { FailedEvent, PlexerEvent, PlexerDeliveryReport } from './types';
import { CONSUMERS } from './consumers';

const DATA_DIR = path.join(process.cwd(), 'data');
const FAILED_LOG = path.join(DATA_DIR, 'failed_forwards.jsonl');
const PROCESSING_LOG = path.join(DATA_DIR, 'failed_forwards.processing.jsonl');

let lastError: string | null = null;
let lastRetryAt: string | null = null;
let failedCount = 0;

async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {}
}

// Initialize failedCount on startup (best effort)
(async () => {
  try {
    await ensureDataDir();
    const content = await fs.readFile(FAILED_LOG, 'utf8').catch(() => '');
    failedCount = content.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {}
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
    nextAttempt: new Date(Date.now() + 1000 * 30).toISOString(), // Retry in 30s
    error,
  };

  const line = JSON.stringify(failedEvent) + '\n';
  await fs.appendFile(FAILED_LOG, line, 'utf8');
  failedCount++;
  lastError = error;
}

async function processFile(filePath: string): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    return;
  }

  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const remainingEvents: FailedEvent[] = [];
  const now = new Date();
  let processedCount = 0;

  for (const line of lines) {
    let entry: FailedEvent;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // Skip malformed
    }

    if (new Date(entry.nextAttempt) <= now) {
      processedCount++;
      // Try to send
      const consumer = CONSUMERS.find((c) => c.key === entry.consumerKey);
      if (!consumer) {
        // Consumer config missing, backoff significantly
        entry.retryCount++;
        entry.nextAttempt = new Date(
          now.getTime() +
            Math.min(
              Math.pow(2, entry.retryCount) * 1000 * 60,
              24 * 60 * 60 * 1000,
            ),
        ).toISOString();
        entry.error = 'Consumer configuration missing';
        remainingEvents.push(entry);
        continue;
      }

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (consumer.token) {
          headers.Authorization = `Bearer ${consumer.token}`;
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
      } catch (err) {
        entry.retryCount++;
        entry.lastAttempt = new Date().toISOString();
        // Backoff: 1min * 2^retryCount. Max 24h.
        const delay = Math.min(
          Math.pow(2, entry.retryCount) * 60 * 1000,
          24 * 60 * 60 * 1000,
        );
        entry.nextAttempt = new Date(Date.now() + delay).toISOString();
        entry.error = err instanceof Error ? err.message : String(err);
        lastError = entry.error;
        remainingEvents.push(entry);
        console.warn(
          `[Retry] Failed to forward to ${consumer.label}: ${entry.error}`,
        );
      }
    } else {
      // Not time yet
      remainingEvents.push(entry);
    }
  }

  // Append remaining to main file
  if (remainingEvents.length > 0) {
    const block =
      remainingEvents.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.appendFile(FAILED_LOG, block, 'utf8');
  }

  // Remove the processing file
  await fs.unlink(filePath);
}

export async function retryFailedEvents(): Promise<void> {
  lastRetryAt = new Date().toISOString();

  // 1. Check if a left-over processing file exists
  try {
    await fs.access(PROCESSING_LOG);
    await processFile(PROCESSING_LOG);
  } catch {
    // No processing file, proceed
  }

  // 2. Rename current log to processing
  try {
    await fs.rename(FAILED_LOG, PROCESSING_LOG);
  } catch (e) {
    if ((e as any).code === 'ENOENT') {
      // Nothing to retry
    } else {
      console.error('Failed to rename failed log for processing:', e);
    }
    return;
  }

  // 3. Process the new processing file
  try {
    await processFile(PROCESSING_LOG);
  } catch (err) {
    console.error('Error processing failed events:', err);
  }

  // Update failedCount
  try {
    const content = await fs.readFile(FAILED_LOG, 'utf8').catch(() => '');
    failedCount = content.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {}
}

export function getDeliveryMetrics(pendingCount: number): PlexerDeliveryReport {
  return {
    counts: {
      pending: pendingCount,
      failed: failedCount,
    },
    last_error: lastError,
    last_retry_at: lastRetryAt,
  };
}
