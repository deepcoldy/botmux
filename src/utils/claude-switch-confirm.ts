import { stripAnsiForLog } from './crash-log.js';
import { stripAnsiScreenText } from './idle-detector.js';

/**
 * Claude Code's "switching re-reads the cached history" confirmation.
 *
 * When a conversation already has output and its prompt cache may still be
 * warm, `/effort <level>` and `/model <name>` do not switch at once. Claude
 * Code (2.1.319, one shared dialog component) first asks:
 *
 *     Change effort level?                       (or "Switch model?")
 *     Your next response will be slower and use more tokens
 *     This conversation is cached for the current effort level. Switching to
 *     max means the full history gets re-read.
 *     ❯ 1. Yes, switch to max                    (focused by default)
 *       2. No, go back
 *
 * The same dialog asks on behalf of a user-installed PreModelSwitch hook; then
 * the subtitle reads "A PreModelSwitch hook asked you to confirm" and the body
 * is the hook's own reason. The command is recorded in the transcript only once
 * the dialog is answered, and it never fires a hook — so an unanswered dialog
 * leaves the session parked with no way to answer it from the chat.
 *
 * Botmux typed the line itself in two places, and in both the line's own
 * argument already says which level/model is wanted:
 *  - a passthrough from the chat (`/effort max` typed by a user): the PTY-chunk
 *    {@link ClaudeSwitchConfirmGuard} armed for a few seconds after the write;
 *  - a bot startup command replayed into a resumed conversation: the worker
 *    reads the authoritative screen while the command is unconfirmed and asks
 *    {@link decideStartupSwitchConfirm}.
 */

export type ClaudeSwitchKind = 'effort' | 'model';

/** `/effort <level>` → 'effort', `/model <name>` → 'model'. Bare forms open a
 *  picker (unknown target) and multi-token lines are not a switch, so both are
 *  null — they never arm anything. */
export function claudeSwitchKindForCommand(content: string): ClaudeSwitchKind | null {
  const m = /^\s*\/(effort|model)\s+\S+\s*$/.exec(content);
  return m ? (m[1] as ClaudeSwitchKind) : null;
}

export type SwitchConfirmAction = 'pass' | 'confirm';

/** Collapsed (whitespace-stripped, lower-cased) title per dialog kind. */
const CHUNK_TITLE: Record<ClaudeSwitchKind, string> = {
  effort: 'changeeffortlevel',
  model: 'switchmodel',
};

/**
 * Passthrough guard: auto-confirm the dialog right after botmux wrote a
 * `/effort <level>` or `/model <name>` line typed by a chat user. Armed only by
 * that write (for the matching kind), so it never inspects arbitrary screens.
 * While armed it watches PTY chunks for the dialog's title followed by both
 * rendered option rows; on a match it reports `confirm` (the caller presses
 * Enter on the default "Yes" row) and disarms. A dialog raised for a user's
 * PreModelSwitch hook disarms without an answer. The caller also disarms on a
 * timeout, so a switch that needs no confirmation leaves no residue.
 */
export class ClaudeSwitchConfirmGuard {
  private kind: ClaudeSwitchKind | null = null;
  private tail = '';

  /** Arm after a `/effort <level>` / `/model <name>` passthrough is written. */
  arm(kind: ClaudeSwitchKind): void {
    this.kind = kind;
    this.tail = '';
  }

  /** Whether the guard is currently watching for the confirm dialog. */
  isArmed(): boolean {
    return this.kind !== null;
  }

  /** Stop watching (fired dialog, timed out, or CLI respawn). */
  disarm(): void {
    this.kind = null;
    this.tail = '';
  }

  reset(): void {
    this.disarm();
  }

  inspect(data: string): SwitchConfirmAction {
    if (!this.kind) return 'pass';

    const plain = stripAnsiForLog(data).replace(/\s+/g, '').toLowerCase();
    this.tail = (this.tail + plain).slice(-4_096);

    // Match structurally, and only *after* the most recent title, so stale
    // scrollback (e.g. an earlier assistant answer containing "yes") before a
    // half-drawn title can never be mistaken for the rendered options. The
    // dialog's numbered rows collapse to `1.yes…` / `2.no…` once ANSI cursor
    // moves and whitespace are stripped; requiring BOTH confirms the choices
    // have actually rendered before we press Enter.
    const titleAt = this.tail.lastIndexOf(CHUNK_TITLE[this.kind]);
    if (titleAt < 0) return 'pass';
    const afterTitle = this.tail.slice(titleAt);
    // A user's PreModelSwitch hook asking a person (reachable for `/model`) is
    // not ours to answer: stop watching and leave the dialog on screen.
    if (afterTitle.includes('hookaskedyoutoconfirm')) {
      this.disarm();
      return 'pass';
    }
    const hasYesRow = /1\.yes/.test(afterTitle);
    const hasNoRow = /2\.no/.test(afterTitle);
    if (!hasYesRow || !hasNoRow) return 'pass';

    // One-shot: disarm so a later composer redraw can't inherit menu words.
    this.disarm();
    return 'confirm';
  }
}

export interface ClaudeSwitchConfirmDialog {
  kind: ClaudeSwitchKind;
  /** What the accept row offers to switch to ("max", a model's display name…). */
  target: string;
  /** Why Claude asks: its own prompt-cache warning, a user PreModelSwitch hook,
   *  or wording this build does not know. */
  reason: 'cache' | 'hook' | 'unknown';
  /** The selection marker is on the accept row, so Enter accepts. */
  acceptFocused: boolean;
}

/** The dialog's OWN lines: text starts the line after at most a box border, a
 *  selection marker and a list number — prose quoting it mid-line does not. */
const LINE_PREFIX = String.raw`^[ \t│┃]*`;
const TITLE_RE = new RegExp(LINE_PREFIX + String.raw`(?:Change|Switch)(?: the)? (effort(?: level)?|model)\?[ \t]*$`, 'i');
const ACCEPT_RE = new RegExp(LINE_PREFIX + String.raw`([❯›>][ \t]*)?(?:\d+[.)][ \t]*)?Yes,? (?:switch|change) to (.+?)[ \t]*$`, 'i');
const CANCEL_RE = new RegExp(LINE_PREFIX + String.raw`(?:[❯›>][ \t]*)?(?:\d+[.)][ \t]*)?No\b`, 'i');
/** A composer frame (`────`). Claude draws the dialog INSTEAD of the composer,
 *  so a rule below the title means the "dialog" is history the composer
 *  follows — e.g. a resumed conversation that quotes this very dialog. */
const COMPOSER_RULE_RE = /─{8,}/;
/** How far up from the bottom the dialog may start (its own height is 6–7
 *  rows plus a hook reason of at most 7). */
const DIALOG_MAX_ROWS = 16;
const HOOK_REASON_RE = /\bhook\b/i;
const CACHE_REASON_RE = /\bcached\b|\bre-?read\b|more tokens/i;

/**
 * Recognize the switch confirmation on an authoritative screen (ANSI allowed).
 * The dialog must be what the bottom of the screen shows: the accept row
 * directly followed by the cancel row, the title above them within the dialog's
 * height, and no composer frame anywhere below the title. Wording is matched
 * loosely (Change/Switch, effort/effort level/model, optional list numbers) so a
 * reworded build still matches; anything that is not this dialog is null.
 */
export function detectClaudeSwitchConfirmDialog(rawScreen: string): ClaudeSwitchConfirmDialog | null {
  const lines = stripAnsiScreenText(rawScreen ?? '').split(/\r?\n/).map(line => line.replace(/\s+$/, ''));
  let last = lines.length - 1;
  while (last >= 0 && !lines[last]!.trim()) last--;
  if (last < 0) return null;
  const top = Math.max(0, last - DIALOG_MAX_ROWS);

  // Cancel row: the last such row near the bottom; accept row: the non-blank
  // line right above it.
  let cancelAt = -1;
  for (let i = last; i >= top; i--) {
    if (CANCEL_RE.test(lines[i]!)) { cancelAt = i; break; }
  }
  if (cancelAt < 0) return null;
  let acceptAt = cancelAt - 1;
  while (acceptAt >= top && !lines[acceptAt]!.trim()) acceptAt--;
  const accept = acceptAt >= top ? ACCEPT_RE.exec(lines[acceptAt]!) : null;
  if (!accept) return null;

  let titleAt = -1;
  let title: RegExpExecArray | null = null;
  for (let i = acceptAt - 1; i >= top; i--) {
    title = TITLE_RE.exec(lines[i]!);
    if (title) { titleAt = i; break; }
  }
  if (!title) return null;
  for (let i = titleAt + 1; i <= last; i++) {
    if (COMPOSER_RULE_RE.test(lines[i]!)) return null;
  }

  const body = lines.slice(titleAt + 1, acceptAt).join('\n');
  const reason = HOOK_REASON_RE.test(body) ? 'hook' : CACHE_REASON_RE.test(body) ? 'cache' : 'unknown';
  return {
    kind: /effort/i.test(title[1]!) ? 'effort' : 'model',
    target: accept[2]!,
    reason,
    acceptFocused: !!accept[1],
  };
}

/**
 * What to do about a switch confirmation while botmux's own startup command
 * `commandLine` is still unconfirmed. `accept`: Claude's own prompt-cache
 * warning for a switch of this line's kind (effort / model), with "Yes" focused
 * — the bot's configuration already decided, so Enter accepts. The offered
 * target is deliberately not compared with the line's argument: Claude shows
 * what it resolved the argument to (a model's display name for `/model opus`,
 * `high` for `/effort max` on a model without max), so a strict comparison would
 * strand exactly the sessions this exists for. `leave`: a dialog of this kind
 * is up but is not that warning (a user's PreModelSwitch hook asking for a
 * person, unknown wording, or the marker moved off "Yes") — it stays for a
 * person and the command keeps the queue held. null: no such dialog for this line.
 */
export function decideStartupSwitchConfirm(
  rawScreen: string,
  commandLine: string,
): { accept: boolean; detail: string } | null {
  const kind = claudeSwitchKindForCommand(commandLine);
  if (!kind) return null;
  const dialog = detectClaudeSwitchConfirmDialog(rawScreen);
  if (!dialog || dialog.kind !== kind) return null;
  const detail = `${kind} switch confirmation to "${dialog.target}" (${dialog.reason}${dialog.acceptFocused ? '' : ', accept not focused'})`;
  return { accept: dialog.reason === 'cache' && dialog.acceptFocused, detail };
}
