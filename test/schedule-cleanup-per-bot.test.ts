/**
 * Regression for the e2e schedule cleanup helper under per-bot stores
 * (test/e2e-browser/schedule-cleanup.ts). Schedules moved from one shared
 * data/schedules.json to per-bot <botmuxHome>/bots/<appId>/schedules.json, so
 * the helper's old zero-arg removeTask/listTasks calls would throw
 * `no bot scope bound`. It must enumerate every per-bot store and address each
 * one explicitly (codex #611 finding 2). Real fs in a temp botmux-home tree.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string; // botmux home root; dataDir = <tempDir>/data

// The helper resolves its data dir from SESSION_DATA_DIR, and schedule-store
// reads config.session.dataDir — point both at our temp tree. The store's
// per-bot path is dirname(dataDir)/bots/<appId>/schedules.json.
vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return join(tempDir, 'data'); } } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const BOT_A = 'cli_bota00000000001';
const BOT_B = 'cli_botb00000000002';

function storeFp(appId: string): string {
  return join(tempDir, 'bots', appId, 'schedules.json');
}
function seedTask(appId: string, id: string, name: string, extra: Record<string, unknown> = {}) {
  const fp = storeFp(appId);
  mkdirSync(dirname(fp), { recursive: true });
  const existing = existsSync(fp) ? JSON.parse(readFileSync(fp, 'utf-8')) : {};
  existing[id] = {
    id, name, schedule: '0 9 * * *',
    parsed: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
    prompt: `p ${id}`, workingDir: '/w', chatId: 'oc_x', enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z', larkAppId: appId, ...extra,
  };
  writeFileSync(fp, JSON.stringify(existing));
}

async function freshHelper() {
  vi.resetModules();
  process.env.SESSION_DATA_DIR = join(tempDir, 'data');
  return import('./e2e-browser/schedule-cleanup.js');
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sched-cleanup-'));
  mkdirSync(join(tempDir, 'data'), { recursive: true });
  process.env.SESSION_DATA_DIR = join(tempDir, 'data');
});
afterEach(() => {
  delete process.env.SESSION_DATA_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('e2e schedule-cleanup helper across per-bot stores', () => {
  it('cleanupTasksByLabel deletes a candidate id from whichever bot store holds it', async () => {
    seedTask(BOT_A, 'ta', 'sched-1111111111');
    seedTask(BOT_B, 'tb', 'sched-2222222222');
    const helper = await freshHelper();

    const { removed, warnings } = await helper.cleanupTasksByLabel('sched-2222222222', ['tb']);
    expect(warnings).toEqual([]);
    expect(removed).toEqual(['tb']);                       // deleted from BOT_B's store
    expect(JSON.parse(readFileSync(storeFp(BOT_B), 'utf-8'))).toEqual({});
    // BOT_A untouched.
    expect(Object.keys(JSON.parse(readFileSync(storeFp(BOT_A), 'utf-8')))).toEqual(['ta']);
  });

  it('cleanupTasksByLabel falls back to name match across ALL stores when no candidate id hits', async () => {
    seedTask(BOT_A, 'ta', 'shared-label');
    seedTask(BOT_B, 'tb', 'shared-label');
    const helper = await freshHelper();

    const { removed, warnings } = await helper.cleanupTasksByLabel('shared-label', []);
    expect(warnings).toEqual([]);
    expect(removed.sort()).toEqual(['ta', 'tb']);          // both stores swept by label
  });

  it('sweepOrphanSchedTasks removes aged sched-<digits> tasks from every store, sparing fresh + non-matching', async () => {
    const old = '2020-01-01T00:00:00.000Z';
    seedTask(BOT_A, 'old-a', 'sched-1000000000', { createdAt: old });
    seedTask(BOT_B, 'old-b', 'sched-2000000000', { createdAt: old });
    seedTask(BOT_A, 'fresh', 'sched-3000000000', { createdAt: new Date().toISOString() });
    seedTask(BOT_B, 'user', 'my real task', { createdAt: old }); // name doesn't match pattern
    const helper = await freshHelper();

    const removed = await helper.sweepOrphanSchedTasks(1);
    expect(removed.sort()).toEqual(['old-a', 'old-b']);
    // Fresh + user tasks survive.
    const a = JSON.parse(readFileSync(storeFp(BOT_A), 'utf-8'));
    const b = JSON.parse(readFileSync(storeFp(BOT_B), 'utf-8'));
    expect(Object.keys(a)).toEqual(['fresh']);
    expect(Object.keys(b)).toEqual(['user']);
  });

  it('no bot stores → helpers degrade to no-op without throwing', async () => {
    const helper = await freshHelper();
    const { removed, warnings } = await helper.cleanupTasksByLabel('sched-x', ['nope']);
    expect(removed).toEqual([]);
    expect(warnings).toEqual([]);
    expect(await helper.sweepOrphanSchedTasks(1)).toEqual([]);
  });
});
