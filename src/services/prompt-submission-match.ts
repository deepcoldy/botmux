/**
 * prompt-submission-match.ts
 *
 * Which written turn a UserPromptSubmit hook's prompt was. The hook reports
 * only a fingerprint and a prefix of what the CLI submitted (the same pair
 * prompt-context-store keys sidecars by); the worker knows what it wrote.
 * A turn counts as submitted only when the prompt is its text (same
 * fingerprint) or starts with it (a prefix unique to one written turn: the
 * CLI appended a later write to the same input box). A prefix shared by two
 * written turns proves neither — workflow wakes of one session open with the
 * same static preamble, so their first 30 chars are identical, and crediting
 * the older entry would accept a turn whose wake the daemon no longer tracks
 * while the submitted one waits for the hold cap. A box cleared with Esc and
 * another prompt typed in its place submits none of the turns written before.
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

  /** The turn this submitted prompt was, forgotten once matched. The prefix
   *  fallback resolves only while it is unique: a shared prefix cannot tell
   *  two written turns apart, so it resolves nothing and consumes nothing. */
  takeSubmitted(prompt: SubmittedPrompt): string | undefined {
    if (prompt.fingerprint) {
      const index = this.written.findIndex((entry) => entry.fingerprint === prompt.fingerprint);
      if (index >= 0) {
        const [entry] = this.written.splice(index, 1);
        return entry.turnId;
      }
    }
    if (!prompt.prefix) return undefined;
    const matches: number[] = [];
    for (let i = 0; i < this.written.length; i++) {
      if (this.written[i].prefix !== '' && this.written[i].prefix === prompt.prefix) matches.push(i);
    }
    if (matches.length !== 1) return undefined;
    const [entry] = this.written.splice(matches[0], 1);
    return entry.turnId;
  }
}
