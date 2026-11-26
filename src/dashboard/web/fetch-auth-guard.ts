export type FetchUnauthorizedAction =
  | { kind: 'ignore' }
  | { kind: 'auth-expired'; loginUrl?: string }
  | { kind: 'readonly-toast' };

const PLUGIN_SERVICE_PROXY_PATH_RE = /^\/api\/plugins\/[^/]+\/service(?:\/|$)/;

/**
 * Decide how the Dashboard SPA's global `fetch` wrapper reacts to a `401`
 * response:
 * - Cross-origin 401s are ignored (never open Dashboard login overlays or honor
 *   cross-origin `x-botmux-login-url`).
 * - Same-origin 401s from `/api/plugins/:id/service/*` carrying
 *   `x-botmux-plugin-proxy: 1` came from the upstream plugin service, not
 *   Dashboard session expiry, so pass them straight to the plugin caller.
 * - Unmarked 401s (excluding expected `x-botmux-auth-scope: workbench` denials)
 *   indicate Dashboard session expiry or read-only mode.
 */
export function classifyFetchUnauthorized(params: {
  input: RequestInfo | URL;
  init?: RequestInit;
  response: Pick<Response, 'status' | 'headers'>;
  locationHref: string;
  publicReadOnly: boolean;
}): FetchUnauthorizedAction {
  const { input, init, response, locationHref, publicReadOnly } = params;
  if (response.status !== 401) return { kind: 'ignore' };

  let sameOrigin = true;
  let pathname = '';
  try {
    const rawUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input?.url ?? '';
    const resolved = new URL(rawUrl, locationHref);
    const base = new URL(locationHref);
    sameOrigin = resolved.origin === base.origin;
    pathname = resolved.pathname;
  } catch {
    sameOrigin = true;
  }
  if (!sameOrigin) return { kind: 'ignore' };

  if (
    PLUGIN_SERVICE_PROXY_PATH_RE.test(pathname)
    && response.headers.get('x-botmux-plugin-proxy') === '1'
  ) {
    return { kind: 'ignore' };
  }
  if (response.headers.get('x-botmux-auth-scope') === 'workbench') {
    return { kind: 'ignore' };
  }

  const loginUrl = response.headers.get('x-botmux-login-url') ?? undefined;
  const fallbackMethod = typeof Request !== 'undefined' && input instanceof Request
    ? input.method
    : 'GET';
  const method = (init?.method ?? fallbackMethod).toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';
  if (loginUrl || (isRead && !publicReadOnly)) {
    return { kind: 'auth-expired', ...(loginUrl ? { loginUrl } : {}) };
  }
  return { kind: 'readonly-toast' };
}
