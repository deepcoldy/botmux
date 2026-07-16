/**
 * Cross-process advisory lock for a single file. Used to serialize
 * read-modify-write of shared JSON config (e.g. `bots.json` from multiple
 * daemon processes + the dashboard).
 *
 * Acquisition: atomic `open(path + '.lock', 'wx')`. The filesystem makes
 * O_CREAT|O_EXCL atomic, so exactly one waiter wins.
 *
 * Stale-break: a holder that crashes mid-section leaves the lock file
 * behind with its PID + process-start identity (legacy plain PIDs remain
 * readable). A crash before the payload write leaves an empty lock, reclaimed
 * only after a longer grace. To reclaim either shape we create a generation-
 * scoped hard-link claim. Breaker ownership is an append-only epoch lease:
 * `owner-000...`, `owner-001...`, etc. A dead owner is replaced by atomically
 * creating the next epoch, so a crash at any point can be resumed without
 * reusing or deleting an active owner's pathname. Only the live highest epoch
 * may unlink the public lock, after proving the claim, its pinned observation,
 * and the public path are the same inode. This avoids both the classic delayed
 * pathname-unlink race and the old fixed `.stale-claim` crash wedge.
 *
 * Not reentrant. Don't nest `withFileLock` calls on the same path within
 * the same process — the inner call would wait MAX_WAIT_MS and then time
 * out. (We could allow reentrancy via PID-equal check, but our callers
 * don't need it and the equality check would re-open the stale-break race.)
 */
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  promises as fsp,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { readLinuxBootIdentity, readProcessStartIdentity } from '../core/session-marker.js';
import { logger } from './logger.js';

const MAX_WAIT_MS = 5_000;
const RETRY_BASE_MS = 25;
// Minimum age before we'll consider stale-breaking a lock with a dead PID.
// Prevents racing on freshly-acquired locks where the holder might not have
// finished writing its PID file yet.
const MIN_STALE_AGE_MS = 100;
// `open(..., 'wx')` creates the inode before the holder PID is written. A
// crash in that tiny window leaves an empty/invalid lock. Never steal a live
// writer's freshly-created file, but do reclaim an invalid holder after a more
// conservative grace period so crash recovery cannot deadlock forever.
const MIN_INVALID_HOLDER_STALE_AGE_MS = 1_000;
const STALE_CLAIM_PREFIX = '.botmux-stale-claim-';
const STALE_CLAIM_OWNER_SUFFIX = '.owner-';
const STALE_CLAIM_OWNER_WIDTH = 12;

interface LockHolder {
  pid: number;
  procStart?: string;
  bootId?: string;
}

let selfProcStartResolved = false;
let selfProcStart: string | undefined;
let selfBootIdResolved = false;
let selfBootId: string | undefined;

function currentLockHolderPayload(): string {
  if (!selfProcStartResolved) {
    selfProcStart = readProcessStartIdentity(process.pid);
    selfProcStartResolved = true;
  }
  if (!selfBootIdResolved) {
    selfBootId = readLinuxBootIdentity();
    selfBootIdResolved = true;
  }
  return selfProcStart || selfBootId
    ? JSON.stringify({
        pid: process.pid,
        ...(selfProcStart ? { procStart: selfProcStart } : {}),
        ...(selfBootId ? { bootId: selfBootId } : {}),
      })
    : String(process.pid);
}

function parseLockHolder(raw: string): LockHolder | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) {
    const pid = Number(text);
    return Number.isSafeInteger(pid) && pid > 1 ? { pid } : undefined;
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 1) return undefined;
    if (
      record.procStart !== undefined &&
      (typeof record.procStart !== 'string' || !record.procStart || record.procStart.length > 256)
    ) return undefined;
    if (
      record.bootId !== undefined &&
      (typeof record.bootId !== 'string' || !record.bootId || record.bootId.length > 256)
    ) return undefined;
    return {
      pid: record.pid as number,
      ...(typeof record.procStart === 'string' ? { procStart: record.procStart } : {}),
      ...(typeof record.bootId === 'string' ? { bootId: record.bootId } : {}),
    };
  } catch {
    return undefined;
  }
}

async function isHolderAlive(holder: LockHolder): Promise<boolean> {
  if (holder.bootId) {
    const liveBoot = readLinuxBootIdentity();
    if (liveBoot === undefined) return true;
    if (liveBoot !== holder.bootId) return false;
  }
  if (holder.procStart) {
    const liveStart = readProcessStartIdentity(holder.pid);
    if (liveStart !== undefined) return liveStart === holder.procStart;
  }
  const pid = holder.pid;
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isHolderAliveSync(holder: LockHolder): boolean {
  if (holder.bootId) {
    const liveBoot = readLinuxBootIdentity();
    if (liveBoot === undefined) return true;
    if (liveBoot !== holder.bootId) return false;
  }
  if (holder.procStart) {
    const liveStart = readProcessStartIdentity(holder.pid);
    if (liveStart !== undefined) return liveStart === holder.procStart;
  }
  const pid = holder.pid;
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sameInode(
  left: Pick<import('node:fs').Stats, 'dev' | 'ino'>,
  right: Pick<import('node:fs').Stats, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function releaseOwnedLock(lockPath: string, owned: import('node:fs').Stats): Promise<void> {
  try {
    const current = await fsp.lstat(lockPath);
    if (current.isFile() && !current.isSymbolicLink() && sameInode(current, owned)) {
      await fsp.unlink(lockPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function releaseOwnedLockSync(lockPath: string, owned: import('node:fs').Stats): void {
  try {
    const current = lstatSync(lockPath);
    if (current.isFile() && !current.isSymbolicLink() && sameInode(current, owned)) {
      unlinkSync(lockPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function staleClaimPathFor(
  lockPath: string,
  observed: Pick<import('node:fs').Stats, 'dev' | 'ino' | 'birthtimeMs'>,
): string {
  // link(2) changes ctime, so the generation deliberately uses only identity
  // metadata that remains stable for the inode's entire lifetime. In
  // particular, size and mtime are excluded: a late holder write must not let
  // two breakers elect different claims for the same inode.
  // The digest keeps the sibling filename well below NAME_MAX even when the
  // target filename itself is long.
  const generation = createHash('sha256')
    .update([
      String(observed.dev),
      String(observed.ino),
      String(observed.birthtimeMs),
    ].join('\0'))
    .digest('hex')
    .slice(0, 24);
  return join(dirname(lockPath), `${STALE_CLAIM_PREFIX}${generation}`);
}

function staleClaimOwnerPath(claimPath: string, epoch: number): string {
  return `${claimPath}${STALE_CLAIM_OWNER_SUFFIX}${String(epoch).padStart(STALE_CLAIM_OWNER_WIDTH, '0')}`;
}

function parseStaleClaimOwnerEpoch(claimPath: string, name: string): number | undefined {
  const prefix = `${basename(claimPath)}${STALE_CLAIM_OWNER_SUFFIX}`;
  if (!name.startsWith(prefix)) return undefined;
  const raw = name.slice(prefix.length);
  if (raw.length !== STALE_CLAIM_OWNER_WIDTH || !/^\d+$/.test(raw)) return undefined;
  const epoch = Number(raw);
  return Number.isSafeInteger(epoch) ? epoch : undefined;
}

interface PinnedHolderObservation {
  holder: LockHolder | undefined;
  ageMs: number;
  stats: import('node:fs').Stats;
}

async function readPinnedHolder(path: string): Promise<PinnedHolderObservation> {
  const handle = await fsp.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const raw = await handle.readFile('utf8');
    const after = await handle.stat();
    if (!before.isFile() || !sameInode(before, after) || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('file-lock stale-claim owner changed while reading');
    }
    return { holder: parseLockHolder(raw), ageMs: Date.now() - after.mtimeMs, stats: after };
  } finally {
    await handle.close();
  }
}

function readPinnedHolderSync(path: string): PinnedHolderObservation {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    const raw = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    if (!before.isFile() || !sameInode(before, after) || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('file-lock stale-claim owner changed while reading');
    }
    return { holder: parseLockHolder(raw), ageMs: Date.now() - after.mtimeMs, stats: after };
  } finally {
    closeSync(fd);
  }
}

interface StaleClaimOwnership {
  ownerPath: string;
  handle: import('node:fs/promises').FileHandle;
}

async function tryAcquireStaleClaimOwnership(
  claimPath: string,
  claimWasCreated: boolean,
  minStaleAgeMs: number,
): Promise<StaleClaimOwnership | undefined> {
  let claim: import('node:fs').Stats;
  try {
    claim = await fsp.lstat(claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!claim.isFile() || claim.isSymbolicLink()) {
    throw new Error('file-lock stale-claim is not a regular file');
  }

  const ownerEpochs = (await fsp.readdir(dirname(claimPath)))
    .map(name => parseStaleClaimOwnerEpoch(claimPath, name))
    .filter((epoch): epoch is number => epoch !== undefined)
    .sort((left, right) => left - right);

  let nextEpoch = 0;
  const latestEpoch = ownerEpochs.at(-1);
  if (latestEpoch === undefined) {
    // The creator may still be between link(2) and owner publication. The
    // claim inode's ctime is refreshed by link(2), unlike its old mtime.
    const ownerlessAgeMs = Date.now() - claim.ctimeMs;
    if (!claimWasCreated && ownerlessAgeMs < Math.max(minStaleAgeMs, MIN_INVALID_HOLDER_STALE_AGE_MS)) {
      return undefined;
    }
  } else {
    let observedOwner: PinnedHolderObservation;
    try {
      observedOwner = await readPinnedHolder(staleClaimOwnerPath(claimPath, latestEpoch));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const staleAge = observedOwner.holder
      ? minStaleAgeMs
      : Math.max(minStaleAgeMs, MIN_INVALID_HOLDER_STALE_AGE_MS);
    if (observedOwner.ageMs < staleAge ||
        (observedOwner.holder && await isHolderAlive(observedOwner.holder))) {
      return undefined;
    }
    nextEpoch = latestEpoch + 1;
    if (!Number.isSafeInteger(nextEpoch) || nextEpoch >= 10 ** STALE_CLAIM_OWNER_WIDTH) {
      throw new Error('file-lock stale-claim owner epoch exhausted');
    }
  }

  const ownerPath = staleClaimOwnerPath(claimPath, nextEpoch);
  let handle: import('node:fs/promises').FileHandle;
  try {
    handle = await fsp.open(ownerPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' ||
        (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    // As with the public lock, publish the identity without an async gap.
    writeFileSync(handle.fd, currentLockHolderPayload());
    const owner = await handle.stat();
    const currentClaim = await fsp.lstat(claimPath);
    if (!owner.isFile() || !sameInode(currentClaim, claim)) {
      await handle.close();
      try { await releaseOwnedLock(ownerPath, owner); } catch { /* tolerate */ }
      return undefined;
    }
    return { ownerPath, handle };
  } catch (error) {
    try { await handle.close(); } catch { /* tolerate */ }
    try { await fsp.unlink(ownerPath); } catch { /* tolerate */ }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

interface StaleClaimOwnershipSync {
  ownerPath: string;
  fd: number;
}

function tryAcquireStaleClaimOwnershipSync(
  claimPath: string,
  claimWasCreated: boolean,
  minStaleAgeMs: number,
): StaleClaimOwnershipSync | undefined {
  let claim: import('node:fs').Stats;
  try {
    claim = lstatSync(claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!claim.isFile() || claim.isSymbolicLink()) {
    throw new Error('file-lock stale-claim is not a regular file');
  }

  const ownerEpochs = readdirSync(dirname(claimPath))
    .map(name => parseStaleClaimOwnerEpoch(claimPath, name))
    .filter((epoch): epoch is number => epoch !== undefined)
    .sort((left, right) => left - right);

  let nextEpoch = 0;
  const latestEpoch = ownerEpochs.at(-1);
  if (latestEpoch === undefined) {
    const ownerlessAgeMs = Date.now() - claim.ctimeMs;
    if (!claimWasCreated && ownerlessAgeMs < Math.max(minStaleAgeMs, MIN_INVALID_HOLDER_STALE_AGE_MS)) {
      return undefined;
    }
  } else {
    let observedOwner: PinnedHolderObservation;
    try {
      observedOwner = readPinnedHolderSync(staleClaimOwnerPath(claimPath, latestEpoch));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const staleAge = observedOwner.holder
      ? minStaleAgeMs
      : Math.max(minStaleAgeMs, MIN_INVALID_HOLDER_STALE_AGE_MS);
    if (observedOwner.ageMs < staleAge ||
        (observedOwner.holder && isHolderAliveSync(observedOwner.holder))) {
      return undefined;
    }
    nextEpoch = latestEpoch + 1;
    if (!Number.isSafeInteger(nextEpoch) || nextEpoch >= 10 ** STALE_CLAIM_OWNER_WIDTH) {
      throw new Error('file-lock stale-claim owner epoch exhausted');
    }
  }

  const ownerPath = staleClaimOwnerPath(claimPath, nextEpoch);
  let fd: number;
  try {
    fd = openSync(ownerPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' ||
        (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    writeFileSync(fd, currentLockHolderPayload());
    const owner = fstatSync(fd);
    const currentClaim = lstatSync(claimPath);
    if (!owner.isFile() || !sameInode(currentClaim, claim)) {
      closeSync(fd);
      try { releaseOwnedLockSync(ownerPath, owner); } catch { /* tolerate */ }
      return undefined;
    }
    return { ownerPath, fd };
  } catch (error) {
    try { closeSync(fd); } catch { /* tolerate */ }
    try { unlinkSync(ownerPath); } catch { /* tolerate */ }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function cleanStaleClaimOwnership(claimPath: string, ownership: StaleClaimOwnership): Promise<void> {
  try { await ownership.handle.close(); } catch { /* tolerate */ }
  try { await fsp.unlink(ownership.ownerPath); } catch { /* tolerate */ }
  // Older dead epochs are no longer security-relevant after the claim itself
  // is gone. Clean them best-effort; a loser that was already in flight may
  // leave another harmless orphan owner file behind.
  try {
    const names = await fsp.readdir(dirname(claimPath));
    await Promise.all(names.filter(name => parseStaleClaimOwnerEpoch(claimPath, name) !== undefined).map(async name => {
      try { await fsp.unlink(join(dirname(claimPath), name)); } catch { /* tolerate */ }
    }));
  } catch { /* tolerate */ }
}

function cleanStaleClaimOwnershipSync(claimPath: string, ownership: StaleClaimOwnershipSync): void {
  try { closeSync(ownership.fd); } catch { /* tolerate */ }
  try { unlinkSync(ownership.ownerPath); } catch { /* tolerate */ }
  try {
    for (const name of readdirSync(dirname(claimPath))) {
      if (parseStaleClaimOwnerEpoch(claimPath, name) === undefined) continue;
      try { unlinkSync(join(dirname(claimPath), name)); } catch { /* tolerate */ }
    }
  } catch { /* tolerate */ }
}

async function resumeStaleBreak(
  lockPath: string,
  claimPath: string,
  observed: import('node:fs').Stats,
  claimWasCreated: boolean,
  minStaleAgeMs: number,
): Promise<boolean> {
  const ownership = await tryAcquireStaleClaimOwnership(claimPath, claimWasCreated, minStaleAgeMs);
  if (!ownership) return false;
  let claimRemoved = false;
  try {
    const claim = await fsp.lstat(claimPath);
    if (!sameInode(claim, observed)) {
      // The public stale inode may have been released and replaced after our
      // observation but before link(2). In that case link(2) pinned the newer
      // inode under the older generation name. Remove only that pinned claim;
      // never touch the public path, which may now be a live holder.
      await releaseOwnedLock(claimPath, claim);
      claimRemoved = true;
      return false;
    }

    let current: PinnedHolderObservation | undefined;
    try {
      current = await readPinnedHolder(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (current && sameInode(current.stats, observed)) {
      const staleAge = current.holder
        ? minStaleAgeMs
        : Math.max(minStaleAgeMs, MIN_INVALID_HOLDER_STALE_AGE_MS);
      const stillBreakable = current.ageMs >= staleAge &&
        (!current.holder || !(await isHolderAlive(current.holder)));
      if (!stillBreakable) {
        // A once-empty holder may have finished publishing a live identity
        // while the claim was being elected. Withdraw the claim, never steal.
        await releaseOwnedLock(claimPath, claim);
        claimRemoved = true;
        return false;
      }
      await fsp.unlink(lockPath);
      logger.warn(
        `[file-lock] broke stale lock at ${lockPath} ` +
        `(${current.holder ? `dead/reused pid ${current.holder.pid}` : 'empty/invalid holder'}, age ${current.ageMs}ms)`,
      );
    }
    // If the public path is absent or names a newer inode, a previous owner
    // completed the destructive step and crashed before cleanup. Removing the
    // generation-scoped claim is the replay operation.
    await releaseOwnedLock(claimPath, claim);
    claimRemoved = true;
    return true;
  } finally {
    // Only the elected live epoch may remove the claim. If claim cleanup
    // failed, keep owner history so another process can take over after this
    // process dies rather than allowing two concurrent breakers.
    if (claimRemoved) await cleanStaleClaimOwnership(claimPath, ownership);
    else {
      try { await ownership.handle.close(); } catch { /* tolerate */ }
      // This owner is returning synchronously and cannot later resume an
      // unlink. Withdraw its epoch so the same process does not look like a
      // permanently-live crashed breaker after a transient I/O error.
      try { await fsp.unlink(ownership.ownerPath); } catch { /* tolerate */ }
    }
  }
}

function resumeStaleBreakSync(
  lockPath: string,
  claimPath: string,
  observed: import('node:fs').Stats,
  claimWasCreated: boolean,
  minStaleAgeMs: number,
): boolean {
  const ownership = tryAcquireStaleClaimOwnershipSync(claimPath, claimWasCreated, minStaleAgeMs);
  if (!ownership) return false;
  let claimRemoved = false;
  try {
    const claim = lstatSync(claimPath);
    if (!sameInode(claim, observed)) {
      releaseOwnedLockSync(claimPath, claim);
      claimRemoved = true;
      return false;
    }

    let current: PinnedHolderObservation | undefined;
    try {
      current = readPinnedHolderSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (current && sameInode(current.stats, observed)) {
      const staleAge = current.holder
        ? minStaleAgeMs
        : Math.max(minStaleAgeMs, MIN_INVALID_HOLDER_STALE_AGE_MS);
      const stillBreakable = current.ageMs >= staleAge &&
        (!current.holder || !isHolderAliveSync(current.holder));
      if (!stillBreakable) {
        releaseOwnedLockSync(claimPath, claim);
        claimRemoved = true;
        return false;
      }
      unlinkSync(lockPath);
      logger.warn(
        `[file-lock] broke stale lock at ${lockPath} ` +
        `(${current.holder ? `dead/reused pid ${current.holder.pid}` : 'empty/invalid holder'}, age ${current.ageMs}ms)`,
      );
    }
    releaseOwnedLockSync(claimPath, claim);
    claimRemoved = true;
    return true;
  } finally {
    if (claimRemoved) cleanStaleClaimOwnershipSync(claimPath, ownership);
    else {
      try { closeSync(ownership.fd); } catch { /* tolerate */ }
      try { unlinkSync(ownership.ownerPath); } catch { /* tolerate */ }
    }
  }
}

export interface FileLockOptions {
  /** Max time to wait for the lock before throwing (default MAX_WAIT_MS). */
  maxWaitMs?: number;
  /** Min lock age before a dead-PID lock is stale-breakable (default MIN_STALE_AGE_MS). */
  minStaleAgeMs?: number;
}

export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
  const minStaleAgeMs = opts.minStaleAgeMs ?? MIN_STALE_AGE_MS;
  const lockPath = targetPath + '.lock';
  const start = Date.now();
  // Resolve the (potentially ps-backed on non-Linux) birth identity before
  // publishing an empty O_EXCL inode. The cached payload makes open→write a
  // tiny synchronous step rather than a seconds-long stale-break window.
  const holderPayload = currentLockHolderPayload();
  while (true) {
    let fh: import('node:fs/promises').FileHandle | undefined;
    try {
      fh = await fsp.open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (fh) {
      let owned: import('node:fs').Stats | undefined;
      try {
        // Synchronous fd write avoids yielding with a publicly-visible empty
        // lock between O_EXCL creation and holder publication.
        writeFileSync(fh.fd, holderPayload);
        owned = fstatSync(fh.fd);
      } catch (writeErr) {
        try { await fh.close(); } catch { /* tolerate */ }
        if (owned) {
          try { await releaseOwnedLock(lockPath, owned); } catch { /* tolerate */ }
        }
        throw writeErr;
      }
      try {
        return await fn();
      } finally {
        try { if (owned) await releaseOwnedLock(lockPath, owned); } catch { /* tolerate */ }
        try { await fh.close(); } catch { /* tolerate */ }
      }
    }

    // EEXIST from open: someone holds the lock. Callback exceptions never
    // reach this branch, even when user code happens to use the same code.
    let holder: LockHolder | undefined;
    let lockAgeMs = Infinity;
    let observed: import('node:fs').Stats;
    try {
      const observedHandle = await fsp.open(
        lockPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const before = await observedHandle.stat();
        const raw = await observedHandle.readFile('utf8');
        const after = await observedHandle.stat();
        if (!before.isFile() || !sameInode(before, after) || before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) continue;
        observed = after;
        holder = parseLockHolder(raw);
        lockAgeMs = Date.now() - after.mtimeMs;
      } finally {
        await observedHandle.close();
      }
    } catch (re: any) {
      if (re.code === 'ENOENT') continue; // released between EEXIST and read
      throw re;
    }

    const staleAge = holder
      ? minStaleAgeMs
      : Math.max(minStaleAgeMs, MIN_INVALID_HOLDER_STALE_AGE_MS);
    const breakable = lockAgeMs >= staleAge &&
      (!holder || !(await isHolderAlive(holder)));
    if (breakable) {
      const stalePath = staleClaimPathFor(lockPath, observed);
      let claimWasCreated = false;
      try {
        await fsp.link(lockPath, stalePath);
        claimWasCreated = true;
      } catch (claimErr: any) {
        if (claimErr.code === 'ENOENT') continue;
        if (claimErr.code !== 'EEXIST') throw claimErr;
      }
      if (await resumeStaleBreak(
        lockPath,
        stalePath,
        observed,
        claimWasCreated,
        minStaleAgeMs,
      )) {
        continue;
      }
    }

    if (Date.now() - start > maxWaitMs) {
      throw new Error(
        `file-lock timeout waiting for ${lockPath} ` +
        `(held by pid ${holder?.pid || '?'}, age ${Math.round(lockAgeMs)}ms)`,
      );
    }
    await new Promise(r => setTimeout(r, RETRY_BASE_MS + Math.random() * RETRY_BASE_MS));
  }
}

export function withFileLockSync<T>(
  targetPath: string,
  fn: () => T,
  opts: FileLockOptions = {},
): T {
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
  const minStaleAgeMs = opts.minStaleAgeMs ?? MIN_STALE_AGE_MS;
  const lockPath = targetPath + '.lock';
  const start = Date.now();
  const holderPayload = currentLockHolderPayload();
  while (true) {
    let fd: number | null = null;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (fd !== null) {
      let owned: import('node:fs').Stats | undefined;
      try {
        writeFileSync(fd, holderPayload);
        owned = fstatSync(fd);
      } catch (writeError) {
        try { closeSync(fd); } catch { /* tolerate */ }
        if (owned) {
          try { releaseOwnedLockSync(lockPath, owned); } catch { /* tolerate */ }
        }
        throw writeError;
      }
      try {
        return fn();
      } finally {
        try { if (owned) releaseOwnedLockSync(lockPath, owned); } catch { /* tolerate */ }
        try { closeSync(fd); } catch { /* tolerate */ }
      }
    }

    let holder: LockHolder | undefined;
    let lockAgeMs = Infinity;
    let observed: import('node:fs').Stats;
    try {
      const observedFd = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = fstatSync(observedFd);
        const raw = readFileSync(observedFd, 'utf-8');
        const after = fstatSync(observedFd);
        if (!before.isFile() || !sameInode(before, after) || before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) continue;
        observed = after;
        holder = parseLockHolder(raw);
        lockAgeMs = Date.now() - after.mtimeMs;
      } finally {
        closeSync(observedFd);
      }
    } catch (re: any) {
      if (re.code === 'ENOENT') continue;
      throw re;
    }

    const staleAge = holder
      ? minStaleAgeMs
      : Math.max(minStaleAgeMs, MIN_INVALID_HOLDER_STALE_AGE_MS);
    const breakable = lockAgeMs >= staleAge &&
      (!holder || !isHolderAliveSync(holder));
    if (breakable) {
      const stalePath = staleClaimPathFor(lockPath, observed);
      let claimWasCreated = false;
      try {
        linkSync(lockPath, stalePath);
        claimWasCreated = true;
      } catch (claimErr: any) {
        if (claimErr.code === 'ENOENT') continue;
        if (claimErr.code !== 'EEXIST') throw claimErr;
      }
      if (resumeStaleBreakSync(
        lockPath,
        stalePath,
        observed,
        claimWasCreated,
        minStaleAgeMs,
      )) {
        continue;
      }
    }

    if (Date.now() - start > maxWaitMs) {
      throw new Error(
        `file-lock timeout waiting for ${lockPath} ` +
        `(held by pid ${holder?.pid || '?'}, age ${Math.round(lockAgeMs)}ms)`,
      );
    }
    sleepSync(RETRY_BASE_MS + Math.random() * RETRY_BASE_MS);
  }
}
