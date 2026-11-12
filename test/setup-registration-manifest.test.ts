import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tryRegisterApp } from '../src/setup/register-app.js';
import {
  classifyCreationGrants,
  compareScopeGrants,
  completeRegisteredApp,
  createRegistrationOptions,
} from '../src/setup/registration-manifest.js';
import {
  BOT_BASELINE_APP_EVENTS,
  BOT_BASELINE_CALLBACKS,
  BOT_OPTIONAL_APP_EVENTS,
  collectBotmuxRedirectUrls,
} from '../src/setup/open-platform-automation.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('官方注册链接', () => {
  it('SDK 输出 gzip/base64url 编码的完整 addons，并保留名称和创建限制', async () => {
    const options = createRegistrationOptions('{user} 的机器人');
    const post = vi.spyOn(defaultHttpInstance, 'post')
      .mockResolvedValueOnce({
        verification_uri_complete: 'https://open.feishu.cn/page/launcher?user_code=TEST',
        device_code: 'device-code',
      })
      .mockResolvedValueOnce({ client_id: 'cli_test', client_secret: randomUUID() });
    const onQRCodeReady = vi.fn();

    await expect(tryRegisterApp({ ...options, onQRCodeReady })).resolves.toMatchObject({ ok: true });
    expect(post).toHaveBeenCalledTimes(2);
    const url = new URL(onQRCodeReady.mock.calls[0][0].url);
    const encoded = url.searchParams.get('addons')!;
    expect(encoded).toBe(gzipSync(JSON.stringify(options.addons)).toString('base64url'));
    const decoded = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64url')).toString());
    expect(decoded.scopes.tenant).toContain('application:application:self_manage');
    expect(decoded.scopes.user).toContain('im:message');
    expect(decoded.scopes.tenant).not.toContain('bitable:app');
    expect(decoded.scopes.user).not.toContain('bitable:app');
    expect(decoded.events.items.tenant).toEqual(expect.arrayContaining([...BOT_BASELINE_APP_EVENTS, ...BOT_OPTIONAL_APP_EVENTS]));
    expect(decoded.callbacks.items).toEqual([...BOT_BASELINE_CALLBACKS]);
    expect(url.searchParams.get('name')).toBe('{user} 的机器人');
    expect(url.searchParams.get('createOnly')).toBe('true');
    expect(url.searchParams.has('clientID')).toBe(false);
  });

  it('更新链接带 clientID，SDK 仍会切换到 Lark 轮询', async () => {
    const post = vi.spyOn(defaultHttpInstance, 'post')
      .mockResolvedValueOnce({
        verification_uri_complete: 'https://open.feishu.cn/page/launcher?user_code=TEST',
        device_code: 'device-code',
      })
      .mockResolvedValueOnce({ user_info: { tenant_brand: 'lark' } })
      .mockResolvedValueOnce({ client_id: 'cli_test', client_secret: randomUUID() });
    const onQRCodeReady = vi.fn();
    const onStatusChange = vi.fn();
    const result = await tryRegisterApp({
      appId: 'cli_test',
      addons: { scopes: { tenant: ['im:message'] } },
      onQRCodeReady,
      onStatusChange,
    });
    const url = new URL(onQRCodeReady.mock.calls[0][0].url);
    expect(url.searchParams.get('clientID')).toBe('cli_test');
    expect(url.searchParams.has('createOnly')).toBe(false);
    expect(post.mock.calls[2][0]).toContain('accounts.larksuite.com');
    expect(onStatusChange).toHaveBeenCalledWith({ status: 'domain_switched' });
    expect(result).toMatchObject({ ok: true, brand: 'lark' });
  });
});

const wanted = {
  tenant: Array.from({ length: 12 }, (_, index) => `scope:${index}`),
  user: ['scope:0'],
};
const grantedRows = [
  ...wanted.tenant.map(scope_name => ({ scope_name, scope_type: 'tenant', grant_status: 1 })),
  { scope_name: 'scope:0', scope_type: 'user', grant_status: 1 },
];

describe('注册授予结果', () => {
  it('按授权状态和 token 类型比对同名项，并区分完整、部分与接近空清单', () => {
    const complete = compareScopeGrants(wanted, grantedRows);
    const partial = compareScopeGrants(wanted, [
      ...grantedRows.slice(0, -1),
      { scope_name: 'scope:0', scope_type: 'user', grant_status: 2 },
    ]);
    const ignored = compareScopeGrants(wanted, grantedRows.slice(0, 1));
    expect(complete.grantedCount).toBe(13);
    expect(partial.missing).toEqual({ tenant: [], user: ['scope:0'] });
    expect(classifyCreationGrants(wanted, complete)).toBe('complete');
    expect(classifyCreationGrants(wanted, partial)).toBe('partial');
    expect(classifyCreationGrants(wanted, ignored)).toBe('likely_ignored');
  });
});

function stubOpenApi(reads: unknown[], options: { redirectMissing?: boolean; webhook?: boolean } = {}) {
  const redirects = collectBotmuxRedirectUrls();
  let redirectUrls = options.redirectMissing ? [] : redirects;
  let eventMode = options.webhook ? 'webhook' : 'websocket';
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'token' });
    if (url.endsWith('/v6/scopes')) {
      const result = reads.shift();
      if (result instanceof Error) throw result;
      return Response.json(result);
    }
    if (url.endsWith('/config') && init?.method === 'PATCH') {
      const patch = JSON.parse(String(init.body));
      if (patch.security?.add) redirectUrls = patch.security.add.redirect_urls;
      if (patch.event) eventMode = patch.event.subscription_type;
      return Response.json({ code: 0 });
    }
    return Response.json({ code: 0, data: { app: {
      online_version_id: 'published',
      security: { redirect_urls: redirectUrls },
      event: { subscription_type: eventMode, subscribed_events: BOT_BASELINE_APP_EVENTS },
      callback_info: { callback_type: eventMode, subscribed_callbacks: BOT_BASELINE_CALLBACKS },
    } } });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

const scopeResponse = (scopes: typeof grantedRows) => ({ code: 0, data: { scopes } });
const identity = { appId: 'cli_target', appSecret: randomUUID(), brand: 'feishu' as const };
const addons = { scopes: wanted };

describe('注册后补配', () => {
  it('全部授予，官方接口补 redirect 和 WebSocket 后回读，复用已发布版本', async () => {
    const fetcher = stubOpenApi([scopeResponse(grantedRows)], { redirectMissing: true, webhook: true });
    const web = vi.fn();
    const result = await completeRegisteredApp(identity, addons, web);
    expect(result).toMatchObject({ ok: true, scopeCount: 13, redirectConfigured: true, eventModeReady: true, publishSkipped: true });
    expect(web).not.toHaveBeenCalled();
    const patches = fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH').map(([, init]) => JSON.parse(String(init!.body)));
    expect(patches).toEqual([
      { security: { add: { redirect_urls: collectBotmuxRedirectUrls() } } },
      { event: { subscription_type: 'websocket' }, callback: { callback_type: 'websocket' } },
    ]);
  });

  it('部分授予保留缺失桶，线上配置齐全时不走网页权限导入', async () => {
    stubOpenApi([scopeResponse(grantedRows.slice(0, -1))]);
    const web = vi.fn();
    const result = await completeRegisteredApp(identity, addons, web);
    expect(result).toMatchObject({ ok: true, scopeCount: 12, scopeWarning: expect.stringContaining('user: scope:0') });
    expect(web).not.toHaveBeenCalled();
  });

  it('接近默认模板时在同一应用上仅补缺失桶，并再回读', async () => {
    stubOpenApi([scopeResponse(grantedRows.slice(0, 1)), scopeResponse(grantedRows.slice(0, 1)), scopeResponse(grantedRows)]);
    const web = vi.fn().mockResolvedValue({ ok: true, scopeCount: 0 });
    const status = vi.fn();
    const result = await completeRegisteredApp(identity, addons, web, { onStatus: status });
    expect(status).toHaveBeenCalledWith(expect.stringContaining('灰度'));
    expect(web).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      appId: identity.appId,
      scopeManifest: { scopes: { tenant: wanted.tenant.slice(1), user: wanted.user } },
      appJustCreated: false,
    }));
    expect(result).toMatchObject({ ok: true, scopeCount: 13, scopeWarning: undefined });
  });

  it('等待授权传播，第二次回读已齐全时不降级', async () => {
    stubOpenApi([scopeResponse(grantedRows.slice(0, 1)), scopeResponse(grantedRows)]);
    const web = vi.fn();
    const result = await completeRegisteredApp(identity, addons, web);
    expect(result).toMatchObject({ ok: true, scopeCount: 13 });
    expect(web).not.toHaveBeenCalled();
  });

  it('网页补事件失败时保留已确认的 redirect 状态', async () => {
    const fetcher = stubOpenApi([scopeResponse(grantedRows)]);
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => url.includes('/v6/applications/')
      ? Promise.resolve(Response.json({ code: 0, data: { app: {
          online_version_id: 'published',
          redirect_urls: collectBotmuxRedirectUrls(),
        } } }))
      : original(url, init));
    const web = vi.fn().mockResolvedValue({ ok: false, reason: 'invalid_session', redirectConfigured: false });
    const result = await completeRegisteredApp(identity, addons, web);
    expect(result).toMatchObject({ ok: false, reason: 'invalid_session', redirectConfigured: true });
  });

  it('网络读失败时说明未核验，禁止把它当作灰度证据', async () => {
    stubOpenApi([new Error('network unavailable')]);
    const web = vi.fn();
    const result = await completeRegisteredApp(identity, addons, web);
    expect(result).toMatchObject({ ok: true, scopeCount: 0, scopeWarning: expect.stringContaining('无法回读') });
    expect(web).not.toHaveBeenCalled();
  });

  it('Lark 的清单疑似未授予时提示手动检查', async () => {
    stubOpenApi([scopeResponse([]), scopeResponse([])]);
    const web = vi.fn();
    const result = await completeRegisteredApp({ ...identity, brand: 'lark' }, addons, web);
    expect(result).toMatchObject({ ok: false, reason: 'unsupported_brand' });
    expect(web).not.toHaveBeenCalled();
  });
});
