import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isLocalDevInstallAt,
  isLocalDevInstall,
  botmuxVersion,
  botmuxVersionAt,
  botmuxCliEntryAt,
  bakedBinaryVersion,
} from '../src/utils/install-info.js';

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

  it('can read a stable package root selected by the updater', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-version-at-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '9.8.7' }));
      expect(botmuxVersionAt(root)).toBe('9.8.7');
      expect(botmuxCliEntryAt(root)).toBe(join(root, 'dist', 'cli.js'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The compiled single-file executable has no package.json on disk (its module
 * graph lives in the virtual read-only /$bunfs, and packageRoot() walks up to
 * `/`, which has none), so every version read failed there and `botmux
 * --version` printed `unknown` on the published 3.18.0-canary.2. The build now
 * bakes the version in via `define`, surfaced through bakedBinaryVersion().
 */
describe('bakedBinaryVersion (compiled-binary version)', () => {
  const KEY = 'BOTMUX_BAKED_VERSION';
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[KEY]; delete process.env[KEY]; });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('undefined under Node, where nothing is baked in', () => {
    expect(bakedBinaryVersion()).toBeUndefined();
  });

  it('returns the baked version when the build substituted one', () => {
    process.env[KEY] = '3.18.0-canary.2';
    expect(bakedBinaryVersion()).toBe('3.18.0-canary.2');
  });

  it('treats the unbuilt 0.0.0 placeholder as absent', () => {
    // A locally-compiled dev binary bakes in the repo's placeholder. Reporting
    // that as authoritative would mask the git-describe fallback, so it must be
    // indistinguishable from "nothing baked".
    process.env[KEY] = '0.0.0';
    expect(bakedBinaryVersion()).toBeUndefined();
  });

  it('treats blank/whitespace as absent and trims real values', () => {
    process.env[KEY] = '   ';
    expect(bakedBinaryVersion()).toBeUndefined();
    process.env[KEY] = '  3.20.1  ';
    expect(bakedBinaryVersion()).toBe('3.20.1');
  });

  it('takes precedence over an on-disk package.json (the compiled case)', () => {
    // In compiled mode the disk read fails; here we prove the baked value wins
    // even when a readable package.json exists, which is what makes the single
    // code path correct for both runtimes.
    const root = mkdtempSync(join(tmpdir(), 'botmux-baked-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
      expect(botmuxVersionAt(root)).toBe('1.2.3');
      process.env[KEY] = '4.5.6';
      expect(botmuxVersionAt(root)).toBe('4.5.6');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the disk read when the baked value is the placeholder', () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-baked-ph-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '7.7.7' }));
      process.env[KEY] = '0.0.0';
      expect(botmuxVersionAt(root)).toBe('7.7.7');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
