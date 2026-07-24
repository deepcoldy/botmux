/**
 * Strict host-authority file primitives.
 *
 * Unlike general dotfiles, machine/device credentials must never follow a
 * leaf symlink. Linux pins the containing directory while operating on the
 * leaf; other platforms require a non-replaceable ancestor chain. All writes
 * atomically replace the leaf, and its directory must be owned by the current
 * user without group/other write access.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export class UnsafeHostAuthorityFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeHostAuthorityFileError';
  }
}

function sameInode(
  left: Pick<import('node:fs').Stats, 'dev' | 'ino'>,
  right: Pick<import('node:fs').Stats, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOwnedByCurrentUser(stats: import('node:fs').Stats, label: string): void {
  if (process.platform === 'win32' || !process.getuid) return;
  if (stats.uid !== process.getuid()) {
    throw new UnsafeHostAuthorityFileError(`${label} 不属于当前用户`);
  }
}

function assertSecureParentStats(stats: import('node:fs').Stats): void {
  if (!stats.isDirectory()) {
    throw new UnsafeHostAuthorityFileError('宿主凭证目录不是普通目录');
  }
  assertOwnedByCurrentUser(stats, '宿主凭证目录');
  if (process.platform !== 'win32' && (stats.mode & 0o022) !== 0) {
    throw new UnsafeHostAuthorityFileError('宿主凭证目录可被组内或其它用户写入');
  }
}

/**
 * A 0700 credential directory is still replaceable when one of its ancestors
 * is writable by another user. Walk the canonical chain so later path-based
 * open/rename operations cannot be redirected by renaming the whole directory.
 *
 * POSIX sticky directories (notably /tmp) are the one safe writable exception:
 * when both the directory owner and child owner are trusted, unrelated users
 * cannot rename that child despite the directory's 01777 mode.
 */
function assertAncestorChainCannotReplace(canonicalParent: string): void {
  if (process.platform === 'win32' || !process.getuid) return;
  const uid = process.getuid();
  const trustedOwner = (owner: number) => owner === uid || owner === 0;
  let childPath = canonicalParent;
  let childStats = statSync(childPath);

  while (true) {
    const ancestorPath = dirname(childPath);
    if (ancestorPath === childPath) return;
    const ancestorStats = statSync(ancestorPath);
    if (!ancestorStats.isDirectory()) {
      throw new UnsafeHostAuthorityFileError('宿主凭证祖先路径不是目录');
    }

    const untrustedOwnerCanWrite = !trustedOwner(ancestorStats.uid)
      && (ancestorStats.mode & 0o200) !== 0;
    const groupOrOtherCanWrite = (ancestorStats.mode & 0o022) !== 0;
    if (untrustedOwnerCanWrite || groupOrOtherCanWrite) {
      const stickyProtectsChild = (ancestorStats.mode & 0o1000) !== 0
        && trustedOwner(ancestorStats.uid)
        && trustedOwner(childStats.uid);
      if (!stickyProtectsChild) {
        throw new UnsafeHostAuthorityFileError('宿主凭证目录可被不可信祖先目录替换');
      }
    }

    childPath = ancestorPath;
    childStats = ancestorStats;
  }
}

function canonicalSecureHostParent(filePath: string): string {
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = realpathSync(parent);
  const parentStats = statSync(canonicalParent);
  assertSecureParentStats(parentStats);
  return canonicalParent;
}

/** Create/resolve the parent without ever resolving the final path component. */
export function secureHostFilePath(filePath: string): string {
  const canonicalParent = canonicalSecureHostParent(filePath);
  assertAncestorChainCannotReplace(canonicalParent);
  return join(canonicalParent, basename(filePath));
}

interface SecureHostParent {
  path: string;
  fd?: number;
}

/**
 * Linux exposes an opened directory through /proc/self/fd. Keeping that
 * directory descriptor open makes all leaf operations independent of later
 * ancestor renames: an untrusted mount-point owner can still cause denial of
 * service, but cannot redirect a credential write into a directory it reads.
 *
 * Other platforms retain the conservative ancestor-chain requirement until
 * they have an equivalent descriptor-relative primitive.
 */
function acquireSecureHostParent(filePath: string): SecureHostParent {
  const canonicalParent = canonicalSecureHostParent(filePath);
  if (process.platform !== 'linux') {
    assertAncestorChainCannotReplace(canonicalParent);
    return { path: canonicalParent };
  }

  const fd = openSync(
    canonicalParent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const openedStats = fstatSync(fd);
    assertSecureParentStats(openedStats);
    const anchoredPath = `/proc/self/fd/${fd}`;
    let anchoredStats: import('node:fs').Stats;
    try {
      anchoredStats = statSync(anchoredPath);
    } catch {
      // Minimal/chrooted Linux environments may not mount procfs. Preserve
      // the old fail-closed path validation there.
      closeSync(fd);
      assertAncestorChainCannotReplace(canonicalParent);
      return { path: canonicalParent };
    }
    if (!sameInode(openedStats, anchoredStats)) {
      throw new UnsafeHostAuthorityFileError('宿主凭证目录句柄发生变化');
    }
    return { path: anchoredPath, fd };
  } catch (error) {
    try { closeSync(fd); } catch { /* best effort */ }
    throw error;
  }
}

function releaseSecureHostParent(parent: SecureHostParent): void {
  if (parent.fd === undefined) return;
  closeSync(parent.fd);
}

function assertSecureFileStats(stats: import('node:fs').Stats, maxBytes: number): void {
  if (!stats.isFile()) {
    throw new UnsafeHostAuthorityFileError('宿主凭证必须是普通文件');
  }
  assertOwnedByCurrentUser(stats, '宿主凭证文件');
  if (process.platform !== 'win32' && (stats.mode & 0o777) !== 0o600) {
    throw new UnsafeHostAuthorityFileError('宿主凭证文件权限必须严格为 0600');
  }
  if (stats.size < 0 || stats.size > maxBytes) {
    throw new UnsafeHostAuthorityFileError('宿主凭证文件大小异常');
  }
}

function readSecureHostFileFromParentSync(
  parent: SecureHostParent,
  leafName: string,
  maxBytes: number,
): string | null {
  const resolved = join(parent.path, leafName);
  let fd: number;
  try {
    const flags = process.platform === 'win32'
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW;
    fd = openSync(resolved, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new UnsafeHostAuthorityFileError('宿主凭证拒绝符号链接');
    }
    throw error;
  }

  try {
    const before = fstatSync(fd);
    assertSecureFileStats(before, maxBytes);
    const pathStats = lstatSync(resolved);
    if (pathStats.isSymbolicLink() || !sameInode(before, pathStats)) {
      throw new UnsafeHostAuthorityFileError('宿主凭证路径在读取时发生变化');
    }
    const raw = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    if (
      !sameInode(before, after)
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new UnsafeHostAuthorityFileError('宿主凭证在读取时发生变化');
    }
    return raw;
  } finally {
    closeSync(fd);
  }
}

/** Return null only for a genuinely absent leaf; unsafe shapes fail closed. */
export function readSecureHostFileSync(filePath: string, maxBytes = 64 * 1024): string | null {
  try {
    lstatSync(dirname(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parent = acquireSecureHostParent(filePath);
  try {
    return readSecureHostFileFromParentSync(parent, basename(filePath), maxBytes);
  } finally {
    releaseSecureHostParent(parent);
  }
}

function writePinnedSecureHostFileSync(
  parent: SecureHostParent,
  directoryFd: number,
  leafName: string,
  data: string,
): void {
  const resolved = join(parent.path, leafName);
  const tmp = join(
    parent.path,
    `${leafName}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, data, { encoding: 'utf8' });
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, resolved);
    fsyncSync(directoryFd);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

/** Strict, durable atomic replace that never follows a leaf symlink. */
export function writeSecureHostFileSync(filePath: string, data: string): void {
  const parent = acquireSecureHostParent(filePath);
  const leafName = basename(filePath);
  const resolved = join(parent.path, leafName);
  try {
    let leafExists = false;
    try {
      lstatSync(resolved);
      leafExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (leafExists) {
      // Pin and validate the existing leaf before replacement. The final
      // rename never follows a leaf symlink.
      readSecureHostFileFromParentSync(parent, leafName, 64 * 1024);
    }
    if (parent.fd !== undefined) {
      writePinnedSecureHostFileSync(
        parent,
        parent.fd,
        leafName,
        data,
      );
    } else {
      atomicWriteFileSync(resolved, data, {
        mode: 0o600,
        durable: true,
        followTargetSymlink: false,
      });
    }
  } finally {
    releaseSecureHostParent(parent);
  }
}

/** Strict durable unlink. Returns false only if the leaf is absent. */
export function unlinkSecureHostFileSync(filePath: string): boolean {
  const parent = acquireSecureHostParent(filePath);
  const leafName = basename(filePath);
  const resolved = join(parent.path, leafName);
  try {
    if (readSecureHostFileFromParentSync(parent, leafName, 64 * 1024) === null) return false;
    unlinkSync(resolved);
    if (process.platform !== 'win32') {
      if (parent.fd !== undefined) {
        fsyncSync(parent.fd);
      } else {
        const fd = openSync(parent.path, constants.O_RDONLY);
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
    }
    return true;
  } finally {
    releaseSecureHostParent(parent);
  }
}
