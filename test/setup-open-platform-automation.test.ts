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
  vcListenerEventGateError,
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
  /** callback/switch 直接报错。 */
  failCallbackSwitch?: boolean;
  /** callback/switch 返回成功但 mode 实际不变(回读兜底用例)。 */
  callbackSwitchNoop?: boolean;
  /** event/update 中包含这些事件时整批被拒(逐个重试时对应单个失败)。 */
  rejectEventNames?: string[];
  initial?: { appEvents?: string[]; userEvents?: string[]; callbacks?: string[]; callbackMode?: number; eventMode?: number };
} = {}) {
  const state = {
    eventMode: opts.initial?.eventMode ?? 4,
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
      const requested: string[] = [...(body.appEvents ?? []), ...(body.userEvents ?? [])];
      if (opts.failEventUpdate || requested.some(name => (opts.rejectEventNames ?? []).includes(name))) {
        return Response.json({ code: 1, msg: 'event update rejected' });
      }
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
      if (opts.failCallbackSwitch) return Response.json({ code: 1, msg: 'callback switch rejected' });
      const body = JSON.parse(String(init?.body));
      if (!opts.callbackSwitchNoop) state.callbackMode = body.callbackMode;
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
      if (path === '/developers/v1/manifest/upsert_by_template') {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          appManifestTemplateID: 'developer_console',
          createAppUserCustomField: {
            i18n: { zh_cn: { name: 'botmux-4' } },
            avatar: 'https://cdn.example/botmux.png',
            primaryLang: 'zh_cn',
          },
        });
        expect(typeof body.cid).toBe('string');
        expect(body.cid.length).toBeGreaterThan(0);
        return Response.json({ code: 0, data: { clientID: 'cli_created' } });
      }
      if (path === '/developers/v1/app_version/create/cli_created') {
        return Response.json({ code: 0, data: { versionId: 'v-enable' } });
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
    // 创建后立刻发布一个极简版本让应用上架启用(对齐 launcher),再读 secret
    expect(calls.map(call => call.path)).toEqual([
      '/developers/v1/app/upload/image',
      '/developers/v1/manifest/upsert_by_template',
      '/developers/v1/robot/switch/cli_created',
      '/developers/v1/event/switch/cli_created',
      '/developers/v1/app_version/create/cli_created',
      '/developers/v1/publish/commit/cli_created/v-enable',
      '/developers/v1/secret/cli_created',
    ]);
    // 版本可见成员含当前登录人(session identity userId),否则发布不自动上架
    const versionCall = calls.find(c => c.path === '/developers/v1/app_version/create/cli_created');
    expect(JSON.parse(String(versionCall?.body))).toMatchObject({ visibleSuggest: { members: ['u_1'] } });
  });

  it('falls back to plain app/create when the one-click template endpoint fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-fallback-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === 'https://open.feishu.cn/app') return new Response(openPlatformPage(), { status: 200 });
      const path = new URL(href).pathname;
      calls.push(path);
      if (path === '/developers/v1/app/upload/image') {
        return Response.json({ code: 0, data: { url: 'https://cdn.example/botmux.png' } });
      }
      if (path === '/developers/v1/manifest/upsert_by_template') {
        return Response.json({ code: 1, msg: 'template not available for this tenant' });
      }
      if (path === '/developers/v1/app/create') {
        expect(JSON.parse(String(init?.body))).toMatchObject({ name: 'botmux-5', appSceneType: 0 });
        return Response.json({ code: 0, data: { ClientID: 'cli_fallback' } });
      }
      if (path === '/developers/v1/app_version/create/cli_fallback') {
        return Response.json({ code: 0, data: { versionId: 'v-enable' } });
      }
      if (path === '/developers/v1/secret/cli_fallback') {
        return Response.json({ code: 0, data: { secret: 'fallback-secret' } });
      }
      return Response.json({ code: 0 });
    }) as typeof fetch;

    const result = await createFeishuOpenPlatformApp({
      name: 'botmux-5',
      sessionFilePath: sessionFile,
      disableBytedcliFallback: true,
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: true, appId: 'cli_fallback', appSecret: 'fallback-secret' });
    expect(calls).toEqual([
      '/developers/v1/app/upload/image',
      '/developers/v1/manifest/upsert_by_template',
      '/developers/v1/app/create',
      '/developers/v1/robot/switch/cli_fallback',
      '/developers/v1/event/switch/cli_fallback',
      '/developers/v1/app_version/create/cli_fallback',
      '/developers/v1/publish/commit/cli_fallback/v-enable',
      '/developers/v1/secret/cli_fallback',
    ]);
  });

  function outcomeUnknownFetchImpl(calls: string[], templateResponse: () => Response | Promise<Response>) {
    return (async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === 'https://open.feishu.cn/app') return new Response(openPlatformPage(), { status: 200 });
      const path = new URL(href).pathname;
      calls.push(path);
      if (path === '/developers/v1/app/upload/image') {
        return Response.json({ code: 0, data: { url: 'https://cdn.example/botmux.png' } });
      }
      if (path === '/developers/v1/manifest/upsert_by_template') {
        return templateResponse();
      }
      return Response.json({ code: 0 });
    }) as typeof fetch;
  }

  it('fails closed without cross-endpoint fallback when the template succeeds without a ClientID', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-noid-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const result = await createFeishuOpenPlatformApp({
      name: 'botmux-6',
      sessionFilePath: sessionFile,
      disableBytedcliFallback: true,
      // code=0 但响应缺 ClientID:应用可能已建成,禁止再走 app/create 重建
      fetchImpl: outcomeUnknownFetchImpl(calls, () => Response.json({ code: 0, data: {} })),
    });

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    if (!result.ok) expect(result.message).toContain('确认');
    expect(calls.filter(p => p === '/developers/v1/app/create')).toEqual([]);
  });

  it('fails closed without cross-endpoint fallback on ambiguous transport errors from the template endpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-transport-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const result = await createFeishuOpenPlatformApp({
      name: 'botmux-7',
      sessionFilePath: sessionFile,
      disableBytedcliFallback: true,
      // 传输错误(如 ECONNRESET):服务端可能已 commit,结果未知,不得重建
      fetchImpl: outcomeUnknownFetchImpl(calls, () => { throw new Error('socket hang up (ECONNRESET)'); }),
    });

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    expect(calls.filter(p => p === '/developers/v1/app/create')).toEqual([]);
  });

  it('fails closed without cross-endpoint fallback on HTTP 5xx from the template endpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-5xx-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const result = await createFeishuOpenPlatformApp({
      name: 'botmux-8',
      sessionFilePath: sessionFile,
      disableBytedcliFallback: true,
      // 5xx:服务端内部错误,可能已部分落库,结果未知
      fetchImpl: outcomeUnknownFetchImpl(calls, () => new Response('oops', { status: 502 })),
    });

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    expect(calls.filter(p => p === '/developers/v1/app/create')).toEqual([]);
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

  it('fails closed when the callback long-connection switch fails even with the callback already subscribed', async () => {
    const sub = openPlatformSubscriptionMock('cli_x', {
      failCallbackSwitch: true,
      initial: { callbacks: ['card.action.trigger'], callbackMode: 1 },
    });
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-swfail-', sub, calls);

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    if (!result.ok) expect(result.message).toContain('回调接收模式');
    expect(sub.state.callbackMode).toBe(1);
    expect(calls.some(u => u.includes('/publish/commit/'))).toBe(false);
  });

  it('fails closed when callback mode readback still shows webhook after a successful switch call', async () => {
    const sub = openPlatformSubscriptionMock('cli_x', {
      callbackSwitchNoop: true,
      initial: { callbacks: ['card.action.trigger'], callbackMode: 1 },
    });
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-swnoop-', sub, calls);

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    if (!result.ok) expect(result.message).toContain('回调接收模式');
    expect(calls.some(u => u.includes('/publish/commit/'))).toBe(false);
  });

  it('keeps plain bot setup ok when only VC events fail, but reports missingVcEvents for the listener gate', async () => {
    const vcEvents = [
      'vc.bot.meeting_invited_v1',
      'vc.bot.meeting_activity_v1',
      'vc.bot.meeting_ended_v1',
      'vc.meeting.participant_meeting_joined_v1',
    ];
    const sub = openPlatformSubscriptionMock('cli_x', { rejectEventNames: vcEvents });
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-vc-', sub, calls);

    // 普通建 bot:baseline+回调齐 → 不阻断,照常发版
    expect(result.ok).toBe(true);
    expect(calls.some(u => u.includes('/publish/commit/'))).toBe(true);
    if (result.ok) {
      expect(result.missingVcEvents).toEqual(vcEvents);
      expect(result.subscribedEventCount).toBe(8); // 7 baseline 事件 + 1 回调
      expect(result.eventWarning).toContain('VC 会议事件未确认订阅');
      // VC listener 保存门必须拦下这种结果(dashboard 两条分支都走这个门)
      expect(vcListenerEventGateError(result)).toContain('vc.bot.meeting_invited_v1');
    }
  });

  it('fails closed and blocks the listener gate when event mode readback stays webhook despite full subscriptions', async () => {
    // event/switch 返回成功(mock 默认 code 0)但回读 eventMode 仍是 1:
    // 订阅名齐、count=12、missingVcEvents=[],唯一异常是接收方式。
    const sub = openPlatformSubscriptionMock('cli_x', {
      initial: {
        eventMode: 1,
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
    const result = await runSetupWithMock('botmux-sub-evmode-', sub, calls);

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    if (!result.ok) {
      expect(result.message).toContain('事件接收模式');
      expect(result.eventModeReady).toBe(false);
      expect(result.missingVcEvents).toEqual([]);
      // dashboard 非登录失败分支的 listener 门必须拦下(此前 count=12/missingVc=[] 会放行)
      expect(vcListenerEventGateError(result)).toContain('长连接');
    }
    expect(calls.some(u => u.includes('/publish/commit/'))).toBe(false);
  });

  it('vcListenerEventGateError passes clean results and blocks zero-subscription, missing-VC or mode-not-ready results', () => {
    expect(vcListenerEventGateError({ subscribedEventCount: 12, missingVcEvents: [], eventModeReady: true })).toBeNull();
    expect(vcListenerEventGateError({ eventWarning: 'boom', subscribedEventCount: 0 })).toContain('事件订阅全部失败');
    expect(vcListenerEventGateError({ subscribedEventCount: 8, missingVcEvents: ['vc.bot.meeting_ended_v1'], eventModeReady: true }))
      .toContain('vc.bot.meeting_ended_v1');
    expect(vcListenerEventGateError({ subscribedEventCount: 12, missingVcEvents: [], eventModeReady: false }))
      .toContain('长连接');
    // 走不到订阅阶段的早期失败(missingVcEvents/eventModeReady 均 undefined)保持原 best-effort 语义
    expect(vcListenerEventGateError({})).toBeNull();
  });
});
