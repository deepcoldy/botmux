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

  it('releases a loading hold on the actual 0.210 resumed composer without a loaded banner', () => {
    detector.feed(LOADING);
    const restored = `■ Conversation interrupted - use /feedback if something went wrong
⚠ This session was recorded with model GPT-6-Astra but is resuming with GPT-6.1-Sol.
──────── Configure botmux environment ─
❯ Explain this codebase
───────────────────────────────────────
  GPT-6.1-Sol (MAX) xhigh · ~ · Context 89% left
  ☢ Full Access (shift+tab to cycle) · ? for shortcuts · ← for agents`;
    detector.feed(restored);
    quiet();
    expect(detector.isStartupPending()).toBe(true);
    expect(detector.observeStartupHistory(restored)).toBe(true);
    expect(detector.isStartupPending()).toBe(false);
    // Initialization alone must not emit a synthetic turn completion.
    expect(idle).not.toHaveBeenCalled();
    detector.feed('❯ Explain this codebase');
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it.each([
    '◆ Queued for capacity (30s • esc to interrupt)',
    '◆ Working… (3s • esc to interrupt)',
    'Queued for next turn',
    '│ model: loading /model to change │\n│ directory: /tmp │',
  ])('holds a restored composer with conflicting live evidence: %s', conflict => {
    detector.feed(LOADING);
    expect(detector.observeStartupHistory(`${conflict}
──────────────────────────
❯ Explain this codebase
──────────────────────────
  GPT-6.1-Sol (MAX) xhigh · ~ · Context 89% left
  ☢ Full Access · ? for shortcuts`)).toBe(false);
    expect(detector.isStartupPending()).toBe(true);
  });

  it.each([
    '❯ 1. Trust and continue',
    '❯ my unsent draft',
    '  ❯ Explain this codebase',
    '▍ ❯ Explain this codebase',
  ])('does not release on a picker, draft, or quoted composer: %s', prompt => {
    detector.feed(LOADING);
    expect(detector.observeStartupHistory(`${prompt}
──────────────────────────
  GPT-6.1-Sol (MAX) xhigh · ~ · Context 89% left
  ☢ Full Access · ? for shortcuts`)).toBe(false);
    expect(detector.isStartupPending()).toBe(true);
  });

  it('accepts an initialized warm footer without misreading old busy transcript as current activity', () => {
    expect(detector.observeStartupHistory(`◆ Working… (3s • esc to interrupt)
old completed response
■ Conversation interrupted
⚠ Resuming with another model.
──────────────────────────
❯ Use /skills to list available skills
──────────────────────────
  GPT-6.1-Sol (MAX) xhigh · ~ · Context 89% left
  ☢ Full Access · ? for shortcuts`)).toBe(true);
  });
});
