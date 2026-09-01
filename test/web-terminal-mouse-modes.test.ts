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
 *   - worker seed appends the mode seed for WRITE clients only, and the client
 *     script trailing-throttles pure-motion reports (1003 floods → send-keys)
 */
import { describe, it, expect, vi, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

describe('worker web-terminal wiring (source assertions)', () => {
  const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

  it('appends the pane mode seed for write clients only', () => {
    expect(workerSource).toContain(
      "const modeSeed = hasWrite ? (backend?.capturePaneInputModes?.() ?? '') : '';",
    );
    expect(workerSource).toContain('ws.send(seed + modeSeed + herdrWebCursorSequence());');
    // Mode seed alone must still be sent when the capture seed is empty.
    expect(workerSource).toContain('if (seed.length > 0 || modeSeed.length > 0) {');
  });

  it('trailing-throttles pure-motion mouse reports in the client script', () => {
    // Motion = SGR button code 35 plus shift(+4)/alt(+8)/ctrl(+16) combinations.
    expect(workerSource).toContain(
      'var _MOTION_RE=/^(?:\\\\x1b\\\\[<(?:35|39|43|47|51|55|59|63);\\\\d+;\\\\d+[Mm])+$/;',
    );
    // Non-motion input must cancel a pending motion to preserve event order.
    const onData = workerSource.slice(
      workerSource.indexOf('term.onData(function(d){'),
      workerSource.indexOf('var fixedSize='),
    );
    expect(onData).toContain('_motionPend=d;');
    expect(onData).toContain('if(_motionT){clearTimeout(_motionT);_motionT=0}');
    expect(onData.indexOf('_MOTION_RE.test(d)')).toBeLessThan(onData.indexOf('_sendInput(d);'));
  });

  it('keeps the motion-code set in sync with the client regex', () => {
    // Base 35 (0b100011: motion, no button) + modifier bits 4/8/16.
    const expected = [0, 4, 8, 12, 16, 20, 24, 28].map(m => 35 + m).join('|');
    expect(workerSource).toContain(`(?:${expected})`);
  });
});
