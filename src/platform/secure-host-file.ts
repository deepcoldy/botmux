/**
 * Strict host-authority file primitives.
 *
 * Unlike general dotfiles, machine/device credentials must never follow a
 * leaf symlink. Reads pin one inode with O_NOFOLLOW, writes canonicalize only
 * the parent and atomically replace the leaf, and the containing directory
 * must not be writable by group/other users.
 */
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
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

/**
 * Escape hatch for trusted-but-awkward shared hosts (e.g. corporate devboxes)
 * where some ancestor like `/data00` is owned by an unrelated service account
 * and owner-writable (`0755`), yet the physical machine is trusted and the
 * user cannot chmod that level. `BOTMUX_SKIP_HOST_AUTH_CHECK=1` skips ONLY the
 * ancestor-chain replaceability walk below; the direct credential-dir/leaf
 * checks (owner, exact 0600, no group/other write) still apply.
 */
function ancestorChainCheckDisabled(): boolean {
  return process.env.BOTMUX_SKIP_HOST_AUTH_CHECK === '1';
}

let warnedAncestorChainSkipped = false;

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
  if (ancestorChainCheckDisabled()) {
    if (!warnedAncestorChainSkipped) {
      warnedAncestorChainSkipped = true;
      console.error(
        '[secure-host-file] BOTMUX_SKIP_HOST_AUTH_CHECK=1 已跳过宿主凭证祖先链检查；'
        + '仅在本机物理环境可信（如共享 devbox 上某级父目录归属服务账号）时使用。',
      );
    }
    return;
  }
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
        throw new UnsafeHostAuthorityFileError(
          '宿主凭证目录可被不可信祖先目录替换'
          + `（祖先 ${ancestorPath} 可被非本人账号写入）；`
          + '若本机物理环境可信，可设 BOTMUX_SKIP_HOST_AUTH_CHECK=1 跳过祖先链检查',
        );
      }
    }

    childPath = ancestorPath;
    childStats = ancestorStats;
  }
}

/** Create/resolve the parent without ever resolving the final path component. */
export function secureHostFilePath(filePath: string): string {
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = realpathSync(parent);
  const parentStats = statSync(canonicalParent);
  if (!parentStats.isDirectory()) {
    throw new UnsafeHostAuthorityFileError('宿主凭证目录不是普通目录');
  }
  assertOwnedByCurrentUser(parentStats, '宿主凭证目录');
  if (process.platform !== 'win32' && (parentStats.mode & 0o022) !== 0) {
    throw new UnsafeHostAuthorityFileError('宿主凭证目录可被组内或其它用户写入');
  }
  assertAncestorChainCannotReplace(canonicalParent);
  return join(canonicalParent, basename(filePath));
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

/** Return null only for a genuinely absent leaf; unsafe shapes fail closed. */
export function readSecureHostFileSync(filePath: string, maxBytes = 64 * 1024): string | null {
  try {
    lstatSync(dirname(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const resolved = secureHostFilePath(filePath);
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

/** Strict, durable atomic replace that never follows a leaf symlink. */
export function writeSecureHostFileSync(filePath: string, data: string): void {
  const resolved = secureHostFilePath(filePath);
  let leafExists = false;
  try {
    lstatSync(resolved);
    leafExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (leafExists) {
    // Pin and validate the existing leaf before replacement. The final rename
    // never follows a leaf symlink, so a later swap cannot redirect the write.
    readSecureHostFileSync(resolved);
  }
  atomicWriteFileSync(resolved, data, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

/** Strict durable unlink. Returns false only if the leaf is absent. */
export function unlinkSecureHostFileSync(filePath: string): boolean {
  const resolved = secureHostFilePath(filePath);
  if (readSecureHostFileSync(resolved) === null) return false;
  unlinkSync(resolved);
  if (process.platform !== 'win32') {
    const fd = openSync(dirname(resolved), constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  return true;
}
