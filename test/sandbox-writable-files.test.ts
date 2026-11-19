import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSandboxWritableFiles } from '../src/adapters/backend/sandbox-writable-files.js';

describe('prepareSandboxWritableFiles', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sbx-writable-files-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('creates a missing file as an EMPTY regular file (never a directory) and returns it', () => {
    const p = join(dir, 'trae', 'installation_id');
    expect(prepareSandboxWritableFiles([p])).toEqual([p]);
    expect(lstatSync(p).isFile()).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('');
  });

  it('keeps an existing file byte-for-byte', () => {
    const p = join(dir, 'installation_id');
    writeFileSync(p, '568d1637-91f8-420a-885c-c2f4407ca399');
    expect(prepareSandboxWritableFiles([p, p])).toEqual([p]);
    expect(readFileSync(p, 'utf8')).toBe('568d1637-91f8-420a-885c-c2f4407ca399');
  });

  it('never binds a directory, a symlink or a relative path', () => {
    const asDir = join(dir, 'is-dir');
    mkdirSync(asDir);
    const target = join(dir, 'elsewhere');
    writeFileSync(target, 'x');
    const link = join(dir, 'link');
    symlinkSync(target, link);
    expect(prepareSandboxWritableFiles([asDir, link, 'relative/installation_id'])).toEqual([]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
