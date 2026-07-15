/**
 * Feishu Open Platform automation used by `botmux setup`.
 *
 * The primary Feishu path now uses one reusable Web session for the whole flow:
 * create app -> read AppID/AppSecret -> configure scopes/events/redirect ->
 * create and publish a version. The official SDK registerApp device flow stays
 * available as a fallback (notably for Lark international tenants).
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import { VC_MEETING_BOT_EVENTS } from './verify-permissions.js';

/**
 * All non-VC events (application identity) that the botmux dispatcher consumes.
 * `card.action.trigger` is intentionally NOT here: the Open Platform treats it
 * as a "callback" configured via `/developers/v1/callback/*`, see
 * BOT_BASELINE_CALLBACKS.
 */
export const BOT_BASELINE_APP_EVENTS = [
  'im.message.receive_v1',
  'im.chat.member.bot.added_v1',
  'im.chat.member.bot.deleted_v1',
  'drive.file.comment_add_v1',
  'drive.notice.comment_add_v1',
  'im.message.reaction.created_v1',
  'im.message.reaction.deleted_v1',
] as const;

/** 缺了它 daemon 完全收不到消息——回读确认失败时整个自动配置 fail-closed。 */
export const BOT_CRITICAL_APP_EVENTS = ['im.message.receive_v1'] as const;

/** 卡片交互回调。缺了它卡片按钮点击无响应,同样 fail-closed。 */
export const BOT_BASELINE_CALLBACKS = ['card.action.trigger'] as const;

/** 开放平台「使用长连接接收事件/回调」对应的 mode 值。 */
export const LONG_CONNECTION_EVENT_MODE = 4;

const VC_MEETING_EVENT_IDENTITY = {
  'vc.bot.meeting_invited_v1': 'app',
  'vc.bot.meeting_activity_v1': 'app',
  'vc.bot.meeting_ended_v1': 'app',
  'vc.meeting.participant_meeting_joined_v1': 'user',
} as const satisfies Record<(typeof VC_MEETING_BOT_EVENTS)[number], 'app' | 'user'>;

export const VC_MEETING_APP_EVENTS = VC_MEETING_BOT_EVENTS.filter(
  eventName => VC_MEETING_EVENT_IDENTITY[eventName] === 'app',
);
export const VC_MEETING_USER_EVENTS = VC_MEETING_BOT_EVENTS.filter(
  eventName => VC_MEETING_EVENT_IDENTITY[eventName] === 'user',
);

export const BOTMUX_REDIRECT_URL = 'http://127.0.0.1:9768/callback';
const FEISHU_ACCOUNTS_ORIGIN = 'https://accounts.feishu.cn';
const ASK_FEISHU_ORIGIN = 'https://ask.feishu.cn';
const FEISHU_APP_ID = '12';
const FEISHU_COMMON_HEADERS = {
  'x-api-version': '1.0.28',
  'x-device-info':
    'device_id=0;device_name=Chrome;device_os=Mac;device_model=Chrome;lark_version=;channel=Release;package_name=feishu;tt_app_id=1658;is_dpop_support=true;is_iframe=false',
  'x-locale': 'zh-CN',
  'x-terminal-type': '2',
};

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
  expiresAt?: number;
  sameSite?: string;
}

/** 当前开放平台 Web session 对应的人与企业。创建前用它防止复用错租户。 */
export interface FeishuWebSessionIdentity {
  userId: string;
  userName: string;
  email?: string;
  tenantId: string;
  tenantName: string;
}

export interface ScopeManifest {
  scopes?: {
    tenant?: string[];
    user?: string[];
  };
}

export interface OpenPlatformScopeEntry {
  id: string;
  name: string;
  bucket?: 'tenant' | 'user';
}

export interface MappedScopeIds {
  tenantScopeIds: string[];
  userScopeIds: string[];
  missingTenantScopes: string[];
  missingUserScopes: string[];
}

export type OpenPlatformAutomationResult =
  | {
      ok: true;
      sessionFile: string;
      sessionSource: FeishuWebSessionSource;
      cookieCount: number;
      scopeCount: number;
      skippedScopeCount: number;
      scopeWarning?: string;
      subscribedEventCount: number;
      eventWarning?: string;
      /** 回读后仍缺失的 VC 会议事件。普通建 bot 不阻断,VC listener 保存前必须为空。 */
      missingVcEvents: string[];
      /** 回读确认事件接收方式已是长连接(ok:true 时恒为 true,显式带回供门函数统一判定)。 */
      eventModeReady: boolean;
      versionId?: string;
    }
  | {
      ok: false;
      reason:
        | 'unsupported_brand'
        | 'missing_session'
        | 'invalid_session'
        | 'login_failed'
        | 'qr_expired'
        | 'timeout'
        | 'missing_csrf'
        | 'scope_mapping_failed'
        | 'network'
        | 'api_error';
      message: string;
      sessionFile?: string;
      /** Number of events successfully subscribed (0 when event update failed before downstream error). */
      subscribedEventCount?: number;
      /** Warning from event subscription attempt, if any. */
      eventWarning?: string;
      /** 回读后仍缺失的 VC 会议事件(走到订阅阶段才有)。 */
      missingVcEvents?: string[];
      /** 事件接收方式是否回读确认为长连接(走到订阅阶段才有;早期失败为 undefined)。 */
      eventModeReady?: boolean;
    };

export interface OpenPlatformAutomationOptions {
  appId: string;
  brand?: 'feishu' | 'lark';
  sessionFilePath?: string;
  bytedcliFallbackSessionFilePath?: string;
  disableBytedcliFallback?: boolean;
  /** Reuse a valid cache or fail instead of presenting another QR. */
  disableQrLogin?: boolean;
  fetchImpl?: typeof fetch;
  scopeManifest?: ScopeManifest;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  onQrCode?: (info: { qrText: string; qrPayload: string }) => void | Promise<void>;
  onStatus?: (message: string) => void | Promise<void>;
}


export type FeishuWebSessionSource = 'botmux_cache' | 'qr_login' | 'bytedcli_fallback';
export type FeishuWebSessionFailureReason = 'login_failed' | 'qr_expired' | 'timeout' | 'network' | 'invalid_session';

export type FeishuWebSessionPrepareResult =
  | {
      ok: true;
      sessionFile: string;
      source: FeishuWebSessionSource;
      cookies: StoredCookie[];
      cookieCount: number;
    }
  | {
      ok: false;
      reason: FeishuWebSessionFailureReason;
      message: string;
      sessionFile: string;
      fallbackSessionFile?: string;
    };

export interface FeishuWebSessionOptions {
  sessionFilePath?: string;
  bytedcliFallbackSessionFilePath?: string;
  disableBytedcliFallback?: boolean;
  /**
   * Ignore cached sessions and require a fresh QR login. Dashboard onboarding
   * uses this so the user always sees which account is authorizing the new app;
   * the resulting session is still cached for the remaining setup steps.
   */
  forceQrLogin?: boolean;
  /** Reuse a valid cache or fail; never present another QR code. */
  disableQrLogin?: boolean;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  onQrCode?: (info: { qrText: string; qrPayload: string }) => void | Promise<void>;
  onStatus?: (message: string) => void | Promise<void>;
}

export type FeishuOpenPlatformSessionInspectionResult =
  | {
      ok: true;
      source: FeishuWebSessionSource;
      identity: FeishuWebSessionIdentity;
      sessionFile: string;
    }
  | {
      ok: false;
      reason: FeishuWebSessionFailureReason | 'missing_csrf' | 'identity_unavailable' | 'network';
      message: string;
      sessionFile?: string;
    };


export function parseSetupOpenPlatformAutoFlag(argv: string[]): boolean {
  let enabled = true;
  for (const arg of argv) {
    if (arg === '--open-platform-auto') enabled = true;
    if (arg === '--no-open-platform-auto') enabled = false;
  }
  return enabled;
}

export function botmuxFeishuSessionFilePath(configDir = join(homedir(), '.botmux')): string {
  return join(configDir, 'feishu-session.json');
}

export function bytedcliFeishuSessionFilePath(homeDir = homedir()): string {
  return join(homeDir, '.local', 'share', 'bytedcli', 'data', 'feishu_session.json');
}

export function readStoredCookiesFromSessionFile(filePath: string): StoredCookie[] | null {
  if (!existsSync(filePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const cookies = (parsed as { cookies?: unknown }).cookies;
  if (!Array.isArray(cookies)) return null;
  return pruneExpiredCookies(cookies.filter(isStoredCookieRecord));
}

export function readStoredCookiesFromBytedcliSession(filePath: string): StoredCookie[] | null {
  return readStoredCookiesFromSessionFile(filePath);
}

export function writeStoredCookiesToSessionFile(filePath: string, cookies: StoredCookie[]): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmpPath, JSON.stringify({ cookies: pruneExpiredCookies(cookies) }, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    renameSync(tmpPath, filePath);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore.
    }
  }
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
}

export function getCookieHeader(cookies: StoredCookie[], requestUrl: string): string {
  const url = new URL(requestUrl);
  return pruneExpiredCookies(cookies)
    .filter(cookie => {
      if (cookie.secure && url.protocol !== 'https:') return false;
      if (!domainMatches(url.hostname, cookie)) return false;
      return pathMatches(url.pathname || '/', cookie.path || '/');
    })
    .sort((a, b) => b.path.length - a.path.length)
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

export function extractOpenPlatformCsrfToken(html: string): string | null {
  const match =
    html.match(/\bwindow\.csrfToken\s*=\s*(['"])([^'"]+)\1/) ??
    html.match(/\bcsrfToken\s*:\s*(['"])([^'"]+)\1/);
  return match?.[2] ?? null;
}

/**
 * 开发者后台把当前登录人写入 `window.user = {...}`。只提取创建前需要展示和
 * 比对的稳定字段，不把头像、功能开关等整段页面状态带进 Dashboard API。
 */
export function extractOpenPlatformSessionIdentity(html: string): FeishuWebSessionIdentity | null {
  const marker = /\bwindow\.user\s*=\s*/g;
  const match = marker.exec(html);
  if (!match) return null;
  const start = match.index + match[0].length;
  const json = extractBalancedJsonObject(html, start);
  if (!json) return null;
  let user: Record<string, unknown>;
  try {
    user = asRecord(JSON.parse(json));
  } catch {
    return null;
  }
  const userId = pickString(user, ['id', 'userId', 'user_id']);
  const userName = pickString(user, ['name', 'userName', 'user_name'])
    ?? pickString(asRecord(user.displayName), ['value']);
  const tenantId = pickString(user, ['tenantId', 'tenant_id']);
  const tenantName = pickString(asRecord(user.tenantDisplayName), ['value'])
    ?? pickString(user, ['tenantName', 'tenant_name']);
  if (!userId || !userName || !tenantId || !tenantName) return null;
  const email = pickString(user, ['email']);
  return { userId, userName, ...(email ? { email } : {}), tenantId, tenantName };
}

export function extractOpenPlatformScopeEntries(payload: unknown): OpenPlatformScopeEntry[] {
  const out: OpenPlatformScopeEntry[] = [];
  collectScopeEntries(payload, undefined, out);
  const seen = new Set<string>();
  return out.filter(entry => {
    const key = `${entry.bucket ?? 'any'}:${entry.name}:${entry.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function mapManifestScopesToOpenPlatformIds(
  manifest: ScopeManifest,
  catalog: OpenPlatformScopeEntry[],
): MappedScopeIds {
  const tenant = uniqueStrings(manifest.scopes?.tenant ?? []);
  const user = uniqueStrings(manifest.scopes?.user ?? []);
  return {
    tenantScopeIds: mapScopeIds(tenant, catalog, 'tenant').ids,
    userScopeIds: mapScopeIds(user, catalog, 'user').ids,
    missingTenantScopes: mapScopeIds(tenant, catalog, 'tenant').missing,
    missingUserScopes: mapScopeIds(user, catalog, 'user').missing,
  };
}

export function buildScopeUpdatePayload(appId: string, mapped: Pick<MappedScopeIds, 'tenantScopeIds' | 'userScopeIds'>) {
  return {
    clientId: appId,
    appScopeIDs: mapped.tenantScopeIds,
    userScopeIDs: mapped.userScopeIds,
    scopeIds: [],
    operation: 'add',
    isDeveloperPanel: true,
  };
}

export function buildSafeSettingPayload(appId: string) {
  return {
    clientId: appId,
    redirectURL: [BOTMUX_REDIRECT_URL],
  };
}

/**
 * Build the incremental event-subscription payload used by the developer
 * console (`updateEvent` in the console frontend bundle):
 * `{clientId, operation:'add', events, appEvents, userEvents, eventMode}`。
 * eventMode 必须回填读接口返回的当前值,事件按接收身份分桶(应用/用户)。
 */
export function buildEventSubscriptionPayload(
  appId: string,
  eventMode: number,
  appEvents: string[],
  userEvents: string[],
  events: string[] = [],
) {
  return {
    clientId: appId,
    operation: 'add',
    events,
    appEvents,
    userEvents,
    eventMode,
  };
}

/** 同款增量契约的回调版(console frontend `updateCallback`)。 */
export function buildCallbackSubscriptionPayload(appId: string, callbackMode: number, callbacks: string[]) {
  return {
    clientId: appId,
    operation: 'add',
    callbacks,
    callbackMode,
  };
}

export interface OpenPlatformEventState {
  eventMode?: number;
  /** 所有已订阅事件(顶层 events + 应用/用户身份分组的并集)。 */
  events: string[];
  appEvents: string[];
  userEvents: string[];
}

export interface OpenPlatformCallbackState {
  callbackMode?: number;
  callbacks: string[];
}

/** Extract the event mode and subscribed event ids from `/developers/v1/event/:clientId`. */
export function extractOpenPlatformEventState(payload: unknown): OpenPlatformEventState {
  const root = asRecord(payload);
  const wrapped = asRecord(root.data);
  const data = Object.keys(wrapped).length > 0 ? wrapped : root;
  const appEvents = uniqueStrings([
    ...extractEventIds(data.appEvents),
    ...extractEventIdsFromDetails(data.appEventDetails),
  ]);
  const userEvents = uniqueStrings([
    ...extractEventIds(data.userEvents),
    ...extractEventIdsFromDetails(data.userEventDetails),
  ]);
  const genericEvents = uniqueStrings([
    ...extractEventIds(data.events),
    ...extractEventIdsFromDetails(data.eventDetails),
  ]);
  const eventMode = typeof data.eventMode === 'number' && Number.isFinite(data.eventMode)
    ? data.eventMode
    : undefined;
  return {
    eventMode,
    events: uniqueStrings([...genericEvents, ...appEvents, ...userEvents]),
    appEvents,
    userEvents,
  };
}

/** Extract the callback mode and subscribed callback ids from `/developers/v1/callback/:clientId`. */
export function extractOpenPlatformCallbackState(payload: unknown): OpenPlatformCallbackState {
  const root = asRecord(payload);
  const wrapped = asRecord(root.data);
  const data = Object.keys(wrapped).length > 0 ? wrapped : root;
  const callbackMode = typeof data.callbackMode === 'number' && Number.isFinite(data.callbackMode)
    ? data.callbackMode
    : undefined;
  return { callbackMode, callbacks: extractEventIds(data.callbacks) };
}

function extractEventIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value
    .map(item => typeof item === 'string' ? item : pickString(asRecord(item), ['id']))
    .filter((item): item is string => Boolean(item)));
}

function extractEventIdsFromDetails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.flatMap(group => extractEventIds(asRecord(group).items)));
}

/**
 * 应用版本创建 payload,与 console launcher「一键创建智能体」同款极简结构
 * (CDP 抓包确认)。⚠️不要重新加回 applyReasonConfig / isAutoAudit:false ——
 * 那会让版本进入人工审核、发布后应用停在「未上架/未启用」(tenantAppStatus=0),
 * 事件配置进了草稿也无法在企业内生效。visibleSuggest.members 必须含创建者,
 * 否则同样不会自动上架启用。
 */
export function buildAppVersionCreatePayload(appVersion: string, visibleMemberIds: string[] = []) {
  return {
    appVersion,
    mobileDefaultAbility: 'bot',
    pcDefaultAbility: 'bot',
    changeLog: 'Initial bot release.',
    visibleSuggest: {
      departments: [],
      members: visibleMemberIds,
      groups: [],
      isAll: 0,
    },
    blackVisibleSuggest: {
      departments: [],
      members: [],
      groups: [],
      isAll: 0,
    },
  };
}

export function buildFeishuQrPayload(token: string): string {
  return JSON.stringify({ qrlogin: { token } });
}

export function mapFeishuQrPollingStatus(status: number | null): string {
  if (status === 2) return '已经扫码，等待手机确认';
  if (status === 5) return '二维码已过期';
  return '等待飞书扫码';
}

export async function prepareFeishuWebSession(
  options: FeishuWebSessionOptions = {},
): Promise<FeishuWebSessionPrepareResult> {
  const fetcher = options.fetchImpl ?? fetch;
  const sessionFile = options.sessionFilePath ?? botmuxFeishuSessionFilePath();
  if (!options.forceQrLogin) {
    const cached = readStoredCookiesFromSessionFile(sessionFile);
    if (cached && cached.length > 0 && await validateFeishuWebSession(cached, fetcher)) {
      return {
        ok: true,
        sessionFile,
        source: 'botmux_cache',
        cookies: cached,
        cookieCount: cached.length,
      };
    }
  }

  if (options.disableQrLogin) {
    return {
      ok: false,
      reason: 'invalid_session',
      message: '没有可复用的 Feishu Web session；为避免意外出现第二个二维码，已停止自动登录',
      sessionFile,
    };
  }

  let loginError: unknown;
  try {
    const loggedIn = await loginFeishuWebSession(fetcher, options);
    writeStoredCookiesToSessionFile(sessionFile, loggedIn);
    return {
      ok: true,
      sessionFile,
      source: 'qr_login',
      cookies: loggedIn,
      cookieCount: loggedIn.length,
    };
  } catch (err) {
    loginError = err;
  }

  const fallbackSessionFile = options.bytedcliFallbackSessionFilePath ?? bytedcliFeishuSessionFilePath();
  if (!options.forceQrLogin && !options.disableBytedcliFallback) {
    const fallback = readStoredCookiesFromBytedcliSession(fallbackSessionFile);
    if (fallback && fallback.length > 0 && await validateFeishuWebSession(fallback, fetcher)) {
      writeStoredCookiesToSessionFile(sessionFile, fallback);
      return {
        ok: true,
        sessionFile,
        source: 'bytedcli_fallback',
        cookies: fallback,
        cookieCount: fallback.length,
      };
    }
  }

  return {
    ok: false,
    reason: classifyFeishuLoginError(loginError),
    message: safeErrorMessage(loginError),
    sessionFile,
    fallbackSessionFile: options.disableBytedcliFallback || options.forceQrLogin ? undefined : fallbackSessionFile,
  };
}

export async function automateOpenPlatformSetup(
  options: OpenPlatformAutomationOptions,
): Promise<OpenPlatformAutomationResult> {
  const brand = options.brand ?? 'feishu';
  if (brand !== 'feishu') {
    return { ok: false, reason: 'unsupported_brand', message: '开放平台自动配置当前只支持 feishu.cn 租户' };
  }

  const fetcher = options.fetchImpl ?? fetch;
  const preparedSession = await prepareFeishuWebSession({
    sessionFilePath: options.sessionFilePath,
    bytedcliFallbackSessionFilePath: options.bytedcliFallbackSessionFilePath,
    disableBytedcliFallback: options.disableBytedcliFallback,
    disableQrLogin: options.disableQrLogin,
    fetchImpl: fetcher,
    pollIntervalMs: options.pollIntervalMs,
    maxWaitMs: options.maxWaitMs,
    onQrCode: options.onQrCode,
    onStatus: options.onStatus,
  });
  if (!preparedSession.ok) {
    return {
      ok: false,
      reason: preparedSession.reason,
      message: `获取 Feishu Web session 失败: ${preparedSession.message}`,
      sessionFile: preparedSession.sessionFile,
    };
  }

  const sessionFile = preparedSession.sessionFile;
  const session = new MutableCookieJar(preparedSession.cookies);
  const defaultOrigin = 'https://open.feishu.cn';
  const defaultAppHome = `${defaultOrigin}/app/${options.appId}`;
  // The botmux-managed Feishu Web login yields reusable cookies, not Open
  // Platform's page-scoped `window.csrfToken`. Load an Open Platform page with
  // those cookies and extract CSRF from HTML before calling `/developers/v1/*`.
  // Feishu tenants can redirect the console to open.larkoffice.com; API origin,
  // referer, CSRF token and cookies must stay on that final origin.
  let csrfToken: string | null = null;
  let apiOrigin = defaultOrigin;
  let appHome = defaultAppHome;
  try {
    const authPage = await session.fetchTextWithUrl(fetcher, `${defaultAppHome}/auth`);
    apiOrigin = new URL(authPage.finalUrl).origin;
    appHome = `${apiOrigin}/app/${options.appId}`;
    csrfToken = extractOpenPlatformCsrfToken(authPage.text);
    if (!csrfToken) {
      const homePage = await session.fetchTextWithUrl(fetcher, appHome);
      apiOrigin = new URL(homePage.finalUrl).origin;
      appHome = `${apiOrigin}/app/${options.appId}`;
      csrfToken = extractOpenPlatformCsrfToken(homePage.text);
    }
  } catch (err: any) {
    return { ok: false, reason: 'network', message: `读取开放平台页面失败: ${safeErrorMessage(err)}`, sessionFile };
  }
  if (!csrfToken) {
    return {
      ok: false,
      reason: 'missing_csrf',
      message:
        'Feishu session 可读取，但开放平台页面没有返回 window.csrfToken；可能需要在浏览器完成开放平台登录',
      sessionFile,
    };
  }

  const postJson = async (path: string, body?: unknown): Promise<unknown> => {
    const url = `${apiOrigin}${path}`;
    const response = await session.fetchRaw(fetcher, url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: apiOrigin,
        referer: appHome,
        'x-csrf-token': csrfToken!,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data: any;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      throw new OpenPlatformApiError(`HTTP ${response.status} ${path}: ${summarizeOpenPlatformPayload(data)}`, data);
    }
    if (data && typeof data === 'object' && typeof data.code === 'number' && data.code !== 0) {
      throw new OpenPlatformApiError(`code=${data.code} msg=${data.msg ?? data.message ?? ''}`, data);
    }
    return data;
  };

  let allScopesPayload: unknown;
  try {
    allScopesPayload = await postJson(`/developers/v1/scope/all/${options.appId}`);
  } catch (err: any) {
    return { ok: false, reason: 'api_error', message: `读取开放平台 scope 列表失败: ${safeErrorMessage(err)}`, sessionFile };
  }

  const manifest = options.scopeManifest ?? readDefaultScopeManifest();
  const catalog = extractOpenPlatformScopeEntries(allScopesPayload);
  const mapped = mapManifestScopesToOpenPlatformIds(manifest, catalog);
  const missing = [...mapped.missingTenantScopes, ...mapped.missingUserScopes];
  const skippedScopeCount = missing.length;
  if (missing.length > 0) {
    console.warn(`Warning: ${missing.length} scopes are not present in the Open Platform catalog and will be skipped: ${missing.slice(0, 8).join(', ')}`);
  }

  // "部分权限即成功"：有的租户目录下个别权限不可授予，整批 scope/update 会被拒。
  // 把权限注册做成非致命——失败只告警并继续配 redirect / 建版本，不让权限问题阻塞建 bot。
  let importedScopeCount = mapped.tenantScopeIds.length + mapped.userScopeIds.length;
  let scopeWarning: string | undefined;
  if (importedScopeCount > 0) {
    try {
      await postJson(`/developers/v1/scope/update/${options.appId}`, buildScopeUpdatePayload(options.appId, mapped));
    } catch (err: any) {
      scopeWarning = safeErrorMessage(err);
      importedScopeCount = 0;
    }
  }

  // Web 创建的是普通企业自建应用（不是 SDK PersonalAgent），需要显式开启
  // 机器人能力并把事件接收方式切到长连接。对已启用的 SDK/已有应用重复调用
  // 是幂等的；这里设为致命步骤，因为缺任一项 daemon 都无法正常收消息。
  try {
    await postJson(`/developers/v1/robot/switch/${options.appId}`, { clientId: options.appId, enable: true });
    await postJson(`/developers/v1/event/switch/${options.appId}`, { clientId: options.appId, eventMode: 4 });
  } catch (err: any) {
    return {
      ok: false,
      reason: 'api_error',
      message: `启用机器人或长连接事件能力失败: ${safeErrorMessage(err)}`,
      sessionFile,
    };
  }

  // 事件与回调都走 console 前端同款「增量」契约:先读现状 → operation:add 只补
  // 缺失 → 回读确认。旧实现的 eventNames/eventNameList 参数和
  // /event_callback/update 端点在开放平台并不存在,请求全部失败还被吞成
  // warning——新建应用因此落地就没有任何事件订阅。核心项(im.message.receive_v1
  // 事件 + card.action.trigger 回调)回读仍缺失时直接判失败:缺了它们 daemon
  // 收不到消息/卡片点击,静默降级只会产出一个「建好了却不回话」的坏 bot。
  const eventWarnings: string[] = [];
  const readEventState = async () =>
    extractOpenPlatformEventState(await postJson(`/developers/v1/event/${options.appId}`, { needEventDetail: true }));
  const addEvents = async (appEvents: string[], userEvents: string[], eventMode: number) => {
    await postJson(
      `/developers/v1/event/update/${options.appId}`,
      buildEventSubscriptionPayload(options.appId, eventMode, appEvents, userEvents),
    );
  };

  let eventState: OpenPlatformEventState | undefined;
  try {
    eventState = await readEventState();
  } catch (err: any) {
    eventWarnings.push(`读取当前事件订阅失败: ${safeErrorMessage(err)}`);
  }
  const hasEvent = (name: string) => Boolean(eventState?.events.includes(name));
  const wantedAppEvents = [...BOT_BASELINE_APP_EVENTS, ...VC_MEETING_APP_EVENTS];
  const missingAppEvents = wantedAppEvents.filter(name => !hasEvent(name));
  const missingUserEvents = VC_MEETING_USER_EVENTS.filter(name => !hasEvent(name));
  if (missingAppEvents.length > 0 || missingUserEvents.length > 0) {
    const eventMode = eventState?.eventMode ?? LONG_CONNECTION_EVENT_MODE;
    try {
      await addEvents(missingAppEvents, missingUserEvents, eventMode);
    } catch {
      // 部分租户个别事件依赖的权限不可授予会拒掉整批——逐个补,别让长尾事件拖垮核心事件
      for (const name of missingAppEvents) {
        try {
          await addEvents([name], [], eventMode);
        } catch (err: any) {
          eventWarnings.push(`订阅事件 ${name} 失败: ${safeErrorMessage(err)}`);
        }
      }
      for (const name of missingUserEvents) {
        try {
          await addEvents([], [name], eventMode);
        } catch (err: any) {
          eventWarnings.push(`订阅事件 ${name} 失败: ${safeErrorMessage(err)}`);
        }
      }
    }
    try {
      eventState = await readEventState();
    } catch (err: any) {
      eventWarnings.push(`回读事件订阅失败: ${safeErrorMessage(err)}`);
    }
  }
  const missingBaselineEvents = BOT_BASELINE_APP_EVENTS.filter(name => !hasEvent(name));
  if (missingBaselineEvents.length > 0) {
    eventWarnings.push(`基础事件未确认订阅: ${missingBaselineEvents.join(', ')}`);
  }
  // VC 事件缺失不阻断普通建 bot,但要显式带回给 VC listener 保存门
  // (vcListenerEventGateError)——只看总 count 无法区分「缺的是不是 VC」。
  const missingVcEvents: string[] = VC_MEETING_BOT_EVENTS.filter(name => !hasEvent(name));
  if (missingVcEvents.length > 0) {
    eventWarnings.push(`VC 会议事件未确认订阅: ${missingVcEvents.join(', ')}`);
  }

  // 卡片回调(card.action.trigger)在开放平台是「回调」不是「事件」,配置走
  // /developers/v1/callback/*;回调接收方式独立于事件,需要单独切到长连接。
  const readCallbackState = async () =>
    extractOpenPlatformCallbackState(await postJson(`/developers/v1/callback/${options.appId}`, {}));
  let callbackState: OpenPlatformCallbackState | undefined;
  try {
    callbackState = await readCallbackState();
  } catch (err: any) {
    eventWarnings.push(`读取当前回调订阅失败: ${safeErrorMessage(err)}`);
  }
  if (callbackState && callbackState.callbackMode !== LONG_CONNECTION_EVENT_MODE) {
    try {
      await postJson(`/developers/v1/callback/switch/${options.appId}`, {
        clientId: options.appId,
        callbackMode: LONG_CONNECTION_EVENT_MODE,
      });
      callbackState = await readCallbackState();
    } catch (err: any) {
      eventWarnings.push(`切换回调长连接模式失败: ${safeErrorMessage(err)}`);
    }
  }
  let missingCallbacks = BOT_BASELINE_CALLBACKS.filter(name => !callbackState?.callbacks.includes(name));
  if (missingCallbacks.length > 0) {
    try {
      await postJson(
        `/developers/v1/callback/update/${options.appId}`,
        buildCallbackSubscriptionPayload(
          options.appId,
          callbackState?.callbackMode ?? LONG_CONNECTION_EVENT_MODE,
          [...missingCallbacks],
        ),
      );
    } catch (err: any) {
      eventWarnings.push(`订阅卡片回调失败: ${safeErrorMessage(err)}`);
    }
    try {
      callbackState = await readCallbackState();
    } catch (err: any) {
      eventWarnings.push(`回读回调订阅失败: ${safeErrorMessage(err)}`);
    }
    missingCallbacks = BOT_BASELINE_CALLBACKS.filter(name => !callbackState?.callbacks.includes(name));
  }

  const subscribedEventCount =
    [...wantedAppEvents, ...VC_MEETING_USER_EVENTS].filter(name => hasEvent(name)).length
    + BOT_BASELINE_CALLBACKS.filter(name => callbackState?.callbacks.includes(name)).length;
  const eventWarning = eventWarnings.length > 0 ? eventWarnings.join('; ') : undefined;
  const criticalIssues: string[] = [
    ...BOT_CRITICAL_APP_EVENTS.filter(name => !hasEvent(name)),
    ...missingCallbacks,
  ];
  // 长连接模式必须以回读为准:switch 接口返回成功≠生效,mode 不是 4 时
  // daemon 走长连接同样收不到事件/回调。eventModeReady 显式带回结果——
  // dashboard listener 门要靠它识别「订阅名齐但接收方式不对」的黑洞。
  const eventModeReady = eventState?.eventMode === LONG_CONNECTION_EVENT_MODE;
  if (!eventModeReady) {
    criticalIssues.push(`事件接收模式=${eventState?.eventMode ?? '未知'}(需长连接 ${LONG_CONNECTION_EVENT_MODE})`);
  }
  if (callbackState?.callbackMode !== LONG_CONNECTION_EVENT_MODE) {
    criticalIssues.push(`回调接收模式=${callbackState?.callbackMode ?? '未知'}(需长连接 ${LONG_CONNECTION_EVENT_MODE})`);
  }
  if (criticalIssues.length > 0) {
    return {
      ok: false,
      reason: 'api_error',
      message: `核心事件/回调订阅未生效(${criticalIssues.join('; ')}),机器人将收不到消息或卡片点击;请到开放平台「事件与回调」手动补齐后重试`,
      sessionFile,
      subscribedEventCount,
      eventWarning,
      missingVcEvents,
      eventModeReady,
    };
  }

  try {
    await postJson(`/developers/v1/safe_setting/update/${options.appId}`, buildSafeSettingPayload(options.appId));
    const contactRange = await postJson(`/developers/v1/contact_range/${options.appId}`, {});
    // 镜像应用原有 contact range 作为版本可见范围——绝不注入「当前 Web session
    // 操作者」:automateOpenPlatformSetup 也被 VC listener 保存 / 权限自愈 / 选择
    // 已有应用等路径调用,那里操作者不一定是创建者/现有可见成员,注入会悄悄扩大
    // 已有 bot 的可见范围。新建应用的「上架启用」由 createOpenPlatformAppWithClient
    // 的首次发布(含创建者可见)完成,与本处无关。
    const visibleMemberIds = extractContactRangeMemberIds(contactRange);
    const versionList = await postJson(`/developers/v1/app_version/list/${options.appId}`, {});
    const appVersion = nextAppVersion(versionList);
    const created = await postJson(`/developers/v1/app_version/create/${options.appId}`, buildAppVersionCreatePayload(appVersion, visibleMemberIds));
    const versionId = extractVersionId(created);
    if (versionId) {
      await postJson(`/developers/v1/publish/commit/${options.appId}/${versionId}`, { clientId: options.appId });
    }
    return {
      ok: true,
      sessionFile,
      sessionSource: preparedSession.source,
      cookieCount: preparedSession.cookieCount,
      scopeCount: importedScopeCount,
      skippedScopeCount,
      scopeWarning,
      subscribedEventCount,
      eventWarning,
      missingVcEvents,
      eventModeReady,
      versionId,
    };
  } catch (err: any) {
    return {
      ok: false,
      reason: 'api_error',
      message: `开放平台自动配置失败: ${safeErrorMessage(err)}`,
      sessionFile,
      subscribedEventCount,
      eventWarning,
      missingVcEvents,
      eventModeReady,
    };
  }
}

/**
 * dashboard 保存 VC 会议监听 bot 前的事件订阅门。普通建 bot 允许 VC 事件缺失
 * (只记 warning),但 listener 缺 VC 事件=会议邀请黑洞,必须阻断保存。
 * 只看 subscribedEventCount 总数无法区分「缺的是不是 VC」,所以要看
 * missingVcEvents。返回错误描述;可保存时返回 null。
 */
export function vcListenerEventGateError(result: {
  eventWarning?: string;
  subscribedEventCount?: number;
  missingVcEvents?: string[];
  eventModeReady?: boolean;
}): string | null {
  if (result.eventWarning && (result.subscribedEventCount ?? 0) === 0) {
    return `事件订阅全部失败(${result.eventWarning})`;
  }
  // 订阅名齐但接收方式不是长连接同样收不到——eventModeReady 显式 false 才阻断,
  // undefined(走到订阅阶段前就失败)保持原 best-effort 语义。
  if (result.eventModeReady === false) {
    return `事件接收方式未确认为长连接${result.eventWarning ? `(${result.eventWarning})` : ''}`;
  }
  const missingVc = result.missingVcEvents ?? [];
  if (missingVc.length > 0) {
    return `VC 会议事件未订阅成功(${missingVc.join(', ')})${result.eventWarning ? `;${result.eventWarning}` : ''}`;
  }
  return null;
}

// ─── 已有应用列表 / 凭证读取（setup「选择已有应用」路径）───────────────────────
//
// 复用同一套 Web session + console CSRF 机制，调 console 前端同款接口
// （bundle 里的 getAppList / getAppSecret）。与 automateOpenPlatformSetup 的
// 内联 postJson 少量重复——那条链路已实测稳定且 CSRF 种子页 / referer 都绑定
// 具体 appId，不强行合并，避免动到已验证的自动配置路径。

export interface OpenPlatformAppSummary {
  clientId: string;
  name: string;
  /** 应用描述（接口给什么用什么，仅展示）。 */
  description?: string;
}

export interface OpenPlatformApiClient {
  apiOrigin: string;
  postJson(path: string, body?: unknown): Promise<unknown>;
  postForm(path: string, body: FormData): Promise<unknown>;
}

export type OpenPlatformClientResult =
  | { ok: true; client: OpenPlatformApiClient; identity?: FeishuWebSessionIdentity }
  | { ok: false; reason: 'missing_csrf' | 'network'; message: string };

/**
 * 用已就绪的 Web session cookies 构造开放平台 console API 客户端：加载 console
 * 页面提取 `window.csrfToken` 与最终 origin（部分租户会把控制台重定向到
 * open.larkoffice.com），返回可调 `/developers/v1/*` 的 postJson。
 */
export async function createOpenPlatformApiClient(
  cookies: StoredCookie[],
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<OpenPlatformClientResult> {
  const fetcher = opts.fetchImpl ?? fetch;
  const session = new MutableCookieJar(cookies);
  let csrfToken: string | null = null;
  let apiOrigin = 'https://open.feishu.cn';
  let referer = `${apiOrigin}/app`;
  let identity: FeishuWebSessionIdentity | undefined;
  try {
    const page = await session.fetchTextWithUrl(fetcher, `${apiOrigin}/app`);
    apiOrigin = new URL(page.finalUrl).origin;
    referer = page.finalUrl;
    csrfToken = extractOpenPlatformCsrfToken(page.text);
    identity = extractOpenPlatformSessionIdentity(page.text) ?? undefined;
  } catch (err) {
    return { ok: false, reason: 'network', message: `读取开放平台页面失败: ${safeErrorMessage(err)}` };
  }
  if (!csrfToken) {
    return {
      ok: false,
      reason: 'missing_csrf',
      message: '开放平台页面没有返回 window.csrfToken；Web session 可能已过期或未完成开放平台登录',
    };
  }

  const request = async (path: string, body?: BodyInit, contentType?: string): Promise<unknown> => {
    const url = `${apiOrigin}${path}`;
    const response = await session.fetchRaw(fetcher, url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: apiOrigin,
        referer,
        'x-csrf-token': csrfToken!,
        ...(contentType ? { 'content-type': contentType } : {}),
      },
      body,
    });
    let data: any;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      throw new OpenPlatformApiError(`HTTP ${response.status} ${path}: ${summarizeOpenPlatformPayload(data)}`, data);
    }
    if (data && typeof data === 'object' && typeof data.code === 'number' && data.code !== 0) {
      throw new OpenPlatformApiError(`code=${data.code} msg=${data.msg ?? data.message ?? ''}`, data);
    }
    return data;
  };

  const postJson = async (path: string, body?: unknown): Promise<unknown> =>
    request(path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? undefined : 'application/json');
  const postForm = async (path: string, body: FormData): Promise<unknown> => request(path, body);

  return { ok: true, client: { apiOrigin, postJson, postForm }, identity };
}

/**
 * 只检查现有缓存，不展示二维码。Dashboard 打开添加表单时调用；返回的账号/企业
 * 会显示给用户，并在真正创建前再次比对，避免旧 cookie 把应用建到错误租户。
 */
export async function inspectCachedFeishuOpenPlatformSession(
  options: Pick<FeishuWebSessionOptions, 'sessionFilePath' | 'fetchImpl'> = {},
): Promise<FeishuOpenPlatformSessionInspectionResult> {
  const prepared = await prepareFeishuWebSession({
    ...options,
    disableQrLogin: true,
    disableBytedcliFallback: true,
  });
  if (!prepared.ok) return prepared;
  const clientResult = await createOpenPlatformApiClient(prepared.cookies, { fetchImpl: options.fetchImpl });
  if (!clientResult.ok) {
    return {
      ok: false,
      reason: clientResult.reason,
      message: clientResult.message,
      sessionFile: prepared.sessionFile,
    };
  }
  if (!clientResult.identity) {
    return {
      ok: false,
      reason: 'identity_unavailable',
      message: '开放平台没有返回当前账号与企业信息；为避免创建到错误租户，未复用该登录态',
      sessionFile: prepared.sessionFile,
    };
  }
  return {
    ok: true,
    source: prepared.source,
    identity: clientResult.identity,
    sessionFile: prepared.sessionFile,
  };
}

export type CreateFeishuOpenPlatformAppResult =
  | {
      ok: true;
      appId: string;
      appSecret: string;
      brand: 'feishu';
      sessionFile: string;
      sessionSource: FeishuWebSessionSource;
      sessionIdentity: FeishuWebSessionIdentity;
    }
  | {
      ok: false;
      reason:
        | FeishuWebSessionFailureReason
        | 'missing_csrf'
        | 'missing_icon'
        | 'identity_unavailable'
        | 'session_changed'
        | 'api_error';
      message: string;
      /** 应用已经建成但读取 Secret 失败时返回，调用方不得再创建一个重复应用。 */
      appId?: string;
      sessionFile?: string;
    };

export interface CreateFeishuOpenPlatformAppOptions extends FeishuWebSessionOptions {
  name: string;
  description?: string;
  /** 测试/定制图标；默认复用 botmux dashboard 的 512x512 favicon。 */
  iconFilePath?: string;
  /** Dashboard 表单打开时显示过的缓存身份；创建前必须仍是同一人、同一企业。 */
  expectedIdentity?: Pick<FeishuWebSessionIdentity, 'userId' | 'tenantId'>;
  /** 已拿到并验证账号/企业、但尚未创建应用时触发。 */
  onSessionReady?: (info: {
    source: FeishuWebSessionSource;
    identity: FeishuWebSessionIdentity;
  }) => void | Promise<void>;
}

class CreatedOpenPlatformAppError extends Error {
  constructor(readonly appId: string, cause: unknown) {
    super(`应用 ${appId} 已创建，但启用机器人能力或读取 AppSecret 失败: ${safeErrorMessage(cause)}`);
  }
}

function defaultBotmuxAppIconPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // npm build: dist/setup/open-platform-automation.js -> dist/dashboard-web/favicon.png
    join(here, '..', 'dashboard-web', 'favicon.png'),
    // tsx / vitest: src/setup/open-platform-automation.ts -> src/dashboard/web/favicon.png
    join(here, '..', 'dashboard', 'web', 'favicon.png'),
  ];
  return candidates.find(existsSync);
}

function pickPayloadString(payload: unknown, keys: string[]): string | undefined {
  const record = asRecord(payload);
  return pickString(record, keys) ?? pickString(asRecord(record.data), keys);
}

/** 「一键创建智能体」(backend_oneclick launcher) 使用的应用清单模板 ID。 */
export const ONECLICK_APP_MANIFEST_TEMPLATE_ID = 'developer_console';

/**
 * Build the payload for `POST /developers/v1/manifest/upsert_by_template` —
 * the console launcher's one-click agent creation endpoint (CDP 抓包确认)。
 * 该模板建出的应用开箱自带 bot 能力、长连接事件/回调模式、基础事件订阅与
 * card.action.trigger 回调,正是「正常申请默认带的权限」。
 */
export function buildManifestTemplateCreatePayload(
  name: string,
  description: string,
  avatar: string,
  cid: string,
) {
  return {
    appManifestTemplateID: ONECLICK_APP_MANIFEST_TEMPLATE_ID,
    createAppUserCustomField: {
      i18n: { zh_cn: { name, description } },
      avatar,
      primaryLang: 'zh_cn',
    },
    cid,
    HTTPHead: {},
  };
}

/**
 * 模板创建是否属于服务端「明确拒绝」——即可确定应用没有建出来,允许安全
 * 回退 app/create。业务错误码(code!==0,服务端解析请求后拒绝)与 HTTP 404
 * (端点不存在)算明确拒绝;传输错误(ECONNRESET/timeout,非
 * OpenPlatformApiError)、HTTP 5xx、code=0 缺 ClientID 都属「结果未知」——
 * 服务端可能已 commit,跨端点重建会产生孤儿 + 重复应用,必须 fail-closed。
 */
function isDefiniteTemplateRejection(err: unknown): boolean {
  if (!(err instanceof OpenPlatformApiError)) return false;
  const code = (asRecord(err.payload) as { code?: unknown }).code;
  if (typeof code === 'number' && code !== 0) return true;
  return /^HTTP 404\b/.test(err.message);
}

/**
 * 用已经登录的开放平台 Web session 创建一个企业自建应用并读取凭证。
 *
 * 首选 console launcher 的「一键创建智能体」模板接口
 * (manifest/upsert_by_template):模板应用出生即带 bot 能力、长连接、基础
 * 事件与卡片回调,新建 bot 不再依赖后续订阅补齐。模板 ID 属内部契约,被
 * 服务端明确拒绝时自动回退旧 app/create(裸自建应用,事件/回调由
 * automateOpenPlatformSetup 增量补齐并 fail-closed 兜底);创建结果未知时
 * 不回退(见 isDefiniteTemplateRejection)。Secret 只存在返回值中,不打印、
 * 不写日志。
 */
export async function createOpenPlatformAppWithClient(
  client: OpenPlatformApiClient,
  // creatorUserId 必填:首次「启用发布」的版本可见范围必须含创建者,否则发布后
  // 应用不会自动上架启用。调用方(createFeishuOpenPlatformApp)已保证 session
  // identity 可用才会走到这里。
  options: { name: string; description?: string; iconFilePath?: string; creatorUserId: string },
): Promise<{ appId: string; appSecret: string }> {
  const name = options.name.trim();
  if (!name) throw new Error('应用名称不能为空');
  if (!options.creatorUserId) throw new Error('创建应用缺少创建者 userId,无法完成上架启用');
  const iconFile = options.iconFilePath ?? defaultBotmuxAppIconPath();
  if (!iconFile || !existsSync(iconFile)) throw new Error('找不到 botmux 默认应用图标');

  const icon = readFileSync(iconFile);
  const form = new FormData();
  form.append('file', new Blob([icon], { type: 'image/png' }), 'botmux.png');
  form.append('uploadType', '4'); // Open Platform console enum: Icon
  form.append('isIsv', 'false'); // 企业自建应用
  form.append('scale', JSON.stringify({ width: 512, height: 512 }));
  const uploaded = await client.postForm('/developers/v1/app/upload/image', form);
  const avatar = pickPayloadString(uploaded, ['url']);
  if (!avatar) throw new Error('开放平台上传图标后没有返回 url');

  const description = options.description?.trim() || 'AI coding assistant powered by botmux';
  let appId: string | undefined;
  try {
    const created = await client.postJson(
      '/developers/v1/manifest/upsert_by_template',
      buildManifestTemplateCreatePayload(name, description, avatar, randomUUID()),
    );
    const templateAppId = pickPayloadString(created, ['ClientID', 'clientID', 'clientId', 'appId']);
    if (!templateAppId?.startsWith('cli_')) {
      // code=0 却没有 ClientID:应用可能已建成(响应结构变化),结果未知——
      // 不能落入 fallback 再 create,让下面的 catch 按「非明确拒绝」抛出。
      throw new Error('一键智能体模板创建返回成功但没有 ClientID(结果未知);请到开放平台确认是否已创建同名应用后重试');
    }
    appId = templateAppId;
  } catch (err) {
    if (!isDefiniteTemplateRejection(err)) throw err;
    console.warn(`一键智能体模板创建被拒,回退普通自建应用: ${safeErrorMessage(err)}`);
    appId = undefined;
  }
  if (!appId) {
    const created = await client.postJson('/developers/v1/app/create', {
      appSceneType: 0, // SelfBuild
      name,
      desc: description,
      avatar,
      i18n: { zh_cn: { name, description } },
      primaryLang: 'zh_cn',
    });
    appId = pickPayloadString(created, ['ClientID', 'clientID', 'clientId', 'appId']);
  }
  if (!appId?.startsWith('cli_')) throw new Error('开放平台创建应用后没有返回 ClientID');

  try {
    // 模板应用出生已带 bot + 长连接(重复调用幂等);fallback 的裸自建应用
    // 则必须显式开启——这两步是「一扫即用」的必要条件,在返回凭证前完成。
    await client.postJson(`/developers/v1/robot/switch/${appId}`, { clientId: appId, enable: true });
    await client.postJson(`/developers/v1/event/switch/${appId}`, { clientId: appId, eventMode: 4 }); // WebSocket

    // 复刻 console launcher「一键创建智能体」的最后一步:立刻用极简版本发布一次,
    // 让应用**上架启用**(tenantAppStatus 0→2)。这样返回的就是一个「已启用、可
    // 收发消息」的应用——等价于旧 SDK registerApp 直接产出可用 PersonalAgent 的效果。
    // 这一步 fail-closed:拿到 versionId 后 commit 失败、或 code=0 却没 versionId
    // (可能留下未发布草稿),都视为创建失败抛出(带 appId,由调用方兜底/提示),
    // 不宣称「后续 setup 会软兜底」——setup 的 nextAppVersion 不复用未发布草稿,
    // 版本号可能撞车导致二次发版继续失败,应用永远停在未启用。
    const versionCreated = await client.postJson(
      `/developers/v1/app_version/create/${appId}`,
      buildAppVersionCreatePayload('1.0.0', [options.creatorUserId]),
    );
    const enableVersionId = extractVersionId(versionCreated);
    if (!enableVersionId) {
      throw new Error('上架启用版本创建返回成功但没有 versionId(可能已留下未发布草稿);请到开放平台确认后重试');
    }
    await client.postJson(`/developers/v1/publish/commit/${appId}/${enableVersionId}`, { clientId: appId });

    const appSecret = await fetchOpenPlatformAppSecret(client, appId);
    return { appId, appSecret };
  } catch (err) {
    throw new CreatedOpenPlatformAppError(appId, err);
  }
}

/**
 * 单次飞书 Web 扫码完成应用创建。session 会写入 ~/.botmux，后续
 * automateOpenPlatformSetup 会直接复用，因此权限/redirect/发版不再二次扫码。
 */
export async function createFeishuOpenPlatformApp(
  options: CreateFeishuOpenPlatformAppOptions,
): Promise<CreateFeishuOpenPlatformAppResult> {
  const prepared = await prepareFeishuWebSession(options);
  if (!prepared.ok) {
    return {
      ok: false,
      reason: prepared.reason,
      message: `获取 Feishu Web session 失败: ${prepared.message}`,
      sessionFile: prepared.sessionFile,
    };
  }

  const clientResult = await createOpenPlatformApiClient(prepared.cookies, { fetchImpl: options.fetchImpl });
  if (!clientResult.ok) {
    return {
      ok: false,
      reason: clientResult.reason,
      message: clientResult.message,
      sessionFile: prepared.sessionFile,
    };
  }
  if (!clientResult.identity) {
    return {
      ok: false,
      reason: 'identity_unavailable',
      message: '开放平台没有返回当前账号与企业信息；为避免创建到错误租户，未创建应用',
      sessionFile: prepared.sessionFile,
    };
  }
  if (options.expectedIdentity
    && (clientResult.identity.userId !== options.expectedIdentity.userId
      || clientResult.identity.tenantId !== options.expectedIdentity.tenantId)) {
    return {
      ok: false,
      reason: 'session_changed',
      message: `当前登录账号或企业已变化（${clientResult.identity.userName} · ${clientResult.identity.tenantName}）；请重新确认后再创建`,
      sessionFile: prepared.sessionFile,
    };
  }

  try {
    await options.onSessionReady?.({ source: prepared.source, identity: clientResult.identity });
    const credentials = await createOpenPlatformAppWithClient(clientResult.client, {
      ...options,
      creatorUserId: clientResult.identity.userId,
    });
    return {
      ok: true,
      ...credentials,
      brand: 'feishu',
      sessionFile: prepared.sessionFile,
      sessionSource: prepared.source,
      sessionIdentity: clientResult.identity,
    };
  } catch (err) {
    const message = safeErrorMessage(err);
    return {
      ok: false,
      reason: /默认应用图标/.test(message) ? 'missing_icon' : 'api_error',
      message,
      ...(err instanceof CreatedOpenPlatformAppError ? { appId: err.appId } : {}),
      sessionFile: prepared.sessionFile,
    };
  }
}

/**
 * 列出当前登录人可见的自建应用（console `getAppList` 同款：
 * POST /developers/v1/app/list，body {Count, Cursor, QueryFilter}，响应
 * data.apps + totalCount，分页拉全）。console 是内部接口，item 字段名做
 * 宽松解析，取不到 cli_ 开头 clientId 的条目丢弃。失败抛错（含 API 错误）。
 */
export async function listOpenPlatformApps(
  client: OpenPlatformApiClient,
  opts: { pageSize?: number; maxApps?: number } = {},
): Promise<OpenPlatformAppSummary[]> {
  const pageSize = opts.pageSize ?? 100;
  const maxApps = opts.maxApps ?? 500;
  const out: OpenPlatformAppSummary[] = [];
  for (let cursor = 0; cursor < maxApps; cursor += pageSize) {
    const payload = await client.postJson('/developers/v1/app/list', {
      Count: pageSize,
      Cursor: cursor,
      QueryFilter: {},
    });
    const record = asRecord(payload);
    const data = asRecord(record.data);
    const apps = Array.isArray(data.apps) ? data.apps : Array.isArray(record.apps) ? (record.apps as unknown[]) : [];
    for (const item of apps) {
      const rec = asRecord(item);
      const clientId = pickString(rec, ['clientId', 'client_id', 'appId', 'app_id', 'appID']);
      if (!clientId || !clientId.startsWith('cli_')) continue;
      const name = pickString(rec, ['name', 'appName', 'app_name']) ?? clientId;
      const description = pickString(rec, ['description', 'desc', 'appDesc', 'app_desc']);
      out.push({ clientId, name, ...(description ? { description } : {}) });
    }
    const totalCount = typeof data.totalCount === 'number' ? data.totalCount
      : typeof record.totalCount === 'number' ? (record.totalCount as number) : undefined;
    if (apps.length < pageSize) break;
    if (totalCount !== undefined && cursor + pageSize >= totalCount) break;
  }
  return out;
}

/**
 * 读取指定应用的 App Secret（console `getAppSecret` 同款：
 * POST /developers/v1/secret/:clientId，响应含 secret 字段）。
 * 只读接口——绝不触碰 /v1/secret/reset/*（会轮换 secret、打断在跑的 bot）。
 */
export async function fetchOpenPlatformAppSecret(
  client: OpenPlatformApiClient,
  clientId: string,
): Promise<string> {
  const payload = await client.postJson(`/developers/v1/secret/${clientId}`, {});
  const record = asRecord(payload);
  const secret = pickString(asRecord(record.data), ['secret']) ?? pickString(record, ['secret']);
  if (!secret) throw new Error('开放平台没有返回 secret 字段');
  return secret;
}

async function validateFeishuWebSession(cookies: StoredCookie[], fetcher: typeof fetch): Promise<boolean> {
  if (cookies.length === 0) return false;
  const session = new MutableCookieJar(cookies);
  try {
    const response = await session.fetchRaw(fetcher, `${ASK_FEISHU_ORIGIN}/`, { method: 'GET' });
    if (!response.ok) return false;
    const text = await response.text();
    return !isFeishuLoginLikeValue(text);
  } catch {
    return false;
  }
}

async function loginFeishuWebSession(fetcher: typeof fetch, options: FeishuWebSessionOptions): Promise<StoredCookie[]> {
  const session = new MutableCookieJar([]);
  const redirectUrl = `${ASK_FEISHU_ORIGIN}/`;
  // Implements Feishu Web QR session login directly: initialize
  // `/accounts/qrlogin/init`, poll `/accounts/qrlogin/polling`, follow the
  // returned cross-login URI, then persist the resulting cookie jar privately.
  const qrInit = await initFeishuQrLogin(session, fetcher, redirectUrl);
  const qrPayload = buildFeishuQrPayload(qrInit.token);
  const qrText = await renderTerminalQr(qrPayload);
  const onQrCode = options.onQrCode ?? defaultPrintFeishuQrCode;
  await onQrCode({ qrText, qrPayload });

  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const maxWaitMs = options.maxWaitMs ?? 120_000;
  const start = Date.now();
  let lastStatusMessage = '';
  for (;;) {
    if (Date.now() - start > maxWaitMs) {
      throw new FeishuWebSessionError('等待飞书扫码超时', 'timeout');
    }

    const poll = await pollFeishuQrLogin(session, fetcher, qrInit.flowKey);
    if (poll.nextStep === 'enter_app') {
      if (poll.crossLoginUri) {
        await session.fetchRaw(fetcher, poll.crossLoginUri, { method: 'GET' });
      }
      await session.fetchRaw(fetcher, redirectUrl, { method: 'GET' });
      const cookies = session.toJSON();
      if (!await validateFeishuWebSession(cookies, fetcher)) {
        throw new FeishuWebSessionError('飞书扫码已完成，但没有拿到可复用的 Web session', 'invalid_session');
      }
      return cookies;
    }

    const statusMessage = mapFeishuQrPollingStatus(poll.status);
    if (options.onStatus && statusMessage !== lastStatusMessage) {
      lastStatusMessage = statusMessage;
      await options.onStatus(statusMessage);
    }
    if (poll.status === 5) {
      throw new FeishuWebSessionError('二维码已过期', 'qr_expired');
    }
    await sleep(pollIntervalMs);
  }
}

async function initFeishuQrLogin(
  session: MutableCookieJar,
  fetcher: typeof fetch,
  authorizeUrl: string,
): Promise<{ flowKey: string; token: string }> {
  const endpoint = `${FEISHU_ACCOUNTS_ORIGIN}/accounts/qrlogin/init?_r${10000 + Math.floor(Math.random() * 80000)}=${Date.now()}`;
  const response = await session.fetchRaw(fetcher, endpoint, {
    method: 'POST',
    headers: {
      ...FEISHU_COMMON_HEADERS,
      'x-app-id': FEISHU_APP_ID,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      biz_type: null,
      redirect_uri: authorizeUrl,
    }),
  });
  const data = await response.json();
  assertFeishuApiOk(data, 'Feishu QR init failed');
  const token = asRecord(asRecord(data).data).step_info
    ? pickString(asRecord(asRecord(asRecord(data).data).step_info), ['token'])
    : undefined;
  const flowKey = response.headers.get('x-flow-key') ?? '';
  if (!flowKey || !token) {
    throw new FeishuWebSessionError('Feishu QR init missing flow key or token', 'login_failed');
  }
  return { flowKey, token };
}

async function pollFeishuQrLogin(
  session: MutableCookieJar,
  fetcher: typeof fetch,
  flowKey: string,
): Promise<{ nextStep: string | null; status: number | null; crossLoginUri: string | null }> {
  const endpoint = `${FEISHU_ACCOUNTS_ORIGIN}/accounts/qrlogin/polling?_r${10000 + Math.floor(Math.random() * 80000)}=${Date.now()}`;
  const response = await session.fetchRaw(fetcher, endpoint, {
    method: 'POST',
    headers: {
      ...FEISHU_COMMON_HEADERS,
      'x-app-id': FEISHU_APP_ID,
      'x-flow-key': flowKey,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ biz_type: null }),
  });
  const data = await response.json();
  assertFeishuApiOk(data, 'Feishu QR polling failed');
  const payload = asRecord(asRecord(data).data);
  const stepInfo = asRecord(payload.step_info);
  return {
    nextStep: pickString(payload, ['next_step']) ?? null,
    status: typeof stepInfo.status === 'number' ? stepInfo.status : null,
    crossLoginUri: pickString(stepInfo, ['cross_login_uri']) ?? null,
  };
}

function readDefaultScopeManifest(): ScopeManifest {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'lark-scopes.json'),
    join(here, 'setup', 'lark-scopes.json'),
    join(here, '..', 'src', 'setup', 'lark-scopes.json'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    return JSON.parse(readFileSync(candidate, 'utf-8')) as ScopeManifest;
  }
  throw new Error('找不到 botmux lark-scopes.json');
}

class MutableCookieJar {
  private cookies: StoredCookie[];

  constructor(cookies: StoredCookie[]) {
    this.cookies = pruneExpiredCookies(cookies);
  }

  toJSON(): StoredCookie[] {
    this.cookies = pruneExpiredCookies(this.cookies);
    return this.cookies.map(cookie => ({ ...cookie }));
  }

  async fetchText(fetcher: typeof fetch, url: string): Promise<string> {
    const response = await this.fetchRaw(fetcher, url, { method: 'GET' });
    return await response.text();
  }

  async fetchTextWithUrl(fetcher: typeof fetch, url: string): Promise<{ text: string; finalUrl: string }> {
    const response = await this.fetchRaw(fetcher, url, { method: 'GET' });
    return {
      text: await response.text(),
      finalUrl: finalResponseUrl(response, url),
    };
  }

  async fetchRaw(fetcher: typeof fetch, url: string, init: RequestInit = {}, maxHops = 10): Promise<Response> {
    let current = url;
    let referer: string | undefined;
    for (let hop = 0; hop <= maxHops; hop += 1) {
      const headers = new Headers(init.headers);
      const cookieHeader = getCookieHeader(this.cookies, current);
      if (cookieHeader) headers.set('cookie', cookieHeader);
      headers.set('user-agent', headers.get('user-agent') ?? DEFAULT_BROWSER_USER_AGENT);
      if (referer && !headers.has('referer')) headers.set('referer', referer);

      const response = await fetcher(current, { ...init, headers, redirect: 'manual' });
      this.loadFromResponse(current, response.headers);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return response;
        referer = current;
        current = new URL(location, current).toString();
        continue;
      }
      markFinalResponseUrl(response, current);
      return response;
    }
    throw new Error('Too many redirects while accessing open platform');
  }

  private loadFromResponse(responseUrl: string, headers: Headers): void {
    const rawSetCookies = typeof (headers as any).getSetCookie === 'function'
      ? (headers as any).getSetCookie()
      : splitSetCookieHeader(headers.get('set-cookie'));
    for (const raw of rawSetCookies) {
      const cookie = parseSetCookie(responseUrl, raw);
      if (!cookie) continue;
      const idx = this.cookies.findIndex(item => item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path);
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= Date.now()) {
        if (idx >= 0) this.cookies.splice(idx, 1);
        continue;
      }
      if (idx >= 0) this.cookies[idx] = cookie;
      else this.cookies.push(cookie);
    }
    this.cookies = pruneExpiredCookies(this.cookies);
  }
}

export class OpenPlatformApiError extends Error {
  constructor(message: string, readonly payload: unknown) {
    super(message);
  }
}

class FeishuWebSessionError extends Error {
  constructor(message: string, readonly reason: FeishuWebSessionFailureReason) {
    super(message);
  }
}

const DEFAULT_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

function defaultPrintFeishuQrCode(info: { qrText: string }): void {
  process.stderr.write('\n请用飞书 App 扫码完成开放平台自动配置登录：\n\n');
  process.stderr.write(`${info.qrText}\n`);
  process.stderr.write('如果当前环境无法扫码，可重新运行 `botmux setup --no-open-platform-auto` 跳过自动配置。\n\n');
}

async function renderTerminalQr(payload: string): Promise<string> {
  return await new Promise((resolve) => qrcode.generate(payload, { small: true }, qr => resolve(qr)));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertFeishuApiOk(payload: unknown, message: string): void {
  const record = asRecord(payload);
  if (record.code === 0) return;
  const msg = pickString(record, ['message', 'msg']) ?? 'unknown error';
  throw new FeishuWebSessionError(`${message}: ${msg}`, 'login_failed');
}

function isFeishuLoginLikeValue(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes('/accounts/') || normalized.includes('/login') || normalized.includes('qrlogin');
}

function classifyFeishuLoginError(err: unknown): FeishuWebSessionFailureReason {
  if (err instanceof FeishuWebSessionError) return err.reason;
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out|超时/i.test(message)) return 'timeout';
  if (/expired|过期/i.test(message)) return 'qr_expired';
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|network/i.test(message)) return 'network';
  return 'login_failed';
}

function collectScopeEntries(value: unknown, bucket: 'tenant' | 'user' | undefined, out: OpenPlatformScopeEntry[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectScopeEntries(item, bucket, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const name = pickString(record, ['scope_name', 'scopeName', 'name', 'key', 'scopeKey']);
  const id = pickString(record, ['id', 'scope_id', 'scopeId', 'scopeID']);
  if (name && id) out.push({ name, id, bucket });
  for (const [key, child] of Object.entries(record)) {
    const nextBucket = /user/i.test(key)
      ? 'user'
      : /app|client|tenant/i.test(key)
        ? 'tenant'
        : bucket;
    if (child && typeof child === 'object') collectScopeEntries(child, nextBucket, out);
  }
}

function mapScopeIds(scopeNames: string[], catalog: OpenPlatformScopeEntry[], bucket: 'tenant' | 'user') {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const scopeName of scopeNames) {
    const matched =
      catalog.find(entry => entry.name === scopeName && entry.bucket === bucket) ??
      catalog.find(entry => entry.name === scopeName && entry.bucket === undefined) ??
      catalog.find(entry => entry.name === scopeName);
    if (matched) ids.push(matched.id);
    else missing.push(scopeName);
  }
  return { ids: uniqueStrings(ids), missing };
}

/** 从 app_version/list 响应算下一个版本号（最新已发布 +1，无发布版 → 0.0.1）。 */
export function nextAppVersion(payload: unknown): string {
  const data = asRecord(asRecord(payload).data);
  const versions = Array.isArray(data.versions) ? data.versions : [];
  // 取所有版本(含未发布草稿)里的最大三段号 +1——不能只看已发布版本:若存在
  // 未发布草稿(如上架启用失败留下的 1.0.0),只看已发布会算出 0.0.1 撞车,导致
  // 二次发版被平台以「版本号未递增」拒掉,应用永远停在未启用。
  const triples = versions
    .map(item => pickString(asRecord(item), ['appVersion']))
    .filter((version): version is string => Boolean(version))
    .map(version => version.split('.').map(part => Number.parseInt(part, 10)))
    .filter(parts => parts.length === 3 && parts.every(part => Number.isFinite(part)));
  if (triples.length === 0) return '0.0.1';
  const max = triples.reduce((a, b) => {
    for (let i = 0; i < 3; i++) {
      if (b[i] !== a[i]) return b[i] > a[i] ? b : a;
    }
    return a;
  });
  return [max[0], max[1], max[2] + 1].join('.');
}

function extractContactRangeMemberIds(payload: unknown): string[] {
  const data = asRecord(asRecord(payload).data);
  const detail = asRecord(data.contactRangeDetail);
  const members = Array.isArray(detail.members) ? detail.members : [];
  return uniqueStrings(members
    .map(item => pickString(asRecord(item), ['id']))
    .filter((id): id is string => Boolean(id)));
}

/** 从 app_version/create 响应提取 versionId（多种响应形态兼容）。 */
export function extractVersionId(payload: unknown): string | undefined {
  const direct = pickString(asRecord(payload), ['versionId', 'version_id', 'id']);
  if (direct) return direct;
  const data = asRecord(asRecord(payload).data);
  return pickString(data, ['versionId', 'version_id', 'id']) ?? pickString(asRecord(data.appVersion), ['versionId', 'version_id', 'id']);
}

function extractBalancedJsonObject(input: string, start: number): string | null {
  if (input[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < input.length; i += 1) {
    const char = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return null;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isStoredCookieRecord(value: unknown): value is StoredCookie {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cookie = value as Partial<StoredCookie>;
  return typeof cookie.name === 'string'
    && typeof cookie.value === 'string'
    && typeof cookie.domain === 'string'
    && typeof cookie.path === 'string'
    && typeof cookie.secure === 'boolean'
    && typeof cookie.httpOnly === 'boolean'
    && typeof cookie.hostOnly === 'boolean';
}

function pruneExpiredCookies(cookies: StoredCookie[]): StoredCookie[] {
  const now = Date.now();
  return cookies.filter(cookie => cookie.expiresAt === undefined || cookie.expiresAt > now);
}

function domainMatches(hostname: string, cookie: StoredCookie): boolean {
  const host = hostname.toLowerCase();
  const domain = cookie.domain.replace(/^\./, '').toLowerCase();
  if (cookie.hostOnly) return host === domain;
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function splitSetCookieHeader(header: string | null): string[] {
  if (!header) return [];
  const parts: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let i = 0; i < header.length; i += 1) {
    const slice = header.slice(Math.max(0, i - 8), i + 1).toLowerCase();
    if (slice.endsWith('expires=')) inExpires = true;
    if (inExpires && header[i] === ';') inExpires = false;
    if (!inExpires && header[i] === ',') {
      parts.push(header.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(header.slice(start).trim());
  return parts.filter(Boolean);
}

function parseSetCookie(responseUrl: string, header: string): StoredCookie | null {
  const url = new URL(responseUrl);
  const parts = header.split(';').map(part => part.trim()).filter(Boolean);
  const first = parts.shift();
  if (!first) return null;
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const cookie: StoredCookie = {
    name: first.slice(0, eq),
    value: first.slice(eq + 1),
    domain: url.hostname,
    path: '/',
    secure: false,
    httpOnly: false,
    hostOnly: true,
  };
  for (const part of parts) {
    const partEq = part.indexOf('=');
    const key = (partEq >= 0 ? part.slice(0, partEq) : part).trim().toLowerCase();
    const value = partEq >= 0 ? part.slice(partEq + 1).trim() : '';
    if (key === 'domain' && value) {
      cookie.domain = value.toLowerCase();
      cookie.hostOnly = false;
    } else if (key === 'path' && value) {
      cookie.path = value;
    } else if (key === 'secure') {
      cookie.secure = true;
    } else if (key === 'httponly') {
      cookie.httpOnly = true;
    } else if (key === 'expires' && value) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) cookie.expiresAt = parsed;
    } else if (key === 'max-age' && value) {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) cookie.expiresAt = Date.now() + seconds * 1000;
    } else if (key === 'samesite' && value) {
      cookie.sameSite = value;
    }
  }
  return cookie;
}

function summarizeOpenPlatformPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return String(payload);
  const record = payload as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ['code', 'msg', 'message', 'error', 'error_msg']) {
    if (record[key] !== undefined) summary[key] = record[key];
  }
  return JSON.stringify(summary).slice(0, 500);
}

function safeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/[A-Za-z0-9_=-]{24,}/g, '***');
}

function markFinalResponseUrl(response: Response, finalUrl: string): void {
  try {
    Object.defineProperty(response, 'botmuxFinalUrl', {
      value: finalUrl,
      configurable: true,
    });
  } catch {
    // Response can be non-extensible in some runtimes; fall back to response.url.
  }
}

function finalResponseUrl(response: Response, fallbackUrl: string): string {
  return typeof (response as any).botmuxFinalUrl === 'string'
    ? (response as any).botmuxFinalUrl
    : response.url || fallbackUrl;
}
