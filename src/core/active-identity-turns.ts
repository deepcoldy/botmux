/**
 * Accepted-but-not-terminal turn ledger, per session.
 *
 * The daemon publishes an identity when a message is ACCEPTED, while the worker
 * may hold it in its type-ahead queue for a long time before executing. Terminal
 * identity garbage collection needs to keep that published material even though
 * no other daemon-side structure names the queued turn yet — the worker's own
 * PID marker is CLI-writable and therefore cannot anchor a retention decision.
 *
 * A turn is registered at publication and released on its exact terminal (or
 * rejection). Replays publish and register the same turn id again; a stale
 * terminal from an older dispatch attempt does not release the newer one
 * (callers gate the release on the attempt match).
 *
 * Daemon memory only: a restart clears the ledger, and surviving workers
 * re-publish (re-register) the turns they replay.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_TURNS_PER_SESSION = 256;

const sessions = new Map<string, Set<string>>();
/** Sessions at the defensive cap: every one of their turns is retained, and
 *  GC must not collect that session at all. A set this large means many turns
 *  never terminaled (crashed workers); clearing it would let the next sweep
 *  collect still-queued material, so saturation fails toward retention. */
const saturatedSessions = new Set<string>();

function sessionKey(dataDir: string, sessionId: string): string {
  let canonical: string;
  try { canonical = realpathSync(dataDir); } catch { canonical = resolve(dataDir); }
  return JSON.stringify([canonical, sessionId]);
}

/** Whether GC must skip a session entirely because its accept ledger is
 *  saturated (fail toward retention of its queued material). */
export function activeIdentityTurnsSaturated(dataDir: string, sessionId: string): boolean {
  return saturatedSessions.has(sessionKey(dataDir, sessionId));
}

/** Mark a published turn as still alive (queued, preparing, or executing). */
export function registerActiveIdentityTurn(dataDir: string, sessionId: string, turnId: string): void {
  const key = sessionKey(dataDir, sessionId);
  let turns = sessions.get(key);
  if (!turns) { turns = new Set(); sessions.set(key, turns); }
  if (saturatedSessions.has(key)) { turns.add(turnId); return; }
  turns.add(turnId);
  // Defensive bound: a session that somehow never terminals stops accruing
  // beyond this many turns. Past the cap the whole session is pinned (the
  // ledger cannot tell queued from dead at that volume) — never clear, which
  // would turn the next GC into over-collection of in-flight material.
  if (turns.size > MAX_TURNS_PER_SESSION) saturatedSessions.add(key);
}

/** Release one turn after its terminal/rejection was observed. */
export function releaseActiveIdentityTurn(dataDir: string, sessionId: string, turnId: string): void {
  sessions.get(sessionKey(dataDir, sessionId))?.delete(turnId);
}

/** All still-alive published turn ids for a session. A saturated session
 *  signals "retain everything" by returning null. */
export function activeIdentityTurns(dataDir: string, sessionId: string): string[] | null {
  const key = sessionKey(dataDir, sessionId);
  if (saturatedSessions.has(key)) return null;
  return [...(sessions.get(key) ?? [])];
}

/** Drop the whole session ledger (teardown). */
export function clearActiveIdentityTurns(dataDir: string, sessionId: string): void {
  const key = sessionKey(dataDir, sessionId);
  sessions.delete(key);
  saturatedSessions.delete(key);
}
