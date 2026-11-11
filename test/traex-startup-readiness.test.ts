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

// Real tmux 160x50 frames from traecli 0.214.1. The empty composer paints in
// ~1.5s, but the model/context footer only appears after the model list fetch
// resolves (measured above 30s on a slow network); until then the only footer
// row is the native shortcut hint. Requiring a Context row here held the first
// prompt until the 90s hard timeout even though the composer already accepted
// keystrokes.
const SHORTCUT_ONLY_YOLO = [
  '  █ ◆ ◆ █  TRAE CLI (v0.214.1)',
  '  /tmp/traex0214/work',
  '  permissions: YOLO mode',
  '──────────────────────────────────────────────────────────',
  '❯ Ask TRAE CLI to do anything',
  '──────────────────────────────────────────────────────────',
  '  ? for shortcuts',
];
const SHORTCUT_ONLY_STANDARD = [
  '  █ ◆ ◆ █  TRAE CLI (v0.214.1)',
  '  /tmp/traex0214/work',
  '──────────────────────────────────────────────────────────',
  '❯ Ask TRAE CLI to do anything',
  '──────────────────────────────────────────────────────────',
  '  ? for shortcuts',
];

const REPOSITORY_NOTICE = [
  '  █ ◆ ◆ █  TRAE CLI (v0.212.1)',
  '  ~/projects',
  '  permissions: YOLO mode',
  '────────────────────────────────────────────────────',
  '❯ Write tests for @filename',
  '────────────────────────────────────────────────────',
  '  无法访问 Git 仓库 `git@example.invalid`，请确认该仓库权限或地址。',
];

describe('TraeX startup repository notification', () => {
  const resumedNotice = [
    '■ Conversation interrupted - use /feedback if something went wrong',
    '',
    '────────────────────────────────────────────────────',
    '❯ Write tests for @filename',
    '────────────────────────────────────────────────────',
    '  无法访问 Git 仓库 `git@example.invalid`，请确认该仓库权限或地址。',
  ].join('\n');

  it('accepts a known repository notice on an exact resumed session without a cold-start banner', () => {
    expect(traexRestoredComposerReady(resumedNotice, { resumedSession: true })).toBe(true);
    expect(traexRestoredComposerReady(resumedNotice)).toBe(false);
  });

  it.each([
    resumedNotice.replace('Write tests for @filename', 'my unsent draft'),
    resumedNotice.replace('Write tests for @filename', '1. Pick a model'),
    `Sign in to TraeCode CLI\n${resumedNotice}`,
    `│ model: loading /model to change │\n${resumedNotice}`,
    resumedNotice.replace('■ Conversation interrupted - use /feedback if something went wrong', '◆ Working… (3s • esc to interrupt)'),
    `${resumedNotice}\n  a wrapped draft continuation`,
    resumedNotice.replace('无法访问 Git 仓库 `git@example.invalid`，请确认该仓库权限或地址。', 'Please sign in before continuing'),
  ])('keeps blocked resumed input surfaces gated: %j', (screen) => {
    expect(traexRestoredComposerReady(screen, { resumedSession: true })).toBe(false);
  });

  it('accepts the initialized composer while the transient repository notice hides the model footer', () => {
    expect(traexRestoredComposerReady(REPOSITORY_NOTICE.join('\n'))).toBe(true);
    expect(traexRestoredComposerReady(REPOSITORY_NOTICE.join('\n').replace('Write tests for @filename', 'Ask TRAE CLI to do anything'))).toBe(true);
    expect(traexRestoredComposerReady(REPOSITORY_NOTICE.join('\n').replace('git@example.invalid', 'git@example.invalid:loading/repo.git'))).toBe(true);
  });

  it.each([
    REPOSITORY_NOTICE.map(row => row.replace('Write tests for @filename', 'my unsent draft')),
    REPOSITORY_NOTICE.map(row => row.replace('Write tests for @filename', '1. Sign in')),
    ['Sign in to TraeCode CLI', ...REPOSITORY_NOTICE],
    ['│ model: loading /model to change │', ...REPOSITORY_NOTICE],
    [...REPOSITORY_NOTICE.slice(0, 3), '◆ Working… (3s • esc to interrupt)', ...REPOSITORY_NOTICE.slice(3)],
    REPOSITORY_NOTICE.slice(3),
    REPOSITORY_NOTICE.filter(row => !row.includes('TRAE CLI (v')),
    REPOSITORY_NOTICE.filter(row => !row.includes('permissions:')),
    [...REPOSITORY_NOTICE, '  ☢ Full Access (shift+tab to cycle) · ? for shortcuts · ← for agents'],
    [...REPOSITORY_NOTICE, '  a wrapped draft continuation'],
    REPOSITORY_NOTICE.map(row => row.replace('无法访问 Git 仓库 `git@example.invalid`，请确认该仓库权限或地址。', 'Please sign in before continuing')),
  ])('keeps blocking input owners and unknown notifications gated: %j', (...rows: string[]) => {
    expect(traexRestoredComposerReady(rows.join('\n'))).toBe(false);
  });
});

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

  it('releases the startup hold when a 0.214.1 shortcut-only frame replaces the loading skeleton', () => {
    detector.feed(LOADING);
    quiet();
    expect(idle).not.toHaveBeenCalled();
    expect(detector.observeStartupHistory(SHORTCUT_ONLY_YOLO.join('\n'))).toBe(true);
    expect(detector.isStartupPending()).toBe(false);
  });

  it('does not release the startup hold on the 0.205 combined shortcut/context loading row', () => {
    detector.feed(LOADING);
    const combined = SHORTCUT_ONLY_YOLO.slice(0, -1)
      .concat('  ? for shortcuts                                                                                        100% context left')
      .join('\n');
    expect(detector.observeStartupHistory(combined)).toBe(false);
    expect(detector.isStartupPending()).toBe(true);
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
    ['Auto Mode footer', INITIALIZED_COMPOSER.map(row => row.replace('☢ Full Access', '▧ Auto Mode')), true],
    ['Workspace Edit footer', INITIALIZED_COMPOSER.map(row => row.replace('☢ Full Access', '▧ Workspace Edit')), true],
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

// Real tmux 160x50 frames from traecli 0.214.1: see SHORTCUT_ONLY_* above.
describe('TraeX 0.214.1 shortcut-only startup footer', () => {
  it.each([
    ['YOLO cold start', SHORTCUT_ONLY_YOLO],
    ['standard workspace cold start', SHORTCUT_ONLY_STANDARD],
    ['agents hint only', SHORTCUT_ONLY_YOLO.slice(0, -1).concat('  ← for agents')],
    ['both hint tokens', SHORTCUT_ONLY_YOLO.slice(0, -1).concat('  ? for shortcuts · ← for agents')],
  ])('accepts the initialized empty composer before the model footer resolves: %s', (_name, rows) => {
    expect(traexRestoredComposerReady(rows.join('\n'))).toBe(true);
  });

  it('accepts the same frame on an exact resume', () => {
    expect(traexRestoredComposerReady(SHORTCUT_ONLY_STANDARD.join('\n'), { resumedSession: true })).toBe(true);
  });

  it.each([
    ['migration dialog below the hint', [
      ...SHORTCUT_ONLY_YOLO,
      '',
      '  > Legacy TRAE CLI data detected',
      '  Would you like to migrate detected data to the new TRAE CLI storage?',
      '    1. Proceed with selected',
      '    2. Skip for now',
    ]],
    ['draft in the composer', SHORTCUT_ONLY_YOLO.map(row => row.replace('Ask TRAE CLI to do anything', 'my unsent draft'))],
    ['0.205 loading skeleton keeps its combined context row', [
      ...SHORTCUT_ONLY_YOLO.slice(0, -1),
      '  ? for shortcuts                                                                                        100% context left',
    ]],
    ['unknown notification sentence', SHORTCUT_ONLY_YOLO.slice(0, -1).concat('  Please wait while models load')],
    ['hint row with extra suffix', SHORTCUT_ONLY_YOLO.slice(0, -1).concat('  ? for shortcuts  loading')],
    ['login surface above the composer', ['Sign in to TraeCode CLI', ...SHORTCUT_ONLY_YOLO]],
    ['picker composer row', SHORTCUT_ONLY_YOLO.map(row => row.replace('Ask TRAE CLI to do anything', '1. Continue'))],
  ])('keeps non-ready or blocked surfaces gated: %s', (_name, rows) => {
    expect(traexRestoredComposerReady(rows.join('\n'))).toBe(false);
  });
});
