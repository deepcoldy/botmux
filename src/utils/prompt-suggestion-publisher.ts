/**
 * Worker-side gate between screen samples and the `prompt_suggestion` IPC.
 *
 * The screen sampler only re-reads a frame when the pane produced output, so
 * the last observed suggestion stands for every tick until the next capture.
 * A suggestion is sent while the CLI is idle and a botmux turn owns the
 * screen, once per (turn, attempt, text): an unchanged frame never repeats
 * it, and only a frame captured under the current turn counts for it.
 */
export interface PromptSuggestionNotice {
  text: string;
  turnId: string;
  dispatchAttempt?: number;
}

export class PromptSuggestionPublisher {
  private onScreen: { text: string | undefined; turnKey: string } = { text: undefined, turnKey: '' };
  private lastSent = '';

  /** The suggestion read from a freshly captured frame (undefined = none),
   * with the turn that owned the screen when the frame was captured. */
  observe(text: string | undefined, turn: { turnId?: string; dispatchAttempt?: number }): void {
    this.onScreen = { text, turnKey: turnKey(turn) };
  }

  /** `reportAs`: the turn the suggestion answers when it is not the one
   * owning the screen (see promptSuggestionReportTurn). */
  take(
    status: string,
    turn: { turnId?: string; dispatchAttempt?: number },
    reportAs: { turnId?: string; dispatchAttempt?: number } = turn,
  ): PromptSuggestionNotice | undefined {
    const text = this.onScreen.text;
    if (status !== 'idle' || !text || !turn.turnId || !reportAs.turnId) return undefined;
    // A frame captured before the screen changed hands (a new turn's input is
    // written but not echoed yet) still shows the previous turn's suggestion.
    if (this.onScreen.turnKey !== turnKey(turn)) return undefined;
    const key = JSON.stringify([turnKey(reportAs), text]);
    if (key === this.lastSent) return undefined;
    this.lastSent = key;
    return {
      text,
      turnId: reportAs.turnId,
      ...(reportAs.dispatchAttempt !== undefined ? { dispatchAttempt: reportAs.dispatchAttempt } : {}),
    };
  }
}

/** A type-ahead turn the CLI folded into the turn owning the screen (`into`). */
export interface FoldedTypeAheadTurn {
  turnId: string;
  dispatchAttempt?: number;
  into?: string;
}

/**
 * The turn a suggestion on screen answers. Input typed while a turn runs can
 * be folded into it by the CLI: both end together, the folded turn's record is
 * retired at its terminal, and the screen keeps belonging to the earlier turn
 * — while the session's latest turn, and its last reply card, is the folded
 * one. Once the screen's own turn has ended, the suggestion answers the newest
 * turn folded into it.
 */
export function promptSuggestionReportTurn(
  current: { turnId?: string; dispatchAttempt?: number },
  folded: FoldedTypeAheadTurn | undefined,
  ended: (turnId: string, dispatchAttempt?: number) => boolean,
): { turnId?: string; dispatchAttempt?: number } {
  if (!current.turnId || !ended(current.turnId, current.dispatchAttempt)) return current;
  if (!folded || folded.into !== current.turnId) return current;
  return { turnId: folded.turnId, dispatchAttempt: folded.dispatchAttempt };
}

function turnKey(turn: { turnId?: string; dispatchAttempt?: number }): string {
  return JSON.stringify([turn.turnId ?? null, turn.dispatchAttempt ?? null]);
}
