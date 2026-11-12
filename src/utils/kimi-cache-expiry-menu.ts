/**
 * Kimi Code's "cache expired" menu (upstream CacheHintDialogComponent, shipped
 * unchanged from 0.34.0 through at least 2.5.3). Kimi mounts it in place of its
 * composer in two situations:
 *
 *  - idle submit: a message submitted after the session sat idle past the
 *    model's cache window is swallowed and parked until the menu is answered;
 *    "Compact and continue" compacts and then re-sends that message by itself;
 *  - resume: right after `--session <id>` loads a long-idle session, before any
 *    message. Nothing is parked here: a message pasted into the menu is
 *    swallowed and its Enter picks the highlighted row (Compact, or a NEW
 *    SESSION when the highlight was moved) — the message is lost.
 *
 * In both cases OSC 7501 reports nothing for the menu (the last terminal state
 * stays), so without recognising it a botmux turn ended on the 2s quiet screen.
 *
 * Captured from the real binary (test/fixtures/stuck-pages/kimi-*):
 *
 *   ──────────────────────────────────────────────…   rule
 *    This session has been idle for 1m and is ~201 tokens.
 *    ↑↓ navigate · Enter select · Esc cancel
 *                                                     (blank)
 *    Cache expired — the next message re-sends the entire history at full price.
 *     ❯ Compact and continue    one-time compact cost · cheapest way to keep this topic
 *       Start a new session     zero context cost · best for a new task
 *       Continue as-is          full history kept · highest cost per turn
 *       Don't ask me again
 *                                                     (blank)
 *   ──────────────────────────────────────────────…   rule
 *   Never Ask  K3  /path …                            status footer (1–2 rows)
 *
 * Every row is truncated to the terminal width, never wrapped (80 columns cut
 * the first description to "…keep th..."), so labels are matched as prefixes
 * and descriptions are free. The block must sit at the bottom of the viewport
 * with only the status footer below it: the same text quoted in the transcript
 * above the composer is not the menu.
 *
 * Two text forms reach this matcher and both are accepted: the backend's raw
 * capture (`captureViewport`, ANSI and spacing intact) and the worker's xterm
 * text (`snapshotToText` / `renderer.rawSnapshot()`), which blanks box-drawing
 * rules and collapses runs of spaces — there a rule row is empty and a
 * label is followed by a single space.
 */

export type KimiCacheExpiryChoice = 'compact' | 'new' | 'continue' | 'never';

export interface KimiCacheExpiryMenu {
  /** The row carrying the selection pointer; undefined when no row (or more
   *  than one) carries it — never guessed. */
  highlighted: KimiCacheExpiryChoice | undefined;
  /** The menu rows between its two rules, ANSI stripped — the part of the
   *  screen that may be shown on a card. Never the conversation above it. */
  block: string[];
}

const NON_PRINTING_ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b\[[0-?]*[ -\/]*[@-~]|\x1b[()*+][0-9A-Za-z]|\x1b[78=>]/g;
const VIEWPORT_LINES = 40;
/** Rows Kimi may draw below the menu: its status footer (mode/model/cwd/tips
 *  and the context line). Anything taller is not this menu at the bottom. */
const MAX_FOOTER_ROWS = 4;

const RULE = /^\s*─{8,}\s*$/;
/** A rule row in either text form (the xterm text blanks it). */
const isRuleRow = (row: string): boolean => RULE.test(row) || row.trim() === '';
const TITLE = /^\s*This session has been idle for \S/;
const HINT = /^\s*↑↓ navigate · Enter select · Esc cancel\s*$/;
const BODY = /^\s*Cache expired — the next message\b/;
const SELECT_POINTER = '❯';
const OPTION_ROWS: ReadonlyArray<readonly [KimiCacheExpiryChoice, RegExp]> = [
  ['compact', /^\s*(❯\s+)?Compact and continue(?:\s+\S.*)?$/],
  ['new', /^\s*(❯\s+)?Start a new session(?:\s+\S.*)?$/],
  ['continue', /^\s*(❯\s+)?Continue as-is(?:\s+\S.*)?$/],
  ['never', /^\s*(❯\s+)?Don't ask me again\s*$/],
];

function viewportRows(snapshot: string): string[] {
  const rows = snapshot.split('\n').map(row => row.replace(NON_PRINTING_ESCAPES, '').replace(/\r/g, ''));
  let end = rows.length;
  while (end > 0 && rows[end - 1]!.trim() === '') end--;
  return rows.slice(Math.max(0, end - VIEWPORT_LINES), end);
}

/** The menu at the bottom of `snapshot`, or undefined. Pure. */
export function matchKimiCacheExpiryMenu(snapshot: string): KimiCacheExpiryMenu | undefined {
  if (!snapshot) return undefined;
  const rows = viewportRows(snapshot);
  // The body line anchors the block; search from the bottom so a menu quoted
  // higher up in the transcript can never be the one picked.
  for (let b = rows.length - 1; b >= 4; b--) {
    if (!BODY.test(rows[b]!)) continue;
    const top = b - 4;
    const bottom = b + 6;
    if (bottom >= rows.length) return undefined;
    if (!isRuleRow(rows[top]!) || !TITLE.test(rows[b - 3]!) || !HINT.test(rows[b - 2]!) || rows[b - 1]!.trim() !== '') {
      return undefined;
    }
    let highlighted: KimiCacheExpiryChoice | undefined;
    let pointers = 0;
    for (let i = 0; i < OPTION_ROWS.length; i++) {
      const [choice, pattern] = OPTION_ROWS[i]!;
      const m = pattern.exec(rows[b + 1 + i]!);
      if (!m) return undefined;
      if (m[1]?.startsWith(SELECT_POINTER)) {
        pointers++;
        highlighted = choice;
      }
    }
    if (rows[b + 5]!.trim() !== '' || !isRuleRow(rows[bottom]!)) return undefined;
    const below = rows.slice(bottom + 1).filter(row => row.trim() !== '');
    if (below.length > MAX_FOOTER_ROWS) return undefined;
    return {
      highlighted: pointers === 1 ? highlighted : undefined,
      block: rows.slice(top + 1, bottom).map(row => row.trimEnd()),
    };
  }
  return undefined;
}

/** Rows of a rule line kept on a card: the terminal-wide rule would wrap. */
const CARD_RULE = '─'.repeat(40);

/**
 * The menu as a card's screen tail: just its own rows (fixed Kimi chrome plus
 * the idle time and context size it reports), rules shortened. The
 * conversation above the menu never leaves the terminal. Empty when the
 * screen does not show the menu.
 */
export function kimiCacheExpiryMenuTail(snapshot: string): string {
  const menu = matchKimiCacheExpiryMenu(snapshot);
  if (!menu) return '';
  return [CARD_RULE, ...menu.block, CARD_RULE].join('\n');
}
