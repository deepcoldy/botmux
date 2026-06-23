import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstExistingDir, safeCwd } from '../src/utils/safe-cwd.js';

describe('firstExistingDir', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-safecwd-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns the first candidate that is an existing directory', () => {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    mkdirSync(a);
    mkdirSync(b);
    expect(firstExistingDir([join(dir, 'missing'), a, b])).toBe(a);
  });

  it('skips non-existent candidates and falls through to a later existing one', () => {
    const real = join(dir, 'real');
    mkdirSync(real);
    expect(firstExistingDir([join(dir, 'nope'), join(dir, 'also-nope'), real])).toBe(real);
  });

  it('skips a candidate that exists but is a regular file (not a directory)', () => {
    const file = join(dir, 'file');
    writeFileSync(file, 'x');
    const real = join(dir, 'realdir');
    mkdirSync(real);
    expect(firstExistingDir([file, real])).toBe(real);
  });

  it('falls back to os.tmpdir() when no candidate exists', () => {
    const res = firstExistingDir([join(dir, 'x'), join(dir, 'y')]);
    expect(res).toBe(tmpdir());
    expect(existsSync(res)).toBe(true);
  });
});

describe('safeCwd (runtime)', () => {
  const made: string[] = [];
  const tmpHome = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'botmux-safecwd-home-'));
    made.push(d);
    return d;
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('returns an existing directory', () => {
    const res = safeCwd();
    expect(typeof res).toBe('string');
    expect(existsSync(res)).toBe(true);
  });

  it('prefers ~/.botmux when it exists', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.botmux'));
    vi.stubEnv('HOME', home);
    expect(safeCwd()).toBe(join(home, '.botmux'));
  });

  it('falls back to the home dir when ~/.botmux is absent', () => {
    const home = tmpHome();
    vi.stubEnv('HOME', home);
    expect(safeCwd()).toBe(home);
  });
});
