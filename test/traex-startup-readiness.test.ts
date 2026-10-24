import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { traexRestoredComposerReady } from '../src/adapters/cli/traex-footer.js';

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

function cursorAddressedComposer(width = 40): string {
  const rule = '─'.repeat(width);
  return `\x1b[12;1H${rule}\x1b[13;1H❯ Ask TRAE CLI to do anything\x1b[14;1H${rule}`;
}

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

  // TraeX 0.211.1 redraws adjacent rows with CUP instead of newlines.
  // Stripping ANSI therefore joins the rule and composer as `────❯ …`.
  it.each(['─', '━'])('releases the composer following a %s rule in a cursor-addressed PTY frame', rule => {
    detector.feed(`\x1b[12;1H${rule.repeat(160)}\x1b[13;1H\x1b[1m❯\x1b[0m Ask TRAE CLI to do anything\x1b[14;1H${rule.repeat(160)}`);
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('recognizes a rule and composer arriving in separate PTY chunks', () => {
    detector.feed(`\x1b[12;1H${'─'.repeat(160)}`);
    detector.feed('\x1b[13;1H\x1b[1m❯\x1b[0m Ask TRAE CLI to do anything');
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('still holds a loading banner with a cursor-addressed composer', () => {
    detector.feed(LOADING);
    detector.feed(`\x1b[12;1H${'─'.repeat(160)}\x1b[13;1H❯ Ask TRAE CLI to do anything`);
    quiet();
    expect(idle).not.toHaveBeenCalled();
    detector.feed(LOADED);
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('does not release numbered picker rows after a rule', () => {
    detector.feed(`\x1b[12;1H${'─'.repeat(160)}\x1b[13;1H❯ 1. Continue`);
    quiet();
    expect(idle).not.toHaveBeenCalled();
    detector.feed('\r❯ Ask TRAE CLI to do anything');
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('clears a capacity hold when the cursor-addressed composer returns', () => {
    detector.feed('\x1b[2KQueued for capacity\nContext 100% left');
    quiet();
    expect(idle).not.toHaveBeenCalled();
    detector.feed(`\x1b[12;1H${'─'.repeat(160)}\x1b[13;1H❯ Ask TRAE CLI to do anything`);
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['queue-first', 'Queued for capacity'],
    ['queue-first', '⠋ Queued for capacity'],
    ['composer-first', 'Queued for capacity'],
    ['composer-first', '⠋ Queued for capacity'],
  ])('holds a same-chunk queue and cursor-addressed composer (%s, %s)', (order, label) => {
    const queue = `\x1b[11;1H\x1b[2K${label}`;
    const composer = cursorAddressedComposer();
    // Preserve the queue line boundary when it follows the composer.
    detector.feed(order === 'queue-first' ? queue + composer : `${composer}\n${queue}`);
    quiet();
    expect(idle).not.toHaveBeenCalled();

    // A later composer-only repaint clears the hold; stale tail evidence
    // must not re-arm it when just the status bar redraws afterwards.
    detector.feed(composer);
    detector.feed('\x1b[15;1HContext 100% left');
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('keeps same-chunk queue evidence that has scrolled out of the rolling tail', () => {
    detector.feed(`\x1b[11;1H\x1b[2KQueued for capacity${cursorAddressedComposer(320)}`);
    quiet();
    expect(idle).not.toHaveBeenCalled();
    detector.feed('Context 100% left');
    quiet();
    expect(idle).not.toHaveBeenCalled();

    detector.feed(cursorAddressedComposer());
    quiet();
    expect(idle).toHaveBeenCalledTimes(1);
  });
});


const INITIALIZED_COMPOSER = [
  '──────────────────────────',
  '❯ Use /skills to list available skills',
  '──────────────────────────',
  '  GPT-6-Astra xhigh · /tmp/project · Context —',
  '  ☢ Full Access · ? for shortcuts',
];

describe('TraeX initialized composer', () => {
  it.each([
    ['fresh context', INITIALIZED_COMPOSER, true],
    ['model still loading', INITIALIZED_COMPOSER.map(row => row.replace('GPT-6-Astra xhigh', 'loading')), false],
    ['directory named loading', INITIALIZED_COMPOSER.map(row => row.replace('/tmp/project', '/tmp/loading')), true],
  ])('%s has the expected initialization evidence', (_name, rows, expected) => {
    expect(traexRestoredComposerReady(rows.join('\n'))).toBe(expected);
  });

  it.each([
    ['Sign in to TraeCode CLI', 'Press enter to open browser', 'https://example.invalid/auth', 'waiting for authorization…'],
    ['Sign in to TraeCode CLI', '', '', '', ''],
    ['Press enter to open browser', '', '', '', ''],
    ['waiting for authorization…', '', '', '', ''],
  ].map(login => [login]))('holds an initialized composer while a login surface above it still owns input: %j', login => {
    expect(traexRestoredComposerReady([...login, ...INITIALIZED_COMPOSER].join('\n'))).toBe(false);
  });

  it('does not treat a completed reply mentioning login as an active login surface', () => {
    expect(traexRestoredComposerReady([
      '◆ The previous login said: Sign in to TraeCode CLI',
      '  It used open browser and authorization before completing.',
      '■ Conversation interrupted',
      ...INITIALIZED_COMPOSER,
    ].join('\n'))).toBe(true);
  });

  it.each(['Sign in to TraeCode CLI', 'Press enter to open browser', 'waiting for authorization…'])(
    'accepts an indented transcript continuation containing %s', line => {
      expect(traexRestoredComposerReady(['◆ Previous instructions:', `  ${line}`,
        '■ Conversation interrupted', ...INITIALIZED_COMPOSER].join('\n'))).toBe(true);
    });
});
