// Terminal write-permission gate.
//
// The web terminal grants write access one of two ways:
//
//  1. Private write-link token — the `?token=<workerToken>` query param. An
//     explicitly issued write link is an independent capability and wins
//     outright, including for a viewer the platform sees as guest/teammate.
//
//  2. Platform-injected role — when a central platform fronts `/s`, it
//     authenticates the viewer and injects `X-Botmux-Role` (owner | teammate |
//     guest), first stripping any client-supplied copy. Only `owner` may write.
//
// The role header is trustworthy ONLY on a request that actually came through
// the platform's authenticated reverse proxy. The dashboard `/s` bridge and the
// terminal-proxy replay request headers verbatim, and the front door binds all
// interfaces, so `X-Botmux-Role` alone is client-forgeable — a direct caller
// could send `X-Botmux-Role: owner` and bypass the `?token=` gate. We therefore
// honor the role header only when BOTH hold:
//
//   • this machine is bound to a central platform (`platformBound`), and
//   • the request carries the platform-injected dashboard-token cookie
//     (`platformProxied`) — the platform's proxy drops any client Cookie and
//     injects this machine's real `botmux_dashboard_token`, a secret a direct
//     caller doesn't have. Its presence proves the request traversed the
//     platform's authenticated front door.
//
// Otherwise the role header is ignored and write falls back to `?token=`.

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 中央前门 → worker 的「平台只读访客」**展示层**提示头（#933 回归修复）。
 *
 * 背景：平台注入的 Cookie / `X-Botmux-Role` 在两条路上都会被 dashboard 前门剥掉
 * （显式 query capability 走 P1-6 的 stripBrowserCredentials；无 capability 时换成
 * 内部签名 grant）。剥掉之后 worker 的 `platformReadonly` 恒为 false，只读终端页
 * 便不再显示「owner 登录后可操作 →」的 SSO 引导——冷打开飞书卡片链接的平台访客
 * 被困在一个没有任何登录入口的只读页里。
 *
 * 该头只影响只读页渲染哪条横幅（登录引导 vs 纯只读提示），**不进入任何读/写授权
 * 判定**：直连 worker 伪造它，最多让一个本来就只读的页面多显示一条登录引导链接。
 * 前门在 terminalForwardHeaders 丢弃全部客户端 `x-botmux-*` 之后才设置它，浏览器
 * 无法夹带。
 */
export const TERMINAL_PLATFORM_READONLY_HINT_HEADER = 'x-botmux-platform-readonly';

export interface TerminalWriteInput {
  /** Value of the `X-Botmux-Role` request header (normalized to a single string, or undefined). */
  role: string | undefined;
  /** Whether the request's `?token=` matched the worker's write token. */
  tokenMatches: boolean;
  /** Whether this machine is bound to a central platform (a trusted boundary fronts `/s`). */
  platformBound: boolean;
  /** Whether the request carried a valid platform-injected dashboard-token cookie,
   *  i.e. it genuinely traversed the platform's authenticated reverse proxy. */
  platformProxied: boolean;
}

export interface TerminalAccessInput extends TerminalWriteInput {
  /** Whether the request's `?viewToken=` matched the worker's read capability. */
  viewTokenMatches: boolean;
}

export interface TerminalAccessDecision {
  hasRead: boolean;
  hasWrite: boolean;
  platformReadonly: boolean;
}

// NOTE(P1-5): the stable read capability (`deriveTerminalViewToken`, HMAC of
// secret+sessionId) was deliberately REMOVED. A stable view token could never
// be revoked: an H5 viewer who fetched it once kept terminal read access after
// logout/expiry, and a worker restart re-derived the very same value. Read
// access is now either
//   • the worker's per-boot random `viewToken` (Feishu card links — dies with
//     the worker generation), or
//   • a short-lived signed read grant carried in `?viewToken=` (dashboard
//     view-link API — bound to sessionId + authSessionId + expiresAt, plus
//     `audience: central` and the worker's boot generation; the worker accepts
//     it only when the central front proxy countersigned the hop, so a raw
//     copied URL dialled straight at the worker/daemon port cannot spend it).
// Every previously issued stable view token therefore fails on new workers.
// The WRITE capability below intentionally stays stable — an explicitly issued
// 「操作链接」 is an independent capability that must survive restarts.

/**
 * Derive a stable WRITE (operate) capability for one session. Uses a DISTINCT
 * domain separator from the retired stable view token so the two capabilities
 * can never collide — knowing a read capability must never yield the write
 * token (and vice versa) even for the same session+secret.
 *
 * Rationale: the write token used to be a per-process `randomBytes(16)`, so an
 * already-issued 「操作链接」/write link (`?token=`) died the moment its worker
 * restarted (a silent daemon restart re-forks every worker → new token → old
 * link 403s). Deriving it from the host-only dashboard secret keeps the operate
 * link valid across restarts, exactly like the read-only view token. The
 * host-only secret is masked from sandboxed CLIs, so a sandboxed CLI still
 * can't mint its own write link.
 */
export function deriveTerminalWriteToken(secret: string, sessionId: string): string {
  return createHmac('sha256', secret)
    .update('botmux-terminal-write-v1\0')
    .update(sessionId)
    .digest('base64url');
}

export function resolveTerminalWrite(
  { role, tokenMatches, platformBound, platformProxied }: TerminalWriteInput,
): { hasWrite: boolean; platformReadonly: boolean } {
  // A matching private write-link token is an independent capability: the owner
  // explicitly issued that link, so it grants write even for a viewer the
  // platform authenticated as guest/teammate. Without it, a verified platform
  // role decides; a role header outside the verified-proxy path is ignored.
  if (tokenMatches) return { hasWrite: true, platformReadonly: false };
  if (platformBound && platformProxied && typeof role === 'string' && role) {
    const hasWrite = role === 'owner';
    return { hasWrite, platformReadonly: !hasWrite };
  }
  return { hasWrite: false, platformReadonly: false };
}

/** Resolve both read and write access without ever promoting a view token. */
export function resolveTerminalAccess(input: TerminalAccessInput): TerminalAccessDecision {
  const write = resolveTerminalWrite(input);
  return {
    // A valid dashboard cookie proves that the request passed through the
    // authenticated dashboard/platform front door.  It grants observation even
    // on an unbound local dashboard, while write still follows the stricter
    // token/platform-owner rules above.
    hasRead: write.hasWrite || input.viewTokenMatches || input.platformProxied,
    ...write,
  };
}

/** Constant-time equality (avoids leaking the dashboard token through compare timing). */
export function safeTerminalTokenEqual(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extract the `botmux_dashboard_token` value from a request Cookie header. */
export function readDashboardCookie(cookieHeader: string | string[] | undefined): string | null {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === 'botmux_dashboard_token') return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/** Credential rotation atomically replaces the token file, so a strict
 * inode-stability read may transiently throw while the rename wins. Auth must
 * fail closed for that request rather than letting storage errors escape into
 * the worker HTTP/WebSocket server. */
function readLiveDashboardToken(getDashboardToken: () => string | null): string | null {
  try {
    return getDashboardToken();
  } catch {
    return null;
  }
}

/**
 * Resolve terminal write for one request: extract the `X-Botmux-Role` header
 * (a duplicated/array header is treated as absent), verify the request came
 * through the platform proxy (dashboard-token cookie matches this machine's
 * active token), and gate the role's trust on the machine's platform binding.
 *
 * Both `isPlatformBound` and `getDashboardToken` are thunks evaluated on EVERY
 * call — never snapshotted. `botmux bind`/unbind and `botmux dashboard rotate`
 * rewrite state that the dashboard hot-reloads WITHOUT restarting live workers;
 * a cached value would go stale — keep trusting a request after an unbind / token
 * rotation, or deny legitimate platform writes after a bind.
 */
export function resolveTerminalWriteForRequest(
  headers: Record<string, string | string[] | undefined>,
  tokenMatches: boolean,
  isPlatformBound: () => boolean,
  getDashboardToken: () => string | null,
): { hasWrite: boolean; platformReadonly: boolean } {
  const rawRole = headers['x-botmux-role'];
  const role = typeof rawRole === 'string' ? rawRole : undefined;
  const cookieToken = readDashboardCookie(headers['cookie']);
  const activeToken = readLiveDashboardToken(getDashboardToken);
  const platformProxied = !!activeToken && safeTerminalTokenEqual(cookieToken, activeToken);
  return resolveTerminalWrite({ role, tokenMatches, platformBound: isPlatformBound(), platformProxied });
}

/**
 * Request-level terminal access gate.  Unlike the legacy write-only resolver,
 * this explicitly denies observation unless the caller has a view/write
 * capability or an authenticated dashboard cookie.
 */
export function resolveTerminalAccessForRequest(
  headers: Record<string, string | string[] | undefined>,
  tokenMatches: boolean,
  viewTokenMatches: boolean,
  isPlatformBound: () => boolean,
  getDashboardToken: () => string | null,
): TerminalAccessDecision {
  const rawRole = headers['x-botmux-role'];
  const role = typeof rawRole === 'string' ? rawRole : undefined;
  const cookieToken = readDashboardCookie(headers['cookie']);
  const activeToken = readLiveDashboardToken(getDashboardToken);
  const platformProxied = !!activeToken && safeTerminalTokenEqual(cookieToken, activeToken);
  return resolveTerminalAccess({
    role,
    tokenMatches,
    viewTokenMatches,
    platformBound: isPlatformBound(),
    platformProxied,
  });
}
