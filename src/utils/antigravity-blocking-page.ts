/**
 * Antigravity CLI (`agy`) pickers that own the input surface while a turn
 * runs — the `antigravity` stuck-page family (utils/stuck-detector.ts). Typed
 * or pasted input there is read as keystrokes: digits jump to an option,
 * Enter picks the highlighted one. Captured from agy 1.5.12 (tmux at 44, 60
 * and 120 columns, with and without a stacked statusLine row):
 *
 *   Question                                      ← title
 *   ──────────
 *   Question 1/2: Which database should we use?   ← header (text may wrap)
 *   > 1. (Recommended) PostgreSQL                  ← numbered rows; multi-select
 *     2. SQLite                                       draws `[ ]` / `[x]`
 *     3. Write-in...                               ← (`Your answer:` + typed
 *                                                      text when it is open)
 *     ↑/↓ Navigate · → Next · enter Select · esc Skip
 *   esc to cancel                    Gemini 3.1 Pro · low
 *   <statusLine rows, if configured>
 *
 * The hint bar varies with the state (`← Back`, `space Toggle`,
 * `enter Submit All`, `enter Write-in`) and a pane narrower than the bar CUTS
 * it, not wraps it (44 columns: `… · enter Select · esc`, `… · space Toggle ·
 * ent`). So a list page is anchored on the bar's first hint `↑/↓ Navigate`
 * plus the page's own rows; the open write-in field's short bar is
 * `enter Submit All · esc Back`.
 *
 * The run_command permission dialog (no --dangerously-skip-permissions, or a
 * command an admin policy still sends for review):
 *
 *   Command
 *   ──────────
 *   Requesting permission for:
 *      touch /tmp/x && echo done
 *
 *   Run this command?
 *   > 1. Yes, run command
 *     …
 *     4. No, cancel
 *
 *     ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command
 *   esc to cancel                    Gemini 3.1 Pro · low
 *
 * Both replace the composer and are drawn only during a running turn, so a
 * match needs the busy status row (`esc to cancel`) at the bottom — at most a
 * few statusLine rows below it, none of them a composer — with the page's
 * hint bar directly above it. The same text quoted in the transcript is
 * followed by the composer and `? for shortcuts` instead.
 */
import { stripAnsiScreenText } from './idle-detector.js';

export type AntigravityBlockingPageType = 'antigravity question' | 'antigravity permission';

/** Rows below the busy status row: agy stacks a configured statusLine there. */
const MAX_ROWS_BELOW_STATUS = 4;
/** How far above the hint bar the page's header may sit (options, a wrapped
 *  question, an open write-in field). */
const MAX_PAGE_ROWS = 40;

const STATUS_ROW = /^\s*esc to cancel(?:\s|$)/;
/** A row the composer draws (prompt marker, ready footer): never part of a live page. */
const COMPOSER_ROW = /^\s*(?:>|❯)(?:\s|$)|^\s*\? for shortcuts(?:\s|$)/;
const OPTION_ROW = /^\s*(?:>\s*)?\d+\.\s+\S/;
const QUESTION_HEADER = /^\s*Question \d+\/\d+:\s/;
const PERMISSION_OPTION = /^\s*(?:>\s*)?\d+\.\s+(?:Yes|No)\b/;

function screenRows(snapshot: string): string[] {
  const rows = stripAnsiScreenText(snapshot).replace(/\r\n?/g, '\n').split('\n').map(row => row.trimEnd());
  let end = rows.length;
  while (end > 0 && rows[end - 1] === '') end--;
  return rows.slice(0, end);
}

/** `↑/↓ Navigate · → Next · enter Select · esc Skip` → ['↑/↓ navigate', '→ next', 'enter select', 'esc skip']. */
function hints(row: string): string[] {
  return row.trim().split(/\s+·\s+/).map(hint => hint.trim().toLowerCase().replace(/\s+/g, ' '));
}

/** A list page's bar: its first hint survives the cut on a narrow pane. */
function isListHintBar(row: string): boolean {
  return hints(row)[0] === '↑/↓ navigate';
}

/** The bar under an open write-in field of the question picker. */
function isWriteInHintBar(row: string): boolean {
  const set = hints(row);
  return /^enter (?:submit|submit all|next)$/.test(set[0] ?? '') && set.includes('esc back');
}

/** Index of the hint bar that sits on top of the live busy status row, or -1. */
function hintBarIndex(rows: string[]): number {
  let status = -1;
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 1 - MAX_ROWS_BELOW_STATUS); i--) {
    if (STATUS_ROW.test(rows[i]!)) { status = i; break; }
  }
  if (status < 0) return -1;
  if (rows.slice(status + 1).some(row => COMPOSER_ROW.test(row))) return -1;
  let hint = status - 1;
  while (hint >= 0 && rows[hint]!.trim() === '') hint--;
  return hint;
}

interface PageMatch {
  type: AntigravityBlockingPageType;
  /** The page's own rows, title to hint bar. */
  block: string[];
  /** Block rows (indices into `block`) carrying the command a permission
   *  dialog asks about — free-form, never repeated outside the terminal. */
  commandRows?: [number, number];
}

/** agy's own last option of every question: the free-text row. */
const WRITE_IN_ROW = /^\s*(?:>\s*)?\d+\.\s+(?:\[[ x]\]\s+)?Write-in\.\.\.$/;
/** Hints only the question picker draws (`esc Skip`, `space Toggle`, `→ Next`, `← Back`, `enter Submit All`). */
const QUESTION_ONLY_HINTS = new Set(['esc skip', 'space toggle', '→ next', '← back', 'enter submit all']);

function matchPage(snapshot: string): PageMatch | undefined {
  if (!snapshot) return undefined;
  const rows = screenRows(snapshot);
  const hint = hintBarIndex(rows);
  if (hint < 0) return undefined;
  const pageTop = Math.max(0, hint - MAX_PAGE_ROWS);
  const page = rows.slice(pageTop, hint);
  const bar = rows[hint]!;
  const block = (from: number) => rows.slice(pageTop + from, hint + 1);
  const listBar = isListHintBar(bar);
  const writeInBar = isWriteInHintBar(bar);
  if (!listBar && !writeInBar) return undefined;
  const header = page.map(row => QUESTION_HEADER.test(row)).lastIndexOf(true);
  // The title row sits right above the header (a rule row between them,
  // blanked by the PTY renderer's display cleanup).
  const title = header < 0 ? -1 : page.slice(0, header).map(row => row.trim() === 'Question').lastIndexOf(true);
  if (title >= 0 && header - title <= 4) {
    const options = page.slice(header + 1).filter(row => OPTION_ROW.test(row)).length;
    return options >= 2 ? { type: 'antigravity question', block: block(title) } : undefined;
  }
  // A long option list (or a narrow pane) scrolls the title and header off
  // the viewport: the picker is still known by its own last rows — the
  // write-in row right above the list bar, a question-only hint, or the open
  // write-in field.
  const firstOption = page.findIndex(row => OPTION_ROW.test(row));
  const lastRow = page.map(row => row.trim() !== '').lastIndexOf(true);
  const questionBottom = listBar
    ? (lastRow >= 0 && WRITE_IN_ROW.test(page[lastRow]!)) || hints(bar).some(h => QUESTION_ONLY_HINTS.has(h))
    : page.some(row => /^\s*Your answer:$/.test(row));
  if (questionBottom && firstOption >= 0 && page.filter(row => OPTION_ROW.test(row)).length >= 2) {
    return { type: 'antigravity question', block: block(firstOption) };
  }
  if (!listBar) return undefined;
  const first = page.findIndex(row => PERMISSION_OPTION.test(row));
  if (first < 0) return undefined;
  // From "Requesting permission for:" (or the prompt line above the options).
  const request = page.slice(0, first).map(row => /^\s*Requesting permission for:/.test(row)).lastIndexOf(true);
  const from = request >= 0 ? request : Math.max(0, first - 1);
  // The command sits between "Requesting permission for:" and the prompt
  // line right above the options ("Run this command?").
  const prompt = page.slice(0, first).map(row => row.trim() !== '').lastIndexOf(true);
  return {
    type: 'antigravity permission',
    block: block(from),
    ...(request >= 0 && prompt > request + 1 ? { commandRows: [1, prompt - from] as [number, number] } : {}),
  };
}

/** Which agy picker the live viewport shows, if any. Pure. */
export function matchAntigravityBlockingPage(snapshot: string): AntigravityBlockingPageType | undefined {
  return matchPage(snapshot)?.type;
}

/** The picker's own rows as a card's screen tail (empty when no picker is
 *  shown): the conversation above it never leaves the terminal, and neither
 *  does the command a permission dialog asks about (free-form: it can carry a
 *  token in any shape). Credential shapes elsewhere are the caller's
 *  redaction (core/stuck-page-catalog.ts redactStuckPageTail). */
export function antigravityBlockingPageTail(snapshot: string): string {
  const match = matchPage(snapshot);
  if (!match) return '';
  const [from, to] = match.commandRows ?? [-1, -1];
  return match.block
    .map((row, i) => (i >= from && i < to && row.trim() ? `${/^\s*/.exec(row)![0]}‹hidden›`
      : /^[─━]{8,}$/.test(row.trim()) ? '─'.repeat(40) : row))
    .join('\n');
}
