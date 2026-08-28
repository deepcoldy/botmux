/**
 * Fleet state store — persists the supervisor's view of the fleet to
 * `~/.botmux/fleet-state.json`, replacing pm2's jlist/dump. Every write goes
 * through the same file lock the rest of botmux uses, and validates the
 * projection-identity invariant (unique names, no shared live pids) before it
 * touches disk, so a lost/duplicated child can never be silently persisted.
 *
 * The file IS the durable fleet record: there is no separate "save/dump" step
 * like pm2 — the live supervisor writes it on every state change, and resurrect
 * simply re-reads it and respawns the procs that were not cleanly stopped.
 */

import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { assertProjectionIdentity, type FleetState, type FleetProcState } from './fleet-supervisor-policy.js';

/** Shape guard for a parsed state file — tolerant of an absent/partial file. */
function coerceState(raw: unknown): FleetState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.procs)) return null;
  const procs: FleetProcState[] = [];
  for (const p of o.procs) {
    if (!p || typeof p !== 'object') continue;
    const q = p as Record<string, unknown>;
    if (typeof q.name !== 'string' || typeof q.appId !== 'string') continue;
    procs.push({
      name: q.name,
      appId: q.appId,
      pid: Number.isSafeInteger(q.pid) ? (q.pid as number) : 0,
      generation: Number.isSafeInteger(q.generation) ? (q.generation as number) : 0,
      status: (['online', 'stopped', 'errored', 'launching'] as const).includes(q.status as never)
        ? (q.status as FleetProcState['status']) : 'stopped',
      restarts: Number.isSafeInteger(q.restarts) ? (q.restarts as number) : 0,
      lastExitCode: typeof q.lastExitCode === 'number' ? q.lastExitCode : null,
      startedAt: typeof q.startedAt === 'string' ? q.startedAt : null,
    });
  }
  return {
    supervisorPid: Number.isSafeInteger(o.supervisorPid) ? (o.supervisorPid as number) : 0,
    supervisorStartedAt: typeof o.supervisorStartedAt === 'string' ? o.supervisorStartedAt : '',
    procs,
  };
}

/** Read the fleet state file, or null if it's absent/unparseable/empty. */
export function readFleetState(statePath: string): FleetState | null {
  if (!existsSync(statePath)) return null;
  try {
    return coerceState(JSON.parse(readFileSync(statePath, 'utf-8')));
  } catch {
    return null;
  }
}

/**
 * Read-modify-write the fleet state under a file lock. The mutator receives the
 * current state (or a fresh empty one) and returns the next state; the result is
 * validated (projection identity) and atomically written. Returns the persisted
 * state. Serializes concurrent supervisors/CLI mutations on the same file.
 */
export function mutateFleetState(
  statePath: string,
  mutator: (current: FleetState) => FleetState,
): FleetState {
  return withFileLockSync(statePath, () => {
    const current = readFleetState(statePath) ?? { supervisorPid: 0, supervisorStartedAt: '', procs: [] };
    const next = mutator(structuredClone(current));
    assertProjectionIdentity(next.procs);
    atomicWriteFileSync(statePath, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
  });
}

/** Overwrite the whole state (still validated + locked). Used at supervisor boot. */
export function writeFleetState(statePath: string, state: FleetState): FleetState {
  return mutateFleetState(statePath, () => state);
}
