#!/usr/bin/env node
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FleetSupervisor, pidAlive } from './core/fleet-supervisor.js';
import { withFileLock } from './utils/file-lock.js';
import { atomicWriteFileSync } from './utils/atomic-write.js';
import { isLinuxZombie, readDurableProcessIdentity } from './utils/process-identity.js';
import { scrubExternalMemberEnv } from './utils/child-env.js';
import { installStdioEpipeGuard } from './utils/stdio-epipe-guard.js';
import { botmuxHome } from './core/plugins/paths.js';
import {
  pluginSupervisorDir, pluginSupervisorStatePath, pluginSupervisorResultPath,
  readPluginSupervisorDesired, readPluginSupervisorState, type PluginServiceSpec,
} from './core/plugins/supervisor-store.js';

installStdioEpipeGuard();
scrubExternalMemberEnv(process.env);
delete process.env.BUN_BE_BUN;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Poll metadata rather than binding a watcher to an inode a linked build may
// replace. This also handles new subdirectories on Linux without a dependency.
function watchFingerprint(path: string): string {
  const hash = createHash('sha256');
  const visit = (file: string) => {
    try {
      const stat = statSync(file);
      hash.update(`${file}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size};`);
      if (stat.isDirectory()) {
        for (const entry of readdirSync(file, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.isSymbolicLink() && entry.name !== 'node_modules' && entry.name !== '.git') visit(join(file, entry.name));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update(`${file}:missing;`);
    }
  };
  visit(path);
  return hash.digest('hex');
}

/** Recover only the exact child generations recorded by the previous owner.
 * An unreadable birth identity blocks recovery instead of killing a recycled PID. */
async function reapOrphans(): Promise<void> {
  for (const proc of readPluginSupervisorState()?.procs ?? []) {
    const alive = () => pidAlive(proc.pid) && !isLinuxZombie(proc.pid);
    if (!alive()) continue;
    const identity = readDurableProcessIdentity(proc.pid);
    if (!proc.processStart || !identity) throw new Error(`plugin_supervisor_orphan_identity_unknown:${proc.name}:${proc.pid}`);
    if (identity !== proc.processStart) continue; // stale row, never signal a recycled PID
    const same = () => readDurableProcessIdentity(proc.pid) === proc.processStart;
    try { process.kill(proc.pid, 'SIGTERM'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    const deadline = Date.now() + 8_000;
    while (alive() && same() && Date.now() < deadline) await delay(50);
    if (alive() && same()) {
      try { process.kill(proc.pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      const hardDeadline = Date.now() + 5_000;
      while (alive() && same() && Date.now() < hardDeadline) await delay(50);
      if (alive() && same()) throw new Error(`plugin_supervisor_orphan_stop_failed:${proc.name}`);
    }
  }
}

async function main(): Promise<void> {
  mkdirSync(pluginSupervisorDir(), { recursive: true, mode: 0o700 });
  // A lifetime lock prevents concurrent CLI launches from creating two owners.
  // The shared lock implementation verifies process birth identity on recovery.
  await withFileLock(join(pluginSupervisorDir(), 'owner'), async () => {
    await reapOrphans();
    const supervisor = new FleetSupervisor({
      statePath: pluginSupervisorStatePath(), distDir: '', cwd: botmuxHome(),
      daemonEnv: { ...process.env }, logDir: join(pluginSupervisorDir(), 'logs'),
    });
    supervisor.start([]);
    let shuttingDown = false;
    const requestShutdown = () => { shuttingDown = true; };
    process.on('SIGTERM', requestShutdown);
    process.on('SIGINT', requestShutdown);
    const applied = new Map<string, { spec: PluginServiceSpec; running: boolean }>();
    const watches = new Map<string, { fingerprint: string; changedAt?: number }>();
    let revision = '';
    const acknowledge = (value: string, error?: string) => atomicWriteFileSync(pluginSupervisorResultPath(), JSON.stringify({
      revision: value, pid: process.pid, processStart: readDurableProcessIdentity(process.pid), ...(error ? { error } : {}),
    }), { mode: 0o600, followTargetSymlink: false });
    acknowledge('');
    try {
      while (!shuttingDown) {
        const desired = readPluginSupervisorDesired();
        if (desired.revision !== revision) {
          try {
            for (const [id, previous] of applied) {
              if (!desired.services[id]) {
                await supervisor.removeExternal(previous.spec.name);
                applied.delete(id);
                watches.delete(id);
              }
            }
            for (const [id, item] of Object.entries(desired.services)) {
              if (shuttingDown) break;
              const previous = applied.get(id);
              if (!previous || JSON.stringify(previous) !== JSON.stringify(item) || desired.target === id) {
                // Track failed starts too: spawn errors may leave a restart
                // timer that a later remove must cancel before deleting files.
                applied.set(id, item);
                watches.delete(id);
                if (item.running) await supervisor.upsertExternal(item.spec);
                else await supervisor.stopOneBot(item.spec.name);
                if (item.running && item.spec.watch) {
                  watches.set(id, { fingerprint: watchFingerprint(item.spec.watch.path) });
                } else watches.delete(id);
              }
            }
            if (shuttingDown) throw new Error('plugin_supervisor_shutting_down');
            acknowledge(desired.revision);
          } catch (error) {
            acknowledge(desired.revision, error instanceof Error ? error.message : String(error));
          }
          revision = desired.revision;
        }
        for (const [id, watch] of watches) {
          if (shuttingDown) break;
          try {
            const item = applied.get(id)!;
            const config = item.spec.watch!;
            const fingerprint = watchFingerprint(config.path);
            if (fingerprint !== watch.fingerprint) {
              watch.fingerprint = fingerprint;
              watch.changedAt = Date.now();
            }
            if (watch.changedAt !== undefined && Date.now() - watch.changedAt >= config.delayMs) {
              watch.changedAt = undefined;
              await supervisor.stopOneBot(item.spec.name);
              await supervisor.upsertExternal(item.spec);
            }
          } catch (error) {
            // A bad linked build must not tear down unrelated plugin services.
            // An explicit start re-arms this watcher after the build is repaired.
            watches.delete(id);
            console.error(`[plugin-supervisor] watch ${id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        await delay(250);
      }
    } finally {
      process.removeListener('SIGTERM', requestShutdown);
      process.removeListener('SIGINT', requestShutdown);
      await supervisor.stopAll();
    }
  }, { maxWaitMs: 1_000 });
}

// The compiled hidden CLI entry stays parked after importing this module.
// Exit only after main has stopped the children and released its lifetime lock.
main().then(() => process.exit(0)).catch(error => {
  console.error(`[plugin-supervisor] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
