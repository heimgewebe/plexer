import request from 'supertest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

/**
 * Critical-sink readiness diagnostics — real filesystem integration.
 *
 * These tests exercise the actual delivery module against a real temp queue
 * directory (real rename/append/proper-lockfile/scan). Only config, logger,
 * chronik delivery and consumers are mocked. This is deliberately NOT a stream
 * mock: the post-retry recompute now reads the live queue file, so a faithful
 * fs is required to prove the write-during-retry invariant.
 *
 * Scope guard: internal diagnostic surface only, never the vendored
 * plexer.delivery.report.v1 contract.
 */

const mockConfig: Record<string, unknown> = {
  port: 3000,
  host: '0.0.0.0',
  environment: 'test',
  chronikUrl: 'http://chronik.local',
  chronikToken: 'chronik-secret',
  dataDir: '', // set per test
  retryConcurrency: 2,
  retryBatchSize: 5,
};
jest.mock('../config', () => ({ config: mockConfig }));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../chronik', () => ({ deliverToChronikAgentLedger: jest.fn() }));
jest.mock('../consumers', () => ({
  CONSUMERS: [
    { key: 'heimgeist', label: 'Heimgeist', url: 'http://heimgeist.local', token: 't', authKind: 'x-auth' },
    { key: 'chronik', label: 'Chronik', url: 'http://chronik.local', token: 't', authKind: 'x-auth' },
  ],
}));

import {
  initDelivery,
  retryFailedEvents,
  saveFailedChronikAgentLedgerEvent,
  getCriticalSinkReadiness,
  getDeliveryMetrics,
  flushFailedWrites,
} from '../delivery';
import { deliverToChronikAgentLedger } from '../chronik';
import { createServer } from '../server';

const CRITICAL_KEY = 'chronik-agent-ledger';
const deliverMock = deliverToChronikAgentLedger as jest.MockedFunction<typeof deliverToChronikAgentLedger>;

const failedLogPath = () => path.join(mockConfig.dataDir as string, 'failed_forwards.jsonl');

interface EntryOpts {
  nextAttempt: string;
  error?: unknown;
  lastAttempt?: string;
  retryCount?: number;
  consumerKey?: string;
}
const entry = (o: EntryOpts) => ({
  consumerKey: o.consumerKey ?? CRITICAL_KEY,
  event: { type: 'agent.run.ledger.v1', source: 'plexer', payload: { kind: 'agent.run.completed' } },
  retryCount: o.retryCount ?? 1,
  nextAttempt: o.nextAttempt,
  lastAttempt: o.lastAttempt ?? new Date().toISOString(),
  error: o.error ?? 'chronik down',
});
const criticalEntry = (o: EntryOpts) => entry(o);
const observerEntry = (o: Omit<EntryOpts, 'consumerKey'>) => entry({ ...o, consumerKey: 'heimgeist' });

const past = () => new Date(Date.now() - 1000).toISOString();
const future = () => new Date(Date.now() + 60000).toISOString();

// Write the queue file directly (JSONL), bypassing the write pipeline.
const seedQueue = async (rows: unknown[]) => {
  const body = rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');
  await fs.writeFile(failedLogPath(), rows.length ? body + '\n' : '');
};

const waitFor = async (cond: () => boolean, timeoutMs = 3000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('Critical-sink readiness (real fs)', () => {
  let dir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Reset (not just clear) so a gated mockImplementation from one test cannot
    // leak into a later test that forgets to set its own delivery behavior.
    deliverMock.mockReset();
    dir = path.join(os.tmpdir(), `plexer-readiness-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    mockConfig.dataDir = dir;
    mockConfig.chronikUrl = 'http://chronik.local';
    mockConfig.chronikToken = 'chronik-secret';
  });

  afterEach(async () => {
    try {
      await Promise.race([flushFailedWrites(), new Promise((r) => setTimeout(r, 1000))]);
    } catch { /* best-effort drain */ }
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('summary from the queue', () => {
    it('reports "degraded", counts only the critical subset, reconstructs last_error', async () => {
      await seedQueue([criticalEntry({ nextAttempt: past() }), observerEntry({ nextAttempt: future() }), observerEntry({ nextAttempt: past() })]);
      await initDelivery();

      const r = getCriticalSinkReadiness();
      expect(r.status).toBe('degraded');
      expect(r.configured).toBe(true);
      expect(r.critical_sink).toBe('chronik.agent.ledger');
      expect(r.queued).toBe(1);
      expect(r.retryable_now).toBe(1);
      expect(r.last_error).toBe('chronik down');
      expect(r.due_now).toBe(true);
    });

    it('reports "ready" when the critical queue is empty', async () => {
      await seedQueue([observerEntry({ nextAttempt: future() })]);
      await initDelivery();

      const r = getCriticalSinkReadiness();
      expect(r.status).toBe('ready');
      expect(r.queued).toBe(0);
      expect(r.retryable_now).toBe(0);
      expect(r.next_due_at).toBeNull();
      expect(r.due_now).toBe(false);
      expect(r.last_error).toBeNull();
    });

    it('reports "unconfigured" when CHRONIK_URL is absent', async () => {
      await seedQueue([]);
      await initDelivery();
      mockConfig.chronikUrl = undefined;

      const r = getCriticalSinkReadiness();
      expect(r.status).toBe('unconfigured');
      expect(r.configured).toBe(false);
    });

    it('exposes queue_state basis without an active probe', async () => {
      await seedQueue([]);
      await initDelivery();

      const r = getCriticalSinkReadiness();
      expect(r.status_basis).toBe('queue_state');
      expect(r.active_probe).toBe(false);
    });

    it('reconstructs last_error from an existing critical queue entry on init (restart)', async () => {
      await seedQueue([criticalEntry({ nextAttempt: past(), error: 'chronik down' })]);
      await initDelivery();

      const r = getCriticalSinkReadiness();
      expect(r.status).toBe('degraded');
      expect(r.queued).toBe(1);
      expect(r.last_error).toBe('chronik down');
    });

    it('prefers the error of the most recently attempted open entry', async () => {
      const older = new Date(Date.now() - 60000).toISOString();
      const newer = new Date(Date.now() - 1000).toISOString();
      await seedQueue([
        criticalEntry({ nextAttempt: future(), error: 'older error', lastAttempt: older }),
        criticalEntry({ nextAttempt: future(), error: 'newer error', lastAttempt: newer }),
      ]);
      await initDelivery();

      expect(getCriticalSinkReadiness().last_error).toBe('newer error');
    });
  });

  describe('CHRONIK_TOKEN semantics', () => {
    it('is configured with only CHRONIK_URL set (token optional)', async () => {
      mockConfig.chronikToken = undefined;
      await seedQueue([]);
      await initDelivery();

      const r = getCriticalSinkReadiness();
      expect(r.configured).toBe(true);
      expect(r.status).not.toBe('unconfigured');
      expect(r.status).toBe('ready');
    });
  });

  describe('write path', () => {
    it('increments the critical count and records last_error on save; fresh entry is not yet due', async () => {
      await seedQueue([]);
      await initDelivery();
      expect(getCriticalSinkReadiness().queued).toBe(0);

      await saveFailedChronikAgentLedgerEvent({ kind: 'agent.run.completed' }, 'chronik unreachable');
      await flushFailedWrites();

      const r = getCriticalSinkReadiness();
      expect(r.queued).toBe(1);
      expect(r.status).toBe('degraded');
      expect(r.last_error).toBe('chronik unreachable');
      expect(r.retryable_now).toBe(0); // ~30s out
      expect(r.due_now).toBe(false);
    });
  });

  describe('retry recompute', () => {
    it('clears the critical count and last_error, stamps last_delivered_at, after a successful retry', async () => {
      await seedQueue([criticalEntry({ nextAttempt: past(), error: 'chronik down' })]);
      await initDelivery();
      expect(getCriticalSinkReadiness().status).toBe('degraded');

      deliverMock.mockResolvedValue({ status: 'delivered', retryable: false, statusCode: 202 });
      await retryFailedEvents();

      const r = getCriticalSinkReadiness();
      expect(deliverMock).toHaveBeenCalled();
      expect(r.status).toBe('ready');
      expect(r.queued).toBe(0);
      expect(r.last_error).toBeNull();
      expect(r.last_delivered_at).not.toBeNull();
    });

    it('keeps last_error from the still-queued entry on partial recovery', async () => {
      await seedQueue([
        criticalEntry({ nextAttempt: past(), error: 'transient' }),
        criticalEntry({ nextAttempt: future(), error: 'persistent' }),
      ]);
      await initDelivery();

      deliverMock.mockResolvedValue({ status: 'delivered', retryable: false, statusCode: 202 });
      await retryFailedEvents();

      const r = getCriticalSinkReadiness();
      expect(r.status).toBe('degraded');
      expect(r.queued).toBe(1);
      expect(r.last_error).toBe('persistent');
    });

    // Stress/smoke test (NOT a deterministic interleaving proof): the two ops
    // race, so retry may finish before the write lands. The invariant it guards
    // is that the empty-reset path never permanently drops a concurrent write.
    // The deterministic interleaving proof is the in-flight-retry test below.
    it('empty-reset path does not clobber a concurrent critical write (stress)', async () => {
      await seedQueue([]);
      await initDelivery();
      expect(getCriticalSinkReadiness().status).toBe('ready');

      // Race the empty-queue retry (early reset path) against a producer write.
      // The saved event is future-dated (~30s), so it is never delivered here;
      // whichever path runs, it must survive as a queued critical event.
      await Promise.all([
        retryFailedEvents(),
        (async () => {
          await saveFailedChronikAgentLedgerEvent({ kind: 'agent.run.blocked' }, 'raced with empty reset');
          await flushFailedWrites();
        })(),
      ]);

      const r = getCriticalSinkReadiness();
      expect(r.queued).toBe(1);
      expect(r.status).toBe('degraded');
      expect(r.last_error).toBe('raced with empty reset');
      expect(getDeliveryMetrics(0).counts.failed).toBe(1);
    });

    // The core invariant: a retry run must not drop metrics/state for events
    // that were persisted concurrently while it awaited delivery.
    it('does not lose a critical event queued DURING an in-flight retry', async () => {
      await seedQueue([criticalEntry({ nextAttempt: past(), error: 'original' })]);
      await initDelivery();
      expect(getCriticalSinkReadiness().queued).toBe(1);

      // Gate the delivery so we can inject a concurrent write mid-retry.
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      deliverMock.mockImplementation(async () => {
        await gate;
        return { status: 'delivered', retryable: false, statusCode: 202 };
      });

      const retryP = retryFailedEvents();
      await waitFor(() => deliverMock.mock.calls.length > 0);

      // Concurrent producer write while retry is parked in delivery.
      await saveFailedChronikAgentLedgerEvent({ kind: 'agent.run.blocked' }, 'concurrent failure');
      await flushFailedWrites();

      release();
      await retryP;

      const r = getCriticalSinkReadiness();
      // The originally-queued event was delivered; the concurrently-written one
      // must survive the retry's final recompute.
      expect(r.status).toBe('degraded');
      expect(r.queued).toBe(1);
      expect(r.last_error).toBe('concurrent failure');
      // Aggregate metric must also reflect the surviving event.
      expect(getDeliveryMetrics(0).counts.failed).toBe(1);
    });
  });

  describe('queue corruption tolerance', () => {
    it('ignores invalid JSON lines and does not let a bad nextAttempt pollute next_due_at', async () => {
      const p = past();
      await seedQueue([
        'this is not json',
        criticalEntry({ nextAttempt: 'garbage-date', error: 'bad-date-entry' }),
        criticalEntry({ nextAttempt: p, error: 'valid-entry', lastAttempt: new Date().toISOString() }),
      ]);
      await initDelivery();

      const r = getCriticalSinkReadiness();
      expect(r.status).toBe('degraded');
      expect(r.queued).toBe(2); // two parseable critical entries
      expect(r.next_due_at).toBe(p); // garbage nextAttempt did not set minNext
      expect(r.due_now).toBe(true);
      expect(typeof r.last_error === 'string').toBe(true);
    });

    it('keeps last_error type-safe when an entry has a non-string error', async () => {
      await seedQueue([
        criticalEntry({ nextAttempt: past(), error: 12345 }),
      ]);
      await initDelivery();

      const r = getCriticalSinkReadiness();
      expect(r.queued).toBe(1);
      // Non-string error must never become last_error.
      expect(r.last_error === null || typeof r.last_error === 'string').toBe(true);
      expect(r.last_error).not.toBe(12345 as unknown as string);
      expect(r.last_error).toBeNull();
    });
  });

  describe('GET /readiness endpoint', () => {
    const app = createServer();

    it('returns 200 and diagnostic fields when ready', async () => {
      await seedQueue([]);
      await initDelivery();

      const res = await request(app).get('/readiness');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.status_basis).toBe('queue_state');
      expect(res.body.active_probe).toBe(false);
      expect(res.body.critical_sink).toBe('chronik.agent.ledger');
    });

    it('returns 503 with degraded diagnostics and last_error from the queue', async () => {
      await seedQueue([criticalEntry({ nextAttempt: past(), error: 'chronik down' })]);
      await initDelivery();

      const res = await request(app).get('/readiness');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('degraded');
      expect(res.body.queued).toBe(1);
      expect(res.body.due_now).toBe(true);
      expect(res.body.last_error).toBe('chronik down');
    });

    it('returns 503 when unconfigured', async () => {
      await seedQueue([]);
      await initDelivery();
      mockConfig.chronikUrl = undefined;

      const res = await request(app).get('/readiness');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unconfigured');
    });

    it('GET /diagnostics/critical-sink returns 200 even when degraded', async () => {
      await seedQueue([criticalEntry({ nextAttempt: past(), error: 'chronik down' })]);
      await initDelivery();

      const res = await request(app).get('/diagnostics/critical-sink');
      expect(res.status).toBe(200); // canonical dashboard endpoint never 503s
      expect(res.body.status).toBe('degraded');
      expect(res.body.critical_sink).toBe('chronik.agent.ledger');
      expect(res.body.last_error).toBe('chronik down');
    });
  });
});
