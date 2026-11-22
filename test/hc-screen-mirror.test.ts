import { describe, expect, it } from 'vitest';
import { HC_MIRROR_SCROLLBACK_LINES, ScreenMirror } from '../src/adapters/backend/hc/screen-mirror.js';
import { composeSeedBody, normaliseCaptureLineEndings, paneInputModeSeed } from '../src/adapters/backend/tmux-pipe-backend.js';
import { makeTerminal, visibleState, writeAll } from './helpers/xterm-cells.js';

const lines = (from: number, to: number, fmt: (i: number) => string = i => `line ${i}`): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => fmt(from + i));

const FIXTURES: Array<[string, string]> = [
  ['colours and attributes', '\x1b[1;31mbold red\x1b[0m \x1b[38;5;208m256\x1b[0m \x1b[38;2;10;200;30;48;2;0;0;80mrgb\x1b[0m\r\n\x1b[3;4;9mmixed\x1b[0m'],
  ['wide characters', '中文 😀 ✅\r\n\x1b[32m漢字\x1b[0m end\r\n' + 'x'.repeat(19) + '宽'],
  ['scrollback', lines(0, 120, i => `\x1b[3${i % 8}mrow ${i}\x1b[0m ${'#'.repeat(i % 17)}`).join('\r\n')],
  ['a screen cleared mid-stream', `${lines(0, 9).join('\r\n')}\x1b[H\x1b[2Jafter clear\r\nsecond`],
  ['the alternate screen', `${lines(0, 30).join('\r\n')}\x1b[?1049h\x1b[H\x1b[44malt\x1b[0m\x1b[4;3H中文 alt\x1b[2;7H`],
  ['a cursor parked mid-screen', `${lines(0, 3).join('\r\n')}\x1b[2;5H`],
];

describe('ScreenMirror captures', () => {
  it('reflects a write in a capture taken right after it', () => {
    const mirror = new ScreenMirror({ cols: 20, rows: 4 });
    mirror.write('hello');
    expect(mirror.viewportText().split('\n')[0]).toBe('hello');
    expect(mirror.captureInputState().cursor).toEqual({ x: 5, y: 0 });

    const wide = Buffer.from(' 中', 'utf8');
    mirror.write(wide.subarray(0, 2));
    mirror.write(wide.subarray(2));
    expect(mirror.viewportText().split('\n')[0]).toBe('hello 中');

    const bulk = lines(0, 20_000).join('\r\n');
    mirror.write(bulk);
    expect(mirror.viewportText().split('\n')[3]).toBe('line 20000');
    const kept = mirror.captureCurrentScreen().split('\r\n');
    expect(kept[0]).toBe(`line ${20_000 - 3 - HC_MIRROR_SCROLLBACK_LINES}`);
    expect(kept).toHaveLength(HC_MIRROR_SCROLLBACK_LINES + 4);
  });

  it.each(FIXTURES)('captureCurrentScreen replays to the same screen, history and cursor: %s', async (_name, input) => {
    const mirror = new ScreenMirror({ cols: 20, rows: 6 });
    mirror.write(input);
    const reference = makeTerminal(20, 6);
    await writeAll(reference, input);
    const replay = makeTerminal(20, 6);
    await writeAll(replay, mirror.captureCurrentScreen());
    expect(visibleState(replay)).toEqual(visibleState(reference));
  });

  it.each(FIXTURES)('captureViewport holds the same visible rows: %s', async (_name, input) => {
    const mirror = new ScreenMirror({ cols: 20, rows: 6 });
    mirror.write(input);
    const reference = makeTerminal(20, 6);
    await writeAll(reference, input);
    const { cols, rows } = mirror.size();
    const replay = makeTerminal(cols, rows);
    await writeAll(replay, mirror.captureViewport().replace(/\r\n$/, ''));
    expect(visibleState(replay).rows).toEqual(visibleState(reference).rows);
    expect(replay.buffer.active.type).toBe(reference.buffer.active.type);
  });

  it('captureViewport is the visible rows only, each CRLF-terminated, with no cursor', () => {
    const mirror = new ScreenMirror({ cols: 20, rows: 4 });
    mirror.write(lines(0, 9).join('\r\n'));
    expect(mirror.captureViewport()).toBe(normaliseCaptureLineEndings(`${lines(6, 9).join('\n')}\n`));
  });

  it('captureCurrentScreen is the whole history with the cursor in place of the last line end', () => {
    const mirror = new ScreenMirror({ cols: 20, rows: 4 });
    mirror.write(lines(0, 9).join('\r\n'));
    expect(mirror.captureCurrentScreen())
      .toBe(composeSeedBody(normaliseCaptureLineEndings(`${lines(0, 9).join('\n')}\n`), { x: 6, y: 3 }));
  });

  it('on the alternate screen captures the main history then the alternate rows, not the saved main rows', async () => {
    const mirror = new ScreenMirror({ cols: 20, rows: 4 });
    mirror.write(`${lines(0, 9).join('\r\n')}\r\n\x1b[?1049h\x1b[Halt screen`);
    expect(mirror.altScreen).toBe(true);
    const screen = mirror.captureCurrentScreen();
    expect(screen).toContain('line 6\r\n');
    expect(screen).not.toContain('line 7');
    expect(screen.indexOf('line 6')).toBeLessThan(screen.indexOf('alt screen'));
    const replay = makeTerminal(20, 4);
    await writeAll(replay, screen);
    expect(replay.buffer.active.type).toBe('alternate');
    expect(mirror.captureViewport()).not.toContain('line');
  });

  it('captureInputState is the plain viewport, LF-terminated rows, and the cursor', () => {
    const mirror = new ScreenMirror({ cols: 10, rows: 3 });
    mirror.write('\x1b[31m中a\x1b[0m  \r\nb');
    const state = mirror.captureInputState();
    expect(state).toEqual({ viewport: '中a\nb\n\n', cursor: { x: 1, y: 1 } });
    expect(mirror.viewportText()).toBe(state.viewport);
  });

  it('keeps a bounded history', () => {
    const mirror = new ScreenMirror({ cols: 20, rows: 5, scrollback: 50 });
    mirror.write(lines(0, 199).join('\r\n'));
    const rows = mirror.captureCurrentScreen().split('\r\n');
    expect(rows).toHaveLength(55);
    expect(rows[0]).toBe('line 145');
  });

  it('pushes a cleared screen into history like tmux scroll-on-clear', () => {
    const mirror = new ScreenMirror({ cols: 20, rows: 4 });
    mirror.write('one\r\ntwo\x1b[H\x1b[2Jthree');
    expect(mirror.captureCurrentScreen()).toMatch(/^one\r\ntwo\r\nthree/);
    expect(mirror.viewportText()).toBe('three\n\n\n\n');
  });
});

describe('ScreenMirror paints', () => {
  it('does not push the screen a paint replaces into history', () => {
    const mirror = new ScreenMirror({ cols: 20, rows: 3 });
    const captured = (): string[] => mirror.captureCurrentScreen().replace(/\x1b\[\d+;\d+H$/, '').split('\r\n').filter(r => r.startsWith('line'));
    mirror.write(lines(0, 4).join('\r\n'));
    mirror.writePaint('\x18\x1b[!p\x1b[?2026l\x1b[?1049l\x1b[H\x1b[2Jline 2\r\nline 3\r\nline 4\x1b[?9001l');
    expect(captured()).toEqual(lines(0, 4));
    mirror.write('\x1b[H\x1b[2J');
    expect(captured()).toEqual(lines(0, 4));
    expect(mirror.viewportText()).toBe('\n\n\n');
  });

  it('rebuilds history, screen and modes from an attach paint on a fresh mirror', () => {
    const mirror = new ScreenMirror({ cols: 20, rows: 3 });
    const paint = '\x18\x1b[!p\x1b[?2026l\x1b[?1l\x1b[?2004l\x1b[?1049l\x1b[H\x1b[2J'
      + 'old 1\r\nold 2\x1b[0m\r\n\n\n\n\x1b[H\x1b[2J'
      + 'now 1\r\nnow 2\x1b[?1h\x1b[?2004h\x1b[2;6H\x1b]2;title\x1b\\\x1b[?9001l';
    mirror.writePaint(paint);
    const rows = mirror.captureCurrentScreen().split('\r\n');
    expect(rows.slice(0, 2)).toEqual(['old 1', 'old 2']);
    expect(rows.filter(r => r.startsWith('old'))).toHaveLength(2);
    expect(mirror.viewportText()).toBe('now 1\nnow 2\n\n');
    expect(mirror.captureInputState().cursor).toEqual({ x: 5, y: 1 });
    expect(mirror.applicationCursorKeys).toBe(true);
    expect(mirror.bracketedPaste).toBe(true);
  });
});

describe('ScreenMirror modes', () => {
  it.each([
    ['\x1b[?1000h', { mouseStandard: true }],
    ['\x1b[?1002h', { mouseButton: true }],
    ['\x1b[?1003h', { mouseAll: true }],
    ['\x1b[?1003h\x1b[?1006h', { mouseAll: true, mouseSgr: true }],
    ['\x1b[?1016h', {}],
    ['\x1b[?9h', {}],
    ['\x1b[?1h', { appCursorKeys: true }],
    ['\x1b=', { appKeypad: true }],
    ['\x1b[?25l', { cursorVisible: false }],
  ])('reports %j like tmux pane flags', (seq, flags) => {
    const mirror = new ScreenMirror({ cols: 10, rows: 2 });
    mirror.write(seq);
    const expected = {
      mouseStandard: false, mouseButton: false, mouseAll: false, mouseSgr: false,
      appCursorKeys: false, appKeypad: false, cursorVisible: true, ...flags,
    };
    expect(mirror.inputModes()).toEqual(expected);
    expect(mirror.capturePaneInputModes()).toBe(paneInputModeSeed(expected));
  });

  it('has no mode seed for a terminal in its default modes', () => {
    expect(new ScreenMirror({ cols: 10, rows: 2 }).capturePaneInputModes()).toBe('');
  });

  it('tracks DECCKM and bracketed paste', () => {
    const mirror = new ScreenMirror({ cols: 10, rows: 2 });
    expect([mirror.applicationCursorKeys, mirror.bracketedPaste]).toEqual([false, false]);
    mirror.write('\x1b[?1h\x1b[?2004h');
    expect([mirror.applicationCursorKeys, mirror.bracketedPaste]).toEqual([true, true]);
    mirror.write('\x1b[?1l\x1b[?2004l');
    expect([mirror.applicationCursorKeys, mirror.bracketedPaste]).toEqual([false, false]);
  });
});

describe('ScreenMirror lifecycle', () => {
  it('reset drops screen, history and modes but keeps the size', () => {
    const mirror = new ScreenMirror({ cols: 30, rows: 4 });
    mirror.write(`${lines(0, 9).join('\r\n')}\x1b[?1h\x1b[?2004h\x1b[?1000h`);
    mirror.reset();
    expect(mirror.size()).toEqual({ cols: 30, rows: 4 });
    expect(mirror.captureCurrentScreen()).toBe(composeSeedBody('\r\n\r\n\r\n\r\n', { x: 0, y: 0 }));
    expect([mirror.applicationCursorKeys, mirror.bracketedPaste]).toEqual([false, false]);
    expect(mirror.capturePaneInputModes()).toBe('');
  });

  it('resize changes the size every capture reports', () => {
    const mirror = new ScreenMirror({ cols: 20, rows: 4 });
    mirror.write('abc');
    mirror.resize(40, 6);
    expect(mirror.size()).toEqual({ cols: 40, rows: 6 });
    expect([mirror.cols, mirror.rows]).toEqual([40, 6]);
    expect(mirror.captureViewport().split('\r\n')).toHaveLength(7);
    expect(mirror.captureInputState().viewport.split('\n')).toHaveLength(7);
  });
});
