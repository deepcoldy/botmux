/**
 * Small synchronous durability primitives for commit-style filesystem writes.
 *
 * Atomic rename/link prevents torn readers, but it does not by itself promise
 * that either the file contents or the new directory entry survive a machine
 * crash.  Callers publishing a commit marker must fsync the referenced files
 * first, then their containing directory, and only then publish the marker.
 */
import {
  closeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
} from 'node:fs';

const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set([
  'EINVAL',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
]);

function errnoCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err
    ? String((err as NodeJS.ErrnoException).code)
    : undefined;
}

/** Exposed so the narrow cross-platform fallback policy stays regression-tested. */
export function isUnsupportedDirectoryFsyncError(err: unknown): boolean {
  const code = errnoCode(err);
  return code !== undefined && UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(code);
}

/**
 * fsync a directory entry when the host filesystem supports it.
 *
 * Linux/macOS filesystems normally support directory fsync. Some platforms
 * and virtual/network filesystems reject the operation with a documented
 * "unsupported" errno. In that narrow case atomicity remains intact but crash
 * durability is best-effort; genuine I/O and permission errors still fail the
 * publication rather than making a false durability claim.
 */
export function fsyncDirectorySyncPortable(directoryPath: string): void {
  // Windows does not expose POSIX directory handles suitable for fsync via
  // Node's fs API (open commonly fails with EPERM). Atomic rename/link remains
  // the visibility boundary there; directory durability is best-effort.
  if (process.platform === 'win32') return;
  let fd: number | undefined;
  try {
    fd = openSync(directoryPath, 'r');
    fsyncSync(fd);
  } catch (err) {
    if (!isUnsupportedDirectoryFsyncError(err)) throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Strictly fsync one regular file. Symlinks/devices are never accepted. */
export function fsyncRegularFileSync(filePath: string): void {
  const pathStat = lstatSync(filePath);
  if (!pathStat.isFile()) {
    throw new Error(`durability target must be a regular file: ${filePath}`);
  }

  const fd = openSync(filePath, 'r');
  try {
    // Re-check the opened inode so a concurrently replaced path cannot turn a
    // file durability request into fsync of a directory/device.
    if (!fstatSync(fd).isFile()) {
      throw new Error(`durability target must remain a regular file: ${filePath}`);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Make a set of already-written files and their directory entries durable.
 * Duplicate paths are intentionally collapsed to avoid redundant disk flushes.
 */
export function fsyncFilesAndDirectorySync(
  directoryPath: string,
  filePaths: readonly string[],
): void {
  for (const filePath of [...new Set(filePaths)].sort()) {
    fsyncRegularFileSync(filePath);
  }
  fsyncDirectorySyncPortable(directoryPath);
}
