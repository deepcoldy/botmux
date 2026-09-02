import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { MAX_SCHEDULE_PRECONDITION_SCRIPT_BYTES } from './schedule-precondition-store.js';

export type SchedulePreconditionFileErrorCode =
  | 'invalid_path'
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

function resolvedFilePath(filePath: string, workingDir: string): string {
  if (filePath.trim().length === 0 || filePath.includes('\0') || filePath.startsWith('~')) {
    fail(
      'invalid_path',
      'Scheduled task precondition file path must be non-empty and must not use NUL bytes or ~ expansion',
    );
  }

  // Absolute paths name the scheduler host directly. Relative paths follow the
  // task's working directory on every trigger, so changing workingDir changes
  // which condition file is consulted without falling back to daemon cwd.
  if (!isAbsolute(filePath) && workingDir.trim().length === 0) {
    fail(
      'invalid_path',
      'Scheduled task precondition file needs a valid task working directory',
    );
  }
  return isAbsolute(filePath) ? resolve(filePath) : resolve(workingDir, filePath);
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
  workingDir: string,
  operations: SchedulePreconditionFileOperations = defaultOperations,
): string {
  const resolvedPath = resolvedFilePath(filePath, workingDir);

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
