import { CodexBridgeQueue } from './codex-bridge-queue.js';
import { splitCodexEventsByCutoff, type CodexBridgeEvent } from './codex-transcript.js';
import { clearBridgeTurnJournal, readBridgeTurnJournal, selectRestorableBridgeTurns, writeBridgeTurnJournal } from './bridge-turn-journal.js';

/** Persist attribution only. Recovery never re-submits input to the CLI.
 * Durable deliveries have a separate recovery owner and are excluded. */
export function checkpointCodexAdoptTurns(path: string, rolloutPath: string, queue: CodexBridgeQueue): void {
  const entries = queue.peek().flatMap(turn => {
    if (turn.isLocal || turn.dispatchAttempt !== undefined || turn.finalText !== undefined
      || turn.markTimeMs === undefined || !turn.contentFingerprint) return [];
    // Codex recovery drains from byte zero, then filters by timestamps rather than offsetAtMark.
    return [{ turnId: turn.turnId, markTimeMs: turn.markTimeMs,
      fingerprint: turn.contentFingerprint, jsonlPath: rolloutPath, offsetAtMark: 0 }];
  });
  const previous = readBridgeTurnJournal(path);
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
  const { history, live } = splitCodexEventsByCutoff(events, replayCutoff);
  return { history, live: live.filter(event => event.kind !== 'cot' || event.timestampMs >= cutoffMs), restored: entries.length };
}
