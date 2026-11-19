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
 * The same rule applies to text the ledger forgot: an entry pushed out by
 * the size cap, or replaced by a rewrite of its turn that opens differently,
 * loses its fingerprint, so its prefix is spent as well — a recalled copy
 * must not reach a later entry that happens to share it. A rewrite keeping
 * the opening leaves the prefix naming that same turn. Such a prompt is left
 * to the transcript proof. A box cleared with Esc and another prompt typed
 * in its place submits none of the turns written before.
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
  /** Prefixes that can no longer be evidence: spent by a claim or orphaned
   *  when their fingerprint was forgotten (eviction, a rewrite that changes
   *  the opening). The set lives for the worker process; each entry is at
   *  most 30 chars and one is added per distinct prefix actually written, so
   *  it stays small. */
  private taintedPrefixes = new Set<string>();

  noteWritten(turnId: string, content: string): void {
    const fingerprint = fingerprintPromptText(content);
    const prefix = prefixOf(content);
    // A turn rewritten with a different opening abandons the old prefix: with
    // its fingerprint gone it must not survive as fallback evidence. A kept
    // opening still names only this turn, so it stays usable.
    for (const entry of this.written) {
      if (entry.turnId === turnId && entry.prefix !== prefix && entry.prefix) {
        this.taintedPrefixes.add(entry.prefix);
      }
    }
    this.written = this.written.filter((entry) => entry.turnId !== turnId);
    this.written.push({ turnId, fingerprint, prefix });
    while (this.written.length > WRITTEN_INPUTS_MAX) {
      const [evicted] = this.written.splice(0, 1);
      if (evicted.prefix) this.taintedPrefixes.add(evicted.prefix);
    }
  }

  /** The turn this submitted prompt was, forgotten once matched. The prefix
   *  fallback resolves only while it is unique and unclaimed: a shared,
   *  spent or orphaned prefix cannot tell two written turns apart, so it
   *  resolves nothing and consumes nothing. */
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
