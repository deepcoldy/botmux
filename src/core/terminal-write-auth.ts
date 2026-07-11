// Terminal write-permission gate.
//
// The web terminal grants write access one of two ways:
//
//  1. Platform-injected role — when a central platform fronts `/s`, it
//     authenticates the viewer and injects `X-Botmux-Role` (owner | teammate |
//     guest), first stripping any client-supplied copy. Only `owner` may write.
//
//  2. Legacy write token — the `?token=<workerToken>` query param.
//
// The role header is trustworthy ONLY behind that platform boundary. A
// self-hosted deployment (not bound to a platform) has no boundary stripping the
// header, and the dashboard/terminal-proxy replay request headers verbatim — so
// a client could send `X-Botmux-Role: owner` and bypass the token gate =
// unauthenticated terminal write = RCE. We therefore honor the role header ONLY
// when this machine is bound to a central platform; otherwise the header is
// ignored and write falls back to the `?token=` gate.

export interface TerminalWriteInput {
  /** Value of the `X-Botmux-Role` request header (normalized to a single string, or undefined). */
  role: string | undefined;
  /** Whether the request's `?token=` matched the worker's write token. */
  tokenMatches: boolean;
  /** Whether this machine is bound to a central platform (a trusted boundary fronts `/s`). */
  platformBound: boolean;
}

export function resolveTerminalWrite(
  { role, tokenMatches, platformBound }: TerminalWriteInput,
): { hasWrite: boolean; platformReadonly: boolean } {
  if (platformBound && typeof role === 'string' && role) {
    const hasWrite = role === 'owner';
    return { hasWrite, platformReadonly: !hasWrite };
  }
  return { hasWrite: tokenMatches, platformReadonly: false };
}

/**
 * Resolve terminal write for one request: extract the `X-Botmux-Role` header
 * (a duplicated/array header is treated as absent) and gate it on the machine's
 * platform binding.
 *
 * `isPlatformBound` is a thunk evaluated on EVERY call — never snapshotted.
 * `botmux bind`/unbind rewrites platform.json and the dashboard hot-reloads the
 * tunnel WITHOUT restarting live workers; a cached value would keep trusting a
 * forged role header after an unbind (the RCE would reappear until restart) and
 * would deny legitimate platform writes to sessions that predate a bind.
 */
export function resolveTerminalWriteForRequest(
  headers: Record<string, string | string[] | undefined>,
  tokenMatches: boolean,
  isPlatformBound: () => boolean,
): { hasWrite: boolean; platformReadonly: boolean } {
  const rawRole = headers['x-botmux-role'];
  const role = typeof rawRole === 'string' ? rawRole : undefined;
  return resolveTerminalWrite({ role, tokenMatches, platformBound: isPlatformBound() });
}
