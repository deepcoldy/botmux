import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configuredWorkingDirs, invalidWorkingDirs, isPathWithinAnyDir, isPathWithinDir, parseWorkingDirList } from '../src/utils/working-dir.js';

describe('working-dir utils', () => {
  it('parses comma-separated strings and arrays', () => {
    expect(parseWorkingDirList('/a, /b,,/c')).toEqual(['/a', '/b', '/c']);
    expect(parseWorkingDirList(['/a, /b', ' /c '])).toEqual(['/a', '/b', '/c']);
    expect(parseWorkingDirList(undefined)).toEqual([]);
  });

  it('dedupes configured dirs by resolved path', () => {
    const cwd = process.cwd();
    expect(configuredWorkingDirs({ workingDir: '., ' + cwd })).toEqual(['.']);
  });

  it('reports missing paths and files as invalid dirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-working-dir-'));
    const file = join(dir, 'not-a-dir');
    const missing = join(dir, 'missing');
    writeFileSync(file, 'x');

    expect(invalidWorkingDirs({ workingDir: [dir, file, missing] })).toEqual([
      resolve(file),
      resolve(missing),
    ]);
  });

  it('accepts paths under an allowed root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-working-dir-root-'));
    expect(isPathWithinDir(join(dir, 'repo'), dir)).toBe(true);
    expect(isPathWithinAnyDir(join(dir, 'repo'), ['/other', dir])).toBe(true);
  });

  it('rejects sibling paths with the same prefix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-working-dir-root-'));
    expect(isPathWithinDir(`${dir}-sibling`, dir)).toBe(false);
  });

  it('resolves symlinks before applying the root guard', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-working-dir-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'botmux-working-dir-outside-'));
    const link = join(root, 'escape');
    symlinkSync(outside, link);

    expect(isPathWithinDir(link, root)).toBe(false);
  });
});
