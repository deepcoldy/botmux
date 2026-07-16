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

/**
 * Derive a stable, read-only terminal capability for one session.  The domain
 * separator prevents this HMAC from being confused with any other use of the
 * dashboard secret, while binding to sessionId keeps a token from opening a
 * different worker.  The host-only secret is masked from sandboxed CLIs.
 */
export function deriveTerminalViewToken(secret: string, sessionId: string): string {
  return createHmac('sha256', secret)
    .update('botmux-terminal-view-v1\0')
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

/**
 * Resolve terminal write for one request: extract the `X-Botmux-Role` header
 * (a duplicated/array header is treated as absent), verify the request came
 * through the platform proxy (dashboard-token cookie matches this machine's
 * active token), and gate the role's trust on the machine's platform binding.
 *
 * Both `isPlatformBound` and `getDashboardToken` are thunks evaluated on EVERY
 * call — never snapshotted. `botmux bind`/unbind and `botmux dashboard` (token
 * rotation) rewrite state that the dashboard hot-reloads WITHOUT restarting live
 * workers; a cached value would go stale — keep trusting a request after an
 * unbind / token rotation, or deny legitimate platform writes after a bind.
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
  const activeToken = getDashboardToken();
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
  const activeToken = getDashboardToken();
  const platformProxied = !!activeToken && safeTerminalTokenEqual(cookieToken, activeToken);
  return resolveTerminalAccess({
    role,
    tokenMatches,
    viewTokenMatches,
    platformBound: isPlatformBound(),
    platformProxied,
  });
}
