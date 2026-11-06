/**
 * Unit tests for TmuxBackend's static diagnostic-session helper.
 *
 * TmuxBackend is a static-only helper now (the pty-under-tmux instance was
 * removed; live tmux sessions run on TmuxPipeBackend). Input addressing,
 * paste-buffer handling, copy-mode guards and launch-wrapper shapes for the
 * live backend are covered in tmux-pipe-backend.test.ts / tmux-copy-mode.test.ts.
 *
 * Run:  bun run vitest run test/tmux-backend-input.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock child_process before importing TmuxBackend
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

import { execFileSync, execSync } from 'node:child_process';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExecSync = vi.mocked(execSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeShell = {
  readonly dir: string;
  readonly path: string;
};

function createFakeShell(name: 'fish'): FakeShell {
  const dir = mkdtempSync(join(tmpdir(), 'bmx-fake-shell-'));
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexec "$@"\n');
  chmodSync(path, 0o755);
  return { dir, path };
}

function cleanupFakeShell(shell: FakeShell): void {
  rmSync(shell.dir, { recursive: true, force: true });
}

function tmuxNewSessionArgs(): string[] {
  const call = mockedExecFileSync.mock.calls.find(([_, args]) => {
    return Array.isArray(args) && args.includes('new-session');
  });
  if (!call) throw new Error('expected tmux new-session call');
  return call[1] as string[];
}

function scriptIndex(args: readonly string[]): number {
  const index = args.indexOf('-c');
  if (index < 0) throw new Error('expected shell -c script in argv');
  return index;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TmuxBackend.parkDiagnosticSession', () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
    mockedExecSync.mockReset();
  });

  it('parks fish diagnostic sessions with fish argv and diagnostic syntax', () => {
    const shell = createFakeShell('fish');
    const previousShell = process.env.SHELL;
    process.env.SHELL = shell.path;
    try {
      const parked = TmuxBackend.parkDiagnosticSession('bmx-diag-fish', {
        cwd: '/tmp',
        cols: 80,
        rows: 24,
        contentPath: '/tmp/diagnostic.ansi',
      });

      expect(parked).toBe(true);
      const args = tmuxNewSessionArgs();
      const cIdx = scriptIndex(args);
      const script = args[cIdx + 1] ?? '';
      expect(args.slice(cIdx - 2, cIdx + 2)).toEqual([shell.path, '-i', '-c', script]);
      expect(args[cIdx + 2]).toBe('/tmp');
      expect(args[cIdx + 2]).not.toBe('_');
      expect(args[cIdx + 3]).toBe('/tmp/diagnostic.ansi');
      expect(args[cIdx + 4]).toBe(shell.path);
      expect(script).toContain('cd -- $argv[1]');
      expect(script).toContain('cat -- $argv[2]');
      expect(script).toContain('exec $argv[3] -i');
      expect(script).not.toContain('cd -- "$1"');
      expect(script).not.toContain('"$@');
      expect(script).not.toMatch(/\bshift\b/);
    } finally {
      if (previousShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = previousShell;
      cleanupFakeShell(shell);
    }
  });
});
