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

const waitForClaimHeartbeat = () => new Promise((resolve) => setTimeout(resolve, 2_500));

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

  it('reserves byte quota for a live claim owned by another store instance', async () => {
    const entry = makeEntry('claimed');
    const maxBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
    const owner = storeFor(dir, { maxBytes, maxEntries: 10 });
    const peer = storeFor(dir, { maxBytes, maxEntries: 10 });
    await owner.initialize();
    await owner.append([entry]);
    const claim = await owner.claimNext();
    expect(claim).not.toBeNull();

    expect(await peer.initialize()).toMatchObject({
      bytes: claim!.bytes,
      entries: claim!.entries,
    });
    expect(await peer.append([makeEntry('rejected')])).toEqual([
      { status: 'rejected', reason: 'quota' },
    ]);

    await owner.replaceClaim(claim!, []);
    await expect(fs.stat(`${claim!.path}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
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

  it('recovers a retry claim whose filesystem lease is stale', async () => {
    const store = storeFor(dir);
    await store.initialize();
    await store.append([makeEntry('restart-claim')]);
    const activePath = path.join(dir, 'failed_forwards.jsonl');
    const orphanPath = path.join(dir, 'retrying.crashed.jsonl');
    await fs.rename(activePath, orphanPath);
    await fs.writeFile(activePath, '');
    const leasePath = `${orphanPath}.lock`;
    await fs.mkdir(leasePath);
    await fs.utimes(leasePath, new Date(0), new Date(0));

    const restarted = storeFor(dir);
    await restarted.initialize();
    await expect(fs.stat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const recovered = await restarted.claimNext();
    expect(recovered).not.toBeNull();
    const recoveredEntries = [];
    for await (const line of restarted.readClaim(recovered!)) {
      if (line.entry) recoveredEntries.push(line.entry);
    }
    expect(recoveredEntries).toHaveLength(1);
    expect(recoveredEntries[0].event.payload).toEqual({ id: 'restart-claim' });
    await restarted.replaceClaim(recovered!, []);
  });

  it('does not recover or rewrite a live claim owned by another store instance', async () => {
    const owner = storeFor(dir);
    const peer = storeFor(dir);
    await owner.initialize();
    await owner.append([makeEntry('live-cross-instance')]);
    const claim = await owner.claimNext();
    expect(claim).not.toBeNull();
    const before = await fs.readFile(claim!.path);

    await peer.initialize();

    expect(await fs.readFile(claim!.path)).toEqual(before);
    expect(await peer.claimNext()).toBeNull();
    await owner.replaceClaim(claim!, []);
  });

  it.each(['replace', 'abandon'] as const)(
    'rejects %s after the claim lease is compromised without mutating the claim',
    async (operation) => {
      const owner = storeFor(dir);
      await owner.initialize();
      await owner.append([makeEntry(`compromised-${operation}`)]);
      const claim = await owner.claimNext();
      expect(claim).not.toBeNull();
      const before = await fs.readFile(claim!.path);

      await fs.rm(`${claim!.path}.lock`, { recursive: true, force: true });
      await waitForClaimHeartbeat();

      const mutation = operation === 'replace'
        ? owner.replaceClaim(claim!, [])
        : owner.abandonClaim(claim!);
      await expect(mutation).rejects.toThrow('Retry claim ownership lost');
      expect(await fs.readFile(claim!.path)).toEqual(before);
    },
    10_000,
  );

  it('abandons a claim that disappears after it was claimed', async () => {
    const store = storeFor(dir);
    await store.initialize();
    await store.append([makeEntry('missing-on-abandon')]);
    const claim = await store.claimNext();
    expect(claim).not.toBeNull();
    const activePath = path.join(dir, 'failed_forwards.jsonl');
    const activeBefore = await fs.readFile(activePath);
    const leasePath = `${claim!.path}.lock`;

    await fs.unlink(claim!.path);
    expect(await fs.stat(leasePath)).toBeDefined();

    await expect(store.abandonClaim(claim!)).resolves.toBeUndefined();

    await expect(fs.stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(claim!.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(activePath)).toEqual(activeBefore);
    expect((await fs.readdir(dir)).sort()).toEqual([
      'failed_forwards.jsonl',
      'failed_forwards.lock',
    ]);
  });

  it('recovers a fresh restart orphan on a later claimNext after its lease is stale', async () => {
    const activePath = path.join(dir, 'failed_forwards.jsonl');
    const orphanPath = path.join(dir, 'retrying.fresh-orphan.jsonl');
    const leasePath = `${orphanPath}.lock`;
    await fs.writeFile(orphanPath, `${JSON.stringify(makeEntry('fresh-orphan'))}\n`);
    await fs.mkdir(leasePath);

    const restarted = storeFor(dir);
    await restarted.initialize();
    expect(await fs.readFile(orphanPath, 'utf8')).toContain('fresh-orphan');
    expect(await fs.stat(activePath)).toBeDefined();

    await fs.utimes(leasePath, new Date(0), new Date(0));
    const recovered = await restarted.claimNext();
    expect(recovered).not.toBeNull();
    const bytes = await fs.readFile(recovered!.path, 'utf8');
    expect(bytes).toContain('fresh-orphan');
    await restarted.replaceClaim(recovered!, []);
    await expect(fs.stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reaps a stale claim lock directory whose claim file is absent', async () => {
    const store = storeFor(dir);
    await store.initialize();
    const leasePath = path.join(dir, 'retrying.missing.jsonl.lock');
    await fs.mkdir(leasePath);
    await fs.utimes(leasePath, new Date(0), new Date(0));

    expect(await store.claimNext()).toBeNull();

    await expect(fs.stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not orphan or duplicate a live claim when initialization repeats', async () => {
    const store = storeFor(dir);
    await store.initialize();
    await store.append([makeEntry('live-claim')]);
    const claim = await store.claimNext();
    expect(claim).not.toBeNull();
    const claimedLines: string[] = [];
    for await (const line of store.readClaim(claim!)) {
      if (line.raw) claimedLines.push(line.raw);
    }

    await store.initialize();
    await store.replaceClaim(claim!, claimedLines);

    const { entries } = await scanEntries(store);
    expect(entries.map((entry) => entry.event.payload)).toEqual([{ id: 'live-claim' }]);
  });
});
