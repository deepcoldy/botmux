/**
 * Unit tests for TmuxPipeBackend.
 *
 * Verifies:
 *   - spawn() creates a fifo, opens it for read, then issues `tmux pipe-pane`
 *   - send-keys / paste-buffer / copy-mode all address the REAL pane target
 *     (the bug we keep guarding against — using a synthetic session name
 *     here would silently route input to whichever pane tmux has active)
 *   - kill() cancels the pipe-pane subscription with `tmux pipe-pane`
 *     (no command argument = turn off) and unlinks the fifo
 *   - getChildPid resolves through display-message, not list-panes
 *   - captureCurrentScreen issues capture-pane -e -p -S -
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual: any = await vi.importActual('node:fs');
  return {
    ...actual,
    openSync: vi.fn(() => 7),
    createReadStream: vi.fn(() => {
      const handlers: Record<string, Array<(...a: any[]) => void>> = {};
      return {
        on(event: string, cb: any) { (handlers[event] ??= []).push(cb); return this; },
        emit(event: string, ...args: any[]) { for (const cb of handlers[event] ?? []) cb(...args); },
        destroy: vi.fn(),
      };
    }),
    unlinkSync: vi.fn(),
    constants: actual.constants,
  };
});

import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { unlinkSync, createReadStream } from 'node:fs';
import {
  TmuxPipeBackend,
  normaliseCaptureLineEndings,
  tmuxLifecycleInitialDelayMs,
} from '../src/adapters/backend/tmux-pipe-backend.js';

const mockedExecSync = vi.mocked(execSync);
const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawnSync = vi.mocked(spawnSync);
const mockedUnlinkSync = vi.mocked(unlinkSync);

function getExecFileCalls() {
  return mockedExecFileSync.mock.calls
    .filter(call => !(call[1] as string[]).includes('display-message'));
}

function spawnOpts() {
  return {
    cwd: '/tmp',
    cols: 200,
    rows: 50,
    env: process.env as Record<string, string>,
  };
}

beforeEach(() => {
  mockedExecSync.mockReset();
  mockedExecFileSync.mockReset();
  mockedSpawnSync.mockReset();
  mockedUnlinkSync.mockReset();
  mockedExecSync.mockReturnValue(Buffer.from('') as any);
  mockedSpawnSync.mockReturnValue({ status: 0 } as any);
});

describe('TmuxPipeBackend.spawn', () => {
  it('mkfifo + opens read fd + issues tmux pipe-pane to that fifo', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());

    // Step 1: mkfifo via spawnSync
    expect(mockedSpawnSync).toHaveBeenCalledWith('mkfifo', expect.arrayContaining([expect.stringMatching(/botmux-pipe-/)]), expect.any(Object));

    // Step 2: tmux pipe-pane -O -t 0:2.0 'cat > <fifo>'
    const pipeCalls = mockedExecSync.mock.calls
      .map(c => String(c[0]))
      .filter(c => c.includes('pipe-pane'));
    expect(pipeCalls.length).toBe(1);
    expect(pipeCalls[0]).toContain('-O');
    expect(pipeCalls[0]).toContain("'0:2.0'");
    expect(pipeCalls[0]).toMatch(/cat > '.*botmux-pipe-.*\.fifo'/);
  });
});

describe('TmuxPipeBackend input addressing', () => {
  it('sendText routes to the real pane target', () => {
    const be = new TmuxPipeBackend('0:3.1');
    be.spawn('', [], spawnOpts());
    mockedExecFileSync.mockClear();
    be.sendText('飞书消息');

    const call = getExecFileCalls()[0];
    expect(call[0]).toBe('tmux');
    const args = call[1] as string[];
    const tIdx = args.indexOf('-t');
    expect(args[tIdx + 1]).toBe('0:3.1');
    expect(args).toContain('-l');
    expect(args).toContain('飞书消息');
  });

  it('sendSpecialKeys routes to the pane', () => {
    const be = new TmuxPipeBackend('1:0.2');
    be.spawn('', [], spawnOpts());
    mockedExecFileSync.mockClear();
    be.sendSpecialKeys('Enter');

    const args = getExecFileCalls()[0][1] as string[];
    const tIdx = args.indexOf('-t');
    expect(args[tIdx + 1]).toBe('1:0.2');
    expect(args).toContain('Enter');
  });

  it('pasteText load-buffer + paste-buffer, paste targets the pane', () => {
    const be = new TmuxPipeBackend('0:5.0');
    be.spawn('', [], spawnOpts());
    mockedExecFileSync.mockClear();
    be.pasteText('multi\nline');

    const calls = getExecFileCalls();
    const loadArgs = calls[0][1] as string[];
    expect(loadArgs).toContain('load-buffer');
    expect((calls[0][2] as any).input).toBe('multi\nline');
    const bIdx = loadArgs.indexOf('-b');
    expect(bIdx).toBeGreaterThanOrEqual(0);
    const bufferName = loadArgs[bIdx + 1];
    expect(bufferName).toMatch(/^botmux-[a-f0-9]{16}$/);

    const pasteArgs = calls[1][1] as string[];
    expect(pasteArgs).toContain('paste-buffer');
    const pasteBIdx = pasteArgs.indexOf('-b');
    expect(pasteBIdx).toBeGreaterThanOrEqual(0);
    expect(pasteArgs[pasteBIdx + 1]).toBe(bufferName);
    const tIdx = pasteArgs.indexOf('-t');
    expect(pasteArgs[tIdx + 1]).toBe('0:5.0');
    // -p forces bracketed-paste markers, REQUIRED for CoCo/Ink to treat the
    // content as one paste and accept the trailing Enter as a submit. Without
    // it the Enter is swallowed as a soft-newline and the message strands in
    // the input box (replies-to-previous-message off-by-one). Regression guard
    // for PR #25, which added -p only to the unused TmuxBackend.
    expect(pasteArgs).toContain('-p');
  });

  it('uses a fresh named tmux buffer for each paste', () => {
    const be = new TmuxPipeBackend('0:5.0');
    be.spawn('', [], spawnOpts());
    mockedExecFileSync.mockClear();
    be.pasteText('one');
    be.pasteText('two');

    const loadCalls = getExecFileCalls()
      .map(call => call[1] as string[])
      .filter(args => args.includes('load-buffer'));
    const firstBuffer = loadCalls[0][loadCalls[0].indexOf('-b') + 1];
    const secondBuffer = loadCalls[1][loadCalls[1].indexOf('-b') + 1];
    expect(firstBuffer).not.toBe(secondBuffer);
  });

  it('deletes the named buffer when paste-buffer fails (cleanup, no leak)', () => {
    const be = new TmuxPipeBackend('0:5.0');
    be.spawn('', [], spawnOpts());
    mockedExecFileSync.mockClear();
    // load-buffer succeeds, paste-buffer throws → the -d delete never runs, so
    // the finally{} must delete the SAME named buffer. guardedSend swallows the
    // failure (pane ALIVE via the default execSync mock) so pasteText must not throw.
    mockedExecFileSync.mockImplementation(((_cmd: string, args?: string[]) => {
      if (Array.isArray(args) && args.includes('paste-buffer')) throw new Error('no server running');
      return '' as any;
    }) as any);

    expect(() => be.pasteText('boom')).not.toThrow();

    const calls = getExecFileCalls().map(call => call[1] as string[]);
    const loadArgs = calls.find(args => args.includes('load-buffer'))!;
    const bufferName = loadArgs[loadArgs.indexOf('-b') + 1];
    const deleteArgs = calls.find(args => args.includes('delete-buffer'));
    expect(deleteArgs).toBeDefined();
    expect(deleteArgs![deleteArgs!.indexOf('-b') + 1]).toBe(bufferName);
  });

  it('write delegates to sendText (literal send-keys)', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecFileSync.mockClear();
    be.write('hi');
    const args = getExecFileCalls()[0][1] as string[];
    expect(args).toContain('-l');  // literal mode
    expect(args).toContain('hi');
  });
});

describe('TmuxPipeBackend.getChildPid', () => {
  it('uses display-message -p (not list-panes) for accurate pane resolution', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockClear();
    mockedExecSync.mockReturnValue('45678\n' as any);
    expect(be.getChildPid()).toBe(45678);
    const cmd = String(mockedExecSync.mock.calls[0][0]);
    expect(cmd).toContain('display-message');
    expect(cmd).toContain('#{pane_pid}');
    expect(cmd).not.toContain('list-panes');
  });
});

describe('TmuxPipeBackend.captureCurrentScreen', () => {
  it('captures with ANSI + full scrollback (-e -p -S -)', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockClear();
    // First call → alternate_on probe (returns '0' = main buffer)
    // Second call → capture-pane payload
    mockedExecSync
      .mockReturnValueOnce('0\n' as any)
      .mockReturnValueOnce('\x1b[1mhello\x1b[0m' as any);
    const out = be.captureCurrentScreen();
    expect(out).toBe('\x1b[1mhello\x1b[0m');
    const captureCall = mockedExecSync.mock.calls.find(c => String(c[0]).includes('capture-pane'));
    expect(captureCall).toBeDefined();
    const cmd = String(captureCall![0]);
    expect(cmd).toContain('-e');
    expect(cmd).toContain('-p');
    expect(cmd).toContain('-S -');
    expect(cmd).toContain("'0:2.0'");
  });

  it('normalises bare \\n to \\r\\n so xterm.js does not staircase', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.from('') as any);
    mockedExecSync
      .mockReturnValueOnce('0\n' as any)  // alternate_on probe
      .mockReturnValueOnce('line1\nline2\nline3\n' as any);
    const out = be.captureCurrentScreen();
    // Each \n must become \r\n; existing \r\n must not be doubled. The web seed
    // also strips the trailing newline (see composeSeedBody) so it doesn't
    // scroll the receiving xterm a row past the content. Cursor query is mocked
    // empty here → no CUP appended.
    expect(out).toBe('line1\r\nline2\r\nline3');
  });

  it('preserves existing \\r\\n untouched', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.from('') as any);
    mockedExecSync
      .mockReturnValueOnce('0\n' as any)
      .mockReturnValueOnce('a\r\nb\nc\r\n' as any);
    // \r\n preserved; trailing newline stripped for the seed.
    expect(be.captureCurrentScreen()).toBe('a\r\nb\r\nc');
  });

  it('prefixes alt-buffer enter sequence when pane is in alt screen', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.from('') as any);
    mockedExecSync
      .mockReturnValueOnce('1\n' as any)        // alternate_on=1 (Claude TUI)
      .mockReturnValueOnce('claude prompt\n' as any);
    const out = be.captureCurrentScreen();
    // Must start with: enter alt buffer + home + clear, then the snapshot
    // (trailing newline stripped for the seed; cursor query mocked empty).
    expect(out.startsWith('\x1b[?1049h\x1b[H\x1b[2J')).toBe(true);
    expect(out.endsWith('claude prompt')).toBe(true);
  });

  it('does NOT prefix alt-buffer enter when pane is on main buffer', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.from('') as any);
    mockedExecSync
      .mockReturnValueOnce('0\n' as any)        // alternate_on=0 (zsh prompt)
      .mockReturnValueOnce('$ ls\n' as any);
    const out = be.captureCurrentScreen();
    expect(out).toBe('$ ls');                   // trailing newline stripped
    expect(out).not.toContain('\x1b[?1049h');
  });

  it('restores the pane cursor (CUP) so the live redraw lands on the right row', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.from('') as any);
    mockedExecSync
      .mockReturnValueOnce('0\n' as any)          // alternate_on=0 (main buffer)
      .mockReturnValueOnce('STATUS\nTIP\nINPUT\n' as any)  // capture-pane
      .mockReturnValueOnce('6 10\n' as any);      // cursor_x=6 cursor_y=10
    const out = be.captureCurrentScreen();
    // Trailing newline stripped, then CUP to (y+1=11, x+1=7).
    expect(out).toBe('STATUS\r\nTIP\r\nINPUT\x1b[11;7H');
  });
});

describe('TmuxPipeBackend.captureViewport', () => {
  it('uses no `-S`/`-E` flags so tmux returns viewport-only', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.from('') as any);
    mockedExecSync
      .mockReturnValueOnce('0\n' as any)
      .mockReturnValueOnce('viewport line\n' as any);
    const out = be.captureViewport();
    expect(out).toBe('viewport line\r\n');
    const captureCall = mockedExecSync.mock.calls.find(c => String(c[0]).includes('capture-pane'));
    expect(captureCall).toBeDefined();
    const cmd = String(captureCall![0]);
    expect(cmd).toContain('-e');
    expect(cmd).toContain('-p');
    // Critically, no `-S` flag — otherwise -S -N pulls N scrollback rows
    // on top of the viewport (tmux semantics) and the transient terminal
    // ends up scrolled past the bottom.
    expect(cmd).not.toContain('-S');
    expect(cmd).not.toContain('-E');
  });

  it('still applies alt-buffer prefix when pane is in alt screen', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue(Buffer.from('') as any);
    mockedExecSync
      .mockReturnValueOnce('1\n' as any)
      .mockReturnValueOnce('claude tui\n' as any);
    const out = be.captureViewport();
    expect(out.startsWith('\x1b[?1049h\x1b[H\x1b[2J')).toBe(true);
    expect(out).toContain('claude tui\r\n');
  });
});

describe('TmuxPipeBackend.getPaneSize', () => {
  it('parses `#{pane_width} #{pane_height}` into {cols, rows}', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue('200 60\n' as any);
    const size = be.getPaneSize();
    expect(size).toEqual({ cols: 200, rows: 60 });
    const cmd = String(mockedExecSync.mock.calls[0][0]);
    expect(cmd).toContain('display-message');
    expect(cmd).toContain("'#{pane_width} #{pane_height}'");
  });

  it('returns null when tmux errors (pane gone, server gone)', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockImplementation(() => { throw new Error('no server'); });
    expect(be.getPaneSize()).toBeNull();
  });

  it('returns null on malformed output (NaN width/height)', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    mockedExecSync.mockReset();
    mockedExecSync.mockReturnValue('abc def\n' as any);
    expect(be.getPaneSize()).toBeNull();
  });

  it('returns null after exited', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    be.kill();
    expect(be.getPaneSize()).toBeNull();
  });
});

describe('normaliseCaptureLineEndings', () => {
  it('handles mixed line endings idempotently', () => {
    expect(normaliseCaptureLineEndings('a\nb')).toBe('a\r\nb');
    expect(normaliseCaptureLineEndings('a\r\nb')).toBe('a\r\nb');
    expect(normaliseCaptureLineEndings('\n\n\n')).toBe('\r\n\r\n\r\n');
    expect(normaliseCaptureLineEndings('')).toBe('');
  });
});

describe('TmuxPipeBackend managed session', () => {
  it('creates detached session and applies botmux tmux options', () => {
    const be = new TmuxPipeBackend('bmx-owned', { createSession: true, ownsSession: true });
    be.spawn('/bin/echo', ['hello'], spawnOpts());

    const newSessionCall = mockedExecFileSync.mock.calls.find(call => {
      const args = call[1] as string[];
      return args.includes('new-session');
    });
    expect(newSessionCall).toBeDefined();
    expect(newSessionCall![1]).toContain('-d');
    expect(newSessionCall![1]).toContain('bmx-owned');

    const optionCalls = mockedExecSync.mock.calls.map(c => String(c[0]));
    expect(optionCalls.some(c => c.includes('set-option') && c.includes('status on'))).toBe(true);
    expect(optionCalls.some(c => c.includes('set-option') && c.includes('mouse on'))).toBe(true);
    expect(optionCalls.some(c => c.includes('set-option') && c.includes('history-limit 50000'))).toBe(true);
    expect(optionCalls.some(c => c.includes('set-option') && c.includes('window-size largest'))).toBe(true);
    expect(optionCalls.some(c => c.includes('set-option -s set-clipboard on'))).toBe(true);
  });

  it('resizes owned tmux sessions and only records adopted pane resize', () => {
    const owned = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
    owned.resize(120, 40);
    expect(mockedExecFileSync).toHaveBeenCalledWith('tmux', ['resize-window', '-t', 'bmx-owned', '-x', '120', '-y', '40'], expect.any(Object));

    mockedExecFileSync.mockClear();
    const adopted = new TmuxPipeBackend('0:2.0');
    adopted.resize(100, 30);
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });
});

describe('TmuxPipeBackend lifecycle watcher', () => {
  const isPaneProbe = (args: any) =>
    Array.isArray(args) && args.includes('display-message') && args.includes('#{pane_id}');
  const PANE_OK = (_bin: any, args: any) => isPaneProbe(args) ? '%1\n' as any : '' as any;
  const PANE_GONE = (_bin: any, args: any) => {
    if (isPaneProbe(args)) throw Object.assign(new Error('no pane'), { status: 1, signal: null });
    return '' as any;
  };

  it('fires exit when the tmux pane disappears — but only after 3 consecutive failures', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      mockedExecFileSync.mockImplementation(PANE_OK);
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());
      mockedExecFileSync.mockImplementation(PANE_GONE);

      // Two failed probes are NOT enough — the debounce gate must ride them out.
      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 1_000);
      expect(exits).toEqual([]);

      // 3rd consecutive failure trips the gate; the final lenient confirm also
      // fails ⇒ now we detach.
      vi.advanceTimersByTime(1_000);
      expect(exits).toEqual([[1, null]]);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  it('treats an empty pane id as a failure (debounced the same way)', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      mockedExecFileSync.mockImplementation(PANE_OK);
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());
      mockedExecFileSync.mockImplementation((_bin: any, args: any) => isPaneProbe(args) ? '\n' as any : '' as any);

      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 1_000);
      expect(exits).toEqual([]);
      vi.advanceTimersByTime(1_000);
      expect(exits).toEqual([[1, null]]);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  it('does NOT detach on a single transient probe failure that then recovers', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      mockedExecFileSync.mockImplementation(PANE_OK);
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());

      // One failure, then sustained success — the false signal must be ignored.
      mockedExecFileSync.mockImplementation(PANE_GONE);
      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned'));
      mockedExecFileSync.mockImplementation(PANE_OK);
      vi.advanceTimersByTime(10_000);

      expect(exits).toEqual([]);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  it('resets the failure counter on an intervening success (never 3-in-a-row)', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      mockedExecFileSync.mockImplementation(PANE_OK);
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());

      mockedExecFileSync.mockImplementation(PANE_GONE);
      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 1_000); // 2 failures
      mockedExecFileSync.mockImplementation(PANE_OK);
      vi.advanceTimersByTime(1_000);          // success → reset
      mockedExecFileSync.mockImplementation(PANE_GONE);
      vi.advanceTimersByTime(2_000);          // 2 more failures (gate back to 2)

      expect(exits).toEqual([]);              // never reached 3 consecutive
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  it('stays attached when the final lenient confirm probe succeeds', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      let paneIdCalls = 0;
      mockedExecFileSync.mockImplementation((_bin: any, args: any) => {
        if (isPaneProbe(args)) {
          paneIdCalls += 1;
          if (paneIdCalls <= 3) {
            throw Object.assign(new Error('no pane'), { status: 1, signal: null });
          }
          return '%1\n' as any;
        }
        return '' as any;
      });
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());

      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 2_000);
      expect(exits).toEqual([]);              // recovered on the confirm, no detach
      expect(paneIdCalls).toBe(4);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  it('never detaches when tmux probes time out or fail to spawn (unknown, not missing)', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());
      mockedExecFileSync.mockImplementation((_bin: any, args: any) => {
        if (isPaneProbe(args)) {
          throw Object.assign(new Error('spawn tmux EMFILE'), { code: 'EMFILE', status: null, signal: null });
        }
        return '' as any;
      });

      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 10_000);
      expect(exits).toEqual([]);
      expect(errSpy.mock.calls.some(call => String(call[0]).includes('keeping managed session attached'))).toBe(true);
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });

  it('fires exit IMMEDIATELY when the adopted CLI pid disappears (pid is decisive, not debounced)', () => {
    // The pid check is a pure process.kill(pid,0) syscall — it can only report
    // ESRCH/EPERM, never a transient timeout — so it must NOT be debounced:
    // delaying teardown would route Lark input into the user's bare shell.
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | 0) => {
      if (pid === 4242 && signal === 0) {
        const err: NodeJS.ErrnoException = new Error('gone');
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    }) as typeof process.kill);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      mockedExecFileSync.mockImplementation(PANE_OK);
      const be = new TmuxPipeBackend('0:2.0', { cliPid: 4242 });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());
      mockedExecSync.mockClear();

      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('0:2.0'));
      expect(exits).toEqual([[1, null]]);

      const cancelCall = mockedExecSync.mock.calls
        .map(c => String(c[0]))
        .find(c => c.includes('pipe-pane'));
      expect(cancelCall).toBeDefined();
      expect(cancelCall).toContain("'0:2.0'");
      expect(cancelCall).not.toContain('cat >');
    } finally {
      errSpy.mockRestore();
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('kill() during a pending (sub-threshold) failure streak stops the watcher cleanly', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      mockedExecFileSync.mockImplementation(PANE_OK);
      const be = new TmuxPipeBackend('bmx-owned', { ownsSession: true });
      const exits: Array<[number | null, string | null]> = [];
      be.onExit((code, signal) => exits.push([code, signal]));
      be.spawn('', [], spawnOpts());

      mockedExecFileSync.mockImplementation(PANE_GONE);
      vi.advanceTimersByTime(tmuxLifecycleInitialDelayMs('bmx-owned') + 1_000);
      expect(exits).toEqual([]);

      be.kill();                              // explicit close mid-streak
      mockedExecFileSync.mockClear();
      vi.advanceTimersByTime(10_000);         // watcher must be stopped

      expect(exits).toEqual([]);              // kill() does not fire onExit
      const probeAfterKill = mockedExecFileSync.mock.calls
        .some(c => (c[1] as string[]).includes('display-message'));
      expect(probeAfterKill).toBe(false);     // no further probing after kill
    } finally {
      vi.useRealTimers();
      errSpy.mockRestore();
    }
  });
});

describe('TmuxPipeBackend send failure handling', () => {
  // Regression: a CLI that exits mid-write destroys its tmux session, so the
  // next `tmux send-keys` returns exit 1. Previously execFileSync's throw
  // propagated through writeInput → flushPending (fire-and-forget async) →
  // unhandledRejection and killed the whole worker. The send methods must
  // never throw: pane-gone is converted to a normal onExit, a transient
  // failure on a live pane is logged and dropped.
  it('fires onExit (does NOT throw) when send-keys fails and the pane is gone', () => {
    const be = new TmuxPipeBackend('bmx-dead', { ownsSession: true });
    const exits: Array<[number | null, string | null]> = [];
    be.onExit((c, s) => exits.push([c, s]));
    be.spawn('', [], spawnOpts());

    // The actual send-keys (execFileSync) fails…
    mockedExecFileSync.mockImplementation((_bin: any, args: any) => {
      if ((args as string[]).includes('send-keys')) throw new Error('no server running');
      return '' as any;
    });
    // …and the liveness probe (execSync display-message) also fails ⇒ pane GONE.
    mockedExecSync.mockImplementation(() => { throw new Error('no server running'); });

    expect(() => be.sendSpecialKeys('Enter')).not.toThrow();
    expect(exits).toEqual([[1, null]]);
  });

  it('drops the write (no throw, no exit) when send-keys fails but the pane is alive', () => {
    const be = new TmuxPipeBackend('bmx-live', { ownsSession: true });
    const exits: Array<[number | null, string | null]> = [];
    be.onExit((c, s) => exits.push([c, s]));
    be.spawn('', [], spawnOpts());

    mockedExecFileSync.mockImplementation((_bin: any, args: any) => {
      if ((args as string[]).includes('send-keys')) throw new Error('transient tmux error');
      if ((args as string[]).includes('#{pane_id}')) return '%1\n' as any;
      return '' as any;
    });
    // Liveness probe succeeds ⇒ pane ALIVE ⇒ transient error, just dropped.

    expect(() => be.sendText('hi')).not.toThrow();
    expect(exits).toEqual([]);
  });

  it('drops the write without teardown when the follow-up pane probe is unknown', () => {
    const be = new TmuxPipeBackend('bmx-busy', { ownsSession: true });
    const exits: Array<[number | null, string | null]> = [];
    be.onExit((c, s) => exits.push([c, s]));
    be.spawn('', [], spawnOpts());

    mockedExecFileSync.mockImplementation((_bin: any, args: any) => {
      if ((args as string[]).includes('send-keys')) throw new Error('tmux write timed out');
      if ((args as string[]).includes('#{pane_id}')) {
        throw Object.assign(new Error('spawn tmux EMFILE'), { code: 'EMFILE', status: null, signal: null });
      }
      return '' as any;
    });

    expect(() => be.sendText('hi')).not.toThrow();
    expect(exits).toEqual([]);
  });

  it('dumps the piped output tail (CLI final stdout/stderr) when the pane is gone', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const be = new TmuxPipeBackend('bmx-dead3', { ownsSession: true });
      be.spawn('', [], spawnOpts());
      // Drive the fifo data handler so recentOutput holds the CLI's last bytes.
      const stream: any = vi.mocked(createReadStream).mock.results.at(-1)!.value;
      stream.emit('data', Buffer.from('Error: gateway 502 — model unavailable\n'));

      mockedExecFileSync.mockImplementation((_bin: any, args: any) => {
        if ((args as string[]).includes('send-keys')) throw new Error('no server running');
        return '' as any;
      });
      mockedExecSync.mockImplementation(() => { throw new Error('no server running'); });

      be.sendSpecialKeys('Enter');

      const dumped = errSpy.mock.calls.map(c => String(c[0])).join('');
      expect(dumped).toContain('CLI last output before exit');
      expect(dumped).toContain('gateway 502 — model unavailable');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('paste failure with a gone pane fires onExit instead of throwing', () => {
    const be = new TmuxPipeBackend('bmx-dead2', { ownsSession: true });
    const exits: Array<[number | null, string | null]> = [];
    be.onExit((c, s) => exits.push([c, s]));
    be.spawn('', [], spawnOpts());

    mockedExecFileSync.mockImplementation((_bin: any, args: any) => {
      if ((args as string[]).includes('load-buffer') || (args as string[]).includes('paste-buffer')) {
        throw new Error('no server running');
      }
      return '' as any;
    });
    mockedExecSync.mockImplementation(() => { throw new Error('no server running'); });

    expect(() => be.pasteText('hello')).not.toThrow();
    expect(exits).toEqual([[1, null]]);
  });
});

describe('TmuxPipeBackend.kill', () => {
  it('cancels pipe-pane subscription and unlinks the fifo without firing onExit', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    let exitFired = false;
    be.onExit(() => { exitFired = true; });

    mockedExecSync.mockClear();
    be.kill();

    // The cancellation call: pipe-pane WITHOUT a shell command argument.
    const pipeCall = mockedExecSync.mock.calls
      .map(c => String(c[0]))
      .find(c => c.includes('pipe-pane'));
    expect(pipeCall).toBeDefined();
    expect(pipeCall).not.toContain('cat >');  // no command = cancel
    expect(pipeCall).toContain("'0:2.0'");

    expect(mockedUnlinkSync).toHaveBeenCalledWith(expect.stringMatching(/botmux-pipe-.*\.fifo/));
    expect(exitFired).toBe(false);
  });

  it('is idempotent (second kill is a no-op)', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    be.kill();
    mockedExecSync.mockClear();
    mockedUnlinkSync.mockClear();
    be.kill();
    expect(mockedExecSync).not.toHaveBeenCalled();
    expect(mockedUnlinkSync).not.toHaveBeenCalled();
  });

  it('post-kill writes are silently dropped', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    be.kill();
    mockedExecFileSync.mockClear();
    be.sendText('after-kill');
    be.sendSpecialKeys('Enter');
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });
});

describe('TmuxPipeBackend.onData', () => {
  function lastStream() {
    return vi.mocked(createReadStream).mock.results.at(-1)!.value as any;
  }

  it('forwards a whole fifo chunk to registered listeners', () => {
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    const received: string[] = [];
    be.onData(d => received.push(d));

    lastStream().emit('data', Buffer.from('hello 你好\n', 'utf8'));
    expect(received).toEqual(['hello 你好\n']);
  });

  it('reassembles a multi-byte char split across two chunks (no U+FFFD)', () => {
    // Regression: the fifo emits raw Buffers at libuv's 64KB highWaterMark,
    // which can fall mid-character. Decoding each chunk independently with
    // chunk.toString('utf8') split one wide glyph into replacement chars and
    // shifted every following column — the intermittent web-terminal "错位"
    // during CLI re-renders. StringDecoder must buffer the partial bytes.
    const be = new TmuxPipeBackend('0:2.0');
    be.spawn('', [], spawnOpts());
    const received: string[] = [];
    be.onData(d => received.push(d));

    // `┌`(0xE2 0x94 0x8C) and `─`(0xE2 0x94 0x80) are 3 bytes each. Cut one
    // byte into `─` so that character straddles the chunk boundary, exactly
    // like a 64KB split during a full-screen redraw.
    const full = Buffer.from('┌─┐', 'utf8');
    const stream = lastStream();
    stream.emit('data', full.subarray(0, 4)); // `┌` + first byte of `─`
    stream.emit('data', full.subarray(4));    // remaining bytes of `─` + `┐`

    const joined = received.join('');
    expect(joined).toBe('┌─┐');
    expect(joined).not.toContain('�');
  });
});
