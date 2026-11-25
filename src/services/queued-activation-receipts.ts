import type { SubmitRecheckResult } from '../adapters/cli/types.js';

export type QueuedActivationEvidenceSource =
  | 'adapter-recheck'
  | 'deferred-recheck'
  | 'structured-transcript'
  | 'botmux-send';

export interface QueuedActivationTurnIdentity {
  sessionId?: string;
  generation: number;
  turnId?: string;
  dispatchAttempt?: number;
}

export interface QueuedActivationProof {
  source: QueuedActivationEvidenceSource;
  cliSessionId?: string;
  ownershipProven?: boolean;
  unprovenCliSessionId?: string;
  /** Exact SubmitRecheckResult from watch.recheck() so legacy 1-arg onConfirmed
   *  callers receive the exact value unchanged. */
  rawRecheckResult?: SubmitRecheckResult;
}

export interface QueuedActivationWatch {
  recheck?: () => SubmitRecheckResult | Promise<SubmitRecheckResult>;
  /** Synchronous read-only probe for authoritative execution proof (full
   *  structured-transcript record or exact-turn botmux-send marker). Must never
   *  accept bare idle, pty-output, short prefixes, or uncorroborated starts. */
  probeEvidence?: () => QueuedActivationProof | undefined;
  sessionId?: string;
  generation?: number;
  turnId?: string;
  dispatchAttempt?: number;
  isCurrent: () => boolean;
  /** Legacy 1-argument callback (kept for inputDeliveryQuarantine and existing
   *  observer callers). */
  onConfirmed?: (result: SubmitRecheckResult) => void;
  /** Unified settlement callback carrying the authoritative proof source. */
  onSettled?: (proof: QueuedActivationProof) => void;
}

export interface QueuedActivationReceiptObserver {
  watch(token: string, watch: QueuedActivationWatch): boolean;
  confirmToken(
    token: string,
    proof: QueuedActivationProof,
    fence?: Partial<QueuedActivationTurnIdentity>,
  ): boolean;
  confirmByTurn(
    identity: QueuedActivationTurnIdentity,
    proof: QueuedActivationProof,
  ): number;
  probeToken(token: string): boolean;
  probeByTurn(identity: QueuedActivationTurnIdentity): number;
  /** Once-per-token IPC emission latch shared by immediate, watched, RPC, raw,
   *  argv, and hard-refusal paths. Cancels any live watch for `token`. */
  claimOnce(token: string): boolean;
  isSettled(token: string): boolean;
  has(token: string): boolean;
  hasTurn(identity: QueuedActivationTurnIdentity): boolean;
  cancel(token: string): void;
  size(): number;
  clear(): void;
}

export function proofFromSubmitRecheckResult(
  result: SubmitRecheckResult,
  source: 'adapter-recheck' | 'deferred-recheck' = 'adapter-recheck',
): QueuedActivationProof | undefined {
  if (typeof result === 'boolean') {
    return result ? { source, rawRecheckResult: true } : undefined;
  }
  if (!result || result.submitted !== true) return undefined;
  return {
    source,
    ...(typeof result.cliSessionId === 'string' && result.cliSessionId
      ? { cliSessionId: result.cliSessionId }
      : {}),
    ...(result.ownershipProven === true ? { ownershipProven: true } : {}),
    ...(typeof result.unprovenCliSessionId === 'string' && result.unprovenCliSessionId
      ? { unprovenCliSessionId: result.unprovenCliSessionId }
      : {}),
    rawRecheckResult: result,
  };
}

export function recheckResultFromProof(proof: QueuedActivationProof): SubmitRecheckResult {
  if (proof.rawRecheckResult !== undefined) return proof.rawRecheckResult;
  if (!proof.cliSessionId && !proof.ownershipProven && !proof.unprovenCliSessionId) {
    return true;
  }
  return {
    submitted: true,
    ...(proof.cliSessionId ? { cliSessionId: proof.cliSessionId } : {}),
    ...(proof.ownershipProven ? { ownershipProven: true } : {}),
    ...(proof.unprovenCliSessionId ? { unprovenCliSessionId: proof.unprovenCliSessionId } : {}),
  };
}

export function matchesQueuedActivationTurn(
  watch: Pick<QueuedActivationWatch, 'sessionId' | 'generation' | 'turnId' | 'dispatchAttempt'>,
  target: QueuedActivationTurnIdentity,
): boolean {
  if (watch.generation === undefined || watch.generation !== target.generation) return false;
  if (watch.turnId === undefined || target.turnId === undefined || watch.turnId !== target.turnId) {
    return false;
  }
  if (watch.dispatchAttempt !== target.dispatchAttempt) return false;
  if (watch.sessionId !== undefined && target.sessionId !== undefined
    && watch.sessionId !== target.sessionId) {
    return false;
  }
  return true;
}

export function claudeNativeSessionIdFromJsonlPath(sourceJsonlPath?: string): string | undefined {
  if (!sourceJsonlPath) return undefined;
  const segments = sourceJsonlPath.split(/[\\/]/);
  const base = segments[segments.length - 1] ?? '';
  return base.endsWith('.jsonl') && /^[A-Za-z0-9-]{8,128}\.jsonl$/.test(base)
    ? base.slice(0, -'.jsonl'.length)
    : undefined;
}

const MAX_REMEMBERED_TOKENS = 1_024;

function rememberBounded(set: Set<string>, token: string): void {
  set.delete(token);
  set.add(token);
  while (set.size > MAX_REMEMBERED_TOKENS) {
    const oldest = set.keys().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

/** The activation journal outlives the bounded submit-warning chain. Observe
 * its original receipt (adapter recheck and/or authoritative execution proof)
 * until confirmation or cancellation without ever typing input again. One
 * timer per token; replacement/restart also fences in-flight asynchronous
 * reads, not just timers that have yet to fire. All confirmation paths flow
 * through one idempotent settlement gate so each activation token settles at
 * most once. */
export function createQueuedActivationReceiptObserver(
  intervalMs: number,
): QueuedActivationReceiptObserver {
  type Entry = {
    token: string;
    watch: QueuedActivationWatch;
    timer?: ReturnType<typeof setTimeout>;
  };
  const entries = new Map<string, Entry>();
  const settledWatches = new Set<string>();
  const claimedTokens = new Set<string>();

  const cancel = (token: string): void => {
    const entry = entries.get(token);
    if (entry?.timer) clearTimeout(entry.timer);
    entries.delete(token);
  };

  const owns = (entry: Entry): boolean => entries.get(entry.token) === entry;

  const isEntryCurrent = (entry: Entry): boolean => {
    if (!owns(entry)) return false;
    if (entry.watch.isCurrent()) return true;
    cancel(entry.token);
    return false;
  };

  const settleEntry = (entry: Entry, proof: QueuedActivationProof): boolean => {
    if (settledWatches.has(entry.token) || claimedTokens.has(entry.token)) {
      cancel(entry.token);
      return false;
    }
    if (!isEntryCurrent(entry)) return false;
    cancel(entry.token);
    rememberBounded(settledWatches, entry.token);
    entry.watch.onSettled?.(proof);
    entry.watch.onConfirmed?.(recheckResultFromProof(proof));
    return true;
  };

  const probeEntry = (entry: Entry): boolean => {
    if (!entry.watch.probeEvidence) return false;
    if (!isEntryCurrent(entry)) return false;
    let proof: QueuedActivationProof | undefined;
    try { proof = entry.watch.probeEvidence(); }
    catch { return false; }
    if (!proof) return false;
    return settleEntry(entry, proof);
  };

  const matchesFence = (
    watch: QueuedActivationWatch,
    fence?: Partial<QueuedActivationTurnIdentity>,
  ): boolean => {
    if (!fence) return true;
    if (fence.generation !== undefined
      && watch.generation !== undefined
      && watch.generation !== fence.generation) {
      return false;
    }
    if (fence.sessionId !== undefined
      && watch.sessionId !== undefined
      && watch.sessionId !== fence.sessionId) {
      return false;
    }
    if ('turnId' in fence
      && (fence.turnId !== undefined || watch.turnId !== undefined)
      && watch.turnId !== fence.turnId) {
      return false;
    }
    if ('dispatchAttempt' in fence
      && watch.turnId !== undefined
      && watch.dispatchAttempt !== fence.dispatchAttempt) {
      return false;
    }
    return true;
  };

  return {
    cancel,
    size: () => entries.size,
    has: (token: string) => entries.has(token),
    hasTurn: (identity: QueuedActivationTurnIdentity) => {
      for (const entry of entries.values()) {
        if (matchesQueuedActivationTurn(entry.watch, identity)) return true;
      }
      return false;
    },
    isSettled: (token: string) => settledWatches.has(token) || claimedTokens.has(token),
    claimOnce(token: string): boolean {
      if (claimedTokens.has(token)) return false;
      cancel(token);
      rememberBounded(claimedTokens, token);
      rememberBounded(settledWatches, token);
      return true;
    },
    clear(): void {
      for (const token of [...entries.keys()]) cancel(token);
    },
    watch(token: string, watch: QueuedActivationWatch): boolean {
      if (settledWatches.has(token) || claimedTokens.has(token)) return false;
      cancel(token);
      const entry: Entry = { token, watch };
      entries.set(token, entry);
      if (!watch.recheck && !watch.probeEvidence) return true;
      const arm = (): void => {
        if (!owns(entry)) return;
        entry.timer = setTimeout(() => { void poll(); }, intervalMs);
        entry.timer.unref?.();
      };
      const poll = async (): Promise<void> => {
        if (!isEntryCurrent(entry)) return;
        // Prefer adapter recheck() ahead of fallback evidence probes so
        // cliSessionId / ownershipProven (and argv completion watching) are
        // never skipped when a botmux-send marker also exists on disk.
        let result: SubmitRecheckResult = false;
        if (watch.recheck) {
          try { result = await watch.recheck(); }
          catch { /* A temporarily unreadable receipt does not authorize replay. */ }
        }
        if (!isEntryCurrent(entry)) return;
        const recheckProof = proofFromSubmitRecheckResult(result, 'adapter-recheck');
        if (recheckProof) {
          settleEntry(entry, recheckProof);
          return;
        }
        if (probeEntry(entry)) return;
        if (isEntryCurrent(entry)) arm();
      };
      arm();
      return true;
    },
    confirmToken(
      token: string,
      proof: QueuedActivationProof,
      fence?: Partial<QueuedActivationTurnIdentity>,
    ): boolean {
      const entry = entries.get(token);
      if (!entry) return false;
      if (!matchesFence(entry.watch, fence)) return false;
      return settleEntry(entry, proof);
    },
    confirmByTurn(
      identity: QueuedActivationTurnIdentity,
      proof: QueuedActivationProof,
    ): number {
      let settled = 0;
      for (const entry of [...entries.values()]) {
        if (!matchesQueuedActivationTurn(entry.watch, identity)) continue;
        if (settleEntry(entry, proof)) settled += 1;
      }
      return settled;
    },
    probeToken(token: string): boolean {
      const entry = entries.get(token);
      if (!entry) return false;
      return probeEntry(entry);
    },
    probeByTurn(identity: QueuedActivationTurnIdentity): number {
      let settled = 0;
      for (const entry of [...entries.values()]) {
        if (!matchesQueuedActivationTurn(entry.watch, identity)) continue;
        if (probeEntry(entry)) settled += 1;
      }
      return settled;
    },
  };
}
