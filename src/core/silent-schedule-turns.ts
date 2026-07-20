import type { DaemonSession } from './types.js';

// Silent schedule turn ids are intentionally retained past turn_terminal: a
// worker can still emit a trailing idle/screenshot event after its terminal
// receipt. Unique ids make retention safe, while TTL + size bounds prevent a
// long-lived scheduler session from growing without limit.
const SILENT_TURN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SILENT_TURNS_PER_SESSION = 256;

function pruneSilentScheduledTurns(ds: DaemonSession, now: number): void {
  const turns = ds.silentScheduledTurns;
  if (!turns) return;
  for (const [turnId, armedAt] of turns) {
    if (now - armedAt > SILENT_TURN_TTL_MS) turns.delete(turnId);
  }
  while (turns.size >= MAX_SILENT_TURNS_PER_SESSION) {
    const oldest = turns.keys().next().value as string | undefined;
    if (!oldest) break;
    turns.delete(oldest);
  }
  if (turns.size === 0) ds.silentScheduledTurns = undefined;
}

export function armSilentScheduledTurn(
  ds: DaemonSession,
  turnId: string,
  now = Date.now(),
): void {
  pruneSilentScheduledTurns(ds, now);
  const turns = ds.silentScheduledTurns ??= new Map<string, number>();
  turns.set(turnId, now);
}

export function isSilentScheduledTurn(
  ds: DaemonSession,
  turnId?: string,
  now = Date.now(),
): boolean {
  if (!turnId) return false;
  const armedAt = ds.silentScheduledTurns?.get(turnId);
  if (armedAt === undefined) return false;
  if (now - armedAt <= SILENT_TURN_TTL_MS) return true;
  ds.silentScheduledTurns?.delete(turnId);
  if (ds.silentScheduledTurns?.size === 0) ds.silentScheduledTurns = undefined;
  return false;
}

export function disarmSilentScheduledTurn(ds: DaemonSession, turnId: string): void {
  ds.silentScheduledTurns?.delete(turnId);
  if (ds.silentScheduledTurns?.size === 0) ds.silentScheduledTurns = undefined;
}
