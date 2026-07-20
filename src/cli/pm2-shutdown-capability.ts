import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SUPERVISOR_SHUTDOWN_PROTOCOL } from '../core/supervisor-shutdown-protocol.js';
import { readSupervisorProcessStartIdentity } from '../core/process-start-identity.js';

export interface Pm2ShutdownCapabilityTarget {
  name: string;
  pid: number;
}

export interface AttestedPm2DaemonShutdownTarget extends Pm2ShutdownCapabilityTarget {
  larkAppId: string;
  ipcPort: number;
  bootInstanceId: string;
  processStartIdentity: string;
}

export interface Pm2ShutdownCapabilityRuntime {
  now(): number;
  exists(path: string): boolean;
  readdir(path: string): string[];
  read(path: string): string;
  mtime(path: string): number;
  isAlive(pid: number): boolean;
  readStartIdentity(pid: number): string | undefined;
}

const FRESH_MS = 90_000;

const defaultRuntime: Pm2ShutdownCapabilityRuntime = {
  now: () => Date.now(),
  exists: path => existsSync(path),
  readdir: path => readdirSync(path),
  read: path => readFileSync(path, 'utf8'),
  mtime: path => statSync(path).mtimeMs,
  isAlive: pid => { try { process.kill(pid, 0); return true; } catch { return false; } },
  readStartIdentity: pid => {
    // Lazy import is unnecessary here: this pure helper has no daemon state.
    // The concrete function is injected below to keep tests deterministic.
    return readSupervisorProcessStartIdentity(pid);
  },
};

function failure(operation: string, detail: string): Error {
  return new Error(
    `[${operation}] refusing to signal daemon generation(s): ${detail}. `
    + `The live daemon may predate shutdown protocol ${SUPERVISOR_SHUTDOWN_PROTOCOL}; `
    + 'normal stop/restart intentionally fails closed on this first-upgrade boundary. '
    + 'Confirm every Session/Riff workload is idle before an operator-approved one-time manual bootstrap; '
    + 'automatic update must not be reported as applied until the new handler-ready fleet is verified',
  );
}

/**
 * Require every still-live target daemon PID to own one fresh, daemon-written
 * descriptor advertising the exact safe shutdown protocol. This is a rollout
 * boundary, not a package-version guess: installing a new CLI does not upgrade
 * an already-running old daemon in memory.
 */
export function assertPm2DaemonShutdownCapabilitiesIn(
  operation: string,
  targets: readonly Pm2ShutdownCapabilityTarget[],
  registryDir: string,
  runtime: Pm2ShutdownCapabilityRuntime = defaultRuntime,
): AttestedPm2DaemonShutdownTarget[] {
  const invalid = targets.filter(target =>
    !target.name.trim() || !Number.isSafeInteger(target.pid) || target.pid <= 1);
  if (invalid.length > 0) {
    throw failure(operation, 'shutdown target has no canonical name/live PID');
  }
  const duplicatePids = [...new Set(targets.map(target => target.pid))]
    .filter(pid => targets.filter(target => target.pid === pid).length > 1);
  if (duplicatePids.length > 0) {
    throw failure(operation, `multiple shutdown targets share PID(s) ${duplicatePids.join(', ')}`);
  }

  // A generation that exited before attestation needs no signal. Any successor
  // is discovered from a fresh PM2 projection and must attest independently.
  const liveTargets = targets.filter(target => runtime.isAlive(target.pid));
  if (liveTargets.length === 0) return [];
  if (!runtime.exists(registryDir)) {
    throw failure(operation, 'daemon descriptor registry is missing');
  }

  let names: string[];
  try { names = runtime.readdir(registryDir); }
  catch (error) {
    throw failure(
      operation,
      `daemon descriptor registry is unreadable (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const now = runtime.now();
  const targetPids = new Set(liveTargets.map(target => target.pid));
  const descriptors = new Map<number, Record<string, unknown>>();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(registryDir, name);
    let mtimeMs: number;
    try { mtimeMs = runtime.mtime(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw failure(
        operation,
        `cannot inspect daemon descriptor ${name} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const mtimeFresh = now - mtimeMs <= FRESH_MS;

    let value: unknown;
    try { value = JSON.parse(runtime.read(path)); }
    catch (error) {
      if (!mtimeFresh) continue;
      throw failure(
        operation,
        `fresh daemon descriptor ${name} is unreadable or malformed `
        + `(${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
    const heartbeat = record?.lastHeartbeat;
    const heartbeatFresh = typeof heartbeat === 'number'
      && Number.isFinite(heartbeat)
      && now - heartbeat <= FRESH_MS;
    if (!mtimeFresh && !heartbeatFresh) continue;

    const pid = record?.pid;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 1) {
      throw failure(operation, `fresh daemon descriptor ${name} has no canonical PID`);
    }
    if (!targetPids.has(pid as number)) continue;
    if (!heartbeatFresh) {
      throw failure(operation, `daemon descriptor ${name} has no fresh semantic heartbeat`);
    }
    if (!runtime.isAlive(pid as number)) continue;
    if (descriptors.has(pid as number)) {
      throw failure(operation, `multiple fresh descriptors claim live PID ${pid}`);
    }
    descriptors.set(pid as number, record!);
  }

  const authorized: AttestedPm2DaemonShutdownTarget[] = [];
  for (const target of liveTargets) {
    const descriptor = descriptors.get(target.pid);
    if (!descriptor) {
      // Re-check process birth: a generation that exited during the registry
      // scan needs no signal, but a same-PID successor must not inherit a stale
      // capability.
      if (!runtime.readStartIdentity(target.pid) && !runtime.isAlive(target.pid)) continue;
      throw failure(
        operation,
        `${target.name}/${target.pid} has no matching fresh daemon descriptor`,
      );
    }
    if (descriptor.supervisorShutdownProtocol !== SUPERVISOR_SHUTDOWN_PROTOCOL) {
      throw failure(
        operation,
        `${target.name}/${target.pid} does not attest ${SUPERVISOR_SHUTDOWN_PROTOCOL}`,
      );
    }
    const larkAppId = descriptor.larkAppId;
    const ipcPort = descriptor.ipcPort;
    const bootInstanceId = descriptor.bootInstanceId;
    if (typeof larkAppId !== 'string' || !larkAppId.trim()
        || !Number.isSafeInteger(ipcPort) || (ipcPort as number) < 1 || (ipcPort as number) > 65_535
        || typeof bootInstanceId !== 'string' || !bootInstanceId) {
      throw failure(
        operation,
        `${target.name}/${target.pid} descriptor has no canonical app/port/boot identity`,
      );
    }
    const describedStart = descriptor.processStartIdentity;
    if (typeof describedStart !== 'string' || !describedStart) {
      throw failure(
        operation,
        `${target.name}/${target.pid} descriptor has no process-start identity`,
      );
    }
    const currentStart = runtime.readStartIdentity(target.pid);
    if (!currentStart) {
      if (!runtime.isAlive(target.pid)) continue;
      throw failure(
        operation,
        `cannot revalidate process-start identity for ${target.name}/${target.pid}`,
      );
    }
    if (currentStart !== describedStart) {
      throw failure(
        operation,
        `${target.name}/${target.pid} process-start identity does not match its descriptor`,
      );
    }
    authorized.push({
      ...target,
      larkAppId: larkAppId.trim(),
      ipcPort: ipcPort as number,
      bootInstanceId,
      processStartIdentity: describedStart,
    });
  }
  return authorized;
}
