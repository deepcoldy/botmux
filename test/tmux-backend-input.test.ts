/**
 * Unit tests for TmuxBackend input methods (sendText, sendSpecialKeys, pasteText).
 * Verifies the correct tmux commands are invoked.
 *
 * pasteText uses load-buffer + paste-buffer (tmux auto-wraps in bracketed paste
 * if the pane has it enabled). Only used by CLIs that support it (Claude Code).
 *
 * Run:  pnpm vitest run test/tmux-backend-input.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing TmuxBackend
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

// Mock node-pty
vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';

const mockedExecFileSync = vi.mocked(execFileSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createBackend(sessionName = 'bmx-test1234'): TmuxBackend {
  return new TmuxBackend(sessionName);
}

function getCalls(): Array<{ cmd: string; args: string[]; opts?: any }> {
  return mockedExecFileSync.mock.calls.map((call: any[]) => ({
    cmd: call[0] as string,
    args: call[1] as string[],
    opts: call[2],
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TmuxBackend.sendText', () => {
  beforeEach(() => mockedExecFileSync.mockReset());

  it('sends text via tmux send-keys -l', () => {
    const be = createBackend();
    be.sendText('hello world');

    const calls = getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('tmux');
    expect(calls[0].args).toContain('send-keys');
    expect(calls[0].args).toContain('-l');
    expect(calls[0].args).toContain('hello world');
  });

  it('targets the correct tmux session', () => {
    const be = createBackend('bmx-mysess');
    be.sendText('test');

    const calls = getCalls();
    const tIdx = calls[0].args.indexOf('-t');
    expect(calls[0].args[tIdx + 1]).toBe('bmx-mysess');
  });
});

describe('TmuxBackend.sendSpecialKeys', () => {
  beforeEach(() => mockedExecFileSync.mockReset());

  it('sends Enter key', () => {
    const be = createBackend();
    be.sendSpecialKeys('Enter');

    const calls = getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('Enter');
    expect(calls[0].args).not.toContain('-l');
  });

  it('sends multiple keys in one call', () => {
    const be = createBackend();
    be.sendSpecialKeys('Escape', 'q');

    const calls = getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('Escape');
    expect(calls[0].args).toContain('q');
  });
});

describe('TmuxBackend.pasteText', () => {
  beforeEach(() => mockedExecFileSync.mockReset());

  it('uses tmux load-buffer + paste-buffer', () => {
    const be = createBackend();
    be.pasteText('line1\n\nline2');

    const calls = getCalls();
    expect(calls).toHaveLength(2);

    // Call 1: load-buffer from stdin
    expect(calls[0].cmd).toBe('tmux');
    expect(calls[0].args).toContain('load-buffer');
    expect(calls[0].args).toContain('-');
    expect(calls[0].opts?.input).toBe('line1\n\nline2');

    // Call 2: paste-buffer to the session
    expect(calls[1].cmd).toBe('tmux');
    expect(calls[1].args).toContain('paste-buffer');
    expect(calls[1].args).toContain('-d');
  });

  it('targets the correct session in paste-buffer', () => {
    const be = createBackend('bmx-target');
    be.pasteText('content');

    const calls = getCalls();
    const pasteCall = calls[1];
    const tIdx = pasteCall.args.indexOf('-t');
    expect(tIdx).toBeGreaterThanOrEqual(0);
    expect(pasteCall.args[tIdx + 1]).toBe('bmx-target');
  });

  it('passes content via stdin to load-buffer', () => {
    const be = createBackend();
    const content = '中文内容\n带换行\n\nSession ID: abc-123';
    be.pasteText(content);

    const calls = getCalls();
    expect(calls[0].opts?.input).toBe(content);
    expect(calls[0].opts?.stdio).toEqual(['pipe', 'ignore', 'ignore']);
  });
});
