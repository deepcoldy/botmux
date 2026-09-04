import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import {
  assertSchedulePreconditionFilePathTrusted,
  readSchedulePreconditionFile,
  SchedulePreconditionFileError,
  type SchedulePreconditionFileOperations,
} from '../src/services/schedule-precondition-file.js';
import {
  ensureSchedulePreconditionRoot,
  MAX_SCHEDULE_PRECONDITION_SCRIPT_BYTES,
  schedulePreconditionRoot,
  schedulePreconditionTrustedFilesRoot,
} from '../src/services/schedule-precondition-store.js';

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
  let trustedRoot: string;
  let previousDataDir: string;

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'botmux-schedule-precondition-file-'));
    workingDir = join(tempDir, 'working');
    mkdirSync(workingDir);
    previousDataDir = config.session.dataDir;
    config.session.dataDir = join(tempDir, 'data');
    ensureSchedulePreconditionRoot();
    trustedRoot = schedulePreconditionTrustedFilesRoot();
  });

  afterEach(() => {
    const tempDir = join(workingDir, '..');
    config.session.dataDir = previousDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects relative paths before touching the filesystem', () => {
    const file = join(workingDir, 'guard.sh');
    writeFileSync(file, 'printf 1');
    const operations = nodeOperations();
    let lstatCalls = 0;
    const realLstat = operations.lstat;
    operations.lstat = path => {
      lstatCalls += 1;
      return realLstat(path);
    };

    const error = capturedError(() => readSchedulePreconditionFile('guard.sh', workingDir, operations));
    expect(error).toMatchObject({
      code: 'invalid_path',
      message: 'Scheduled task precondition file path must be absolute',
    });
    expect(lstatCalls).toBe(0);
  });

  it('rereads an absolute path on every call independently of task workingDir', () => {
    const file = join(trustedRoot, 'absolute-guard.sh');
    writeFileSync(file, 'printf 0');

    expect(readSchedulePreconditionFile(file, '')).toBe('printf 0');

    writeFileSync(file, 'printf 1');

    expect(readSchedulePreconditionFile(file, '')).toBe('printf 1');
  });

  it.each([
    ['the trusted root itself', () => trustedRoot],
    ['an absolute path outside the root', () => join(workingDir, 'outside.sh')],
    ['a parent traversal outside the root', () => join(trustedRoot, '..', 'outside.sh')],
    ['a sibling with the same path prefix', () => join(`${trustedRoot}-other`, 'guard.sh')],
  ] as const)('rejects %s with a stable non-leaking error', (_label, getPath) => {
    const filePath = getPath();
    const error = capturedError(() => assertSchedulePreconditionFilePathTrusted(filePath));

    expect(error).toMatchObject({
      code: 'outside_trusted_directory',
      message: 'Scheduled task precondition file path must be inside the daemon trusted-files directory',
    });
    expect(error.message).not.toContain(filePath);
    expect(error.message).not.toContain(trustedRoot);
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
    const privatePath = join(trustedRoot, privateBasename);

    const error = capturedError(() => readSchedulePreconditionFile(privatePath, workingDir));

    expect(error.code).toBe('unreadable_file');
    expect(error.message).not.toContain(privateBasename);
    expect(error.message).not.toContain(privatePath);
    expect(error.message).not.toContain(workingDir);
  });

  it.skipIf(process.platform === 'win32')('rejects a final symbolic link without reading its target', () => {
    const privateTargetName = 'private-target-name.sh';
    const target = join(workingDir, privateTargetName);
    const link = join(trustedRoot, 'guard.sh');
    writeFileSync(target, 'printf 1');
    symlinkSync(target, link);

    const error = capturedError(() => readSchedulePreconditionFile(link, workingDir));

    expect(error.code).toBe('symbolic_link');
    expect(error.message).not.toContain(privateTargetName);
    expect(error.message).not.toContain(link);
  });

  it('rejects non-regular files', () => {
    const directory = join(trustedRoot, 'directory');
    mkdirSync(directory);
    const error = capturedError(() => readSchedulePreconditionFile(directory, workingDir));

    expect(error.code).toBe('non_regular_file');
    expect(error.message).not.toContain(workingDir);
  });

  it('rejects source files larger than the protected script limit', () => {
    const file = join(trustedRoot, 'large.sh');
    writeFileSync(file, Buffer.alloc(MAX_SCHEDULE_PRECONDITION_SCRIPT_BYTES + 1, 0x61));

    const error = capturedError(() => readSchedulePreconditionFile(file, workingDir));

    expect(error.code).toBe('file_too_large');
    expect(error.message).not.toContain(file);
  });

  it('rejects invalid UTF-8 and blank or NUL-bearing Bash source', () => {
    const file = join(trustedRoot, 'guard.sh');

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
    const file = join(trustedRoot, 'guard.sh');
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

  it.skipIf(process.platform === 'win32')('rejects a symbolic-link ancestor below the trusted root', () => {
    const outsideDirectory = join(workingDir, 'outside-directory');
    const link = join(trustedRoot, 'linked-directory');
    mkdirSync(outsideDirectory);
    writeFileSync(join(outsideDirectory, 'guard.sh'), 'printf 1');
    symlinkSync(outsideDirectory, link);

    const error = capturedError(() => readSchedulePreconditionFile(
      join(link, 'guard.sh'),
      workingDir,
    ));

    expect(error.code).toBe('symbolic_link');
    expect(error.message).not.toContain(outsideDirectory);
    expect(error.message).not.toContain(link);
  });

  it.skipIf(process.platform === 'win32')('fails closed when an ancestor races to a symlink reaching the same file', () => {
    const nestedDirectory = join(trustedRoot, 'nested');
    const movedDirectory = join(workingDir, 'moved-nested');
    const file = join(nestedDirectory, 'guard.sh');
    mkdirSync(nestedDirectory);
    writeFileSync(file, 'printf 1');
    const operations = nodeOperations();
    const realOpen = operations.open;
    operations.open = (path, flags) => {
      renameSync(nestedDirectory, movedDirectory);
      symlinkSync(movedDirectory, nestedDirectory);
      return realOpen(path, flags);
    };

    const error = capturedError(() => readSchedulePreconditionFile(file, workingDir, operations));

    expect(error.code).toBe('symbolic_link');
    expect(error.message).not.toContain(movedDirectory);
    expect(error.message).not.toContain(nestedDirectory);
  });

  it.skipIf(process.platform === 'win32')('rejects a symbolic-link trusted root at runtime', () => {
    const outsideDirectory = join(workingDir, 'outside-root');
    mkdirSync(outsideDirectory);
    writeFileSync(join(outsideDirectory, 'guard.sh'), 'printf 1');
    rmSync(trustedRoot, { recursive: true });
    symlinkSync(outsideDirectory, trustedRoot);

    const error = capturedError(() => readSchedulePreconditionFile(
      join(trustedRoot, 'guard.sh'),
      workingDir,
    ));

    expect(error.code).toBe('symbolic_link');
    expect(error.message).not.toContain(outsideDirectory);
    expect(error.message).not.toContain(trustedRoot);
  });

  it('fails closed when descriptor metadata changes during the bounded read', () => {
    const file = join(trustedRoot, 'guard.sh');
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

  it('creates and tightens the trusted root below protected storage', () => {
    if (process.platform === 'win32') return;
    const storageRoot = schedulePreconditionRoot();
    chmodSync(trustedRoot, 0o755);

    expect(ensureSchedulePreconditionRoot()).toBe(storageRoot);
    expect(lstatSync(storageRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(trustedRoot).mode & 0o777).toBe(0o700);
  });
});
