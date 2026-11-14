import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  bot: undefined as any,
  automate: vi.fn(),
  register: vi.fn(),
  probe: vi.fn(),
  hints: vi.fn(),
  dm: vi.fn(),
}));

vi.mock('../src/bot-registry.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  getBot: () => h.bot,
  getOwnerOpenId: () => h.bot.resolvedAllowedUsers[0],
}));
vi.mock('../src/setup/open-platform-automation.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  automateOpenPlatformSetup: h.automate,
  probeVcMeetingEventSubscription: h.probe,
  inspectUnderReviewConfigHints: h.hints,
}));
vi.mock('../src/setup/register-app.js', () => ({ tryRegisterApp: h.register }));
vi.mock('../src/im/lark/client.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  sendUserMessage: h.dm,
}));

import { checkRequiredScopes, ensureVcMeetingEventsSubscribed } from '../src/im/lark/event-dispatcher.js';
import { readDefaultScopeManifest } from '../src/setup/open-platform-automation.js';
import type { RegisterAppOptions } from '../src/setup/register-app.js';
import { BOTMUX_REQUIRED_SCOPES } from '../src/setup/verify-permissions.js';

const APP = 'cli_scope_selfcheck';
const makeBot = (config: Record<string, unknown> = {}) => ({
  config: { larkAppId: APP, larkAppSecret: 'secret', brand: 'feishu', vcMeetingAgent: { enabled: false }, ...config },
  resolvedAllowedUsers: ['ou_admin'],
  botName: 'ScopeBot',
});

/** Lark app-info stub: `granted` scopes in both token buckets, or an error `code`. */
function stubLark(app: { granted?: string[]; code?: number; reviewVersion?: string; approveRepair?: boolean; userOnly?: string; legacy?: boolean }): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('tenant_access_token')) return Response.json({ code: 0, tenant_access_token: 't' });
    if (String(url).endsWith('/v6/scopes')) {
      const buckets = h.register.mock.lastCall?.[0]?.addons.scopes;
      const scopes = app.approveRepair ? ['tenant', 'user'].flatMap(scope_type =>
        (buckets?.[scope_type] ?? []).map((scope_name: string) => ({ scope_name, scope_type, grant_status: 1 }))) : [];
      return Response.json({ code: 0, data: { scopes } });
    }
    if (app.code !== undefined) return Response.json({ code: app.code, msg: 'denied' });
    return Response.json({ code: 0, data: { app: {
      unaudit_version_id: app.reviewVersion,
      scopes: (app.granted ?? []).map(scope => app.legacy
        ? { scope }
        : { scope, token_types: app.userOnly === scope ? ['user'] : ['tenant', 'user'] }),
    } } });
  }));
}

const manifest = readDefaultScopeManifest();
const inManifest = (name: string) => manifest.scopes.tenant.includes(name) || manifest.scopes.user.includes(name);
const critical = BOTMUX_REQUIRED_SCOPES.filter(s => s.critical).map(s => s.name);
const optional = BOTMUX_REQUIRED_SCOPES.filter(s => !s.critical).map(s => s.name);
const missingCriticalScope = 'im:resource';
const requested = (): string[] => {
  const scopes = h.register.mock.lastCall![0].addons.scopes;
  return [...new Set<string>([...scopes.tenant, ...scopes.user])].sort();
};
const link = 'https://open.feishu.cn/page/launcher?user_code=TEST';

beforeEach(() => {
  h.bot = makeBot();
  h.automate.mockReset();
  h.register.mockReset().mockImplementation(async (opts: RegisterAppOptions) => {
    opts.onQRCodeReady?.({ url: link, expireIn: 600 });
    return { ok: true, appId: APP, appSecret: crypto.randomUUID(), brand: 'feishu' };
  });
  h.probe.mockReset();
  h.hints.mockReset().mockResolvedValue('');
  h.dm.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('checkRequiredScopes — 官方增量确认', () => {
  it('所有权限已授权时无需确认链接', async () => {
    stubLark({ granted: [...critical, ...optional] });
    await checkRequiredScopes(APP);
    expect(h.register).not.toHaveBeenCalled();
    expect(h.automate).not.toHaveBeenCalled();
    expect(h.dm).not.toHaveBeenCalled();
  });

  it.each(['feishu', 'lark'])('仅缺可选权限时重复自检不向 owner 发送链接（%s）', async brand => {
    h.bot = makeBot({ brand });
    stubLark({ granted: critical });
    for (let check = 0; check < 3; check++) await checkRequiredScopes(APP);
    expect(h.register).not.toHaveBeenCalled();
    expect(h.dm).not.toHaveBeenCalled();
  });

  it('空权限数组无法核验，跳过启动补权', async () => {
    stubLark({ granted: [] });
    await checkRequiredScopes(APP);
    expect(h.register).not.toHaveBeenCalled();
    expect(h.dm).not.toHaveBeenCalled();
  });

  it('兼容只提供权限名称的旧响应，并只申请确实缺失的权限', async () => {
    stubLark({ granted: [...critical, ...optional].filter(name => name !== missingCriticalScope), legacy: true, approveRepair: true });
    await checkRequiredScopes(APP);
    expect(requested()).toEqual([missingCriticalScope]);
  });

  it('只向 owner 申请缺失项，确认后回读再告知结果', async () => {
    const missingOptional = optional.find(inManifest)!;
    const granted = [...critical, ...optional].filter(name => name !== missingCriticalScope && name !== missingOptional);
    stubLark({ granted, approveRepair: true });
    await checkRequiredScopes(APP);
    expect(h.register).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ appId: APP }));
    expect(requested()).toEqual([missingCriticalScope, missingOptional].sort());
    expect(h.automate).not.toHaveBeenCalled();
    expect(h.dm.mock.calls[0]?.slice(0, 4)).toEqual([APP, 'ou_admin', expect.stringContaining(link), 'text']);
    expect(h.dm.mock.calls[1]?.slice(0, 4)).toEqual([APP, 'ou_admin', expect.stringContaining('全部补齐'), 'text']);
  });

  it('确认后仍缺失时报告实际结果', async () => {
    const missing = missingCriticalScope;
    stubLark({ granted: [...critical, ...optional].filter(name => name !== missing) });
    await checkRequiredScopes(APP);
    expect(h.dm.mock.calls[1]![2]).toContain('仍缺失');
    expect(h.dm.mock.calls[1]![2]).toContain(missing);
  });

  it('合并授权回读还在进行中的启动检查，避免用旧快照重新发起补权', async () => {
    stubLark({ granted: [...critical, ...optional].filter(name => name !== missingCriticalScope), approveRepair: true });
    const fetcher = vi.mocked(fetch);
    const respond = fetcher.getMockImplementation()!;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    fetcher.mockImplementation(async (url, init) => {
      if (String(url).includes('/v6/applications/')) await pending;
      return respond(url, init);
    });
    const first = checkRequiredScopes(APP);
    await vi.waitFor(() => expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/v6/applications/'))).toHaveLength(1));
    const second = checkRequiredScopes(APP);
    release();
    await Promise.all([first, second]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/v6/applications/'))).toHaveLength(1);
    expect(h.register).toHaveBeenCalledTimes(1);
    expect(h.dm).toHaveBeenCalledTimes(2);
  });

  it('待确认时合并同一应用的重复检查', async () => {
    const missing = missingCriticalScope;
    stubLark({ granted: [...critical, ...optional].filter(name => name !== missing), approveRepair: true });
    let resolve!: (value: unknown) => void;
    h.register.mockImplementationOnce(async (opts: RegisterAppOptions) => {
      opts.onQRCodeReady?.({ url: link, expireIn: 600 });
      return new Promise(done => { resolve = done; });
    });
    const first = checkRequiredScopes(APP);
    await vi.waitFor(() => expect(h.dm).toHaveBeenCalledTimes(1));
    await checkRequiredScopes(APP);
    expect(h.register).toHaveBeenCalledTimes(1);
    resolve({ ok: true, appId: APP, brand: 'feishu' });
    await first;
    expect(h.dm).toHaveBeenCalledTimes(2);
  });

  it('同名 scope 只授予 user 时仍为 tenant 申请缺失项', async () => {
    const scope = 'im:message';
    stubLark({ granted: [...critical, ...optional], approveRepair: true, userOnly: scope });
    await checkRequiredScopes(APP);
    expect(h.register.mock.lastCall?.[0].addons.scopes).toEqual({ tenant: [scope], user: [] });
  });

  it('生成链接期间更换 owner 时只向新 owner 发链接', async () => {
    const missing = missingCriticalScope;
    stubLark({ granted: [...critical, ...optional].filter(name => name !== missing), approveRepair: true });
    let finishBegin!: () => void;
    h.register.mockImplementationOnce(async (opts: RegisterAppOptions) => {
      await new Promise<void>(done => { finishBegin = done; });
      opts.onQRCodeReady?.({ url: link, expireIn: 600 });
      return { ok: false, error: 'aborted' };
    });
    const first = checkRequiredScopes(APP);
    await vi.waitFor(() => expect(h.register).toHaveBeenCalledTimes(1));
    h.bot.resolvedAllowedUsers = ['ou_new_owner'];
    await checkRequiredScopes(APP);
    finishBegin();
    await first;
    expect(h.register).toHaveBeenCalledTimes(2);
    expect(h.dm.mock.calls.map(call => call[1])).toEqual(['ou_new_owner', 'ou_new_owner']);
  });

  it('回读被拒时只申请 self_manage', async () => {
    stubLark({ code: 99991672, approveRepair: true });
    await checkRequiredScopes(APP);
    expect(requested()).toEqual(['application:application:self_manage']);
  });

  it('确认链接生成失败时保留手动 self_manage 链接', async () => {
    stubLark({ code: 99991672 });
    h.register.mockResolvedValue({ ok: false, error: 'network', message: 'network' });
    await checkRequiredScopes(APP);
    expect(h.dm).toHaveBeenCalledTimes(1);
    expect(h.dm.mock.calls[0]![2]).toContain('application:application:self_manage');
  });
});

describe('checkRequiredScopes — app stuck in review', () => {
  it('DMs once per pending version, and counts it only after the DM was delivered', async () => {
    stubLark({ granted: optional, reviewVersion: 'ver-1' });
    h.hints.mockResolvedValue('HINT-DATA-RANGE');
    h.dm.mockRejectedValueOnce(new Error('network down'));
    await checkRequiredScopes(APP);
    await checkRequiredScopes(APP);
    await checkRequiredScopes(APP);
    expect(h.dm).toHaveBeenCalledTimes(2);
    expect(h.dm.mock.calls[1]![2]).toContain('HINT-DATA-RANGE');
    stubLark({ granted: optional, reviewVersion: 'ver-2' });
    await checkRequiredScopes(APP);
    expect(h.dm).toHaveBeenCalledTimes(3);
    expect(h.register).not.toHaveBeenCalled();
  });
});

describe('ensureVcMeetingEventsSubscribed', () => {
  const vcBot = (config: Record<string, unknown> = {}) => makeBot({ vcMeetingAgent: undefined, ...config });

  it('skips non-feishu, apiOnly and VC-disabled bots without probing', async () => {
    for (const bot of [vcBot({ brand: 'lark' }), vcBot({ apiOnly: true }), makeBot()]) {
      h.bot = bot;
      await ensureVcMeetingEventsSubscribed(APP);
    }
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('never publishes when the events are already subscribed', async () => {
    h.bot = vcBot();
    h.probe.mockResolvedValue({ ok: true, missingVcEvents: [], eventModeReady: true });
    await ensureVcMeetingEventsSubscribed(APP);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.automate).not.toHaveBeenCalled();
  });

  it('subscribes missing events without a QR, and DMs the admin only when that fails', async () => {
    h.bot = vcBot();
    h.probe.mockResolvedValue({ ok: true, missingVcEvents: ['vc.bot.meeting_invited_v1'], eventModeReady: true });
    h.automate.mockResolvedValue({ ok: true, subscribedEventCount: 3, versionId: 'v1' });
    await ensureVcMeetingEventsSubscribed(APP);
    expect(h.automate).toHaveBeenCalledWith(expect.objectContaining({ disableQrLogin: true }));
    expect(h.dm).not.toHaveBeenCalled();
    h.automate.mockResolvedValue({ ok: false, reason: 'api_error', message: 'boom' });
    await ensureVcMeetingEventsSubscribed(APP);
    expect(h.dm).toHaveBeenCalledTimes(1);
  });

  it('degrades quietly when the read-only probe fails', async () => {
    h.bot = vcBot();
    h.probe.mockResolvedValue({ ok: false, reason: 'missing_session', message: 'no cached session' });
    await expect(ensureVcMeetingEventsSubscribed(APP)).resolves.toBeUndefined();
    expect(h.automate).not.toHaveBeenCalled();
    expect(h.dm).not.toHaveBeenCalled();
  });
});
