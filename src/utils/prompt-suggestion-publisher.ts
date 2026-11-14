/**
 * Worker-side gate between screen samples and the `prompt_suggestion` IPC.
 *
 * The screen sampler only re-reads a frame when the pane produced output, so
 * the last observed suggestion stands for every tick until the next capture.
 * A suggestion is sent while the CLI is idle and a botmux turn owns the
 * screen, once per (turn, attempt, text): an unchanged frame never repeats
 * it, and the same text after the next turn is that turn's suggestion.
 */
export interface PromptSuggestionNotice {
  text: string;
  turnId: string;
  dispatchAttempt?: number;
}

export class PromptSuggestionPublisher {
  private onScreen: string | undefined;
  private lastSent = '';

  /** The suggestion read from a freshly captured frame (undefined = none). */
  observe(text: string | undefined): void {
    this.onScreen = text;
  }

  take(status: string, turn: { turnId?: string; dispatchAttempt?: number }): PromptSuggestionNotice | undefined {
    if (status !== 'idle' || !this.onScreen || !turn.turnId) return undefined;
    const key = JSON.stringify([turn.turnId, turn.dispatchAttempt ?? null, this.onScreen]);
    if (key === this.lastSent) return undefined;
    this.lastSent = key;
    return {
      text: this.onScreen,
      turnId: turn.turnId,
      ...(turn.dispatchAttempt !== undefined ? { dispatchAttempt: turn.dispatchAttempt } : {}),
    };
  }
}
