import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isLocalDevInstallAt, isLocalDevInstall, botmuxVersion } from '../src/utils/install-info.js';

describe('isLocalDevInstallAt', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-install-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('true when a .git directory is present (checkout)', () => {
    mkdirSync(join(dir, '.git'));
    expect(isLocalDevInstallAt(dir)).toBe(true);
  });
  it('true when .git is a file (git worktree pointer)', () => {
    writeFileSync(join(dir, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
    expect(isLocalDevInstallAt(dir)).toBe(true);
  });
  it('true when a src/ directory is present (unpublished source tree)', () => {
    mkdirSync(join(dir, 'src'));
    expect(isLocalDevInstallAt(dir)).toBe(true);
  });
  it('false for an npm-global-style install (only dist/, no .git/src)', () => {
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'botmux' }));
    expect(isLocalDevInstallAt(dir)).toBe(false);
  });
});

describe('isLocalDevInstall (runtime)', () => {
  it('returns a boolean and detects this checkout/worktree as local-dev', () => {
    const v = isLocalDevInstall();
    expect(typeof v).toBe('boolean');
    expect(v).toBe(true); // the test runs from a git working copy with src/
  });
});

describe('botmuxVersion', () => {
  it('reads the version from the package root package.json', () => {
    // resolve repo root from this test file: test/ → repo root
    const root = fileURLToPath(new URL('..', import.meta.url));
    const expected = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;
    expect(botmuxVersion()).toBe(expected);
  });
});
