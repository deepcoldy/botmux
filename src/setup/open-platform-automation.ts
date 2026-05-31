/**
 * Automates the Open Platform half of `botmux setup` after the PersonalAgent
 * app has been created by the Feishu SDK registerApp flow.
 *
 * Follow-up for PR review: the current end-to-end setup can still ask for two
 * QR scans: one for SDK app creation and one for this Web session. These can be
 * collapsed in a later iteration by making the Feishu Web session the primary
 * path for app creation as well: Web QR login -> create/find app -> read
 * AppID/AppSecret -> write bots.json -> configure scopes/redirect/version.
 * With a cached ~/.botmux/feishu-session.json, that path can create another bot
 * with no QR scan at all. Keep the current SDK creation path as the stable
 * fallback until that flow is fully verified.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';

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
    };

export interface OpenPlatformAutomationOptions {
  appId: string;
  brand?: 'feishu' | 'lark';
  sessionFilePath?: string;
  bytedcliFallbackSessionFilePath?: string;
  disableBytedcliFallback?: boolean;
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
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  onQrCode?: (info: { qrText: string; qrPayload: string }) => void | Promise<void>;
  onStatus?: (message: string) => void | Promise<void>;
}


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

export function buildAppVersionCreatePayload(appVersion: string, visibleMemberIds: string[] = []) {
  return {
    appVersion,
    mobileDefaultAbility: 'bot',
    pcDefaultAbility: 'bot',
    changeLog: 'Init version',
    visibleSuggest: {
      departments: [],
      members: visibleMemberIds,
      groups: [],
      isAll: 0,
    },
    applyReasonConfig: {
      apiPrivilegeNeedReason: true,
      contactPrivilegeNeedReason: true,
      dataPrivilegeReasonMap: {},
      visibleScopeNeedReason: true,
      apiPrivilegeReasonMap: {},
      contactPrivilegeReason: '',
      isDataPrivilegeExpandMap: {},
      visibleScopeReason: '',
      dataPrivilegeNeedReason: true,
      isAutoAudit: false,
      isContactExpand: false,
    },
    b2cShareSuggest: false,
    autoPublish: false,
    remark: 'Personal AI assistant for self use',
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
  if (!options.disableBytedcliFallback) {
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
    fallbackSessionFile: options.disableBytedcliFallback ? undefined : fallbackSessionFile,
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

  try {
    await postJson(`/developers/v1/safe_setting/update/${options.appId}`, buildSafeSettingPayload(options.appId));
    const contactRange = await postJson(`/developers/v1/contact_range/${options.appId}`, {});
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
      versionId,
    };
  } catch (err: any) {
    return { ok: false, reason: 'api_error', message: `开放平台自动配置失败: ${safeErrorMessage(err)}`, sessionFile };
  }
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

class OpenPlatformApiError extends Error {
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

function nextAppVersion(payload: unknown): string {
  const data = asRecord(asRecord(payload).data);
  const versions = Array.isArray(data.versions) ? data.versions : [];
  const published = versions
    .map(item => asRecord(item))
    .filter(item => item.versionStatus === 2)
    .map(item => pickString(item, ['appVersion']))
    .filter((version): version is string => Boolean(version));
  if (published.length === 0) return '0.0.1';
  const latest = published[0];
  const parts = latest.split('.').map(part => Number.parseInt(part, 10));
  if (parts.length < 3 || parts.some(part => !Number.isFinite(part))) return '0.0.1';
  parts[parts.length - 1] += 1;
  return parts.join('.');
}

function extractContactRangeMemberIds(payload: unknown): string[] {
  const data = asRecord(asRecord(payload).data);
  const detail = asRecord(data.contactRangeDetail);
  const members = Array.isArray(detail.members) ? detail.members : [];
  return uniqueStrings(members
    .map(item => pickString(asRecord(item), ['id']))
    .filter((id): id is string => Boolean(id)));
}

function extractVersionId(payload: unknown): string | undefined {
  const direct = pickString(asRecord(payload), ['versionId', 'version_id', 'id']);
  if (direct) return direct;
  const data = asRecord(asRecord(payload).data);
  return pickString(data, ['versionId', 'version_id', 'id']) ?? pickString(asRecord(data.appVersion), ['versionId', 'version_id', 'id']);
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
