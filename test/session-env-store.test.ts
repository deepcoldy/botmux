/**
 * Persistence of the two session-env layers: the bot layer lives in the
 * existing bots.json `env` field (= set) plus `envUnset`; the global layer is
 * config.json `sessionEnv`. Untouched configs keep no trace of either field.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) { this.opts = opts; }
  }
  return { Client: FakeClient };
});

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/bot-config-store.js');
  const globalConfig = await import('../src/global-config.js');
  return { registry, store, globalConfig };
}

let dir: string;
let configPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'session-env-store-'));
  configPath = join(dir, 'bots.json');
  process.env.BOTS_CONFIG = configPath;
  process.env.BOTMUX_GLOBAL_CONFIG_FILE = join(dir, 'config.json');
});
afterEach(() => {
  delete process.env.BOTS_CONFIG;
  delete process.env.BOTMUX_GLOBAL_CONFIG_FILE;
  rmSync(dir, { recursive: true, force: true });
});

function writeBots(entry: Record<string, unknown> = {}) {
  writeFileSync(configPath, JSON.stringify([{
    larkAppId: 'app_a', larkAppSecret: 'secret', cliId: 'claude-code', allowedUsers: ['ou_owner'], ...entry,
  }], null, 2));
}
const readBot = () => JSON.parse(readFileSync(configPath, 'utf8'))[0];

async function loaded(entry: Record<string, unknown> = {}) {
  writeBots(entry);
  const mods = await freshModules();
  mods.registry.loadBotConfigs().forEach((c: any) => mods.registry.registerBot(c));
  return mods;
}

describe('bot layer (bots.json env + envUnset)', () => {
  it('loads a legacy entry unchanged and without envUnset', async () => {
    const { registry } = await loaded({ env: { ANTHROPIC_BASE_URL: 'https://glm', ANTHROPIC_AUTH_TOKEN: 'tok' } });
    const cfg = registry.getBot('app_a').config;
    expect(cfg.env).toEqual({ ANTHROPIC_BASE_URL: 'https://glm', ANTHROPIC_AUTH_TOKEN: 'tok' });
    expect(cfg.envUnset).toBeUndefined();
  });

  it('normalizes a hand-edited envUnset at load', async () => {
    const { registry } = await loaded({ env: { A: '1' }, envUnset: ['A', 'B', 'PATH', 'BOTMUX_CHAT_ID', 'not valid', 'B'] });
    expect(registry.getBot('app_a').config.envUnset).toEqual(['B']);
  });

  it('applies ops inside the file lock and hot-updates the registry', async () => {
    const { registry, store } = await loaded({ env: { KEEP: 'k', OLD: 'o' }, someFutureField: 1 });
    const [r1, r2] = await Promise.all([
      store.applyBotSessionEnvOps('app_a', [{ op: 'set', key: 'HTTPS_PROXY', value: 'http://p' }]),
      store.applyBotSessionEnvOps('app_a', [{ op: 'unset', key: 'BYTECLOUD_AUTH_AS' }, { op: 'reset', key: 'OLD' }]),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    const saved = readBot();
    expect(saved.env).toEqual({ KEEP: 'k', HTTPS_PROXY: 'http://p' });
    expect(saved.envUnset).toEqual(['BYTECLOUD_AUTH_AS']);
    expect(saved.someFutureField).toBe(1);
    const cfg = registry.getBot('app_a').config;
    expect(cfg.env).toEqual(saved.env);
    expect(cfg.envUnset).toEqual(saved.envUnset);
  });

  it('clearing every entry removes both fields from bots.json', async () => {
    const { registry, store } = await loaded({ env: { A: '1' }, envUnset: ['B'] });
    await store.applyBotSessionEnvOps('app_a', [{ op: 'reset', key: 'A' }, { op: 'reset', key: 'B' }]);
    const saved = readBot();
    expect('env' in saved).toBe(false);
    expect('envUnset' in saved).toBe(false);
    expect(registry.getBot('app_a').config.env).toBeUndefined();
    expect(registry.getBot('app_a').config.envUnset).toBeUndefined();
  });

  it('the Dashboard write path validates with this bot\'s identity lock', async () => {
    const { store } = await loaded();
    // lark tool binding is on by default → ZDOTDIR belongs to the wrapper
    expect(await store.applyBotSessionEnvRequest('app_a', [{ op: 'set', key: 'ZDOTDIR', value: '/z' }]))
      .toEqual({ ok: false, reason: 'reserved_key', key: 'ZDOTDIR' });
    expect('env' in readBot()).toBe(false);
    expect(await store.applyBotSessionEnvRequest('app_a', [{ op: 'unset', key: 'PATH' }]))
      .toEqual({ ok: false, reason: 'unset_forbidden', key: 'PATH' });
    const off = await loaded({ larkToolBinding: false });
    expect((await off.store.applyBotSessionEnvRequest('app_a', [{ op: 'set', key: 'ZDOTDIR', value: '/z' }])).ok).toBe(true);
    expect(readBot().env).toEqual({ ZDOTDIR: '/z' });
  });

  it('refuses a save that would grow the bot layer past the pane-argv budget', async () => {
    const { store } = await loaded({ larkToolBinding: false });
    expect((await store.applyBotSessionEnvRequest('app_a', [{ op: 'set', key: 'A', value: 'x'.repeat(3000) }])).ok).toBe(true);
    expect(await store.applyBotSessionEnvRequest('app_a', [{ op: 'set', key: 'B', value: 'y'.repeat(3000) }]))
      .toEqual({ ok: false, reason: 'layer_too_large' });
    expect(Object.keys(readBot().env)).toEqual(['A']);
  });

  it('the legacy PUT /api/bots/:id/env path enforces the same pane-argv budget', async () => {
    const { store } = await loaded();
    const big = { BIG: 'x'.repeat(16000) };
    const rejected = await store.applyPerBotEnvChange('app_a', { incoming: big, mode: 'replace' });
    expect(rejected).toEqual({ ok: false, reason: 'layer_too_large' });
    expect('env' in readBot()).toBe(false);
    // a merge that stays within the layer lands normally
    expect((await store.applyPerBotEnvChange('app_a', { incoming: { A: 'v' }, mode: 'merge' })).ok).toBe(true);
    // removing keys (shrinking) is always allowed, even when the layer is over budget
    const { store: preloaded } = await loaded({ env: { BIG: 'x'.repeat(16000) } });
    expect(await preloaded.applyPerBotEnvChange('app_a', { incoming: {}, mode: 'replace' }))
      .toMatchObject({ ok: true });
    expect('env' in readBot()).toBe(false);
  });

  it('the /botconfig set env and envUnset fields enforce the budget too', async () => {
    const { store } = await loaded();
    const envSpec = store.findConfigField('env')!;
    const coercedEnv = store.coerceConfigValue(envSpec, JSON.stringify({ BIG: 'x'.repeat(16000) }));
    expect(coercedEnv.ok).toBe(true);
    expect(await store.applyConfigField('app_a', envSpec, coercedEnv.value))
      .toEqual(expect.objectContaining({ ok: false, reason: 'layer_too_large' }));
    expect('env' in readBot()).toBe(false);

    const unsetSpec = store.findConfigField('envUnset')!;
    // 80 names of 50 bytes each (plus list overhead) > 4 KiB layer budget
    const names = Array.from({ length: 80 }, (_, i) => `REMOVED_VAR_NAME_${i}`.padEnd(50, 'Z'));
    const coercedUnset = store.coerceConfigValue(unsetSpec, names.join(' '));
    expect(coercedUnset.ok).toBe(true);
    expect(await store.applyConfigField('app_a', unsetSpec, coercedUnset.value))
      .toEqual(expect.objectContaining({ ok: false, reason: 'layer_too_large' }));
    expect('envUnset' in readBot()).toBe(false);
    // clearing is a shrink and always allowed
    expect((await store.applyConfigField('app_a', envSpec, null)).ok).toBe(true);
  });

  it('/botconfig envUnset keeps only removable names', async () => {
    const { store } = await loaded();
    const spec = store.findConfigField('envUnset')!;
    const coerced = store.coerceConfigValue(spec, 'BYTECLOUD_AUTH_AS, PATH BOTMUX_X  not-valid HTTPS_PROXY');
    expect(coerced).toEqual({ ok: true, value: ['BYTECLOUD_AUTH_AS', 'HTTPS_PROXY'] });
  });
});

describe('global layer (config.json sessionEnv)', () => {
  it('writes, reads back normalized, and removes the key when emptied', async () => {
    const { globalConfig } = await freshModules();
    writeFileSync(process.env.BOTMUX_GLOBAL_CONFIG_FILE!, JSON.stringify({ lang: 'zh', futureKey: { x: 1 } }));
    globalConfig.applyGlobalSessionEnvOps([
      { op: 'set', key: 'HTTPS_PROXY', value: 'http://g' },
      { op: 'unset', key: 'BYTECLOUD_AUTH_AS' },
    ]);
    const raw = () => JSON.parse(readFileSync(process.env.BOTMUX_GLOBAL_CONFIG_FILE!, 'utf8'));
    expect(raw().sessionEnv).toEqual({ set: { HTTPS_PROXY: 'http://g' }, unset: ['BYTECLOUD_AUTH_AS'] });
    expect(raw().futureKey).toEqual({ x: 1 });
    expect(globalConfig.readGlobalConfig().sessionEnv).toEqual({ set: { HTTPS_PROXY: 'http://g' }, unset: ['BYTECLOUD_AUTH_AS'] });
    globalConfig.applyGlobalSessionEnvOps([{ op: 'reset', key: 'HTTPS_PROXY' }, { op: 'reset', key: 'BYTECLOUD_AUTH_AS' }]);
    expect('sessionEnv' in raw()).toBe(false);
    expect(raw().lang).toBe('zh');
  });

  it('refuses a save that would grow the global layer past the budget', async () => {
    const { globalConfig } = await freshModules();
    expect(globalConfig.applyGlobalSessionEnvOps([{ op: 'set', key: 'A', value: 'x'.repeat(3000) }]).ok).toBe(true);
    expect(globalConfig.applyGlobalSessionEnvOps([{ op: 'set', key: 'B', value: 'y'.repeat(3000) }]))
      .toEqual({ ok: false, error: 'layer_too_large' });
    expect(globalConfig.readGlobalConfig().sessionEnv?.set).toEqual({ A: 'x'.repeat(3000) });
  });
});
