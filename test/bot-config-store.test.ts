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
import { validateCodexServiceTier } from '../src/services/codex-service-tier-catalog.js';

vi.mock('../src/services/codex-service-tier-catalog.js', () => ({
  validateCodexServiceTier: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) { this.opts = opts; }
  }
  return { Client: FakeClient };
});

// Stub the Lark client so setBotAllowedUsers resolves emails/on_ → fake open_ids
// without any network. Mirrors resolveAllowedUsersWithMap's contract: pass ou_
// through, on_xxx → ou_xxx, email → ou_<localpart> (except ghost@*, which models
// a definitive miss: no such user / not visible), anything else is dropped.
vi.mock('../src/im/lark/client.js', () => ({
  resolveAllowedUsersWithMap: async (_appId: string, raw: string[]) => {
    const map = new Map<string, string>();
    const resolved: string[] = [];
    const entryStatus = new Map<string, 'resolved' | 'transient' | 'definitive'>();
    for (const v of raw) {
      let id: string | undefined;
      if (v.startsWith('ou_')) id = v;
      else if (v.startsWith('on_')) id = 'ou_' + v.slice(3);
      else if (v.includes('@') && !v.startsWith('ghost@')) id = 'ou_' + v.split('@')[0];
      if (id) { resolved.push(id); map.set(v, id); entryStatus.set(v, 'resolved'); }
      else entryStatus.set(v, 'definitive');
    }
    const definitiveMisses = raw.filter(v => entryStatus.get(v) === 'definitive');
    return { resolved, map, entryStatus, definitiveMisses };
  },
}));

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/bot-config-store.js');
  const pinStreamingCardChange = await import('../src/services/pin-streaming-card-change.js');
  return { registry, store, pinStreamingCardChange };
}

describe('bot-config store', () => {
  let configPath: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-cfgstore-'));
    configPath = join(dir, 'bots.json');
    process.env.BOTS_CONFIG = configPath;
    // Isolate the allowedUsers sidecar (setBotAllowedUsers writes it) into the
    // same tmp dir so tests don't pollute the real ~/.botmux/data.
    process.env.SESSION_DATA_DIR = dir;
    vi.mocked(validateCodexServiceTier).mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(() => { delete process.env.BOTS_CONFIG; delete process.env.SESSION_DATA_DIR; });

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
    const { registry, store, pinStreamingCardChange } = await freshModules();
    registry.loadBotConfigs().forEach((c: any) => registry.registerBot(c));
    return { registry, store, pinStreamingCardChange };
  }

  it('round-trips envPolicy through shared CLI coercion, file parsing, persistence and memory', async () => {
    const { registry, store } = await loaded({ envPolicy: { mode: 'strict', inherit: ['HTTPS_PROXY'] } });
    const spec = store.findConfigField('envPolicy')!;
    expect(spec.effect).toBe('next-session');
    const coerced = store.coerceConfigValue(spec, '{"mode":"strict","inherit":["NODE_EXTRA_CA_CERTS","HTTPS_PROXY","HTTPS_PROXY"]}');
    expect(coerced.ok).toBe(true);
    if (!coerced.ok) return;
    expect((await store.applyConfigField('app_default', spec, coerced.value)).ok).toBe(true);
    const saved = readConfig().envPolicy;
    expect(saved).toEqual({ mode: 'strict', inherit: ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS'] });
    expect(registry.getBot('app_default').config.envPolicy).toEqual(saved);
    expect(registry.loadBotConfigs()[0]!.envPolicy).toEqual(saved);
    expect((await store.applyConfigField('app_default', spec, { mode: 'strict', inherit: ['BOTMUX_OWNER_OPEN_ID'] })).ok).toBe(false);
    expect(readConfig().envPolicy).toEqual(saved);
    expect((await store.applyConfigField('app_default', spec, null)).ok).toBe(true);
    expect(readConfig().envPolicy).toBeUndefined();
    expect(registry.getBot('app_default').config.envPolicy).toBeUndefined();
  });
  it('rejects a malformed strict file policy instead of falling back to inherited credentials', async () => {
    writeConfig({ envPolicy: { mode: 'strict', inherit: ['*'] } });
    const { registry } = await freshModules();
    expect(() => registry.loadBotConfigs()).toThrow('permitted environment variable names');
  });

  it('zero injection is per-bot, preserves reply preferences, and refuses unsupported CLI changes', async () => {
    const { registry, store } = await loaded({ cliId: 'codex', replyDelivery: 'send' });
    const spec = store.findConfigField('promptInjection')!;
    expect((await store.applyConfigField('app_default', spec, 'none')).ok).toBe(true);
    expect(readConfig()).toMatchObject({ promptInjection: 'none', replyDelivery: 'send' });
    const { effectiveReplyDelivery } = await import('../src/core/reply-delivery.js');
    expect(effectiveReplyDelivery('app_default', 'codex')).toBe('transcript');
    registry.registerBot({ larkAppId: 'plain', larkAppSecret: 's', cliId: 'codex' });
    expect(effectiveReplyDelivery('plain', 'codex')).toBe('send');
    const cli = store.findConfigField('cli')!;
    const changed = await store.applyConfigField('app_default', cli, 'gemini');
    expect(changed).toMatchObject({ ok: false, reason: 'zero_prompt_unsupported' });
    expect(readConfig().cliId).toBe('codex');
    expect((await store.applyConfigField('app_default', spec, 'default')).ok).toBe(true);
    expect(effectiveReplyDelivery('app_default', 'codex')).toBe('send');
    expect(readConfig().replyDelivery).toBe('send');
  });

  it.each([
    ['codex', { id: 'vendor-codex', executable: '/opt/bin/vendor-codex' }, 'kimi'],
    ['kimi', { id: 'codem', displayName: 'CodeM', executable: '/opt/bin/codem-wrapper' }, 'codex'],
  ] as const)('/config cli switch %s -> %s drops the stranded structured runtime on disk and in memory', async (fromCli, runtime, toCli) => {
    const { registry, store } = await loaded({
      cliId: fromCli,
      cliRuntime: { ...runtime, update: { provider: 'none' } },
      cliPathOverride: runtime.executable,
    });
    const changed = await store.applyConfigField('app_default', store.findConfigField('cli')!, toCli);
    expect(changed).toMatchObject({ ok: true });
    // Disk: descriptor and its equal downgrade shadow are both gone.
    expect(readConfig()).toMatchObject({ cliId: toCli });
    expect(readConfig().cliRuntime).toBeUndefined();
    expect(readConfig().cliPathOverride).toBeUndefined();
    // Memory config must match the persisted generation (new sessions read it).
    const live = registry.getBot('app_default').config;
    expect(live.cliRuntime).toBeUndefined();
    expect(live.cliPathOverride).toBeUndefined();
    // A fresh reload accepts the next generation instead of running one
    // family's binary under the other family's interaction contract.
    expect(() => registry.loadBotConfigs()).not.toThrow();
  });

  it.each([
    ['codex', { id: 'vendor-codex', executable: '/opt/bin/vendor-codex' }],
    ['kimi', { id: 'codem', displayName: 'CodeM', executable: '/opt/bin/codem-wrapper' }],
  ] as const)('/config cli re-selecting the same %s family preserves its structured runtime', async (cliId, runtime) => {
    const { store } = await loaded({
      cliId,
      cliRuntime: { ...runtime, update: { provider: 'none' } },
      cliPathOverride: runtime.executable,
    });
    const changed = await store.applyConfigField('app_default', store.findConfigField('cli')!, cliId);
    expect(changed).toMatchObject({ ok: true });
    expect(readConfig()).toMatchObject({
      cliId,
      cliRuntime: expect.objectContaining({ id: runtime.id }),
      cliPathOverride: runtime.executable,
    });
  });

  it('/config cli switch keeps an unrelated legacy cliPathOverride but clears a switch to an unsupported adapter', async () => {
    // Legacy raw paths predate structured runtimes and are deliberately not
    // scoped to an adapter family — same parity as setup edits.
    {
      const { store } = await loaded({ cliId: 'codex', cliPathOverride: '/opt/legacy-router' });
      const changed = await store.applyConfigField('app_default', store.findConfigField('cli')!, 'kimi');
      expect(changed).toMatchObject({ ok: true });
      expect(readConfig()).toMatchObject({ cliId: 'kimi', cliPathOverride: '/opt/legacy-router' });
      expect(readConfig().cliRuntime).toBeUndefined();
    }
    // Structured runtime + switch to an adapter that has no runtime support:
    // the descriptor is cleared, so the next generation reloads instead of
    // failing the whole bots.json parse.
    {
      const { registry, store } = await loaded({
        cliId: 'codex',
        cliRuntime: { id: 'vendor-codex', executable: '/opt/bin/vendor-codex' },
        cliPathOverride: '/opt/bin/vendor-codex',
      });
      const changed = await store.applyConfigField('app_default', store.findConfigField('cli')!, 'claude-code');
      expect(changed).toMatchObject({ ok: true });
      expect(readConfig()).toMatchObject({ cliId: 'claude-code' });
      expect(readConfig().cliRuntime).toBeUndefined();
      expect(readConfig().cliPathOverride).toBeUndefined();
      expect(() => registry.loadBotConfigs()).not.toThrow();
    }
  });

  it.each(['traex', 'coco', 'hermes', 'mtr', 'pi', 'oh-my-pi', 'ebsd', 'grok'])('enables zero injection for %s using its final-reply capability', async (cliId) => {
    const { store } = await loaded({ cliId, replyDelivery: 'send' });
    expect((await store.applyConfigField('app_default', store.findConfigField('promptInjection')!, 'none')).ok).toBe(true);
    expect(readConfig()).toMatchObject({ promptInjection: 'none', replyDelivery: 'send' });
    const { effectiveReplyDelivery } = await import('../src/core/reply-delivery.js');
    expect(effectiveReplyDelivery('app_default', cliId)).toBe('transcript');
  });

  it.each(['codex', 'traex'])('supports zero injection with local %s RPC input', async (cliId) => {
    const { store } = await loaded({ cliId, codexRpcInput: true });
    expect((await store.applyConfigField('app_default', store.findConfigField('promptInjection')!, 'none')).ok).toBe(true);
    expect(readConfig()).toMatchObject({ promptInjection: 'none', codexRpcInput: true });
  });

  it('judges zero injection on the effective backend (daemon default when not overridden)', async () => {
    process.env.BACKEND_TYPE = 'zmx';
    try {
      // antigravity zero injection cannot run on zmx; with no override the session uses it.
      const { store } = await loaded({ cliId: 'antigravity' });
      const zero = store.findConfigField('promptInjection')!;
      expect(await store.applyConfigField('app_default', zero, 'none'))
        .toMatchObject({ ok: false, reason: 'zero_prompt_unsupported' });
      const backend = store.findConfigField('backendType')!;
      expect((await store.applyConfigField('app_default', backend, 'tmux')).ok).toBe(true);
      expect((await store.applyConfigField('app_default', zero, 'none')).ok).toBe(true);
      // Clearing the override falls back to zmx: refused while zero injection is on.
      expect(await store.applyConfigField('app_default', backend, null))
        .toMatchObject({ ok: false, reason: 'zero_prompt_unsupported' });
      expect(readConfig().backendType).toBe('tmux');
    } finally {
      delete process.env.BACKEND_TYPE;
    }
  });

  it('pairs a remote daemon default back to pty for a local CLI, as spawning does', async () => {
    process.env.BACKEND_TYPE = 'riff';
    try {
      // claude-code never spawns on riff: the pairing resolves it to pty, which supports zero injection.
      const { store } = await loaded({ cliId: 'claude-code' });
      expect((await store.applyConfigField('app_default', store.findConfigField('promptInjection')!, 'none')).ok).toBe(true);
      // Runtime prompt construction agrees with the accepted write.
      const { zeroPromptInjectionForBot } = await import('../src/core/prompt-injection.js');
      expect(zeroPromptInjectionForBot('app_default')).toBe(true);
    } finally {
      delete process.env.BACKEND_TYPE;
    }
  });

  it('treats a stale remote backend override on a local CLI the way spawning does', async () => {
    // e.g. left over after switching away from a remote CLI: spawn pairs it back to local.
    const { store } = await loaded({ cliId: 'claude-code', backendType: 'riff', replyDelivery: 'send' });
    expect((await store.applyConfigField('app_default', store.findConfigField('promptInjection')!, 'none')).ok).toBe(true);
    const { zeroPromptInjectionForBot } = await import('../src/core/prompt-injection.js');
    expect(zeroPromptInjectionForBot('app_default')).toBe(true);
    const { effectiveReplyDelivery } = await import('../src/core/reply-delivery.js');
    expect(effectiveReplyDelivery('app_default', 'claude-code')).toBe('transcript');
  });

  it('rejects zero injection without automatic reply support', async () => {
    const { store } = await loaded({ cliId: 'gemini' });
    expect(await store.applyConfigField('app_default', store.findConfigField('promptInjection')!, 'none'))
      .toMatchObject({ ok: false, reason: 'zero_prompt_unsupported' });
    expect(readConfig().promptInjection).toBeUndefined();
  });

  it.each([undefined, 'reject', 'trusted-egress'])('network policy with proxyMode %s persists atomically; clear restores legacy network', async proxyMode => {
    const { registry, store } = await loaded({ sandbox: true, backendType: 'pty', sandboxNetwork: false });
    const spec = store.findConfigField('sandboxNetworkPolicy')!;
    const policy = { version: 1, public: { mode: 'allow' }, private: { mode: 'block' }, ...(proxyMode !== undefined ? { proxyMode } : {}) };
    expect(store.coerceConfigValue(spec, JSON.stringify(policy))).toMatchObject({ ok: true, value: policy });
    expect(store.coerceConfigValue(spec, JSON.stringify({ ...policy, public: { mode: 'allowlist', rules: [{ cidr: 'example.org' }] } }))).toMatchObject({ ok: false });
    // Linux-only runtime support is a deliberate gate, not a silent no-op.
    if (process.platform !== 'linux') {
      expect(await store.applyConfigField('app_default', spec, policy)).toMatchObject({ ok: false });
      expect(readConfig()).not.toHaveProperty('sandboxNetworkPolicy');
      return;
    }
    expect((await store.applyConfigField('app_default', spec, policy)).ok).toBe(true);
    expect(readConfig().sandboxNetworkPolicy).toEqual(policy);
    expect(registry.getBot('app_default').config.sandboxNetworkPolicy).toEqual(policy);
    expect(await store.applyConfigField('app_default', store.findConfigField('backendType')!, 'tmux')).toMatchObject({ ok: false });
    expect(readConfig().backendType).toBe('pty');
    expect((await store.applyConfigField('app_default', spec, null)).ok).toBe(true);
    expect(readConfig()).not.toHaveProperty('sandboxNetworkPolicy');
    expect(readConfig().sandboxNetwork).toBe(false);
  });

  it('CONFIG_FIELDS have unique keys and include allowedUsers', async () => {
    const { store } = await freshModules();
    const keys = store.CONFIG_FIELDS.map(f => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('allowedUsers');
    expect(keys).toContain('model');
    expect(keys).not.toContain('repoPickerMode');
    expect(keys).toContain('skills');
    expect(keys).toContain('silentTurnReactions');
    expect(keys).toContain('codexAppCleanInput');
    expect(keys).toContain('feedback');
    expect(keys).toContain('showReplyTiming');
    expect(keys).toContain('cardActionAckTimeoutMs');
    expect(keys).toContain('herdr');
  });

  it('strictly normalizes the herdr JSON field and clears an empty block', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('herdr')!;
    expect(spec).toMatchObject({ kind: 'json', effect: 'next-session', clearable: true });
    // 合法块：trim 文本、保留枚举与 chatTypes。
    const ok = store.coerceConfigValue(spec, JSON.stringify({
      sessionName: ' default ',
      placement: 'split',
      workspace: '  ',
      tab: '3',
      splitDirection: 'right',
      chatTypes: ['group'],
    }));
    expect(ok).toEqual({
      ok: true,
      value: { sessionName: 'default', placement: 'split', tab: '3', splitDirection: 'right', chatTypes: ['group'] },
    });
    expect((await store.applyConfigField('app_default', spec, (ok as any).value)).ok).toBe(true);
    expect(readConfig().herdr).toEqual({ sessionName: 'default', placement: 'split', tab: '3', splitDirection: 'right', chatTypes: ['group'] });
    expect(registry.getBot('app_default').config.herdr).toEqual(readConfig().herdr);
    // 非法 placement / 未知字段 / 错误类型显式拒绝（不静默剔除），且不动已落盘配置。
    for (const bad of [
      { placement: 'nope' },
      { session: 'default' },
      { sessionName: 3 },
      { chatTypes: ['group', 'x'] },
      [1, 2],
    ]) {
      const rejected = store.coerceConfigValue(spec, JSON.stringify(bad));
      expect(rejected.ok, JSON.stringify(bad)).toBe(false);
      expect((rejected as any).reason).toContain('invalid_herdr_config');
    }
    expect(readConfig().herdr).toBeDefined();
    // chatTypes 重复值与 bots.json/env 门一致：去重接受，不报错。
    const dup = store.coerceConfigValue(spec, JSON.stringify({
      sessionName: 'default', chatTypes: ['group', 'group', 'p2p'],
    }));
    expect(dup).toEqual({ ok: true, value: { sessionName: 'default', chatTypes: ['group', 'p2p'] } });
    // 空对象归一为 null：applyConfigField 删除整个 herdr 键。
    const empty = store.coerceConfigValue(spec, '{}');
    expect(empty).toEqual({ ok: true, value: null });
    expect((await store.applyConfigField('app_default', spec, null)).ok).toBe(true);
    expect(readConfig()).not.toHaveProperty('herdr');
    expect(registry.getBot('app_default').config.herdr).toBeUndefined();
  });

  it('rejects an inert herdr block through the shared /config coerce path too', async () => {
    const { store } = await loaded();
    const spec = store.findConfigField('herdr')!;
    // IM /config set 与 Dashboard 共用 coerceConfigValue：无 sessionName/placement
    // 时只填子字段必须拒绝，不能存出「零效果」块。
    for (const raw of [{ tab: '3' }, { workspace: 'w' }, { splitDirection: 'down' }, { chatTypes: ['group'] }]) {
      const r = store.coerceConfigValue(spec, JSON.stringify(raw));
      expect(r.ok, JSON.stringify(raw)).toBe(false);
      expect((r as any).reason).toContain('invalid_herdr_config');
    }
    // env 已提供 placement 时，只覆盖 tab 的部分块合法（字段级叠加）。
    const cfg = (await import('../src/config.js')).config.daemon as { herdr?: unknown };
    const prev = cfg.herdr;
    cfg.herdr = { placement: 'split' };
    try {
      expect(store.coerceConfigValue(spec, JSON.stringify({ tab: '3' }))).toEqual({ ok: true, value: { tab: '3' } });
    } finally {
      if (prev === undefined) delete cfg.herdr; else cfg.herdr = prev;
    }
  });

  it('keeps the strict herdr field list in parity with the normalizer', async () => {
    const { store } = await loaded();
    const types = await import('../src/adapters/backend/types.js');
    const spec = store.findConfigField('herdr')!;
    const allFields = types.normalizeHerdrBackendConfig({
      sessionName: 'default', placement: 'split', workspace: 'w', tab: 't',
      splitDirection: 'right', chatTypes: ['group', 'p2p'],
    });
    // 严格门字段表必须与归一器实际接受的键完全一致：漏一个就会把新字段当
    // 未知字段拒绝（或两边语义分叉）。
    expect([...store.HERDR_FIELD_NAMES].sort()).toEqual(Object.keys(allFields).sort());
    // 每个字段单独传入都能被严格门识别为已知字段（不报「不是可识别字段」）。
    for (const key of store.HERDR_FIELD_NAMES) {
      const value = key === 'placement' ? 'workspace'
        : key === 'splitDirection' ? 'right'
        : key === 'chatTypes' ? ['group']
        : key === 'sessionName' ? 's' : 'x';
      const r = store.coerceConfigValue(spec, JSON.stringify({ [key]: value }));
      if (r.ok === false) expect(r.reason).not.toContain('不是可识别字段');
    }
    void spec;
  });

  it('strictly normalizes feedback JSON through the shared config field', async () => {
    const { store } = await loaded();
    const spec = store.findConfigField('feedback')!;
    expect(store.coerceConfigValue(spec, '{"enabled":true}')).toMatchObject({
      ok: true,
      value: { enabled: true, audience: 'requester' },
    });
    expect(store.coerceConfigValue(spec, '{"enabled":true,"audience":"all"}')).toEqual({ ok: false, reason: 'invalid_json' });
  });

  it('hot-updates sender email hiding through botconfig and reloads it', async () => {
    const { registry, store } = await loaded({ cliId: 'codex' });
    const spec = store.findConfigField('senderTagHideEmail')!;
    expect(spec).toMatchObject({ kind: 'boolean', effect: 'immediate' });
    expect(store.coerceConfigValue(spec, 'on')).toEqual({ ok: true, value: true });
    expect(store.coerceConfigValue(spec, 'off')).toEqual({ ok: true, value: false });
    expect((await store.applyConfigField('app_default', spec, true)).ok).toBe(true);
    expect(registry.getBot('app_default').config.senderTagHideEmail).toBe(true);
    expect(registry.loadBotConfigs()[0].senderTagHideEmail).toBe(true);
    expect((await store.applyConfigField('app_default', spec, false)).ok).toBe(true);
    expect(readConfig()).not.toHaveProperty('senderTagHideEmail');
    expect(registry.loadBotConfigs()[0].senderTagHideEmail).toBeUndefined();
  });

  it('defaults Codex capacity recovery off and round-trips its explicit opt-in', async () => {
    const { registry, store } = await loaded({ cliId: 'codex' });
    expect(registry.getBot('app_default').config.codexCapacityRecovery).not.toBe(true);
    const spec = store.findConfigField('codexCapacityRecovery')!;
    expect(spec).toMatchObject({ kind: 'boolean', effect: 'immediate', clearable: true });
    expect(store.coerceConfigValue(spec, 'on')).toEqual({ ok: true, value: true });
    expect(store.coerceConfigValue(spec, 'off')).toEqual({ ok: true, value: false });
    expect(store.coerceConfigValue(spec, 'sometimes').ok).toBe(false);
    expect((await store.applyConfigField('app_default', spec, true)).ok).toBe(true);
    expect(readConfig().codexCapacityRecovery).toBe(true);
    expect(registry.getBot('app_default').config.codexCapacityRecovery).toBe(true);
    expect(registry.loadBotConfigs()[0].codexCapacityRecovery).toBe(true);
    expect((await store.applyConfigField('app_default', spec, false)).ok).toBe(true);
    expect(registry.getBot('app_default').config.codexCapacityRecovery).not.toBe(true);
    expect(registry.loadBotConfigs()[0].codexCapacityRecovery).not.toBe(true);
    expect((await store.applyConfigField('app_default', spec, null)).ok).toBe(true);
    expect(readConfig().codexCapacityRecovery).toBeUndefined();
    expect(registry.getBot('app_default').config.codexCapacityRecovery).toBeUndefined();
  });

  it('defaults the delivered-final failure-notice opt-in off and round-trips only an explicit true', async () => {
    const { registry, store } = await loaded({ cliId: 'codex' });
    expect(registry.getBot('app_default').config.suppressDeliveredFinalFailureNotice).toBeUndefined();
    const spec = store.findConfigField('suppressDeliveredFinalFailureNotice')!;
    expect(spec).toMatchObject({ kind: 'boolean', effect: 'next-session', clearable: true });
    expect(spec.defaultOn).toBeUndefined();
    expect(spec.hint).toContain('实验性');
    expect(spec.hint).toContain('默认 off');
    expect(store.coerceConfigValue(spec, 'on')).toEqual({ ok: true, value: true });
    expect(store.coerceConfigValue(spec, 'off')).toEqual({ ok: true, value: false });
    expect((await store.applyConfigField('app_default', spec, true)).ok).toBe(true);
    expect(readConfig().suppressDeliveredFinalFailureNotice).toBe(true);
    expect(registry.getBot('app_default').config.suppressDeliveredFinalFailureNotice).toBe(true);
    expect(registry.loadBotConfigs()[0].suppressDeliveredFinalFailureNotice).toBe(true);
    expect((await store.applyConfigField('app_default', spec, false)).ok).toBe(true);
    expect(readConfig()).not.toHaveProperty('suppressDeliveredFinalFailureNotice');
    expect(registry.getBot('app_default').config.suppressDeliveredFinalFailureNotice).toBeUndefined();
    expect((await store.applyConfigField('app_default', spec, null)).ok).toBe(true);
    expect(readConfig()).not.toHaveProperty('suppressDeliveredFinalFailureNotice');
  });

  it.each(['true', 1, 'on'])('does not enable the delivered-final opt-in from a non-boolean bots.json value (%s)', async raw => {
    const { registry } = await loaded({ cliId: 'codex', suppressDeliveredFinalFailureNotice: raw });
    expect(registry.getBot('app_default').config.suppressDeliveredFinalFailureNotice).toBeUndefined();
  });

  it('normalizes noProgressNotify JSON and rejects out-of-range or unknown fields', async () => {
    const { store } = await loaded();
    const spec = store.findConfigField('noProgressNotify')!;
    expect(spec).toMatchObject({ kind: 'json', effect: 'immediate', clearable: true });
    expect(store.coerceConfigValue(spec, '{}')).toEqual({ ok: true, value: { enabled: true } });
    expect(store.coerceConfigValue(spec, '{"enabled":false}')).toEqual({ ok: true, value: { enabled: false } });
    expect(store.coerceConfigValue(spec, '{"timeoutMs":300000}')).toEqual({ ok: true, value: { enabled: true, timeoutMs: 300000 } });
    expect(store.coerceConfigValue(spec, '{"enabled":false,"timeoutMs":300000}')).toEqual({ ok: true, value: { enabled: false, timeoutMs: 300000 } });
    expect(store.coerceConfigValue(spec, '{"timeoutMs":5000}').ok).toBe(false);
    expect(store.coerceConfigValue(spec, '{"timeoutMs":3600001}').ok).toBe(false);
    expect(store.coerceConfigValue(spec, '{"timeoutMs":90.5}').ok).toBe(false);
    expect(store.coerceConfigValue(spec, '{"enabled":"yes"}').ok).toBe(false);
    expect(store.coerceConfigValue(spec, '{"unknown":1}').ok).toBe(false);
  });

  it('persists, cold-loads and clears noProgressNotify through the shared field', async () => {
    // bots.json hand-edit path: registry load normalizes the raw entry.
    const { registry, store } = await loaded({ noProgressNotify: { timeoutMs: 300000 } });
    expect(registry.getBot('app_default').config.noProgressNotify).toEqual({ enabled: true, timeoutMs: 300000 });

    // /config set path: mute lands in the registry + on disk in one round-trip.
    const spec = store.findConfigField('noProgressNotify')!;
    const applied = await store.applyConfigField('app_default', spec, { enabled: false, timeoutMs: 300000 });
    expect(applied).toMatchObject({ ok: true, effect: 'immediate' });
    expect(registry.getBot('app_default').config.noProgressNotify).toEqual({ enabled: false, timeoutMs: 300000 });
    expect(readConfig().noProgressNotify).toEqual({ enabled: false, timeoutMs: 300000 });

    // Cold reload keeps the value (hand-edited bots.json with same content).
    const cold = await freshModules();
    cold.registry.loadBotConfigs().forEach((c: any) => cold.registry.registerBot(c));
    expect(cold.registry.getBot('app_default').config.noProgressNotify).toEqual({ enabled: false, timeoutMs: 300000 });

    // unset clears back to the built-in default (enabled, 90s).
    const cleared = await store.applyConfigField('app_default', spec, null);
    expect(cleared).toMatchObject({ ok: true });
    expect(registry.getBot('app_default').config.noProgressNotify).toBeUndefined();
    expect(readConfig().noProgressNotify).toBeUndefined();
  });

  it('validates, persists, cold-loads and clears opt-in /g defaults', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('groupCreation')!;
    const value = { agents: ['cli_review_app'], tag: 'Work', avatar: 'name' };
    const parsed = store.coerceConfigValue(spec, JSON.stringify(value));
    expect(parsed).toEqual({ ok: true, value });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(await store.applyConfigField('app_default', spec, parsed.value)).toMatchObject({ ok: true });
    expect(readConfig().groupCreation).toEqual(value);
    expect(registry.loadBotConfigs()[0].groupCreation).toEqual(value);
    expect(registry.getBot('app_default').config.groupCreation).toEqual(value);
    expect(store.coerceConfigValue(spec, '{"agents":"bad"}').ok).toBe(false);
    await store.applyConfigField('app_default', spec, null);
    expect(readConfig().groupCreation).toBeUndefined();
  });

  it('persists Oncall button settings without changing feedback or chat overrides', async () => {
    const original = { feedback: { enabled: true, allowReselect: true }, chatFeedbackPolicies: { oc_a: { enabled: false } } };
    const { registry, store } = await loaded(original);
    const spec = store.findConfigField('oncallGroup')!;
    const parsed = store.coerceConfigValue(spec, JSON.stringify({ enabled: true, chatIds: ['oc_a'] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(await store.applyConfigField('app_default', spec, parsed.value)).toMatchObject({ ok: true });
    expect(readConfig()).toMatchObject(original);
    expect(readConfig().oncallGroup).toEqual({ enabled: true, chatIds: ['oc_a'] });
    expect(registry.loadBotConfigs()[0].oncallGroup).toEqual({ enabled: true, chatIds: ['oc_a'] });
    expect(registry.getBot('app_default').config.oncallGroup).toEqual({ enabled: true, chatIds: ['oc_a'] });
    expect(store.coerceConfigValue(spec, '{"enabled":"yes"}').ok).toBe(false);
    await store.applyConfigField('app_default', spec, null);
    expect(readConfig().oncallGroup).toBeUndefined();
    expect(readConfig()).toMatchObject(original);
  });

  it('persists bot and per-chat feedback layers and updates the live registry', async () => {
    const { registry, store } = await loaded();
    expect(await store.setBotFeedbackPolicy('app_default', { enabled: true, allowReselect: true })).toMatchObject({ ok: true });
    expect(readConfig().feedback).toMatchObject({ enabled: true, allowReselect: true });
    expect(registry.getBot('app_default').config.feedback).toMatchObject({ enabled: true, allowReselect: true });

    expect(await store.setChatFeedbackPolicy('app_default', 'oc_chat', { enabled: false })).toMatchObject({ ok: true });
    expect(readConfig().chatFeedbackPolicies.oc_chat).toEqual({ enabled: false });
    expect(registry.getBot('app_default').config.chatFeedbackPolicies?.oc_chat).toEqual({ enabled: false });

    expect(await store.setChatFeedbackPolicy('app_default', 'oc_chat', null)).toMatchObject({ ok: true });
    expect(readConfig().chatFeedbackPolicies).toBeUndefined();
    expect(registry.getBot('app_default').config.chatFeedbackPolicies).toBeUndefined();
  });

  it('rejects invalid feedback layers without changing disk or live memory', async () => {
    const { registry, store } = await loaded({ feedback: { enabled: true } });
    const beforeDisk = readConfig();
    const beforeMemory = structuredClone(registry.getBot('app_default').config);
    expect(await store.setChatFeedbackPolicy('app_default', 'oc_chat', { buttons: {} } as any)).toMatchObject({ ok: false, reason: 'invalid_policy' });
    expect(readConfig()).toEqual(beforeDisk);
    expect(registry.getBot('app_default').config).toEqual(beforeMemory);
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
    expect(store.findConfigField('hiddenstreamingcardbuttons')?.configKey).toBe('hiddenStreamingCardButtons');
    expect(store.findConfigField('PINSTREAMINGCARD')?.configKey).toBe('pinStreamingCard');
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

  it('parses codexAppCleanInput strictly and defaults it off', async () => {
    const { registry } = await freshModules();
    const [on, off, invalid, missing] = registry.parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'clean-on', larkAppSecret: 's', cliId: 'codex-app', codexAppCleanInput: true },
      { larkAppId: 'clean-off', larkAppSecret: 's', cliId: 'codex-app', codexAppCleanInput: false },
      { larkAppId: 'clean-invalid', larkAppSecret: 's', cliId: 'codex-app', codexAppCleanInput: 'true' },
      { larkAppId: 'clean-missing', larkAppSecret: 's', cliId: 'codex-app' },
    ]));
    expect(on.codexAppCleanInput).toBe(true);
    expect(off.codexAppCleanInput).toBeUndefined();
    expect(invalid.codexAppCleanInput).toBeUndefined();
    expect(missing.codexAppCleanInput).toBeUndefined();
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
      topicGroups: true,
      topicActiveSessionTrigger: true,
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
      topicGroups: true,
      topicActiveSessionTrigger: true,
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

  it('merges dashboard env saves inside the file lock so concurrent merge/remove keep both changes', async () => {
    const { registry, store } = await loaded({ env: { A: '1' } });
    // Both requests start from the same stale snapshot {A}; computing the merge
    // outside the lock would let the remove drop B (or the add resurrect A).
    const [r1, r2] = await Promise.all([
      store.applyPerBotEnvChange('app_default', { incoming: {}, mode: 'merge', remove: ['A'] }),
      store.applyPerBotEnvChange('app_default', { incoming: { B: '2' }, mode: 'merge' }),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    expect(readConfig().env).toEqual({ B: '2' });
    expect(registry.getBot('app_default').config.env).toEqual({ B: '2' });

    const r3 = await store.applyPerBotEnvChange('app_default', { incoming: {}, mode: 'replace' });
    expect(r3).toEqual({ ok: true, envKeys: [] });
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
    // Same rule for dotenv input — CLAUDE_CONFIG_DIR from a launcher script is refused.
    expect(store.coerceConfigValue(spec, 'CLAUDE_CONFIG_DIR=/x\nANTHROPIC_MODEL=m')).toEqual({ ok: false, reason: 'reserved_env' });
  });

  it('accepts dotenv / settings-snippet env text and normalizes to the same map as JSON', async () => {
    const { store } = await loaded();
    const spec = store.findConfigField('env')!;
    const want = { ok: true, value: { ANTHROPIC_BASE_URL: 'http://gw:8080', ANTHROPIC_MODEL: 'claude-opus-5-5' } };
    expect(store.coerceConfigValue(spec, 'ANTHROPIC_BASE_URL=http://gw:8080\nexport ANTHROPIC_MODEL="claude-opus-5-5"')).toEqual(want);
    expect(store.coerceConfigValue(spec, '{"env":{"ANTHROPIC_BASE_URL":"http://gw:8080","ANTHROPIC_MODEL":"claude-opus-5-5"}}')).toEqual(want);
    expect(store.coerceConfigValue(spec, 'A="unterminated')).toEqual({ ok: false, reason: 'invalid_env' });
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

    const timing = store.findConfigField('showReplyTiming')!;
    await store.applyConfigField('app_default', timing, true);
    expect(registry.getBot('app_default').config.showReplyTiming).toBe(true);
    expect(registry.loadBotConfigs()[0].showReplyTiming).toBe(true);
    await store.applyConfigField('app_default', timing, false);
    expect(readConfig().showReplyTiming).toBeUndefined();
  });

  it('larkToolBinding is a next-session clearable boolean with defaultOn, aliases bindlarkapp / larkappbinding, and cleans bots.json when true', async () => {
    const { registry, store } = await loaded();
    expect(store.findConfigField('larkToolBinding')?.configKey).toBe('larkToolBinding');
    expect(store.findConfigField('bindLarkApp')?.configKey).toBe('larkToolBinding');
    expect(store.findConfigField('larkAppBinding')?.configKey).toBe('larkToolBinding');

    const spec = store.findConfigField('larkToolBinding')!;
    expect(spec.effect).toBe('next-session');
    expect(spec.clearable).toBe(true);
    expect(spec.defaultOn).toBe(true);

    // Initial state: undefined (renders 'on' because defaultOn: true)
    expect(registry.getBot('app_default').config.larkToolBinding).toBeUndefined();
    expect(readConfig().larkToolBinding).toBeUndefined();

    // Disable (false) -> writes false on disk and in memory
    const r1 = await store.applyConfigField('app_default', spec, false);
    expect(r1.ok).toBe(true);
    if (r1.ok) { expect(r1.oldText).toBe('on'); expect(r1.newText).toBe('off'); }
    expect(readConfig().larkToolBinding).toBe(false);
    expect(registry.getBot('app_default').config.larkToolBinding).toBe(false);

    // Enable (true) -> deletes key (back to default), in-memory undefined (= on)
    const r2 = await store.applyConfigField('app_default', spec, true);
    expect(r2.ok).toBe(true);
    if (r2.ok) { expect(r2.oldText).toBe('off'); expect(r2.newText).toBe('on'); }
    expect(readConfig().larkToolBinding).toBeUndefined();
    expect(registry.getBot('app_default').config.larkToolBinding).toBeUndefined();

    // Unset (null) from an explicit-false state also restores the default
    await store.applyConfigField('app_default', spec, false);
    expect(readConfig().larkToolBinding).toBe(false);
    const r3 = await store.applyConfigField('app_default', spec, null);
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.newText).toBe('on');
    expect(readConfig().larkToolBinding).toBeUndefined();
    expect(registry.getBot('app_default').config.larkToolBinding).toBeUndefined();
  });

  it('sets and unsets hidden streaming-card buttons through /botconfig', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('hiddenStreamingCardButtons')!;
    const parsed = store.coerceConfigValue(spec, 'close terminal close');
    expect(parsed).toEqual({ ok: true, value: ['terminal', 'close'] });
    expect(store.coerceConfigValue(spec, 'terminal unknown')).toEqual({ ok: false, reason: 'empty' });
    if (!parsed.ok) return;

    const set = await store.applyConfigField('app_default', spec, parsed.value);
    expect(set.ok).toBe(true);
    expect(readConfig().hiddenStreamingCardButtons).toEqual(['terminal', 'close']);
    expect(registry.getBot('app_default').config.hiddenStreamingCardButtons)
      .toEqual(['terminal', 'close']);

    const unset = await store.applyConfigField('app_default', spec, null);
    expect(unset.ok).toBe(true);
    expect(readConfig().hiddenStreamingCardButtons).toBeUndefined();
    expect(registry.getBot('app_default').config.hiddenStreamingCardButtons).toBeUndefined();
  });

  it('defaultOn boolean (cotEnabled): inverted persistence — only explicit false is written', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('cotEnabled')!;
    expect(spec.defaultOn).toBe(true);

    // off → explicit false on disk and in memory. oldText 'on' proves the
    // untouched (absent) value renders as on — the default-ON display path.
    const r1 = await store.applyConfigField('app_default', spec, false);
    expect(r1.ok).toBe(true);
    if (r1.ok) { expect(r1.oldText).toBe('on'); expect(r1.newText).toBe('off'); }
    expect(readConfig().cotEnabled).toBe(false);
    expect(registry.getBot('app_default').config.cotEnabled).toBe(false);

    // on → key deleted (back to default), in-memory undefined (= on).
    const r2 = await store.applyConfigField('app_default', spec, true);
    expect(r2.ok).toBe(true);
    if (r2.ok) { expect(r2.oldText).toBe('off'); expect(r2.newText).toBe('on'); }
    expect(readConfig().cotEnabled).toBeUndefined();
    expect(registry.getBot('app_default').config.cotEnabled).toBeUndefined();

    // unset (null) from an explicit-false state also restores the default.
    await store.applyConfigField('app_default', spec, false);
    const r3 = await store.applyConfigField('app_default', spec, null);
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.newText).toBe('on');
    expect(readConfig().cotEnabled).toBeUndefined();
  });

  it('usageDisplay is an immediate three-state enum persisted verbatim, cleared via unset', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('usageDisplay')!;
    expect(spec.effect).toBe('immediate');
    expect(spec.kind).toBe('enum');
    expect(spec.clearable).toBe(true);
    expect(spec.enumValues).toEqual(['streaming', 'footer', 'off']);

    // coerce validates the enum (case-insensitive) and rejects nonsense.
    expect(store.coerceConfigValue(spec, 'footer')).toEqual({ ok: true, value: 'footer' });
    expect(store.coerceConfigValue(spec, 'nonsense')).toEqual({ ok: false, reason: 'invalid_enum' });

    const toFooter = await store.applyConfigField('app_default', spec, 'footer');
    expect(toFooter).toMatchObject({ ok: true, newText: 'footer', effect: 'immediate' });
    expect(readConfig().usageDisplay).toBe('footer');
    expect(registry.getBot('app_default').config.usageDisplay).toBe('footer');

    const toOff = await store.applyConfigField('app_default', spec, 'off');
    expect(toOff).toMatchObject({ ok: true, newText: 'off' });
    expect(readConfig().usageDisplay).toBe('off');

    // Clearing (unset) drops the key → back to the default 'streaming'.
    await store.applyConfigField('app_default', spec, null);
    expect(readConfig().usageDisplay).toBeUndefined();
    expect(registry.getBot('app_default').config.usageDisplay).toBeUndefined();
  });

  it('offers only default and unified reply modes and preserves the retired status-card opt-out on writes', async () => {
    const { registry, store } = await loaded({ replyCardMode: 'final-only' });
    const spec = store.findConfigField('replyCardMode')!;
    expect(spec.enumValues).toEqual(['legacy', 'unified']);
    expect(store.coerceConfigValue(spec, 'final-only')).toEqual({ ok: false, reason: 'invalid_enum' });
    expect(registry.getBot('app_default').config).toMatchObject({ replyCardMode: 'unified', disableStreamingCard: true });
    expect((await store.applyConfigField('app_default', spec, 'unified')).ok).toBe(true);
    expect(readConfig()).toMatchObject({ replyCardMode: 'unified', disableStreamingCard: true });
    const offSwitch = store.findConfigField('disableStreamingCard')!;
    expect((await store.applyConfigField('app_default', offSwitch, false)).ok).toBe(true);
    expect(registry.getBot('app_default').config.disableStreamingCard).toBeUndefined();
    expect(registry.loadBotConfigs()[0].disableStreamingCard).toBeUndefined();
  });

  it('codexAppCleanInput is immediate, default-off, and deletes its key when disabled', async () => {
    const { registry, store } = await loaded({ cliId: 'codex-app' });
    const spec = store.findConfigField('codexAppCleanInput')!;
    expect(spec.effect).toBe('immediate');
    expect(registry.getBot('app_default').config.codexAppCleanInput).toBeUndefined();

    const enabled = await store.applyConfigField('app_default', spec, true);
    expect(enabled).toMatchObject({ ok: true, oldText: 'off', newText: 'on', effect: 'immediate' });
    expect(readConfig().codexAppCleanInput).toBe(true);
    expect(registry.getBot('app_default').config.codexAppCleanInput).toBe(true);

    await store.applyConfigField('app_default', spec, false);
    expect(readConfig().codexAppCleanInput).toBeUndefined();
    expect(registry.getBot('app_default').config.codexAppCleanInput).toBeUndefined();
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

  it('pinStreamingCard is an immediate default-off boolean', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('PINSTREAMINGCARD')!;
    expect(spec).toMatchObject({
      configKey: 'pinStreamingCard',
      kind: 'boolean',
      effect: 'immediate',
      clearable: false,
    });

    const on = await store.applyConfigField('app_default', spec, true);
    expect(on).toMatchObject({ ok: true, oldText: 'off', newText: 'on' });
    expect(readConfig().pinStreamingCard).toBe(true);
    expect(registry.getBot('app_default').config.pinStreamingCard).toBe(true);

    const off = await store.applyConfigField('app_default', spec, false);
    expect(off).toMatchObject({ ok: true, oldText: 'on', newText: 'off' });
    expect(readConfig().pinStreamingCard).toBeUndefined();
    expect(registry.getBot('app_default').config.pinStreamingCard).toBeUndefined();
  });

  it('notifies pinStreamingCard changes only after disk and live memory are synchronized', async () => {
    const { registry, store, pinStreamingCardChange } = await loaded();
    const spec = store.findConfigField('PINSTREAMINGCARD')!;
    const observed: Array<{ enabled: boolean; disk: unknown; memory: unknown }> = [];
    const dispose = pinStreamingCardChange.registerPinStreamingCardChangeHandler((appId, enabled) => {
      observed.push({
        enabled,
        disk: readConfig().pinStreamingCard,
        memory: registry.getBot(appId).config.pinStreamingCard,
      });
    });

    try {
      const on = await store.applyConfigField('app_default', spec, true);
      expect(on.ok).toBe(true);

      const off = await store.applyConfigField('app_default', spec, false);
      expect(off.ok).toBe(true);
    } finally {
      dispose();
    }

    expect(observed).toEqual([
      { enabled: true, disk: true, memory: true },
      { enabled: false, disk: undefined, memory: undefined },
    ]);
  });

  it('does not notify pinStreamingCard no-op writes when the effective boolean is unchanged', async () => {
    const { registry, store, pinStreamingCardChange } = await loaded();
    const spec = store.findConfigField('PINSTREAMINGCARD')!;
    const observed: Array<{ enabled: boolean; disk: unknown; memory: unknown }> = [];
    const dispose = pinStreamingCardChange.registerPinStreamingCardChangeHandler((appId, enabled) => {
      observed.push({
        enabled,
        disk: readConfig().pinStreamingCard,
        memory: registry.getBot(appId).config.pinStreamingCard,
      });
    });

    try {
      const offNoop = await store.applyConfigField('app_default', spec, false);
      expect(offNoop.ok).toBe(true);

      const on = await store.applyConfigField('app_default', spec, true);
      expect(on.ok).toBe(true);

      const onNoop = await store.applyConfigField('app_default', spec, true);
      expect(onNoop.ok).toBe(true);

      const off = await store.applyConfigField('app_default', spec, false);
      expect(off.ok).toBe(true);

      const offNoopAgain = await store.applyConfigField('app_default', spec, false);
      expect(offNoopAgain.ok).toBe(true);
    } finally {
      dispose();
    }

    expect(observed).toEqual([
      { enabled: true, disk: true, memory: true },
      { enabled: false, disk: undefined, memory: undefined },
    ]);
  });

  it('does not notify pinStreamingCard changes when the write fails', async () => {
    const { store, pinStreamingCardChange } = await loaded();
    const spec = store.findConfigField('PINSTREAMINGCARD')!;
    const seen = vi.fn();
    const dispose = pinStreamingCardChange.registerPinStreamingCardChangeHandler(seen);

    try {
      const result = await store.applyConfigField('app_missing', spec, true);
      expect(result).toMatchObject({ ok: false, reason: 'bot_not_registered' });
    } finally {
      dispose();
    }

    expect(seen).not.toHaveBeenCalled();
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

  it('idleSuspendMinutes is an immediate clearable number field that round-trips', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('idleSuspendMinutes')!;
    expect(spec).toMatchObject({ kind: 'number', effect: 'immediate', clearable: true });

    // Coerce layer: positive integers only (0/negative/fraction/garbage rejected).
    expect(store.coerceConfigValue(spec, 30)).toEqual({ ok: true, value: 30 });
    expect(store.coerceConfigValue(spec, '45')).toEqual({ ok: true, value: 45 });
    expect(store.coerceConfigValue(spec, 0)).toEqual({ ok: false, reason: 'invalid_number' });
    expect(store.coerceConfigValue(spec, -1)).toEqual({ ok: false, reason: 'invalid_number' });
    expect(store.coerceConfigValue(spec, 1.5)).toEqual({ ok: false, reason: 'invalid_number' });
    expect(store.coerceConfigValue(spec, 'abc')).toEqual({ ok: false, reason: 'invalid_number' });

    const set = await store.applyConfigField('app_default', spec, 20);
    expect(set).toMatchObject({ ok: true, effect: 'immediate' });
    expect(readConfig().idleSuspendMinutes).toBe(20);
    expect(registry.getBot('app_default').config.idleSuspendMinutes).toBe(20);

    const clear = await store.applyConfigField('app_default', spec, null);
    expect(clear.ok).toBe(true);
    expect(readConfig().idleSuspendMinutes).toBeUndefined();
    expect(registry.getBot('app_default').config.idleSuspendMinutes).toBeUndefined();
  });

  it('cardActionAckTimeoutMs enforces its range and hot-updates the registered Bot', async () => {
    const { registry, store } = await loaded();
    const spec = store.findConfigField('cardActionAckTimeoutMs')!;
    expect(spec).toMatchObject({
      kind: 'number',
      effect: 'immediate',
      clearable: true,
      min: 500,
      max: 2_500,
    });
    expect(store.coerceConfigValue(spec, 500)).toEqual({ ok: true, value: 500 });
    expect(store.coerceConfigValue(spec, '2500')).toEqual({ ok: true, value: 2_500 });
    expect(store.coerceConfigValue(spec, 499)).toEqual({ ok: false, reason: 'invalid_number' });
    expect(store.coerceConfigValue(spec, 2_501)).toEqual({ ok: false, reason: 'invalid_number' });
    expect(store.coerceConfigValue(spec, 1_000.5)).toEqual({ ok: false, reason: 'invalid_number' });

    const set = await store.applyConfigField('app_default', spec, 1_200);
    expect(set).toMatchObject({ ok: true, oldText: '∅', newText: '1200', effect: 'immediate' });
    expect(readConfig().cardActionAckTimeoutMs).toBe(1_200);
    expect(registry.getBot('app_default').config.cardActionAckTimeoutMs).toBe(1_200);

    const unset = await store.applyConfigField('app_default', spec, null);
    expect(unset.ok).toBe(true);
    expect(readConfig().cardActionAckTimeoutMs).toBeUndefined();
    expect(registry.getBot('app_default').config.cardActionAckTimeoutMs).toBeUndefined();
  });

  it('session owner reminder config round-trips and hot-updates the registered Bot', async () => {
    const { registry } = await loaded();
    const reminderStore = await import('../src/services/session-owner-reminder-config-store.js');
    const value = {
      enabled: true,
      intervalMinutes: 30,
      text: '请继续处理。',
      states: ['idle', 'tui_prompt'],
    };
    const saved = await reminderStore.updateSessionOwnerReminderConfig('app_default', value);
    expect(saved).toEqual({ ok: true, config: value });
    expect(readConfig().sessionOwnerReminder).toEqual(value);
    expect(registry.getBot('app_default').config.sessionOwnerReminder).toEqual(value);

    expect(await reminderStore.updateSessionOwnerReminderConfig('app_default', {
      ...value,
      text: '<at user_id="ou_other"></at>',
    })).toEqual({ ok: false, reason: 'invalid_session_owner_reminder' });
    expect(readConfig().sessionOwnerReminder).toEqual(value);
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
    expect(readConfig().cliLaunchMode).toBeUndefined();
    expect(readConfig().wrapperCli).toBeUndefined();
    expect(registry.getBot('app_default').config.cliId).toBe('codex');
    expect(registry.getBot('app_default').config.cliLaunchMode).toBeUndefined();
    expect(registry.getBot('app_default').config.wrapperCli).toBeUndefined();
  });

  it('cli field sets and clears Forge x TraeX launch mode atomically', async () => {
    const { registry, store } = await loaded({ cliId: 'traex', reasoningEffort: 'medium' });
    const spec = store.findConfigField('cli')!;
    expect(store.coerceConfigValue(spec, 'forge-x-traex')).toMatchObject({
      ok: true,
      value: { cliId: 'traex', cliLaunchMode: 'forge-traex' },
    });

    const setForge = await store.applyConfigField('app_default', spec, 'forge-x-traex');
    expect(setForge.ok).toBe(true);
    expect(readConfig()).toMatchObject({ cliId: 'traex', cliLaunchMode: 'forge-traex' });
    expect(readConfig().reasoningEffort).toBe('medium');
    expect(registry.getBot('app_default').config.cliLaunchMode).toBe('forge-traex');
    expect(registry.getBot('app_default').config.reasoningEffort).toBe('medium');
    const forgeSnapshot = store.getConfigSnapshot('app_default');
    expect(forgeSnapshot.ok && forgeSnapshot.rows.find(r => r.key === 'cli')?.value).toBe('forge-x-traex');

    const setPlain = await store.applyConfigField('app_default', spec, 'traex');
    expect(setPlain.ok).toBe(true);
    expect(readConfig().cliId).toBe('traex');
    expect(readConfig().cliLaunchMode).toBeUndefined();
    expect(readConfig().reasoningEffort).toBe('medium');
    expect(registry.getBot('app_default').config.cliLaunchMode).toBeUndefined();
    expect(registry.getBot('app_default').config.reasoningEffort).toBe('medium');
  });

  it('cli field rejects Forge x TraeX when existing security isolation would make it invalid', async () => {
    const { store } = await loaded({ cliId: 'traex', readIsolation: true });
    const spec = store.findConfigField('cli')!;
    const result = await store.applyConfigField('app_default', spec, 'forge-x-traex');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('cannot be combined with sandbox or readIsolation');
    expect(readConfig()).toMatchObject({ cliId: 'traex', readIsolation: true });
    expect(readConfig().cliLaunchMode).toBeUndefined();
  });

  it('reasoningEffort is a next-session enum field', async () => {
    const { registry, store } = await loaded({ cliId: 'traex', model: 'DeepSeek-V4-Pro' });
    const spec = store.findConfigField('reasoningEffort')!;
    expect(spec.kind).toBe('enum');
    expect(spec.effect).toBe('next-session');
    expect(store.coerceConfigValue(spec, 'MEDIUM')).toEqual({ ok: true, value: 'medium' });
    expect(store.coerceConfigValue(spec, 'extreme')).toEqual({ ok: false, reason: 'invalid_enum' });

    const r1 = await store.applyConfigField('app_default', spec, 'medium');
    expect(r1.ok).toBe(true);
    expect(readConfig().reasoningEffort).toBe('medium');
    expect(registry.getBot('app_default').config.reasoningEffort).toBe('medium');

    const r2 = await store.applyConfigField('app_default', spec, null);
    expect(r2.ok).toBe(true);
    expect(readConfig().reasoningEffort).toBeUndefined();
    expect(registry.getBot('app_default').config.reasoningEffort).toBeUndefined();
  });

  it('allows TraeX common reasoning effort when model is unset', async () => {
    const { registry, store } = await loaded({ cliId: 'traex' });
    const spec = store.findConfigField('reasoningEffort')!;
    const r = await store.applyConfigField('app_default', spec, 'medium');
    expect(r.ok).toBe(true);
    expect(readConfig().reasoningEffort).toBe('medium');
    expect(registry.getBot('app_default').config.reasoningEffort).toBe('medium');
  });

  it('rejects reasoningEffort writes for unsupported CLIs and model pairs', async () => {
    const unsupportedCli = await loaded({ cliId: 'gemini' });
    const spec = unsupportedCli.store.findConfigField('reasoningEffort')!;
    const r1 = await unsupportedCli.store.applyConfigField('app_default', spec, 'medium');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('reasoning_effort_not_supported');
    expect(readConfig().reasoningEffort).toBeUndefined();
    expect(unsupportedCli.registry.getBot('app_default').config.reasoningEffort).toBeUndefined();

    const unsupportedPair = await loaded({ cliId: 'traex', model: 'DeepSeek-V4-Pro' });
    const r2 = await unsupportedPair.store.applyConfigField('app_default', spec, 'xhigh');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('reasoning_effort_not_supported_by_model');
    expect(readConfig().reasoningEffort).toBeUndefined();
    expect(unsupportedPair.registry.getBot('app_default').config.reasoningEffort).toBeUndefined();
  });

  it('rejects model writes that would make the stored reasoningEffort invalid', async () => {
    const { registry, store } = await loaded({ cliId: 'traex', model: 'GPT-5.5', reasoningEffort: 'xhigh' });
    const spec = store.findConfigField('model')!;
    const r = await store.applyConfigField('app_default', spec, 'DeepSeek-V4-Pro');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('reasoning_effort_not_supported_by_model');
    expect(readConfig().model).toBe('GPT-5.5');
    expect(readConfig().reasoningEffort).toBe('xhigh');
    expect(registry.getBot('app_default').config.model).toBe('GPT-5.5');
    expect(registry.getBot('app_default').config.reasoningEffort).toBe('xhigh');
  });

  it('serviceTier is a codex-only next-session enum field', async () => {
    const { registry, store } = await loaded({ cliId: 'codex' });
    const spec = store.findConfigField('serviceTier')!;
    expect(spec.kind).toBe('enum');
    expect(spec.effect).toBe('next-session');
    expect(store.coerceConfigValue(spec, 'PRIORITY')).toEqual({ ok: true, value: 'priority' });
    expect(store.coerceConfigValue(spec, 'fast')).toEqual({ ok: false, reason: 'invalid_enum' });

    const explicitDefault = await store.applyConfigField('app_default', spec, 'default');
    expect(explicitDefault.ok).toBe(true);
    expect(readConfig().serviceTier).toBe('default');
    expect(registry.getBot('app_default').config.serviceTier).toBe('default');

    const cleared = await store.applyConfigField('app_default', spec, null);
    expect(cleared.ok).toBe(true);
    expect(readConfig().serviceTier).toBeUndefined();
    expect(registry.getBot('app_default').config.serviceTier).toBeUndefined();
  });

  it('validates accelerated serviceTier against the actual model catalog', async () => {
    const { registry, store } = await loaded({ cliId: 'codex', model: 'gpt-6.1-sol' });
    const spec = store.findConfigField('serviceTier')!;
    vi.mocked(validateCodexServiceTier).mockResolvedValueOnce({ ok: false, error: 'not_supported_by_model' });
    const rejected = await store.applyConfigField('app_default', spec, 'ultrafast');
    expect(rejected).toEqual({ ok: false, reason: 'service_tier_not_supported_by_model' });
    expect(validateCodexServiceTier).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-6.1-sol',
      serviceTier: 'ultrafast',
    }));
    expect(readConfig().serviceTier).toBeUndefined();
    expect(registry.getBot('app_default').config.serviceTier).toBeUndefined();

    const saved = await store.applyConfigField('app_default', spec, 'priority');
    expect(saved.ok).toBe(true);
    expect(readConfig().serviceTier).toBe('priority');
  });

  it('rejects accelerated serviceTier without a model and rechecks when model changes', async () => {
    const { store } = await loaded({ cliId: 'codex', model: 'gpt-6.1-sol', serviceTier: 'priority' });
    const tierSpec = store.findConfigField('serviceTier')!;
    vi.mocked(validateCodexServiceTier).mockResolvedValueOnce({ ok: false, error: 'model_required' });
    const rejected = await store.applyConfigField('app_default', tierSpec, 'priority');
    expect(rejected).toEqual({ ok: false, reason: 'service_tier_model_required' });

    const modelSpec = store.findConfigField('model')!;
    vi.mocked(validateCodexServiceTier).mockResolvedValueOnce({ ok: false, error: 'catalog_unavailable' });
    const changedModel = await store.applyConfigField('app_default', modelSpec, 'gpt-6-astra');
    expect(changedModel).toEqual({ ok: false, reason: 'service_tier_catalog_unavailable' });
  });

  it('rejects serviceTier writes for unsupported CLIs and clears it when switching CLI', async () => {
    const unsupported = await loaded({ cliId: 'gemini' });
    const spec = unsupported.store.findConfigField('serviceTier')!;
    const rejected = await unsupported.store.applyConfigField('app_default', spec, 'priority');
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toBe('service_tier_not_supported');
    expect(readConfig().serviceTier).toBeUndefined();

    const switched = await loaded({ cliId: 'codex', serviceTier: 'ultrafast' });
    const cliSpec = switched.store.findConfigField('cli')!;
    const switchedCli = await switched.store.applyConfigField('app_default', cliSpec, 'claude-code');
    expect(switchedCli.ok).toBe(true);
    expect(readConfig().serviceTier).toBeUndefined();
    expect(switched.registry.getBot('app_default').config.serviceTier).toBeUndefined();
  });

  it('replyDelivery: defaults to send on every CLI; both values persist; unset clears back to that default', async () => {
    const { registry, store } = await loaded({ cliId: 'claude-code' });
    const spec = store.findConfigField('replyDelivery')!;
    expect(spec.kind).toBe('enum');
    expect(spec.effect).toBe('next-session');
    expect(spec.clearable).toBe(true);
    expect(store.coerceConfigValue(spec, 'TRANSCRIPT')).toEqual({ ok: true, value: 'transcript' });
    expect(store.coerceConfigValue(spec, 'send')).toEqual({ ok: true, value: 'send' });
    expect(store.coerceConfigValue(spec, 'auto')).toEqual({ ok: false, reason: 'invalid_enum' });

    // 缺省展示是 send（而非 ∅），claude-code 也不例外——transcript 不随 CLI 自动翻转。
    const before = store.getConfigSnapshot('app_default');
    expect(before.ok && before.rows.find(r => r.key === 'replyDelivery')?.value).toBe('send');
    expect('replyDelivery' in readConfig()).toBe(false);
    expect(registry.resolveReplyDelivery('app_default')).toBeUndefined();

    // set transcript：opt-in，显式落盘。
    const r1 = await store.applyConfigField('app_default', spec, 'transcript');
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1).toMatchObject({ oldText: 'send', newText: 'transcript', effect: 'next-session' });
    expect(readConfig().replyDelivery).toBe('transcript');
    expect(registry.getBot('app_default').config.replyDelivery).toBe('transcript');
    expect(registry.resolveReplyDelivery('app_default')).toBe('transcript');

    // set send：显式退回也落盘（与缺省同值，但意图是「钉住」，不靠缺省兜）。
    const r2 = await store.applyConfigField('app_default', spec, 'send');
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2).toMatchObject({ oldText: 'transcript', newText: 'send' });
    expect(readConfig().replyDelivery).toBe('send');
    expect(registry.getBot('app_default').config.replyDelivery).toBe('send');
    expect(registry.resolveReplyDelivery('app_default')).toBe('send');

    // unset：删 key，回缺省 send，内存同步为 undefined。
    const r3 = await store.applyConfigField('app_default', spec, null);
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3).toMatchObject({ oldText: 'send', newText: 'send' });
    expect('replyDelivery' in readConfig()).toBe(false);
    expect(registry.getBot('app_default').config.replyDelivery).toBeUndefined();
    expect(registry.resolveReplyDelivery('app_default')).toBeUndefined();
  });

  it('replyDelivery: an explicit "send" in bots.json survives loadBotConfigs (claude-code opts back out)', async () => {
    const { registry, store } = await loaded({ cliId: 'claude-code', replyDelivery: 'send' });
    expect(registry.getBot('app_default').config.replyDelivery).toBe('send');
    expect(registry.resolveReplyDelivery('app_default')).toBe('send');
    const snap = store.getConfigSnapshot('app_default');
    expect(snap.ok && snap.rows.find(r => r.key === 'replyDelivery')?.value).toBe('send');
  });

  it('replyDelivery: non-claude CLIs default to send; transcript persists on structured-bridge CLIs (codex) and unset clears', async () => {
    const { registry, store } = await loaded({ cliId: 'codex' });
    const spec = store.findConfigField('replyDelivery')!;
    const before = store.getConfigSnapshot('app_default');
    expect(before.ok && before.rows.find(r => r.key === 'replyDelivery')?.value).toBe('send');
    expect(registry.resolveReplyDelivery('app_default')).toBeUndefined();

    const r1 = await store.applyConfigField('app_default', spec, 'transcript');
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1).toMatchObject({ oldText: 'send', newText: 'transcript' });
    expect(readConfig().replyDelivery).toBe('transcript');
    expect(registry.getBot('app_default').config.replyDelivery).toBe('transcript');
    expect(registry.resolveReplyDelivery('app_default')).toBe('transcript');

    const r2 = await store.applyConfigField('app_default', spec, null);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2).toMatchObject({ oldText: 'transcript', newText: 'send' });
    expect('replyDelivery' in readConfig()).toBe(false);
    expect(registry.getBot('app_default').config.replyDelivery).toBeUndefined();
  });

  it('rejects replyDelivery=transcript for CLIs without transcript capture', async () => {
    // antigravity has only zero-prompt transcript harvest and is still
    // unsupported for ordinary transcript delivery; cursor used to be the
    // exemplar here but gained the capability in #932.
    const { registry, store } = await loaded({ cliId: 'antigravity' });
    const spec = store.findConfigField('replyDelivery')!;
    const before = store.getConfigSnapshot('app_default');
    expect(before.ok && before.rows.find(r => r.key === 'replyDelivery')?.value).toBe('send');
    const r = await store.applyConfigField('app_default', spec, 'transcript');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('reply_delivery_unsupported');
    expect('replyDelivery' in readConfig()).toBe(false);
    expect(registry.getBot('app_default').config.replyDelivery).toBeUndefined();

    // send 在不支持的 CLI 上照样允许，且同样显式落盘。
    const r2 = await store.applyConfigField('app_default', spec, 'send');
    expect(r2.ok).toBe(true);
    expect(readConfig().replyDelivery).toBe('send');
    expect(registry.resolveReplyDelivery('app_default')).toBe('send');
  });

  it('accepts replyDelivery=transcript for cursor (always-on structured fallback since #932)', async () => {
    const { registry, store } = await loaded({ cliId: 'cursor' });
    const spec = store.findConfigField('replyDelivery')!;
    const r = await store.applyConfigField('app_default', spec, 'transcript');
    expect(r.ok).toBe(true);
    expect(readConfig().replyDelivery).toBe('transcript');
    expect(registry.resolveReplyDelivery('app_default')).toBe('transcript');
  });

  it('rejects replyDelivery=transcript for cursor under scratch sandbox (host cannot read merged mirror; never a silent fallback)', async () => {
    const { store } = await loaded({ cliId: 'cursor', sandbox: 'scratch' });
    const spec = store.findConfigField('replyDelivery')!;
    const r = await store.applyConfigField('app_default', spec, 'transcript');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('reply_delivery_unsupported');
    expect(readConfig().replyDelivery).toBeUndefined();
  });

  it('still accepts replyDelivery=transcript for an always-on non-cursor CLI (codex) under scratch — its bridge does not read a merged mirror', async () => {
    const { store } = await loaded({ cliId: 'codex', sandbox: 'scratch' });
    const spec = store.findConfigField('replyDelivery')!;
    const r = await store.applyConfigField('app_default', spec, 'transcript');
    expect(r.ok).toBe(true);
    expect(readConfig().replyDelivery).toBe('transcript');
  });

  it('invariant backstop: switching cliId codex→cursor while scratch+transcript persist is rejected (the replyDelivery-only gate misses this edge)', async () => {
    // 复现 pi 复审洞 1：replyDelivery 写入门禁只在 configKey==='replyDelivery' 时跑，
    // 单查那条边会放行进 cursor 的切换，落盘永久无效组合（dashboard 显「已开启」、
    // 运行时静默回落 send）。rmwBotEntry 的全局不变量必须在 cli 切换这条边拦下。
    const { store } = await loaded({ cliId: 'codex', sandbox: 'scratch', replyDelivery: 'transcript' });
    const spec = store.findConfigField('cli')!;
    const r = await store.applyConfigField('app_default', spec, 'cursor');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('reply_delivery_unsupported');
    expect(readConfig()).toMatchObject({ cliId: 'codex', sandbox: 'scratch', replyDelivery: 'transcript' });
  });

  it('repair path: switching the invalid cursor+scratch+transcript entry to a supporting CLI (codex) succeeds', async () => {
    // 不能把坏 entry 锁死：任何一个字段改到合法组合都必须能写，给运维修复出口。
    const { store } = await loaded({ cliId: 'cursor', sandbox: 'scratch', replyDelivery: 'transcript' });
    const spec = store.findConfigField('cli')!;
    const r = await store.applyConfigField('app_default', spec, 'codex');
    expect(r.ok).toBe(true);
    expect(readConfig()).toMatchObject({ cliId: 'codex', sandbox: 'scratch', replyDelivery: 'transcript' });
  });

  it('invariant backstop: updateBotSandboxMode rejects switching a cursor+transcript bot to scratch (rmwBotEntry path, no replyDelivery write)', async () => {
    const { registry } = await loaded({ cliId: 'cursor', replyDelivery: 'transcript' });
    const sandboxStore = await import('../src/services/sandbox-store.js');
    const r = await sandboxStore.updateBotSandboxMode('app_default', 'scratch');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('reply_delivery_unsupported');
    expect(readConfig().sandbox).toBeUndefined();
    // 内存态可能由配置归一化填默认 false（盘上缺省才是契约）；关键是不能落成 scratch。
    expect(registry.getBot('app_default').config.sandbox).not.toBe('scratch');
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
    const { store } = await loaded({ model: 'sonnet', disableStreamingCard: true, pinStreamingCard: true });
    const snap = store.getConfigSnapshot('app_default');
    expect(snap.ok).toBe(true);
    if (snap.ok) {
      expect(snap.info.cliId).toBe('claude-code');
      expect(snap.info.resolvedAdmins).toBe(1);
      const model = snap.rows.find(r => r.key === 'model');
      expect(model?.value).toBe('sonnet');
      const card = snap.rows.find(r => r.key === 'disableStreamingCard');
      expect(card?.value).toBe('on');
      const pin = snap.rows.find(r => r.key === 'pinStreamingCard');
      expect(pin?.value).toBe('on');
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

  // 确定性解析失败（邮箱不存在 / 对本应用不可见）不拒绝写入：条目可能只是临时
  // 不可见，且 self-lockout 防护已保证发起人仍生效。但结果必须把未生效条目带
  // 回给 /botconfig 提示，而不是让它静默消失。
  it('setBotAllowedUsers keeps writing but reports a definitively-missing email in unresolvedEmailsAndMobiles', async () => {
    const { store } = await loaded();
    const r = await store.setBotAllowedUsers(
      'app_default', ['alice@corp.com', 'ghost@corp.com'], 'ou_alice',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.resolved).toEqual(['ou_alice']);
    expect(r.unresolvedEmailsAndMobiles).toEqual(['ghost@corp.com']);
    // 原始条目照常落盘，日后联系人可见时可随重新解析恢复。
    expect(readConfig().allowedUsers).toEqual(['alice@corp.com', 'ghost@corp.com']);
  });

  it('setBotAllowedUsers reports a definitively-missing mobile alongside a resolved one', async () => {
    const { store } = await loaded();
    // 测试桩里非邮箱、非 ou_/on_ 的条目一律按 definitive miss（手机号同样走
    // 真实 resolver 的 batch 缺口径）。
    const r = await store.setBotAllowedUsers(
      'app_default', ['alice@corp.com', '13900000000'], 'ou_alice',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.unresolvedEmailsAndMobiles).toEqual(['13900000000']);
  });

  it('setBotAllowedUsers dedupes repeated definitively-missing entries in the warning list', async () => {
    const { store } = await loaded();
    // 同一条失效邮箱在命令里写两次：原始条目照常落盘（不去重用户输入），
    // 但给 /botconfig 的未生效提示只列一次，与 union_id 告警口径一致。
    const r = await store.setBotAllowedUsers(
      'app_default', ['alice@corp.com', 'ghost@corp.com', 'ghost@corp.com'], 'ou_alice',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.unresolvedEmailsAndMobiles).toEqual(['ghost@corp.com']);
  });

  it('setBotAllowedUsers omits warning fields when every entry resolves', async () => {    const { store } = await loaded();
    const r = await store.setBotAllowedUsers('app_default', ['alice@corp.com', 'ou_owner'], 'ou_alice');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.unresolvedEmailsAndMobiles).toBeUndefined();
      expect(r.unresolvedUnionIds).toBeUndefined();
    }
  });

  it('setBotAllowedUsers reports on_ misses only in unresolvedUnionIds, not as email/mobile warnings', async () => {
    const { store } = await loaded();
    // 正常 on_ 与邮箱确定性 miss 同时存在：两类告警互不串台（on_ miss 的分支
    // 由 config-allow-owner-identity.test.ts 覆盖）。
    const r = await store.setBotAllowedUsers(
      'app_default', ['on_buddy', 'ghost@corp.com'], 'ou_buddy',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.unresolvedUnionIds).toBeUndefined();
    expect(r.unresolvedEmailsAndMobiles).toEqual(['ghost@corp.com']);
  });

  it('setBotBlockedUsers with [] clears disk entry and in-memory resolved list', async () => {
    const { registry, store } = await loaded({ blockedUsers: ['carol@corp.com'] });
    registry.getBot('app_default').resolvedBlockedUsers = ['ou_carol'];

    const r = await store.setBotBlockedUsers('app_default', []);
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ ok: true, raw: [], resolved: [] });
    expect(readConfig().blockedUsers).toBeUndefined();
    const bot = registry.getBot('app_default');
    expect(bot.config.blockedUsers).toBeUndefined();
    expect(bot.resolvedBlockedUsers).toEqual([]);
  });

  it('setBotBlockedUsers refuses to block a resolved allowedUsers admin', async () => {
    const { registry, store } = await loaded();
    // 模拟 daemon 启动期把 email 形态的管理员解析成 ou_ 后的内存态。
    registry.getBot('app_default').resolvedAllowedUsers = ['ou_owner', 'ou_alice'];

    const r = await store.setBotBlockedUsers('app_default', ['alice@corp.com']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('cannot_block_admin');
      expect(r.conflicting).toEqual(['ou_alice']);
    }
    // 绝不落盘 / 不动内存。
    expect(readConfig().blockedUsers).toBeUndefined();
    expect(registry.getBot('app_default').resolvedBlockedUsers).toEqual([]);
  });

  it('setBotBlockedUsers refuses to block the current owner', async () => {
    const { store } = await loaded();
    const r = await store.setBotBlockedUsers('app_default', ['ou_owner']);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('cannot_block_admin');
      expect(r.conflicting).toEqual(['ou_owner']);
    }
  });

  it('setBotBlockedUsers rejects an all-unresolvable list as empty', async () => {
    const { store } = await loaded();
    const r = await store.setBotBlockedUsers('app_default', ['garbage']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty_resolved');
  });

  it('setBotBlockedUsers returns bot_not_registered for an unknown app', async () => {
    const { store } = await loaded();
    const r = await store.setBotBlockedUsers('app_missing', ['carol@corp.com']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bot_not_registered');
  });

  it('setBotBlockedUsers persists raw entries, syncs memory, and keeps the shared sidecar union (allowed ∪ blocked)', async () => {
    const { registry, store } = await loaded();
    // 先让 sidecar 里有 allowedUsers 的映射（与运行时 set allowedUsers 同路径）。
    const allow = await store.setBotAllowedUsers('app_default', ['ou_owner'], 'ou_owner');
    expect(allow.ok).toBe(true);

    const r = await store.setBotBlockedUsers('app_default', ['carol@corp.com', 'on_bob']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toEqual(['ou_carol', 'ou_bob']);

    expect(readConfig().blockedUsers).toEqual(['carol@corp.com', 'on_bob']);
    const bot = registry.getBot('app_default');
    expect(bot.config.blockedUsers).toEqual(['carol@corp.com', 'on_bob']);
    expect(bot.resolvedBlockedUsers).toEqual(['ou_carol', 'ou_bob']);

    // 同一 sidecar：blocked 写入不得把 allowed 的缓存键 prune 掉（retainKeys 取并集）。
    const sidecar = JSON.parse(readFileSync(join(process.env.SESSION_DATA_DIR!, 'allowed-users-cache-app_default.json'), 'utf-8'));
    expect(sidecar.map).toMatchObject({
      ou_owner: 'ou_owner',
      'carol@corp.com': 'ou_carol',
      on_bob: 'ou_bob',
    });
  });

  it('removeBlockedUsers lifts email/on_ raw entries that resolve to the target open_id', async () => {
    const { registry, store } = await loaded({ blockedUsers: ['carol@corp.com', 'on_bob', 'ou_dave'] });
    registry.getBot('app_default').resolvedBlockedUsers = ['ou_carol', 'ou_bob', 'ou_dave'];

    const r = await store.removeBlockedUsers('app_default', ['ou_carol']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.raw).toEqual(['on_bob', 'ou_dave']);
      expect(r.resolved).toEqual(['ou_bob', 'ou_dave']);
    }
    expect(readConfig().blockedUsers).toEqual(['on_bob', 'ou_dave']);
    const bot = registry.getBot('app_default');
    expect(bot.config.blockedUsers).toEqual(['on_bob', 'ou_dave']);
    expect(bot.resolvedBlockedUsers).toEqual(['ou_bob', 'ou_dave']);
  });

  it('removeBlockedUsers keeps non-matching alias entries and is a no-op when nothing maps', async () => {
    const { registry, store } = await loaded({ blockedUsers: ['carol@corp.com', 'on_bob'] });
    registry.getBot('app_default').resolvedBlockedUsers = ['ou_carol', 'ou_bob'];

    const r = await store.removeBlockedUsers('app_default', ['ou_someone_else']);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.raw).toEqual(['carol@corp.com', 'on_bob']);
    // 无命中：磁盘与内存原样。
    expect(readConfig().blockedUsers).toEqual(['carol@corp.com', 'on_bob']);
    expect(registry.getBot('app_default').resolvedBlockedUsers).toEqual(['ou_carol', 'ou_bob']);
  });

  it('removeBlockedUsers still succeeds when the list carries a definitively unresolvable legacy entry', async () => {
    // 脏态直写：一个不可能解析的垃圾条目与一个正常邮箱条目并存。全量
    // setBotBlockedUsers 重解析会以 empty_resolved 拒绝；定向解除不得被它挡住。
    const { registry, store } = await loaded({ blockedUsers: ['carol@corp.com', 'garbage'] });
    registry.getBot('app_default').resolvedBlockedUsers = ['ou_carol'];

    const r = await store.removeBlockedUsers('app_default', ['ou_carol']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 垃圾条目证据不足 → 保留；邮箱条目映射命中 → 剔除。
      expect(r.raw).toEqual(['garbage']);
      expect(r.resolved).toEqual([]);
    }
    expect(readConfig().blockedUsers).toEqual(['garbage']);
  });

  it('removeBlockedUsers clearing the last entry goes through the clear path', async () => {
    const { registry, store } = await loaded({ blockedUsers: ['carol@corp.com'] });
    registry.getBot('app_default').resolvedBlockedUsers = ['ou_carol'];

    const r = await store.removeBlockedUsers('app_default', ['ou_carol']);
    expect(r).toMatchObject({ ok: true, raw: [], resolved: [] });
    expect(readConfig().blockedUsers).toBeUndefined();
    expect(registry.getBot('app_default').config.blockedUsers).toBeUndefined();
  });

  it('removeBlockedUsers with no targets is an idempotent no-op', async () => {
    const { store } = await loaded({ blockedUsers: ['carol@corp.com'] });
    const r = await store.removeBlockedUsers('app_default', []);
    expect(r).toMatchObject({ ok: true });
    expect(readConfig().blockedUsers).toEqual(['carol@corp.com']);
  });

  it('removeBlockedUsers returns bot_not_registered for an unknown app', async () => {
    const { store } = await loaded();
    const r = await store.removeBlockedUsers('app_missing', ['ou_carol']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bot_not_registered');
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
    expect(store.coerceConfigValue(cliSpec, 'codex')).toMatchObject({ ok: true, value: { cliId: 'codex' } });
    expect(store.coerceConfigValue(cliSpec, 'bogus-cli')).toEqual({ ok: false, reason: 'invalid_cli' });
    const authSpec = store.findConfigField('codexAuthSync')!;
    expect(store.coerceConfigValue(authSpec, 'ISOLATED')).toEqual({ ok: true, value: 'isolated' });
    expect(store.coerceConfigValue(authSpec, 'global')).toEqual({ ok: false, reason: 'invalid_enum' });
  });

  it('persists codexAuthSync through the generic /config store path', async () => {
    const { registry, store } = await loaded({ cliId: 'codex' });
    const spec = store.findConfigField('codexAuthSync')!;
    const set = await store.applyConfigField('app_default', spec, 'isolated');
    expect(set.ok).toBe(true);
    expect(readConfig().codexAuthSync).toBe('isolated');
    expect(registry.getBot('app_default').config.codexAuthSync).toBe('isolated');

    const cleared = await store.applyConfigField('app_default', spec, null);
    expect(cleared.ok).toBe(true);
    expect(readConfig().codexAuthSync).toBeUndefined();
    expect(registry.getBot('app_default').config.codexAuthSync).toBeUndefined();
  });

  it('getConfigCardData returns the card view (booleans + cli options + model choices)', async () => {
    const { store } = await loaded({ model: 'opus', disableStreamingCard: true, pinStreamingCard: true });
    const data = store.getConfigCardData('app_default', ['opus', 'sonnet']);
    expect(data).not.toBeNull();
    expect(data!.cliId).toBe('claude-code');
    expect(data!.model).toBe('opus');
    expect(data!.modelChoices).toEqual(['opus', 'sonnet']);
    expect(data!.cliOptions.length).toBeGreaterThan(0);
    expect(data!.cliOptions.map(option => option.id)).toContain('forge-x-traex');
    expect(data!.booleans.find(b => b.key === 'disableStreamingCard')?.on).toBe(true);
    expect(data!.booleans.find(b => b.key === 'pinStreamingCard')?.on).toBe(true);
    const { store: store2 } = await loaded({ model: 'opus' });
    expect(store2.getConfigCardData('app_default', ['opus'])!.booleans.find(b => b.key === 'pinStreamingCard')?.on).toBe(false);
    const { store: store3 } = await loaded({ cliId: 'traex', cliLaunchMode: 'forge-traex' });
    expect(store3.getConfigCardData('app_default')!.cliId).toBe('forge-x-traex');
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

describe('codexProfile cross-field gate across generic write surfaces (#2037)', () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-profile-gate-'));
    process.env.BOTS_CONFIG = join(dir, 'bots.json');
    process.env.SESSION_DATA_DIR = dir;
  });
  afterEach(() => { delete process.env.BOTS_CONFIG; delete process.env.SESSION_DATA_DIR; });

  async function setupRegistry() {
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach((c: any) => registry.registerBot(c));
    return { registry, store };
  }
  const profileBotJson = () => JSON.stringify([{
    larkAppId: 'app_default', larkAppSecret: 'secret', cliId: 'codex', codexProfile: 'selected',
  }]);

  it.each([
    ['startupCommands', ['/effort low']],
    ['codexAuthSync', 'isolated'],
    ['backendType', 'zellij'],
  ] as const)('rejects %s from a generic /config write when a codexProfile is set', async (key, value) => {
    writeFileSync(process.env.BOTS_CONFIG!, profileBotJson());
    const { registry, store } = await setupRegistry();
    const before = readFileSync(process.env.BOTS_CONFIG!, 'utf8');
    const r = await store.applyConfigField('app_default', store.findConfigField(key)!, value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('Codex profile');
    expect(readFileSync(process.env.BOTS_CONFIG!, 'utf8')).toBe(before);
    const onDisk = JSON.parse(readFileSync(process.env.BOTS_CONFIG!, 'utf8'))[0];
    expect(onDisk[key]).toBeUndefined();
    expect(registry.getBot('app_default').config.codexProfile).toBe('selected');
  });

  it('rejects a non-default service tier through the generic path while keeping the profile', async () => {
    writeFileSync(process.env.BOTS_CONFIG!, profileBotJson());
    const { store } = await setupRegistry();
    const r = await store.applyConfigField('app_default', store.findConfigField('serviceTier')!, 'priority');
    expect(r.ok).toBe(false);
    expect(JSON.parse(readFileSync(process.env.BOTS_CONFIG!, 'utf8'))[0])
      .toMatchObject({ cliId: 'codex', codexProfile: 'selected' });
  });

  it('still accepts an unrelated field (model) for a profile bot', async () => {
    writeFileSync(process.env.BOTS_CONFIG!, profileBotJson());
    const { store } = await setupRegistry();
    const r = await store.applyConfigField('app_default', store.findConfigField('model')!, 'gpt-test');
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(process.env.BOTS_CONFIG!, 'utf8'))[0])
      .toMatchObject({ codexProfile: 'selected', model: 'gpt-test' });
  });

  it('does not affect bots without a profile: startupCommands still writes', async () => {
    writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify([{
      larkAppId: 'app_default', larkAppSecret: 'secret', cliId: 'codex',
    }]));
    const { store } = await setupRegistry();
    const r = await store.applyConfigField('app_default', store.findConfigField('startupCommands')!, ['/effort low']);
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(process.env.BOTS_CONFIG!, 'utf8'))[0].startupCommands)
      .toEqual(['/effort low']);
  });

  it('writeRawConfigAtomic refuses a whole generation the loader would reject, leaving the file intact', async () => {
    const { writeRawConfigAtomic, readRawConfig } = await import('../src/services/config-store.js');
    const path = process.env.BOTS_CONFIG!;
    writeFileSync(path, profileBotJson());
    const before = readFileSync(path, 'utf8');
    const bad = JSON.parse(before);
    bad[0].readIsolation = true;
    await expect(writeRawConfigAtomic(path, bad)).rejects.toThrow('Codex profile');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect((await readRawConfig(path))[0].readIsolation).toBeUndefined();
  });
});
