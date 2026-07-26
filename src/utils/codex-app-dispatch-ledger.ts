import type {
  CodexAppDispatchLedgerEntry,
  CodexAppGenerationCommit,
} from '../types.js';

export type CodexAppDispatchIdentity = Pick<
  CodexAppDispatchLedgerEntry,
  'dispatchId' | 'turnId' | 'dispatchAttempt'
>;

function sameIdentity(
  left: CodexAppDispatchIdentity,
  right: CodexAppDispatchIdentity,
): boolean {
  return left.dispatchId === right.dispatchId
    && left.turnId === right.turnId
    && left.dispatchAttempt === right.dispatchAttempt;
}

/** Any ledger entry is daemon-owned unfinished work. Lifecycle mutations that
 * can replace a worker, pane, cwd, or chat route must reject while this is true;
 * explicit session close is the sole abandon operation. */
export function hasUnsettledCodexAppDispatch(
  ledger: readonly CodexAppDispatchLedgerEntry[] | undefined,
): boolean {
  return (ledger?.length ?? 0) > 0;
}

/**
 * Authorize a worker-hosted `botmux send` relay against the immutable Codex
 * App origin. `requireExact` is true for a live Codex App turn even when the
 * ledger has just become empty: settlement winning before watcher admission
 * must reject, never downgrade the old capability into an ordinary send.
 */
export function validateCodexAppManagedSendOrigin(
  ledger: readonly CodexAppDispatchLedgerEntry[] | undefined,
  origin: { turnId?: string; dispatchAttempt?: number },
  requireExact: boolean,
): { ok: true; requiresLedger: boolean } | { ok: false; error: string } {
  const entries = ledger ?? [];
  if (!requireExact && entries.length === 0) {
    return { ok: true, requiresLedger: false };
  }
  if (!origin.turnId) {
    return { ok: false, error: 'unsettled Codex App output has no live turn identity' };
  }
  const sameTurn = entries.filter(entry => entry.turnId === origin.turnId);
  const exact = origin.dispatchAttempt === undefined
    ? sameTurn
    : sameTurn.filter(entry => entry.dispatchAttempt === origin.dispatchAttempt);
  if (exact.length !== 1) {
    return {
      ok: false,
      error: `${exact.length} Codex App ledger entries match the live relay origin`,
    };
  }
  const sink = exact[0]!.deliverySink ?? 'lark';
  if (sink === 'http_wait' || sink === 'http_async' || sink === 'suppressed') {
    return { ok: false, error: `Codex App output is bound to ${sink}` };
  }
  return { ok: true, requiresLedger: true };
}

export function appendAcceptedCodexAppDispatch(
  ledger: readonly CodexAppDispatchLedgerEntry[],
  entry: Omit<CodexAppDispatchLedgerEntry, 'state'>,
): CodexAppDispatchLedgerEntry[] {
  if (!entry.dispatchId || !entry.turnId) throw new Error('Codex App dispatch identity is incomplete');
  if (ledger.some(candidate => candidate.dispatchId === entry.dispatchId)) {
    throw new Error('Codex App dispatch id is already present');
  }
  return [...ledger, { ...entry, state: 'accepted' }];
}

export function prepareCodexAppDispatch(
  ledger: readonly CodexAppDispatchLedgerEntry[],
  identity: CodexAppDispatchIdentity,
): { ok: true; ledger: CodexAppDispatchLedgerEntry[] } | { ok: false; error: string } {
  const index = ledger.findIndex(entry => entry.dispatchId === identity.dispatchId);
  if (index < 0 || !sameIdentity(ledger[index], identity)) {
    return { ok: false, error: 'dispatch_not_found' };
  }
  if (ledger.slice(0, index).some(entry => entry.state !== 'prepared')) {
    return { ok: false, error: 'dispatch_out_of_order' };
  }
  if (ledger[index].state === 'prepared') return { ok: true, ledger: [...ledger] };
  const next = ledger.map((entry, candidateIndex) => candidateIndex === index
    ? { ...entry, state: 'prepared' as const }
    : entry);
  return { ok: true, ledger: next };
}

/** A worker proved that a prepared write left the runner input untouched (or
 * fully flushed invalid), so the exact item may return to accepted and retry in
 * the same FIFO without minting a second dispatch. */
export function retryPreparedCodexAppDispatch(
  ledger: readonly CodexAppDispatchLedgerEntry[],
  identity: CodexAppDispatchIdentity,
): { ok: true; ledger: CodexAppDispatchLedgerEntry[] } | { ok: false; error: string } {
  const index = ledger.findIndex(entry => entry.dispatchId === identity.dispatchId);
  if (index < 0 || !sameIdentity(ledger[index], identity)) {
    return { ok: false, error: 'dispatch_not_found' };
  }
  if (ledger[index].state !== 'prepared') {
    return { ok: false, error: 'dispatch_not_prepared' };
  }
  if (ledger.slice(index + 1).some(entry => entry.state === 'prepared')) {
    return { ok: false, error: 'prepared_successor_exists' };
  }
  return {
    ok: true,
    ledger: ledger.map((entry, candidateIndex) => candidateIndex === index
      ? { ...entry, state: 'accepted' as const }
      : entry),
  };
}

export function cancelCodexAppDispatch(
  ledger: readonly CodexAppDispatchLedgerEntry[],
  identity: CodexAppDispatchIdentity,
): { ok: true; ledger: CodexAppDispatchLedgerEntry[] } | { ok: false; error: string } {
  const index = ledger.findIndex(entry => entry.dispatchId === identity.dispatchId);
  if (index < 0 || !sameIdentity(ledger[index], identity)) {
    return { ok: false, error: 'dispatch_not_found' };
  }
  if (ledger.slice(index + 1).some(entry => entry.state === 'prepared')) {
    return { ok: false, error: 'prepared_successor_exists' };
  }
  return { ok: true, ledger: ledger.filter((_, candidateIndex) => candidateIndex !== index) };
}

/**
 * Remove one exact VC delivery attempt after its owned CLI backing has been
 * authoritatively proved absent. Unlike ordinary cancellation, this does not
 * reject a prepared successor: the dead generation can no longer execute the
 * fenced attempt, and retaining it would make a replacement restore N beside
 * the delivery hub's replayed N+1.
 *
 * No match is idempotent success because the worker may have durably retired
 * the entry before it exited. More than one match is corruption and remains
 * fail-closed because the receipt identity does not contain a dispatchId.
 */
export function retireCodexAppDispatchAfterBackingMissing(
  ledger: readonly CodexAppDispatchLedgerEntry[],
  turnId: string,
  dispatchAttempt: number,
): { ok: true; ledger: CodexAppDispatchLedgerEntry[] } | { ok: false; error: string } {
  const sameTurnIndexes = ledger.flatMap((entry, index) => entry.turnId === turnId ? [index] : []);
  if (sameTurnIndexes.length === 0) return { ok: true, ledger: [...ledger] };
  if (sameTurnIndexes.length !== 1) return { ok: false, error: 'dispatch_identity_ambiguous' };
  const matchIndex = sameTurnIndexes[0]!;
  if (ledger[matchIndex]!.dispatchAttempt !== dispatchAttempt) {
    return { ok: false, error: 'dispatch_attempt_conflict' };
  }
  return {
    ok: true,
    ledger: ledger.filter((_, index) => index !== matchIndex),
  };
}

export function settleCodexAppDispatch(
  ledger: readonly CodexAppDispatchLedgerEntry[],
  commits: readonly CodexAppGenerationCommit[],
  identity: CodexAppDispatchIdentity,
  generation: string,
  seq: number,
): {
  ok: true;
  ledger: CodexAppDispatchLedgerEntry[];
  commits: CodexAppGenerationCommit[];
  settledEntry: CodexAppDispatchLedgerEntry;
  } | { ok: false; error: string } {
  const head = ledger[0];
  if (!head || head.state !== 'prepared' || !sameIdentity(head, identity)) {
    return { ok: false, error: 'prepared_head_mismatch' };
  }
  if (!generation || !Number.isSafeInteger(seq) || seq <= 0) {
    return { ok: false, error: 'invalid_control_identity' };
  }
  const existing = commits.find(commit => commit.generation === generation)?.committedThrough ?? 0;
  const nextCommit = { generation, committedThrough: Math.max(existing, seq) };
  return {
    ok: true,
    ledger: ledger.slice(1),
    settledEntry: { ...head },
    commits: [
      ...commits.filter(commit => commit.generation !== generation),
      nextCommit,
    ],
  };
}

export function committedCodexAppSequence(
  commits: readonly CodexAppGenerationCommit[],
  generation: string,
  seq: number,
): boolean {
  return commits.some(commit => commit.generation === generation && seq <= commit.committedThrough);
}

/** A proved fresh runner retires every prior generation and its ACK history. */
export function retainFreshCodexAppGeneration(
  commits: readonly CodexAppGenerationCommit[],
  generation: string,
): CodexAppGenerationCommit[] {
  return commits.filter(commit => commit.generation === generation);
}
