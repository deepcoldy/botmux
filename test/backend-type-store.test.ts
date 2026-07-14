/**
 * Unit tests for the per-bot session-backend override store: set / clear
 * round-trips through bots.json + the in-memory registry (no daemon restart),
 * plus the editable-backend validation used by the dashboard IPC route.
 *
 * Run: pnpm vitest run test/backend-type-store.test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/backend-type-store.js');
  return { registry, store };
}

describe('backend-type store', () => {
  let configPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-backendtype-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
  });
  afterEach(() => { delete process.env.BOTS_CONFIG; });

  function writeConfig(entry: Record<string, unknown> = {}) {
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app_default', larkAppSecret: 'secret', cliId: 'claude-code', allowedUsers: ['ou_owner'], ...entry,
    }], null, 2), 'utf-8');
  }
  function readConfig(): any { return JSON.parse(readFileSync(configPath, 'utf-8'))[0]; }
  async function loaded(entry: Record<string, unknown> = {}) {
    writeConfig(entry);
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach((c: any) => registry.registerBot(c));
    return { registry, store };
  }

  it('isEditableBackendType accepts the four backends and rejects junk', async () => {
    const { store } = await freshModules();
    for (const v of ['pty', 'tmux', 'herdr', 'zellij']) expect(store.isEditableBackendType(v)).toBe(true);
    for (const v of ['auto', '', 'foo', null, 3, undefined]) expect(store.isEditableBackendType(v)).toBe(false);
    expect(store.EDITABLE_BACKEND_TYPES).toContain('herdr');
  });

  it('sets a per-bot backend override, round-tripping to disk and registry', async () => {
    const { registry, store } = await loaded();
    const r = await store.updateBotBackendType('app_default', 'herdr');
    expect(r).toMatchObject({ ok: true, backendType: 'herdr' });
    expect(readConfig().backendType).toBe('herdr');
    expect(registry.getBot('app_default').config.backendType).toBe('herdr');
    expect(store.getBotBackendType('app_default')).toBe('herdr');
  });

  it('clears the override (null) — removes the key so the daemon default applies', async () => {
    const { registry, store } = await loaded({ backendType: 'herdr' });
    const r = await store.updateBotBackendType('app_default', null);
    expect(r).toMatchObject({ ok: true, backendType: null });
    expect('backendType' in readConfig()).toBe(false); // key omitted, not persisted as null
    expect(registry.getBot('app_default').config.backendType).toBeUndefined();
  });

  it('rejects an unregistered bot without touching disk', async () => {
    const { store } = await loaded();
    const r = await store.updateBotBackendType('app_missing', 'tmux');
    expect(r).toMatchObject({ ok: false, reason: 'bot_not_registered' });
    expect('backendType' in readConfig()).toBe(false);
  });
});
