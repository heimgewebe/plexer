import { FailedEvent } from '../types';

jest.mock('../config', () => ({
  config: {
    dataDir: 'data',
    retryConcurrency: 2,
    retryBatchSize: 4,
    failedForwardsMaxBytes: 1024 * 1024,
    failedForwardsMaxEntries: 100,
    failedForwardsMaxAgeMs: 60_000,
    chronikUrl: 'http://chronik.local',
  },
}));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../chronik', () => ({ deliverToChronikAgentLedger: jest.fn() }));
jest.mock('../consumers', () => ({
  CONSUMERS: [
    {
      key: 'test-consumer',
      label: 'Test Consumer',
      url: 'http://test.local',
      token: 'consumer-token',
      authKind: 'bearer',
    },
  ],
}));
jest.mock('../failedForwardStore', () => ({
  failedForwardStore: {
    initialize: jest.fn(),
    append: jest.fn(),
    claimNext: jest.fn(),
    readClaim: jest.fn(),
    replaceClaim: jest.fn(),
    abandonClaim: jest.fn(),
    scan: jest.fn(),
  },
}));

import {
  flushFailedWrites,
  initDelivery,
  retryFailedEvents,
  saveFailedEvent,
} from '../delivery';
import { failedForwardStore } from '../failedForwardStore';
import { deliverToChronikAgentLedger } from '../chronik';
import { logger } from '../logger';

const store = failedForwardStore as jest.Mocked<typeof failedForwardStore>;
const deliverMock = deliverToChronikAgentLedger as jest.MockedFunction<
  typeof deliverToChronikAgentLedger
>;

const makeEntry = (overrides: Partial<FailedEvent> = {}): FailedEvent => ({
  consumerKey: 'test-consumer',
  event: { type: 'test', source: 'src', payload: {} },
  retryCount: 0,
  lastAttempt: new Date().toISOString(),
  nextAttempt: new Date(Date.now() - 1_000).toISOString(),
  error: 'previous failure',
  ...overrides,
});

const queueLine = (entry: FailedEvent, extraBytes = 256) => {
  const raw = JSON.stringify(entry);
  return {
    raw,
    bytes: Buffer.byteLength(raw, 'utf8') + 1 + extraBytes,
    nonEmpty: true,
    entry,
  };
};

const lines = (...values: ReturnType<typeof queueLine>[]) => (
  async function* () {
    for (const value of values) yield value;
  }
)();

describe('Delivery reliability orchestration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.initialize.mockResolvedValue({
      bytes: 0,
      entries: 0,
      corruptDropped: 0,
      expiredDropped: 0,
      quotaDropped: 0,
    });
    store.append.mockImplementation(async (entries) => (
      entries.map(() => ({ status: 'persisted' as const }))
    ));
    store.claimNext.mockResolvedValue(null);
    store.readClaim.mockImplementation(() => lines());
    store.replaceClaim.mockResolvedValue(undefined);
    store.scan.mockResolvedValue({ bytes: 0, entries: 0 });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    await flushFailedWrites();
  });

  it('persists a valid failed event and reports the durable result', async () => {
    const result = await saveFailedEvent(
      { type: 'test', source: 'src', payload: {} },
      'test-consumer',
      'failure',
    );

    expect(result).toEqual({ status: 'persisted' });
    expect(store.append).toHaveBeenCalledTimes(1);
    expect(store.append.mock.calls[0][0][0]).toMatchObject({
      consumerKey: 'test-consumer',
      retryCount: 0,
      error: 'failure',
    });
  });

  it('returns an explicit quota rejection instead of claiming persistence', async () => {
    store.append.mockResolvedValueOnce([{ status: 'rejected', reason: 'quota' }]);
    const result = await saveFailedEvent(
      { type: 'test', source: 'src', payload: {} },
      'test-consumer',
      'failure',
    );
    expect(result).toEqual({ status: 'rejected', reason: 'quota' });
  });

  it('keeps the in-memory entry reservation bounded while a batch is flushing', async () => {
    let releaseAppend!: () => void;
    store.append.mockImplementationOnce((entries) => new Promise((resolve) => {
      releaseAppend = () => resolve(entries.map(() => ({ status: 'persisted' as const })));
    }));
    const first = saveFailedEvent(
      { type: 'test', source: 'src', payload: {} },
      'test-consumer',
      'failure',
    );
    while (store.append.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const staged = Array.from({ length: 99 }, () => saveFailedEvent(
      { type: 'test', source: 'src', payload: {} },
      'test-consumer',
      'failure',
    ));
    const excess = await saveFailedEvent(
      { type: 'test', source: 'src', payload: {} },
      'test-consumer',
      'failure',
    );
    expect(excess).toEqual({ status: 'rejected', reason: 'quota' });

    releaseAppend();
    await Promise.all([first, ...staged]);
  });

  it('rejects invalid queue records before the store and does not log payloads', async () => {
    const result = await saveFailedEvent(
      { type: 'test' } as never,
      'test-consumer',
      'failure',
    );
    expect(result).toEqual({ status: 'rejected', reason: 'invalid' });
    expect(store.append).not.toHaveBeenCalled();
    const serializedLogs = JSON.stringify((logger.error as jest.Mock).mock.calls);
    expect(serializedLogs).not.toContain('"payload"');
  });

  it('normalizes retention and scans all queue files on restart', async () => {
    store.initialize.mockResolvedValueOnce({
      bytes: 200,
      entries: 1,
      corruptDropped: 1,
      expiredDropped: 2,
      quotaDropped: 3,
    });
    await initDelivery();
    expect(store.initialize).toHaveBeenCalledTimes(1);
    expect(store.scan).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        corrupt_dropped: 1,
        expired_dropped: 2,
        quota_dropped: 3,
      }),
      expect.stringContaining('retention'),
    );
  });

  it('removes a successfully retried archive entry', async () => {
    const entry = makeEntry();
    const line = queueLine(entry);
    store.claimNext.mockResolvedValueOnce({ path: '/queue/processing.a.jsonl', bytes: line.bytes, entries: 1 });
    store.readClaim.mockImplementationOnce(() => lines(line));

    await retryFailedEvents();

    expect(global.fetch).toHaveBeenCalledWith(
      'http://test.local',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(store.replaceClaim).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/queue/processing.a.jsonl' }),
      [],
    );
  });

  it('requeues a failed retry with bounded updated metadata', async () => {
    const entry = makeEntry();
    const line = queueLine(entry);
    store.claimNext.mockResolvedValueOnce({ path: '/queue/processing.b.jsonl', bytes: line.bytes, entries: 1 });
    store.readClaim.mockImplementationOnce(() => lines(line));
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Error',
    }) as unknown as typeof fetch;

    await retryFailedEvents();

    const replacement = store.replaceClaim.mock.calls[0][1];
    expect(replacement).toHaveLength(1);
    const saved = JSON.parse(replacement[0]);
    expect(saved.retryCount).toBe(1);
    expect(Date.parse(saved.nextAttempt)).toBeGreaterThan(Date.now());
  });

  it('preserves a future entry without attempting delivery', async () => {
    const entry = makeEntry({
      nextAttempt: new Date(Date.now() + 60_000).toISOString(),
    });
    const line = queueLine(entry);
    store.claimNext.mockResolvedValueOnce({ path: '/queue/processing.c.jsonl', bytes: line.bytes, entries: 1 });
    store.readClaim.mockImplementationOnce(() => lines(line));

    await retryFailedEvents();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(store.replaceClaim.mock.calls[0][1]).toEqual([line.raw]);
  });

  it('drops corrupt archive lines deterministically', async () => {
    store.claimNext.mockResolvedValueOnce({ path: '/queue/processing.d.jsonl', bytes: 8, entries: 1 });
    store.readClaim.mockImplementationOnce(() => (
      async function* () {
        yield { raw: 'broken', bytes: 7, nonEmpty: true };
      }
    )());

    await retryFailedEvents();

    expect(store.replaceClaim.mock.calls[0][1]).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ corrupt_dropped: 1 }),
      expect.stringContaining('non-retryable archive'),
    );
  });

  it('leaves a claimed archive intact when replacement fails', async () => {
    const entry = makeEntry({ nextAttempt: new Date(Date.now() + 60_000).toISOString() });
    const line = queueLine(entry);
    const claim = { path: '/queue/processing.e.jsonl', bytes: line.bytes, entries: 1 };
    store.claimNext.mockResolvedValueOnce(claim);
    store.readClaim.mockImplementationOnce(() => lines(line));
    store.replaceClaim.mockRejectedValueOnce(new Error('disk failure'));

    await retryFailedEvents();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Error processing failed events'),
    );
  });

  it('retries Chronik ledger entries through the critical delivery path', async () => {
    const entry = makeEntry({
      consumerKey: 'chronik-agent-ledger',
      event: { type: 'agent.run.ledger.v1', source: 'plexer', payload: { kind: 'agent.run.completed' } },
    });
    const line = queueLine(entry);
    store.claimNext.mockResolvedValueOnce({ path: '/queue/processing.f.jsonl', bytes: line.bytes, entries: 1 });
    store.readClaim.mockImplementationOnce(() => lines(line));
    deliverMock.mockResolvedValue({ status: 'delivered', retryable: false, statusCode: 202 });

    await retryFailedEvents();

    expect(deliverMock).toHaveBeenCalledWith(entry.event.payload);
    expect(store.replaceClaim.mock.calls[0][1]).toEqual([]);
  });
});
