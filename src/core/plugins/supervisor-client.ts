import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { readDurableProcessIdentity } from '../../utils/process-identity.js';
import { scrubExternalMemberEnv } from '../../utils/child-env.js';
import { pidAlive } from '../fleet-supervisor.js';
import { isStandaloneBinary, resolveEntrySpawn } from '../self-spawn.js';
import { liveGodAt } from '../legacy-pm2-reaper.js';
import { botmuxHome } from './paths.js';
import {
  pluginServiceName, pluginSupervisorDir, readPluginSupervisorState,
  pluginSupervisorDesiredPath, readPluginSupervisorDesired, readPluginSupervisorResult,
  type PluginServiceSpec,
} from './supervisor-store.js';

export interface PluginProcessInfo {
  name: string;
  pid?: number;
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
    const alive = pidAlive(proc.pid);
    processes.set(proc.name, {
      name: proc.name,
      ...(alive ? { pid: proc.pid } : {}),
      status: !alive && proc.status === 'online' ? 'stopped' : proc.status,
      configHash: proc?.configHash,
    });
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
): Promise<void> {
  assertNoLegacyPluginPm2();
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
  if (!supervisorAlive()) launchSupervisor();
  const timeoutMs = Math.max(30_000, killTimeoutMs + 10_000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = readPluginSupervisorResult();
    if (result?.revision === desired.revision) {
      if (result.error) throw new Error(result.error);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`plugin_supervisor_timeout:${pluginId}: see ${join(pluginSupervisorDir(), 'supervisor.log')}`);
}
