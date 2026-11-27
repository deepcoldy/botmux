import { readdirSync } from 'node:fs';
import {
  listAntigravityUserInputMatchOffsets,
  resolveAntigravityCandidateMinByteOffset,
  resolveAntigravityTranscriptPath,
} from './antigravity-transcript.js';

/**
 * Native-consumption proof for Antigravity (`agy`) submits.
 *
 * history.jsonl is shared by every agy on the host, keys lines by a 40-char
 * prefix, has no conversation id on a fresh conversation's first submit and
 * truncates long inputs, and a busy agy logs an Enter there long before the
 * model gets the input. So it only says "an Enter with this opening landed
 * somewhere". The proof instead is a USER_INPUT in the transcript of this
 * pane's own conversation (resolved from its process-scoped `--log-file` or
 * pid) whose whole unwrapped payload hashes to the submitted text, appended
 * after the write-time baseline.
 *
 * Identical texts are the hard part: a record cannot say which of several
 * same-text submits it belongs to, and agy can drop a queued input (Esc), so
 * FIFO order is not reliable either. Every record is therefore claimed by at
 * most one submit, and a submit only claims while it is the sole unresolved
 * submit of its text: any other same-text submit that might still own a
 * record after this baseline makes the proof fail closed (a missing receipt
 * only falls back to the terminal path; a wrong one misattributes replies).
 */

/** What the conversation's transcript looked like when an input was written. */
export interface AntigravitySubmitBaseline {
  /** Conversation the pane was in at write time (process-scoped log / pid). */
  conversationId?: string;
  /** Transcript resolved for that conversation at write time, if on disk. */
  transcriptPath: string | null;
  /** Its byte size at write time. */
  transcriptSize: number;
  /** No transcript existed yet for the conversation this input lands in, so
   *  everything agy later writes there is post-submit. */
  transcriptCreatedAfter: boolean;
  /** Fresh launch with no conversation yet: conversations already on disk at
   *  write time. A later `/resume` into one of them is not this submit's new
   *  conversation. Undefined when the snapshot failed (fails closed). */
  preexistingConversations?: ReadonlySet<string>;
}

/** Byte offset in `path` (the current transcript of `conversationId`) from
 *  which records are post-write for `baseline`; undefined when the baseline
 *  does not describe this conversation or cannot be aligned with this file. */
export function antigravityBaselineMinOffset(
  conversationId: string,
  path: string,
  baseline: AntigravitySubmitBaseline,
): number | undefined {
  if (baseline.transcriptPath) {
    if (conversationId !== baseline.conversationId) return undefined;
    const mapped = resolveAntigravityCandidateMinByteOffset(
      { minByteOffset: baseline.transcriptSize, sampledTranscriptPath: baseline.transcriptPath }, path);
    return mapped ?? undefined;
  }
  if (!baseline.transcriptCreatedAfter) return undefined;
  if (baseline.conversationId) return baseline.conversationId === conversationId ? 0 : undefined;
  if (!baseline.preexistingConversations || baseline.preexistingConversations.has(conversationId)) return undefined;
  return 0;
}

/** Conversation ids that already have a brain directory. */
export function snapshotAntigravityConversations(brainDir: string): ReadonlySet<string> | undefined {
  try {
    return new Set(readdirSync(brainDir));
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? new Set() : undefined;
  }
}

export interface AntigravitySubmitEntry {
  readonly sha: string;
  readonly baseline: AntigravitySubmitBaseline;
  /** Write order within this pane. */
  readonly seq: number;
  claim?: { conversationId: string; path: string; offset: number };
  /** Ledger seq at which the worker reported this input's turn finished.
   *  Its record, if any, precedes every submit written after that point. */
  settledAtSeq?: number;
}

const MAX_TRACKED_ENTRIES = 512;

export class AntigravitySubmitLedger {
  private entries: AntigravitySubmitEntry[] = [];
  private seq = 0;
  /** Claimed record offsets per conversation, all on one transcript file. */
  private claims = new Map<string, { path: string; offsets: Set<number> }>();

  constructor(private readonly brainDir?: string) {}

  /** Record an input written to the pane (call before its Enter can land). */
  register(sha: string, baseline: AntigravitySubmitBaseline): AntigravitySubmitEntry {
    const entry: AntigravitySubmitEntry = { sha, baseline, seq: ++this.seq };
    this.entries.push(entry);
    this.prune();
    return entry;
  }

  /** The input's turn reached its terminal: whatever record it has is already
   *  on disk, so it can no longer take one written after a later submit. */
  settle(entry: AntigravitySubmitEntry): void {
    if (entry.settledAtSeq === undefined) entry.settledAtSeq = this.seq;
  }

  /** Claim this entry's USER_INPUT in `conversationId`, if it is provably its. */
  tryClaim(entry: AntigravitySubmitEntry, conversationId: string | undefined): boolean {
    if (entry.claim) return entry.claim.conversationId === conversationId;
    if (!conversationId || entry.settledAtSeq !== undefined) return false;
    if (this.ambiguous(entry)) return false;
    const path = resolveAntigravityTranscriptPath(conversationId, this.brainDir ? { brainDir: this.brainDir } : {});
    if (!path) return false;
    const minOffset = antigravityBaselineMinOffset(conversationId, path, entry.baseline);
    if (minOffset === undefined) return false;
    const claimed = this.claims.get(conversationId);
    if (claimed && claimed.path !== path) return false; // offsets of another file cannot be compared
    // While the ambiguity rule holds, a claimed record already precedes this
    // baseline; skipping claimed offsets keeps that true across baseline
    // remapping (compact → full) too.
    const offset = listAntigravityUserInputMatchOffsets(path, entry.sha, minOffset)
      .find(candidate => !claimed?.offsets.has(candidate));
    if (offset === undefined) return false;
    if (claimed) claimed.offsets.add(offset);
    else this.claims.set(conversationId, { path, offsets: new Set([offset]) });
    entry.claim = { conversationId, path, offset };
    return true;
  }

  /** Another unresolved same-text submit could own a record after this one's
   *  baseline: a later one always can; an earlier one unless its turn had
   *  already finished before this one was written. */
  private ambiguous(entry: AntigravitySubmitEntry): boolean {
    return this.entries.some(other => other !== entry && other.sha === entry.sha && !other.claim
      && (other.seq > entry.seq || other.settledAtSeq === undefined || other.settledAtSeq >= entry.seq));
  }

  private prune(): void {
    // Claimed entries live on only as claimed offsets.
    this.entries = this.entries.filter(entry => !entry.claim);
    if (this.entries.length <= MAX_TRACKED_ENTRIES) return;
    // Over the cap, forget settled entries that no unresolved same-text submit
    // written before their settle can still be confused with. Anything else
    // keeps blocking its text (fail closed) rather than silently stopping to.
    let excess = this.entries.length - MAX_TRACKED_ENTRIES;
    this.entries = this.entries.filter(entry => {
      if (excess <= 0 || entry.settledAtSeq === undefined) return true;
      const settledAt = entry.settledAtSeq;
      const stillRelevant = this.entries.some(other => other !== entry && other.sha === entry.sha
        && !other.claim && other.settledAtSeq === undefined && other.seq <= settledAt);
      if (stillRelevant) return true;
      excess -= 1;
      return false;
    });
  }
}
