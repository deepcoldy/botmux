import { describe, it, expect } from 'vitest';
import { OutputRing, TerminalModeTracker, incompleteTailStart } from '../src/dashboard/host-terminal-replay.js';
import {
  clampTerminalSize,
  hostTerminalTargetKey,
  parseClientControl,
  parseHostTerminalTarget,
} from '../src/dashboard/host-terminal-protocol.js';
import { ctrlChord, hostTerminalKeyBytes } from '../src/dashboard/web/host-terminal-keys.js';

const b = (s: string) => Buffer.from(s, 'latin1');

describe('TerminalModeTracker', () => {
  it('tracks alt screen, mouse, bracketed paste and keypad; restore emits the live state', () => {
    const t = new TerminalModeTracker();
    t.feed(b('hello\x1b[?1049h\x1b[?1000;1006h\x1b[?2004h\x1b[?25l\x1b='));
    expect(t.altScreen).toBe(true);
    const seq = t.restoreSequence();
    expect(seq.startsWith('\x1b[?1047h')).toBe(true);
    expect(seq).toContain('\x1b[?1;25;1004l');
    expect(seq).toContain('\x1b[?7;2004h');
    expect(seq).toContain('\x1b[?9;1000;1002;1003l\x1b[?1000h');
    expect(seq).toContain('\x1b[?1006;1016l\x1b[?1006h');
    expect(seq.endsWith('\x1b=')).toBe(true);
  });

  it('tracks the mouse protocol as one exclusive state, like xterm does', () => {
    const t = new TerminalModeTracker();
    t.feed(b('\x1b[?1003h\x1b[?1000h'));
    expect(t.mouseTracking).toBe(1000);
    // 恢复序列只打开当前协议，不会把 1003 一起打开（那会变成 any-event 上报）。
    expect(t.restoreSequence()).toContain('\x1b[?9;1000;1002;1003l\x1b[?1000h');
    expect(t.restoreSequence()).not.toContain('1003h');
    // reset 任何一个协议都回到「不上报」。
    t.feed(b('\x1b[?1000h\x1b[?1002h\x1b[?1002l'));
    expect(t.mouseTracking).toBe(0);
    expect(t.restoreSequence()).not.toMatch(/\x1b\[\?(9|1000|1002|1003)h/);
  });

  it('never emits an alt-screen reset: in xterm that is DECRC, which would yank the cursor', () => {
    const t = new TerminalModeTracker();
    t.feed(b('\x1b[?1049h vim \x1b[?1049l$ '));
    expect(t.altScreen).toBe(false);
    expect(t.restoreSequence()).not.toMatch(/\x1b\[\?(1049|1047|47)[lh]/);
  });

  it('parses sequences split across chunks', () => {
    const t = new TerminalModeTracker();
    t.feed(b('abc\x1b[?10'));
    t.feed(b('49h tail'));
    expect(t.altScreen).toBe(true);
    t.feed(b('\x1b'));
    t.feed(b('[?1049l'));
    expect(t.altScreen).toBe(false);
  });

  it('can start tracking from inside the alternate screen', () => {
    const t = new TerminalModeTracker(true);
    expect(t.altScreen).toBe(true);
    t.feed(b('\x1b[?1049l'));
    expect(t.altScreen).toBe(false);
  });

  it('keeps automatic wrap off after tput rmam so a truncated replay does not re-enable it', () => {
    const t = new TerminalModeTracker();
    t.feed(b('\x1b[?7l'));
    expect(t.isOn(7)).toBe(false);
    expect(t.restoreSequence()).toMatch(/\x1b\[\?[\d;]*\b7\b[\d;]*l/);
    t.feed(b('\x1bc'));
    expect(t.isOn(7)).toBe(true);
  });

  it('DECSTR soft reset turns the input modes back off but keeps mouse / alt screen', () => {
    const t = new TerminalModeTracker();
    t.feed(b('\x1b[?1h\x1b[?2004h\x1b[?25l\x1b=\x1b[?1000h\x1b[?1049h'));
    t.feed(b('\x1b[!p'));
    expect(t.isOn(1)).toBe(false);
    expect(t.isOn(2004)).toBe(false);
    expect(t.isOn(25)).toBe(true);
    expect(t.restoreSequence().endsWith('\x1b>')).toBe(true);
    expect(t.mouseTracking).toBe(1000);
    expect(t.altScreen).toBe(true);
  });

  it('RIS resets everything back to defaults', () => {
    const t = new TerminalModeTracker();
    t.feed(b('\x1b[?1049h\x1b[?2004h\x1b[?25l'));
    t.feed(b('\x1bc'));
    expect(t.altScreen).toBe(false);
    expect(t.isOn(2004)).toBe(false);
    expect(t.isOn(25)).toBe(true);
  });

  it('ignores ordinary CSI / SGR traffic', () => {
    const t = new TerminalModeTracker();
    t.feed(b('\x1b[31mred\x1b[0m \x1b[2J\x1b[H\x1b]0;title\x07'));
    expect(t.altScreen).toBe(false);
    expect(t.isOn(1000)).toBe(false);
  });
});

describe('incompleteTailStart', () => {
  const u = (s: string) => Buffer.from(s, 'utf8');
  it('is the buffer length when the stream ends cleanly', () => {
    for (const s of ['plain text\r\n', 'x\x1b[31m', '\x1b]0;title\x07', '\x1b]8;;http://a\x1b\\', '\x1b(B', '你好']) {
      expect(incompleteTailStart(u(s)), JSON.stringify(s)).toBe(u(s).length);
    }
  });

  it('points at the start of an unfinished escape sequence', () => {
    expect(incompleteTailStart(u('abc\x1b[?2004'))).toBe(3);
    expect(incompleteTailStart(u('abc\x1b'))).toBe(3);
    expect(incompleteTailStart(u('abc\x1b]0;half a title'))).toBe(3);
    expect(incompleteTailStart(u('abc\x1b('))).toBe(3);
    expect(incompleteTailStart(u('abc\x1bP1$r'))).toBe(3);
  });

  it('points at the lead byte of a truncated UTF-8 character', () => {
    const full = u('ab你');
    expect(incompleteTailStart(full.subarray(0, full.length - 1))).toBe(2);
    expect(incompleteTailStart(full.subarray(0, full.length - 2))).toBe(2);
  });
});

describe('OutputRing', () => {
  it('keeps everything while under capacity', () => {
    const r = new OutputRing(1024);
    r.push(b('one\r\n'));
    r.push(b('two\r\n'));
    expect(r.snapshot().bytes.toString()).toBe('one\r\ntwo\r\n');
    expect(r.snapshot().altAtStart).toBe(false);
  });

  it('reports the alternate-screen state at the head once the switch was evicted', () => {
    const r = new OutputRing(64 * 1024);
    // 全屏程序很早就切进了备用屏，之后的输出把那条 ?1049h 挤出了环形缓冲。
    r.push(b('$ htop\r\n\x1b[?1049h'), false);
    r.push(b('x'.repeat(40 * 1024)), true);
    r.push(b('y'.repeat(40 * 1024)), true);
    const snap = r.snapshot();
    expect(snap.bytes.includes(b('\x1b[?1049h'))).toBe(false);
    expect(snap.altAtStart).toBe(true);
  });

  it('restores an alt-screen switch that was split across frames once the first half is evicted', () => {
    const r = new OutputRing(40 * 1024);
    const t = new TerminalModeTracker();
    const pushRaw = (s: string) => {
      const buf = b(s);
      const alt = t.altScreen;
      const carry = t.pendingSequence();
      t.feed(buf);
      r.push(buf, alt, carry);
    };
    pushRaw('z'.repeat(20 * 1024) + '\x1b[?10');
    pushRaw('49h' + 'tui'.repeat(5000));
    pushRaw('x'.repeat(20 * 1024));
    const snap = r.snapshot();
    // 第一块被挤出后，切屏序列的前半截随第二块一起补回，重放开头就是完整的 ?1049h。
    expect(snap.bytes.subarray(0, 8).toString('latin1')).toBe('\x1b[?1049h');
    expect(snap.altAtStart).toBe(false);
    const replayed = new TerminalModeTracker(snap.altAtStart);
    replayed.feed(snap.bytes);
    expect(replayed.altScreen).toBe(true);
  });

  it('tracks the alt state across the line-boundary trim and a single oversized frame', () => {
    const r = new OutputRing(100);
    r.push(b('\x1b[?1049h' + 'z'.repeat(200) + '\n' + 'w'.repeat(50)), false);
    const snap = r.snapshot();
    expect(snap.altAtStart).toBe(true);
    expect(snap.bytes.length).toBeLessThanOrEqual(100);
  });

  it('drops whole chunks from the head and starts the replay on a line boundary', () => {
    const r = new OutputRing(100);
    r.push(b('x'.repeat(20 * 1024)));
    r.push(b('partial-line\nkept-1\n' + 'y'.repeat(60)));
    const snap = r.snapshot().bytes.toString();
    expect(snap.startsWith('kept-1\n')).toBe(true);
    expect(r.bytes).toBeLessThanOrEqual(100);
  });

  it('copies frames instead of pinning the caller buffer', () => {
    const r = new OutputRing(1024);
    const big = Buffer.alloc(64 * 1024, 0x61);
    r.push(big.subarray(0, 3));
    big.fill(0x62);
    expect(r.snapshot().bytes.toString()).toBe('aaa');
  });
});

describe('host-terminal protocol', () => {
  it('accepts shell / tmux / herdr targets and rejects option-looking names', () => {
    expect(parseHostTerminalTarget({ kind: 'shell' })).toEqual({ kind: 'shell' });
    expect(parseHostTerminalTarget({ kind: 'tmux', session: 'work' })).toEqual({ kind: 'tmux', session: 'work' });
    expect(parseHostTerminalTarget({ kind: 'herdr', session: '中文 session' })).toEqual({ kind: 'herdr', session: '中文 session' });
    expect(parseHostTerminalTarget({ kind: 'tmux', session: '-t' })).toBeNull();
    expect(parseHostTerminalTarget({ kind: 'tmux', session: 'a\u0007b' })).toBeNull();
    expect(parseHostTerminalTarget({ kind: 'tmux', session: '' })).toBeNull();
    expect(parseHostTerminalTarget({ kind: 'ssh', session: 'x' })).toBeNull();
    expect(hostTerminalTargetKey({ kind: 'tmux', session: 'w' })).toBe('tmux:w');
  });

  it('clamps terminal sizes and validates control frames', () => {
    expect(clampTerminalSize(120, 40)).toEqual({ cols: 120, rows: 40 });
    expect(clampTerminalSize(99999, 99999)).toEqual({ cols: 1000, rows: 500 });
    expect(clampTerminalSize(0, 10)).toBeNull();
    expect(clampTerminalSize('80', 24)).toBeNull();
    expect(parseClientControl('{"t":"resize","cols":80.7,"rows":24}')).toEqual({ t: 'resize', cols: 80, rows: 24 });
    expect(parseClientControl('{"t":"ack","bytes":-5}')).toBeNull();
    expect(parseClientControl('{"t":"visibility","hidden":true}')).toEqual({ t: 'visibility', hidden: true });
    expect(parseClientControl('not json')).toBeNull();
    // 旧调试终端的 JSON 输入帧不再被当成输入：输入只走二进制帧。
    expect(parseClientControl('{"type":"input","data":"rm -rf /"}')).toBeNull();
  });
});

describe('host-terminal touch keys', () => {
  it('encodes arrows per DECCKM and maps the sticky-Ctrl chord', () => {
    expect(hostTerminalKeyBytes('up', false)).toBe('\x1b[A');
    expect(hostTerminalKeyBytes('up', true)).toBe('\x1bOA');
    expect(hostTerminalKeyBytes('left', true)).toBe('\x1bOD');
    expect(hostTerminalKeyBytes('shiftTab', false)).toBe('\x1b[Z');
    expect(hostTerminalKeyBytes('home', false)).toBe('\x1b[H');
    expect(hostTerminalKeyBytes('home', true)).toBe('\x1bOH');
    expect(hostTerminalKeyBytes('end', true)).toBe('\x1bOF');
    expect(hostTerminalKeyBytes('pageUp', true)).toBe('\x1b[5~');
    expect(hostTerminalKeyBytes('ctrlC', false)).toBe('\x03');
    expect(ctrlChord('c')).toBe('\x03');
    expect(ctrlChord('D')).toBe('\x04');
    expect(ctrlChord('[')).toBe('\x1b');
    expect(ctrlChord('?')).toBe('\x7f');
    expect(ctrlChord(' ')).toBe('\x00');
    expect(ctrlChord('1')).toBeNull();
    expect(ctrlChord('ab')).toBeNull();
  });
});
