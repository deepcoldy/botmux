import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configuredWorkingDirs, invalidWorkingDirs, parseWorkingDirList } from '../src/utils/working-dir.js';
import { validateWorkingDir } from '../src/core/working-dir.js';

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
});

describe('validateWorkingDir', () => {
  it('rejects a missing path by default and does not create it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-validate-wd-'));
    const missing = join(dir, 'missing');

    const r = validateWorkingDir(missing);
    expect(r.ok).toBe(false);
    expect(existsSync(missing)).toBe(false);
  });

  it('creates a missing path with autoCreate and flags created', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-validate-wd-'));
    const missing = join(dir, 'nested', 'deep');

    const r = validateWorkingDir(missing, undefined, { autoCreate: true });
    expect(r).toEqual({ ok: true, resolvedPath: resolve(missing), created: true });
    expect(existsSync(missing)).toBe(true);
  });

  it('does not flag created for an existing dir even with autoCreate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-validate-wd-'));

    const r = validateWorkingDir(dir, undefined, { autoCreate: true });
    expect(r).toEqual({ ok: true, resolvedPath: resolve(dir) });
  });

  it('rejects an existing file in both modes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-validate-wd-'));
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');

    expect(validateWorkingDir(file).ok).toBe(false);
    expect(validateWorkingDir(file, undefined, { autoCreate: true }).ok).toBe(false);
  });
});
