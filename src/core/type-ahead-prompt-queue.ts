import type { DaemonSession } from './types.js';
import { removePromptContextForTurn } from '../services/prompt-context-store.js';

function normalizedTurnIds(turnIds: readonly string[]): string[] {
  // Every live queued turn may fire a hook. Never silently evict a live
  // candidate: admission is fail-open only for ambiguity, not for capacity.
  return [...new Set(turnIds.filter(turnId => typeof turnId === 'string' && turnId.length > 0))];
}

/** Record a live worker's queue observation without changing its original order. */
export function noteTypeAheadPromptTurn(ds: DaemonSession, turnId: string): void {
  const turnIds = ds.typeAheadPromptTurnIds ?? [];
  if (!turnIds.includes(turnId)) ds.typeAheadPromptTurnIds = normalizedTurnIds([...turnIds, turnId]);
}

/** A promoted turn leaves the queue but keeps its sidecar for delayed current-turn claim. */
export function promoteTypeAheadPromptTurn(ds: DaemonSession, turnId: string): void {
  ds.typeAheadPromptTurnIds = (ds.typeAheadPromptTurnIds ?? []).filter(id => id !== turnId);
}

/**
 * A dropped/folded/terminal queued turn can never claim its sidecar later.
 * If it has already become the managed origin, leave the file for the ordinary
 * current-turn claim path; only the stale queue entry is removed here.
 */
export function dropTypeAheadPromptTurn(ds: DaemonSession, turnId: string): void {
  ds.typeAheadPromptTurnIds = (ds.typeAheadPromptTurnIds ?? []).filter(id => id !== turnId);
  if (ds.managedTurnOrigin?.turnId !== turnId) {
    removePromptContextForTurn(ds.session.sessionId, turnId);
  }
}

/**
 * Reconcile after a local CLI PID-marker bind. The snapshot is the worker's
 * complete live queue, including records restored by a replacement worker.
 * Entries absent from it are stale; live records keep their existing sidecars.
 */
export function reconcileTypeAheadPromptTurns(ds: DaemonSession, turnIds: readonly string[]): void {
  const previous = ds.typeAheadPromptTurnIds ?? [];
  const next = normalizedTurnIds(turnIds);
  ds.typeAheadPromptTurnIds = next;
  const live = new Set(next);
  for (const turnId of previous) {
    if (live.has(turnId) || ds.managedTurnOrigin?.turnId === turnId) continue;
    removePromptContextForTurn(ds.session.sessionId, turnId);
  }
}
