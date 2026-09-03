/**
 * Restart-intent breadcrumb: a small file written just before an *intentional*
 * restart (manual `botmux restart`, or an auto-update that restarts to apply).
 * On the next daemon startup the primary daemon consumes it to decide whether
 * to DM the owner a restart summary.
 *
 * A pm2 crash-autorestart (or machine reboot) writes no breadcrumb, so the
 * fresh daemon stays silent — this is how we distinguish "crash" from
 * "intentional restart" without a debounce. See core/maintenance.ts and
 * core/restart-report.ts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { config } from '../config.js';
import { readProcessStartIdentity } from '../core/session-marker.js';
import { withFileLockSync } from '../utils/file-lock.js';

export type RestartKind = 'manual' | 'update' | 'rollback';

export interface RestartIntentPayload {
  kind: RestartKind;
  /** Present for an update or rollback: the version delta to report. */
  oldVersion?: string;
  newVersion?: string;
  /** ISO 8601 timestamp the breadcrumb was written. */
  at: string;
}

export interface RestartIntent extends RestartIntentPayload {
  attemptId?: string;
  attemptState?: 'prepared' | 'committed' | 'aborted';
  deferredIntent?: RestartIntentPayload;
}

export type RestartIntentReportClaim =
  | { state: 'claimed'; intent: RestartIntent }
  | { state: 'prepared' }
  | { state: 'absent' };

const FILE = 'restart-intent.json';
const LEASE_FILE = 'restart-lease.json';

/** Breadcrumbs older than this are stale (an aborted/failed restart left it)
 *  and never produce a report. */
export const RESTART_INTENT_FRESH_MS = 10 * 60_000;
export const RESTART_LEASE_CLAIM_MS = 60_000;
export const RESTART_LEASE_MAX_MS = 30 * 60_000;

export function restartIntentPathIn(dir: string): string {
  return join(dir, FILE);
}

function writeRestartIntentUnlocked(dir: string, intent: RestartIntent): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = restartIntentPathIn(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(intent, null, 2) + '\n');
  renameSync(tmp, path);
}

export function clearRestartIntentTo(dir: string): void {
  if (!existsSync(dir)) return;
  withFileLockSync(restartIntentPathIn(dir), () => {
    try { rmSync(restartIntentPathIn(dir)); } catch { /* absent / best-effort */ }
  });
}

function payloadOf(intent: RestartIntent): RestartIntentPayload {
  return {
    kind: intent.kind,
    at: intent.at,
    ...(intent.oldVersion !== undefined ? { oldVersion: intent.oldVersion } : {}),
    ...(intent.newVersion !== undefined ? { newVersion: intent.newVersion } : {}),
  };
}

export function writeRestartIntentTo(dir: string, intent: RestartIntent): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  withFileLockSync(restartIntentPathIn(dir), () => {
    const current = readRaw(dir);
    const intentAt = Date.parse(intent.at);
    const writerNow = Number.isFinite(intentAt) ? intentAt : Date.now();
    if ((current?.attemptState === 'prepared' || current?.attemptState === 'aborted')
        && isFresh(current, writerNow)) {
      writeRestartIntentUnlocked(dir, {
        ...current,
        deferredIntent: payloadOf(intent),
      });
      return;
    }
    writeRestartIntentUnlocked(dir, payloadOf(intent));
  });
}

function readRaw(dir: string): RestartIntent | null {
  const path = restartIntentPathIn(dir);
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, 'utf-8'));
    if (v && typeof v === 'object' && typeof v.kind === 'string' && typeof v.at === 'string') {
      return v as RestartIntent;
    }
  } catch {
    /* corrupt → treated as absent (and cleaned up by consume) */
  }
  return null;
}

function isFresh(intent: RestartIntent, nowMs: number): boolean {
  const at = Date.parse(intent.at);
  return Number.isFinite(at) && Math.abs(nowMs - at) <= RESTART_INTENT_FRESH_MS;
}

export function restartLeasePathIn(dir: string): string {
  return join(dir, LEASE_FILE);
}

interface RestartLease {
  id: string;
  at: number;
  pid?: number;
  procStart?: string;
}

function readRestartLeaseTo(dir: string): RestartLease | null {
  try {
    const value = JSON.parse(readFileSync(restartLeasePathIn(dir), 'utf-8')) as Record<string, unknown>;
    if (typeof value.id !== 'string' || !value.id || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
    if (value.pid !== undefined && (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 1)) return null;
    if (value.procStart !== undefined && (typeof value.procStart !== 'string' || !value.procStart)) return null;
    return {
      id: value.id,
      at: value.at,
      ...(typeof value.pid === 'number' ? { pid: value.pid } : {}),
      ...(typeof value.procStart === 'string' ? { procStart: value.procStart } : {}),
    };
  } catch {
    return null;
  }
}

/** Call while holding globalInstallUpdateLockTarget(). */
export function hasActiveRestartLeaseTo(dir: string, nowMs: number): boolean {
  const lease = readRestartLeaseTo(dir);
  if (!lease) return false;
  const age = nowMs - lease.at;
  if (!Number.isFinite(nowMs)) return false;
  if (!lease.pid) return age >= 0 && age <= RESTART_LEASE_CLAIM_MS;
  if (lease.procStart) {
    const liveStart = readProcessStartIdentity(lease.pid);
    if (liveStart !== undefined) {
      if (liveStart !== lease.procStart) return false;
      // A matching process birth identity tolerates bounded wall-clock skew.
      // Provisional leases never receive this identity-based exception.
      // A stuck driver must not hold the lease forever: even if the process
      // is still alive (and its start time matches), expire after MAX_MS so a
      // new restart can be attempted.
      if (age < -RESTART_LEASE_MAX_MS || age > RESTART_LEASE_MAX_MS) return false;
      return true;
    }
  }
  if (age < 0 || age > RESTART_LEASE_MAX_MS) return false;
  try { process.kill(lease.pid, 0); return true; } catch { return false; }
}

/** Claim the restart handoff while holding globalInstallUpdateLockTarget(). */
export function claimRestartLeaseTo(dir: string, nowMs: number): string | null {
  if (hasActiveRestartLeaseTo(dir, nowMs)) return null;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = restartLeasePathIn(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  const id = randomBytes(12).toString('hex');
  writeFileSync(tmp, JSON.stringify({ id, at: nowMs }) + '\n');
  renameSync(tmp, path);
  return id;
}

/** Bind a provisional claim while holding globalInstallUpdateLockTarget(). */
export function bindRestartLeaseTo(dir: string, id: string, pid: number, nowMs: number): boolean {
  const lease = readRestartLeaseTo(dir);
  if (
    !lease
    || lease.id !== id
    || lease.pid !== undefined
    || lease.procStart !== undefined
    || !Number.isFinite(nowMs)
    || nowMs < lease.at
    || nowMs - lease.at > RESTART_LEASE_CLAIM_MS
    || !Number.isSafeInteger(pid)
    || pid <= 1
  ) return false;
  const path = restartLeasePathIn(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  const procStart = readProcessStartIdentity(pid);
  writeFileSync(tmp, JSON.stringify({ id, at: nowMs, pid, ...(procStart ? { procStart } : {}) }) + '\n');
  renameSync(tmp, path);
  return true;
}

function clearRestartLeaseToUnlocked(dir: string, id: string): void {
  if (readRestartLeaseTo(dir)?.id !== id) return;
  try { rmSync(restartLeasePathIn(dir)); } catch { /* absent / best-effort */ }
}

/**
 * Best-effort clear through the same lock used by claim/bind. Launch-failure
 * cleanup can run from an event callback after the caller released that lock;
 * never block or throw there. A busy lock leaves the generation lease to expire.
 */
export function clearRestartLeaseToLocked(dir: string, id: string, lockTarget: string): boolean {
  try {
    withFileLockSync(lockTarget, () => clearRestartLeaseToUnlocked(dir, id), { maxWaitMs: 0 });
    return true;
  } catch {
    return false;
  }
}

/** Low-level helper for callers that already hold the global update lock. */
export function clearRestartLeaseTo(dir: string, id: string): void {
  clearRestartLeaseToUnlocked(dir, id);
}

/** Read + delete the breadcrumb. Always deletes (fresh, stale, or corrupt) so
 *  it fires at most once and never lingers into a later restart. Returns the
 *  intent only when it is fresh. */
export function consumeRestartIntentTo(dir: string, nowMs: number): RestartIntent | null {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return withFileLockSync(restartIntentPathIn(dir), () => {
    const intent = readRaw(dir);
    const path = restartIntentPathIn(dir);
    if ((intent?.attemptState === 'prepared' || intent?.attemptState === 'aborted')
        && isFresh(intent, nowMs)) {
      return null;
    }
    if (existsSync(path)) {
      try { rmSync(path); } catch { /* best-effort */ }
    }
    if (!intent) return null;
    return isFresh(intent, nowMs) ? intent : null;
  });
}

export function claimRestartIntentForReportTo(
  dir: string,
  nowMs: number,
): RestartIntentReportClaim {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return withFileLockSync(restartIntentPathIn(dir), () => {
    const intent = readRaw(dir);
    const path = restartIntentPathIn(dir);
    if (!intent || !isFresh(intent, nowMs)) {
      if (existsSync(path)) {
        try { rmSync(path); } catch { /* best-effort stale/corrupt cleanup */ }
      }
      return { state: 'absent' };
    }
    if (intent.attemptState === 'prepared') return { state: 'prepared' };
    if (intent.attemptState === 'aborted') return { state: 'absent' };
    if (existsSync(path)) {
      try { rmSync(path); }
      catch { return { state: 'absent' }; }
    }
    return { state: 'claimed', intent };
  });
}

export function hasPreparedRestartIntentTo(dir: string, nowMs: number): boolean {
  if (!existsSync(dir)) return false;
  return withFileLockSync(restartIntentPathIn(dir), () => {
    const intent = readRaw(dir);
    if (intent?.attemptState !== 'prepared') return false;
    if (isFresh(intent, nowMs)) return true;
    try { rmSync(restartIntentPathIn(dir)); } catch { /* best-effort stale cleanup */ }
    return false;
  });
}

/** Write a `manual` breadcrumb only when no *fresh* breadcrumb already exists —
 *  so a maintenance-written `update` breadcrumb is not clobbered
 *  by the `botmux restart` it spawns. */
export function writeManualIntentIfAbsentTo(dir: string, nowMs: number, atIso: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  withFileLockSync(restartIntentPathIn(dir), () => {
    const existing = readRaw(dir);
    if (existing && isFresh(existing, nowMs)) return;
    writeRestartIntentUnlocked(dir, { kind: 'manual', at: atIso });
  });
}

export function writeRestartAttemptIntentTo(
  dir: string,
  preferred: RestartIntent,
  nowMs: number,
  attemptId: string,
): RestartIntent {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return withFileLockSync(restartIntentPathIn(dir), () => {
    const existing = readRaw(dir);
    const selected = existing && isFresh(existing, nowMs)
      ? ((existing.attemptState === 'prepared' || existing.attemptState === 'aborted')
          && existing.deferredIntent
          ? existing.deferredIntent
          : payloadOf(existing))
      : payloadOf(preferred);
    const written: RestartIntent = { ...selected, attemptId, attemptState: 'prepared' };
    writeRestartIntentUnlocked(dir, written);
    return written;
  });
}

export function commitRestartIntentAttemptTo(dir: string, attemptId: string): boolean {
  if (!existsSync(dir)) return false;
  return withFileLockSync(restartIntentPathIn(dir), () => {
    const current = readRaw(dir);
    if (current?.attemptId !== attemptId || current.attemptState !== 'prepared') return false;
    const selected = current.deferredIntent ?? payloadOf(current);
    writeRestartIntentUnlocked(dir, {
      ...selected,
      attemptId,
      attemptState: 'committed',
    });
    return true;
  });
}

export function removeRestartIntentAttemptTo(dir: string, attemptId: string): boolean {
  if (!existsSync(dir)) return false;
  return withFileLockSync(restartIntentPathIn(dir), () => {
    const current = readRaw(dir);
    if (current?.attemptId !== attemptId) return false;
    writeRestartIntentUnlocked(dir, {
      ...(current.deferredIntent ?? payloadOf(current)),
      attemptId: `aborted:${attemptId}`,
      attemptState: 'aborted',
    });
    return true;
  });
}

// ---- default-dir wrappers (production wiring) ----

export function writeRestartIntent(intent: RestartIntent): void {
  writeRestartIntentTo(config.session.dataDir, intent);
}

export function clearRestartIntent(): void {
  clearRestartIntentTo(config.session.dataDir);
}

export function consumeRestartIntent(nowMs: number = Date.now()): RestartIntent | null {
  return consumeRestartIntentTo(config.session.dataDir, nowMs);
}

export function hasActiveRestartLease(nowMs: number = Date.now()): boolean {
  return hasActiveRestartLeaseTo(config.session.dataDir, nowMs);
}

export function claimRestartLease(nowMs: number = Date.now()): string | null {
  return claimRestartLeaseTo(config.session.dataDir, nowMs);
}

export function clearRestartLease(id: string): void {
  clearRestartLeaseTo(config.session.dataDir, id);
}

export function clearRestartLeaseLocked(id: string): boolean {
  const dataDir = config.session.dataDir;
  return clearRestartLeaseToLocked(dataDir, id, join(dataDir, 'npm-global-update'));
}

export function claimRestartIntentForReport(
  nowMs: number = Date.now(),
): RestartIntentReportClaim {
  return claimRestartIntentForReportTo(config.session.dataDir, nowMs);
}

export function hasPreparedRestartIntent(nowMs: number = Date.now()): boolean {
  return hasPreparedRestartIntentTo(config.session.dataDir, nowMs);
}

export function writeManualIntentIfAbsent(nowMs: number = Date.now()): void {
  writeManualIntentIfAbsentTo(config.session.dataDir, nowMs, new Date(nowMs).toISOString());
}
