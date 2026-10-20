import type {
  CodexAppDispatchLedgerEntry,
  CodexAppGenerationCommit,
} from '../types.js';
import { ASYNC_OUTPUT_DRAIN_MS } from '../services/async-trigger-store.js';

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
  identity: CodexAppDispatchIdentity & Pick<CodexAppDispatchLedgerEntry, 'serialRecovery'>,
): { ok: true; ledger: CodexAppDispatchLedgerEntry[] } | { ok: false; error: string } {
  const index = ledger.findIndex(entry => entry.dispatchId === identity.dispatchId);
  if (index < 0 || !sameIdentity(ledger[index], identity)) {
    return { ok: false, error: 'dispatch_not_found' };
  }
  if (ledger[index].executionPolicy === 'serial' && index !== 0) {
    return { ok: false, error: 'serial_predecessor_unsettled' };
  }
  if (ledger.slice(0, index).some(entry => entry.state !== 'prepared')) {
    return { ok: false, error: 'dispatch_out_of_order' };
  }
  if (ledger[index].state === 'prepared') return { ok: true, ledger: [...ledger] };
  const next = ledger.map((entry, candidateIndex) => candidateIndex === index
    ? { ...entry, state: 'prepared' as const,
        ...(entry.executionPolicy === 'serial' && identity.serialRecovery
          ? { serialRecovery: { ...identity.serialRecovery } } : {}) }
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

/** Journal exact observations before any output consumer or successor runs.
 * Duplicate observations preserve the first native timestamp and payload. */
export function observeSerialDispatch(
  ledger: readonly CodexAppDispatchLedgerEntry[],
  observation: NonNullable<CodexAppDispatchLedgerEntry['serialResult']>['terminal']
    | NonNullable<CodexAppDispatchLedgerEntry['serialResult']>['output'],
  observedAt = Date.now(),
): CodexAppDispatchLedgerEntry[] {
  if (!observation) throw new Error('serial_observation_missing');
  const index = ledger.findIndex(entry => entry.turnId === observation.turnId
    && entry.dispatchAttempt === observation.dispatchAttempt && entry.executionPolicy === 'serial');
  if (index < 0) throw new Error('serial_dispatch_not_found');
  if (index !== 0 || ledger[index].state !== 'prepared') throw new Error('serial_prepared_head_mismatch');
  const entry = ledger[index];
  const result = { ...entry.serialResult };
  if (observation.type === 'turn_terminal') {
    if (result.terminal && (result.terminal.status !== observation.status
      || result.terminal.errorCode !== observation.errorCode
      || result.terminal.outputDisposition !== observation.outputDisposition)) {
      throw new Error('serial_terminal_conflict');
    }
    result.terminal ??= { ...observation };
    if (observation.status === 'completed' && observation.outputDisposition !== 'nothing_to_send') {
      result.outputDrainUntil ??= observedAt + ASYNC_OUTPUT_DRAIN_MS;
    }
  } else {
    if (result.outputAbsentAt !== undefined) throw new Error('serial_output_after_absence');
    if (result.output && (result.output.content !== observation.content
      || result.output.lastUuid !== observation.lastUuid
      || result.output.turnFailed !== observation.turnFailed)) throw new Error('serial_output_conflict');
    result.output ??= { ...observation };
  }
  return ledger.map((item, i) => i === index ? { ...item, serialResult: result } : item);
}

export function serialDispatchReadyToRetire(entry: CodexAppDispatchLedgerEntry): boolean {
  const result = entry.serialResult;
  return entry.executionPolicy === 'serial' && entry.state === 'prepared'
    && result?.terminalCommitted === true && !!result.terminal
    && (result.terminal.status !== 'completed'
      || result.terminal.outputDisposition === 'nothing_to_send'
      || result.outputCommitted === true || result.outputAbsentAt !== undefined);
}

/** Settled raw facts stay in the journal until consumer commit is known.
 * Never retire a queued tail on a late terminal or a mere model final. */
export function commitSerialDispatchConsumer(
  ledger: readonly CodexAppDispatchLedgerEntry[],
  identity: CodexAppDispatchIdentity,
  consumer: 'terminal' | 'output',
): CodexAppDispatchLedgerEntry[] {
  const head = ledger[0];
  if (!head || head.executionPolicy !== 'serial' || head.state !== 'prepared'
    || !sameIdentity(head, identity)) throw new Error('serial_prepared_head_mismatch');
  const result = head.serialResult;
  if (!result?.[consumer]) throw new Error('serial_observation_missing');
  return [{ ...head, serialResult: { ...result,
    ...(consumer === 'terminal' ? { terminalCommitted: true as const } : { outputCommitted: true as const }),
  } }, ...ledger.slice(1)];
}

/** Resolve only an observed native terminal. Delivery failures with a known
 * output retain their original consumer responsibility and never become no_output. */
export function resolveSerialDispatchTerminal(
  entry: CodexAppDispatchLedgerEntry,
  now = Date.now(),
): { entry: CodexAppDispatchLedgerEntry;
  terminal?: NonNullable<CodexAppDispatchLedgerEntry['serialResult']>['terminal'] } {
  const result = entry.serialResult;
  const terminal = result?.terminal;
  if (entry.executionPolicy !== 'serial' || !terminal) return { entry };
  if (terminal.status !== 'completed' || terminal.outputDisposition === 'nothing_to_send'
    || result.outputCommitted) return { entry, terminal };
  if (result.output || result.outputDrainUntil === undefined || now < result.outputDrainUntil) return { entry };
  return {
    entry: { ...entry, serialResult: { ...result, outputAbsentAt: result.outputAbsentAt ?? now } },
    terminal: { ...terminal, status: 'ambiguous', errorCode: 'no_output', retryable: false },
  };
}

/** Native identity is immutable even when a replacement worker observes it. */
export function bindSerialDispatchNativeStart(
  ledger: readonly CodexAppDispatchLedgerEntry[],
  identity: CodexAppDispatchIdentity,
  proof: NonNullable<CodexAppDispatchLedgerEntry['serialNativeStart']>,
): CodexAppDispatchLedgerEntry[] {
  const head = ledger[0];
  if (!head || head.executionPolicy !== 'serial' || head.state !== 'prepared'
    || !sameIdentity(head, identity)) throw new Error('serial_prepared_head_mismatch');
  if (!proof.nativeSessionId || !proof.nativeTurnId || !Number.isFinite(proof.startedAtMs)
    || proof.workerGeneration !== undefined && (!Number.isSafeInteger(proof.workerGeneration) || proof.workerGeneration <= 0)) {
    throw new Error('serial_native_identity_missing');
  }
  if (head.serialNativeStart) {
    if (head.serialNativeStart.nativeSessionId !== proof.nativeSessionId
      || head.serialNativeStart.nativeTurnId !== proof.nativeTurnId) throw new Error('serial_native_identity_conflict');
    return [...ledger];
  }
  return [{ ...head, serialNativeStart: { ...proof } }, ...ledger.slice(1)];
}

/** An owned serial transaction, unlike a legacy IPC-only lease, supplies the
 * payload before write and the exact readback basis after it. Recovery retains
 * the same lease; it never grants a second request admission. */
export function serialDispatchOwnsRecovery(
  ledger: readonly CodexAppDispatchLedgerEntry[] | undefined,
  turnId: string,
): boolean {
  const matches = (ledger ?? []).filter(entry => entry.turnId === turnId);
  if (matches.length !== 1) return false;
  const entry = matches[0];
  return entry.executionPolicy === 'serial' && entry.origin?.atMostOnce === true
    && entry.dispatchAttempt === undefined
    && (entry.state === 'accepted' || entry.state === 'prepared');
}

/** Process-local active authority can be reset on backend replacement, but a
 * prepared serial transaction keeps the lane until the daemon commits its
 * result. Only its exact, still-unwritten local input may reconcile prepare. */
export function preparedSerialDispatch(ledger: readonly CodexAppDispatchLedgerEntry[] | undefined): CodexAppDispatchLedgerEntry | undefined {
  return ledger?.find(entry => entry.executionPolicy === 'serial' && entry.state === 'prepared');
}

export function serialDispatchBlocksInput(
  ledger: readonly CodexAppDispatchLedgerEntry[] | undefined,
  input: { turnId?: string; dispatchAttempt?: number },
): boolean {
  const prepared = preparedSerialDispatch(ledger);
  return !!prepared && (prepared.turnId !== input.turnId
    || prepared.dispatchAttempt !== input.dispatchAttempt || !!prepared.serialResult?.terminal);
}
