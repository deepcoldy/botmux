import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { resolveServiceSecretReadonlyFiles } from '../src/adapters/cli/service-secret-files.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-service-secret-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveServiceSecretReadonlyFiles', () => {
  it('returns canonical exact regular files and expands tilde', () => {
    const home = tempDir();
    const path = join(home, 'diag-token');
    writeFileSync(path, 'test-token', { mode: 0o600 });

    expect(resolveServiceSecretReadonlyFiles(['~/diag-token'], home)).toEqual([
      realpathSync(path),
    ]);
  });

  it('fails closed for a symlink leaf', () => {
    const home = tempDir();
    const target = join(home, 'target');
    const link = join(home, 'link');
    writeFileSync(target, 'test-token', { mode: 0o600 });
    symlinkSync(target, link);

    expect(() => resolveServiceSecretReadonlyFiles([link], home)).toThrow(
      'every service credential path must be an exact regular file',
    );
  });

  it('fails closed for a directory', () => {
    const home = tempDir();
    const path = join(home, 'not-a-file');
    mkdirSync(path);

    expect(() => resolveServiceSecretReadonlyFiles([path], home)).toThrow(
      'every service credential path must be an exact regular file',
    );
  });

  it('fails closed for a missing file', () => {
    const home = tempDir();

    expect(() => resolveServiceSecretReadonlyFiles([join(home, 'missing')], home)).toThrow(
      'a required service credential file is unavailable',
    );
  });
});
