/**
 * prompt-submission-match.ts
 *
 * Which written turn a UserPromptSubmit hook's prompt was. The hook reports
 * only a fingerprint and a prefix of what the CLI submitted (the same pair
 * prompt-context-store keys sidecars by); the worker knows what it wrote.
 * A turn counts as submitted only when the prompt is its text (same
 * fingerprint) or starts with it (a prefix unique to one written turn and
 * never used by a claim before: the CLI appended a later write to the same
 * input box). A prefix shared by two written turns proves neither — workflow
 * wakes of one session open with the same static preamble, so their first
 * 30 chars are identical, and crediting the older entry would accept a turn
 * whose wake the daemon no longer tracks while the submitted one waits for
 * the hold cap. A prefix that already backed a claim never backs another:
 * text recalled from input history (Up-arrow) after its turn was consumed
 * has no fingerprint entry left, and the unique-prefix fallback would
 * otherwise credit the wake currently held for text its CLI never took.
 * Such a prompt is left to the transcript proof. A box cleared with Esc and
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
  /** Prefixes that already backed a claim, never evidence again. */
  private taintedPrefixes = new Set<string>();

  noteWritten(turnId: string, content: string): void {
    this.written = this.written.filter((entry) => entry.turnId !== turnId);
    this.written.push({ turnId, fingerprint: fingerprintPromptText(content), prefix: prefixOf(content) });
    if (this.written.length > WRITTEN_INPUTS_MAX) this.written.shift();
  }

  /** The turn this submitted prompt was, forgotten once matched. The prefix
   *  fallback resolves only while it is unique and unclaimed: a shared or
   *  already-spent prefix cannot tell two written turns apart, so it resolves
   *  nothing and consumes nothing. */
  takeSubmitted(prompt: SubmittedPrompt): string | undefined {
    if (prompt.fingerprint) {
      const index = this.written.findIndex((entry) => entry.fingerprint === prompt.fingerprint);
      if (index >= 0) {
        const [entry] = this.written.splice(index, 1);
        if (entry.prefix) this.taintedPrefixes.add(entry.prefix);
        return entry.turnId;
      }
    }
    if (!prompt.prefix || this.taintedPrefixes.has(prompt.prefix)) return undefined;
    const matches: number[] = [];
    for (let i = 0; i < this.written.length; i++) {
      if (this.written[i].prefix !== '' && this.written[i].prefix === prompt.prefix) matches.push(i);
    }
    if (matches.length !== 1) return undefined;
    const [entry] = this.written.splice(matches[0], 1);
    if (entry.prefix) this.taintedPrefixes.add(entry.prefix);
    return entry.turnId;
  }
}
