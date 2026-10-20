import type { CodexAppDispatchLedgerEntry } from '../types.js';
import { CodexBridgeQueue } from './codex-bridge-queue.js';
import { splitCodexEventsByCutoff, type CodexBridgeEvent } from './codex-transcript.js';
import { clearBridgeTurnJournal, readBridgeTurnJournal, selectRestorableBridgeTurns, writeBridgeTurnJournal } from './bridge-turn-journal.js';

/** Persist attribution only. Recovery never re-submits input to the CLI.
 * Durable deliveries have a separate recovery owner and are excluded. */
export function checkpointCodexAdoptTurns(
  path: string,
  rolloutPath: string,
  queue: CodexBridgeQueue,
  offsetAtMark: number = 0,
  externallyOwned: (turnId: string, dispatchAttempt?: number) => boolean = () => false,
): void {
  const previous = readBridgeTurnJournal(path);
  const safeOffsetAtMark = Number.isSafeInteger(offsetAtMark) && offsetAtMark >= 0
    ? offsetAtMark
    : 0;
  const entries = queue.peek().flatMap(turn => {
    if (externallyOwned(turn.turnId, turn.dispatchAttempt) || turn.isLocal || turn.dispatchAttempt !== undefined || turn.finalText !== undefined
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
    return [{ turnId: turn.turnId, markTimeMs: turn.markTimeMs,
      fingerprint: turn.contentFingerprint, jsonlPath: rolloutPath,
      offsetAtMark: prior?.offsetAtMark ?? capturedOffset ?? safeOffsetAtMark }];
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
  externallyOwned: (turnId: string, dispatchAttempt?: number) => boolean = () => false,
): { history: CodexBridgeEvent[]; live: CodexBridgeEvent[]; restored: number } {
  // New pre-attach inputs stay in place behind the restored marks. A duplicate
  // message belongs to this generation, including any durable delivery attempt.
  const existing = new Set(queue.peek().map(turn => turn.turnId));
  const entries = selectRestorableBridgeTurns(readBridgeTurnJournal(path), { currentJsonlPath: rolloutPath, nowMs })
    .flatMap(entry => !externallyOwned(entry.turnId, entry.dispatchAttempt) && !existing.has(entry.turnId) && Number.isFinite(entry.markTimeMs) && entry.markTimeMs <= nowMs
      && typeof entry.fingerprint === 'string' && entry.fingerprint.length > 0
      ? [{ ...entry, fingerprint: entry.fingerprint }] : []);
  queue.restorePendingTurns(entries);
  const replayCutoff = Math.min(cutoffMs, ...entries.map(entry => entry.markTimeMs - 5_000));
  const { history, live } = splitCodexEventsByCutoff(events, replayCutoff);
  return { history, live: live.filter(event => event.kind !== 'cot' || event.timestampMs >= cutoffMs), restored: entries.length };
}

/** Serial recovery uses the daemon's prepared transaction, not the best-effort
 * legacy journal. No model input is submitted by this operation. */
export function serialDispatchRecoveryMark(
  entry: CodexAppDispatchLedgerEntry,
  rolloutPath: string,
  nativeSessionId: string | undefined,
): (Parameters<CodexBridgeQueue['restorePendingTurns']>[0][number] & { jsonlPath: string; offsetAtMark: number }) | undefined {
  const basis = entry.serialRecovery;
  const native = entry.serialNativeStart;
  if (entry.executionPolicy !== 'serial' || entry.state !== 'prepared' || entry.serialResult?.terminal
    || !basis || !basis.fingerprint || !Number.isFinite(basis.markTimeMs)) return undefined;
  if (native && native.nativeSessionId !== nativeSessionId) return undefined;
  if (basis.jsonlPath ? basis.jsonlPath !== rolloutPath : !native) return undefined;
  const offsetAtMark = basis.jsonlPath ? basis.offsetAtMark : 0;
  if (!Number.isSafeInteger(offsetAtMark) || offsetAtMark! < 0) return undefined;
  return { turnId: entry.turnId, dispatchAttempt: entry.dispatchAttempt, queueAfterActiveTurn: true,
    fingerprint: basis.fingerprint, markTimeMs: basis.markTimeMs,
    jsonlPath: rolloutPath, offsetAtMark: offsetAtMark!, ...(native ? { nativeStart: native } : {}),
  };
}

/** A missing transport is not a dead execution. Only a positive backing fence
 * permits unknown work to settle; readback gets first chance to recover a real
 * completion. An ambiguous receipt is never permission to replay the input. */
export function settleFencedSerialDispatch(deps: {
  backing: 'live' | 'gone' | 'unknown';
  hasTerminal: () => boolean;
  readback: () => void;
  ambiguous: (errorCode: string) => void;
}): 'held' | 'terminal' | 'ambiguous' {
  if (deps.hasTerminal()) return 'terminal';
  if (deps.backing !== 'gone') return 'held';
  let readbackFailed = false;
  try { deps.readback(); } catch { readbackFailed = true; }
  if (deps.hasTerminal()) return 'terminal';
  deps.ambiguous(readbackFailed ? 'serial_recovery_readback_unavailable' : 'serial_backing_exited');
  return 'ambiguous';
}
