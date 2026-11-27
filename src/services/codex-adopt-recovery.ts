import { CodexBridgeQueue, codexBridgeEventRolloutOffset } from './codex-bridge-queue.js';
import { splitCodexEventsByCutoff, type CodexBridgeEvent } from './codex-transcript.js';
import { clearBridgeTurnJournal, nativeInstantJournalCaller, readBridgeTurnJournal, selectRestorableBridgeTurns, writeBridgeTurnJournal } from './bridge-turn-journal.js';
import { sameTrustedPrincipal } from '../core/active-turn-authority.js';
import { createHash } from 'node:crypto';
import { wholeInputHash } from './codex-bridge-queue.js';

/** Admission-only first marks survive lazy rollout creation in the existing
 * journal. They never synthesize an accepted native input or re-submit it. */
export function checkpointNativeInstantPendingTurn(
  path: string, queue: CodexBridgeQueue, turnId: string, pid: number, birth: string,
): void {
  const turn = queue.peek().find(turn => turn.turnId === turnId && turn.dispatchAttempt === undefined);
  const caller = nativeInstantJournalCaller(turn?.nativeInstantInputCaller);
  if (!turn || !caller || !turn.turnId.startsWith('om_') || turn.isLocal || turn.started
    || turn.markTimeMs === undefined || !turn.contentFingerprint || !turn.wholeInputHash
    || !Number.isSafeInteger(pid) || pid <= 0 || !/^[0-9]+$/.test(birth)) return;
  const entries = readBridgeTurnJournal(path);
  const index = entries.findIndex(entry => entry.turnId === turnId && entry.dispatchAttempt === undefined);
  const pending = { turnId, markTimeMs: turn.markTimeMs, fingerprint: turn.contentFingerprint,
    wholeInputHash: turn.wholeInputHash, ...(turn.inputTextHash ? { inputTextHash: turn.inputTextHash } : {}),
    ...(turn.linkRefMode ? { linkRefMode: turn.linkRefMode } : {}),
    nativeInstantInputCaller: caller, nativeInstantPendingProcess: { pid, birth }, jsonlPath: '', offsetAtMark: 0 };
  if (index < 0) entries.push(pending);
  else if (!entries[index].jsonlPath && !entries[index].nativeUserProof) entries[index] = { ...entries[index], ...pending };
  writeBridgeTurnJournal(path, entries);
}

/** The caller proves the same live process and owned top-level file before
 * and after this step. Only an exact real user record may bind a pre-path mark. */
export function bindNativeInstantPendingTurns(
  path: string, rolloutPath: string, queue: CodexBridgeQueue, pid: number, birth: string, nativeSessionId: string,
  events: readonly CodexBridgeEvent[], nowMs = Date.now(), current: () => boolean = () => true,
): number {
  if (!current()) return 0;
  const entries = readBridgeTurnJournal(path);
  let bound = 0;
  const next = entries.map(entry => {
    if (entry.nativeInstantPendingProcess?.pid !== pid || entry.nativeInstantPendingProcess.birth !== birth
      || entry.jsonlPath !== '' || !entry.nativeInstantInputCaller || !entry.wholeInputHash
      || entry.dispatchAttempt !== undefined || entry.pendingNotice || entry.pendingFinal
      || !Number.isFinite(entry.markTimeMs) || entry.markTimeMs > nowMs || nowMs - entry.markTimeMs > 24 * 60 * 60_000) return entry;
    const user = events.find(event => event.kind === 'user' && event.sourceSessionId === nativeSessionId
      && !!event.sourceTurnId && event.timestampMs >= entry.markTimeMs - 5_000
      && event.timestampMs <= nowMs && wholeInputHash(event.text) === entry.wholeInputHash);
    if (!user) return entry;
    const { nativeInstantPendingProcess: _pending, ...ordinary } = entry;
    bound++;
    return { ...ordinary, jsonlPath: rolloutPath, offsetAtMark: 0 };
  });
  if (bound && current()) {
    writeBridgeTurnJournal(path, next);
    if (!current()) { writeBridgeTurnJournal(path, entries); return 0; }
    for (const entry of next) {
      if (entry.nativeInstantPendingProcess || entry.jsonlPath !== rolloutPath) continue;
      const live = queue.peek().find(turn => turn.turnId === entry.turnId && turn.dispatchAttempt === undefined);
      if (live) { live.recoveryJsonlPathAtMark = rolloutPath; live.recoveryOffsetAtMark = 0; }
    }
  } else return 0;
  return bound;
}

/** Persist attribution only. Recovery never re-submits input to the CLI.
 * Durable deliveries have a separate recovery owner and are excluded. */
export function checkpointCodexAdoptTurns(
  path: string,
  rolloutPath: string,
  queue: CodexBridgeQueue,
  offsetAtMark: number = 0,
  persistNativeUserProof = false,
): void {
  const previous = readBridgeTurnJournal(path);
  const safeOffsetAtMark = Number.isSafeInteger(offsetAtMark) && offsetAtMark >= 0
    ? offsetAtMark
    : 0;
  // Peek order is drainage order (a started successor moves ahead of passed
  // marks), not submission order. Persist by the monotonic mark order so equal
  // millisecond timestamps still restore the original FIFO after a restart.
  const queued = queue.peek().slice().sort((left, right) => {
    const leftOrder = left.markOrder ?? left.markTimeMs ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.markOrder ?? right.markTimeMs ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
  const entries = queued.flatMap(turn => {
    // A passed mark must survive as passed, with a post-successor cursor.
    // Restoring its old ordinary mark would either replay the successor or
    // steal a newer identical input; dropping it loses the late reply entirely.
    if (turn.isLocal || turn.dispatchAttempt !== undefined
      || turn.markTimeMs === undefined || !turn.contentFingerprint) return [];
    // Capture the cursor on the FIRST checkpoint for this pending turn. Later
    // checkpoints can run after its user/progress records were ingested, so
    // advancing the offset would make restart recovery skip the turn start.
    const prior = previous.find(entry => entry.turnId === turn.turnId
      && entry.dispatchAttempt === turn.dispatchAttempt
      && entry.jsonlPath === rolloutPath);
    const capturedOffset = turn.recoveryJsonlPathAtMark === rolloutPath
      && Number.isSafeInteger(turn.recoveryOffsetAtMark)
      && turn.recoveryOffsetAtMark! >= 0
      ? turn.recoveryOffsetAtMark
      : undefined;
    const passedBySuccessor = turn.passedBySuccessor ? {
      // A later checkpoint may observe more of the successor's terminal, but
      // a restored queue with no new rows must never move this floor backwards.
      replayFloorMs: Math.max(
        prior?.passedBySuccessor?.replayFloorMs ?? 0,
        queue.transcriptEventTimeUpperBound() ?? turn.markTimeMs,
      ),
    } : undefined;
    const supersededTurnIds = turn.supersededTurns
      ?.filter(identity => identity.dispatchAttempt === undefined)
      .map(identity => identity.turnId);
    const nativeInstantInputCaller = nativeInstantJournalCaller(turn.nativeInstantInputCaller);
    const nativeInstantSupersededTurns = nativeInstantInputCaller && turn.sourceSessionId && turn.sourceTurnId
      ? turn.supersededTurns?.flatMap(member => {
        const caller = nativeInstantJournalCaller(member.nativeInstantInputCaller);
        if (member.dispatchAttempt !== undefined || !member.turnId.startsWith('om_')
          || !caller || !sameTrustedPrincipal(nativeInstantInputCaller, caller)
          || !member.exactUserInputMatch || !member.nativeUserProof
          || member.sourceSessionId !== turn.sourceSessionId || member.sourceTurnId !== turn.sourceTurnId) return [];
        return [{ turnId: member.turnId, nativeInstantInputCaller: caller, nativeUserProof: { ...member.nativeUserProof } }];
      }) : undefined;
    // The correction's own mark is after the original user record. Retain
    // the earliest accepted member's existing frontier so the replacement
    // can corroborate every saved proof against the owned native rollout.
    const nativeReplayOffsets = nativeInstantSupersededTurns?.length
      ? turn.supersededTurns?.filter(member =>
        nativeInstantSupersededTurns.some(accepted => accepted.turnId === member.turnId)
        && member.recoveryJsonlPathAtMark === rolloutPath
        && Number.isSafeInteger(member.recoveryOffsetAtMark) && member.recoveryOffsetAtMark! >= 0)
        .map(member => member.recoveryOffsetAtMark!) ?? []
      : [];
    // A terminal can remain queued until delivery. Empty polls or another
    // mark must not checkpoint beyond it and erase the successor's replay.
    const nativeUserProof = persistNativeUserProof && turn.started && turn.nativeUserProof
      ? turn.finalText !== undefined ? prior?.nativeUserProof
        : { ...turn.nativeUserProof, trajectoryOffset: safeOffsetAtMark }
      : undefined;
    return [{ turnId: turn.turnId, markTimeMs: turn.markTimeMs,
      ...(nativeInstantInputCaller ? { nativeInstantInputCaller } : {}),
      ...(nativeUserProof ? { nativeUserProof } : {}),
      fingerprint: turn.contentFingerprint, jsonlPath: rolloutPath,
      ...(turn.inputTextHash ? { inputTextHash: turn.inputTextHash } : {}),
      ...(turn.wholeInputHash ? { wholeInputHash: turn.wholeInputHash } : {}),
      ...(passedBySuccessor ? { passedBySuccessor } : {}),
      ...(turn.linkRefMode ? { linkRefMode: turn.linkRefMode } : {}),
      ...(turn.sourceTurnId && supersededTurnIds?.length ? { mergedExecution: {
        sourceTurnId: turn.sourceTurnId,
        ...(turn.sourceSessionId ? { sourceSessionId: turn.sourceSessionId } : {}),
        supersededTurnIds,
        ...(nativeInstantSupersededTurns?.length ? { nativeInstantSupersededTurns } : {}),
      } } : {}),
      offsetAtMark: turn.passedBySuccessor
        ? safeOffsetAtMark
        : Math.min(prior?.offsetAtMark ?? capturedOffset ?? safeOffsetAtMark, ...nativeReplayOffsets) }];
  });
  // An attach can precede the first User append. Empty queue checkpoints
  // must not erase that pre-path admission; it is still not an accepted turn.
  const retainedPending = previous.filter(entry => entry.nativeInstantPendingProcess
    && !entries.some(current => current.turnId === entry.turnId && entry.dispatchAttempt === undefined));
  const checkpoint = [...entries, ...retainedPending];
  if (JSON.stringify(previous) === JSON.stringify(checkpoint)) return;
  if (checkpoint.length === 0) clearBridgeTurnJournal(path);
  else writeBridgeTurnJournal(path, checkpoint);
}

/** Called only on the first adopted Codex attach in a worker generation.
 * Keep old completed turns behind the watermark, but replay the persisted
 * pending input so its future terminal still belongs to the original message.
 * Historical thinking is omitted; new progress can open a fresh bubble. */
export function restoreCodexAdoptTurns(
  path: string, rolloutPath: string, queue: CodexBridgeQueue,
  events: readonly CodexBridgeEvent[], cutoffMs: number, nowMs = Date.now(),
): { history: CodexBridgeEvent[]; live: CodexBridgeEvent[]; restored: number } {
  // New pre-attach inputs stay in place behind the restored marks. A duplicate
  // message belongs to this generation, including any durable delivery attempt.
  const existing = new Set(queue.peek().map(turn => turn.turnId));
  const entries = selectRestorableBridgeTurns(readBridgeTurnJournal(path), { currentJsonlPath: rolloutPath, nowMs })
    .flatMap(entry => !existing.has(entry.turnId) && Number.isFinite(entry.markTimeMs) && entry.markTimeMs <= nowMs
      && typeof entry.fingerprint === 'string' && entry.fingerprint.length > 0
      ? [{ ...entry, fingerprint: entry.fingerprint }] : []);
  queue.restorePendingTurns(entries.map(entry => {
    if (!entry.mergedExecution?.nativeInstantSupersededTurns?.length) return entry;
    const merged = entry.mergedExecution;
    const accepted = merged.nativeInstantSupersededTurns!.filter(member => events.some(event =>
      event.kind === 'user' && event.sourceSessionId === merged.sourceSessionId
      && event.sourceTurnId === merged.sourceTurnId && event.uuid === member.nativeUserProof.uuid
      && event.timestampMs === member.nativeUserProof.timestampMs
      && createHash('sha256').update(event.text).digest('hex') === member.nativeUserProof.hash));
    return { ...entry, mergedExecution: { ...merged, nativeInstantSupersededTurns: accepted } };
  }));
  const replayCutoff = Math.min(cutoffMs, ...entries.map(entry => entry.markTimeMs - 5_000));
  const passed = entries.filter(entry => entry.passedBySuccessor !== undefined);
  if (passed.length === 0) {
    const { history, live } = splitCodexEventsByCutoff(events, replayCutoff);
    return { history, live: live.filter(event => event.kind !== 'cot' || event.timestampMs >= cutoffMs), restored: entries.length };
  }

  // Split-live recovery reads the whole rollout, unlike baseline-existing's
  // byte-ranged drain. Apply the journal's byte frontier here too, or a passed
  // mark restored alone would replay its already-delivered successor as local.
  // Stable Codex replay events carry explicit offsets; raw <path>:<offset> ids
  // provide the same evidence. The timestamp floor covers synthetic/legacy
  // events without either form, but never overrides a newer append-only offset.
  const offsets = entries.map(entry => entry.offsetAtMark);
  const byteFloor = offsets.every(offset => Number.isSafeInteger(offset) && offset >= 0)
    ? Math.min(...offsets) : undefined;
  const passedFloorMs = Math.max(...passed.map(entry => entry.passedBySuccessor!.replayFloorMs));
  const onlyPassed = passed.length === entries.length;
  const history: CodexBridgeEvent[] = [];
  const live: CodexBridgeEvent[] = [];
  for (const event of events) {
    const offset = codexBridgeEventRolloutOffset(event);
    const beforeByteFloor = byteFloor !== undefined && offset !== undefined && offset < byteFloor;
    const beforePassedTime = onlyPassed && (byteFloor === undefined || offset === undefined)
      && event.timestampMs <= passedFloorMs;
    if (beforeByteFloor || beforePassedTime || event.timestampMs < replayCutoff) history.push(event);
    else if (event.kind !== 'cot' || event.timestampMs >= cutoffMs) live.push(event);
    else history.push(event);
  }
  return { history, live, restored: entries.length };
}
