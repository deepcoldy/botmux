import { describe, expect, it } from 'vitest';
import { createTraexAdapter, TRAEX_SPINNER_LABELS } from '../src/adapters/cli/traex.js';
import { traexViewportFooterBusy } from '../src/adapters/cli/traex-footer.js';

const adapter = createTraexAdapter('/bin/traex');
/** The worker's real entry point: full authoritative viewport via getter. */
const busy = (screen: string) => adapter.isSessionBusy!({ sessionId: 's', getCurrentScreen: () => screen });

const RULE = '─'.repeat(60);
const BAR = '  tape-model · Context 99% left · /tmp/w   ☢ Full Access (shift+tab to cycle) · ← for agents';
const BANNER = [
  '╭───────────────────────────────────────────────╮',
  '│ █ ◆ ◆ █  TRAE CLI (v0.209.1)                  │',
  '│ model:       tape-model   /model to change    │',
  '╰───────────────────────────────────────────────╯',
];
/** Rule row as seen by each capture path: tmux (─ run), renderer
 *  (cleanBoxDrawing blanks it), stale diff-repaint glyphs (recorded). */
const RULE_ROWS = [RULE, '', ' 只回复一个词：好。不要调用任何工具。'];

function screen(body: string[], rule: string, composer = ['❯ Summarize recent commits']): string {
  return [...BANNER, '', ...body, rule, ...composer, '', BAR].join('\n');
}

const STATUSES = [
  '❖ Working… (1s • esc to interrupt)',
  '⋄ Working… (0s • esc to interrupt)',
  '◆ Thinking… (2s • esc to interrupt • thought for 0s)',
  '✧ Working… (3s • ↓ 9 tokens • esc to interrupt)',
  // Diff-repaint spelling observed in the raw PTY stream.
  '◈ Thinking… (3s • esc to interupt • thought for 0s)',
  '◈ Working… (1m 5s • esc to interrupt)',
];

// Rows captured from a live traecli 0.209.1 pane (xterm-headless 160x50,
// banner trimmed, model/path replaced): the user asked for a code block
// holding a full footer example, then a multi-line draft quoting one.
const LIVE_USER_TURN = [
  '▍ 请原样输出下面这个代码块，不要调用任何工具，不要加别的话：',
  '▍ ```',
  '▍ ❖ Working… (1s • esc to interrupt)',
  '▍ ────────────',
  '▍ ❯ Ask TraeCode CLI to do anything',
  '▍ ```',
];
const LIVE_REPLY = [
  '◆ The user is asking me to output a code block exactly as provided.',
  '  The content is:',
  '  ❖ Working… (1s • esc to interrupt)',
  '  ────────────',
  '  ❯ Ask TraeCode CLI to do anything',
  '  I\'ll output it exactly.',
  '◆ ❖ Working… (1s • esc to interrupt)',
  '  ────────────',
  '  ❯ Ask TraeCode CLI to do anything',
];
const LIVE_BAR = '  tape-model · Context 99% left · /tmp/w                                                ☢ Full Access (shift+tab to cycle) · ← for agents';
const LIVE_TITLED_RULE = `${'─'.repeat(136)} Output code block ─`;
const LIVE_BOTTOM_RULE = '─'.repeat(160);

describe('TraeX 0.209 viewport footer busy evidence', () => {
  it('matches the recorded live pane: mid-turn busy, settled idle, draft idle', () => {
    const midTurn = [
      ...LIVE_USER_TURN,
      '✦ Working… (3s • esc to interrupt)',
      `${'─'.repeat(93)} 请原样输出下面这个代码块，不要调用任何工具，不要加别的话： \`\`\` ❖ ─`,
      '❯ Explain this codebase',
      LIVE_BOTTOM_RULE,
      LIVE_BAR,
    ];
    expect(busy(midTurn.join('\n'))).toBe(true);

    const settled = [
      ...LIVE_USER_TURN, ...LIVE_REPLY,
      '  Worked for 6s • 5:20 AM',
      LIVE_TITLED_RULE,
      '❯ Explain this codebase',
      LIVE_BOTTOM_RULE,
      LIVE_BAR,
    ];
    expect(busy(settled.join('\n'))).toBe(false);

    const draft = [
      ...LIVE_USER_TURN, ...LIVE_REPLY,
      '  Worked for 6s • 5:20 AM',
      LIVE_TITLED_RULE,
      '❯ draft first line',
      '  ❖ Working… (1s • esc to interrupt)',
      '  ────',
      '  ❯ quoted prompt',
      '  last line',
      LIVE_BOTTOM_RULE,
      LIVE_BAR,
    ];
    expect(busy(draft.join('\n'))).toBe(false);
    // The renderer's cleanBoxDrawing view of the same panes.
    const clean = (rows: string[]) => rows
      .map(r => r.replace(/[─━│┌┐└┘├┤┬┴┼╭╮╯╰]/g, ' ').replace(/  +/g, ' ').trimEnd()).join('\n');
    expect(busy(clean(midTurn))).toBe(true);
    expect(busy(clean(settled))).toBe(false);
    expect(busy(clean(draft))).toBe(false);
  });

  it('accepts every compiled-in spinner label, punctuation included', () => {
    for (const label of TRAEX_SPINNER_LABELS) {
      const status = label.endsWith('…') ? `❖ ${label} (12s • esc to interrupt)` : `❖ ${label}… (12s • esc to interrupt)`;
      expect(busy(screen([status], RULE)), status).toBe(true);
    }
    expect(busy(screen(["❖ Shh, it's thinking… (12s • esc to interrupt)"], ''))).toBe(true);
  });

  it('ignores a reply whose first line is a status example ("◆ ❖ Working…")', () => {
    for (const rule of RULE_ROWS) {
      expect(busy(screen(['◆ ❖ Working… (1s • esc to interrupt)'], rule))).toBe(false);
      expect(busy(screen(['◆ ❖ Working… (1s • esc to interrupt)', '  ────'], rule, ['❯ x']))).toBe(false);
    }
  });

  it('recognises the live status row above the composer on every capture shape', () => {
    for (const status of STATUSES) {
      for (const rule of RULE_ROWS) {
        const s = screen(['▍ 只回复一个词：好。', '', '◆ 好', '', status], rule);
        expect(busy(s), `${status} / ${JSON.stringify(rule)}`).toBe(true);
      }
    }
    // tmux capture-pane -e keeps SGR codes at row starts.
    expect(busy(screen(['\x1b[38;5;2m\x1b[1m❖\x1b[0m Working… (1s • esc to interrupt)'], RULE))).toBe(true);
  });

  it('stays idle on a settled turn and the idle composer', () => {
    for (const rule of RULE_ROWS) {
      expect(busy(screen(['◆ 好', '', '  Worked for 3s • 11:08 PM'], rule))).toBe(false);
      expect(busy(screen(['◆ 好'], rule))).toBe(false);
    }
    expect(busy(BANNER.join('\n'))).toBe(false);
    expect(busy('')).toBe(false);
    // No getter = non-authoritative backend (ZMX history): never claim busy.
    expect(adapter.isSessionBusy!({ sessionId: 's' })).toBe(false);
    expect(adapter.isSessionBusy!({ sessionId: 's', getCurrentScreen: () => { throw new Error('capture'); } })).toBe(false);
  });

  // Every repro below reached busyPattern / idleToBusyPattern in an earlier
  // regex-only design and would make deferPromptReadyWhileBusy veto an idle
  // session indefinitely.
  it('ignores replies quoting the interrupt hint or a status line', () => {
    for (const rule of RULE_ROWS) {
      for (const quoted of [
        '◆ Press Escape to cancel the current request (esc to interrupt).',
        '◆ Working… (see docs • esc to interrupt)',
        '◆ 处理中 (2s • esc to interrupt)',
        '◆ The footer shows ❖ Working… (1s • esc to interrupt) while busy',
      ]) {
        expect(busy(screen([quoted, '', '  Worked for 3s • 11:08 PM'], rule)), quoted).toBe(false);
      }
    }
  });

  it('ignores a status example printed on its own line in a completed reply', () => {
    for (const rule of RULE_ROWS) {
      expect(busy(screen(['◆ The footer looks like:', '    ❖ Working… (1s • esc to interrupt)', '', '  Worked for 3s • 11:08 PM'], rule))).toBe(false);
      expect(busy(screen(['    ❖ Working… (1s • esc to interrupt)', '  Worked for 3s • 11:08 PM'], rule))).toBe(false);
    }
  });

  it('ignores a whole fenced footer example above the real settled row (warm restore)', () => {
    for (const rule of RULE_ROWS) {
      expect(busy(screen([
        '◆ The footer looks like this while a turn runs:',
        '    ❖ Working… (1s • esc to interrupt)',
        `    ${rule}`,
        '    ❯ Ask TraeCode CLI to do anything',
        '',
        '  Worked for 3s • 11:08 PM',
      ], rule))).toBe(false);
    }
  });

  it('ignores a footer example inside the composer, including long drafts', () => {
    const quotedFooter = ['  ❖ Working… (1s • esc to interrupt)', `  ${RULE}`, '  ❯ Ask TraeCode CLI to do anything'];
    for (const rule of RULE_ROWS) {
      expect(busy(screen(['◆ 好', '', '  Worked for 3s • 11:08 PM'], rule, ['❯ Please explain this footer:', ...quotedFooter]))).toBe(false);
      expect(busy(screen(['◆ 好', '', '  Worked for 3s • 11:08 PM'], rule, ['❯ Explain "❖ Working… (1s • esc to interrupt)"']))).toBe(false);
      // A draft long enough to push the real composer row out of
      // busyProbeRegion()'s tail; the full viewport still sees it.
      const longDraft = ['❯ line 0', ...Array.from({ length: 24 }, (_, i) => `  line ${i + 1}`), ...quotedFooter];
      expect(busy(screen(['◆ 好', '', '  Worked for 3s • 11:08 PM'], rule, longDraft))).toBe(false);
    }
  });

  it('is a pure line parser (no catastrophic backtracking on hostile rows)', () => {
    const hostile = [
      ...Array.from({ length: 50 }, () => `◆ Working… (1s • ${'esc to interrupt '.repeat(40)}`),
      `◆ ${'x'.repeat(100_000)}`,
    ].join('\n');
    const started = performance.now();
    traexViewportFooterBusy(`${hostile}\n${RULE}\n❯ x`);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
