import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileLockTimeoutError, withFileLock } from '../utils/file-lock.js';
import {
  captureFleetProcessIdentity,
  fleetProcessIdentityRuntime,
  inspectFleetProcess,
  type FleetProcessAttestation,
  type FleetProcessIdentityRuntime,
  type FleetProcessInspection,
} from './fleet-process-identity.js';

export const DESKTOP_HOST_LEASES_DIRNAME = '.desktop-host-leases';

export function fleetMutationLockTarget(botmuxHome: string): string {
  return join(botmuxHome, 'pm2-fleet-mutation');
}

export const STOP_IF_EMPTY_RESULT_PREFIX = 'BOTMUX_STOP_IF_EMPTY_RESULT=';

export type StopIfEmptyCliOutcome =
  | 'stopped'
  | 'skipped:configured'
  | 'skipped:invalid-config'
  | 'skipped:other-host'
  | 'skipped:not-running'
  | 'skipped:pid-mismatch';

const VALID_STOP_IF_EMPTY_OUTCOMES = new Set<StopIfEmptyCliOutcome>([
  'stopped',
  'skipped:configured',
  'skipped:invalid-config',
  'skipped:other-host',
  'skipped:not-running',
  'skipped:pid-mismatch',
]);

export function formatStopIfEmptyCliOutcome(outcome: StopIfEmptyCliOutcome): string {
  return `${STOP_IF_EMPTY_RESULT_PREFIX}${outcome}`;
}

export function parseStopIfEmptyCliOutcome(stdout: string): StopIfEmptyCliOutcome | null {
  let matched: StopIfEmptyCliOutcome | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith(STOP_IF_EMPTY_RESULT_PREFIX)) continue;
    const value = line.slice(STOP_IF_EMPTY_RESULT_PREFIX.length) as StopIfEmptyCliOutcome;
    if (VALID_STOP_IF_EMPTY_OUTCOMES.has(value)) matched = value;
  }
  return matched;
}

export interface DesktopHostLeaseRecord {
  pid: number;
  processStart: string;
  pidNamespace?: string;
  commandLine?: string;
  startedAt: string;
}

/**
 * Parse and validate one attested lease file. Rejects legacy bare-PID records
 * (which lacked `processStart` and were vulnerable to PID reuse).
 */
export function parseDesktopHostLeaseRecord(raw: string, expectedPid: number): DesktopHostLeaseRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DesktopHostLeaseRecord> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 1 || parsed.pid !== expectedPid) {
      return null;
    }
    if (typeof parsed.processStart !== 'string' || !parsed.processStart.trim() || parsed.processStart.length > 256) {
      return null;
    }
    if (typeof parsed.startedAt !== 'string' || !parsed.startedAt.trim() || parsed.startedAt.length > 64) {
      return null;
    }
    if (parsed.pidNamespace !== undefined && (typeof parsed.pidNamespace !== 'string' || !parsed.pidNamespace.trim() || parsed.pidNamespace.length > 256)) {
      return null;
    }
    if (parsed.commandLine !== undefined && (typeof parsed.commandLine !== 'string' || parsed.commandLine.length > 8192)) {
      return null;
    }
    return {
      pid: parsed.pid,
      processStart: parsed.processStart,
      ...(parsed.pidNamespace ? { pidNamespace: parsed.pidNamespace } : {}),
      ...(parsed.commandLine !== undefined ? { commandLine: parsed.commandLine } : {}),
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

export function inspectDesktopHostLease(
  record: DesktopHostLeaseRecord,
  runtime: FleetProcessIdentityRuntime = fleetProcessIdentityRuntime,
): FleetProcessInspection {
  return inspectFleetProcess(
    record.pid,
    record.processStart,
    record.pidNamespace,
    commandLine => (record.commandLine !== undefined ? commandLine === record.commandLine : true),
    runtime,
    record.commandLine !== undefined,
  );
}

/**
 * Check whether any other attested Desktop host process currently holds a live
 * lease under `<botmuxHome>/.desktop-host-leases`.
 *
 * PID reuse returns `'stale'` before any commandLine/namespace check (and is
 * pruned when `pruneStale` is true). `'unverifiable'` fails safe (treats host
 * as possibly active) without unlinking its lease.
 */
export function hasOtherActiveDesktopHostLease(
  botmuxHome: string,
  options: {
    excludePid?: number;
    runtime?: FleetProcessIdentityRuntime;
    pruneStale?: boolean;
  } = {},
): boolean {
  const leaseDir = join(botmuxHome, DESKTOP_HOST_LEASES_DIRNAME);
  if (!existsSync(leaseDir)) return false;
  const runtime = options.runtime ?? fleetProcessIdentityRuntime;
  const pruneStale = options.pruneStale !== false;
  try {
    for (const name of readdirSync(leaseDir)) {
      const match = /^host-(\d+)\.json$/.exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === options.excludePid) continue;
      const filePath = join(leaseDir, name);
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      const record = parseDesktopHostLeaseRecord(raw, pid);
      if (!record) {
        if (pruneStale) {
          try { rmSync(filePath, { force: true }); } catch { /* ignore */ }
        }
        continue;
      }
      const inspection = inspectDesktopHostLease(record, runtime);
      if (inspection.status === 'exact' || inspection.status === 'unverifiable') {
        return true;
      }
      if (pruneStale) {
        try { rmSync(filePath, { force: true }); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return false;
}

export interface DesktopHostLeaseRegistry {
  ensureRegistered(): Promise<boolean>;
  unregister(): void;
  hasOtherActiveHost(): boolean;
}

/**
 * Cross-process fenced lease registry for Electron (`src/desktop/main.ts`) and
 * the native Swift host (`src/desktop/host/desktop-host.ts`).
 *
 * Registration serializes on `PM2_FLEET_MUTATION_LOCK_TARGET` — the exact same
 * lock held by `botmux stop --if-empty` — closing the rapid quit+reopen TOCTOU
 * window where an exiting host could stop a supervisor just adopted by a new host.
 */
export function createDesktopHostLeaseRegistry(
  botmuxHome: string,
  options: {
    selfPid?: number;
    runtime?: FleetProcessIdentityRuntime;
    lockMaxWaitMs?: number;
  } = {},
): DesktopHostLeaseRegistry {
  const selfPid = options.selfPid ?? process.pid;
  const runtime = options.runtime ?? fleetProcessIdentityRuntime;
  const lockMaxWaitMs = options.lockMaxWaitMs ?? 6_000;
  const leaseDir = join(botmuxHome, DESKTOP_HOST_LEASES_DIRNAME);
  const selfFile = join(leaseDir, `host-${selfPid}.json`);
  const lockTarget = fleetMutationLockTarget(botmuxHome);

  let registered = false;
  let disposed = false;
  let inFlight: Promise<boolean> | null = null;
  let cachedIdentity: FleetProcessAttestation | null | undefined;
  let startedAtIso: string | null = null;

  function resolveIdentity(): FleetProcessAttestation | null {
    if (cachedIdentity === undefined) {
      cachedIdentity = captureFleetProcessIdentity(selfPid, runtime);
    }
    return cachedIdentity;
  }

  function writeSelfLeaseUnlocked(identity: FleetProcessAttestation): boolean {
    if (disposed || !existsSync(botmuxHome)) return false;
    try {
      if (!existsSync(leaseDir)) mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
      startedAtIso ??= new Date().toISOString();
      const record: DesktopHostLeaseRecord = {
        pid: identity.pid,
        processStart: identity.processStart,
        ...(identity.pidNamespace ? { pidNamespace: identity.pidNamespace } : {}),
        ...(identity.commandLine !== undefined ? { commandLine: identity.commandLine } : {}),
        startedAt: startedAtIso,
      };
      const tmp = join(leaseDir, `.host-${selfPid}.${process.hrtime.bigint().toString(36)}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      renameSync(tmp, selfFile);
      registered = true;
      return true;
    } catch {
      return false;
    }
  }

  async function ensureRegistered(): Promise<boolean> {
    if (disposed) return false;
    if (registered && existsSync(selfFile)) return true;
    if (!existsSync(botmuxHome)) return false;
    if (inFlight) return inFlight;

    const pending: Promise<boolean> = (async (): Promise<boolean> => {
      const identity = resolveIdentity();
      if (!identity || disposed || !existsSync(botmuxHome)) return false;
      try {
        return await withFileLock(lockTarget, async () => writeSelfLeaseUnlocked(identity), { maxWaitMs: lockMaxWaitMs });
      } catch (err) {
        if (err instanceof FileLockTimeoutError) {
          // Do not stall host startup on a slow unrelated fleet operation; still
          // publish our lease so subsequent stop --if-empty sees us.
          return writeSelfLeaseUnlocked(identity);
        }
        return false;
      }
    })().finally(() => {
      if (inFlight === pending) inFlight = null;
    });
    inFlight = pending;
    return pending;
  }

  function unregister(): void {
    disposed = true;
    registered = false;
    try { rmSync(selfFile, { force: true }); } catch { /* ignore */ }
  }

  function hasOtherActiveHost(): boolean {
    return hasOtherActiveDesktopHostLease(botmuxHome, {
      excludePid: selfPid,
      runtime,
      pruneStale: false,
    });
  }

  return { ensureRegistered, unregister, hasOtherActiveHost };
}
