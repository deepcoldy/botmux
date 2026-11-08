import { parseCodexEffortMenu } from './codex-effort-menu.js';
import { shouldHoldInputForHookReview } from './stuck-detector.js';
import { isCodexModelMigrationScreen } from './codex-model-migration-dialog.js';
import { stripAnsiScreenText } from './idle-detector.js';

/**
 * Structured "a Codex selection surface owns the keyboard" gate.
 *
 * Codex renders interactive choices in two shapes that differ in what they do
 * to the composer, and the difference is exactly what makes a composer-only
 * check unsafe:
 *
 *  - **Inline** views (the tool-approval overlay, hook review, the model
 *    migration picker) replace the bottom pane: no composer row is rendered at
 *    all.
 *  - **Centered** views (`SelectionViewParams::confirmation()` →
 *    `ViewPresentation::Centered`, e.g. "Enable full access?", "Archive this
 *    session?", rate-limit reset confirmation) are painted as an overlay over
 *    the previous view stack, so the backdrop's composer row survives. They
 *    also return `None` from `cursor_pos` unless an on-demand search is active,
 *    so the physical cursor stays wherever the composer left it.
 *
 * A `hasEmptyCodexComposer()`-only pre-check therefore reasons about the
 * *backdrop*, not about who owns Enter. This module answers that question
 * directly and structurally: it recognises the selection surfaces from their
 * rendered rows plus the live control footer, and fails closed on anything it
 * cannot positively classify as "plain composer".
 *
 * Deliberately NOT a "screen contains a selection footer" substring test: the
 * footer must be the LAST non-empty line of the live viewport (so a footer
 * quoted in scrollback, in a pasted draft, or in a resumed transcript cannot
 * match) and the numbered option block must sit above it.
 */

const VIEWPORT_LINES = 40;
/** How far above the footer numbered rows may start. */
const OPTIONS_SEARCH_LINES = 30;

/** Control footer that advertises both an accept key and a cancel/back key.
 *  Anchored at line start (optionally behind the "Press " wording Codex uses
 *  for the approval overlay) so ordinary prose that merely mentions both keys
 *  in a sentence does not match. */
const MENU_CONTROL_FOOTER = /^\s*(?:press\s+)?(?:enter|↵)\b[^\r\n]{0,160}\besc\b/i;

/** Same footer after a custom keymap rebinds the keys: Codex renders the
 *  configured bindings (`f3 select · f2 back`), never the words "enter"/"esc".
 *  Requires the accept verb, the `·` separator and the cancel verb in order, on
 *  the LAST viewport row, so ordinary prose still cannot match. */
const REBOUND_MENU_FOOTER = /^\s*\S+\s+(?:select|confirm|choose)\b[^\r\n]{0,80}·[^\r\n]{0,40}\b(?:back|cancel|quit)\b/i;

/** A numbered option row. Two placements matter:
 *  - at line start (`  2. Cancel`), the usual tmux capture shape;
 *  - embedded after a selection marker (`… reasoning e› 1. Yes, continue
 *    anyway …`), which is what a CENTERED overlay looks like when it is painted
 *    over a still-live backdrop view: the dialog's rectangle begins mid-line, to
 *    the right of the backdrop's own text.
 *  Narrow panes also wrap, splitting `2. Yes, archive` across rows. */
const NUMBERED_OPTION = /(?:^|[\s›»>])(\d+)\.(?:\s|$)/;
/** Selection marker sitting directly on an option number (`› 1. …`). */
const MARKED_OPTION = /[›»>]\s*\d+\./;
/** A marker left alone on its line by a narrow wrap. */
const LONE_MARKER = /^\s*[›»>]\s*$/;
/** The live composer prompt row (empty placeholder or user draft). */
const COMPOSER_ROW = /^\s*[›»](?:\s|$)/;

/**
 * Locate the menu control footer, returning the index of its FIRST row.
 *
 * The footer is normally the last viewport row, but that is NOT guaranteed: when
 * a pane is resized while a CENTERED dialog is open, Codex's repaint leaves the
 * backdrop's composer and status rows BELOW the dialog. Captured from a real
 * 160→60 resize of an open "Enable full access?" dialog:
 *
 *   › 1. Yes, continue anyway  Apply full access for this …
 *     2. Cancel                Go back without enabling full access
 *   enter select · esc back              ← footer, mid-screen
 *   › Ask Codex to do anything           ← backdrop composer
 *   GPT-6.1-Sol xhigh · /tmp/x · ← for agents
 *
 * Anchoring on "last row" alone misses precisely the shape that makes a
 * composer-based check fail open (the cursor/composer really is below the
 * dialog), so a bounded tail of backdrop chrome is allowed after the footer.
 * The tail must contain ONLY composer/status rows — any other content means the
 * footer belongs to an older screen (a resumed transcript quoting a menu), not
 * to the live viewport.
 */
const FOOTER_TAIL_LINES = 20;
/** Backdrop chrome that may legitimately follow a mid-screen dialog footer. */
const STATUS_ROW = /^\s*\S[^\r\n]*·[^\r\n]*$/;

function backdropChromeOnly(lines: string[]): boolean {
  return lines.every(line => {
    const text = line.trim();
    return !text || COMPOSER_ROW.test(line) || STATUS_ROW.test(text);
  });
}

function footerIndex(lines: string[]): number | undefined {
  const trailing = footerTextIndex(lines);
  if (trailing !== undefined) return trailing;
  const last = lines.length - 1;
  const floor = Math.max(0, last - FOOTER_TAIL_LINES);
  for (let index = Math.min(floor, last); index <= last; index++) {
    if (footerTextIndex(lines.slice(0, index + 2)) !== index) continue;
    // Everything below must be backdrop chrome, and must not itself look like
    // menu content.
    const below = lines.slice(index + 2);
    if (!backdropChromeOnly(below)) continue;
    if (below.some(line => MARKED_OPTION.test(line) || NUMBERED_OPTION.test(line))) continue;
    return index;
  }
  return undefined;
}

/** Index of the wrapped-aware footer that ends the viewport. */
function footerTextIndex(lines: string[]): number | undefined {
  for (const take of [1, 2]) {
    if (lines.length < take) continue;
    const from = lines.length - take;
    const joined = lines.slice(from);
    for (const candidate of [joined.join(''), joined.join(' ')].map(text => text.trim())) {
      if (MENU_CONTROL_FOOTER.test(candidate) || REBOUND_MENU_FOOTER.test(candidate)) return from;
    }
  }
  return undefined;
}

export type CodexChoiceModalKind =
  | 'effort-menu'
  | 'hook-review'
  | 'model-migration'
  | 'choice-list';

export interface CodexChoiceModal {
  kind: CodexChoiceModalKind;
  /** Whether the backdrop composer row is still visible behind the surface. */
  composerBehind: boolean;
  /** Label of the highlighted option, when the row is readable. */
  selected?: string;
}

function viewportLines(screen: string): string[] {
  const lines = stripAnsiScreenText(screen)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .slice(-VIEWPORT_LINES);
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === '') end--;
  const trimmed = lines.slice(0, end);
  // Re-join the two wraps a narrow pane produces around option numbers:
  //   ` 2` / `. Yes, archive …`  and  `›` / `1. No, don't archive …`
  const merged: string[] = [];
  for (const line of trimmed) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && /\d$/.test(previous.trim()) && /^\s*\./.test(line)) {
      merged[merged.length - 1] = previous + line;
      continue;
    }
    merged.push(line);
  }
  return merged;
}

/**
 * Detection for the generic centered/inline selection list. Returns undefined
 * unless the live viewport ends in a menu control footer AND ≥2 numbered
 * option rows sit above it, one of them highlighted.
 */
function detectChoiceList(lines: string[]): CodexChoiceModal | undefined {
  if (lines.length < 3) return undefined;
  const footer = footerIndex(lines);
  if (footer === undefined) return undefined;
  // The footer is the last one or two non-empty viewport rows. That anchor is
  // what makes this structural rather than a substring search: the native
  // composer footer never advertises `enter … esc`, and a footer quoted in
  // scrollback, in a draft, or in a resumed transcript is not the LAST row.
  const footerStart = footer;
  const from = Math.max(0, footerStart - OPTIONS_SEARCH_LINES);
  let numbered = 0;
  let marked = false;
  let selected: string | undefined;
  for (let index = from; index < footerStart; index++) {
    const line = lines[index]!;
    if (MARKED_OPTION.test(line) || LONE_MARKER.test(line)) marked = true;
    const match = NUMBERED_OPTION.exec(line);
    if (!match) continue;
    numbered += 1;
    if (selected !== undefined) continue;
    // Label = text after the whole `N.` token. A centered overlay's row begins
    // mid-line (to the right of backdrop text), so slice from the match start.
    let label = line.slice(match.index + match[0].length).trim();
    // A narrow pane wraps a label onto following rows; fall back to the next
    // non-empty non-option row so the log line stays readable.
    for (let next = index + 1; !label && next < footerStart; next++) {
      const candidate = lines[next]!.trim();
      if (!candidate || NUMBERED_OPTION.test(candidate)) break;
      label = candidate;
    }
    if (MARKED_OPTION.test(line) || LONE_MARKER.test(line)) selected = label.slice(0, 120) || undefined;
  }
  // Two options are the minimum for a choice surface (`Yes, continue anyway` /
  // `Cancel`) and at least one must be visibly marked: plain numbered prose
  // cannot qualify. Deliberately NOT requiring a single highlight or a 1..N run
  // — a CENTERED dialog is painted over a still-live backdrop view, so the
  // backdrop's own rows and marker can remain inside the dialog's margins. Any
  // positive modal evidence fails closed, which is the safe direction: a false
  // positive only refuses a legitimate effort change.
  if (numbered < 2 || !marked) return undefined;
  const composerBehind = lines.slice(0, footerStart).some(line => COMPOSER_ROW.test(line));
  return { kind: 'choice-list', composerBehind, ...(selected ? { selected } : {}) };
}

/**
 * Positive identification of an interactive Codex selection surface on the
 * CURRENT viewport. Only meaningful for a live screen: transcript scrollback
 * must be excluded by the caller (the worker gates on its own viewport
 * capture/drain, never on full history).
 */
export function detectCodexChoiceModal(screen: string): CodexChoiceModal | undefined {
  if (!screen.trim()) return undefined;
  // The pickers BotMux drives itself are recognised by their own parsers first,
  // so a nested/prior menu keeps its specific kind.
  const effort = parseCodexEffortMenu(screen);
  if (effort) {
    return { kind: 'effort-menu', composerBehind: false, selected: effort.rows.find(row => row.selected)?.label };
  }
  if (isCodexModelMigrationScreen(screen)) return { kind: 'model-migration', composerBehind: false };
  if (shouldHoldInputForHookReview(screen)) return { kind: 'hook-review', composerBehind: false };
  return detectChoiceList(viewportLines(screen));
}

/** True when Enter belongs to a Codex selection surface instead of the composer. */
export function codexChoiceModalOwnsSubmitKey(screen: string): boolean {
  return detectCodexChoiceModal(screen) !== undefined;
}

export const CODEX_CHOICE_MODAL_VIEWPORT_LINES = VIEWPORT_LINES;
