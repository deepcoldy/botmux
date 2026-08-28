/**
 * Unit tests for the executable/PATH helpers.
 *
 * PR #836 hardening: `accessSync(X_OK)` succeeds on a DIRECTORY (the `x` bit
 * means "traversable" there), so a directory that merely shares an executable's
 * name on PATH would be mis-resolved as the binary. isExecutable() must require
 * a regular file.
 *
 * Run:  pnpm vitest run test/executable.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isExecutable, locateExecutable } from '../src/utils/executable.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'exec-test-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isExecutable', () => {
  it('accepts a regular file with the executable bit', () => {
    const f = join(dir, 'realbin');
    writeFileSync(f, '#!/bin/sh\n');
    chmodSync(f, 0o755);
    expect(isExecutable(f)).toBe(true);
  });

  it('rejects a regular file WITHOUT the executable bit (EACCES)', () => {
    const f = join(dir, 'notexec');
    writeFileSync(f, 'plain\n');
    chmodSync(f, 0o644);
    expect(isExecutable(f)).toBe(false);
  });

  it('rejects a DIRECTORY that carries the x (traversable) bit', () => {
    // The core PR #836 edge: a dir named like a binary is traversable (0755)
    // and would pass a bare X_OK check.
    const d = join(dir, 'dirlike');
    mkdirSync(d, 0o755);
    expect(isExecutable(d)).toBe(false);
  });

  it('rejects a missing path (ENOENT)', () => {
    expect(isExecutable(join(dir, 'nope-does-not-exist'))).toBe(false);
  });

  it('follows a symlink to a real executable', () => {
    const target = join(dir, 'symtarget');
    writeFileSync(target, '#!/bin/sh\n');
    chmodSync(target, 0o755);
    const link = join(dir, 'symlink');
    symlinkSync(target, link);
    expect(isExecutable(link)).toBe(true);
  });
});

describe('locateExecutable (PR #836: directory on PATH must not resolve)', () => {
  it('does not resolve a same-named directory sitting on PATH', () => {
    const pathDir = mkdtempSync(join(tmpdir(), 'exec-path-'));
    mkdirSync(join(pathDir, 'zellij'), 0o755); // a DIRECTORY named zellij
    try {
      expect(locateExecutable('zellij', { PATH: pathDir })).toBeNull();
    } finally {
      rmSync(pathDir, { recursive: true, force: true });
    }
  });

  it('resolves a real binary but skips a shadowing directory earlier on PATH', () => {
    const dirWithDir = mkdtempSync(join(tmpdir(), 'exec-p1-'));
    const dirWithBin = mkdtempSync(join(tmpdir(), 'exec-p2-'));
    mkdirSync(join(dirWithDir, 'zellij'), 0o755); // directory shadow first
    const bin = join(dirWithBin, 'zellij');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    try {
      expect(locateExecutable('zellij', { PATH: `${dirWithDir}:${dirWithBin}` })).toBe(bin);
    } finally {
      rmSync(dirWithDir, { recursive: true, force: true });
      rmSync(dirWithBin, { recursive: true, force: true });
    }
  });

  it('returns null for an empty PATH', () => {
    expect(locateExecutable('zellij', { PATH: '' })).toBeNull();
  });
});
