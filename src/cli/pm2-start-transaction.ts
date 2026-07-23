import type { FleetProcessEntry } from './fleet-shutdown.js';
import { DAEMON_GRACEFUL_EXIT_CODE } from '../core/supervisor-shutdown-protocol.js';

/** Preserve PM2's raw stop_exit_codes elements for exact policy validation.
 * PM2 applies parseInt to string elements at exit time, so lossy numeric
 * projection would hide restart-suppressing extras such as "0foo". */
export function normalizeRawPm2StopExitCodes(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : [value];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertUniqueConfiguredNames(names: string[]): void {
  const unique = new Set(names);
  if (unique.size !== names.length || names.some(name => !name.trim())) {
    throw new Error('configured PM2 fleet names must be unique and non-empty');
  }
}

function assertProjectionIdentities(
  operation: string,
  entries: FleetProcessEntry[],
): void {
  const names = new Set<string>();
  const ids = new Map<number, string>();
  const positivePids = new Map<number, string>();
  for (const entry of entries) {
    if (names.has(entry.name)) {
      throw new Error(`[${operation}] duplicate singleton PM2 row for ${entry.name}`);
    }
    names.add(entry.name);
    if (!Number.isSafeInteger(entry.pmId) || (entry.pmId as number) < 0) {
      throw new Error(`[${operation}] ${entry.name} has no canonical pm_id`);
    }
    const prior = ids.get(entry.pmId as number);
    if (prior !== undefined) {
      throw new Error(
        `[${operation}] duplicate canonical pm_id ${entry.pmId} across ${prior} and ${entry.name}`,
      );
    }
    ids.set(entry.pmId as number, entry.name);
    if (Number.isSafeInteger(entry.pid) && entry.pid > 1) {
      const priorPidName = positivePids.get(entry.pid);
      if (priorPidName !== undefined) {
        throw new Error(
          `[${operation}] duplicate positive pid ${entry.pid} across ${priorPidName} and ${entry.name}`,
        );
      }
      positivePids.set(entry.pid, entry.name);
    }
  }
}

function assertNoUnexpectedRows(
  operation: string,
  entries: FleetProcessEntry[],
  configuredNames: string[],
): void {
  const configured = new Set(configuredNames);
  const unexpected = entries.filter(entry => !configured.has(entry.name));
  if (unexpected.length > 0) {
    throw new Error(
      `[${operation}] unexpected PM2 core row(s): ${unexpected.map(entry => entry.name).join(', ')}`,
    );
  }
}

function isOnlineAndLive(
  entry: FleetProcessEntry,
  isAlive: (pid: number) => boolean,
): boolean {
  return entry.online
    && Number.isSafeInteger(entry.pid)
    && entry.pid > 1
    && isAlive(entry.pid);
}

/** The in-memory shutdown capability is insufficient when PM2 still owns an
 * old registry policy. In particular `stop_exit_codes:[0]` suppresses restart
 * after PM2 normalizes SIGKILL/OOM to exit_code 0. Require the exact daemon
 * policy that makes only shutdown()'s reserved sentinel terminal. */
export function assertDaemonPm2GracefulExitPolicy(
  operation: string,
  entries: FleetProcessEntry[],
): void {
  const unsafe = entries.filter(entry => {
    const codes = entry.stopExitCodes;
    const exactSentinel = Array.isArray(codes)
      && codes.length === 1
      && (codes[0] === DAEMON_GRACEFUL_EXIT_CODE
        || codes[0] === String(DAEMON_GRACEFUL_EXIT_CODE));
    const restartEnabled = entry.autorestart === true || entry.autorestart === 'true';
    return !exactSentinel || !restartEnabled;
  });
  if (unsafe.length > 0) {
    throw new Error(
      `[${operation}] daemon PM2 policy does not prove signal-death autorestart `
      + `(expected autorestart=true and stop_exit_codes=[${DAEMON_GRACEFUL_EXIT_CODE}]; unsafe: `
      + `${unsafe.map(entry => entry.name).join(', ')}). `
      + 'For a one-time pre-protocol upgrade, first independently confirm every Session/Riff '
      + 'workload is idle, then run: botmux restart --bootstrap-shutdown-protocol --yes',
    );
  }
}

/** Require one exact, online, OS-live registry row for every configured core
 * process and no stale/foreign core rows. This is the postcondition for every
 * public fleet start surface. */
export function assertConfiguredPm2FleetOnline(
  operation: string,
  entries: FleetProcessEntry[],
  configuredNames: string[],
  isAlive: (pid: number) => boolean,
): void {
  assertUniqueConfiguredNames(configuredNames);
  assertProjectionIdentities(operation, entries);
  assertNoUnexpectedRows(operation, entries, configuredNames);

  const unavailable = configuredNames.filter(name => {
    const row = entries.find(entry => entry.name === name);
    return !row || !isOnlineAndLive(row, isAlive);
  });
  if (unavailable.length > 0 || entries.length !== configuredNames.length) {
    throw new Error(
      `[${operation}] configured PM2 fleet is not fully online`
      + (unavailable.length > 0 ? ` (unavailable: ${unavailable.join(', ')})` : ''),
    );
  }
}

/** PM2 `online` is published before a daemon's shutdown endpoint/handler-ready
 * capability. A public start is complete only after both authorities agree. */
export function assertConfiguredPm2FleetReady<TEntry extends FleetProcessEntry>(
  operation: string,
  entries: TEntry[],
  configuredNames: string[],
  isAlive: (pid: number) => boolean,
  assertDaemonCapabilities: (entries: TEntry[]) => void,
): void {
  assertConfiguredPm2FleetOnline(operation, entries, configuredNames, isAlive);
  assertDaemonCapabilities(entries);
}

/** Capability scanners used by shutdown may legitimately omit a target that
 * exited during their read. Start verification may not: require an exact
 * attested PID set and recheck OS liveness after the capability scan. */
export function assertExactAttestedDaemonSet(
  operation: string,
  daemonEntries: FleetProcessEntry[],
  attestedPids: readonly number[],
  isAlive: (pid: number) => boolean,
): void {
  const expected = daemonEntries.map(entry => entry.pid).sort((a, b) => a - b);
  const actual = [...attestedPids].sort((a, b) => a - b);
  if (expected.length !== actual.length
      || expected.some((pid, index) => pid !== actual[index])) {
    throw new Error(
      `[${operation}] handler-ready capability set is incomplete `
      + `(expected pids: ${expected.join(', ') || 'none'}; attested: ${actual.join(', ') || 'none'})`,
    );
  }
  const deadAfterAttestation = daemonEntries.filter(entry => !isAlive(entry.pid));
  if (deadAfterAttestation.length > 0) {
    throw new Error(
      `[${operation}] daemon exited after capability attestation: `
      + deadAfterAttestation.map(entry => `${entry.name}/${entry.pid}`).join(', '),
    );
  }
}

export type StartBotFleetAdmission =
  | { state: 'already-online' }
  | { state: 'start-eligible' }
  | { state: 'fleet-down' };

/** `start-bot` is safe only for the append-one-bot case: either the entire
 * configured fleet is already online, or exactly the requested bot row is
 * absent while every other configured bot and the dashboard are online. */
export function classifyStartBotFleetAdmission(
  operation: string,
  entries: FleetProcessEntry[],
  configuredNames: string[],
  targetName: string,
  isAlive: (pid: number) => boolean,
): StartBotFleetAdmission {
  assertUniqueConfiguredNames(configuredNames);
  if (!configuredNames.includes(targetName)) {
    throw new Error(`[${operation}] target ${targetName} is not configured`);
  }
  assertProjectionIdentities(operation, entries);
  assertNoUnexpectedRows(operation, entries, configuredNames);
  if (entries.length === 0) return { state: 'fleet-down' };

  const targetRows = entries.filter(entry => entry.name === targetName);
  const unavailablePeers = configuredNames
    .filter(name => name !== targetName)
    .filter(name => {
      const row = entries.find(entry => entry.name === name);
      return !row || !isOnlineAndLive(row, isAlive);
    });
  if (unavailablePeers.length > 0) {
    throw new Error(
      `[${operation}] refusing single-bot start because configured peer(s) are unavailable: `
      + unavailablePeers.join(', '),
    );
  }
  if (targetRows.length === 0) {
    if (entries.length !== configuredNames.length - 1) {
      throw new Error(`[${operation}] fleet is not the exact one-missing-bot shape`);
    }
    return { state: 'start-eligible' };
  }
  const target = targetRows[0]!;
  if (!isOnlineAndLive(target, isAlive)) {
    throw new Error(
      `[${operation}] refusing start-bot for existing non-live/transitional row ${targetName}`,
    );
  }
  if (entries.length !== configuredNames.length) {
    throw new Error(`[${operation}] fleet is not the exact fully-configured shape`);
  }
  return { state: 'already-online' };
}

export interface Pm2StartTransactionRuntime<TProjection> {
  start(timeoutMs: number): void;
  /** Must obtain a new projection and validate the complete expected state. */
  verifyFresh(timeoutMs: number): TProjection;
  /** Must independently re-read authority before compensating partial launch. */
  rollback(): void;
}

/** Run one bounded PM2 launch and make the fresh fleet projection—not the CLI
 * exit code—the success authority. Any incomplete/unverified launch is
 * compensated before the error escapes. */
export function runBoundedPm2StartTransaction<TProjection>(
  operation: string,
  startTimeoutMs: number,
  verifyTimeoutMs: number,
  runtime: Pm2StartTransactionRuntime<TProjection>,
): TProjection {
  if (!Number.isFinite(startTimeoutMs) || startTimeoutMs <= 0
      || !Number.isFinite(verifyTimeoutMs) || verifyTimeoutMs <= 0) {
    throw new Error(`[${operation}] PM2 start/verification budgets must be positive`);
  }

  let startFailure: unknown;
  try { runtime.start(Math.floor(startTimeoutMs)); }
  catch (error) { startFailure = error; }

  try {
    // A timed-out client can race with a God RPC that already completed. A
    // complete fresh projection is therefore stronger evidence than the
    // launcher exit code and is safe to accept.
    return runtime.verifyFresh(Math.floor(verifyTimeoutMs));
  } catch (verifyFailure) {
    let rollbackFailure: unknown;
    try { runtime.rollback(); }
    catch (error) { rollbackFailure = error; }
    throw new Error(
      `[${operation}] PM2 start transaction did not reach a verified complete fleet`
      + (startFailure ? ` (start: ${errorText(startFailure)})` : '')
      + ` (verify: ${errorText(verifyFailure)})`
      + (rollbackFailure
        ? `; partial-launch rollback failed: ${errorText(rollbackFailure)}`
        : '; partial launch was rolled back'),
    );
  }
}

export interface LatePm2StartRollbackRuntime {
  now(): number;
  sleep(ms: number): void;
  /** Re-read authority and compensate anything currently published. Return
   * true only when this observation exactly matches the pre-start state. */
  reconcileOnce(): boolean;
}

/** A killed/timed-out PM2 client does not cancel work already queued in God.
 * Therefore an empty first rollback projection is not success: require one
 * continuous restored window, resetting it whenever a late row appears. */
export function reconcileLatePm2StartPublication(
  operation: string,
  settleMs: number,
  timeoutMs: number,
  runtime: LatePm2StartRollbackRuntime,
): void {
  if (!Number.isFinite(settleMs) || settleMs < 0
      || !Number.isFinite(timeoutMs) || timeoutMs <= settleMs) {
    throw new Error(`[${operation}] invalid late-publication rollback budgets`);
  }
  const deadline = runtime.now() + Math.floor(timeoutMs);
  let restoredSince: number | undefined;
  while (runtime.now() < deadline) {
    const restored = runtime.reconcileOnce();
    const now = runtime.now();
    if (now >= deadline) break;
    if (!restored) {
      restoredSince = undefined;
      runtime.sleep(Math.min(100, Math.max(1, deadline - now)));
      continue;
    }
    restoredSince ??= now;
    const settledFor = now - restoredSince;
    if (settledFor >= settleMs) return;
    runtime.sleep(Math.min(100, settleMs - settledFor, Math.max(1, deadline - now)));
  }
  throw new Error(
    `[${operation}] partial-launch rollback remains uncertain after the late-publication settle window`,
  );
}
