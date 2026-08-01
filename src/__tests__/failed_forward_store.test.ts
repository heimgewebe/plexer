import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { FailedForwardStore } from '../failedForwardStore';
import { FailedEvent } from '../types';

const makeEntry = (id: string, lastAttempt = new Date().toISOString()): FailedEvent => ({
  consumerKey: 'heimgeist',
  event: { type: 'test.event', source: 'test', payload: { id } },
  retryCount: 0,
  lastAttempt,
  nextAttempt: new Date(Date.now() + 60_000).toISOString(),
  error: 'down',
});

const storeFor = (
  dataDir: string,
  limits: Partial<{ maxBytes: number; maxEntries: number; maxAgeMs: number }> = {},
) => new FailedForwardStore(() => ({
  dataDir,
  maxBytes: limits.maxBytes ?? 1024 * 1024,
  maxEntries: limits.maxEntries ?? 100,
  maxAgeMs: limits.maxAgeMs ?? 60_000,
}));

const scanEntries = async (store: FailedForwardStore) => {
  const entries: FailedEvent[] = [];
  const usage = await store.scan((line) => {
    if (line.entry) entries.push(line.entry);
  });
  return { entries, usage };
};

describe('FailedForwardStore hard retention (real fs)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `plexer-failed-store-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('applies the entry total across the active file and a retry archive', async () => {
    const store = storeFor(dir, { maxEntries: 1 });
    await store.initialize();
    expect(await store.append([makeEntry('first')])).toEqual([{ status: 'persisted' }]);

    const claim = await store.claimNext();
    expect(claim).not.toBeNull();
    expect(await store.append([makeEntry('second')])).toEqual([
      { status: 'rejected', reason: 'quota' },
    ]);

    await store.replaceClaim(claim!, []);
    expect(await store.append([makeEntry('second')])).toEqual([{ status: 'persisted' }]);
  });

  it('accepts the exact byte boundary and rejects the next byte-bearing record', async () => {
    const entry = makeEntry('boundary');
    const exactBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
    const store = storeFor(dir, { maxBytes: exactBytes, maxEntries: 10 });
    await store.initialize();

    expect(await store.append([entry])).toEqual([{ status: 'persisted' }]);
    expect((await scanEntries(store)).usage.bytes).toBe(exactBytes);
    expect(await store.append([makeEntry('overflow')])).toEqual([
      { status: 'rejected', reason: 'quota' },
    ]);
  });

  it('normalizes restart state: corrupt, expired, and over-count records are evicted deterministically', async () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    const active = path.join(dir, 'failed_forwards.jsonl');
    await fs.writeFile(active, [
      'not-json',
      JSON.stringify(makeEntry('expired', old)),
      JSON.stringify(makeEntry('kept-first')),
      JSON.stringify(makeEntry('quota-tail')),
      '',
    ].join('\n'));

    const restarted = storeFor(dir, { maxEntries: 1, maxAgeMs: 60_000 });
    const report = await restarted.initialize();
    expect(report).toMatchObject({
      entries: 1,
      corruptDropped: 1,
      expiredDropped: 1,
      quotaDropped: 1,
    });
    const { entries } = await scanEntries(restarted);
    expect(entries.map((entry) => entry.event.payload)).toEqual([{ id: 'kept-first' }]);
  });

  it('bounds an oversized corrupt physical line without retaining it', async () => {
    await fs.writeFile(
      path.join(dir, 'failed_forwards.jsonl'),
      `${'x'.repeat(4_096)}\n`,
    );
    const store = storeFor(dir, { maxBytes: 256 });

    const report = await store.initialize();

    expect(report.corruptDropped).toBe(1);
    expect((await scanEntries(store)).usage).toEqual({ bytes: 0, entries: 0 });
  });

  it('preserves both records during a concurrent archive retry and active append', async () => {
    const store = storeFor(dir, { maxEntries: 2 });
    await store.initialize();
    await store.append([makeEntry('archived')]);
    const claim = await store.claimNext();
    expect(claim).not.toBeNull();
    const claimedLines = [];
    for await (const line of store.readClaim(claim!)) {
      if (line.raw) claimedLines.push(line.raw);
    }

    const [appendResult] = await Promise.all([
      store.append([makeEntry('concurrent')]),
      store.replaceClaim(claim!, claimedLines),
    ]);

    expect(appendResult).toEqual([{ status: 'persisted' }]);
    const { entries, usage } = await scanEntries(store);
    expect(entries.map((entry) => (entry.event.payload as { id: string }).id).sort())
      .toEqual(['archived', 'concurrent']);
    expect(usage.entries).toBe(2);
  });

  it('refuses a growing retry replacement and leaves the original archive intact', async () => {
    const store = storeFor(dir);
    await store.initialize();
    await store.append([makeEntry('original')]);
    const claim = await store.claimNext();
    expect(claim).not.toBeNull();
    const originals: string[] = [];
    for await (const line of store.readClaim(claim!)) {
      if (line.raw) originals.push(line.raw);
    }

    await expect(
      store.replaceClaim(claim!, [`${originals[0]}${' '.repeat(1_000)}`]),
    ).rejects.toThrow('exceeds claimed archive bounds');

    const { entries } = await scanEntries(store);
    expect(entries).toHaveLength(1);
    expect(entries[0].event.payload).toEqual({ id: 'original' });
    await store.abandonClaim(claim!);
    expect(await store.claimNext()).not.toBeNull();
  });

  it('recovers a crash-orphaned retry claim on restart', async () => {
    const store = storeFor(dir);
    await store.initialize();
    await store.append([makeEntry('restart-claim')]);
    const claim = await store.claimNext();
    expect(path.basename(claim!.path)).toMatch(/^retrying\./);

    const restarted = storeFor(dir);
    await restarted.initialize();
    const recovered = await restarted.claimNext();
    expect(recovered).not.toBeNull();
    const recoveredEntries = [];
    for await (const line of restarted.readClaim(recovered!)) {
      if (line.entry) recoveredEntries.push(line.entry);
    }
    expect(recoveredEntries).toHaveLength(1);
    expect(recoveredEntries[0].event.payload).toEqual({ id: 'restart-claim' });
  });
});
