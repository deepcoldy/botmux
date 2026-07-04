/**
 * Groups action helpers — single source of truth for the
 * `/api/groups/:chatId/*` action routes that used to live inline in
 * `dashboard.ts`.
 *
 * Each helper returns a `HandlerResult { status, body }` so the dashboard route
 * and the HMAC-gated `/__daemon/groups/...` route render the same
 * response. Behaviour is byte-equivalent to the original inline implementation;
 * all IO flows through `deps`.
 */

export interface DaemonHandle {
  larkAppId: string;
  ipcPort: number;
  botName?: string;
}

/** Minimum session shape required by the cascade-close predicate. */
export interface SessionLikeForClose {
  chatId: string;
  larkAppId: string;
}

export interface GroupsActionDeps {
  /** Iterate currently-online daemons, sorted however the dashboard wants. */
  registryList: () => Iterable<DaemonHandle>;
  /** Look up one daemon by larkAppId; returns undefined if offline / unknown. */
  registryGetByAppId: (appId: string) => DaemonHandle | undefined;
  /** Proxy a request to the named daemon. Mirrors `dashboard.ts:proxyToDaemon`. */
  proxyToDaemon: (larkAppId: string, daemonPath: string, init: RequestInit) => Promise<Response>;
  /** Close sessions matching a predicate. Returns an opaque list (we just pass it through). */
  closeSessionsMatching: (predicate: (s: SessionLikeForClose) => boolean) => Promise<unknown[]>;
  /** Override for tests; defaults to global fetch in production. */
  fetch?: typeof fetch;
}

export interface HandlerResult {
  status: number;
  body: unknown;
  /** Optional response headers — currently unused (all responses are JSON). */
  headers?: Record<string, string>;
}

function ok<T>(body: T, status = 200): HandlerResult { return { status, body }; }
function err(error: string, status: number): HandlerResult { return { status, body: { ok: false, error } }; }

async function parseUpstream(upstream: Response): Promise<{ text: string; json: any | null }> {
  const text = await upstream.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* tolerate non-JSON upstreams */ }
  return { text, json };
}

/**
 * POST /api/groups/:chatId/add-bots — find any daemon already in chat, proxy
 * the body verbatim. The first inChat daemon wins (deterministic by
 * registry-list ordering). Response is the upstream raw body.
 */
export async function addBotsToGroup(
  chatId: string,
  bodyRaw: string,
  deps: GroupsActionDeps,
): Promise<HandlerResult> {
  try {
    JSON.parse(bodyRaw || '{}');
  } catch {
    return err('bad_json', 400);
  }
  const fetchFn = deps.fetch ?? fetch;
  let proxy: DaemonHandle | undefined;
  for (const d of deps.registryList()) {
    try {
      const r = await fetchFn(`http://127.0.0.1:${d.ipcPort}/api/groups/${encodeURIComponent(chatId)}/membership`);
      if (!r.ok) continue;
      const j = await r.json() as { inChat?: boolean };
      if (j.inChat) { proxy = d; break; }
    } catch { /* skip offline daemons */ }
  }
  if (!proxy) return ok({ ok: false, error: 'no_proxy_bot' }, 200);

  const upstream = await fetchFn(
    `http://127.0.0.1:${proxy.ipcPort}/api/groups/${encodeURIComponent(chatId)}/add-bots`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyRaw },
  );
  const { text, json } = await parseUpstream(upstream);
  return { status: upstream.status, body: json ?? text };
}

/**
 * POST /api/groups/:chatId/disband — proxy to the named bot's daemon. On
 * success, cascade-close every session in this chat (cross-bot). Response
 * shape: `{ ...upstreamJson, closedSessions }`.
 */
export async function disbandGroup(
  chatId: string,
  bodyParsed: unknown,
  deps: GroupsActionDeps,
): Promise<HandlerResult> {
  const appId =
    bodyParsed && typeof bodyParsed === 'object'
      ? (bodyParsed as { larkAppId?: unknown }).larkAppId
      : undefined;
  if (typeof appId !== 'string' || appId.length === 0) {
    return err('larkAppId_required', 400);
  }

  const upstream = await deps.proxyToDaemon(
    appId, `/api/groups/${encodeURIComponent(chatId)}/disband`, { method: 'POST' },
  );
  const { json } = await parseUpstream(upstream);

  let closedSessions: unknown[] = [];
  if (json?.ok) {
    closedSessions = await deps.closeSessionsMatching(s => s.chatId === chatId);
  }
  return { status: upstream.status, body: { ...(json ?? {}), closedSessions } };
}

/**
 * POST /api/groups/:chatId/leave — selected bots leave the chat in parallel.
 * Each is membership-checked first so a stale UI cache shows `not_in_chat`
 * rather than a generic Lark error. On per-bot success, that bot's sessions
 * in the chat are cascade-closed. Response shape: `{ result: PerBotResult[] }`.
 */
export async function leaveGroup(
  chatId: string,
  bodyParsed: unknown,
  deps: GroupsActionDeps,
): Promise<HandlerResult> {
  const rawIds =
    bodyParsed && typeof bodyParsed === 'object'
      ? (bodyParsed as { larkAppIds?: unknown }).larkAppIds
      : undefined;
  const ids = Array.isArray(rawIds)
    ? (rawIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  if (ids.length === 0) return err('larkAppIds_required', 400);

  const fetchFn = deps.fetch ?? fetch;
  const result = await Promise.all(ids.map(async appId => {
    const d = deps.registryGetByAppId(appId);
    // Pre-proxy failure shapes do NOT carry `closedSessions` — matches the
    // historical inline route (`dashboard.ts`) which only attaches
    // `closedSessions` to the upstream-proxy branch.
    if (!d) return { larkAppId: appId, ok: false, error: 'daemon_offline' };
    try {
      const memRes = await fetchFn(`http://127.0.0.1:${d.ipcPort}/api/groups/${encodeURIComponent(chatId)}/membership`);
      const memJson = await memRes.json() as { inChat?: boolean };
      if (!memJson.inChat) return { larkAppId: appId, ok: false, error: 'not_in_chat' };
    } catch (e: any) {
      return { larkAppId: appId, ok: false, error: `membership_check_failed: ${e?.message ?? e}` };
    }
    const upstream = await deps.proxyToDaemon(
      appId, `/api/groups/${encodeURIComponent(chatId)}/leave`, { method: 'POST' },
    );
    const { json } = await parseUpstream(upstream);
    // Post-proxy result always carries `closedSessions` (empty on failure).
    const closedSessions = json?.ok
      ? await deps.closeSessionsMatching(s => s.chatId === chatId && s.larkAppId === appId)
      : [];
    return {
      larkAppId: appId,
      ok: !!json?.ok,
      error: json?.ok ? undefined : (json?.error ?? `http_${upstream.status}`),
      closedSessions,
    };
  }));
  return ok({ result });
}

/**
 * PUT /api/groups/:chatId/oncall/:appId — bind / update the per-(chat × bot)
 * oncall workingDir. Internal proxy path is `/api/oncall/:chatId` PUT on the
 * named bot's daemon. Body (workingDir JSON) is forwarded verbatim.
 */
export async function bindOncall(
  chatId: string,
  appId: string,
  bodyRaw: string,
  deps: GroupsActionDeps,
): Promise<HandlerResult> {
  const upstream = await deps.proxyToDaemon(
    appId, `/api/oncall/${encodeURIComponent(chatId)}`,
    { method: 'PUT', headers: { 'content-type': 'application/json' }, body: bodyRaw || '{}' },
  );
  const { text, json } = await parseUpstream(upstream);
  return { status: upstream.status, body: json ?? text };
}

/**
 * DELETE /api/groups/:chatId/oncall/:appId — unbind the per-(chat × bot)
 * oncall. Internal proxy path is `/api/oncall/:chatId` DELETE.
 */
export async function unbindOncall(
  chatId: string,
  appId: string,
  deps: GroupsActionDeps,
): Promise<HandlerResult> {
  const upstream = await deps.proxyToDaemon(
    appId, `/api/oncall/${encodeURIComponent(chatId)}`, { method: 'DELETE' },
  );
  const { text, json } = await parseUpstream(upstream);
  return { status: upstream.status, body: json ?? text };
}
