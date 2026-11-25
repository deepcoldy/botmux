import type { SessionRenameSurface } from '../adapters/cli/types.js';

/**
 * When may queued input follow a native session rename?
 *
 * The rename is typed into the CLI's own composer (`/rename <title>` + Enter).
 * Codex-family TUIs (TRAE 0.216.0, Codex 0.167.0 — recorded) take that Enter
 * as a pasted newline when the command text and the Enter reach them in one
 * read; the command then waits in the composer, and the next Lark message is
 * appended to it: its Enter renames the thread to `<title>\n<message>`.
 *
 * - No adapter verdict (`surface` undefined: the CLI has no judge, or this
 *   backend's screen cannot drive input): keep the historical fail-open.
 * - `unsubmitted`: our exact command is still in the composer. One Enter
 *   submits it. Only from the bounded wait, never from a prompt edge that can
 *   race the CLI's own redraw; after that one Enter, keep holding.
 * - `occupied`: a dialog, busy turn or user draft owns the terminal. A rename
 *   receipt says nothing about this CURRENT input owner, so keep holding.
 * - A durable record for this exact native thread and title proves this rename
 *   left the composer. It may release an empty (`settled`) or unrecognised
 *   (`unknown`) surface — the latter keeps working across footer redesigns.
 * - An empty composer alone proves nothing: it is also the pre-rename screen
 *   while a stalled TUI has not read the command. Arbitrary terminal output
 *   cannot fill that gap; nor can an ambiguous write failure.
 */
export type SessionRenameSettlement = 'release' | 'resubmit' | 'hold';

/** A structural pre-write refusal is safe to retry: SubmissionWriteError sets
 * `submissionStarted=false` only when its write callback never ran or the
 * writer proved zero bytes left. Ordinary text/Enter errors stay ambiguous. */
export function sessionRenameWriteFailureAction(err: unknown): 'retry' | 'hold' {
  if (typeof err !== 'object' || err === null) return 'hold';
  return (err as { submissionStarted?: unknown }).submissionStarted === false ? 'retry' : 'hold';
}

export function decideSessionRenameSettlement(state: {
  surface: SessionRenameSurface | undefined;
  /** This exact native thread durably recorded this exact title since arm. */
  recorded: boolean;
  /** The one recovery Enter was already pressed for this rename. */
  resubmitted: boolean;
  /** A screen-idle prompt edge (true) or the bounded wait (false). */
  fromPrompt: boolean;
}): SessionRenameSettlement {
  if (state.surface === undefined) return 'release';
  if (state.surface === 'unsubmitted') {
    return state.resubmitted || state.fromPrompt ? 'hold' : 'resubmit';
  }
  if (state.surface === 'occupied') return 'hold';
  return state.recorded ? 'release' : 'hold';
}

/** Missing a rename receipt must never authorize typing into the old CLI.
 * A private, positively idle CLI can instead be replaced, preserving its
 * native conversation and all inputs that have not yet been submitted.
 * Unknown/occupied surfaces still require the existing manual recovery. */
export function shouldRecoverUnconfirmedSessionRename(state: {
  surface: SessionRenameSurface | undefined;
  elapsedMs: number;
  timeoutMs: number;
  hasQueuedInput: boolean;
  alreadyRecovered: boolean;
  mayRestart: boolean;
}): boolean {
  return state.surface === 'settled'
    && state.elapsedMs >= state.timeoutMs
    && state.hasQueuedInput
    && !state.alreadyRecovered
    && state.mayRestart;
}
