import request from 'supertest';
import fsPromises from 'fs/promises';
import fs from 'fs';
import readline from 'readline';
import { Writable } from 'stream';
import { lock } from 'proper-lockfile';

/**
 * Critical-sink readiness diagnostics.
 *
 * Exercises the real delivery-module counters (via the same fs-mock harness as
 * delivery.test.ts) plus the /readiness endpoint mapping in server.ts.
 * Scope guard: this is an internal diagnostic surface, not the vendored
 * plexer.delivery.report.v1 contract — these tests must not assert on that report.
 */

// Mutable config mock so a single test can flip chronikUrl to exercise the
// 'unconfigured' branch without re-importing the module.
const mockConfig: Record<string, unknown> = {
  port: 3000,
  host: '0.0.0.0',
  environment: 'test',
  chronikUrl: 'http://chronik.local',
  chronikToken: 'chronik-secret',
  dataDir: 'data',
  retryConcurrency: 1,
  retryBatchSize: 5,
};
jest.mock('../config', () => ({ config: mockConfig }));

jest.mock('fs/promises', () => ({
  appendFile: jest.fn(),
  writeFile: jest.fn(),
  access: jest.fn(),
  rename: jest.fn(),
  unlink: jest.fn(),
  readdir: jest.fn(),
  readFile: jest.fn(),
  mkdir: jest.fn(),
  stat: jest.fn(),
  copyFile: jest.fn(),
}));

jest.mock('fs', () => ({
  createReadStream: jest.fn(),
  createWriteStream: jest.fn(),
}));

jest.mock('stream/promises', () => ({ pipeline: jest.fn() }));
jest.mock('readline', () => ({ createInterface: jest.fn() }));
jest.mock('proper-lockfile', () => ({ lock: jest.fn() }));

jest.mock('../consumers', () => ({
  CONSUMERS: [
    { key: 'heimgeist', label: 'Heimgeist', url: 'http://heimgeist.local', token: 't', authKind: 'x-auth' },
    { key: 'chronik', label: 'Chronik', url: 'http://chronik.local', token: 't', authKind: 'x-auth' },
  ],
}));

jest.mock('../chronik', () => ({ deliverToChronikAgentLedger: jest.fn() }));

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  initDelivery,
  retryFailedEvents,
  saveFailedChronikAgentLedgerEvent,
  getCriticalSinkReadiness,
  flushFailedWrites,
} from '../delivery';
import { deliverToChronikAgentLedger } from '../chronik';
import { createServer } from '../server';

const CRITICAL_KEY = 'chronik-agent-ledger';

const criticalEntry = (nextAttempt: string, retryCount = 1) =>
  JSON.stringify({
    consumerKey: CRITICAL_KEY,
    event: { type: 'agent.run.ledger.v1', source: 'plexer', payload: { kind: 'agent.run.completed' } },
    retryCount,
    nextAttempt,
    lastAttempt: new Date().toISOString(),
    error: 'chronik down',
  });

const observerEntry = (nextAttempt: string) =>
  JSON.stringify({
    consumerKey: 'heimgeist',
    event: { type: 'x', source: 's', payload: {} },
    retryCount: 0,
    nextAttempt,
    lastAttempt: new Date().toISOString(),
    error: 'e',
  });

describe('Critical-sink readiness', () => {
  const mockAccess = fsPromises.access as jest.Mock;
  const mockReaddir = fsPromises.readdir as jest.Mock;
  const mockMkdir = fsPromises.mkdir as jest.Mock;
  const mockWriteFile = fsPromises.writeFile as jest.Mock;
  const mockStat = fsPromises.stat as jest.Mock;
  const mockRename = fsPromises.rename as jest.Mock;
  const mockUnlink = fsPromises.unlink as jest.Mock;
  const mockCopyFile = fsPromises.copyFile as jest.Mock;
  const mockCreateReadStream = fs.createReadStream as jest.Mock;
  const mockCreateWriteStream = fs.createWriteStream as jest.Mock;
  const mockPipeline = require('stream/promises').pipeline as jest.Mock;
  const mockCreateInterface = readline.createInterface as jest.Mock;
  const mockLock = lock as jest.Mock;
  const deliverMock = deliverToChronikAgentLedger as jest.MockedFunction<typeof deliverToChronikAgentLedger>;

  let mockRl: any;
  let mockStream: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig.chronikUrl = 'http://chronik.local';

    mockAccess.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ size: 100 });
    mockRename.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
    mockCopyFile.mockResolvedValue(undefined);
    mockPipeline.mockResolvedValue(undefined);
    mockLock.mockResolvedValue(jest.fn());

    mockStream = { on: jest.fn(), off: jest.fn(), removeListener: jest.fn(), destroy: jest.fn() };
    mockCreateReadStream.mockReturnValue(mockStream);
    mockCreateWriteStream.mockReturnValue(new Writable({ write: (c, e, cb) => cb() }));

    mockRl = {
      on: jest.fn(),
      off: jest.fn(),
      removeListener: jest.fn(),
      close: jest.fn(),
      [Symbol.asyncIterator]: jest.fn().mockReturnValue((async function* () {})()),
    };
    mockCreateInterface.mockReturnValue(mockRl);
  });

  const mockReadLines = (lines: string[]) => {
    mockRl[Symbol.asyncIterator].mockReturnValue((async function* () {
      for (const line of lines) yield line;
    })());
  };

  it('reports "degraded" and counts only the critical subset of the queue', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60000).toISOString();
    // One critical (due) + two observer entries — only the critical one must count.
    mockReadLines([criticalEntry(past), observerEntry(future), observerEntry(past)]);

    await initDelivery();

    const readiness = getCriticalSinkReadiness();
    expect(readiness.status).toBe('degraded');
    expect(readiness.configured).toBe(true);
    expect(readiness.critical_sink).toBe('chronik.agent.ledger');
    expect(readiness.queued).toBe(1);
    expect(readiness.retryable_now).toBe(1);
    expect(readiness.next_due_at).toBe(past);
  });

  it('reports "ready" when the critical queue is empty', async () => {
    mockReadLines([observerEntry(new Date(Date.now() + 60000).toISOString())]);

    await initDelivery();

    const readiness = getCriticalSinkReadiness();
    expect(readiness.status).toBe('ready');
    expect(readiness.queued).toBe(0);
    expect(readiness.retryable_now).toBe(0);
    expect(readiness.next_due_at).toBeNull();
  });

  it('reports "unconfigured" when CHRONIK_URL is absent', async () => {
    mockReadLines([]);
    await initDelivery();
    mockConfig.chronikUrl = undefined;

    const readiness = getCriticalSinkReadiness();
    expect(readiness.status).toBe('unconfigured');
    expect(readiness.configured).toBe(false);
  });

  it('increments the critical count and records last_error when an agent.ledger event is queued', async () => {
    mockReadLines([]);
    await initDelivery();
    expect(getCriticalSinkReadiness().queued).toBe(0);

    await saveFailedChronikAgentLedgerEvent({ kind: 'agent.run.completed' }, 'chronik unreachable');
    await flushFailedWrites();

    const readiness = getCriticalSinkReadiness();
    expect(readiness.queued).toBe(1);
    expect(readiness.status).toBe('degraded');
    expect(readiness.last_error).toBe('chronik unreachable');
  });

  it('clears the critical count and stamps last_delivered_at after a successful retry', async () => {
    // Start degraded: one due critical entry in the processing file.
    mockReadLines([criticalEntry(new Date(Date.now() - 1000).toISOString())]);
    deliverMock.mockResolvedValue({ status: 'delivered', retryable: false, statusCode: 202 });

    await retryFailedEvents();

    const readiness = getCriticalSinkReadiness();
    expect(deliverMock).toHaveBeenCalled();
    expect(readiness.queued).toBe(0);
    expect(readiness.status).toBe('ready');
    expect(readiness.last_delivered_at).not.toBeNull();
  });

  describe('GET /readiness endpoint', () => {
    const app = createServer();

    it('returns 200 when the critical sink is ready', async () => {
      mockReadLines([]);
      await initDelivery();

      const res = await request(app).get('/readiness');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.critical_sink).toBe('chronik.agent.ledger');
    });

    it('returns 503 when the critical sink is degraded', async () => {
      mockReadLines([criticalEntry(new Date(Date.now() - 1000).toISOString())]);
      await initDelivery();

      const res = await request(app).get('/readiness');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('degraded');
      expect(res.body.queued).toBe(1);
    });

    it('returns 503 when the critical sink is unconfigured', async () => {
      mockReadLines([]);
      await initDelivery();
      mockConfig.chronikUrl = undefined;

      const res = await request(app).get('/readiness');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unconfigured');
    });
  });
});
