/**
 * Regression tests for tmux copy-mode swallowing botmux input.
 *
 * When a pane is in copy-mode, `tmux send-keys` is handled by tmux itself
 * instead of the CLI running in the pane. The tmux backends must cancel
 * copy-mode before forwarding chat input.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { TmuxBackend } from '../src/adapters/backend/tmux-backend.js';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';

const mockedExecFileSync = vi.mocked(execFileSync);

function mockPaneMode(mode: '0' | '1') {
  mockedExecFileSync.mockImplementation((cmd: any, args: any[]) => {
    if (cmd === 'tmux' && args.includes('display-message')) {
      return `${mode}\n` as any;
    }
    return Buffer.from('') as any;
  });
}

function tmuxCalls() {
  return mockedExecFileSync.mock.calls.map(call => call[1] as string[]);
}

function isCopyModeProbe(args: string[]) {
  return args.includes('display-message') && args.includes('#{pane_in_mode}');
}

function isCopyModeCancel(args: string[]) {
  return args.includes('send-keys') && args.includes('-X') && args.includes('cancel');
}

beforeEach(() => {
  mockedExecFileSync.mockReset();
  mockPaneMode('0');
});

describe('TmuxBackend copy-mode guard', () => {
  it('cancels copy-mode before sendText forwards input', () => {
    mockPaneMode('1');
    const be = new TmuxBackend('bmx-copy');

    be.sendText('hello');

    const calls = tmuxCalls();
    expect(calls[0]).toEqual(['display-message', '-p', '-t', 'bmx-copy', '#{pane_in_mode}']);
    expect(calls[1]).toEqual(['send-keys', '-t', 'bmx-copy', '-X', 'cancel']);
    expect(calls[2]).toEqual(['send-keys', '-t', 'bmx-copy', '-l', '--', 'hello']);
  });

  it('does not cancel copy-mode when the pane is already in normal mode', () => {
    const be = new TmuxBackend('bmx-normal');

    be.sendSpecialKeys('Enter');

    const calls = tmuxCalls();
    expect(calls.some(isCopyModeProbe)).toBe(true);
    expect(calls.some(isCopyModeCancel)).toBe(false);
    expect(calls.at(-1)).toEqual(['send-keys', '-t', 'bmx-normal', 'Enter']);
  });

  it('still pastes input if the copy-mode probe fails', () => {
    mockedExecFileSync.mockImplementation((cmd: any, args: any[]) => {
      if (cmd === 'tmux' && args.includes('display-message')) {
        throw new Error('tmux server unavailable');
      }
      return Buffer.from('') as any;
    });
    const be = new TmuxBackend('bmx-probe-error');

    be.pasteText('multi\nline');

    const calls = tmuxCalls();
    expect(calls.some(args => args.includes('load-buffer'))).toBe(true);
    expect(calls.some(args => args.includes('paste-buffer'))).toBe(true);
  });
});

describe('TmuxPipeBackend copy-mode guard', () => {
  it('cancels copy-mode before sendSpecialKeys forwards input', () => {
    mockPaneMode('1');
    const be = new TmuxPipeBackend('0:2.0');

    be.sendSpecialKeys('Enter');

    const calls = tmuxCalls();
    expect(calls[0]).toEqual(['display-message', '-p', '-t', '0:2.0', '#{pane_in_mode}']);
    expect(calls[1]).toEqual(['send-keys', '-t', '0:2.0', '-X', 'cancel']);
    expect(calls[2]).toEqual(['send-keys', '-t', '0:2.0', 'Enter']);
  });

  it('does not cancel copy-mode when the adopted pane is already in normal mode', () => {
    const be = new TmuxPipeBackend('1:3.0');

    be.sendText('hello');

    const calls = tmuxCalls();
    expect(calls.some(isCopyModeProbe)).toBe(true);
    expect(calls.some(isCopyModeCancel)).toBe(false);
    expect(calls.at(-1)).toEqual(['send-keys', '-t', '1:3.0', '-l', '--', 'hello']);
  });

  it('still pastes input if the copy-mode probe fails', () => {
    mockedExecFileSync.mockImplementation((cmd: any, args: any[]) => {
      if (cmd === 'tmux' && args.includes('display-message')) {
        throw new Error('tmux server unavailable');
      }
      return Buffer.from('') as any;
    });
    const be = new TmuxPipeBackend('2:1.0');

    be.pasteText('multi\nline');

    const calls = tmuxCalls();
    expect(calls.some(args => args.includes('load-buffer'))).toBe(true);
    expect(calls.some(args => args.includes('paste-buffer'))).toBe(true);
  });
});
