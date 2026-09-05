import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  MAX_SCHEDULE_PRECONDITION_SCRIPT_BYTES,
  schedulePreconditionRoot,
  schedulePreconditionTrustedFilesRoot,
} from './schedule-precondition-store.js';

export type SchedulePreconditionFileErrorCode =
  | 'invalid_path'
  | 'outside_trusted_directory'
  | 'unsafe_trusted_directory'
  | 'unreadable_file'
  | 'symbolic_link'
  | 'non_regular_file'
  | 'file_too_large'
  | 'file_changed'
  | 'invalid_utf8'
  | 'invalid_content';

/**
 * File-condition errors deliberately carry no source path or underlying fs
 * error. Scheduler errors can be projected to a public dashboard, so even the
 * basename of a host file is private control-plane data.
 */
export class SchedulePreconditionFileError extends Error {
  constructor(
    readonly code: SchedulePreconditionFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SchedulePreconditionFileError';
  }
}

export interface SchedulePreconditionFileOperations {
  lstat(path: string): BigIntStats;
  open(path: string, flags: number): number;
  fstat(fd: number): BigIntStats;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: null): number;
  close(fd: number): void;
}

const defaultOperations: SchedulePreconditionFileOperations = {
  lstat: path => lstatSync(path, { bigint: true }),
  open: (path, flags) => openSync(path, flags),
  fstat: fd => fstatSync(fd, { bigint: true }),
  read: (fd, buffer, offset, length, position) => readSync(
    fd,
    buffer,
    offset,
    length,
    position,
  ),
  close: fd => closeSync(fd),
};

function fail(code: SchedulePreconditionFileErrorCode, message: string): never {
  throw new SchedulePreconditionFileError(code, message);
}

export function assertSchedulePreconditionFilePathAbsolute(filePath: string): void {
  if (!isAbsolute(filePath)) {
    fail(
      'invalid_path',
      'Scheduled task precondition file path must be absolute',
    );
  }
}

function resolveLiteralFilePath(filePath: string): string {
  if (filePath.trim().length === 0 || filePath.includes('\0') || filePath.startsWith('~')) {
    fail(
      'invalid_path',
      'Scheduled task precondition file path must be non-empty and must not use NUL bytes or ~ expansion',
    );
  }

  // The file is executed by the host daemon rather than inside the model
  // sandbox. Requiring an explicit host-absolute path removes implicit
  // workingDir resolution; it does not make the chosen file immutable, so the
  // configured target must still be trusted and outside model-writable paths.
  assertSchedulePreconditionFilePathAbsolute(filePath);
  return resolve(filePath);
}

function missingPath(error: unknown): boolean {
  return errnoCode(error) === 'ENOENT';
}

function lstatIfPresent(
  path: string,
  operations: SchedulePreconditionFileOperations,
): BigIntStats | undefined {
  try {
    return operations.lstat(path);
  } catch (error) {
    if (missingPath(error)) return undefined;
    fail(
      'unsafe_trusted_directory',
      'Scheduled task precondition trusted-files directory is unavailable or unsafe',
    );
  }
}

function assertRealDirectory(stat: BigIntStats | undefined): boolean {
  if (!stat) return false;
  if (stat.isSymbolicLink()) {
    fail(
      'symbolic_link',
      'Scheduled task precondition source path must not contain symbolic links',
    );
  }
  if (!stat.isDirectory()) {
    fail(
      'unsafe_trusted_directory',
      'Scheduled task precondition trusted-files directory is unavailable or unsafe',
    );
  }
  return true;
}

function assertPathComponentsSafe(
  resolvedPath: string,
  dataDir: string | undefined,
  operations: SchedulePreconditionFileOperations,
): void {
  const storageRoot = resolve(schedulePreconditionRoot(dataDir));
  const trustedRoot = schedulePreconditionTrustedFilesRoot(dataDir);

  // Missing roots are allowed while a new configuration is being validated;
  // the daemon/bootstrap write path creates them before accepting the change.
  // If they exist, neither protected root may be redirected through a symlink.
  if (!assertRealDirectory(lstatIfPresent(storageRoot, operations))) return;
  if (!assertRealDirectory(lstatIfPresent(trustedRoot, operations))) return;

  const segments = relative(trustedRoot, resolvedPath).split(sep);
  let current = trustedRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    const stat = lstatIfPresent(current, operations);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      fail(
        'symbolic_link',
        'Scheduled task precondition source path must not contain symbolic links',
      );
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      fail(
        'unreadable_file',
        'Scheduled task precondition file path has a non-directory parent',
      );
    }
  }
}

/**
 * Validate write/runtime authority for a file-backed precondition.
 *
 * This is intentionally separate from persisted-record schema validation:
 * legacy paths must remain readable so they can be disabled, replaced, or
 * cleared, but they cannot regain execution authority outside this root.
 */
export function assertSchedulePreconditionFilePathTrusted(
  filePath: string,
  dataDir?: string,
  operations: SchedulePreconditionFileOperations = defaultOperations,
): void {
  const resolvedPath = resolveLiteralFilePath(filePath);
  const trustedRoot = schedulePreconditionTrustedFilesRoot(dataDir);
  const relativePath = relative(trustedRoot, resolvedPath);
  if (
    relativePath.length === 0
    || relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    fail(
      'outside_trusted_directory',
      'Scheduled task precondition file path must be inside the daemon trusted-files directory',
    );
  }
  assertPathComponentsSafe(resolvedPath, dataDir, operations);
}

function resolvedFilePath(
  filePath: string,
  dataDir: string | undefined,
  operations: SchedulePreconditionFileOperations,
): string {
  const resolvedPath = resolveLiteralFilePath(filePath);
  assertSchedulePreconditionFilePathTrusted(filePath, dataDir, operations);
  return resolvedPath;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertRegularFile(stat: BigIntStats): void {
  if (!stat.isFile()) {
    fail(
      'non_regular_file',
      'Scheduled task precondition source must be a regular file',
    );
  }
}

function assertWithinSizeLimit(stat: BigIntStats): void {
  if (stat.size > BigInt(MAX_SCHEDULE_PRECONDITION_SCRIPT_BYTES)) {
    fail(
      'file_too_large',
      `Scheduled task precondition file exceeds the ${MAX_SCHEDULE_PRECONDITION_SCRIPT_BYTES}-byte limit`,
    );
  }
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function genericReadError(): SchedulePreconditionFileError {
  return new SchedulePreconditionFileError(
    'unreadable_file',
    'Scheduled task precondition file is unavailable or unreadable; verify that it exists and the daemon user can read it',
  );
}

/**
 * Read the Bash source for one file-backed schedule precondition.
 *
 * The file is resolved and opened afresh on every call. A no-follow descriptor,
 * regular-file checks, a bounded read, and before/after metadata comparisons
 * make every observed race fail closed. The returned source is then suitable
 * for the same `/bin/bash -c` runner used by inline conditions.
 */
export function readSchedulePreconditionFile(
  filePath: string,
  _workingDir: string,
  operations: SchedulePreconditionFileOperations = defaultOperations,
): string {
  const resolvedPath = resolvedFilePath(filePath, undefined, operations);

  let pathBefore: BigIntStats;
  try {
    pathBefore = operations.lstat(resolvedPath);
  } catch {
    throw genericReadError();
  }
  if (pathBefore.isSymbolicLink()) {
    fail(
      'symbolic_link',
      'Scheduled task precondition source must not be a symbolic link',
    );
  }
  assertRegularFile(pathBefore);
  assertWithinSizeLimit(pathBefore);

  let fd: number;
  try {
    fd = operations.open(
      resolvedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (errnoCode(error) === 'ELOOP') {
      fail(
        'symbolic_link',
        'Scheduled task precondition source must not be a symbolic link',
      );
    }
    throw genericReadError();
  }

  let result: string | undefined;
  let failure: unknown;
  try {
    const before = operations.fstat(fd);
    assertRegularFile(before);
    assertWithinSizeLimit(before);
    if (!sameIdentity(pathBefore, before)) {
      fail(
        'file_changed',
        'Scheduled task precondition file changed while being opened; retry after file writes finish',
      );
    }

    // Read at most one byte beyond the accepted limit. The descriptor may grow
    // after fstat; this bound prevents an untrusted file from growing memory use.
    const buffer = Buffer.allocUnsafe(MAX_SCHEDULE_PRECONDITION_SCRIPT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = operations.read(
        fd,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        null,
      );
      if (count === 0) break;
      if (!Number.isSafeInteger(count) || count < 0) throw genericReadError();
      bytesRead += count;
    }

    const after = operations.fstat(fd);
    let pathAfter: BigIntStats;
    try {
      pathAfter = operations.lstat(resolvedPath);
    } catch {
      fail(
        'file_changed',
        'Scheduled task precondition file changed while being read; retry after file writes finish',
      );
    }
    if (pathAfter.isSymbolicLink()
        || !pathAfter.isFile()
        || !sameIdentity(after, pathAfter)
        || !sameSnapshot(before, after)
        || BigInt(bytesRead) !== after.size) {
      fail(
        'file_changed',
        'Scheduled task precondition file changed while being read; retry after file writes finish',
      );
    }
    // O_NOFOLLOW protects only the leaf on common platforms. Rewalk every
    // trusted-root component so an ancestor replaced with a symlink during
    // open/read cannot retain authority even when it reaches the same inode.
    assertSchedulePreconditionFilePathTrusted(filePath, undefined, operations);
    if (bytesRead > MAX_SCHEDULE_PRECONDITION_SCRIPT_BYTES) {
      fail(
        'file_too_large',
        `Scheduled task precondition file exceeds the ${MAX_SCHEDULE_PRECONDITION_SCRIPT_BYTES}-byte limit`,
      );
    }

    let script: string;
    try {
      // Preserve a BOM as source data; Bash should see exactly the imported
      // UTF-8 text rather than the decoder silently changing its first token.
      script = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        .decode(buffer.subarray(0, bytesRead));
    } catch {
      fail(
        'invalid_utf8',
        'Scheduled task precondition file must contain valid UTF-8 Bash source',
      );
    }
    if (script.trim().length === 0 || script.includes('\0')) {
      fail(
        'invalid_content',
        'Scheduled task precondition file must contain non-empty Bash source without NUL bytes',
      );
    }
    result = script;
  } catch (error) {
    failure = error instanceof SchedulePreconditionFileError
      ? error
      : genericReadError();
  }

  try {
    operations.close(fd);
  } catch {
    if (failure === undefined) failure = genericReadError();
  }

  if (failure !== undefined) throw failure;
  return result!;
}
