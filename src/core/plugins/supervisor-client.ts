import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { isLinuxZombie, readDurableProcessIdentity } from '../../utils/process-identity.js';
import { scrubExternalMemberEnv } from '../../utils/child-env.js';
import { pidNotProvablyGone } from '../../utils/process-alive.js';
import { signalAttestedFleetProcess } from '../fleet-process-identity.js';
import { pidAlive } from '../fleet-supervisor.js';
import { isStandaloneBinary, resolveEntrySpawn } from '../self-spawn.js';
import { liveGodAt } from '../legacy-pm2-reaper.js';
import { botmuxHome } from './paths.js';
import {
  pluginServiceName, pluginSupervisorDir, readPluginSupervisorState,
  pluginSupervisorDesiredPath, readPluginSupervisorDesired, readPluginSupervisorResult,
  type PluginServiceSpec, type PluginSupervisorResult,
} from './supervisor-store.js';

export interface PluginProcessInfo {
  name: string;
  pid?: number;
  processStart?: string;
  status?: string;
  configHash?: string;
}

export function assertNoLegacyPluginPm2(): void {
  if (liveGodAt(join(botmuxHome(), 'pm2'))) {
    throw new Error('plugin_legacy_pm2_running: stop the old services with PM2_HOME="'
      + join(botmuxHome(), 'pm2') + '" pm2 kill before starting the plugin supervisor');
  }
}

export function readPluginProcesses(): PluginProcessInfo[] {
  assertNoLegacyPluginPm2();
  const desired = readPluginSupervisorDesired();
  const state = readPluginSupervisorState();
  const result = readPluginSupervisorResult();
  const pending = result?.revision !== desired.revision;
  if (!state && result && !pending && Object.keys(desired.services).length > 0) {
    throw new Error('plugin_supervisor_missing_process_state');
  }
  const processes = new Map<string, PluginProcessInfo>();
  for (const proc of state?.procs ?? []) {
    // Three-state liveness, so a read failure can never masquerade as stopped:
    //  - dead: kill(0) fails or the process is a zombie → 'stopped', pid dropped;
    //  - verified: alive AND (no recorded birth, or birth identity matches) →
    //    the supervisor's own status, pid and processStart kept;
    //  - unknown: alive but birth identity is unreadable or does not match
    //    (PID reuse candidate, /proc hiccup) → 'unknown' with the live pid
    //    retained but no processStart. Lifecycle guards (uninstall/update/start)
    //    must treat unknown like online, never like stopped; the webhook/service
    //    proxy independently requires a verified birth and answers 503 otherwise.
    const liveness = pidAlive(proc.pid) && !isLinuxZombie(proc.pid);
    let info: PluginProcessInfo;
    if (!liveness) {
      info = {
        name: proc.name,
        status: proc.status === 'online' ? 'stopped' : proc.status,
        configHash: proc?.configHash,
      };
    } else if (!proc.processStart || readDurableProcessIdentity(proc.pid) === proc.processStart) {
      info = {
        name: proc.name,
        pid: proc.pid,
        ...(proc.processStart ? { processStart: proc.processStart } : {}),
        status: proc.status,
        configHash: proc?.configHash,
      };
    } else {
      info = {
        name: proc.name,
        pid: proc.pid,
        status: 'unknown',
        configHash: proc?.configHash,
      };
    }
    processes.set(proc.name, info);
  }
  for (const [id, item] of Object.entries(desired.services)) {
    const name = pluginServiceName(id);
    if (item.running && !pending && !processes.has(name)) {
      throw new Error(`plugin_supervisor_missing_process:${id}`);
    }
    const proc = processes.get(name) ?? { name, status: 'stopped' };
    // An armed linked watcher can restart even a naturally stopped/parked
    // child. Require an explicit stop before allowing runtime replacement.
    if (!proc.pid && item.running && (pending || item.spec.watch)) proc.status = 'launching';
    processes.set(name, proc);
  }
  // Stop/remove also need acknowledgement: a failed spawn may have left a
  // restart timer even when there is no live PID or durable process row yet.
  if (pending && desired.target) {
    const name = pluginServiceName(desired.target);
    const proc = processes.get(name) ?? { name };
    if (!proc.pid) proc.status = 'launching';
    processes.set(name, proc);
  }
  return [...processes.values()];
}

function supervisorAlive(): boolean {
  const result = readPluginSupervisorResult();
  return !!result && pidAlive(result.pid) && !!result.processStart
    && readDurableProcessIdentity(result.pid) === result.processStart;
}

function supervisorProcessExited(pid: number): boolean {
  return !pidNotProvablyGone(pid) || isLinuxZombie(pid);
}

function assertSupervisorIdentity(result: PluginSupervisorResult) {
  if (!result.processStart) throw new Error(`plugin_supervisor_identity_unknown:${result.pid}`);
  const identity = readDurableProcessIdentity(result.pid);
  if (!identity) throw new Error(`plugin_supervisor_identity_unknown:${result.pid}`);
  if (identity !== result.processStart) throw new Error(`plugin_supervisor_identity_mismatch:${result.pid}`);
  return result.processStart;
}

function assertSupervisorOwner(result: PluginSupervisorResult) {
  const identity = assertSupervisorIdentity(result);
  const state = readPluginSupervisorState();
  if (state?.supervisorPid !== result.pid) throw new Error(`plugin_supervisor_identity_mismatch:${result.pid}`);
  if (!state.supervisorProcessStart) throw new Error(`plugin_supervisor_identity_unknown:${result.pid}`);
  if (state.supervisorProcessStart !== identity) throw new Error(`plugin_supervisor_identity_mismatch:${result.pid}`);
  return identity;
}

/** Caller holds the service-manager lock. Explicit --all also covers desired
 * members absent from the installed registry, including failed-start retries.
 * Reuse the host's signal/finally path; a delivered signal is not completion. */
export async function shutdownPluginSupervisor(): Promise<void> {
  assertNoLegacyPluginPm2();
  readPluginSupervisorDesired(); // validate uncertainty even without a host result
  const initial = readPluginSupervisorResult();
  const ownerLock = join(pluginSupervisorDir(), 'owner.lock');
  const assertComplete = () => {
    const state = readPluginSupervisorState();
    if (Object.values(readPluginSupervisorDesired().services).some(item => item.running)
      || existsSync(ownerLock) || (initial && !state) || state?.supervisorPid
      || state?.procs.some(proc => proc.pid > 1 || proc.status === 'online' || proc.status === 'launching')) {
      throw new Error('plugin_supervisor_shutdown_incomplete');
    }
  };
  const durableStateComplete = () => {
    try {
      assertComplete();
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === 'plugin_supervisor_shutdown_incomplete') return false;
      throw error;
    }
  };
  if (!initial) {
    if (existsSync(ownerLock)) throw new Error('plugin_supervisor_identity_unknown');
    assertComplete();
    return;
  }
  const initialExited = supervisorProcessExited(initial.pid);
  if (durableStateComplete()) {
    if (initialExited) return;
    const currentIdentity = readDurableProcessIdentity(initial.pid);
    // A completed state makes a retained result stale. A live PID is safe to
    // ignore only when its birth proves that it belongs to a different process.
    if (initial.processStart && currentIdentity && currentIdentity !== initial.processStart) return;
  }
  if (initialExited) {
    assertComplete();
    return;
  }
  assertSupervisorOwner(initial);
  for (const [id, item] of Object.entries(readPluginSupervisorDesired().services)) {
    if (item.running) await changePluginService(id, 'stop', undefined, { existingSupervisorOnly: true });
  }
  const desired = readPluginSupervisorDesired();
  const result = readPluginSupervisorResult();
  if (!result || result.pid !== initial.pid || result.processStart !== initial.processStart) {
    throw new Error('plugin_supervisor_identity_mismatch');
  }
  // changePluginService throws an error ACK for every revision issued above.
  // Any remaining error is historical and must not permanently veto recovery.
  if (Object.values(desired.services).some(item => item.running)) throw new Error('plugin_supervisor_members_running');
  if (supervisorProcessExited(result.pid)) {
    assertComplete();
    return;
  }
  const processStart = assertSupervisorOwner(result);
  if (!signalAttestedFleetProcess({ pid: result.pid, processStart }, 'SIGTERM')) {
    if (!supervisorProcessExited(result.pid)) {
      assertSupervisorIdentity(result);
      throw new Error(`plugin_supervisor_signal_failed:${result.pid}`);
    }
    assertComplete();
    return;
  }
  const longestStop = Math.max(8_000, ...Object.values(desired.services).map(item => item.spec.external.killTimeoutMs ?? 8_000));
  const deadline = Date.now() + longestStop + 6_000;
  while (Date.now() < deadline) {
    if (supervisorProcessExited(result.pid)) {
      assertComplete();
      return;
    }
    assertSupervisorIdentity(result);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`plugin_supervisor_shutdown_timeout:${result.pid}`);
}

function launchSupervisor(): void {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const resolved = resolveEntrySpawn('plugin-supervisor', root);
  // Source development runs TS directly; dist and compiled installs use the
  // shared self-spawn resolver, including the standalone hidden entry.
  if (!isStandaloneBinary() && import.meta.url.endsWith('.ts')) {
    // @ts-ignore — Bun is absent under Node.
    const bun = typeof Bun !== 'undefined';
    resolved.args = [...(bun ? [] : ['--import', createRequire(import.meta.url).resolve('tsx')]), join(root, 'index-plugin-supervisor.ts')];
  }
  const fd = openSync(join(pluginSupervisorDir(), 'supervisor.log'), 'a', 0o600);
  const env = { ...process.env };
  scrubExternalMemberEnv(env);
  delete env.BUN_BE_BUN;
  try {
    const child = spawn(resolved.command, resolved.args, {
      cwd: botmuxHome(), env, detached: true, stdio: ['ignore', fd, fd],
    });
    child.on('error', () => {}); // the bounded acknowledgement wait reports failure
    child.unref();
  } finally { closeSync(fd); }
}

/** Caller holds the plugin service lock throughout publication + acknowledgement.
 * A consumed request is not success: the supervisor acknowledges only after
 * exec succeeds or the old child exits. Desired state survives a CLI crash. */
export async function changePluginService(
  pluginId: string,
  operation: 'start' | 'stop' | 'remove',
  spec?: PluginServiceSpec,
  options: { existingSupervisorOnly?: boolean } = {},
): Promise<void> {
  assertNoLegacyPluginPm2();
  const current = options.existingSupervisorOnly ? readPluginSupervisorResult() : undefined;
  if (options.existingSupervisorOnly) {
    if (!current || !pidNotProvablyGone(current.pid)) throw new Error('plugin_supervisor_shutdown_incomplete');
    assertSupervisorOwner(current);
  }
  const desired = readPluginSupervisorDesired();
  const killTimeoutMs = spec?.external.killTimeoutMs ?? desired.services[pluginId]?.spec.external.killTimeoutMs ?? 8_000;
  const name = pluginServiceName(pluginId);
  if (operation === 'start') {
    if (!spec || spec.name !== name) throw new Error('plugin_supervisor_spec_required');
    desired.services[pluginId] = { spec, running: true };
  } else if (operation === 'stop') {
    if (desired.services[pluginId]) desired.services[pluginId].running = false;
  } else {
    // Its durable process row remains the source of liveness evidence until
    // the supervisor has stopped the child and acknowledged removal.
    delete desired.services[pluginId];
  }
  desired.revision = randomUUID();
  desired.target = pluginId;
  mkdirSync(pluginSupervisorDir(), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(pluginSupervisorDesiredPath(), JSON.stringify(desired), { mode: 0o600, durable: true, followTargetSymlink: false });
  if (!current && !supervisorAlive()) launchSupervisor();
  const timeoutMs = Math.max(30_000, killTimeoutMs + 10_000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = readPluginSupervisorResult();
    if (result?.revision === desired.revision) {
      if (current && (result.pid !== current.pid || result.processStart !== current.processStart)) {
        throw new Error('plugin_supervisor_identity_mismatch');
      }
      if (result.error) throw new Error(result.error);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`plugin_supervisor_timeout:${pluginId}: see ${join(pluginSupervisorDir(), 'supervisor.log')}`);
}
