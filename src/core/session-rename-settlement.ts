import type { SessionRenameSurface } from '../adapters/cli/types.js';

/**
 * When may queued input follow a native session rename?
 *
 * The rename is typed into the CLI's own composer (`/rename <title>` + Enter).
 * Codex-family TUIs (TRAE 0.216.0, Codex 0.167.0 — recorded) take that Enter
 * as a pasted newline when the command text and the Enter reach them in one
 * read; the command then waits in the composer, and the next Lark message is
 * appended to it: its Enter renames the thread to `<title>\n<message>` and the
 * message never becomes a turn. A quiet screen that still holds the command is
 * indistinguishable from a finished rename to prompt detection, and the old
 * bounded wait simply released input after 5s.
 *
 * - No adapter verdict (`surface` undefined: the CLI has no judge, or this
 *   backend's screen cannot drive input): keep the historical fail-open.
 * - `unsubmitted`: our exact command is still in the composer. One Enter
 *   submits it. Only from the bounded wait, never from a prompt edge that can
 *   race the CLI's own redraw; after that one Enter, keep holding. (If the CLI
 *   was merely slow to read the original Enter, this Enter reaches an empty
 *   composer, where TRAE 0.216.0 and Codex 0.167.0 do nothing.)
 * - The CLI's durable record of this exact rename proves the command left the
 *   composer — release.
 * - `settled` proves only an EMPTY composer, which is also what the screen
 *   showed before a stalled TUI read the command at all: releasing then lets
 *   the next message reach the TUI in the same read as the rename (recorded:
 *   a 5.3s stall renamed the thread to `<title>\n<message>`). It releases only
 *   together with terminal output since the command was typed, i.e. after the
 *   TUI has consumed it.
 * - Anything else proves neither outcome: keep holding and re-read.
 */
export type SessionRenameSettlement = 'release' | 'resubmit' | 'hold';

export function decideSessionRenameSettlement(state: {
  surface: SessionRenameSurface | undefined;
  /** The CLI durably recorded this exact title since the command was typed. */
  recorded: boolean;
  /** The terminal drew output after the command started to be typed, or the
   *  write failed part-way so no such evidence is owed. */
  consumed: boolean;
  /** The one recovery Enter was already pressed for this rename. */
  resubmitted: boolean;
  /** A screen-idle prompt edge (true) or the bounded wait (false). */
  fromPrompt: boolean;
}): SessionRenameSettlement {
  if (state.surface === undefined) return 'release';
  if (state.surface === 'unsubmitted') {
    return state.resubmitted || state.fromPrompt ? 'hold' : 'resubmit';
  }
  if (state.recorded) return 'release';
  return state.surface === 'settled' && state.consumed ? 'release' : 'hold';
}
