import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { IdleDetector } from '../src/utils/idle-detector.js';

const LOADING = `╭───────────────────────────────────────╮
│ >_ OpenAI Codex (v0.153.3)            │
│ model:     loading   /model to change │
│ directory: loading                    │
╰───────────────────────────────────────╯
› Ask Codex to do anything
  ? for shortcuts`;
const LOADED = `╭───────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.153.3)                        │
│ model:       gpt-6-astra xhigh   /model to change │
│ directory:   ~                                    │
│ permissions: YOLO mode                            │
╰───────────────────────────────────────────────────╯
› Ask Codex to do anything
  gpt-6-astra xhigh · ~`;

let detector: IdleDetector;
let idle: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  detector = new IdleDetector(createCodexAdapter());
  idle = vi.fn();
  detector.onIdle(idle);
});
afterEach(() => { detector.dispose(); vi.useRealTimers(); });

function quiet() { vi.advanceTimersByTime(95_000); }

describe('Codex startup readiness', () => {
  it('does not release input during a silent loading skeleton, even beyond the first-prompt hard timeout', () => {
    detector.feed(LOADING);
    quiet();
    expect(idle).not.toHaveBeenCalled();
  });

  it('holds split loading evidence and releases exactly once after the initialized screen', () => {
    const split = LOADING.indexOf('loading') + 3;
    detector.feed(LOADING.slice(0, split));
    detector.feed(LOADING.slice(split));
    quiet();
    expect(idle).not.toHaveBeenCalled();
    detector.feed(LOADED);
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('does not let prompt-only redraws or a reset erase known startup loading', () => {
    detector.feed(LOADING);
    detector.reset();
    detector.feed('› Ask Codex to do anything\n  ? for shortcuts');
    quiet();
    expect(idle).not.toHaveBeenCalled();
    detector.feed(LOADED);
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('accepts a warm initialized session and its later ordinary prompt', () => {
    detector.feed(LOADED);
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
    detector.reset();
    detector.feed('› Continue\n  gpt-6-astra xhigh · ~');
    quiet();
    expect(idle).toHaveBeenCalledTimes(2);
  });

  it('lets authoritative transcript completion release a startup hold', () => {
    detector.feed(LOADING);
    detector.fireIdle();
    expect(idle).toHaveBeenCalledTimes(1);
    detector.reset();
    detector.feed('› Continue');
    quiet();
    expect(idle).toHaveBeenCalledTimes(2);
  });

  it('does not release on the model footer, which can precede initialization', () => {
    detector.feed(LOADING);
    quiet();
    expect(idle).not.toHaveBeenCalled();
    detector.feed('› Ask Codex to do anything\n  custom-model high ·');
    detector.feed(' /tmp/work');
    quiet();
    expect(idle).not.toHaveBeenCalled();
    detector.feed(LOADED);
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('does not classify a partial directory value as initialized', () => {
    detector.feed(LOADING);
    detector.feed('│ model: gpt-6-astra xhigh /model to change │\n│ directory: l');
    detector.feed('oading │\n› Ask Codex');
    quiet();
    expect(idle).not.toHaveBeenCalled();
  });

  it('recognizes loading styles split inside an ANSI escape sequence', () => {
    detector.feed('│ model: \x1b[');
    detector.feed('0mloading /model to change │\n› Ask Codex');
    quiet();
    expect(idle).not.toHaveBeenCalled();
  });

  it('recognizes complete initialized cells drawn with cursor movement and no newline', () => {
    detector.feed(LOADING);
    detector.feed('\x1b[3;1H│ model: custom-model /model to change │\x1b[4;1H│ directory: /tmp/work │');
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('accepts an initialized banner when the user hides the status footer', () => {
    detector.feed(LOADING);
    quiet();
    expect(idle).not.toHaveBeenCalled();
    detector.feed(LOADED.replace('  gpt-6-astra xhigh · ~', ''));
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('keeps holding when only the model resolves and the directory is still loading', () => {
    detector.feed(LOADING);
    detector.feed('│ model: gpt-6-astra xhigh /model to change │\n│ directory: loading │\n› Ask Codex');
    quiet();
    expect(idle).not.toHaveBeenCalled();
    expect(detector.isStartupPending()).toBe(true);
  });

  it('does not mistake an old loading banner quoted after startup for a new startup', () => {
    detector.feed(LOADED);
    quiet();
    detector.reset();
    detector.feed(`The earlier screen was:\n${LOADING}\n› Continue`);
    quiet();
    expect(idle).toHaveBeenCalledTimes(2);
    expect(detector.isStartupPending()).toBe(false);
  });

  it('keeps initialized evidence when reattach seeds history and quoted loading in one chunk', () => {
    detector.feed(`${LOADED}\nEarlier failure:\n${LOADING}\n› Continue`);
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
    expect(detector.isStartupPending()).toBe(false);
  });
});
