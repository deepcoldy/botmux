/**
 * Web-terminal input-mode restoration (grok build double-click regression).
 *
 * A capture-pane seed carries screen cells but no DECSET state, so a freshly
 * connected web client's xterm never learned the CLI had enabled mouse
 * tracking — grok build (1003 any-motion + 1006 SGR) then never received
 * clicks, and double-click-to-expand silently did nothing. Verifies:
 *
 *   - paneInputModeSeed maps tmux pane flags → DECSET re-assert sequence
 *   - parsePaneModeFlags parses/rejects display-message output
 *   - TmuxPipeBackend.capturePaneInputModes queries the REAL pane target and
 *     composes the sequence (empty on error/exit)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import {
  paneInputModeSeed,
  parsePaneModeFlags,
  PANE_MODE_FLAGS_FORMAT,
  TmuxPipeBackend,
} from '../src/adapters/backend/tmux-pipe-backend.js';

const mockedExecSync = vi.mocked(execSync);

describe('paneInputModeSeed', () => {
  it('re-asserts grok build modes (1003 any-motion + 1006 SGR)', () => {
    expect(paneInputModeSeed({
      mouseStandard: false,
      mouseButton: false,
      mouseAll: true,
      mouseSgr: true,
      appCursorKeys: false,
      appKeypad: false,
      cursorVisible: true,
    })).toBe('\x1b[?1003h\x1b[?1006h');
  });

  it('is empty for a mode-less pane (plain shell)', () => {
    expect(paneInputModeSeed({
      mouseStandard: false,
      mouseButton: false,
      mouseAll: false,
      mouseSgr: false,
      appCursorKeys: false,
      appKeypad: false,
      cursorVisible: true,
    })).toBe('');
  });

  it('covers every tracked mode, hiding the cursor only when the pane does', () => {
    expect(paneInputModeSeed({
      mouseStandard: true,
      mouseButton: true,
      mouseAll: true,
      mouseSgr: true,
      appCursorKeys: true,
      appKeypad: true,
      cursorVisible: false,
    })).toBe('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1h\x1b=\x1b[?25l');
  });
});

describe('parsePaneModeFlags', () => {
  it('parses a grok build pane', () => {
    expect(parsePaneModeFlags('0 0 1 1 0 0 1\n')).toEqual({
      mouseStandard: false,
      mouseButton: false,
      mouseAll: true,
      mouseSgr: true,
      appCursorKeys: false,
      appKeypad: false,
      cursorVisible: true,
    });
  });

  it('rejects malformed output (pane vanished → tmux error line)', () => {
    expect(parsePaneModeFlags("can't find pane: %42")).toBeNull();
    expect(parsePaneModeFlags('')).toBeNull();
    expect(parsePaneModeFlags('0 0 1 1 0 0')).toBeNull();
    expect(parsePaneModeFlags('0 0 2 1 0 0 1')).toBeNull();
  });
});

describe('TmuxPipeBackend.capturePaneInputModes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries the real pane target and composes the DECSET sequence', () => {
    const backend = new TmuxPipeBackend('main:1.2', { ownsSession: false });
    mockedExecSync.mockReturnValueOnce('0 0 1 1 0 0 1\n' as any);

    expect(backend.capturePaneInputModes()).toBe('\x1b[?1003h\x1b[?1006h');

    const cmd = String(mockedExecSync.mock.calls[0][0]);
    expect(cmd).toContain("display-message -p -t 'main:1.2'");
    expect(cmd).toContain(PANE_MODE_FLAGS_FORMAT);
  });

  it('returns empty when tmux fails or output is malformed', () => {
    const backend = new TmuxPipeBackend('main:1.2', { ownsSession: false });
    mockedExecSync.mockImplementationOnce(() => { throw new Error('no server'); });
    expect(backend.capturePaneInputModes()).toBe('');

    mockedExecSync.mockReturnValueOnce("can't find pane\n" as any);
    expect(backend.capturePaneInputModes()).toBe('');
  });
});
