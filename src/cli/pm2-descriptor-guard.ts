import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readSupervisorProcessStartIdentity } from '../core/process-start-identity.js';

export interface Pm2DescriptorProjectionEntry {
  pid: number;
}

export interface Pm2DescriptorGuardRuntime {
  now(): number;
  exists(path: string): boolean;
  readdir(path: string): string[];
  read(path: string): string;
  mtime(path: string): number;
  isAlive(pid: number): boolean;
  readStartIdentity(pid: number): string | undefined;
}

const FRESH_MS = 90_000;

const defaultRuntime: Pm2DescriptorGuardRuntime = {
  now: () => Date.now(),
  exists: path => existsSync(path),
  readdir: path => readdirSync(path),
  read: path => readFileSync(path, 'utf8'),
  mtime: path => statSync(path).mtimeMs,
  isAlive: pid => { try { process.kill(pid, 0); return true; } catch { return false; } },
  readStartIdentity: pid => readSupervisorProcessStartIdentity(pid),
};

/** Reconcile PM2 registry authority with daemon-owned descriptors before a
 * core mutation. Fresh semantic corruption is fail-closed. A stale descriptor
 * is not automatically harmless: an event-loop-frozen/orphan daemon can remain
 * live after PM2 loses its registry. Ignore a semantically parseable stale
 * record only after proving its PID dead or owned by a different process birth. */
export function assertNoUnregisteredLiveDaemonDescriptorsIn(
  operation: string,
  projections: Pm2DescriptorProjectionEntry[],
  registryDir: string,
  runtime: Pm2DescriptorGuardRuntime = defaultRuntime,
): void {
  const registeredPids = new Set(
    projections.map(entry => entry.pid).filter(pid => Number.isSafeInteger(pid) && pid > 1),
  );
  if (!runtime.exists(registryDir)) return;
  const now = runtime.now();
  let names: string[];
  try { names = runtime.readdir(registryDir); }
  catch (err) {
    throw new Error(
      `[${operation}] daemon descriptor registry is unreadable; refusing PM2 mutation: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const unregistered: Array<{ appId: string; pid: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(registryDir, name);
    let mtimeMs: number;
    try { mtimeMs = runtime.mtime(path); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(
        `[${operation}] cannot inspect daemon descriptor ${name}; refusing PM2 mutation: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const mtimeFresh = now - mtimeMs <= FRESH_MS;

    let value: unknown;
    try { value = JSON.parse(runtime.read(path)); }
    catch (err) {
      if (!mtimeFresh) continue;
      throw new Error(
        `[${operation}] fresh daemon descriptor ${name} is unreadable or malformed; `
        + `refusing PM2 mutation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
    const heartbeat = record?.lastHeartbeat;
    const heartbeatValid = typeof heartbeat === 'number' && Number.isFinite(heartbeat);
    const heartbeatFresh = heartbeatValid && now - heartbeat <= FRESH_MS;
    const pid = record?.pid;
    const appId = record?.larkAppId;
    if (!mtimeFresh && !heartbeatFresh) {
      // Unparseable old debris has no PID authority to reconcile. But once a
      // stale record names a canonical PID, liveness + process birth decide;
      // age alone must never authorize a second fleet.
      if (!record || !Number.isSafeInteger(pid) || (pid as number) <= 1) continue;
      if (!runtime.isAlive(pid as number)) continue;
      const describedStart = record.processStartIdentity;
      if (typeof describedStart !== 'string' || !describedStart) {
        throw new Error(
          `[${operation}] stale daemon descriptor ${name} still names live PID ${pid} `
          + 'but has no process-start identity; refusing PM2 mutation',
        );
      }
      const currentStart = runtime.readStartIdentity(pid as number);
      if (!currentStart) {
        if (!runtime.isAlive(pid as number)) continue;
        throw new Error(
          `[${operation}] cannot revalidate process-start identity for live stale descriptor `
          + `${name}/${pid}; refusing PM2 mutation`,
        );
      }
      if (currentStart !== describedStart) continue;
      if (typeof appId !== 'string' || !appId.trim()) {
        throw new Error(
          `[${operation}] stale daemon descriptor ${name} matches live PID ${pid} `
          + 'but has no canonical app id; refusing PM2 mutation',
        );
      }
      if (!registeredPids.has(pid as number)) {
        unregistered.push({ appId: appId.trim(), pid: pid as number });
      }
      continue;
    }

    if (!record
        || !heartbeatValid
        || now - heartbeat > FRESH_MS
        || !Number.isSafeInteger(pid)
        || (pid as number) <= 1
        || typeof appId !== 'string'
        || !appId.trim()) {
      throw new Error(
        `[${operation}] fresh daemon descriptor ${name} has invalid pid/app id/heartbeat; `
        + 'refusing PM2 mutation',
      );
    }
    if (runtime.isAlive(pid as number) && !registeredPids.has(pid as number)) {
      unregistered.push({ appId: appId.trim(), pid: pid as number });
    }
  }
  if (unregistered.length > 0) {
    throw new Error(
      `[${operation}] refusing PM2 mutation: daemon descriptor PID(s) are live but absent `
      + `from PM2 registry (${unregistered.map(item => `${item.appId}:${item.pid}`).join(', ')})`,
    );
  }
}
