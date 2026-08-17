import { buildWorkbenchHash, type WorkbenchSurface } from './agent-workbench-model.js';

export type WorkbenchBrand = 'feishu' | 'lark';

export interface FeishuJsApiOptions {
  openChatId: string;
  needBadge?: boolean;
  success?: (value?: unknown) => void;
  fail?: (error?: unknown) => void;
  complete?: () => void;
}

export interface FeishuJsApi {
  toggleChat?: (options: FeishuJsApiOptions) => unknown;
  enterChat?: (options: FeishuJsApiOptions) => unknown;
}

export interface WorkbenchH5Context {
  enabled: boolean;
  appId: string;
  brand: WorkbenchBrand;
  entryPath: string;
}

export interface OpenWorkbenchChatOptions {
  chatId: string;
  appLink?: string;
  preferSplit: boolean;
  /** JSAPI is only attempted when this is not false. An unsigned page gets
   *  refused anyway (errno=105) — but only after an async round-trip, and that
   *  await is what strips user activation off the AppLink fallback, which the
   *  client then demotes to a page-initiated open. False keeps the dispatch
   *  inside the click's own task, like the Dashboard's plain anchor. */
  nativeEnabled?: boolean;
  sdk?: FeishuJsApi | null;
  timeoutMs?: number;
  openExternal?: (url: string) => void;
}

export type OpenWorkbenchChatResult =
  | { kind: 'native-split'; method: 'toggleChat' }
  | { kind: 'native-jump'; method: 'enterChat' }
  /** `rejectedBecause` is the client's own reason the native path failed,
   *  when it gave one. Absent means the SDK was simply not present. */
  | { kind: 'applink'; method: 'AppLink'; url: string; rejectedBecause?: string };

declare global {
  interface Window {
    tt?: FeishuJsApi;
    h5sdk?: { ready?: (callback: () => void) => void };
  }
}

function appLinkHost(brand: WorkbenchBrand): string {
  return brand === 'lark' ? 'https://applink.larksuite.com' : 'https://applink.feishu.cn';
}

/** chat/open must stay a bare link: sidebar-semi/width params are a web_url
 *  container contract, and a chat/open carrying them makes the client abandon
 *  in-place placement and navigate — the exact jump this module exists to
 *  avoid. Chat-panel width is client-owned; do not try to smuggle it in here. */
export function buildChatAppLink(chatId: string, brand: WorkbenchBrand = 'feishu'): string {
  const url = new URL('/client/chat/open', appLinkHost(brand));
  url.searchParams.set('openChatId', chatId);
  return url.toString();
}

export function buildWorkbenchWebAppLink(options: {
  appId: string;
  brand?: WorkbenchBrand;
  surface: WorkbenchSurface;
  targetOrigin: string;
  sessionId?: string;
}): string | null {
  if (!options.appId.trim() || !/^https?:\/\//.test(options.targetOrigin)) return null;
  try {
    const url = new URL('/client/web_app/open', appLinkHost(options.brand ?? 'feishu'));
    const hash = buildWorkbenchHash(options.surface, options.sessionId);
    const target = new URL('/', options.targetOrigin);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    target.hash = hash;
    url.searchParams.set('appId', options.appId);
    url.searchParams.set('mode', options.surface === 'dock' ? 'sidebar' : 'appCenter');
    if (options.surface === 'dock') {
      url.searchParams.set('min_width', '350');
      url.searchParams.set('max_width', '520');
    }
    url.searchParams.set('lk_target_url', target.toString());
    return url.toString();
  } catch {
    return null;
  }
}

export function buildWorkbenchLoginUrl(
  entryPath: string,
  surface: WorkbenchSurface,
  sessionId?: string,
): string {
  const path = /^\/[A-Za-z0-9/_-]+$/.test(entryPath) ? entryPath : '/auth/feishu';
  return `${path}?returnTo=${encodeURIComponent(`/${buildWorkbenchHash(surface, sessionId)}`)}`;
}

/**
 * Three-state on purpose. Opening a chat is a side effect that has already
 * happened by the time we are waiting: a client that performs the action but
 * never invokes `success` is not the same as one that reports `fail`. Collapsing
 * both into false made the caller run its fallback on top of a chat the client
 * had already opened — the visible double navigation.
 */
type JsApiOutcome = 'ok' | 'failed' | 'no-response';

/** Why the call ended that way. `detail` carries the client's own error (errno
 *  and message) so a rejection can be reported as observed rather than guessed
 *  at — "unauthorised JSAPI" is a diagnosis that has to come from the client. */
export interface JsApiResult {
  outcome: JsApiOutcome;
  detail?: string;
}

function describeJsApiError(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return typeof error === 'string' ? error.slice(0, 120) : undefined;
  const record = error as Record<string, unknown>;
  const errno = record.errno ?? record.errCode ?? record.code;
  const message = record.errString ?? record.errMsg ?? record.message;
  const parts = [
    errno === undefined ? '' : `errno=${String(errno).slice(0, 40)}`,
    typeof message === 'string' ? message.slice(0, 90) : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : undefined;
}

function invokeJsApi(
  method: ((options: FeishuJsApiOptions) => unknown) | undefined,
  receiver: FeishuJsApi,
  chatId: string,
  timeoutMs: number,
): Promise<JsApiResult> {
  if (typeof method !== 'function') return Promise.resolve({ outcome: 'failed', detail: 'method unavailable' });
  return new Promise(resolve => {
    let settled = false;
    const finish = (outcome: JsApiOutcome, detail?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(detail === undefined ? { outcome } : { outcome, detail });
    };
    const timer = setTimeout(() => finish('no-response'), timeoutMs);
    try {
      const returned = method.call(receiver, {
        openChatId: chatId,
        needBadge: true,
        success: () => finish('ok'),
        fail: error => finish('failed', describeJsApiError(error)),
      });
      if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(returned).then(
          () => finish('ok'),
          error => finish('failed', describeJsApiError(error)),
        );
      }
    } catch (error) {
      finish('failed', describeJsApiError(error));
    }
  });
}

/** Capability-first PC split, then enterChat, then a stable AppLink. */
export async function openWorkbenchChat(options: OpenWorkbenchChatOptions): Promise<OpenWorkbenchChatResult> {
  const sdk = options.sdk ?? (typeof window !== 'undefined' ? window.tt ?? null : null);
  const timeoutMs = Math.max(250, options.timeoutMs ?? 1_500);
  // Only an explicit `fail` justifies trying the next mechanism. Silence means
  // the client most likely acted without reporting back, and stacking enterChat
  // (a full-page jump) on top of an already-open side panel is worse than
  // stopping here.
  let rejection: string | undefined;
  const native = options.nativeEnabled !== false;
  if (sdk && native && options.preferSplit) {
    const result = await invokeJsApi(sdk.toggleChat, sdk, options.chatId, timeoutMs);
    if (result.outcome !== 'failed') return { kind: 'native-split', method: 'toggleChat' };
    rejection = result.detail;
    // toggleChat was rejected. enterChat needs the same JSAPI authorisation, so
    // it would fail identically while additionally navigating the whole page —
    // go straight to the AppLink and let the client place the chat instead.
  } else if (sdk && native) {
    const result = await invokeJsApi(sdk.enterChat, sdk, options.chatId, timeoutMs);
    if (result.outcome !== 'failed') return { kind: 'native-jump', method: 'enterChat' };
    rejection = result.detail;
  }
  let url = buildChatAppLink(options.chatId);
  if (options.appLink) {
    try {
      const candidate = new URL(options.appLink);
      if (candidate.protocol === 'https:'
        && (candidate.hostname === 'applink.feishu.cn' || candidate.hostname === 'applink.larksuite.com')
        && candidate.pathname === '/client/chat/open'
        && candidate.searchParams.get('openChatId') === options.chatId) {
        url = candidate.toString();
      }
    } catch {
      // Malformed/session-controlled metadata falls back to the canonical link.
    }
  }
  options.openExternal?.(url);
  return rejection === undefined
    ? { kind: 'applink', method: 'AppLink', url }
    : { kind: 'applink', method: 'AppLink', url, rejectedBecause: rejection };
}

let sdkLoad: Promise<FeishuJsApi | null> | null = null;

/** Lazy, UA-gated SDK load: ordinary browsers do not fetch or assume Feishu globals. */
export function ensureFeishuJsApi(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): Promise<FeishuJsApi | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return Promise.resolve(null);
  if (window.tt) return Promise.resolve(window.tt);
  if (!/(Lark|Feishu|LarkShell)/i.test(userAgent)) return Promise.resolve(null);
  if (sdkLoad) return sdkLoad;
  sdkLoad = new Promise(resolve => {
    const script = document.createElement('script');
    script.src = 'https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.44.js';
    script.async = true;
    script.referrerPolicy = 'no-referrer';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(window.tt ?? null);
    };
    const timer = window.setTimeout(finish, 5_000);
    script.onload = () => {
      try {
        if (window.h5sdk?.ready) window.h5sdk.ready(finish);
        else finish();
      } catch {
        finish();
      }
    };
    script.onerror = finish;
    document.head.appendChild(script);
  });
  return sdkLoad;
}
