import { stripAnsiForLog } from './crash-log.js';

export type EffortConfirmAction = 'pass' | 'confirm';

/**
 * Auto-confirm Claude Code's mid-session "Change effort level?" dialog.
 *
 * When botmux passes a fully-qualified `/effort <level>` command through to
 * Claude Code *during* a session, the client shows a Yes/No confirmation
 * ("This conversation is cached… Switching to <level> means the full history
 * gets re-read"). The user already expressed the target level when they typed
 * the command, so the second confirmation is pure friction — and because this
 * native slash dialog fires no hook (unlike AskUserQuestion) and is not caught
 * by any screen detector, an un-answered dialog silently parks the session on a
 * green "awaiting input" card with no way to answer from Feishu.
 *
 * This guard is *armed* only by botmux's own `/effort <level>` passthrough, so
 * it never inspects arbitrary screens. While armed it watches PTY chunks for
 * the effort dialog's distinctive title plus a rendered confirm option; on a
 * match it reports `confirm` (the caller presses Enter on the default "Yes"
 * row) and disarms. The caller also disarms on a timeout, so a `/effort` that
 * needs no confirmation (e.g. first use in a fresh session) leaves no residue.
 *
 * Bare `/effort` (no level) opens a level *picker*, not a Yes/No confirm — the
 * target is unknown, so it is intentionally NOT armed here.
 */
export class EffortConfirmDialogGuard {
  private armed = false;
  private tail = '';

  /** Arm after a `/effort <level>` passthrough is written to the CLI. */
  arm(): void {
    this.armed = true;
    this.tail = '';
  }

  /** Whether the guard is currently watching for the confirm dialog. */
  isArmed(): boolean {
    return this.armed;
  }

  /** Stop watching (fired dialog, timed out, or CLI respawn). */
  disarm(): void {
    this.armed = false;
    this.tail = '';
  }

  reset(): void {
    this.disarm();
  }

  inspect(data: string): EffortConfirmAction {
    if (!this.armed) return 'pass';

    const plain = stripAnsiForLog(data).replace(/\s+/g, '').toLowerCase();
    this.tail = (this.tail + plain).slice(-4_096);

    // Match structurally, and only *after* the most recent title, so stale
    // scrollback (e.g. an earlier assistant answer containing "yes") before a
    // half-drawn title can never be mistaken for the rendered options. The
    // dialog's numbered rows collapse to `1.yes…` / `2.no…` once ANSI cursor
    // moves and whitespace are stripped; requiring BOTH confirms the choices
    // have actually rendered before we press Enter.
    const titleAt = this.tail.lastIndexOf('changeeffortlevel');
    if (titleAt < 0) return 'pass';
    const afterTitle = this.tail.slice(titleAt);
    const hasYesRow = /1\.yes/.test(afterTitle);
    const hasNoRow = /2\.no/.test(afterTitle);
    if (!hasYesRow || !hasNoRow) return 'pass';

    // One-shot: disarm so a later composer redraw can't inherit menu words.
    this.disarm();
    return 'confirm';
  }
}

/** True for `/effort <level>` (a confirmable switch), false for bare `/effort`
 *  (a level picker), a multi-token line, or any other command. Anchored to a
 *  single argument so only the confirm-dialog form arms the guard. */
export function isEffortLevelCommand(content: string): boolean {
  return /^\s*\/effort\s+\S+\s*$/.test(content);
}
