/**
 * Unit tests for default-oncall persistence semantics.
 *
 * Run: pnpm vitest run test/oncall-store.test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
    }
  }
  return { Client: FakeClient };
});

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/oncall-store.js');
  return { registry, store };
}

describe('default-oncall store persistence', () => {
  let configPath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'botmux-oncall-store-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.BOTS_CONFIG;
  });

  function writeConfig(entry: Record<string, unknown> = {}) {
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app_default',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      ...entry,
    }], null, 2), 'utf-8');
  }

  function readConfig(): any {
    return JSON.parse(readFileSync(configPath, 'utf-8'))[0];
  }

  it('stamps since on every enabled save (informational only — no cut-off semantics)', async () => {
    writeConfig({
      defaultOncall: { enabled: true, workingDir: '/old', since: 1_000 },
    });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    vi.setSystemTime(10_000);
    const r = await store.updateBotDefaultOncall('app_default', {
      enabled: true,
      workingDir: '/new',
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.defaultOncall).toEqual({
        enabled: true,
        workingDir: '/new',
        since: 10_000,
      });
    }
    expect(readConfig().defaultOncall).toEqual({
      enabled: true,
      workingDir: '/new',
      since: 10_000,
    });
    expect(registry.getBot('app_default').config.defaultOncall?.since).toBe(10_000);
  });

  it('disable with empty workingDir preserves the prior workingDir', async () => {
    // Round-trip case: user toggles off without retyping the path, then toggles
    // back on later — the stored path should still be there. Disable with a
    // non-empty workingDir is treated as an explicit replacement.
    writeConfig({
      defaultOncall: { enabled: true, workingDir: '/repos/payments', since: 5_000 },
    });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    vi.setSystemTime(20_000);
    const r = await store.updateBotDefaultOncall('app_default', {
      enabled: false,
      workingDir: '',
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.defaultOncall).toEqual({
        enabled: false,
        workingDir: '/repos/payments',
        since: 5_000, // prior `since` retained when disabling
      });
    }
  });

  it('auto-bind appends oncallChats and autobound list in one persistence flow', async () => {
    writeConfig({
      oncallChats: [{ chatId: 'oc_existing', workingDir: '/existing' }],
      defaultOncallAutoboundChats: ['oc_old'],
    });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.autoBindOncallFromDefault('app_default', 'oc_new', '/default');

    expect(r).toEqual({
      ok: true,
      created: true,
      entry: { chatId: 'oc_new', workingDir: '/default' },
    });
    expect(readConfig().oncallChats).toEqual([
      { chatId: 'oc_existing', workingDir: '/existing' },
      { chatId: 'oc_new', workingDir: '/default' },
    ]);
    expect(readConfig().defaultOncallAutoboundChats).toEqual(['oc_old', 'oc_new']);
    expect(registry.getBot('app_default').config.oncallChats).toContainEqual({
      chatId: 'oc_new',
      workingDir: '/default',
    });
    expect(registry.getBot('app_default').config.defaultOncallAutoboundChats).toEqual(['oc_old', 'oc_new']);
  });

  it('manual bindOncall does not mark chat as default-autobound', async () => {
    writeConfig({ defaultOncallAutoboundChats: ['oc_old'] });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.bindOncall('app_default', 'oc_manual', '/manual');

    expect(r.ok).toBe(true);
    expect(readConfig().oncallChats).toEqual([{ chatId: 'oc_manual', workingDir: '/manual' }]);
    expect(readConfig().defaultOncallAutoboundChats).toEqual(['oc_old']);
    expect(registry.getBot('app_default').config.defaultOncallAutoboundChats).toEqual(['oc_old']);
  });

  it('unbindOncall writes a tombstone even when the chat was never bound', async () => {
    // Tombstone for the "user-manually-fiddled" edge case: a user manually
    // unbinds a chat that defaults never reached — without the tombstone, the
    // judge would later see firstSeenAt > since with no binding and re-bind.
    writeConfig({});
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.unbindOncall('app_default', 'oc_phantom');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.wasBound).toBe(false);
    expect(readConfig().defaultOncallAutoboundChats).toEqual(['oc_phantom']);
    expect(registry.getBot('app_default').config.defaultOncallAutoboundChats).toEqual(['oc_phantom']);
  });

  it('unbindOncall removes binding AND writes tombstone for a previously bound chat', async () => {
    writeConfig({
      oncallChats: [{ chatId: 'oc_real', workingDir: '/foo' }],
    });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.unbindOncall('app_default', 'oc_real');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.wasBound).toBe(true);
    expect(readConfig().oncallChats).toEqual([]);
    expect(readConfig().defaultOncallAutoboundChats).toEqual(['oc_real']);
  });

  it('autoBindOncallFromDefault skips when chat is already in tombstone (race protection)', async () => {
    // Codex r2 #1: daemon's in-memory tombstone check is a fast path; if a
    // concurrent unbind wrote the tombstone between fast-path read and lock
    // acquisition, the lock-internal authoritative re-check must skip the
    // bind. Without this gate, default would re-bind a chat the user just
    // opted out of.
    writeConfig({ defaultOncallAutoboundChats: ['oc_just_unbound'] });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.autoBindOncallFromDefault('app_default', 'oc_just_unbound', '/default');

    expect(r.ok).toBe(true);
    if (r.ok && 'skipped' in r) expect(r.skipped).toBe('tombstoned');
    // No oncall binding written, tombstone preserved
    expect(readConfig().oncallChats ?? []).toEqual([]);
    expect(readConfig().defaultOncallAutoboundChats).toEqual(['oc_just_unbound']);
  });

  it('autoBindOncallFromDefault skips when chat already has an existing binding (race protection)', async () => {
    // Another race winner — concurrent manual /oncall bind or sibling
    // daemon's autoBind landed first. We must not overwrite the existing
    // binding's workingDir with our default.
    writeConfig({
      oncallChats: [{ chatId: 'oc_taken', workingDir: '/manual' }],
    });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.autoBindOncallFromDefault('app_default', 'oc_taken', '/default');

    expect(r.ok).toBe(true);
    if (r.ok && 'skipped' in r) expect(r.skipped).toBe('already_bound');
    expect(readConfig().oncallChats).toEqual([{ chatId: 'oc_taken', workingDir: '/manual' }]);
    expect(readConfig().defaultOncallAutoboundChats ?? []).toEqual([]);
  });

  it('concurrent autoBind from same process serializes without losing writes', async () => {
    // Promise.all of 5 auto-binds. Each must land in oncallChats AND the
    // tombstone list. Without the lock, a read-modify-write race would drop
    // some entries; with it, all 5 are present.
    writeConfig({});
    // Use real timers — the lock's setTimeout retry path would deadlock under
    // fake timers if any concurrent call had to wait.
    vi.useRealTimers();
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const ids = ['oc_a', 'oc_b', 'oc_c', 'oc_d', 'oc_e'];
    await Promise.all(ids.map(id => store.autoBindOncallFromDefault('app_default', id, '/d')));

    const persisted = readConfig();
    const chatIds = (persisted.oncallChats ?? []).map((c: any) => c.chatId).sort();
    expect(chatIds).toEqual(ids.slice().sort());
    expect((persisted.defaultOncallAutoboundChats ?? []).slice().sort()).toEqual(ids.slice().sort());
  });

  // ── setWorkingDirMode: dashboard 三态互斥写盘 (PR #311 Codex review) ──────────
  it('setWorkingDirMode oncall enables defaultOncall AND clears defaultWorkingDir in one write', async () => {
    writeConfig({ defaultWorkingDir: '/prev-default' }); // start in "default" mode
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    vi.setSystemTime(30_000);
    const r = await store.setWorkingDirMode('app_default', 'oncall', '/repos/oncall');

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.defaultOncall).toEqual({ enabled: true, workingDir: '/repos/oncall', since: 30_000 });
      expect(r.defaultWorkingDir).toBeNull();
    }
    const persisted = readConfig();
    expect(persisted.defaultOncall).toEqual({ enabled: true, workingDir: '/repos/oncall', since: 30_000 });
    expect(persisted.defaultWorkingDir).toBeUndefined(); // cleared — never enabled-oncall + defaultWorkingDir together
    const cfg = registry.getBot('app_default').config;
    expect(cfg.defaultOncall?.enabled).toBe(true);
    expect(cfg.defaultWorkingDir).toBeUndefined();
  });

  it('setWorkingDirMode default sets defaultWorkingDir AND disables defaultOncall (keeps prior oncall dir)', async () => {
    writeConfig({ defaultOncall: { enabled: true, workingDir: '/repos/oncall', since: 5_000 } }); // start oncall
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.setWorkingDirMode('app_default', 'default', '/repos/dwd');

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.defaultWorkingDir).toBe('/repos/dwd');
      expect(r.defaultOncall.enabled).toBe(false);
      expect(r.defaultOncall.workingDir).toBe('/repos/oncall'); // prior dir kept for round-trip
    }
    const persisted = readConfig();
    expect(persisted.defaultWorkingDir).toBe('/repos/dwd');
    expect(persisted.defaultOncall.enabled).toBe(false); // disabled — the active state is mutually exclusive
  });

  it('setWorkingDirMode off clears defaultWorkingDir AND disables defaultOncall (cleans up a both-set state)', async () => {
    // Seed the very inconsistent state the race could once produce: enabled
    // defaultOncall + defaultWorkingDir both present. `off` must clean both.
    writeConfig({
      defaultWorkingDir: '/repos/dwd',
      defaultOncall: { enabled: true, workingDir: '/repos/oncall', since: 5_000 },
    });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.setWorkingDirMode('app_default', 'off', '');

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.defaultWorkingDir).toBeNull();
      expect(r.defaultOncall.enabled).toBe(false);
    }
    const persisted = readConfig();
    expect(persisted.defaultWorkingDir).toBeUndefined();
    expect(persisted.defaultOncall.enabled).toBe(false);
  });

  // ── setWorkingDirMode: 「仅默认目录」+ 自动创建 worktree 开关 ─────────────────────
  it('setWorkingDirMode default with autoWorktree persists defaultWorkingDirAutoWorktree + syncs in-memory', async () => {
    writeConfig({});
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.setWorkingDirMode('app_default', 'default', '/repos/dwd', true);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.defaultWorkingDir).toBe('/repos/dwd');
      expect(r.defaultWorkingDirAutoWorktree).toBe(true);
    }
    expect(readConfig().defaultWorkingDirAutoWorktree).toBe(true);
    expect(registry.getBot('app_default').config.defaultWorkingDirAutoWorktree).toBe(true);
  });

  it('setWorkingDirMode default with autoWorktree=false does NOT persist the flag', async () => {
    writeConfig({ defaultWorkingDir: '/repos/dwd', defaultWorkingDirAutoWorktree: true }); // prior on
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    const r = await store.setWorkingDirMode('app_default', 'default', '/repos/dwd', false);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.defaultWorkingDirAutoWorktree).toBe(false);
    expect(readConfig().defaultWorkingDirAutoWorktree).toBeUndefined(); // cleared, keeps bots.json clean
    expect(registry.getBot('app_default').config.defaultWorkingDirAutoWorktree).toBeUndefined();
  });

  it('setWorkingDirMode force-clears autoWorktree outside default mode (oncall / off)', async () => {
    writeConfig({ defaultWorkingDir: '/repos/dwd', defaultWorkingDirAutoWorktree: true });
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));

    // Even if a stale/forged autoWorktree=true rides in with a non-default mode,
    // it must be dropped — the toggle is meaningless without defaultWorkingDir.
    const r = await store.setWorkingDirMode('app_default', 'oncall', '/repos/oncall', true);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.defaultWorkingDirAutoWorktree).toBe(false);
    expect(readConfig().defaultWorkingDirAutoWorktree).toBeUndefined();
    expect(registry.getBot('app_default').config.defaultWorkingDirAutoWorktree).toBeUndefined();
  });
});
