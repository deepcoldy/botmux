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

import { execFileSync, execSync } from 'node:child_process';
import * as pty from 'node-pty';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExecSync = vi.mocked(execSync);
const mockedPtySpawn = vi.mocked(pty.spawn);

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

// ---------------------------------------------------------------------------
// Adopt mode: input must address the real pane target, not the synthetic
// session name. Without this, send-keys falls through to whichever pane
// tmux happens to have active and the user's message lands in the wrong
// CLI (the bug v3 turned up).
// ---------------------------------------------------------------------------

describe('TmuxBackend adopt-mode pane addressing', () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
    // execSync is called by attachToExisting (grouped-session setup,
    // select-window, select-pane, zoom). Mock it as a no-op so each test
    // only inspects the execFileSync calls (the real input commands).
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.from('') as any);
    mockedPtySpawn.mockReset();
    mockedPtySpawn.mockReturnValue({
      onData: () => {},
      onExit: () => {},
      write: () => {},
      resize: () => {},
      kill: () => {},
    } as any);
  });

  function adoptedBackend(target = '0:2.0') {
    // Synthetic name mirrors what worker.ts uses in adopt mode.
    const be = new TmuxBackend('adopt-deadbeef', { ownsSession: false });
    be.attachToExisting(target, {
      cwd: '/tmp',
      cols: 200,
      rows: 50,
      env: process.env as Record<string, string>,
    });
    return be;
  }

  it('sendText addresses the adopted pane, not the synthetic session name', () => {
    const be = adoptedBackend('0:3.1');
    mockedExecFileSync.mockClear();
    be.sendText('飞书消息');

    const calls = getCalls();
    expect(calls).toHaveLength(1);
    const tIdx = calls[0].args.indexOf('-t');
    // CRITICAL: target must be the real pane "0:3.1", NOT "adopt-deadbeef".
    expect(calls[0].args[tIdx + 1]).toBe('0:3.1');
    expect(calls[0].args[tIdx + 1]).not.toBe('adopt-deadbeef');
  });

  it('sendSpecialKeys addresses the adopted pane', () => {
    const be = adoptedBackend('0:2.0');
    mockedExecFileSync.mockClear();
    be.sendSpecialKeys('Enter');

    const calls = getCalls();
    const tIdx = calls[0].args.indexOf('-t');
    expect(calls[0].args[tIdx + 1]).toBe('0:2.0');
  });

  it('pasteText addresses the adopted pane on paste-buffer', () => {
    const be = adoptedBackend('1:0.2');
    mockedExecFileSync.mockClear();
    be.pasteText('multi\nline\ntext');

    const calls = getCalls();
    const pasteCall = calls.find(c => c.args.includes('paste-buffer'))!;
    const tIdx = pasteCall.args.indexOf('-t');
    expect(pasteCall.args[tIdx + 1]).toBe('1:0.2');
  });

  it('non-adopt backend keeps using the bmx-* session name', () => {
    const be = createBackend('bmx-real');
    be.sendText('hello');
    const calls = getCalls();
    const tIdx = calls[0].args.indexOf('-t');
    expect(calls[0].args[tIdx + 1]).toBe('bmx-real');
  });

  // getChildPid must resolve to ONE pane, not the first listed in a multi-
  // pane window. tmux list-panes -F returns every pane in the window when
  // the target is a pane address; display-message -p resolves exactly
  // the target pane.
  it('getChildPid uses display-message (single-pane resolver), not list-panes', () => {
    const be = adoptedBackend('0:2.0');
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue('98765\n' as any);
    const pid = be.getChildPid();
    expect(pid).toBe(98765);
    const cmd = mockedExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain('display-message');
    expect(cmd).toContain('#{pane_pid}');
    expect(cmd).not.toContain('list-panes');
  });
});
