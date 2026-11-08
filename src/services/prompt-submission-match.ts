/**
 * prompt-submission-match.ts
 *
 * Which written turn a UserPromptSubmit hook's prompt was. The hook reports
 * only a fingerprint and a prefix of what the CLI submitted (the same pair
 * prompt-context-store keys sidecars by); the worker knows what it wrote.
 * A turn counts as submitted only when the prompt is its text (same
 * fingerprint) or starts with it (same prefix: the CLI appended a later
 * write to the same input box). A box cleared with Esc and another prompt
 * typed in its place submits none of the turns written before.
 */
import { fingerprintPromptText, prefixOf } from './prompt-context-store.js';

/** Written turns remembered until a submit matches them. */
const WRITTEN_INPUTS_MAX = 16;

export interface SubmittedPrompt {
  fingerprint?: string;
  prefix?: string;
}

export class WrittenInputLedger {
  private written: Array<{ turnId: string; fingerprint: string; prefix: string }> = [];

  noteWritten(turnId: string, content: string): void {
    this.written = this.written.filter((entry) => entry.turnId !== turnId);
    this.written.push({ turnId, fingerprint: fingerprintPromptText(content), prefix: prefixOf(content) });
    if (this.written.length > WRITTEN_INPUTS_MAX) this.written.shift();
  }

  /** The turn this submitted prompt was, forgotten once matched. Among
   *  turns with the same prefix, the earliest written: the CLI submits
   *  in write order. */
  takeSubmitted(prompt: SubmittedPrompt): string | undefined {
    const index = prompt.fingerprint
      ? this.written.findIndex((entry) => entry.fingerprint === prompt.fingerprint)
      : -1;
    const at = index >= 0 || !prompt.prefix
      ? index
      : this.written.findIndex((entry) => entry.prefix !== '' && entry.prefix === prompt.prefix);
    if (at < 0) return undefined;
    const [entry] = this.written.splice(at, 1);
    return entry.turnId;
  }
}
