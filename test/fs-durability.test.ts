import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  fsyncDirectorySyncPortable,
  fsyncFilesAndDirectorySync,
  fsyncRegularFileSync,
  isUnsupportedDirectoryFsyncError,
} from '../src/utils/fs-durability.js';

describe('filesystem durability helpers', () => {
  it('strictly syncs regular files followed by their containing directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-durable-'));
    try {
      const a = join(root, 'a.json');
      const b = join(root, 'b.json');
      writeFileSync(a, '{}\n');
      writeFileSync(b, '[]\n');

      expect(() => fsyncRegularFileSync(a)).not.toThrow();
      expect(() => fsyncFilesAndDirectorySync(root, [b, a, a])).not.toThrow();
      expect(() => fsyncDirectorySyncPortable(root)).not.toThrow();

      const directory = join(root, 'not-a-file');
      mkdirSync(directory);
      expect(() => fsyncRegularFileSync(directory)).toThrow(/regular file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('only treats explicit unsupported-directory errnos as best-effort', () => {
    for (const code of ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']) {
      expect(isUnsupportedDirectoryFsyncError(Object.assign(new Error(code), { code }))).toBe(true);
    }
    expect(isUnsupportedDirectoryFsyncError(Object.assign(new Error('disk I/O'), { code: 'EIO' }))).toBe(false);
    expect(isUnsupportedDirectoryFsyncError(Object.assign(new Error('permission'), { code: 'EACCES' }))).toBe(false);
    expect(isUnsupportedDirectoryFsyncError(new Error('no errno'))).toBe(false);
  });
});
