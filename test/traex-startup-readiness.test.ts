import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { IdleDetector } from '../src/utils/idle-detector.js';

// Real PTY frames sampled from traex 0.205.1-alpha.3 with node-pty +
// xterm-headless. At 0.6s the composer skeleton is already drawn (including
// the `❯` line and the `100% context left` status bar that match the
// adapter's readyPattern), but the model cell still reads `loading`; at 1.5s
// both banner cells are resolved. traex 0.201.1-alpha.6 paints the same
// `model:`/`directory:` ready banner shape.
const LOADING = `╭──────────────────────────────────────────╮
│ ▄▄▄▄▄▄▄                                  │
│ █ ◆ ◆ █  TraeCode CLI (v0.205.1-alpha.3) │
│  ▀▀▀▀▀▀                                  │
│                                          │
│ model:     loading   /model to change    │
│ directory: /data00/home/huangyuhang.edu  │
╰──────────────────────────────────────────╯
❯ Ask TraeCode CLI to do anything
  ? for shortcuts                                                                                        100% context left`;
const LOADED = `╭─────────────────────────────────────────────────╮
│ █ ◆ ◆ █  TraeCode CLI (v0.205.1-alpha.3)        │
│ Good afternoon, huangyuhang.edu                 │
│                                                 │
│ model:     GPT-6-Astra xhigh   /model to change │
│ directory: /data00/home/huangyuhang.edu         │
╰─────────────────────────────────────────────────╯
❯ Find and fix a bug in @filename
  GPT-6-Astra xhigh · Context 100% left · /data00/home/huangyuhang.edu`;

let detector: IdleDetector;
let idle: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  detector = new IdleDetector(createTraexAdapter('/bin/true'));
  idle = vi.fn();
  detector.onIdle(idle);
});
afterEach(() => { detector.dispose(); vi.useRealTimers(); });

function quiet() { vi.advanceTimersByTime(95_000); }

describe('TraeX startup readiness', () => {
  it('does not release input during a silent loading skeleton, even though the frame already has the ❯ prompt', () => {
    detector.feed(LOADING);
    quiet();
    expect(idle).not.toHaveBeenCalled();
    expect(detector.isStartupPending()).toBe(true);
  });

  it('releases exactly once after the initialized screen', () => {
    detector.feed(LOADING);
    quiet();
    expect(idle).not.toHaveBeenCalled();
    detector.feed(LOADED);
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('holds loading evidence split across PTY chunks', () => {
    const split = LOADING.indexOf('loading') + 3;
    detector.feed(LOADING.slice(0, split));
    detector.feed(LOADING.slice(split));
    quiet();
    expect(idle).not.toHaveBeenCalled();
    detector.feed(LOADED);
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('holds when "loading" is split inside an ANSI escape sequence', () => {
    detector.feed('│ model: \x1b[');
    detector.feed('0mloading /model to change │\n❯ Ask TraeCode');
    quiet();
    expect(idle).not.toHaveBeenCalled();
  });

  it('does not let a reset plus a prompt-only redraw erase known startup loading', () => {
    detector.feed(LOADING);
    detector.reset();
    detector.feed('❯ Ask TraeCode CLI to do anything\n  ? for shortcuts   100% context left');
    quiet();
    expect(idle).not.toHaveBeenCalled();
    detector.feed(LOADED);
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('accepts a warm initialized session and its later ordinary prompt (monotonic, no relapse)', () => {
    detector.feed(LOADED);
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
    detector.reset();
    detector.feed('❯ Continue\n  GPT-6-Astra xhigh · Context 100% left · /data00/home/huangyuhang.edu');
    quiet();
    expect(idle).toHaveBeenCalledTimes(2);
  });

  it('lets authoritative transcript completion release a startup hold', () => {
    detector.feed(LOADING);
    detector.fireIdle();
    expect(idle).toHaveBeenCalledTimes(1);
    detector.reset();
    detector.feed('❯ Continue');
    quiet();
    expect(idle).toHaveBeenCalledTimes(2);
  });

  it('does not mistake an old loading banner quoted after startup for a new startup', () => {
    detector.feed(LOADED);
    quiet();
    detector.reset();
    detector.feed(`The earlier screen was:\n${LOADING}\n❯ Continue`);
    quiet();
    expect(idle).toHaveBeenCalledTimes(2);
    expect(detector.isStartupPending()).toBe(false);
  });

  it('recognizes complete initialized cells redrawn with cursor movement and no newline', () => {
    detector.feed(LOADING);
    detector.feed('\x1b[5;1H│ model: GPT-6-Astra xhigh   /model to change │\x1b[6;1H│ directory: /data00/home/huangyuhang.edu │');
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
  });
});
