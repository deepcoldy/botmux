/**
 * Unit tests for the /config bot-config store: operational-field set/unset
 * round-trips through bots.json + the in-memory registry (no daemon restart),
 * and the sensitive allowedUsers path (re-resolve + self-lockout guard).
 *
 * Run: pnpm vitest run test/bot-config-store.test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) { this.opts = opts; }
  }
  return { Client: FakeClient };
});

// Stub the Lark client so setBotAllowedUsers resolves emails/on_ → fake open_ids
// without any network. Mirrors resolveAllowedUsersWithMap's contract: pass ou_
// through, on_xxx → ou_xxx, email → ou_<localpart>, anything else is dropped.
vi.mock('../src/im/lark/client.js', () => ({
  resolveAllowedUsersWithMap: async (_appId: string, raw: string[]) => {
    const map = new Map<string, string>();
    const resolved: string[] = [];
    for (const v of raw) {
      let id: string | undefined;
      if (v.startsWith('ou_')) id = v;
      else if (v.startsWith('on_')) id = 'ou_' + v.slice(3);
      else if (v.includes('@')) id = 'ou_' + v.split('@')[0];
      if (id) { resolved.push(id); map.set(v, id); }
    }
    return { resolved, map };
  },
}));

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/bot-config-store.js');
  return { registry, store };
}

describe('bot-config store', () => {
  let configPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cfgstore-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
  });
  afterEach(() => { delete process.env.BOTS_CONFIG; });

  function writeConfig(entry: Record<string, unknown> = {}) {
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: 'app_default',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
      ...entry,
    }], null, 2), 'utf-8');
  }
  function readConfig(): any {
    return JSON.parse(readFileSync(configPath, 'utf-8'))[0];
  }
  async function loaded(entry: Record<string, unknown> = {}) {
    writeConfig(entry);
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach((c: any) => registry.registerBot(c));
    return { registry, store };
  }

  it('CONFIG_FIELDS have unique keys and include allowedUsers', async () => {
    const { store } = await freshModules();
    const keys = store.CONFIG_FIELDS.map(f => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('allowedUsers');
    expect(keys).toContain('model');
    expect(keys).not.toContain('repoPickerMode');
  });

  it('parseBooleanValue accepts on/off variants and rejects junk', async () => {
    const { store } = await freshModules();
    for (const v of ['on', 'true', '1', 'yes', '开']) expect(store.parseBooleanValue(v)).toBe(true);
    for (const v of ['off', 'false', '0', 'no', '关']) expect(store.parseBooleanValue(v)).toBe(false);
    expect(store.parseBooleanValue('maybe')).toBeUndefined();
  });

  it('findConfigField is case-insensitive; unknown → undefined', async () => {
    const { store } = await freshModules();
    expect(store.findConfigField('MODEL')?.configKey).toBe('model');
    expect(store.findConfigField('disablestreamingcard')?.configKey).toBe('disableStreamingCard');
    expect(store.findConfigField('nope')).toBeUndefined();
  });

  it('set + unset a string field (model) round-trips to disk and in-memory', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('model')!;

    const r1 = await store.applyConfigField('app_default', spec, 'opus');
    expect(r1.ok).toBe(true);
    if (r1.ok) { expect(r1.oldText).toBe('∅'); expect(r1.newText).toBe('opus'); expect(r1.effect).toBe('next-session'); }
    expect(readConfig().model).toBe('opus');
    expect(registry.getBot('app_default').config.model).toBe('opus');

    const r2 = await store.applyConfigField('app_default', spec, null);
    expect(r2.ok).toBe(true);
    expect(readConfig().model).toBeUndefined();
    expect(registry.getBot('app_default').config.model).toBeUndefined();
  });

  it('boolean field writes true / deletes key on false (keeps bots.json tidy)', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('disableStreamingCard')!;

    await store.applyConfigField('app_default', spec, true);
    expect(readConfig().disableStreamingCard).toBe(true);
    expect(registry.getBot('app_default').config.disableStreamingCard).toBe(true);

    await store.applyConfigField('app_default', spec, false);
    expect(readConfig().disableStreamingCard).toBeUndefined();
    expect(registry.getBot('app_default').config.disableStreamingCard).toBeUndefined();
  });

  it('number field (maxLiveWorkers) round-trips and clears on null', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('maxLiveWorkers')!;
    expect(spec.kind).toBe('number');
    expect(spec.effect).toBe('immediate');

    const r1 = await store.applyConfigField('app_default', spec, 6);
    expect(r1.ok).toBe(true);
    if (r1.ok) { expect(r1.oldText).toBe('∅'); expect(r1.newText).toBe('6'); }
    expect(readConfig().maxLiveWorkers).toBe(6);
    expect(registry.getBot('app_default').config.maxLiveWorkers).toBe(6);

    const r2 = await store.applyConfigField('app_default', spec, null);
    expect(r2.ok).toBe(true);
    expect(readConfig().maxLiveWorkers).toBeUndefined();
    expect(registry.getBot('app_default').config.maxLiveWorkers).toBeUndefined();
  });

  it('coerceConfigValue(number) accepts positive integers and rejects junk/≤0/fractions', async () => {
    const { store } = await loaded();
    const spec = store.findConfigField('maxLiveWorkers')!;
    expect(store.coerceConfigValue(spec, 4)).toEqual({ ok: true, value: 4 });
    expect(store.coerceConfigValue(spec, '12')).toEqual({ ok: true, value: 12 });
    expect(store.coerceConfigValue(spec, 0)).toEqual({ ok: false, reason: 'invalid_number' });
    expect(store.coerceConfigValue(spec, -3)).toEqual({ ok: false, reason: 'invalid_number' });
    expect(store.coerceConfigValue(spec, 1.5)).toEqual({ ok: false, reason: 'invalid_number' });
    expect(store.coerceConfigValue(spec, 'abc')).toEqual({ ok: false, reason: 'invalid_number' });
  });

  it('cli field persists the chosen adapter id', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('cli')!;
    const r = await store.applyConfigField('app_default', spec, 'codex');
    expect(r.ok).toBe(true);
    expect(readConfig().cliId).toBe('codex');
    expect(registry.getBot('app_default').config.cliId).toBe('codex');
  });

  it('getConfigSnapshot reports current values + info', async () => {
    const { store } = await loaded({ model: 'sonnet', disableStreamingCard: true });
    const snap = store.getConfigSnapshot('app_default');
    expect(snap.ok).toBe(true);
    if (snap.ok) {
      expect(snap.info.cliId).toBe('claude-code');
      expect(snap.info.resolvedAdmins).toBe(1);
      const model = snap.rows.find(r => r.key === 'model');
      expect(model?.value).toBe('sonnet');
      const card = snap.rows.find(r => r.key === 'disableStreamingCard');
      expect(card?.value).toBe('on');
    }
  });

  it('setBotAllowedUsers persists raw entries and syncs resolved open_ids', async () => {
    const { registry, store } = await loaded();
    const r = await store.setBotAllowedUsers('app_default', ['alice@corp.com', 'ou_owner'], 'ou_owner');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toEqual(['ou_alice', 'ou_owner']);

    expect(readConfig().allowedUsers).toEqual(['alice@corp.com', 'ou_owner']);
    const bot = registry.getBot('app_default');
    expect(bot.config.allowedUsers).toEqual(['alice@corp.com', 'ou_owner']);
    expect(bot.resolvedAllowedUsers).toEqual(['ou_alice', 'ou_owner']);
  });

  it('setBotAllowedUsers refuses self-lockout (sender not in resolved list)', async () => {
    const { registry, store } = await loaded();
    const r = await store.setBotAllowedUsers('app_default', ['bob@corp.com'], 'ou_owner');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('self_lockout');
    // Disk + memory untouched.
    expect(readConfig().allowedUsers).toEqual(['ou_owner']);
    expect(registry.getBot('app_default').resolvedAllowedUsers).toEqual(['ou_owner']);
  });

  it('setBotAllowedUsers rejects an all-unresolvable list as empty', async () => {
    const { store } = await loaded();
    const r = await store.setBotAllowedUsers('app_default', ['garbage'], 'ou_owner');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty_resolved');
  });

  it('coerceConfigValue parses per kind (bool/enum/cli) and rejects junk', async () => {
    const { store } = await freshModules();
    const boolSpec = store.findConfigField('disableStreamingCard')!;
    expect(store.coerceConfigValue(boolSpec, 'on')).toEqual({ ok: true, value: true });
    expect(store.coerceConfigValue(boolSpec, 'nope')).toEqual({ ok: false, reason: 'invalid_bool' });
    const langSpec = store.findConfigField('lang')!;
    expect(store.coerceConfigValue(langSpec, 'EN')).toEqual({ ok: true, value: 'en' });
    expect(store.coerceConfigValue(langSpec, 'fr')).toEqual({ ok: false, reason: 'invalid_enum' });
    const cliSpec = store.findConfigField('cli')!;
    expect(store.coerceConfigValue(cliSpec, 'codex')).toEqual({ ok: true, value: 'codex' });
    expect(store.coerceConfigValue(cliSpec, 'bogus-cli')).toEqual({ ok: false, reason: 'invalid_cli' });
  });

  it('getConfigCardData returns the card view (booleans + cli options + model choices)', async () => {
    const { store } = await loaded({ model: 'opus', disableStreamingCard: true });
    const data = store.getConfigCardData('app_default', ['opus', 'sonnet']);
    expect(data).not.toBeNull();
    expect(data!.cliId).toBe('claude-code');
    expect(data!.model).toBe('opus');
    expect(data!.modelChoices).toEqual(['opus', 'sonnet']);
    expect(data!.cliOptions.length).toBeGreaterThan(0);
    expect(data!.booleans.find(b => b.key === 'disableStreamingCard')?.on).toBe(true);
    expect(store.getConfigCardData('app_missing')).toBeNull();
  });

  it('returns bot_not_registered for an unknown bot', async () => {
    const { store } = await loaded();
    const spec = store.findConfigField('model')!;
    const r = await store.applyConfigField('app_missing', spec, 'x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bot_not_registered');
  });
});
