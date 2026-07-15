/**
 * Unit tests for Open Platform setup automation helpers.
 *
 * Run: pnpm vitest run test/setup-open-platform-automation.test.ts
 */
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  automateOpenPlatformSetup,
  botmuxFeishuSessionFilePath,
  buildFeishuQrPayload,
  buildSafeSettingPayload,
  buildScopeUpdatePayload,
  createFeishuOpenPlatformApp,
  extractOpenPlatformCsrfToken,
  extractOpenPlatformSessionIdentity,
  extractOpenPlatformScopeEntries,
  getCookieHeader,
  mapFeishuQrPollingStatus,
  mapManifestScopesToOpenPlatformIds,
  parseSetupOpenPlatformAutoFlag,
  prepareFeishuWebSession,
  readStoredCookiesFromSessionFile,
  type StoredCookie,
  writeStoredCookiesToSessionFile,
} from '../src/setup/open-platform-automation.js';

function cookie(overrides: Partial<StoredCookie> = {}): StoredCookie {
  return {
    name: 'session',
    value: 'secret-cookie-value',
    domain: '.feishu.cn',
    path: '/',
    secure: true,
    httpOnly: true,
    hostOnly: false,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

const openPlatformPage = (csrf = 'csrf_create') => `<script>
window.csrfToken="${csrf}";
window.user={"id":"u_1","name":"Alice","email":"alice@example.com","tenantId":"t_1","tenantName":"Example","tenantDisplayName":{"value":"Example"}};
</script>`;

/**
 * 有状态的事件/回调订阅 mock:read 返回当前订阅,operation:add 增量写入,
 * 与开放平台 console 的增量契约同形。automateOpenPlatformSetup 现在会回读
 * 确认核心事件/回调,mock 不落库就会 fail-closed。
 */
function openPlatformSubscriptionMock(appId: string, opts: {
  failEventUpdate?: boolean;
  failCallbackUpdate?: boolean;
  initial?: { appEvents?: string[]; userEvents?: string[]; callbacks?: string[]; callbackMode?: number };
} = {}) {
  const state = {
    eventMode: 4,
    appEvents: [...(opts.initial?.appEvents ?? [])],
    userEvents: [...(opts.initial?.userEvents ?? [])],
    callbackMode: opts.initial?.callbackMode ?? 1,
    callbacks: [...(opts.initial?.callbacks ?? [])],
  };
  const updateBodies: Array<Record<string, unknown>> = [];
  const handle = (href: string, init?: RequestInit): Response | null => {
    if (href.endsWith(`/developers/v1/event/update/${appId}`)) {
      const body = JSON.parse(String(init?.body));
      updateBodies.push(body);
      if (opts.failEventUpdate) return Response.json({ code: 1, msg: 'event update rejected' });
      state.appEvents.push(...(body.appEvents ?? []));
      state.userEvents.push(...(body.userEvents ?? []));
      return Response.json({ code: 0 });
    }
    if (href.endsWith(`/developers/v1/event/${appId}`)) {
      return Response.json({
        code: 0,
        data: {
          eventMode: state.eventMode,
          events: [...state.appEvents, ...state.userEvents],
          appEventDetails: [{ items: state.appEvents.map(id => ({ id })) }],
          userEventDetails: [{ items: state.userEvents.map(id => ({ id })) }],
        },
      });
    }
    if (href.endsWith(`/developers/v1/callback/switch/${appId}`)) {
      const body = JSON.parse(String(init?.body));
      state.callbackMode = body.callbackMode;
      return Response.json({ code: 0 });
    }
    if (href.endsWith(`/developers/v1/callback/update/${appId}`)) {
      const body = JSON.parse(String(init?.body));
      updateBodies.push(body);
      if (opts.failCallbackUpdate) return Response.json({ code: 1, msg: 'callback update rejected' });
      state.callbacks.push(...(body.callbacks ?? []));
      return Response.json({ code: 0 });
    }
    if (href.endsWith(`/developers/v1/callback/${appId}`)) {
      return Response.json({ code: 0, data: { callbackMode: state.callbackMode, callbacks: [...state.callbacks] } });
    }
    return null;
  };
  return { state, updateBodies, handle };
}

describe('parseSetupOpenPlatformAutoFlag', () => {
  it('is enabled by default, supports explicit skip, and keeps --open-platform-auto compatible', () => {
    expect(parseSetupOpenPlatformAutoFlag([])).toBe(true);
    expect(parseSetupOpenPlatformAutoFlag(['--open-platform-auto'])).toBe(true);
    expect(parseSetupOpenPlatformAutoFlag(['--no-open-platform-auto'])).toBe(false);
    expect(parseSetupOpenPlatformAutoFlag(['--open-platform-auto', '--no-open-platform-auto'])).toBe(false);
    expect(parseSetupOpenPlatformAutoFlag(['--no-open-platform-auto', '--open-platform-auto'])).toBe(true);
  });
});

describe('botmux Feishu session cookie adapter', () => {
  it('writes private botmux cookie jar and builds scoped cookie headers without expired cookies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const file = join(dir, 'feishu_session.json');
    writeStoredCookiesToSessionFile(file, [
      cookie(),
      cookie({ name: 'expired', value: 'gone', expiresAt: Date.now() - 10 }),
      cookie({ name: 'askOnly', value: 'nope', domain: 'ask.feishu.cn', hostOnly: true }),
    ]);

    const cookies = readStoredCookiesFromSessionFile(file);
    expect(cookies?.map(c => c.name)).toEqual(['session', 'askOnly']);
    expect(getCookieHeader(cookies ?? [], 'https://open.feishu.cn/app/cli_x/auth')).toBe('session=secret-cookie-value');
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('resolves botmux session path under config dir', () => {
    expect(botmuxFeishuSessionFilePath('/tmp/botmux-config')).toBe('/tmp/botmux-config/feishu-session.json');
  });
});

describe('Open Platform payload helpers', () => {
  it('builds Feishu QR payload and maps polling status', () => {
    expect(buildFeishuQrPayload('qr-token')).toBe(JSON.stringify({ qrlogin: { token: 'qr-token' } }));
    expect(mapFeishuQrPollingStatus(2)).toBe('已经扫码，等待手机确认');
    expect(mapFeishuQrPollingStatus(5)).toBe('二维码已过期');
    expect(mapFeishuQrPollingStatus(null)).toBe('等待飞书扫码');
  });

  it('extracts window.csrfToken from page HTML', () => {
    expect(extractOpenPlatformCsrfToken('<script>window.csrfToken = "csrf_123"</script>')).toBe('csrf_123');
  });

  it('extracts the account and tenant identity shown before cached-session creation', () => {
    expect(extractOpenPlatformSessionIdentity(openPlatformPage())).toEqual({
      userId: 'u_1',
      userName: 'Alice',
      email: 'alice@example.com',
      tenantId: 't_1',
      tenantName: 'Example',
    });
  });

  it('maps tenant/user scope names to Open Platform IDs and builds payloads', () => {
    const entries = extractOpenPlatformScopeEntries({
      data: {
        appScopeList: [{ id: 101, name: 'im:message' }],
        userScopeList: [{ scopeId: '202', scopeName: 'auth:user_access_token:read' }],
      },
    });
    const mapped = mapManifestScopesToOpenPlatformIds(
      { scopes: { tenant: ['im:message'], user: ['auth:user_access_token:read'] } },
      entries,
    );

    expect(mapped).toEqual({
      tenantScopeIds: ['101'],
      userScopeIds: ['202'],
      missingTenantScopes: [],
      missingUserScopes: [],
    });
    expect(buildScopeUpdatePayload('cli_x', mapped)).toMatchObject({
      clientId: 'cli_x',
      appScopeIDs: ['101'],
      userScopeIDs: ['202'],
      operation: 'add',
      isDeveloperPanel: true,
    });
    expect(buildSafeSettingPayload('cli_x').redirectURL).toEqual(['http://127.0.0.1:9768/callback']);
  });
});

describe('prepareFeishuWebSession', () => {
  it('gets a new botmux session via built-in Feishu QR login and saves it privately', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    const qrPayloads: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/accounts/qrlogin/init')) {
        return Response.json(
          { code: 0, data: { step_info: { token: 'qr-token' } } },
          { headers: { 'x-flow-key': 'flow-key' } },
        );
      }
      if (href.includes('/accounts/qrlogin/polling')) {
        return Response.json({
          code: 0,
          data: {
            next_step: 'enter_app',
            step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross-login' },
          },
        });
      }
      if (href === 'https://accounts.feishu.cn/cross-login') {
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://ask.feishu.cn/',
            'set-cookie': 'session=secret-cookie-value; Domain=.feishu.cn; Path=/; Secure; HttpOnly',
          },
        });
      }
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await prepareFeishuWebSession({
      sessionFilePath: sessionFile,
      fetchImpl,
      pollIntervalMs: 0,
      maxWaitMs: 1000,
      onQrCode: ({ qrPayload }) => qrPayloads.push(qrPayload),
    });

    expect(result.ok && result.source).toBe('qr_login');
    expect(qrPayloads).toEqual([JSON.stringify({ qrlogin: { token: 'qr-token' } })]);
    expect(readStoredCookiesFromSessionFile(sessionFile)?.map(c => c.name)).toContain('session');
    if (process.platform !== 'win32') {
      expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
    }
  });

  it('forces a fresh QR login for onboarding even when a valid cache exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-force-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    let initCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/accounts/qrlogin/init')) {
        initCount++;
        return Response.json(
          { code: 0, data: { step_info: { token: 'fresh-token' } } },
          { headers: { 'x-flow-key': 'fresh-flow' } },
        );
      }
      if (href.includes('/accounts/qrlogin/polling')) {
        return Response.json({
          code: 0,
          data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/fresh-cross' } },
        });
      }
      if (href === 'https://accounts.feishu.cn/fresh-cross') {
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://ask.feishu.cn/',
            'set-cookie': 'session=fresh-cookie; Domain=.feishu.cn; Path=/; Secure; HttpOnly',
          },
        });
      }
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await prepareFeishuWebSession({
      sessionFilePath: sessionFile,
      forceQrLogin: true,
      fetchImpl,
      pollIntervalMs: 0,
      maxWaitMs: 1000,
      onQrCode: () => {},
    });

    expect(result.ok && result.source).toBe('qr_login');
    expect(initCount).toBe(1);
    expect(readStoredCookiesFromSessionFile(sessionFile)?.find(c => c.name === 'session')?.value).toBe('fresh-cookie');
  });

  it('can require cache-only reuse so follow-up setup never displays a second QR', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-reuse-only-'));
    const onQrCode = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error('network must not be used without cached cookies');
    }) as unknown as typeof fetch;

    const result = await prepareFeishuWebSession({
      sessionFilePath: join(dir, 'missing-session.json'),
      disableQrLogin: true,
      disableBytedcliFallback: true,
      fetchImpl,
      onQrCode,
    });

    expect(result).toMatchObject({ ok: false, reason: 'invalid_session' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onQrCode).not.toHaveBeenCalled();
  });

  it('uses old bytedcli session file only as fallback after built-in QR login fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    const fallbackSessionFile = join(dir, 'bytedcli-feishu-session.json');
    writeFileSync(fallbackSessionFile, JSON.stringify({ cookies: [cookie()] }));
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/accounts/qrlogin/init')) throw new Error('login down');
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await prepareFeishuWebSession({
      sessionFilePath: sessionFile,
      bytedcliFallbackSessionFilePath: fallbackSessionFile,
      fetchImpl,
      onQrCode: () => {},
    });

    expect(result.ok && result.source).toBe('bytedcli_fallback');
    expect(readStoredCookiesFromSessionFile(sessionFile)?.map(c => c.name)).toContain('session');
  });
});

describe('createFeishuOpenPlatformApp', () => {
  it('reuses one cached Web session to upload an icon, create/enable the bot, and read its secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-create-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: Array<{ path: string; body: unknown }> = [];
    let qrCount = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === 'https://open.feishu.cn/app') {
        return new Response(openPlatformPage(), { status: 200 });
      }
      const path = new URL(href).pathname;
      calls.push({ path, body: init?.body });
      if (path === '/developers/v1/app/upload/image') {
        expect(init?.body).toBeInstanceOf(FormData);
        return Response.json({ code: 0, data: { url: 'https://cdn.example/botmux.png' } });
      }
      if (path === '/developers/v1/app/create') {
        expect(JSON.parse(String(init?.body))).toMatchObject({ name: 'botmux-4', appSceneType: 0 });
        return Response.json({ code: 0, data: { ClientID: 'cli_created' } });
      }
      if (path === '/developers/v1/secret/cli_created') {
        return Response.json({ code: 0, data: { secret: 'created-secret' } });
      }
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await createFeishuOpenPlatformApp({
      name: 'botmux-4',
      sessionFilePath: sessionFile,
      disableBytedcliFallback: true,
      fetchImpl,
      onQrCode: () => { qrCount += 1; },
    });

    expect(result).toMatchObject({
      ok: true,
      appId: 'cli_created',
      appSecret: 'created-secret',
      sessionSource: 'botmux_cache',
      sessionIdentity: { userId: 'u_1', tenantId: 't_1' },
    });
    expect(qrCount).toBe(0);
    expect(calls.map(call => call.path)).toEqual([
      '/developers/v1/app/upload/image',
      '/developers/v1/app/create',
      '/developers/v1/robot/switch/cli_created',
      '/developers/v1/event/switch/cli_created',
      '/developers/v1/secret/cli_created',
    ]);
  });

  it('stops before app/create when the account or tenant changed after the UI confirmation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-identity-race-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const post = vi.fn();
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === 'https://open.feishu.cn/app') return new Response(openPlatformPage(), { status: 200 });
      post(href, init);
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await createFeishuOpenPlatformApp({
      name: 'must-not-exist',
      sessionFilePath: sessionFile,
      disableQrLogin: true,
      disableBytedcliFallback: true,
      expectedIdentity: { userId: 'u_1', tenantId: 'another_tenant' },
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: false, reason: 'session_changed' });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('automateOpenPlatformSetup', () => {
  it('returns login failure so setup can fall back to manual steps without aborting', async () => {
    const fetchImpl = (async () => {
      throw new Error('login down');
    }) as typeof fetch;
    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: join(tmpdir(), `botmux-missing-${Date.now()}.json`),
      disableBytedcliFallback: true,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
      onQrCode: () => {},
      maxWaitMs: 1,
    });

    expect(result).toMatchObject({ ok: false, reason: 'login_failed' });
  });

  it('uses botmux session cookies, page csrf, and calls the expected Open Platform endpoints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const sub = openPlatformSubscriptionMock('cli_x');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init: init ?? {} });
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) {
        return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      }
      if (href.includes('/scope/all/')) {
        return Response.json({
          code: 0,
          data: {
            appScopeList: [{ id: 'tenant-1', name: 'im:message' }],
            userScopeList: [{ id: 'user-1', name: 'auth:user_access_token:read' }],
          },
        });
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: ['auth:user_access_token:read'] } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sessionSource).toBe('botmux_cache');
    expect(calls.filter(call => new URL(call.url).host === 'open.feishu.cn').map(call => new URL(call.url).pathname)).toEqual([
      '/app/cli_x/auth',
      '/developers/v1/scope/all/cli_x',
      '/developers/v1/scope/update/cli_x',
      '/developers/v1/robot/switch/cli_x',
      '/developers/v1/event/switch/cli_x',
      '/developers/v1/event/cli_x',
      '/developers/v1/event/update/cli_x',
      '/developers/v1/event/cli_x',
      '/developers/v1/callback/cli_x',
      '/developers/v1/callback/switch/cli_x',
      '/developers/v1/callback/cli_x',
      '/developers/v1/callback/update/cli_x',
      '/developers/v1/callback/cli_x',
      '/developers/v1/safe_setting/update/cli_x',
      '/developers/v1/contact_range/cli_x',
      '/developers/v1/app_version/list/cli_x',
      '/developers/v1/app_version/create/cli_x',
      '/developers/v1/publish/commit/cli_x/v1',
    ]);
    const updateCall = calls.find(call => call.url.includes('/scope/update/'));
    expect(new Headers(updateCall?.init.headers).get('x-csrf-token')).toBe('csrf_auto');
    expect(new Headers(updateCall?.init.headers).get('cookie')).toBe('session=secret-cookie-value');
    expect(JSON.parse(String(updateCall?.init.body))).toMatchObject({
      clientId: 'cli_x',
      appScopeIDs: ['tenant-1'],
      userScopeIDs: ['user-1'],
    });
  });

  it('uses the redirected Open Platform origin for API calls and referer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const sub = openPlatformSubscriptionMock('cli_x');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, init: init ?? {} });
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === 'https://open.feishu.cn/app/cli_x/auth') {
        return new Response('', {
          status: 302,
          headers: { location: 'https://open.larkoffice.com/app/cli_x/auth' },
        });
      }
      if (href === 'https://open.larkoffice.com/app/cli_x/auth') {
        return new Response('<script>window.csrfToken="csrf_larkoffice"</script>', {
          status: 200,
          headers: {
            'set-cookie': 'lark_oapi_csrf_token=csrf_larkoffice_cookie; Domain=.larkoffice.com; Path=/; Secure',
          },
        });
      }
      if (href.includes('/scope/all/')) {
        return Response.json({
          code: 0,
          data: {
            appScopeList: [{ id: 'tenant-1', name: 'im:message' }],
            userScopeList: [{ id: 'user-1', name: 'auth:user_access_token:read' }],
          },
        });
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: ['auth:user_access_token:read'] } },
    });

    expect(result.ok).toBe(true);
    expect(calls.filter(call => new URL(call.url).host === 'open.larkoffice.com').map(call => new URL(call.url).pathname)).toEqual([
      '/app/cli_x/auth',
      '/developers/v1/scope/all/cli_x',
      '/developers/v1/scope/update/cli_x',
      '/developers/v1/robot/switch/cli_x',
      '/developers/v1/event/switch/cli_x',
      '/developers/v1/event/cli_x',
      '/developers/v1/event/update/cli_x',
      '/developers/v1/event/cli_x',
      '/developers/v1/callback/cli_x',
      '/developers/v1/callback/switch/cli_x',
      '/developers/v1/callback/cli_x',
      '/developers/v1/callback/update/cli_x',
      '/developers/v1/callback/cli_x',
      '/developers/v1/safe_setting/update/cli_x',
      '/developers/v1/contact_range/cli_x',
      '/developers/v1/app_version/list/cli_x',
      '/developers/v1/app_version/create/cli_x',
      '/developers/v1/publish/commit/cli_x/v1',
    ]);
    const updateCall = calls.find(call => call.url === 'https://open.larkoffice.com/developers/v1/scope/update/cli_x');
    const updateHeaders = new Headers(updateCall?.init.headers);
    expect(updateHeaders.get('origin')).toBe('https://open.larkoffice.com');
    expect(updateHeaders.get('referer')).toBe('https://open.larkoffice.com/app/cli_x');
    expect(updateHeaders.get('x-csrf-token')).toBe('csrf_larkoffice');
    expect(updateHeaders.get('cookie')).toContain('lark_oapi_csrf_token=csrf_larkoffice_cookie');
  });

  it('treats a rejected scope batch as success (partial-permission tenants) and still configures redirect + version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const sub = openPlatformSubscriptionMock('cli_x');
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [{ id: 't1', name: 'im:message' }], userScopeList: [] } });
      }
      if (href.includes('/scope/update/')) return Response.json({ code: 1, msg: 'scope not grantable for tenant' });
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopeCount).toBe(0);
      expect(result.scopeWarning).toBeTruthy();
      expect(result.versionId).toBe('v1');
    }
    // 权限被租户拒绝不阻塞后续：redirect / 版本 / 发布仍然走完。
    expect(calls.some(u => u.includes('/safe_setting/update/'))).toBe(true);
    expect(calls.some(u => u.includes('/publish/commit/'))).toBe(true);
  });

  it('skips scope update when no manifest scope exists in this tenant catalog, still succeeding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const sub = openPlatformSubscriptionMock('cli_x');
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [], userScopeList: [] } });
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message', 'contact:user.base:readonly'], user: ['auth:user_access_token:read'] } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopeCount).toBe(0);
      expect(result.skippedScopeCount).toBe(3);
    }
    expect(calls.some(u => u.includes('/scope/update/'))).toBe(false);
  });

  function subscriptionFetchImpl(sub: ReturnType<typeof openPlatformSubscriptionMock>, calls: string[]) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [{ id: 't1', name: 'im:message' }], userScopeList: [] } });
      }
      if (href.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;
  }

  async function runSetupWithMock(sessionDirPrefix: string, sub: ReturnType<typeof openPlatformSubscriptionMock>, calls: string[]) {
    const dir = mkdtempSync(join(tmpdir(), sessionDirPrefix));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    return automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl: subscriptionFetchImpl(sub, calls),
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
    });
  }

  it('subscribes baseline app events incrementally and the card callback via /callback endpoints', async () => {
    const sub = openPlatformSubscriptionMock('cli_x');
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-', sub, calls);

    expect(result.ok).toBe(true);
    const eventUpdate = sub.updateBodies.find(body => Array.isArray(body.appEvents));
    expect(eventUpdate).toMatchObject({ clientId: 'cli_x', operation: 'add', eventMode: 4, events: [] });
    expect(eventUpdate?.appEvents).toContain('im.message.receive_v1');
    expect(eventUpdate?.appEvents).toContain('im.chat.member.bot.added_v1');
    expect(eventUpdate?.appEvents).toContain('vc.bot.meeting_invited_v1');
    expect(eventUpdate?.appEvents).not.toContain('card.action.trigger');
    expect(eventUpdate?.userEvents).toEqual(['vc.meeting.participant_meeting_joined_v1']);
    const callbackUpdate = sub.updateBodies.find(body => Array.isArray(body.callbacks));
    expect(callbackUpdate).toMatchObject({ clientId: 'cli_x', operation: 'add', callbacks: ['card.action.trigger'], callbackMode: 4 });
    // 回调接收方式初始是 webhook(1),必须先切长连接再订阅
    expect(sub.state.callbackMode).toBe(4);
    if (result.ok) {
      expect(result.subscribedEventCount).toBeGreaterThanOrEqual(8);
      expect(result.eventWarning).toBeUndefined();
    }
  });

  it('is idempotent: already-subscribed apps get no event/callback update calls', async () => {
    const sub = openPlatformSubscriptionMock('cli_x', {
      initial: {
        appEvents: [
          'im.message.receive_v1',
          'im.chat.member.bot.added_v1',
          'im.chat.member.bot.deleted_v1',
          'drive.file.comment_add_v1',
          'drive.notice.comment_add_v1',
          'im.message.reaction.created_v1',
          'im.message.reaction.deleted_v1',
          'vc.bot.meeting_invited_v1',
          'vc.bot.meeting_activity_v1',
          'vc.bot.meeting_ended_v1',
        ],
        userEvents: ['vc.meeting.participant_meeting_joined_v1'],
        callbacks: ['card.action.trigger'],
        callbackMode: 4,
      },
    });
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-idem-', sub, calls);

    expect(result.ok).toBe(true);
    expect(sub.updateBodies).toEqual([]);
    expect(calls.some(u => u.includes('/callback/switch/'))).toBe(false);
  });

  it('fails closed when im.message.receive_v1 cannot be subscribed', async () => {
    const sub = openPlatformSubscriptionMock('cli_x', { failEventUpdate: true });
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-fail-', sub, calls);

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    if (!result.ok) {
      expect(result.message).toContain('im.message.receive_v1');
      expect(result.eventWarning).toBeTruthy();
    }
    // 批量失败后逐个重试过:baseline 7 + VC app 3 + VC user 1 = 批量 1 次 + 单个 11 次
    expect(sub.updateBodies.filter(body => Array.isArray(body.appEvents)).length).toBe(12);
    // 核心事件缺失时不再继续发版,避免发布一个收不到消息的版本
    expect(calls.some(u => u.includes('/publish/commit/'))).toBe(false);
  });

  it('fails closed when the card.action.trigger callback cannot be subscribed', async () => {
    const sub = openPlatformSubscriptionMock('cli_x', { failCallbackUpdate: true });
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-cbfail-', sub, calls);

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    if (!result.ok) expect(result.message).toContain('card.action.trigger');
    expect(calls.some(u => u.includes('/publish/commit/'))).toBe(false);
  });
});
