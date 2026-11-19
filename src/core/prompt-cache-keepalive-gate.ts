/**
 * Worker-side write gate for unattended maintenance input — the prompt-cache
 * keep-alive and the auto / idle `/compact` (pure, unit-tested).
 *
 * The line is typed and submitted with Enter while nobody is watching, so
 * "idle" is not enough: Claude's permission dialog and AskUserQuestion picker
 * are static screens that match the adapter's readyPattern (`❯`) and read as
 * idle, and an Enter there selects the highlighted choice — an unattended
 * approval. The write therefore needs POSITIVE screen evidence that the cursor
 * sits in the real composer (a prompt framed by input box rules above and
 * below), and fails closed whenever that evidence is missing: a skipped ping
 * costs one cache refresh, a wrong one approves a tool.
 *
 * The composer must also be EMPTY: a half-typed draft left in the web or local
 * terminal still sits between the two rules, and the line would be appended to
 * it and submitted as a real turn. Text Claude paints greyed out (SGR 2) in an
 * empty composer — its predicted next prompt, the `Try "…"` example — is not a
 * draft: typing replaces it and a bare Enter does not submit it. Typed text,
 * a pasted-text chip and a recalled history entry are never dim, so dim-only
 * content is the one shape read as empty.
 *
 * The caller passes `screen: undefined` for backends whose viewport is not
 * authoritative (zmx can carry stale scrollback), and reads the backend's own
 * viewport where it has one (see the worker's unattendedComposerScreen): the
 * long-lived renderer keeps its spawn size while a web terminal resizes the
 * real pane, and the stream it renders then no longer reproduces the screen.
 */
import { claudeActionPrompt, screenHasUnresolvedPermissionQuestion } from '../services/claude-action-prompt.js';
import { codexNativeComposerState } from '../services/codex-terminal-session.js';
import { screenShowsFramedPrompt } from '../utils/input-gate.js';
import { screenRowText, type ScreenRow } from '../utils/terminal-cells.js';
import { maskFailureText } from '../workflows/v3/draft-failure.js';
import type { PtyHandle } from '../adapters/cli/types.js';
import type { PromptCacheKeepaliveRefusal } from './unattended-input-refusal.js';

export interface PromptCacheKeepaliveWriteProbe {
  hasBackend: boolean;
  restarting: boolean;
  promptReady: boolean;
  /** A botmux-managed TUI prompt (picker / ask) is open. */
  tuiPromptOpen: boolean;
  bareShell: boolean;
  /** Any queued or in-flight user message, raw input, injection or rename. */
  inputPending: boolean;
  /** Current viewport as cells, box drawing kept; undefined when this backend
   *  has no authoritative screen. */
  screen?: readonly ScreenRow[];
  readyPattern?: RegExp;
  /** Unattended Codex maintenance uses cursor + native footer evidence rather
   * than Claude's framed-composer shape. Omitted for Claude keep-alives. */
  cliId?: string;
  codexInputState?: ReturnType<NonNullable<PtyHandle['captureInputState']>>;
}

export type { PromptCacheKeepaliveRefusal };

/** Rows as the text recognizers read (each row's trailing blanks dropped). */
export function screenRowsText(rows: readonly ScreenRow[]): string {
  return rows.map(row => screenRowText(row).trimEnd()).join('\n');
}

function singleMatch(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
}

/** Index of the LAST row whose text matches readyPattern — the row
 *  screenShowsFramedPrompt anchors on. */
function lastPromptRow(rows: readonly ScreenRow[], readyPattern: RegExp): number {
  const pattern = singleMatch(readyPattern);
  for (let y = rows.length - 1; y >= 0; y--) {
    if (pattern.test(screenRowText(rows[y]))) return y;
  }
  return -1;
}

export type ComposerContent = 'empty' | 'ghost' | 'draft';

/**
 * What the prompt row holds besides the prompt marker itself: nothing, only
 * greyed-out ghost text, or anything else (a draft). Ghost means every visible
 * cell is dim, except the one inverse cell Claude draws as its cursor, and at
 * least one is dim: a lone inverse character is a one-letter draft under the
 * cursor, so it stays a draft.
 */
export function composerContent(row: ScreenRow, readyPattern: RegExp): ComposerContent {
  const text = screenRowText(row);
  const match = singleMatch(readyPattern).exec(text);
  const start = match?.index ?? -1;
  const end = match ? match.index + match[0].length : -1;
  let offset = 0;
  let visible = 0;
  let dim = 0;
  let plain = 0;
  for (const cell of row) {
    const at = offset;
    offset += cell.ch.length;
    if (at >= start && at < end) continue;
    if (!cell.ch.trim()) continue;
    visible += 1;
    if (cell.dim) dim += 1;
    else if (!cell.inverse) plain += 1;
  }
  if (visible === 0) return 'empty';
  return plain === 0 && dim > 0 ? 'ghost' : 'draft';
}

/** Why the write must not happen now; undefined = safe to write. */
export function promptCacheKeepaliveRefusal(probe: PromptCacheKeepaliveWriteProbe): PromptCacheKeepaliveRefusal | undefined {
  if (!probe.hasBackend) return 'no_backend';
  if (probe.restarting) return 'restarting';
  if (!probe.promptReady) return 'prompt_not_ready';
  if (probe.tuiPromptOpen) return 'tui_prompt_open';
  if (probe.bareShell) return 'bare_shell';
  if (probe.inputPending) return 'input_pending';
  if (probe.cliId === 'codex') {
    if (!probe.codexInputState) return 'no_screen_evidence';
    const state = codexNativeComposerState(probe.codexInputState);
    if (state === 'draft') return 'composer_not_empty';
    return state === 'empty' ? undefined : 'prompt_not_framed';
  }
  if (!probe.screen || probe.screen.length === 0 || !probe.readyPattern) return 'no_screen_evidence';
  const text = screenRowsText(probe.screen);
  if (claudeActionPrompt(text, { footerAnywhere: true })) return 'action_prompt_open';
  // Also fail closed on a dialog the notification parser deliberately does
  // not reconstruct (question wrapped past the join window / 400-char cap):
  // the screen still carries the hard choices+footer evidence.
  if (screenHasUnresolvedPermissionQuestion(text)) return 'action_prompt_open';
  if (!screenShowsFramedPrompt(text, probe.readyPattern)) return 'prompt_not_framed';
  const prompt = lastPromptRow(probe.screen, probe.readyPattern);
  if (prompt < 0 || composerContent(probe.screen[prompt], probe.readyPattern) === 'draft') return 'composer_not_empty';
  return undefined;
}

const LOG_TAIL_ROWS = 8;
const LOG_ROW_MAX_CHARS = 100;

/**
 * The bottom of the judged screen for a refusal log line: the shape the gate
 * read, without what the user typed. Runs of box rules are counted (`─×214`),
 * the prompt row keeps its marker and says only how much it holds and whether
 * that was ghost text, other rows are credential-masked and clipped.
 */
export function composerScreenLogTail(rows: readonly ScreenRow[], readyPattern: RegExp | undefined): string[] {
  const prompt = readyPattern ? lastPromptRow(rows, readyPattern) : -1;
  const out: string[] = [];
  for (let y = rows.length - 1; y >= 0 && out.length < LOG_TAIL_ROWS; y--) {
    const raw = screenRowText(rows[y]).trimEnd();
    if (!raw.trim()) continue;
    let line: string;
    if (y === prompt && readyPattern) {
      const content = composerContent(rows[y], readyPattern);
      const marker = singleMatch(readyPattern).exec(raw);
      const chars = Array.from(raw.replace(singleMatch(readyPattern), '').trim()).length;
      line = content === 'empty'
        ? raw.trim()
        : `${marker?.[0] ?? ''} ‹${chars} chars, ${content === 'ghost' ? 'dim ghost text' : 'typed'}›`;
    } else {
      line = maskFailureText(raw).replace(/─{4,}/g, run => `─×${run.length}`);
      if (line.length > LOG_ROW_MAX_CHARS) line = `${line.slice(0, LOG_ROW_MAX_CHARS - 1)}…`;
    }
    out.unshift(line);
  }
  return out;
}
