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

  take(status: string, turn: { turnId?: string; dispatchAttempt?: number }): PromptSuggestionNotice | undefined {
    const text = this.onScreen.text;
    if (status !== 'idle' || !text || !turn.turnId) return undefined;
    // A frame captured before the screen changed hands (a new turn's input is
    // written but not echoed yet) still shows the previous turn's suggestion.
    if (this.onScreen.turnKey !== turnKey(turn)) return undefined;
    const key = JSON.stringify([turnKey(turn), text]);
    if (key === this.lastSent) return undefined;
    this.lastSent = key;
    return {
      text,
      turnId: turn.turnId,
      ...(turn.dispatchAttempt !== undefined ? { dispatchAttempt: turn.dispatchAttempt } : {}),
    };
  }
}

function turnKey(turn: { turnId?: string; dispatchAttempt?: number }): string {
  return JSON.stringify([turn.turnId ?? null, turn.dispatchAttempt ?? null]);
}
