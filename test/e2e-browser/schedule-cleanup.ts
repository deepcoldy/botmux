/**
 * Helpers to clean up botmux scheduled tasks left behind by e2e tests.
 *
 * The e2e schedule test creates botmux tasks named `sched-<Date.now()>`. UI-driven
 * cleanup (typing `/schedule remove` into the chat) is fragile because it depends
 * on Midscene `aiAct` finding the right input box. These helpers provide a
 * programmatic fallback that imports `schedule-store` directly and writes through
 * the same `schedules.json` the daemon reads — so even if the UI flow fails,
 * tasks created by the run are wiped before the test process exits.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.botmux');
const DEFAULT_DATA_DIR = join(CONFIG_DIR, 'data');

/** Mirror `src/cli.ts:resolveDataDir` so we land on the same dir the daemon writes to. */
function resolveDataDir(): string {
  if (process.env.SESSION_DATA_DIR) return process.env.SESSION_DATA_DIR;
  const breadcrumb = join(CONFIG_DIR, '.data-dir');
  if (existsSync(breadcrumb)) {
    try {
      const dir = readFileSync(breadcrumb, 'utf-8').trim();
      if (dir && existsSync(dir)) {
        if (existsSync(join(dir, 'sessions.json'))) return dir;
        try {
          const files = readdirSync(dir);
          if (files.some(f => f.startsWith('sessions-') && f.endsWith('.json'))) return dir;
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
  return DEFAULT_DATA_DIR;
}

/**
 * Lazily import schedule-store with SESSION_DATA_DIR pointed at the daemon's
 * dataDir. We set the env var before the dynamic import so config.ts picks it up.
 */
async function loadStore() {
  process.env.SESSION_DATA_DIR ??= resolveDataDir();
  return import('../../src/services/schedule-store.js');
}

/**
 * Remove botmux schedule tasks created by a single test run. Tries each
 * candidate id first; if none match, falls back to scanning by `name === label`.
 * Never throws — returns warnings the caller can log.
 */
export async function cleanupTasksByLabel(
  label: string,
  candidateIds: (string | undefined | null)[] = [],
): Promise<{ removed: string[]; warnings: string[] }> {
  const removed: string[] = [];
  const warnings: string[] = [];
  let store: Awaited<ReturnType<typeof loadStore>>;
  try {
    store = await loadStore();
  } catch (err) {
    warnings.push(`loadStore() failed: ${(err as Error).message}`);
    return { removed, warnings };
  }

  for (const id of candidateIds) {
    if (!id) continue;
    try {
      if (store.removeTask(id)) removed.push(id);
    } catch (err) {
      warnings.push(`removeTask(${id}) threw: ${(err as Error).message}`);
    }
  }

  if (removed.length === 0 && label) {
    try {
      for (const task of store.listTasks()) {
        if (task.name === label && store.removeTask(task.id)) removed.push(task.id);
      }
    } catch (err) {
      warnings.push(`listTasks() threw: ${(err as Error).message}`);
    }
  }

  return { removed, warnings };
}

/**
 * Sweep orphan tasks left over from previous e2e runs. Targets tasks whose name
 * matches `sched-<digits>` (the exact pattern feishu-schedule.e2e.ts uses) and
 * whose `createdAt` is older than `maxAgeDays` days. The narrow regex prevents
 * collateral damage to real user-created schedules.
 */
export async function sweepOrphanSchedTasks(maxAgeDays = 1): Promise<string[]> {
  const removed: string[] = [];
  let store: Awaited<ReturnType<typeof loadStore>>;
  try {
    store = await loadStore();
  } catch (err) {
    console.warn(`[e2e:sweep] loadStore failed: ${(err as Error).message}`);
    return removed;
  }
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  try {
    for (const task of store.listTasks()) {
      if (!/^sched-\d{10,}$/.test(task.name)) continue;
      const createdMs = task.createdAt ? Date.parse(task.createdAt) : 0;
      if (!createdMs || createdMs > cutoff) continue;
      if (store.removeTask(task.id)) removed.push(task.id);
    }
  } catch (err) {
    console.warn(`[e2e:sweep] sweepOrphanSchedTasks failed: ${(err as Error).message}`);
  }
  return removed;
}
