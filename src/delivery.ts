// src/delivery.ts (retryFailedEvents + batchAppendEvents)

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

  let release: any;
  let processingFile: string | null = null;

  try {
    // 1) Lock the lockfile (short critical section)
    release = await lock(lockFile, { retries: 3 });

    // Avoid churn on empty file
    const stats = await fs.stat(failedLog).catch(() => null);
    if (!stats || stats.size === 0) {
      failedCount = 0;
      retryableNowCount = 0;
      nextDueAt = null;
      return;
    }

    // 2) Rename to unique processing file
    processingFile = path.join(dataDir, `processing.${randomUUID()}.jsonl`);
    await fs.rename(failedLog, processingFile);

    // 3) Create new empty FAILED_LOG so saveFailedEvent can continue working
    await fs.writeFile(failedLog, '');

    // 4) Release lock immediately to allow new events to be saved
    await release();
    release = null;

    // 5) Process the renamed file (processingFile) using streaming with error-safe iterator
    const remainingEvents: FailedEvent[] = [];
    const now = Date.now();

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
        const consumer = CONSUMERS.find((c) => c.key === entry.consumerKey);

        if (!consumer || !consumer.url) {
          entry.retryCount++;
          const backoff = Math.min(
            Math.pow(2, entry.retryCount) * 60 * 1000,
            24 * 60 * 60 * 1000,
          );
          const jitter = Math.random() * 1000;
          entry.nextAttempt = new Date(now + backoff + jitter).toISOString();
          entry.error = !consumer
            ? 'Consumer configuration missing'
            : 'Consumer URL missing';

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

          const res = await fetch(consumer.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(entry.event),
          });

          if (!res.ok) {
            let msg = `${res.status} ${res.statusText}`;
            if (res.status === 401 || res.status === 403) msg += ' (token rejected)';
            throw new Error(msg);
          }

          console.log(
            `[Retry] Successfully forwarded event ${entry.event.type} to ${consumer.label}`,
          );
          // Success: drop from queue
        } catch (err) {
          entry.retryCount++;
          entry.lastAttempt = new Date().toISOString();
          const backoff = Math.min(
            Math.pow(2, entry.retryCount) * 60 * 1000,
            24 * 60 * 60 * 1000,
          );
          const jitter = Math.random() * 10000;
          entry.nextAttempt = new Date(now + backoff + jitter).toISOString();
          entry.error = err instanceof Error ? err.message : String(err);
          lastError = entry.error;

          console.warn(`[Retry] Failed to forward to ${consumer.label}: ${entry.error}`);
          remainingEvents.push(entry);
        }
      } else {
        // Not time yet -> keep
        remainingEvents.push(entry);
      }
    }

    // 6) Crash-safety: write remaining first. If this fails, KEEP processing file for recovery.
    if (remainingEvents.length > 0) {
      await batchAppendEvents(remainingEvents); // throws on failure
    }

    // 7) Only now it is safe to delete processing file
    await fs.unlink(processingFile);

    // 8) Reset global metrics based on remaining events
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
    // Important: do NOT unlink processingFile here. initDelivery() can recover it later.
  } finally {
    if (release) await release();
  }
}

async function batchAppendEvents(entries: FailedEvent[]) {
  await ensureDataDir();
  await ensureLockFile();

  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  let release: any;

  try {
    release = await lock(getLockFilePath(), { retries: 3 });
    await fs.appendFile(getFailedLogPath(), lines, 'utf8');
  } catch (e) {
    console.error('Failed to batch requeue events', e);
    // Crash-safety: bubble up so retryFailedEvents keeps processingFile for recovery.
    throw e;
  } finally {
    if (release) await release();
  }
}