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
  sdk?: FeishuJsApi | null;
  timeoutMs?: number;
  openExternal?: (url: string) => void;
}

export type OpenWorkbenchChatResult =
  | { kind: 'native-split'; method: 'toggleChat' }
  | { kind: 'native-jump'; method: 'enterChat' }
  | { kind: 'applink'; method: 'AppLink'; url: string };

declare global {
  interface Window {
    tt?: FeishuJsApi;
    h5sdk?: { ready?: (callback: () => void) => void };
  }
}

function appLinkHost(brand: WorkbenchBrand): string {
  return brand === 'lark' ? 'https://applink.larksuite.com' : 'https://applink.feishu.cn';
}

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

function invokeJsApi(
  method: ((options: FeishuJsApiOptions) => unknown) | undefined,
  receiver: FeishuJsApi,
  chatId: string,
  timeoutMs: number,
): Promise<boolean> {
  if (typeof method !== 'function') return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      const returned = method.call(receiver, {
        openChatId: chatId,
        needBadge: true,
        success: () => finish(true),
        fail: () => finish(false),
      });
      if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(returned).then(() => finish(true), () => finish(false));
      }
    } catch {
      finish(false);
    }
  });
}

/** Capability-first PC split, then enterChat, then a stable AppLink. */
export async function openWorkbenchChat(options: OpenWorkbenchChatOptions): Promise<OpenWorkbenchChatResult> {
  const sdk = options.sdk ?? (typeof window !== 'undefined' ? window.tt ?? null : null);
  const timeoutMs = Math.max(250, options.timeoutMs ?? 1_500);
  if (sdk && options.preferSplit && await invokeJsApi(sdk.toggleChat, sdk, options.chatId, timeoutMs)) {
    return { kind: 'native-split', method: 'toggleChat' };
  }
  if (sdk && await invokeJsApi(sdk.enterChat, sdk, options.chatId, timeoutMs)) {
    return { kind: 'native-jump', method: 'enterChat' };
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
  return { kind: 'applink', method: 'AppLink', url };
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
