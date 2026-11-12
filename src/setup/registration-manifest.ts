import { setTimeout as delay } from 'node:timers/promises';
import type { AppAddons } from '@larksuiteoapi/node-sdk';
import { larkHosts } from '../im/lark/lark-hosts.js';
import {
  BOT_BASELINE_APP_EVENTS,
  BOT_BASELINE_CALLBACKS,
  BOT_CRITICAL_APP_EVENTS,
  BOT_OPTIONAL_APP_EVENTS,
  VC_MEETING_APP_EVENTS,
  VC_MEETING_USER_EVENTS,
  collectBotmuxRedirectUrls,
  readDefaultScopeManifest,
  type OpenPlatformAutomationOptions,
  type OpenPlatformAutomationResult,
  type ScopeManifest,
} from './open-platform-automation.js';
import type { RegisterAppOk, RegisterAppOptions } from './register-app.js';

type ScopeBuckets = { tenant: string[]; user: string[] };
type ScopeGrant = { scope_name?: string; scope_type?: string; grant_status?: number };
type RegistrationIdentity = Pick<RegisterAppOk, 'appId' | 'appSecret' | 'brand'>;

// 已在 PersonalAgent 确认页验证无法授予。清单已有细分 base:*；旧总权限仅保留给手动导入。
const WEB_ONLY_SCOPES = new Set(['bitable:app']);

export function registrationScopeBuckets(manifest: ScopeManifest = readDefaultScopeManifest()): ScopeBuckets {
  return {
    tenant: [...new Set(manifest.scopes?.tenant)].filter(name => !WEB_ONLY_SCOPES.has(name)),
    user: [...new Set(manifest.scopes?.user)].filter(name => !WEB_ONLY_SCOPES.has(name)),
  };
}

export function createRegistrationOptions(name = '{user} 的 botmux', manifest?: ScopeManifest): Pick<RegisterAppOptions, 'addons' | 'appPreset'> {
  return {
    appPreset: { name, desc: '通过飞书使用 botmux 连接本机 AI Agent' },
    addons: {
      preset: false,
      scopes: registrationScopeBuckets(manifest),
      events: { items: { tenant: [...BOT_BASELINE_APP_EVENTS, ...BOT_OPTIONAL_APP_EVENTS, ...VC_MEETING_APP_EVENTS], user: [...VC_MEETING_USER_EVENTS] } },
      callbacks: { items: [...BOT_BASELINE_CALLBACKS] },
    },
  };
}

export function diffScopeBuckets(wanted: ScopeBuckets, granted: ScopeBuckets): ScopeBuckets {
  const tenant = new Set(granted.tenant);
  const user = new Set(granted.user);
  return { tenant: wanted.tenant.filter(name => !tenant.has(name)), user: wanted.user.filter(name => !user.has(name)) };
}

export function scopeBucketCount(scopes: ScopeBuckets): number {
  return scopes.tenant.length + scopes.user.length;
}

export function describeMissingScopes(scopes: ScopeBuckets): string {
  return [scopes.tenant.length && `tenant: ${scopes.tenant.join(', ')}`,
    scopes.user.length && `user: ${scopes.user.join(', ')}`].filter(Boolean).join(' / ');
}

export function compareScopeGrants(wanted: ScopeBuckets, rows: ScopeGrant[]) {
  const granted: ScopeBuckets = { tenant: [], user: [] };
  for (const row of rows) {
    if (row?.grant_status !== 1 || typeof row.scope_name !== 'string') continue;
    if (row.scope_type === 'tenant' || row.scope_type === 'user') granted[row.scope_type].push(row.scope_name);
  }
  const missing = diffScopeBuckets(wanted, granted);
  const missingCount = scopeBucketCount(missing);
  return { missing, granted, grantedCount: scopeBucketCount(wanted) - missingCount };
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T | undefined> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8_000), redirect: 'error' });
    return await res.json() as T;
  } catch {
    return undefined;
  }
}

async function registrationToken(identity: RegistrationIdentity): Promise<string | undefined> {
  const { appId, appSecret, brand } = identity;
  const body = await requestJson<{ code?: number; tenant_access_token?: string }>(
    `${larkHosts(brand).openApi}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    },
  );
  return body?.code === 0 ? body.tenant_access_token : undefined;
}

async function readGrants(brand: RegistrationIdentity['brand'], token: string, wanted: ScopeBuckets) {
  const result = await requestJson<{ code?: number; data?: { scopes?: ScopeGrant[] } }>(
    `${larkHosts(brand).openApi}/open-apis/application/v6/scopes`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (result?.code === 0 && Array.isArray(result.data?.scopes)) {
    return { grants: compareScopeGrants(wanted, result.data.scopes), denied: false };
  }
  return { denied: result?.code === 99991672 };
}

export async function readRegistrationScopes(identity: RegistrationIdentity, wanted: ScopeBuckets) {
  const token = await registrationToken(identity);
  return token ? (await readGrants(identity.brand, token, wanted)).grants : undefined;
}

/** 只在完整创建清单上判断灰度。增量修复无结果时也可能是单项不可授予。 */
export function classifyCreationGrants(wanted: ScopeBuckets, readback: ReturnType<typeof compareScopeGrants>) {
  if (scopeBucketCount(readback.missing) === 0) return 'complete';
  // 默认模板本身会给少量 tenant scope。按 tenant 桶检测，避免把 user 桶的租户限制误判为灰度。
  const tenantGranted = wanted.tenant.length - readback.missing.tenant.length;
  return tenantGranted <= Math.floor(wanted.tenant.length / 10) ? 'likely_ignored' : 'partial';
}

interface AppInfo {
  online_version_id?: string;
  redirect_urls?: string[];
  security?: { redirect_urls?: string[] };
  event?: { subscription_type?: string; subscribed_events?: string[] };
  callback?: { callback_type?: string; subscribed_callbacks?: string[] };
  callback_info?: { callback_type?: string; subscribed_callbacks?: string[] };
}

async function readAppInfo(origin: string, appId: string, headers: HeadersInit): Promise<AppInfo | undefined> {
  const result = await requestJson<{ code?: number; data?: { app?: AppInfo } }>(
    `${origin}/open-apis/application/v6/applications/${encodeURIComponent(appId)}?lang=zh_cn`,
    { headers },
  );
  return result?.code === 0 ? result.data?.app : undefined;
}

function hasLiveSubscriptions(app: AppInfo | undefined): boolean {
  const callback = app?.callback_info ?? app?.callback;
  return Boolean(app?.online_version_id
    && app.event?.subscription_type === 'websocket'
    && BOT_CRITICAL_APP_EVENTS.every(name => app.event?.subscribed_events?.includes(name))
    && callback?.callback_type === 'websocket'
    && BOT_BASELINE_CALLBACKS.every(name => callback.subscribed_callbacks?.includes(name)));
}

function missingRedirects(app: AppInfo | undefined, wanted: string[]): string[] {
  const actual = new Set(app?.security?.redirect_urls ?? app?.redirect_urls);
  return wanted.filter(url => !actual.has(url));
}

type WebAutomation = (options: OpenPlatformAutomationOptions) => Promise<OpenPlatformAutomationResult>;

/** 优先用线上回读确认注册页已生效。回读不足时按实际缺口补配置。 */
export async function completeRegisteredApp(
  identity: RegistrationIdentity,
  addons: AppAddons,
  web: WebAutomation,
  options: Pick<OpenPlatformAutomationOptions, 'onQrCode' | 'onStatus' | 'disableQrLogin' | 'sessionFilePath' | 'disableBytedcliFallback'> = {},
): Promise<OpenPlatformAutomationResult> {
  const wanted = { tenant: addons.scopes?.tenant ?? [], user: addons.scopes?.user ?? [] };
  const token = await registrationToken(identity);
  const { appId, brand } = identity;
  let scopeRead = token ? await readGrants(brand, token, wanted) : undefined;
  if (token && (scopeRead?.denied || (scopeRead?.grants && classifyCreationGrants(wanted, scopeRead.grants) === 'likely_ignored'))) {
    // 刚确认时授权可能仍在传播。再读一次后才决定是否进入网页补配。
    await delay(2_000);
    scopeRead = await readGrants(brand, token, wanted);
  }
  const readback = scopeRead?.grants;
  const status = readback ? classifyCreationGrants(wanted, readback) : 'unverified';
  const warning = status === 'complete' ? undefined
    : readback ? `注册权限回读缺失 ${scopeBucketCount(readback.missing)} 项（${describeMissingScopes(readback.missing)}）`
    : '无法回读应用授权状态，请到开放平台确认权限';
  const needsScopeFallback = status === 'likely_ignored' || scopeRead?.denied === true;
  await options.onStatus?.(status === 'likely_ignored'
    ? '注册后只查到极少数清单权限，当前租户可能未开启 addons 灰度。'
    : warning ?? `已回读确认 ${readback?.grantedCount} 项权限`);

  const origin = larkHosts(brand).openApi;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let app = token ? await readAppInfo(origin, appId, headers) : undefined;
  const redirectUrls = collectBotmuxRedirectUrls();
  const urls = missingRedirects(app, redirectUrls);
  const needsSocketMode = app?.event?.subscription_type !== 'websocket'
    || (app?.callback_info ?? app?.callback)?.callback_type !== 'websocket';
  if (token && (urls.length > 0 || needsSocketMode)) {
    const patch = (data: object) => requestJson<{ code?: number }>(
      `${origin}/open-apis/application/v7/applications/${encodeURIComponent(appId)}/config`,
      { method: 'PATCH', headers, body: JSON.stringify(data) },
    );
    // 分开提交，确保其中一项被租户拒绝时另一项仍可生效。redirect 用增量 add。
    if (urls.length > 0) await patch({ security: { add: { redirect_urls: urls } } });
    if (needsSocketMode) {
      await patch({ event: { subscription_type: 'websocket' }, callback: { callback_type: 'websocket' } });
    }
    app = await readAppInfo(origin, appId, headers) ?? app;
  }

  let redirectConfigured = missingRedirects(app, redirectUrls).length === 0;
  if (brand === 'feishu' && (needsScopeFallback || !hasLiveSubscriptions(app))) {
    await options.onStatus?.('将用网页补配当前应用。');
    const fallback = await web({
      ...options, appId, brand,
      scopeManifest: { scopes: needsScopeFallback ? readback?.missing ?? wanted : { tenant: [], user: [] } },
      // 保留已发布版本，旧网页路径只有补配有变化时才发版。
      appJustCreated: !app?.online_version_id,
      redirectAlreadyConfigured: redirectConfigured,
    });
    const finalReadback = needsScopeFallback ? await readRegistrationScopes(identity, wanted) : readback;
    const scopeWarning = finalReadback
      ? scopeBucketCount(finalReadback.missing) > 0
        ? `授权回读仍缺失 ${scopeBucketCount(finalReadback.missing)} 项（${describeMissingScopes(finalReadback.missing)}）`
        : undefined
      : '网页补配后未能回读授权状态';
    const redirect = redirectConfigured
      ? { redirectConfigured: true, redirectWarning: undefined }
      : { redirectConfigured: fallback.redirectConfigured, redirectWarning: fallback.redirectWarning };
    if (!fallback.ok) {
      return { ...fallback, ...redirect, message: [fallback.message, scopeWarning].filter(Boolean).join('。') };
    }
    return {
      ...fallback,
      redirectConfigured: redirect.redirectConfigured === true,
      redirectWarning: redirect.redirectWarning,
      scopeCount: finalReadback?.grantedCount ?? 0,
      scopeWarning: [fallback.scopeWarning, scopeWarning].filter(Boolean).join('。') || undefined,
    };
  }

  if (needsScopeFallback || !hasLiveSubscriptions(app)) {
    return {
      ok: false,
      reason: brand === 'lark' ? 'unsupported_brand' : 'event_verification_failed',
      message: [warning, '未能确认线上长连接事件和卡片回调，请在开放平台检查'].filter(Boolean).join('。'),
      redirectConfigured,
    };
  }
  if (brand === 'feishu' && !redirectConfigured) {
    // 核心事件已经生效。仅尝试复用登录态补 redirect，缺登录态时把白名单留作独立提示。
    const redirect = await web({ ...options, appId, brand, redirectOnly: true, disableQrLogin: true });
    redirectConfigured = redirect.redirectConfigured === true;
  }
  const appEvents = app?.event?.subscribed_events ?? [];
  const callbacks = (app?.callback_info ?? app?.callback)?.subscribed_callbacks ?? [];
  const missingVcEvents = [...VC_MEETING_APP_EVENTS, ...VC_MEETING_USER_EVENTS].filter(name => !appEvents.includes(name));
  const missingEvents = [...BOT_BASELINE_APP_EVENTS, ...BOT_OPTIONAL_APP_EVENTS].filter(name => !appEvents.includes(name));
  return {
    ok: true,
    scopeCount: readback?.grantedCount ?? 0,
    skippedScopeCount: 0,
    scopeWarning: warning,
    privilegeRangeCount: 0,
    subscribedEventCount: appEvents.length + callbacks.length,
    eventWarning: missingEvents.length ? `事件回读缺失：${missingEvents.join(', ')}` : undefined,
    missingVcEvents,
    eventModeReady: true,
    redirectConfigured,
    redirectWarning: redirectConfigured ? undefined : '未能确认 OAuth redirect 白名单已生效',
    publishSkipped: true,
  };
}
