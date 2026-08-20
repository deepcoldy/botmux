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
  BOT_BASELINE_APP_EVENTS,
  BOT_BASELINE_CALLBACKS,
  botmuxFeishuSessionFilePath,
  buildFeishuQrPayload,
  buildSafeSettingPayload,
  buildScopeUpdatePayload,
  createFeishuOpenPlatformApp,
  createOpenPlatformApiClient,
  extractOpenPlatformCsrfToken,
  extractOpenPlatformSessionIdentity,
  extractOpenPlatformScopeEntries,
  getCookieHeader,
  mapFeishuQrPollingStatus,
  mapManifestScopesToOpenPlatformIds,
  parseSetupOpenPlatformAutoFlag,
  prepareFeishuWebSession,
  readStoredCookiesFromSessionFile,
  safeErrorMessage,
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
  /** visible/online 响应体（不给时用「全员可见」的现行契约形态）。 */
  visibleOnline?: unknown;
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
    if (href.endsWith(`/developers/v1/visible/online/${appId}`)) {
      return Response.json(opts.visibleOnline ?? {
        code: 0,
        data: {
          whiteList: { departments: [], members: [], groups: [], isAll: 1 },
          blackList: { departments: [], members: [], groups: [], isAll: 0 },
        },
      });
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

  it('emits a structured scan confirmation only after Feishu reports the exact QR as scanned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-scan-confirmation-'));
    const sessionFile = join(dir, 'feishu-session.json');
    const confirmations: number[] = [];
    let pollingCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/accounts/qrlogin/init')) {
        return Response.json(
          { code: 0, data: { step_info: { token: 'qr-token' } } },
          { headers: { 'x-flow-key': 'flow-key' } },
        );
      }
      if (href.includes('/accounts/qrlogin/polling')) {
        pollingCount += 1;
        if (pollingCount === 1) {
          return Response.json({
            code: 0,
            data: { next_step: null, step_info: { status: 2 } },
          });
        }
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
      forceQrLogin: true,
      fetchImpl,
      pollIntervalMs: 0,
      maxWaitMs: 1000,
      onQrCode: () => {},
      onQrScanConfirmed: ({ confirmedAt }) => confirmations.push(confirmedAt),
    });

    expect(result.ok && result.source).toBe('qr_login');
    expect(confirmations).toHaveLength(1);
    expect(Number.isInteger(confirmations[0])).toBe(true);
  });

  it('does not fabricate a scan confirmation when Feishu jumps directly to enter_app', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-no-scan-confirmation-'));
    const sessionFile = join(dir, 'feishu-session.json');
    const onQrScanConfirmed = vi.fn();
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
      forceQrLogin: true,
      fetchImpl,
      pollIntervalMs: 0,
      maxWaitMs: 1000,
      onQrCode: () => {},
      onQrScanConfirmed,
    });

    expect(result.ok && result.source).toBe('qr_login');
    expect(onQrScanConfirmed).not.toHaveBeenCalled();
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

  // 应用已建成后,启用能力/发版/读 Secret 这几步撞宿主机↔飞书的瞬态网络抖动
  // (undici `fetch failed`),此前一次失败就把整条链路判死,用户被丢进「应用已创建
  // 但配置尚未完成」的手动恢复。幂等步骤(robot/switch、读 Secret)现在小步重试自愈,
  // 非幂等写(app_version/create、publish/commit)保持一次即抛,不重复提交。
  const transientCreateError = () =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });

  // 复用第一条 happy-path 的建应用流程,允许对指定 path 的前 N 次调用注入瞬态错误。
  function createAppFetchImpl(
    calls: string[],
    inject: (path: string, attempt: number) => void = () => {},
  ): typeof fetch {
    const attempts = new Map<string, number>();
    return (async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === 'https://open.feishu.cn/app') return new Response(openPlatformPage(), { status: 200 });
      const path = new URL(href).pathname;
      calls.push(path);
      const attempt = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, attempt);
      inject(path, attempt); // 可 throw 瞬态错误
      if (path === '/developers/v1/app/upload/image') {
        return Response.json({ code: 0, data: { url: 'https://cdn.example/botmux.png' } });
      }
      if (path === '/developers/v1/manifest/upsert_by_template') {
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
  }

  it('建成后读 Secret 撞一次瞬态网络错误能自愈,不再把用户丢进手动恢复', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-secret-retry-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = createAppFetchImpl(calls, (path, attempt) => {
      if (path === '/developers/v1/secret/cli_created' && attempt === 1) throw transientCreateError();
    });

    const result = await createFeishuOpenPlatformApp({
      name: 'botmux-secret-retry',
      sessionFilePath: sessionFile,
      disableBytedcliFallback: true,
      fetchImpl,
      onQrCode: () => {},
    });

    expect(result).toMatchObject({ ok: true, appId: 'cli_created', appSecret: 'created-secret' });
    // secret 读取重试了一次(首次 + 重试);version/create 只发一次(未受影响)
    expect(calls.filter(p => p === '/developers/v1/secret/cli_created')).toHaveLength(2);
    expect(calls.filter(p => p === '/developers/v1/app_version/create/cli_created')).toHaveLength(1);
  });

  it('建成后启用机器人能力(robot/switch)撞一次瞬态网络错误能自愈', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-robot-retry-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = createAppFetchImpl(calls, (path, attempt) => {
      if (path === '/developers/v1/robot/switch/cli_created' && attempt === 1) throw transientCreateError();
    });

    const result = await createFeishuOpenPlatformApp({
      name: 'botmux-robot-retry',
      sessionFilePath: sessionFile,
      disableBytedcliFallback: true,
      fetchImpl,
      onQrCode: () => {},
    });

    expect(result).toMatchObject({ ok: true, appId: 'cli_created', appSecret: 'created-secret' });
    expect(calls.filter(p => p === '/developers/v1/robot/switch/cli_created')).toHaveLength(2);
  });

  it('非幂等的上架发版(app_version/create)传输错误一次即抛,绝不重试重复建版', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-version-noretry-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const calls: string[] = [];
    const fetchImpl = createAppFetchImpl(calls, (path) => {
      // 每次都抛:若被误当幂等重试,calls 里会出现多次
      if (path === '/developers/v1/app_version/create/cli_created') throw transientCreateError();
    });

    const result = await createFeishuOpenPlatformApp({
      name: 'botmux-version-noretry',
      sessionFilePath: sessionFile,
      disableBytedcliFallback: true,
      fetchImpl,
      onQrCode: () => {},
    });

    // 应用已建成但发版失败:带 appId 供调用方兜底/提示(手动恢复路径)
    expect(result).toMatchObject({ ok: false, reason: 'api_error', appId: 'cli_created' });
    expect(calls.filter(p => p === '/developers/v1/app_version/create/cli_created')).toHaveLength(1);
  });
});

describe('automateOpenPlatformSetup', () => {
  it('forwards forceQrLogin so configure --switch-account ignores a valid cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-auto-force-'));
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
      if (href.endsWith('/app/cli_x/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/cli_x')) return Response.json({ code: 1, msg: 'stop after login' });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      forceQrLogin: true,
      disableBytedcliFallback: true,
      fetchImpl,
      pollIntervalMs: 0,
      maxWaitMs: 1000,
      onQrCode: () => {},
    });

    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
    expect(initCount).toBe(1);
    expect(readStoredCookiesFromSessionFile(sessionFile)?.find(c => c.name === 'session')?.value).toBe('fresh-cookie');
  });

  it('classifies an exact app access denial as an owner-session mismatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-owner-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_owner"</script>', { status: 200 });
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 10003, msg: '无权限访问' }, { status: 403 });
      }
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_owner',
      sessionFilePath: sessionFile,
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: false, reason: 'owner_session_mismatch' });
  });

  it('does not classify a non-403 code 10003 response as an owner-session mismatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-open-platform-owner-status-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_owner"</script>', { status: 200 });
      if (href.includes('/scope/all/')) return Response.json({ code: 10003, msg: 'other business error' });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await automateOpenPlatformSetup({
      appId: 'cli_owner',
      sessionFilePath: sessionFile,
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, reason: 'api_error' });
  });

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
      '/developers/v1/visible/online/cli_x',
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
      '/developers/v1/visible/online/cli_x',
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

  function subscriptionFetchImpl(
    sub: ReturnType<typeof openPlatformSubscriptionMock>,
    calls: string[],
    versionId: string | null = 'v1',
  ) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push(href);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href.endsWith('/auth')) return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      if (href.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [{ id: 't1', name: 'im:message' }], userScopeList: [] } });
      }
      if (href.includes('/app_version/create/')) {
        return Response.json({ code: 0, data: versionId ? { versionId } : {} });
      }
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;
  }

  async function runSetupWithMock(
    sessionDirPrefix: string,
    sub: ReturnType<typeof openPlatformSubscriptionMock>,
    calls: string[],
    options: { requireVerifiedEvents?: boolean; versionId?: string | null } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), sessionDirPrefix));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    return automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl: subscriptionFetchImpl(sub, calls, options.versionId === undefined ? 'v1' : options.versionId),
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
      requireVerifiedEvents: options.requireVerifiedEvents,
    });
  }

  it('returns an exact event and version ack from the same managed session', async () => {
    const sub = openPlatformSubscriptionMock('cli_x');
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-managed-', sub, calls, {
      requireVerifiedEvents: true,
    });

    expect(result).toMatchObject({
      ok: true,
      eventMode: 4,
      verifiedEventCount: BOT_BASELINE_APP_EVENTS.length + BOT_BASELINE_CALLBACKS.length,
      versionId: 'v1',
    });
  });

  it('fails managed activation when one baseline event is still missing after same-session readback', async () => {
    const sub = openPlatformSubscriptionMock('cli_x', {
      rejectEventNames: ['im.chat.member.bot.added_v1'],
    });
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-managed-missing-', sub, calls, {
      requireVerifiedEvents: true,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'event_verification_failed',
    });
  });

  it('fails managed activation when the published version cannot be proven', async () => {
    const sub = openPlatformSubscriptionMock('cli_x');
    const calls: string[] = [];
    const result = await runSetupWithMock('botmux-sub-managed-version-', sub, calls, {
      requireVerifiedEvents: true,
      versionId: null,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'version_verification_failed',
    });
  });

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
          'drive.notice.comment_add_v1',
          'im.message.reaction.created_v1',
          'im.message.reaction.deleted_v1',
          'im.chat.member.user.added_v1',
          'im.chat.member.user.deleted_v1',
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
    // 批量失败后逐个重试过:baseline 6 + 可选 user 事件 2 + VC app 3 + VC user 1 = 批量 1 次 + 单个 12 次
    expect(sub.updateBodies.filter(body => Array.isArray(body.appEvents)).length).toBe(13);
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
      expect(result.subscribedEventCount).toBe(9); // 6 baseline 事件 + 2 可选 user 事件 + 1 回调
      expect(result.eventWarning).toContain('VC 会议事件未确认订阅');
      // VC listener 保存门必须拦下这种结果(dashboard 两条分支都走这个门)
      expect(vcListenerEventGateError(result)).toContain('vc.bot.meeting_invited_v1');
    }
  });

  it('fails closed and blocks the listener gate when event mode readback stays webhook despite full subscriptions', async () => {
    // event/switch 返回成功(mock 默认 code 0)但回读 eventMode 仍是 1:
    // 订阅名齐、count=11、missingVcEvents=[],唯一异常是接收方式。
    const sub = openPlatformSubscriptionMock('cli_x', {
      initial: {
        eventMode: 1,
        appEvents: [
          'im.message.receive_v1',
          'im.chat.member.bot.added_v1',
          'im.chat.member.bot.deleted_v1',
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
      // dashboard 非登录失败分支的 listener 门必须拦下(此前 count=11/missingVc=[] 会放行)
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

/**
 * 回归：自动发版必须原样镜像线上可见范围。
 *
 * 历史 bug —— 这里读的是 `contact_range`（通讯录权限范围）且只取 members，
 * `departments` / `groups` / `isAll` 在版本 payload 里写死空值。由于
 * `app_version/create` 的 visibleSuggest 是**全量覆写**语义，每次权限自愈自动
 * 发版都把「全员可见 / 按部门授权 / 按用户组授权」静默清成「仅少数个人可见」，
 * 升级次日大量用户访问不了应用。
 */
describe('automateOpenPlatformSetup 版本可见范围', () => {
  const visibilityFetch = (appId: string, sub: ReturnType<typeof openPlatformSubscriptionMock>, calls: string[]) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === 'https://ask.feishu.cn/') return new Response('ask home', { status: 200 });
      if (href === `https://open.feishu.cn/app/${appId}/auth`) {
        return new Response('<script>window.csrfToken="csrf_auto"</script>', { status: 200 });
      }
      const path = new URL(href).pathname;
      calls.push(path);
      if (path.includes('/scope/all/')) {
        return Response.json({ code: 0, data: { appScopeList: [{ id: 'tenant-1', name: 'im:message' }], userScopeList: [] } });
      }
      if (path.includes('/app_version/create/')) return Response.json({ code: 0, data: { versionId: 'v1' } });
      return sub.handle(href, init) ?? Response.json({ code: 0 });
    }) as typeof fetch;

  const runWith = async (visibleOnline: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-visibility-'));
    const sessionFile = join(dir, 'feishu-session.json');
    writeStoredCookiesToSessionFile(sessionFile, [cookie()]);
    const sub = openPlatformSubscriptionMock('cli_x', { visibleOnline });
    const calls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const inner = visibilityFetch('cli_x', sub, calls);
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes('/app_version/create/')) bodies.push(JSON.parse(String(init?.body)));
      return inner(url, init);
    }) as typeof fetch;
    const result = await automateOpenPlatformSetup({
      appId: 'cli_x',
      sessionFilePath: sessionFile,
      fetchImpl,
      scopeManifest: { scopes: { tenant: ['im:message'], user: [] } },
    });
    return { result, calls, versionBody: bodies[0] };
  };

  it('把线上的全员可见 / 部门 / 用户组原样镜像进新版本，而不是清空', async () => {
    const { result, versionBody } = await runWith({
      code: 0,
      data: {
        whiteList: {
          departments: [{ id: 'od_sales' }, { id: 'od_eng' }],
          members: [{ id: 'ou_alice' }],
          groups: [{ id: 'g_oncall' }],
          isAll: 1,
        },
        blackList: { departments: [], members: [{ id: 'ou_banned' }], groups: [], isAll: 0 },
      },
    });

    expect(result.ok).toBe(true);
    // 四个集合一个都不能丢：isAll=1 掉成 0 就是「全员可见」被撤销，
    // departments/groups 清空就是按部门/用户组授权的人全部失去访问。
    expect(versionBody.visibleSuggest).toEqual({
      departments: ['od_sales', 'od_eng'],
      members: ['ou_alice'],
      groups: ['g_oncall'],
      isAll: 1,
    });
    // 黑名单同样要镜像：丢了就把被拉黑的人重新放进来。
    expect(versionBody.blackVisibleSuggest).toEqual({
      departments: [], members: ['ou_banned'], groups: [], isAll: 0,
    });
  });

  it('读的是 visible/online（应用可见范围），不再读 contact_range（通讯录权限范围）', async () => {
    const { calls } = await runWith(undefined);
    expect(calls).toContain('/developers/v1/visible/online/cli_x');
    expect(calls).not.toContain('/developers/v1/contact_range/cli_x');
  });

  it('可见范围响应形态不认识时 fail closed：不建版、不发布', async () => {
    // isAll 是字符串 '1' —— 猜错方向就会把全员可见发布成不可见，宁可不发版。
    const { result, calls } = await runWith({
      code: 0,
      data: {
        whiteList: { departments: [], members: [], groups: [], isAll: '1' },
        blackList: { departments: [], members: [], groups: [], isAll: 0 },
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'visibility_unreadable' });
    expect(calls.some(path => path.includes('/app_version/create/'))).toBe(false);
    expect(calls.some(path => path.includes('/publish/commit/'))).toBe(false);
  });

  it('可见范围块缺键时同样 fail closed（残缺响应不得当成空可见范围）', async () => {
    const { result, calls } = await runWith({ code: 0, data: { whiteList: {}, blackList: {} } });

    expect(result).toMatchObject({ ok: false, reason: 'visibility_unreadable' });
    expect(calls.some(path => path.includes('/app_version/create/'))).toBe(false);
  });
});

// 宿主机到飞书的偶发网络抖动会让 undici 抛 TypeError('fetch failed')，一次失败
// 就中断整条 console 链路（dashboard 改名/改头像实测偶发中招）。页面读取 GET
// 幂等可重试；console POST 写操作传输错误时结果未知，绝不能重试。
describe('console 页面读取的瞬态网络错误重试', () => {
  const transientFetchError = () =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });

  it('GET 页面读取遇瞬态网络错误自动重试，抖一次不再让整条链路失败', async () => {
    let pageAttempts = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href === 'https://open.feishu.cn/app') {
        pageAttempts += 1;
        if (pageAttempts === 1) throw transientFetchError();
        return new Response(openPlatformPage(), { status: 200 });
      }
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const result = await createOpenPlatformApiClient([cookie()], { fetchImpl });
    expect(result.ok).toBe(true);
    expect(pageAttempts).toBe(2);
  });

  it('重试耗尽后返回 network 失败，message 带上 cause 里的真实网络错误', async () => {
    let pageAttempts = 0;
    const fetchImpl = (async () => {
      pageAttempts += 1;
      throw transientFetchError();
    }) as typeof fetch;

    const result = await createOpenPlatformApiClient([cookie()], { fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: 'network' });
    if (!result.ok) {
      expect(result.message).toContain('fetch failed');
      expect(result.message).toContain('ECONNRESET');
    }
    expect(pageAttempts).toBe(3); // 首次 + 2 次重试
  });

  it('console POST 写操作不重试：传输错误立刻抛出，避免重复提交', async () => {
    let postAttempts = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
        postAttempts += 1;
        throw transientFetchError();
      }
      if (href === 'https://open.feishu.cn/app') return new Response(openPlatformPage(), { status: 200 });
      throw new Error(`unexpected url: ${href}`);
    }) as typeof fetch;

    const clientResult = await createOpenPlatformApiClient([cookie()], { fetchImpl });
    expect(clientResult.ok).toBe(true);
    if (!clientResult.ok) return;
    await expect(clientResult.client.postJson('/developers/v1/app/cli_x', {})).rejects.toThrow('fetch failed');
    expect(postAttempts).toBe(1);
  });

  it('非网络错误不重试（mock/逻辑错误一次就失败，不白等退避）', async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      throw new Error('boom');
    }) as typeof fetch;

    const result = await createOpenPlatformApiClient([cookie()], { fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: 'network' });
    expect(attempts).toBe(1);
  });
});

describe('safeErrorMessage', () => {
  it('展开 undici fetch failed 的 cause 链，露出真实网络错误', () => {
    const err = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' }),
    });
    expect(safeErrorMessage(err)).toBe('fetch failed: connect ETIMEDOUT 1.2.3.4:443');
  });

  it('cause 是 happy-eyeballs 的 AggregateError 时取首个真实错误', () => {
    const err = new TypeError('fetch failed', {
      cause: new AggregateError([
        Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' }),
      ]),
    });
    expect(safeErrorMessage(err)).toBe('fetch failed: connect ECONNREFUSED 1.2.3.4:443');
  });

  it('message 里没有错误码时把 code 补进去', () => {
    const err = new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo failure'), { code: 'EAI_AGAIN' }),
    });
    expect(safeErrorMessage(err)).toBe('fetch failed: getaddrinfo failure (EAI_AGAIN)');
  });

  it('仍然脱敏长 token', () => {
    const err = new Error(`bad token ${'a'.repeat(32)}`);
    expect(safeErrorMessage(err)).toBe('bad token ***');
  });
});
