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
    expect(keys).toContain('skills');
    expect(keys).toContain('silentTurnReactions');
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

  it('displayName round-trips, fires the refresher hook, and clears on null', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('displayName')!;
    expect(spec.effect).toBe('immediate');

    let refreshed = 0;
    store.setDisplayNameRefresher(() => { refreshed++; });

    const r1 = await store.applyConfigField('app_default', spec, '小助手');
    expect(r1.ok).toBe(true);
    expect(readConfig().displayName).toBe('小助手');
    expect(registry.getBot('app_default').config.displayName).toBe('小助手');
    expect(refreshed).toBe(1);

    const r2 = await store.applyConfigField('app_default', spec, null);
    expect(r2.ok).toBe(true);
    expect(readConfig().displayName).toBeUndefined();
    expect(registry.getBot('app_default').config.displayName).toBeUndefined();
    expect(refreshed).toBe(2);

    // A throwing refresher must not fail the apply (best-effort hook).
    store.setDisplayNameRefresher(() => { throw new Error('boom'); });
    const r3 = await store.applyConfigField('app_default', spec, 'X');
    expect(r3.ok).toBe(true);
    expect(readConfig().displayName).toBe('X');
    store.setDisplayNameRefresher(null);
  });

  it('coerceConfigValue enforces the displayName length cap (spec.maxLen) for every entry point', async () => {
    const { store } = await freshModules();
    const spec = store.findConfigField('displayName')!;
    expect(store.coerceConfigValue(spec, 'x'.repeat(64))).toEqual({ ok: true, value: 'x'.repeat(64) });
    expect(store.coerceConfigValue(spec, 'x'.repeat(65))).toEqual({ ok: false, reason: 'too_long' });
    // Fields without maxLen stay uncapped (e.g. brandLabel markdown can be long).
    const brand = store.findConfigField('brandLabel')!;
    expect(store.coerceConfigValue(brand, 'y'.repeat(200)).ok).toBe(true);
  });

  it('parses bot skill policy while leaving omitted policy undefined', async () => {
    const { registry } = await freshModules();
    const [plain, skilled, advancedOnly] = registry.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'plain', larkAppSecret: 's', cliId: 'codex' },
      {
        larkAppId: 'skilled',
        larkAppSecret: 's',
        cliId: 'codex',
        skills: {
          profiles: ['frontend'],
          include: ['skill:deploy-runbook'],
          exclude: ['skill:old-release'],
          projectSkills: 'trusted',
          mode: 'priority',
          delivery: 'auto',
        },
      },
      {
        larkAppId: 'advanced-only',
        larkAppSecret: 's',
        cliId: 'codex',
        skills: {
          delivery: 'prompt',
          projectSkills: 'all',
        },
      },
    ]));

    expect(plain.skills).toBeUndefined();
    expect(skilled.skills).toEqual({ include: ['skill:deploy-runbook'] });
    expect(advancedOnly.skills).toBeUndefined();
  });

  it('parses silentTurnReactions from bots.json only when true', async () => {
    const { registry } = await freshModules();
    const [on, off, invalid] = registry.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'silent-on', larkAppSecret: 's', cliId: 'codex', silentTurnReactions: true },
      { larkAppId: 'silent-off', larkAppSecret: 's', cliId: 'codex', silentTurnReactions: false },
      { larkAppId: 'silent-invalid', larkAppSecret: 's', cliId: 'codex', silentTurnReactions: 'true' },
    ]));

    expect(on.silentTurnReactions).toBe(true);
    expect(off.silentTurnReactions).toBeUndefined();
    expect(invalid.silentTurnReactions).toBeUndefined();
  });

  it('parses substituteMode, retaining a disabled config\'s targets', async () => {
    const { registry } = await freshModules();
    const [enabled, disabled, empty, emailOnly] = registry.parseBotConfigsFromText(JSON.stringify([
      {
        larkAppId: 'sub-on',
        larkAppSecret: 's',
        cliId: 'codex',
        substituteMode: {
          enabled: true,
          disclosure: 'none',
          targets: [
            { userId: 'u_target', name: 'Target User' },
            { openId: 'ou_target', email: 'target@example.com' },
            { bogus: true },
          ],
        },
      },
      {
        larkAppId: 'sub-disabled',
        larkAppSecret: 's',
        cliId: 'codex',
        substituteMode: { enabled: false, targets: [{ userId: 'u_target' }] },
      },
      {
        larkAppId: 'sub-empty',
        larkAppSecret: 's',
        cliId: 'codex',
        substituteMode: { enabled: true, targets: [{ name: 'No ids' }] },
      },
      {
        larkAppId: 'sub-email-only',
        larkAppSecret: 's',
        cliId: 'codex',
        // email is preserved on a target but never matched at runtime, so an
        // email-only target set cannot enable the mode (would be silently dead).
        substituteMode: { enabled: true, targets: [{ email: 'ghost@example.com', name: 'Email only' }] },
      },
    ]));

    expect(enabled.substituteMode).toEqual({
      enabled: true,
      disclosure: 'none',
      targets: [
        { userId: 'u_target', name: 'Target User' },
        { openId: 'ou_target', email: 'target@example.com' },
      ],
    });
    // A disabled config keeps its target list so the dashboard toggle can flip
    // back on without re-entering everyone; only the runtime trigger stays off.
    expect(disabled.substituteMode).toEqual({
      enabled: false,
      disclosure: 'prefix',
      targets: [{ userId: 'u_target' }],
    });
    // Enabled-but-unmatchable stays dropped: an ON state with no openId/userId/
    // unionId target could never trigger (name-only and email-only are dead).
    expect(empty.substituteMode).toBeUndefined();
    expect(emailOnly.substituteMode).toBeUndefined();
  });

  it('sets and unsets JSON skills policy through /config store', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('skills')!;
    const coerced = store.coerceConfigValue(spec, '{"include":["skill:deploy-runbook"],"delivery":"prompt"}');
    expect(coerced).toEqual({ ok: true, value: { include: ['skill:deploy-runbook'] } });
    if (!coerced.ok) throw new Error('coerce failed');

    const r1 = await store.applyConfigField('app_default', spec, coerced.value);
    expect(r1.ok).toBe(true);
    expect(readConfig().skills).toEqual({ include: ['skill:deploy-runbook'] });
    expect(registry.getBot('app_default').config.skills).toEqual({ include: ['skill:deploy-runbook'] });

    const r2 = await store.applyConfigField('app_default', spec, null);
    expect(r2.ok).toBe(true);
    expect(readConfig().skills).toBeUndefined();
    expect(registry.getBot('app_default').config.skills).toBeUndefined();
  });

  it('sets/round-trips legal per-bot env (JSON) and masks values in the apply result', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('env')!;
    expect(spec.kind).toBe('json');
    expect(spec.effect).toBe('next-session');

    // Legal provider/proxy keys only — stringify primitives, persist + mask.
    const coerced = store.coerceConfigValue(
      spec,
      '{"ANTHROPIC_BASE_URL":"https://api.z.ai/api/anthropic","ANTHROPIC_AUTH_TOKEN":"glm-key","TIMEOUT":30}',
    );
    expect(coerced).toEqual({
      ok: true,
      value: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'glm-key',
        TIMEOUT: '30',
      },
    });
    if (!coerced.ok) throw new Error('coerce failed');

    const r1 = await store.applyConfigField('app_default', spec, coerced.value);
    expect(r1.ok).toBe(true);
    // Persisted verbatim (sanitized) to bots.json + memory…
    expect(readConfig().env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'glm-key',
      TIMEOUT: '30',
    });
    expect(registry.getBot('app_default').config.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'glm-key',
      TIMEOUT: '30',
    });
    // …but the human-facing text masks the values (no token leak in /config get).
    if (r1.ok) {
      expect(r1.newText).not.toContain('glm-key');
      expect(r1.newText).not.toContain('api.z.ai');
      expect(r1.newText).toContain('ANTHROPIC_AUTH_TOKEN=••••');
    }

    // non-object JSON rejected
    expect(store.coerceConfigValue(spec, '"a-string"')).toEqual({ ok: false, reason: 'invalid_json' });
    expect(store.coerceConfigValue(spec, '[1,2]')).toEqual({ ok: false, reason: 'invalid_json' });
    // garbage-only object (no reserved keys, nothing valid after sanitize)
    expect(store.coerceConfigValue(spec, '{"1BAD":"z"}')).toEqual({ ok: false, reason: 'invalid_json' });

    const r2 = await store.applyConfigField('app_default', spec, null);
    expect(r2.ok).toBe(true);
    expect(readConfig().env).toBeUndefined();
    expect(registry.getBot('app_default').config.env).toBeUndefined();
  });

  it('rejects reserved env keys (BOTMUX_*/GROK_HOME/CODEX_HOME) instead of silent drop', async () => {
    const { store } = await loaded();
    const spec = store.findConfigField('env')!;

    // Any reserved key fails the whole write so users see the error (no
    // split-brain from quietly accepting GROK_HOME while daemon paths stay default).
    expect(store.coerceConfigValue(
      spec,
      '{"ANTHROPIC_BASE_URL":"https://api.z.ai/api/anthropic","BOTMUX_SESSION_ID":"hijack"}',
    )).toEqual({ ok: false, reason: 'reserved_env' });

    expect(store.coerceConfigValue(
      spec,
      '{"GROK_HOME":"/tmp/evil-grok","ANTHROPIC_AUTH_TOKEN":"x"}',
    )).toEqual({ ok: false, reason: 'reserved_env' });

    expect(store.coerceConfigValue(
      spec,
      '{"CODEX_HOME":"/tmp/evil-codex"}',
    )).toEqual({ ok: false, reason: 'reserved_env' });

    // Reserved-only object also fails as reserved_env (not invalid_json).
    expect(store.coerceConfigValue(spec, '{"BOTMUX_X":"y"}')).toEqual({ ok: false, reason: 'reserved_env' });
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

  it('silentTurnReactions writes true / deletes key on false (keeps bots.json tidy)', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('silentTurnReactions')!;

    await store.applyConfigField('app_default', spec, true);
    expect(readConfig().silentTurnReactions).toBe(true);
    expect(registry.getBot('app_default').config.silentTurnReactions).toBe(true);

    await store.applyConfigField('app_default', spec, false);
    expect(readConfig().silentTurnReactions).toBeUndefined();
    expect(registry.getBot('app_default').config.silentTurnReactions).toBeUndefined();
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

  it('stringList (customPassthroughCommands) coerces, dedupes, drops daemon-shadowing + junk', async () => {
    const { store } = await freshModules();
    const spec = store.findConfigField('customPassthroughCommands')!;
    expect(spec.kind).toBe('stringList');
    // 逗号/空格混排、缺前导 / 自动补、大写归一、去重；/status 遮蔽 daemon 命令被丢、`/b@d` 非法字符被丢。
    expect(store.coerceConfigValue(spec, 'goal, /export /GOAL /status /b@d'))
      .toEqual({ ok: true, value: ['/goal', '/export'] });
    // 全部非法/被过滤 → empty。
    expect(store.coerceConfigValue(spec, '/status /!nope')).toEqual({ ok: false, reason: 'empty' });
  });

  it('stringList field round-trips array to disk + memory; empty/unset clears the key', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('customPassthroughCommands')!;

    const r1 = await store.applyConfigField('app_default', spec, ['/goal', '/export']);
    expect(r1.ok).toBe(true);
    if (r1.ok) { expect(r1.oldText).toBe('∅'); expect(r1.newText).toBe('/goal, /export'); expect(r1.effect).toBe('immediate'); }
    expect(readConfig().customPassthroughCommands).toEqual(['/goal', '/export']);
    expect(registry.getBot('app_default').config.customPassthroughCommands).toEqual(['/goal', '/export']);

    // 空数组等价清除（bots.json 保持干净）。
    const r2 = await store.applyConfigField('app_default', spec, []);
    expect(r2.ok).toBe(true);
    expect(readConfig().customPassthroughCommands).toBeUndefined();
    expect(registry.getBot('app_default').config.customPassthroughCommands).toBeUndefined();
  });

  it('getConfigCardData surfaces customPassthroughCommands as a space-joined string', async () => {
    const { store } = await loaded({ customPassthroughCommands: ['/goal', '/export'] });
    expect(store.getConfigCardData('app_default')?.customPassthroughCommands).toBe('/goal /export');
    const { store: store2 } = await loaded();
    expect(store2.getConfigCardData('app_default')?.customPassthroughCommands).toBeNull();
  });

  it('startupCommands is a next-session stringList that keeps argument spaces (own parser)', async () => {
    const { store } = await freshModules();
    const spec = store.findConfigField('startupCommands')!;
    expect(spec.kind).toBe('stringList');
    expect(spec.effect).toBe('next-session');
    // Comma/newline split (NOT space) — args survive; leading / auto-added; deduped.
    expect(store.coerceConfigValue(spec, 'effort ultracode, /model opus\n/effort ultracode'))
      .toEqual({ ok: true, value: ['/effort ultracode', '/model opus'] });
    expect(store.coerceConfigValue(spec, '   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('startupCommands round-trips array to disk + memory; empty clears the key', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('startupCommands')!;

    const r1 = await store.applyConfigField('app_default', spec, ['/effort ultracode', '/model opus']);
    expect(r1.ok).toBe(true);
    if (r1.ok) { expect(r1.newText).toBe('/effort ultracode, /model opus'); expect(r1.effect).toBe('next-session'); }
    expect(readConfig().startupCommands).toEqual(['/effort ultracode', '/model opus']);
    expect(registry.getBot('app_default').config.startupCommands).toEqual(['/effort ultracode', '/model opus']);

    const r2 = await store.applyConfigField('app_default', spec, []);
    expect(r2.ok).toBe(true);
    expect(readConfig().startupCommands).toBeUndefined();
    expect(registry.getBot('app_default').config.startupCommands).toBeUndefined();
  });

  it('getConfigCardData joins startupCommands with ", " (commands carry space args)', async () => {
    const { store } = await loaded({ startupCommands: ['/effort ultracode', '/model opus'] });
    expect(store.getConfigCardData('app_default')?.startupCommands).toBe('/effort ultracode, /model opus');
    const { store: store2 } = await loaded();
    expect(store2.getConfigCardData('app_default')?.startupCommands).toBeNull();
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
