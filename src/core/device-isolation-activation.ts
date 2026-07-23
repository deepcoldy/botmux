/**
 * Short-lived daemon barrier used while a host enables device credentials.
 *
 * The barrier is deliberately process-local: the host CLI acquires one lease
 * from every online botmux daemon before it writes the one-way marker. While a
 * lease is held, forkWorker queues at most one cold spawn per logical session;
 * existing workers are inventoried and torn down by the authenticated daemon
 * IPC route. A bounded lease prevents a crashed host CLI from wedging a daemon
 * forever. No device secret is written until every daemon has committed and
 * released its lease.
 */
import { randomUUID } from 'node:crypto';

export const DEVICE_ISOLATION_ACTIVATION_VERSION = 1 as const;
export const DEVICE_ISOLATION_FREEZE_LEASE_MS = 30_000;

export interface DeviceIsolationFreezeLease {
  activationVersion: typeof DEVICE_ISOLATION_ACTIVATION_VERSION;
  leaseId: string;
  nonce: string;
  inventoryGeneration: string;
  acquiredAt: number;
  expiresAt: number;
}

let lease: DeviceIsolationFreezeLease | null = null;
let expiryTimer: NodeJS.Timeout | null = null;
const deferredSpawns = new Map<string, () => void>();

function clearExpiryTimer(): void {
  if (!expiryTimer) return;
  clearTimeout(expiryTimer);
  expiryTimer = null;
}

function flushDeferredSpawns(): void {
  const callbacks = [...deferredSpawns.values()];
  deferredSpawns.clear();
  for (const callback of callbacks) setImmediate(callback);
}

function expireIfNeeded(now = Date.now()): void {
  if (!lease || lease.expiresAt > now) return;
  lease = null;
  clearExpiryTimer();
  flushDeferredSpawns();
}

export function currentDeviceIsolationFreezeLease(
  now = Date.now(),
): DeviceIsolationFreezeLease | null {
  expireIfNeeded(now);
  return lease ? { ...lease } : null;
}

export type AcquireDeviceIsolationFreezeResult =
  | { ok: true; lease: DeviceIsolationFreezeLease; reused: boolean }
  | { ok: false; reason: 'busy' };

export function acquireDeviceIsolationFreeze(input: {
  nonce: string;
  inventoryGeneration: string;
  now?: number;
  leaseMs?: number;
  leaseIdFactory?: () => string;
}): AcquireDeviceIsolationFreezeResult {
  const now = input.now ?? Date.now();
  expireIfNeeded(now);
  if (lease) {
    if (lease.nonce !== input.nonce) return { ok: false, reason: 'busy' };
    return { ok: true, lease: { ...lease }, reused: true };
  }
  const leaseMs = input.leaseMs ?? DEVICE_ISOLATION_FREEZE_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 120_000) {
    throw new Error('invalid device-isolation freeze lease');
  }
  lease = {
    activationVersion: DEVICE_ISOLATION_ACTIVATION_VERSION,
    leaseId: (input.leaseIdFactory ?? randomUUID)(),
    nonce: input.nonce,
    inventoryGeneration: input.inventoryGeneration,
    acquiredAt: now,
    expiresAt: now + leaseMs,
  };
  clearExpiryTimer();
  expiryTimer = setTimeout(() => expireIfNeeded(), leaseMs + 1);
  expiryTimer.unref?.();
  return { ok: true, lease: { ...lease }, reused: false };
}

export function requireDeviceIsolationFreeze(input: {
  nonce: string;
  leaseId: string;
  now?: number;
}): DeviceIsolationFreezeLease | null {
  const current = currentDeviceIsolationFreezeLease(input.now);
  if (!current || current.nonce !== input.nonce || current.leaseId !== input.leaseId) {
    return null;
  }
  return current;
}

/**
 * Bind the post-freeze inventory to the lease. Prepare must acquire the spawn
 * barrier before it looks at sessions; otherwise a worker can appear between
 * inventory and freeze. Only the holder may replace the provisional value.
 */
export function bindDeviceIsolationFreezeInventoryGeneration(input: {
  nonce: string;
  leaseId: string;
  inventoryGeneration: string;
  now?: number;
}): DeviceIsolationFreezeLease | null {
  if (!requireDeviceIsolationFreeze(input) || !lease) return null;
  lease.inventoryGeneration = input.inventoryGeneration;
  return { ...lease };
}

export function releaseDeviceIsolationFreeze(input: {
  nonce: string;
  leaseId: string;
  now?: number;
}): boolean {
  if (!requireDeviceIsolationFreeze(input)) return false;
  lease = null;
  clearExpiryTimer();
  flushDeferredSpawns();
  return true;
}

/**
 * Queue only the first spawn request for a logical session. Later turns are
 * already retained by the session's normal pending-input machinery; replaying
 * multiple fork requests would instead kill and replace the first new worker.
 */
export function deferWorkerSpawnDuringDeviceIsolation(
  sessionId: string,
  callback: () => void,
  now = Date.now(),
): boolean {
  if (!currentDeviceIsolationFreezeLease(now)) return false;
  if (!deferredSpawns.has(sessionId)) deferredSpawns.set(sessionId, callback);
  return true;
}

/** Test-only reset; production callers release through the lease protocol. */
export function resetDeviceIsolationActivationForTest(): void {
  lease = null;
  clearExpiryTimer();
  deferredSpawns.clear();
}
