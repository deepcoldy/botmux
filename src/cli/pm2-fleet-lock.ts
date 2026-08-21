import { join } from 'node:path';
import { homedir } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { withFileLock, withFileLockSync } from '../utils/file-lock.js';

/**
 * One lock for every botmux-internal mutation of the shared PM2_HOME
 * (~/.botmux/pm2): core fleet stop/start/restart AND plugin service
 * lifecycle. Core and plugin apps live under the same God, so two separate
 * locks would let a concurrent plugin start slip between an include-pm2
 * restart's plugin stop and its `pm2 kill`, or between the kill and the fresh
 * fleet start. Computed lazily so tests can repoint HOME.
 */
export function pm2FleetMutationLockTarget(): string {
  return join(homedir(), '.botmux', 'pm2-fleet-mutation');
}

/**
 * Re-entrancy ownership is bound to the ASYNC CALL CHAIN, not the process: a
 * module-level counter would let an unrelated concurrent flow in the same
 * process (the dashboard serves POST /api/plugins/:id/services/* handlers
 * concurrently) mistake "someone in this process holds the lock" for "I hold
 * the lock" and skip the file lock entirely. AsyncLocalStorage context only
 * flows into calls awaited UNDER the holder's callback, so nested calls
 * (cmdRestart stopping plugin services while holding the lock) short-circuit
 * while independent concurrent flows queue on the file lock like any other
 * process.
 */
const lockOwnership = new AsyncLocalStorage<{ held: true }>();

/** True only within the async call chain that currently holds the lock. */
export function pm2FleetMutationLockHeld(): boolean {
  return lockOwnership.getStore() !== undefined;
}

/**
 * Serialize a PM2_HOME mutation against every other botmux flow — other
 * processes via the file lock, other async chains in THIS process via the
 * same file lock (file-lock treats a live same-pid holder as held, not
 * stale). Lock order is fixed: fleet lock FIRST, then the plugin service
 * lock — never the reverse.
 */
export async function withPm2FleetMutationLock<T>(
  fn: () => Promise<T> | T,
  opts: { maxWaitMs?: number } = {},
): Promise<T> {
  if (lockOwnership.getStore()) return await fn();
  return withFileLock(
    pm2FleetMutationLockTarget(),
    () => lockOwnership.run({ held: true }, async () => fn()),
    opts,
  );
}

/** Sync variant for sync call sites (plugin service lock wrapper). */
export function withPm2FleetMutationLockSync<T>(
  fn: () => T,
  opts: { maxWaitMs?: number } = {},
): T {
  if (lockOwnership.getStore()) return fn();
  return withFileLockSync(
    pm2FleetMutationLockTarget(),
    () => lockOwnership.run({ held: true }, fn),
    opts,
  );
}
