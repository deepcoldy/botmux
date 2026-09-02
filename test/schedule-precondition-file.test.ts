import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSchedulePreconditionFile,
  SchedulePreconditionFileError,
  type SchedulePreconditionFileOperations,
} from '../src/services/schedule-precondition-file.js';
import { MAX_SCHEDULE_PRECONDITION_SCRIPT_BYTES } from '../src/services/schedule-precondition-store.js';

function nodeOperations(): SchedulePreconditionFileOperations {
  return {
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
}

function capturedError(run: () => unknown): SchedulePreconditionFileError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SchedulePreconditionFileError);
    return error as SchedulePreconditionFileError;
  }
  throw new Error('expected schedule precondition file read to fail');
}

describe('readSchedulePreconditionFile', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'botmux-schedule-precondition-file-'));
  });

  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('resolves relative paths from task workingDir and rereads the file on every call', () => {
    const file = join(workingDir, 'guard.sh');
    writeFileSync(file, 'printf 0');

    expect(readSchedulePreconditionFile('guard.sh', workingDir)).toBe('printf 0');

    writeFileSync(file, 'printf 1');
    expect(readSchedulePreconditionFile('guard.sh', workingDir)).toBe('printf 1');
  });

  it('resolves absolute paths independently of task workingDir', () => {
    const file = join(workingDir, 'absolute-guard.sh');
    writeFileSync(file, 'printf 1');

    expect(readSchedulePreconditionFile(file, '')).toBe('printf 1');
  });

  it.each([
    ['', 'invalid_path'],
    ['   ', 'invalid_path'],
    ['bad\0path', 'invalid_path'],
    ['~/private-guard.sh', 'invalid_path'],
  ] as const)('rejects an invalid literal path without echoing it: %j', (filePath, code) => {
    const error = capturedError(() => readSchedulePreconditionFile(filePath, workingDir));

    expect(error.code).toBe(code);
    expect(error.message).not.toContain(workingDir);
    if (filePath.length > 1) expect(error.message).not.toContain(filePath);
  });

  it('returns a generic unreadable error without leaking a missing host path', () => {
    const privateBasename = 'customer-secret-condition-name.sh';
    const privatePath = join(workingDir, privateBasename);

    const error = capturedError(() => readSchedulePreconditionFile(privatePath, workingDir));

    expect(error.code).toBe('unreadable_file');
    expect(error.message).not.toContain(privateBasename);
    expect(error.message).not.toContain(privatePath);
    expect(error.message).not.toContain(workingDir);
  });

  it.skipIf(process.platform === 'win32')('rejects a final symbolic link without reading its target', () => {
    const privateTargetName = 'private-target-name.sh';
    const target = join(workingDir, privateTargetName);
    const link = join(workingDir, 'guard.sh');
    writeFileSync(target, 'printf 1');
    symlinkSync(target, link);

    const error = capturedError(() => readSchedulePreconditionFile(link, workingDir));

    expect(error.code).toBe('symbolic_link');
    expect(error.message).not.toContain(privateTargetName);
    expect(error.message).not.toContain(link);
  });

  it('rejects non-regular files', () => {
    const error = capturedError(() => readSchedulePreconditionFile('.', workingDir));

    expect(error.code).toBe('non_regular_file');
    expect(error.message).not.toContain(workingDir);
  });

  it('rejects source files larger than the protected script limit', () => {
    const file = join(workingDir, 'large.sh');
    writeFileSync(file, Buffer.alloc(MAX_SCHEDULE_PRECONDITION_SCRIPT_BYTES + 1, 0x61));

    const error = capturedError(() => readSchedulePreconditionFile(file, workingDir));

    expect(error.code).toBe('file_too_large');
    expect(error.message).not.toContain(file);
  });

  it('rejects invalid UTF-8 and blank or NUL-bearing Bash source', () => {
    const file = join(workingDir, 'guard.sh');

    writeFileSync(file, Buffer.from([0xc3, 0x28]));
    expect(capturedError(() => readSchedulePreconditionFile(file, workingDir)).code)
      .toBe('invalid_utf8');

    writeFileSync(file, ' \n\t');
    expect(capturedError(() => readSchedulePreconditionFile(file, workingDir)).code)
      .toBe('invalid_content');

    writeFileSync(file, Buffer.from('printf 1\0'));
    expect(capturedError(() => readSchedulePreconditionFile(file, workingDir)).code)
      .toBe('invalid_content');
  });

  it.skipIf(process.platform === 'win32')('uses O_NOFOLLOW when the final path races to a symlink', () => {
    const file = join(workingDir, 'guard.sh');
    const target = join(workingDir, 'private-race-target.sh');
    writeFileSync(file, 'printf 0');
    writeFileSync(target, 'printf 1');
    const operations = nodeOperations();
    const realOpen = operations.open;
    operations.open = (path, flags) => {
      unlinkSync(file);
      symlinkSync(target, file);
      return realOpen(path, flags);
    };

    const error = capturedError(() => readSchedulePreconditionFile(file, workingDir, operations));

    expect(error.code).toBe('symbolic_link');
    expect(error.message).not.toContain(target);
  });

  it('fails closed when descriptor metadata changes during the bounded read', () => {
    const file = join(workingDir, 'guard.sh');
    writeFileSync(file, 'printf 1');
    const operations = nodeOperations();
    const realFstat = operations.fstat;
    const realClose = operations.close;
    let fstatCalls = 0;
    let closed = false;
    operations.fstat = (fd) => {
      const stat = realFstat(fd);
      fstatCalls += 1;
      if (fstatCalls !== 2) return stat;
      return new Proxy(stat, {
        get(target, property, receiver) {
          if (property === 'mtimeNs') return target.mtimeNs + 1n;
          return Reflect.get(target, property, receiver);
        },
      });
    };
    operations.close = (fd) => {
      closed = true;
      realClose(fd);
    };

    const error = capturedError(() => readSchedulePreconditionFile(file, workingDir, operations));

    expect(error.code).toBe('file_changed');
    expect(error.message).not.toContain(file);
    expect(closed).toBe(true);
  });
});
