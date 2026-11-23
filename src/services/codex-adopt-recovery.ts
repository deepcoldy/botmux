import { CodexBridgeQueue, codexBridgeEventRolloutOffset } from './codex-bridge-queue.js';
import { splitCodexEventsByCutoff, type CodexBridgeEvent } from './codex-transcript.js';
import { clearBridgeTurnJournal, readBridgeTurnJournal, selectRestorableBridgeTurns, writeBridgeTurnJournal } from './bridge-turn-journal.js';

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
    // A terminal can remain queued until delivery. Empty polls or another
    // mark must not checkpoint beyond it and erase the successor's replay.
    const nativeUserProof = persistNativeUserProof && turn.started && turn.nativeUserProof
      ? turn.finalText !== undefined ? prior?.nativeUserProof
        : { ...turn.nativeUserProof, trajectoryOffset: safeOffsetAtMark }
      : undefined;
    return [{ turnId: turn.turnId, markTimeMs: turn.markTimeMs,
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
      } } : {}),
      offsetAtMark: turn.passedBySuccessor
        ? safeOffsetAtMark
        : prior?.offsetAtMark ?? capturedOffset ?? safeOffsetAtMark }];
  });
  if (JSON.stringify(previous) === JSON.stringify(entries)) return;
  if (entries.length === 0) clearBridgeTurnJournal(path);
  else writeBridgeTurnJournal(path, entries);
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
  queue.restorePendingTurns(entries);
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
