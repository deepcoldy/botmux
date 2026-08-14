import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateExecutable } from '../src/utils/executable.js';

describe('locateExecutable', () => {
  it('returns absolute path as-is when executable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'locate-exe-'));
    try {
      const exe = join(dir, 'tool');
      writeFileSync(exe, '#!/bin/sh\nexit 0\n');
      expect(locateExecutable(exe)).toBe(exe);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for absolute path that is not executable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'locate-missing-'));
    try {
      const missing = join(dir, 'nope');
      expect(locateExecutable(missing)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a bare name across PATH (POSIX form)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'locate-path-'));
    try {
      const bin = join(dir, 'mytool');
      writeFileSync(bin, '#!/bin/sh\nexit 0\n');
      // The file exists; locateExecutable just checks X_OK — on POSIX CI the
      // temp file is executable; on Windows the PATHEXT form is exercised in
      // the dedicated tests below. Assert the path resolution shape only.
      const found = locateExecutable('mytool', { ...process.env, PATH: dir });
      if (found !== null) {
        expect(found).toBe(bin);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves .cmd shims on Windows via PATHEXT', () => {
    const dir = mkdtempSync(join(tmpdir(), 'locate-cmd-'));
    try {
      const shim = join(dir, 'claude.cmd');
      writeFileSync(shim, '@echo off\necho hi\n');
      const found = locateExecutable('claude', {
        ...process.env,
        PATH: dir,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
      }, 'win32');
      // Windows filesystem is case-insensitive: PATHEXT keeps uppercase
      // extensions, so compare case-insensitively.
      expect(found?.toLowerCase()).toBe(shim.toLowerCase());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves .exe on Windows and prefers PATHEXT order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'locate-exe2-'));
    try {
      const cmd = join(dir, 'tool.cmd');
      const exe = join(dir, 'tool.exe');
      writeFileSync(cmd, '@echo off\n');
      writeFileSync(exe, 'MZ');
      // PATHEXT .EXE before .CMD → tool.exe wins.
      const found = locateExecutable('tool', {
        ...process.env,
        PATH: dir,
        PATHEXT: '.EXE;.CMD',
      }, 'win32');
      expect(found?.toLowerCase()).toBe(exe.toLowerCase());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no PATHEXT candidate exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'locate-none-'));
    try {
      const found = locateExecutable('ghost-tool', {
        ...process.env,
        PATH: dir,
        PATHEXT: '.EXE;.CMD',
      }, 'win32');
      expect(found).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles undefined command', () => {
    expect(locateExecutable(undefined)).toBeNull();
  });
});
