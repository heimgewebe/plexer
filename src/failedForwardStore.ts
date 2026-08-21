import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { lock } from 'proper-lockfile';
import { config } from './config';
import { FailedEvent } from './types';
import { LOCK_RETRIES } from './constants';

const ACTIVE_FILE = 'failed_forwards.jsonl';
const LOCK_FILE = 'failed_forwards.lock';
const ARCHIVE_PATTERN = /^processing\.[A-Za-z0-9-]+\.jsonl$/;
const CLAIM_PATTERN = /^retrying\.[A-Za-z0-9-]+\.jsonl$/;
const TEMP_PREFIX = 'failed_forwards.tmp.';

export interface StoreLimits {
  maxBytes: number;
  maxEntries: number;
  maxAgeMs: number;
}

export interface StoreOptions extends StoreLimits {
  dataDir: string;
}

export interface QueueUsage {
  bytes: number;
  entries: number;
}

export interface RetentionReport extends QueueUsage {
  corruptDropped: number;
  expiredDropped: number;
  quotaDropped: number;
}

export type AppendResult =
  | { status: 'persisted' }
  | { status: 'rejected'; reason: 'quota' };

export interface QueueClaim extends QueueUsage {
  path: string;
}

export interface StoredQueueLine {
  /** Null means the physical line exceeded the configured byte bound. */
  raw: string | null;
  bytes: number;
  nonEmpty: boolean;
  entry?: FailedEvent;
}

type OptionsProvider = () => StoreOptions;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Runtime queue validation kept aligned with failed_event.v1. */
export function isFailedEventRecord(value: unknown): value is FailedEvent {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length !== 6 ||
    !keys.every((key) => [
      'consumerKey', 'event', 'retryCount', 'lastAttempt', 'nextAttempt', 'error',
    ].includes(key))
  ) return false;
  if (
    typeof value.consumerKey !== 'string' ||
    !Number.isInteger(value.retryCount) ||
    (value.retryCount as number) < 0 ||
    typeof value.lastAttempt !== 'string' ||
    !Number.isFinite(Date.parse(value.lastAttempt)) ||
    typeof value.nextAttempt !== 'string' ||
    !Number.isFinite(Date.parse(value.nextAttempt)) ||
    typeof value.error !== 'string' ||
    !isObject(value.event)
  ) return false;
  return typeof value.event.type === 'string' &&
    typeof value.event.source === 'string' &&
    Object.prototype.hasOwnProperty.call(value.event, 'payload');
}

function parseEntry(raw: string | null): FailedEvent | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return isFailedEventRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A bounded JSONL reader: memory use for one line never exceeds maxLineBytes.
 * Oversized physical lines are surfaced as corrupt without retaining their body.
 */
export async function* readBoundedQueueLines(
  filePath: string,
  maxLineBytes: number,
): AsyncGenerator<StoredQueueLine> {
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  let parts: Buffer[] = [];
  let retainedBytes = 0;
  let physicalBytes = 0;
  let overflow = false;
  let sawNonWhitespace = false;

  const addSegment = (segment: Buffer) => {
    physicalBytes += segment.length;
    if (!sawNonWhitespace) {
      sawNonWhitespace = segment.some((byte) => ![9, 10, 13, 32].includes(byte));
    }
    if (overflow) return;
    if (retainedBytes + segment.length > maxLineBytes) {
      overflow = true;
      parts = [];
      retainedBytes = 0;
      return;
    }
    if (segment.length > 0) {
      parts.push(Buffer.from(segment));
      retainedBytes += segment.length;
    }
  };

  const finishLine = (hasNewline: boolean): StoredQueueLine => {
    if (hasNewline) physicalBytes++;
    let raw: string | null = null;
    if (!overflow) {
      raw = Buffer.concat(parts, retainedBytes).toString('utf8').replace(/\r$/, '');
    }
    const result: StoredQueueLine = {
      raw,
      bytes: physicalBytes,
      nonEmpty: sawNonWhitespace,
    };
    if (result.nonEmpty) result.entry = parseEntry(raw);
    parts = [];
    retainedBytes = 0;
    physicalBytes = 0;
    overflow = false;
    sawNonWhitespace = false;
    return result;
  };

  for await (const chunkValue of stream) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      if (newline === -1) {
        addSegment(chunk.subarray(offset));
        break;
      }
      addSegment(chunk.subarray(offset, newline));
      yield finishLine(true);
      offset = newline + 1;
    }
  }

  if (physicalBytes > 0 || parts.length > 0 || overflow) {
    yield finishLine(false);
  }
}

export class FailedForwardStore {
  private readonly claimed = new Set<string>();

  constructor(private readonly getOptions: OptionsProvider) {}

  private options(): StoreOptions {
    return this.getOptions();
  }

  private activePath(options = this.options()): string {
    return path.join(path.resolve(options.dataDir), ACTIVE_FILE);
  }

  private lockPath(options = this.options()): string {
    return path.join(path.resolve(options.dataDir), LOCK_FILE);
  }

  private async ensureFiles(options = this.options()): Promise<void> {
    const dataDir = path.resolve(options.dataDir);
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(this.lockPath(options), '', { flag: 'a', mode: 0o600 });
    await fs.writeFile(this.activePath(options), '', { flag: 'a', mode: 0o600 });
  }

  private async withLock<T>(fn: (options: StoreOptions) => Promise<T>): Promise<T> {
    const options = this.options();
    await this.ensureFiles(options);
    const release = await lock(this.lockPath(options), { retries: LOCK_RETRIES });
    try {
      return await fn(options);
    } finally {
      await release();
    }
  }

  private async listDataFilesUnlocked(options: StoreOptions): Promise<string[]> {
    const dataDir = path.resolve(options.dataDir);
    const names = await fs.readdir(dataDir);
    const archives = names.filter((name) => (
      ARCHIVE_PATTERN.test(name) || CLAIM_PATTERN.test(name)
    ));
    const ranked = await Promise.all(archives.map(async (name) => {
      const filePath = path.join(dataDir, name);
      const stat = await fs.stat(filePath);
      return { filePath, mtimeMs: stat.mtimeMs };
    }));
    ranked.sort((a, b) => a.mtimeMs - b.mtimeMs || a.filePath.localeCompare(b.filePath));
    return [...ranked.map(({ filePath }) => filePath), this.activePath(options)];
  }

  private isExpired(entry: FailedEvent, nowMs: number, options: StoreOptions): boolean {
    return nowMs - Date.parse(entry.lastAttempt) > options.maxAgeMs;
  }

  private async atomicRewrite(
    filePath: string,
    lines: string[],
    trailingNewline = true,
  ): Promise<void> {
    const tempPath = path.join(
      path.dirname(filePath),
      `${TEMP_PREFIX}${randomUUID()}`,
    );
    const content = lines.length > 0
      ? `${lines.join('\n')}${trailingNewline ? '\n' : ''}`
      : '';
    try {
      await fs.writeFile(tempPath, content, { flag: 'wx', mode: 0o600 });
      await fs.rename(tempPath, filePath);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private async inspectFile(
    filePath: string,
    options: StoreOptions,
  ): Promise<QueueUsage> {
    let entries = 0;
    for await (const line of readBoundedQueueLines(filePath, options.maxBytes)) {
      if (line.nonEmpty) entries++;
    }
    const stat = await fs.stat(filePath).catch(() => null);
    return { bytes: stat?.size ?? 0, entries };
  }

  private async compactFilesUnlocked(
    files: string[],
    options: StoreOptions,
    initialUsage: QueueUsage = { bytes: 0, entries: 0 },
  ): Promise<RetentionReport> {
    const report: RetentionReport = {
      ...initialUsage,
      corruptDropped: 0,
      expiredDropped: 0,
      quotaDropped: 0,
    };
    const nowMs = Date.now();

    for (const filePath of files) {
      const kept: string[] = [];
      for await (const line of readBoundedQueueLines(filePath, options.maxBytes)) {
        if (!line.nonEmpty) continue;
        if (!line.entry) {
          report.corruptDropped++;
          continue;
        }
        if (this.isExpired(line.entry, nowMs, options)) {
          report.expiredDropped++;
          continue;
        }

        const normalized = JSON.stringify(line.entry);
        const bytes = Buffer.byteLength(normalized, 'utf8') + 1;
        if (
          report.entries + 1 > options.maxEntries ||
          report.bytes + bytes > options.maxBytes
        ) {
          report.quotaDropped++;
          continue;
        }
        kept.push(normalized);
        report.entries++;
        report.bytes += bytes;
      }
      await this.atomicRewrite(filePath, kept);
    }
    return report;
  }

  /** Startup/restart normalization, including orphaned processing archives. */
  async initialize(): Promise<RetentionReport> {
    return this.withLock(async (options) => {
      const dataDir = path.resolve(options.dataDir);
      for (const name of await fs.readdir(dataDir)) {
        if (name.startsWith(TEMP_PREFIX)) {
          await fs.unlink(path.join(dataDir, name)).catch(() => undefined);
        } else if (CLAIM_PATTERN.test(name)) {
          const claimPath = path.join(dataDir, name);
          if (this.claimed.has(claimPath)) continue;
          // A retrying file at process initialization is a crash orphan. Make
          // it claimable again without copying or merging its accepted records.
          await fs.rename(
            claimPath,
            path.join(dataDir, `processing.${randomUUID()}.jsonl`),
          );
        }
      }
      const files = await this.listDataFilesUnlocked(options);
      let claimedUsage: QueueUsage = { bytes: 0, entries: 0 };
      const compactableFiles: string[] = [];
      for (const filePath of files) {
        if (!this.claimed.has(filePath)) {
          compactableFiles.push(filePath);
          continue;
        }
        const usage = await this.inspectFile(filePath, options);
        claimedUsage = {
          bytes: claimedUsage.bytes + usage.bytes,
          entries: claimedUsage.entries + usage.entries,
        };
      }
      return this.compactFilesUnlocked(compactableFiles, options, claimedUsage);
    });
  }

  /**
   * Append in arrival order. Existing archives have priority; new records are
   * rejected at an exact byte/entry boundary rather than evicting retryable data.
   */
  async append(entries: FailedEvent[]): Promise<AppendResult[]> {
    return this.withLock(async (options) => {
      const files = await this.listDataFilesUnlocked(options);
      const active = this.activePath(options);
      const archives = files.filter((file) => file !== active);
      const claimedArchives = archives.filter((file) => (
        this.claimed.has(file) || CLAIM_PATTERN.test(path.basename(file))
      ));
      const compactableFiles = [
        ...archives.filter((file) => !claimedArchives.includes(file)),
        active,
      ];
      let claimedUsage: QueueUsage = { bytes: 0, entries: 0 };
      for (const archive of claimedArchives) {
        const usage = await this.inspectFile(archive, options);
        claimedUsage = {
          bytes: claimedUsage.bytes + usage.bytes,
          entries: claimedUsage.entries + usage.entries,
        };
      }

      // Normalize every unclaimed file on each write. A claimed archive is
      // immutable until its in-flight retry replaces it, so concurrent appends
      // cannot invalidate that retry's source inode or resurrect an eviction.
      const activeReport = await this.compactFilesUnlocked(
        compactableFiles,
        options,
        claimedUsage,
      );
      let bytes = activeReport.bytes;
      let entryCount = activeReport.entries;
      const accepted: string[] = [];
      const results: AppendResult[] = [];

      for (const entry of entries) {
        const line = JSON.stringify(entry);
        const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
        if (
          entryCount + 1 > options.maxEntries ||
          bytes + lineBytes > options.maxBytes
        ) {
          results.push({ status: 'rejected', reason: 'quota' });
          continue;
        }
        accepted.push(line);
        entryCount++;
        bytes += lineBytes;
        results.push({ status: 'persisted' });
      }

      if (accepted.length > 0) {
        await fs.appendFile(active, `${accepted.join('\n')}\n`, {
          encoding: 'utf8',
          mode: 0o600,
        });
      }
      return results;
    });
  }

  /** Rotate the active file and claim the oldest archive for one retry run. */
  async claimNext(): Promise<QueueClaim | null> {
    return this.withLock(async (options) => {
      const active = this.activePath(options);
      const activeStat = await fs.stat(active).catch(() => null);
      if (activeStat && activeStat.size > 0) {
        const archive = path.join(
          path.resolve(options.dataDir),
          `processing.${randomUUID()}.jsonl`,
        );
        await fs.rename(active, archive);
        await fs.writeFile(active, '', { mode: 0o600 });
      }

      const files = await this.listDataFilesUnlocked(options);
      for (const filePath of files) {
        if (
          filePath === active ||
          this.claimed.has(filePath) ||
          !ARCHIVE_PATTERN.test(path.basename(filePath))
        ) continue;
        const claimedPath = path.join(
          path.resolve(options.dataDir),
          `retrying.${randomUUID()}.jsonl`,
        );
        await fs.rename(filePath, claimedPath);
        const usage = await this.inspectFile(claimedPath, options);
        if (usage.bytes === 0) {
          await fs.unlink(claimedPath).catch(() => undefined);
          continue;
        }
        this.claimed.add(claimedPath);
        return { path: claimedPath, ...usage };
      }
      return null;
    });
  }

  readClaim(claim: QueueClaim): AsyncGenerator<StoredQueueLine> {
    return readBoundedQueueLines(claim.path, this.options().maxBytes);
  }

  async abandonClaim(claim: QueueClaim): Promise<void> {
    try {
      await this.withLock(async (options) => {
        const stat = await fs.stat(claim.path).catch(() => null);
        if (!stat) return;
        await fs.rename(
          claim.path,
          path.join(path.resolve(options.dataDir), `processing.${randomUUID()}.jsonl`),
        );
      });
    } finally {
      this.claimed.delete(claim.path);
    }
  }

  /**
   * Replace an archive in place. A retry may only shrink (or preserve) the
   * archive, preventing concurrent active appends from being invalidated by
   * retry metadata growth.
   */
  async replaceClaim(claim: QueueClaim, lines: string[]): Promise<void> {
    try {
      const entries = lines.length;
      const bytes = lines.reduce(
        (sum, line) => sum + Buffer.byteLength(line, 'utf8'),
        Math.max(0, lines.length - 1),
      );
      if (entries > claim.entries || bytes > claim.bytes) {
        throw new Error('Retry replacement exceeds claimed archive bounds');
      }
      await this.withLock(async (options) => {
        if (lines.length === 0) {
          await fs.unlink(claim.path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        } else {
          // No trailing newline avoids growing a legacy archive whose final
          // record did not have one, while remaining valid JSONL.
          await this.atomicRewrite(claim.path, lines, false);
          await fs.rename(
            claim.path,
            path.join(
              path.resolve(options.dataDir),
              `processing.${randomUUID()}.jsonl`,
            ),
          );
        }
      });
    } finally {
      this.claimed.delete(claim.path);
    }
  }

  /** Locked scan across the live active file and every retry archive. */
  async scan(
    visitor: (line: StoredQueueLine) => void,
  ): Promise<QueueUsage> {
    return this.withLock(async (options) => {
      let usage: QueueUsage = { bytes: 0, entries: 0 };
      for (const filePath of await this.listDataFilesUnlocked(options)) {
        const stat = await fs.stat(filePath).catch(() => null);
        usage.bytes += stat?.size ?? 0;
        for await (const line of readBoundedQueueLines(filePath, options.maxBytes)) {
          if (!line.nonEmpty) continue;
          usage.entries++;
          visitor(line);
        }
      }
      return usage;
    });
  }
}

export const failedForwardStore = new FailedForwardStore(() => ({
  dataDir: config.dataDir,
  maxBytes: config.failedForwardsMaxBytes ?? 16 * 1024 * 1024,
  maxEntries: config.failedForwardsMaxEntries ?? 10_000,
  maxAgeMs: config.failedForwardsMaxAgeMs ?? 7 * 24 * 60 * 60 * 1_000,
}));
