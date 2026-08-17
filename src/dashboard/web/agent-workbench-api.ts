import type { WorkbenchH5Context } from './agent-workbench-chat.js';
import { controlCsrfHeaders } from './control-csrf.js';

export interface TerminalControlState {
  mode: 'readonly' | 'controlled';
  owned: boolean;
  expiresAt?: number;
  reused?: boolean;
  /** Trusted platform owners have a fixed role, not a releasable takeover lease. */
  fixed?: boolean;
}

export interface PreviewInteractionState {
  mode: 'preview' | 'interactive';
  label: string;
  securityNotice: string;
  idleExpiresAt?: number;
}

export interface WorkbenchApi {
  getTerminalControl(sessionId: string, signal?: AbortSignal): Promise<TerminalControlState>;
  takeoverTerminal(sessionId: string, signal?: AbortSignal): Promise<TerminalControlState>;
  releaseTerminal(sessionId: string, signal?: AbortSignal): Promise<TerminalControlState>;
  getPreviewInteraction(sessionId: string, signal?: AbortSignal): Promise<PreviewInteractionState>;
  unlockPreview(sessionId: string, signal?: AbortSignal): Promise<PreviewInteractionState>;
  touchPreview(sessionId: string, signal?: AbortSignal): Promise<PreviewInteractionState>;
  lockPreview(sessionId: string, signal?: AbortSignal): Promise<PreviewInteractionState>;
  getH5Context(signal?: AbortSignal): Promise<WorkbenchH5Context | null>;
  /** Capability URL for the read-only terminal (viewToken-bearing). The frame
   *  authenticates by this capability, so it also works where no Dashboard
   *  cookie exists — a Feishu WebView being the case that motivated it.
   *  The server answers with a same-origin path and this client refuses
   *  anything else (P1-5) — see `sameOriginViewLink`.
   *  The capability is short-lived and bound to this login (P1-5): `expiresAt`
   *  is when the server stops honoring it, so callers should fetch a fresh
   *  link shortly before then (null when the server did not say). */
  getTerminalViewLink(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; expiresAt: number | null } | null>;
  /** 让 bot 在会话原话题里发一条 @ 拥有者的定位标记。服务端对每个会话有 30s
   *  限流，超了返回 429 + `retry-after`（见 WorkbenchApiError.retryAfterSeconds）。 */
  locateSession(sessionId: string, signal?: AbortSignal): Promise<void>;
}

export class WorkbenchApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    /** 仅 429 有值：还要等多少秒才能重试。调用方据此显示冷却而不是报错。 */
    public readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'WorkbenchApiError';
  }
}

/** 限流响应把等待时长放在 `retry-after` 头（秒）里，body 另带 `retryAfterMs`。
 *  取头优先、body 兜底，两者都没有就返回 undefined（调用方退化成普通错误）。 */
function parseRetryAfter(response: Response, body: Record<string, unknown> | null): number | undefined {
  if (response.status !== 429) return undefined;
  const header = Number(response.headers?.get?.('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.ceil(header);
  const ms = Number(body?.retryAfterMs);
  if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms / 1000);
  return undefined;
}

async function jsonRequest<T>(fetchImpl: typeof fetch, path: string, init: RequestInit = {}): Promise<T> {
  // P1-11：写请求（takeover/release、preview 解锁、locate）带上页面注入的一次性
  // CSRF 票据。读请求不需要，服务端也不校验。
  const method = String(init.method ?? 'GET').toUpperCase();
  const headers = method === 'GET'
    ? init.headers
    : { ...controlCsrfHeaders(), ...(init.headers as Record<string, string> | undefined) };
  const response = await fetchImpl(path, { cache: 'no-store', ...init, headers });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !body || body.ok === false) {
    throw new WorkbenchApiError(
      response.status,
      String(body?.error ?? `http_${response.status}`),
      parseRetryAfter(response, body),
    );
  }
  return body as T;
}

function responseObject(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkbenchApiError(502, code);
  }
  return value as Record<string, unknown>;
}

function optionalDeadline(value: unknown, code: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new WorkbenchApiError(502, code);
  }
  return value;
}

function terminalControlState(value: unknown, fallbackOwned?: boolean): TerminalControlState {
  const body = responseObject(value, 'invalid_control_response');
  if (body.mode !== 'readonly' && body.mode !== 'controlled') {
    throw new WorkbenchApiError(502, 'invalid_control_response');
  }
  const owned = typeof body.owned === 'boolean' ? body.owned : fallbackOwned;
  if (typeof owned !== 'boolean') throw new WorkbenchApiError(502, 'invalid_control_response');
  const expiresAt = optionalDeadline(body.expiresAt, 'invalid_control_response');
  const fixed = body.fixed === undefined ? undefined : body.fixed;
  if (fixed !== undefined && typeof fixed !== 'boolean') {
    throw new WorkbenchApiError(502, 'invalid_control_response');
  }
  if ((body.mode === 'readonly' && (owned || expiresAt !== undefined))
    || (body.mode === 'controlled' && expiresAt === undefined && fixed !== true)) {
    throw new WorkbenchApiError(502, 'invalid_control_response');
  }
  const reused = body.reused === undefined ? undefined : body.reused;
  if (reused !== undefined && typeof reused !== 'boolean') {
    throw new WorkbenchApiError(502, 'invalid_control_response');
  }
  if (fixed === true && (body.mode !== 'controlled' || !owned || expiresAt !== undefined)) {
    throw new WorkbenchApiError(502, 'invalid_control_response');
  }
  return {
    mode: body.mode,
    owned,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(reused === undefined ? {} : { reused }),
    ...(fixed === undefined ? {} : { fixed }),
  };
}

function previewInteractionState(value: unknown): PreviewInteractionState {
  const body = responseObject(value, 'invalid_preview_interaction_response');
  if (body.mode !== 'preview' && body.mode !== 'interactive') {
    throw new WorkbenchApiError(502, 'invalid_preview_interaction_response');
  }
  if (typeof body.label !== 'string' || !body.label || body.label.length > 256
    || typeof body.securityNotice !== 'string' || !body.securityNotice || body.securityNotice.length > 1_024) {
    throw new WorkbenchApiError(502, 'invalid_preview_interaction_response');
  }
  const idleExpiresAt = optionalDeadline(body.idleExpiresAt, 'invalid_preview_interaction_response');
  if ((body.mode === 'preview' && idleExpiresAt !== undefined)
    || (body.mode === 'interactive' && idleExpiresAt === undefined)) {
    throw new WorkbenchApiError(502, 'invalid_preview_interaction_response');
  }
  return {
    mode: body.mode,
    label: body.label,
    securityNotice: body.securityNotice,
    ...(idleExpiresAt === undefined ? {} : { idleExpiresAt }),
  };
}

/** 当前工作台页面的 origin。无 window（SSR、或注入 fetchImpl 的单测）时返回 null，
 *  此时「同源」无从谈起，调用方原样保留上游地址。 */
function currentPageOrigin(): string | null {
  const origin = (globalThis as { window?: { location?: { origin?: unknown } } })
    .window?.location?.origin;
  return typeof origin === 'string' && origin ? origin : null;
}

/** 只接受「工作台页面同源」的 view-link，并在有 origin 时拼成绝对地址。
 *
 *  P1-5 之后服务端只回同源相对路径（形如 `/s/<id>/?viewToken=…`），绝不再回
 *  daemon/worker 自身端口上的绝对 URL。这不只是可达性问题（早先踩过的案例：手机所在办公
 *  网只放行 dashboard 端口，对反代端口没有任何可达连接，iframe 一片空白），更是撤销问题：
 *  daemon 反代和 worker 端口都在网络上开着，且都看不到 dashboard 的登出状态，凭证一旦被
 *  指到那两个 origin 上，中央的吊销检查就形同虚设。所以这里对任何非同源地址一律拒绝，
 *  不再「改写洗白」——服务端本就不会给，真给了也说明链路被人动过手脚。
 *
 *  origin 缺失（SSR / 注入 fetchImpl 的测试环境）或拼接失败（沙箱 iframe 的不透明 origin，
 *  `window.location.origin` 为 "null"）时保留相对路径：相对地址同样只会打到当前源，
 *  iframe 直接用即可。 */
function sameOriginViewLink(path: string): string {
  const origin = currentPageOrigin();
  if (!origin) return path;
  try {
    const rebased = new URL(path, origin);
    if (rebased.protocol !== 'http:' && rebased.protocol !== 'https:') return path;
    return rebased.toString();
  } catch {
    return path;
  }
}

function controlPath(sessionId: string, action?: 'takeover' | 'release'): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/control${action ? `/${action}` : ''}`;
}

function previewPath(sessionId: string, action?: 'unlock' | 'activity' | 'lock'): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/preview-interaction${action ? `/${action}` : ''}`;
}

export function createWorkbenchApi(fetchImpl: typeof fetch = fetch): WorkbenchApi {
  return {
    getTerminalControl: async (sessionId, signal) => terminalControlState(
      await jsonRequest(fetchImpl, controlPath(sessionId), { signal }),
    ),
    takeoverTerminal: async (sessionId, signal) => terminalControlState(
      await jsonRequest(fetchImpl, controlPath(sessionId, 'takeover'), { method: 'POST', signal }),
      true,
    ),
    releaseTerminal: async (sessionId, signal) => terminalControlState(
      await jsonRequest(fetchImpl, controlPath(sessionId, 'release'), { method: 'POST', signal }),
      false,
    ),
    getPreviewInteraction: async (sessionId, signal) => previewInteractionState(
      await jsonRequest(fetchImpl, previewPath(sessionId), { signal }),
    ),
    unlockPreview: async (sessionId, signal) => previewInteractionState(
      await jsonRequest(fetchImpl, previewPath(sessionId, 'unlock'), { method: 'POST', signal }),
    ),
    touchPreview: async (sessionId, signal) => previewInteractionState(
      await jsonRequest(fetchImpl, previewPath(sessionId, 'activity'), { method: 'POST', signal }),
    ),
    lockPreview: async (sessionId, signal) => previewInteractionState(
      await jsonRequest(fetchImpl, previewPath(sessionId, 'lock'), { method: 'POST', signal }),
    ),
    async locateSession(sessionId, signal) {
      await jsonRequest(
        fetchImpl,
        `/api/sessions/${encodeURIComponent(sessionId)}/locate`,
        { method: 'POST', signal },
      );
    },
    async getTerminalViewLink(sessionId, signal) {
      try {
        const body = responseObject(
          await jsonRequest<unknown>(
            fetchImpl,
            `/api/sessions/${encodeURIComponent(sessionId)}/view-link`,
            { signal },
          ),
          'invalid_view_link_response',
        );
        // P1-5: the only shape allowed to reach the DOM is a same-origin
        // terminal path. `//host/...` is a protocol-relative ABSOLUTE URL and
        // `/\host` is treated the same way by browsers, so both are rejected
        // along with every explicit scheme — an absolute link would hand this
        // capability to an origin that cannot enforce revocation.
        if (typeof body.url !== 'string' || body.url.length > 2_048) return null;
        if (!/^\/s\/[^/\\]/.test(body.url)) return null;
        // Malformed expiry degrades to "unknown" rather than rejecting the
        // link: expiry-driven refresh is an optimization, not the gate.
        const expiresAt = typeof body.expiresAt === 'number'
          && Number.isSafeInteger(body.expiresAt) && body.expiresAt > 0
          ? body.expiresAt
          : null;
        return { url: sameOriginViewLink(body.url), expiresAt };
      } catch {
        return null;
      }
    },
    async getH5Context(signal) {
      try {
        const body = responseObject(
          await jsonRequest<unknown>(fetchImpl, '/api/workbench/h5-context', { signal }),
          'invalid_h5_context_response',
        );
        const h5 = responseObject(body.h5, 'invalid_h5_context_response');
        if (typeof h5.enabled !== 'boolean'
          || typeof h5.appId !== 'string' || h5.appId.length > 256
          || (h5.brand !== 'feishu' && h5.brand !== 'lark')
          || typeof h5.entryPath !== 'string' || !/^\/[A-Za-z0-9/_-]{1,127}$/.test(h5.entryPath)) {
          throw new WorkbenchApiError(502, 'invalid_h5_context_response');
        }
        return {
          enabled: h5.enabled,
          appId: h5.appId,
          brand: h5.brand,
          entryPath: h5.entryPath,
        };
      } catch {
        return null;
      }
    },
  };
}
