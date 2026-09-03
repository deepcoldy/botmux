import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { scanJsonlFromFd } from './jsonl-cursor.js';
import { ompMessageText } from './omp-transcript.js';
import { fsyncDirectorySyncPortable } from '../utils/fs-durability.js';
import { withFileLockSync } from '../utils/file-lock.js';

const JSONL_SUFFIX = '.jsonl';
const COPY_CHUNK_BYTES = 64 * 1024;
const NO_FOLLOW = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
const DEFAULT_LIMITS = {
  maxBuckets: 256,
  maxFiles: 4_096,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
} as const;

export interface OmpLegacyMigrationLimits {
  maxBuckets: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxLineBytes: number;
}

/** Deterministic race hooks for the focused filesystem tests. Production never supplies them. */
export interface OmpLegacyMigrationTestHooks {
  beforeCopy?: (sourcePath: string) => void;
  beforePublish?: (targetPath: string) => void;
}

export interface OmpLegacyMigrationOptions {
  limits?: Partial<OmpLegacyMigrationLimits>;
  testHooks?: OmpLegacyMigrationTestHooks;
}

export type OmpLegacyMigrationResult =
  | { status: 'migrated'; sourcePath: string; targetPath: string; artifactDirectoryPreserved: boolean }
  | { status: 'skipped'; reason: 'exact-history-exists' | 'no-match' | 'ambiguous' | 'inconclusive'; detail?: string };

interface Candidate {
  path: string;
  realPath: string;
  bucketReal: string;
  stats: Stats;
}

function isStrictDescendant(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function exactDirectoryState(exactSessionDir: string): 'empty' | 'history' | 'unsafe' {
  const stats = lstatIfPresent(exactSessionDir);
  if (!stats) return 'empty';
  if (stats.isSymbolicLink() || !stats.isDirectory()) return 'unsafe';
  for (const entry of readdirSync(exactSessionDir, { withFileTypes: true })) {
    // The name alone blocks migration. A symlink, directory, FIFO, or raced leaf
    // ending in .jsonl is uncertainty, never permission to publish another file.
    if (entry.name.endsWith(JSONL_SUFFIX)) return 'history';
  }
  return 'empty';
}

function isValidTitleSlot(record: Record<string, unknown>): boolean {
  return record.type === 'title'
    && record.v === 1
    && typeof record.title === 'string'
    && typeof record.updatedAt === 'string'
    && typeof record.pad === 'string';
}

function scanCandidate(
  fd: number,
  candidate: Candidate,
  effectiveSessionId: string,
  canonicalWorkingDir: string,
  limits: OmpLegacyMigrationLimits,
): 'match' | 'reject' | 'inconclusive' {
  let physicalLine = 0;
  let header: Record<string, unknown> | undefined;
  let malformed = false;
  let oversizedLine = false;
  let targetMarker = false;
  let foreignMarker = false;
  const exactMarker = `<session_id>${effectiveSessionId}</session_id>`;
  const markerPattern = /<session_id>([^<>\r\n]+)<\/session_id>/g;

  const cursor = scanJsonlFromFd(fd, 0, {
    endOffset: candidate.stats.size,
    onError: () => { malformed = true; },
    onLine: line => {
      physicalLine++;
      if (Buffer.byteLength(line, 'utf8') > limits.maxLineBytes) {
        oversizedLine = true;
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformed = true;
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        malformed = true;
        return;
      }
      const record = parsed as Record<string, unknown>;
      if (physicalLine === 1 && isValidTitleSlot(record)) return;
      const expectedHeaderLine = physicalLine === 1 ? 1 : 2;
      if (!header && physicalLine === expectedHeaderLine) {
        header = record;
        return;
      }
      if (record.type !== 'message') return;
      const message = record.message;
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const messageRecord = message as Record<string, unknown>;
      if (messageRecord.role !== 'user') return;
      const text = ompMessageText(messageRecord.content);
      if (text.includes(exactMarker)) targetMarker = true;
      markerPattern.lastIndex = 0;
      for (let marker = markerPattern.exec(text); marker; marker = markerPattern.exec(text)) {
        if (marker[1] !== effectiveSessionId) foreignMarker = true;
      }
    },
  });

  if (!cursor || cursor.pendingTail || malformed || oversizedLine) return 'inconclusive';
  if (!header
    || header.type !== 'session'
    || !Number.isSafeInteger(header.version)
    || (header.version as number) < 1
    || typeof header.id !== 'string'
    || header.id.length === 0
    || /[/\\]/.test(header.id)
    || typeof header.timestamp !== 'string'
    || header.timestamp.length === 0
    || typeof header.cwd !== 'string') return 'reject';
  if (!basename(candidate.path).endsWith(`_${header.id}${JSONL_SUFFIX}`)) return 'reject';
  try {
    if (realpathSync(header.cwd) !== canonicalWorkingDir) return 'reject';
  } catch {
    return 'reject';
  }
  return targetMarker && !foreignMarker ? 'match' : 'reject';
}

function discoverCandidate(
  sessionsRootReal: string,
  effectiveSessionId: string,
  canonicalWorkingDir: string,
  limits: OmpLegacyMigrationLimits,
): { candidate?: Candidate; reason?: 'no-match' | 'ambiguous' | 'inconclusive'; detail?: string } {
  const rootEntries = readdirSync(sessionsRootReal, { withFileTypes: true });
  let bucketsSeen = 0;
  let filesSeen = 0;
  let totalBytes = 0;
  const matches: Candidate[] = [];

  for (const entry of rootEntries) {
    if (entry.name === 'botmux') continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    bucketsSeen++;
    if (bucketsSeen > limits.maxBuckets) {
      return { reason: 'inconclusive', detail: 'legacy bucket scan limit exhausted' };
    }
    const bucketPath = join(sessionsRootReal, entry.name);
    const bucketStats = lstatSync(bucketPath);
    if (bucketStats.isSymbolicLink() || !bucketStats.isDirectory()) {
      return { reason: 'inconclusive', detail: 'legacy bucket changed during scan' };
    }
    const bucketReal = realpathSync(bucketPath);
    if (dirname(bucketReal) !== sessionsRootReal) {
      return { reason: 'inconclusive', detail: 'legacy bucket escaped sessions root' };
    }

    for (const fileEntry of readdirSync(bucketPath, { withFileTypes: true })) {
      if (!fileEntry.name.endsWith(JSONL_SUFFIX)) continue;
      filesSeen++;
      if (filesSeen > limits.maxFiles) {
        return { reason: 'inconclusive', detail: 'legacy file scan limit exhausted' };
      }
      const path = join(bucketPath, fileEntry.name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        return { reason: 'inconclusive', detail: 'unsafe legacy JSONL entry' };
      }
      if (stats.size > limits.maxFileBytes) {
        return { reason: 'inconclusive', detail: 'legacy per-file scan limit exhausted' };
      }
      totalBytes += stats.size;
      if (totalBytes > limits.maxTotalBytes) {
        return { reason: 'inconclusive', detail: 'legacy total scan limit exhausted' };
      }
      const realPath = realpathSync(path);
      if (dirname(realPath) !== bucketReal || !isStrictDescendant(sessionsRootReal, realPath)) {
        return { reason: 'inconclusive', detail: 'legacy JSONL escaped its bucket' };
      }

      let fd: number | undefined;
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW);
        const opened = fstatSync(fd);
        if (!opened.isFile()
          || opened.dev !== stats.dev
          || opened.ino !== stats.ino
          || opened.size !== stats.size
          || opened.mtimeMs !== stats.mtimeMs
          || opened.ctimeMs !== stats.ctimeMs) {
          return { reason: 'inconclusive', detail: 'legacy JSONL changed while opening' };
        }
        const candidate = { path, realPath, bucketReal, stats };
        const outcome = scanCandidate(fd, candidate, effectiveSessionId, canonicalWorkingDir, limits);
        if (outcome === 'inconclusive') {
          return { reason: 'inconclusive', detail: 'legacy JSONL was malformed or exceeded a line limit' };
        }
        if (outcome === 'match') matches.push(candidate);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
  }

  if (matches.length === 0) return { reason: 'no-match' };
  if (matches.length !== 1) return { reason: 'ambiguous' };
  return { candidate: matches[0] };
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function writeAll(fd: number, buffer: Buffer, length: number): void {
  let offset = 0;
  while (offset < length) {
    const written = writeSync(fd, buffer, offset, length - offset);
    if (written <= 0) throw new Error('short write while migrating OMP transcript');
    offset += written;
  }
}

function digestFd(fd: number, size: number): string {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (count <= 0) throw new Error('short read while verifying OMP transcript');
    digest.update(buffer.subarray(0, count));
    offset += count;
  }
  return digest.digest('hex');
}

function copyCandidate(
  candidate: Candidate,
  exactSessionDir: string,
  sessionsRootReal: string,
  hooks: OmpLegacyMigrationTestHooks | undefined,
): { targetPath: string; artifactDirectoryPreserved: boolean } {
  hooks?.beforeCopy?.(candidate.path);
  const rescanned = lstatSync(candidate.path);
  if (!sameSnapshot(rescanned, candidate.stats)
    || realpathSync(candidate.path) !== candidate.realPath
    || dirname(candidate.realPath) !== candidate.bucketReal) {
    throw new Error('legacy OMP source changed after attribution');
  }

  const botmuxRoot = dirname(exactSessionDir);
  const botmuxStats = lstatIfPresent(botmuxRoot);
  if (botmuxStats && (botmuxStats.isSymbolicLink() || !botmuxStats.isDirectory())) {
    throw new Error('unsafe OMP botmux session root');
  }
  if (!botmuxStats) mkdirSync(botmuxRoot, { mode: 0o700 });
  const botmuxReal = realpathSync(botmuxRoot);
  if (dirname(botmuxReal) !== sessionsRootReal || basename(botmuxReal) !== 'botmux') {
    throw new Error('OMP botmux session root escaped sessions root');
  }

  if (!lstatIfPresent(exactSessionDir)) {
    mkdirSync(exactSessionDir, { mode: 0o700 });
  }
  const targetDirStats = lstatSync(exactSessionDir);
  if (targetDirStats.isSymbolicLink() || !targetDirStats.isDirectory()) {
    throw new Error('unsafe exact OMP session directory');
  }
  const targetDirReal = realpathSync(exactSessionDir);
  if (dirname(targetDirReal) !== botmuxReal || basename(targetDirReal) !== basename(exactSessionDir)) {
    throw new Error('exact OMP session directory escaped botmux root');
  }
  if (exactDirectoryState(targetDirReal) !== 'empty') {
    throw new Error('exact OMP history appeared before copy');
  }

  const targetPath = join(targetDirReal, basename(candidate.path));
  const tempPath = join(targetDirReal, `.${basename(candidate.path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let sourceFd: number | undefined;
  let tempFd: number | undefined;
  try {
    sourceFd = openSync(candidate.path, constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW);
    const opened = fstatSync(sourceFd);
    if (!sameSnapshot(opened, candidate.stats)) throw new Error('legacy OMP source raced while opening');

    tempFd = openSync(
      tempPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    fchmodSync(tempFd, 0o600);
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    const sourceDigest = createHash('sha256');
    let copiedBytes = 0;
    while (copiedBytes < opened.size) {
      const count = readSync(sourceFd, buffer, 0, Math.min(buffer.length, opened.size - copiedBytes), copiedBytes);
      if (count <= 0) throw new Error('short read while migrating OMP transcript');
      sourceDigest.update(buffer.subarray(0, count));
      writeAll(tempFd, buffer, count);
      copiedBytes += count;
    }
    const sourceAfterCopy = fstatSync(sourceFd);
    if (!sameSnapshot(sourceAfterCopy, opened) || copiedBytes !== opened.size) {
      throw new Error('legacy OMP source changed while copying');
    }
    const tempStats = fstatSync(tempFd);
    if (!tempStats.isFile() || tempStats.nlink !== 1 || tempStats.size !== copiedBytes
      || (process.platform !== 'win32' && (tempStats.mode & 0o777) !== 0o600)) {
      throw new Error('unsafe OMP temporary transcript copy');
    }
    fsyncSync(tempFd);
    const expectedDigest = sourceDigest.digest('hex');

    hooks?.beforePublish?.(targetPath);
    if (exactDirectoryState(targetDirReal) !== 'empty' || lstatIfPresent(targetPath)) {
      throw new Error('exact OMP history appeared before publication');
    }
    linkSync(tempPath, targetPath);
    unlinkSync(tempPath);
    closeSync(tempFd);
    tempFd = undefined;

    const destinationFd = openSync(targetPath, constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW);
    try {
      const destination = fstatSync(destinationFd);
      if (!destination.isFile() || destination.nlink !== 1 || destination.size !== opened.size
        || (process.platform !== 'win32' && (destination.mode & 0o777) !== 0o600)
        || digestFd(destinationFd, destination.size) !== expectedDigest) {
        throw new Error('published OMP transcript failed identity verification');
      }
    } finally {
      closeSync(destinationFd);
    }
    fsyncDirectorySyncPortable(targetDirReal);

    const artifactPath = candidate.path.slice(0, -JSONL_SUFFIX.length);
    const artifactStats = lstatIfPresent(artifactPath);
    return {
      targetPath,
      artifactDirectoryPreserved: !!artifactStats && !artifactStats.isSymbolicLink() && artifactStats.isDirectory(),
    };
  } catch (error) {
    if (tempFd !== undefined) {
      try { closeSync(tempFd); } catch { /* best effort */ }
    }
    try { unlinkSync(tempPath); } catch { /* absent or already published */ }
    // Never delete a published destination: it is complete and no-overwrite.
    // The ordinary exact probe conservatively treats it as present even if a
    // later durability or verification step fails.
    throw error;
  } finally {
    if (sourceFd !== undefined) {
      try { closeSync(sourceFd); } catch { /* best effort */ }
    }
  }
}

/**
 * Copy one uniquely attributable pre-exact-dir OMP transcript into the exact
 * Botmux directory. Every uncertainty is reported as a skip; the caller then
 * runs the existing pure exact-path resume probe and fresh fallback.
 */
export function migrateLegacyOmpSession(
  effectiveSessionId: string,
  workingDir: string,
  exactSessionDir: string,
  options: OmpLegacyMigrationOptions = {},
): OmpLegacyMigrationResult {
  try {
    if (!effectiveSessionId || effectiveSessionId === '.' || effectiveSessionId === '..'
      || /[/\\]/.test(effectiveSessionId)) {
      return { status: 'skipped', reason: 'inconclusive', detail: 'invalid effective OMP session id' };
    }
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) {
      return { status: 'skipped', reason: 'inconclusive', detail: 'invalid migration scan limits' };
    }

    const expectedBotmuxRoot = dirname(exactSessionDir);
    const sessionsRoot = dirname(expectedBotmuxRoot);
    if (basename(exactSessionDir) !== effectiveSessionId
      || basename(expectedBotmuxRoot) !== 'botmux'
      || resolve(exactSessionDir) !== join(resolve(sessionsRoot), 'botmux', effectiveSessionId)) {
      return { status: 'skipped', reason: 'inconclusive', detail: 'exact OMP directory does not match effective id' };
    }
    const sessionsStats = lstatSync(sessionsRoot);
    if (sessionsStats.isSymbolicLink() || !sessionsStats.isDirectory()) {
      return { status: 'skipped', reason: 'inconclusive', detail: 'unsafe OMP sessions root' };
    }
    const sessionsRootReal = realpathSync(sessionsRoot);
    if (sessionsRootReal !== resolve(sessionsRoot)) {
      return { status: 'skipped', reason: 'inconclusive', detail: 'OMP sessions root is not canonical' };
    }
    const canonicalWorkingDir = realpathSync(workingDir);
    const lockDigest = createHash('sha256').update(exactSessionDir).digest('hex').slice(0, 24);
    const lockTarget = join(sessionsRootReal, `.botmux-legacy-migration-${lockDigest}`);

    return withFileLockSync(lockTarget, () => {
      const exactState = exactDirectoryState(exactSessionDir);
      if (exactState === 'history') return { status: 'skipped', reason: 'exact-history-exists' };
      if (exactState === 'unsafe') {
        return { status: 'skipped', reason: 'inconclusive', detail: 'unsafe exact OMP session directory' };
      }

      const discovered = discoverCandidate(
        sessionsRootReal,
        effectiveSessionId,
        canonicalWorkingDir,
        limits,
      );
      if (!discovered.candidate) {
        return {
          status: 'skipped',
          reason: discovered.reason ?? 'inconclusive',
          detail: discovered.detail,
        };
      }
      const copied = copyCandidate(
        discovered.candidate,
        exactSessionDir,
        sessionsRootReal,
        options.testHooks,
      );
      return {
        status: 'migrated',
        sourcePath: discovered.candidate.path,
        ...copied,
      };
    });
  } catch (error) {
    return {
      status: 'skipped',
      reason: 'inconclusive',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
