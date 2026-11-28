/**
 * Dashboard routes for「会话环境变量」(core/session-env*.ts).
 *
 *   GET  /api/session-env                       global view + tmux servers + running sessions (all bots)
 *   PUT  /api/session-env                       { ops } → config.json `sessionEnv`
 *   GET  /api/session-env/reveal?key=[&source=tmux&socket=]
 *   POST /api/session-env/tmux/remove           { socket, key } → tmux set-environment -g -u
 *   GET  /api/bots/:appId/session-env           bot view (proxied to that bot's daemon)
 *   PUT  /api/bots/:appId/session-env           { ops } → bots.json env / envUnset
 *   GET  /api/bots/:appId/session-env/reveal?key=
 *   GET  /api/bots/:appId/sessions/:sid/env     a running session's real env
 *   GET  /api/bots/:appId/sessions/:sid/env/reveal?key=
 *
 * Every value in a view is masked. Raw values (`reveal`) and the tmux server
 * edit are host-level capabilities: only the local owner identity (the legacy
 * management cookie) gets them. Other managers see every value masked.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseEnvOps, type EnvOp } from '../core/session-env.js';

export interface SessionEnvApiDeps {
  /** Local owner: may read raw values and edit tmux server env tables. */
  canReveal: boolean;
  /**
   * A provider-owned core on this host (the WeCom managed core) that can serve
   * the machine-wide views when the host has no Feishu fleet at all. It is
   * consulted only while no fleet daemon is online AND `fleetConfigured()` is
   * false: a configured fleet that is stopped or failing keeps exactly its own
   * diagnostics (503 / 502 / an older daemon's 404), and the provider core never
   * reveals values or edits tmux server env on the fleet's behalf. Any answer
   * other than 2xx is reported as `daemon_offline`, the same as without it.
   */
  providerMachineHost?: {
    fleetConfigured(): boolean;
    request(path: string, init: RequestInit): Promise<Response>;
  };
  /** Online daemons (any one serves the machine-wide views). */
  daemons(): Array<{ larkAppId: string; botName: string; botIndex: number }>;
  proxyToDaemon(larkAppId: string, daemonPath: string, init: RequestInit): Promise<Response>;
  readJsonBody(req: IncomingMessage): Promise<unknown>;
  /** Persist validated global-layer ops (config.json). */
  applyGlobalOps(ops: readonly EnvOp[]): { ok: true } | { ok: false; error: string };
  jsonRes(res: ServerResponse, status: number, body: unknown): void;
}

const BOT_VIEW_RE = /^\/api\/bots\/([^/]+)\/session-env(\/reveal)?$/;
const LIVE_VIEW_RE = /^\/api\/bots\/([^/]+)\/sessions\/([^/]+)\/env(\/reveal)?$/;

async function relay(res: ServerResponse, upstream: Response, deps: SessionEnvApiDeps, extra?: Record<string, unknown>): Promise<void> {
  const text = await upstream.text();
  if (extra) {
    try {
      const body = JSON.parse(text);
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        return deps.jsonRes(res, upstream.status, { ...body, ...extra });
      }
    } catch { /* fall through: relay verbatim */ }
  }
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
  res.end(text);
}

function primaryDaemon(deps: SessionEnvApiDeps): { larkAppId: string } | undefined {
  return orderedDaemons(deps)[0];
}

function orderedDaemons(deps: SessionEnvApiDeps): Array<{ larkAppId: string; botName: string; botIndex: number }> {
  return [...deps.daemons()].sort((a, b) => a.botIndex - b.botIndex);
}

/** The provider core may answer only on a host with no fleet daemon online and
 *  no fleet bot configured (see SessionEnvApiDeps.providerMachineHost). */
function fleetlessProviderHost(deps: SessionEnvApiDeps): SessionEnvApiDeps['providerMachineHost'] {
  const host = deps.providerMachineHost;
  if (!host || orderedDaemons(deps).length > 0 || host.fleetConfigured()) return undefined;
  return host;
}

/** A provider core's successful answer, or undefined (unavailable, non-2xx, or
 *  not JSON) so the caller reports the ordinary offline diagnostic. */
async function providerMachineAnswer(
  deps: SessionEnvApiDeps,
  path: string,
  init: RequestInit,
): Promise<{ status: number; text: string; contentType: string | null } | undefined> {
  const host = fleetlessProviderHost(deps);
  if (!host) return undefined;
  try {
    const upstream = await host.request(path, init);
    if (!upstream.ok) return undefined;
    return {
      status: upstream.status,
      text: await upstream.text(),
      contentType: upstream.headers.get('content-type'),
    };
  } catch {
    return undefined;
  }
}

/** The machine-wide view from the first daemon that serves it (an older
 *  daemon in a mixed-version fleet may not have the route yet). */
async function machineView(path: string, deps: SessionEnvApiDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  let last: { status: number; body: Record<string, unknown> } = { status: 503, body: { ok: false, error: 'daemon_offline' } };
  for (const d of orderedDaemons(deps)) {
    try {
      const upstream = await deps.proxyToDaemon(d.larkAppId, path, { method: 'GET' });
      const body = await upstream.json() as Record<string, unknown>;
      if (upstream.ok) return { status: upstream.status, body };
      last = { status: upstream.status, body };
    } catch {
      last = { status: 502, body: { ok: false, error: 'bad_upstream' } };
    }
  }
  const provided = await providerMachineAnswer(deps, path, { method: 'GET' });
  if (provided) {
    try {
      return { status: provided.status, body: JSON.parse(provided.text) as Record<string, unknown> };
    } catch {
      /* not a view: keep the offline diagnostic */
    }
  }
  return last;
}

/** No fleet daemon is online: let a fleetless host's provider core answer,
 *  otherwise the original 503. */
async function answerWithoutFleetDaemon(
  res: ServerResponse,
  deps: SessionEnvApiDeps,
  path: string,
  init: RequestInit,
): Promise<void> {
  const provided = await providerMachineAnswer(deps, path, init);
  if (!provided) return deps.jsonRes(res, 503, { ok: false, error: 'daemon_offline' });
  res.writeHead(provided.status, { 'content-type': provided.contentType ?? 'application/json' });
  res.end(provided.text);
}

async function globalView(res: ServerResponse, deps: SessionEnvApiDeps): Promise<void> {
  const mask = deps.canReveal ? '' : '?maskAll=1';
  const { status, body: view } = await machineView(`/api/session-env-global${mask}`, deps);
  if (status < 200 || status >= 300) return deps.jsonRes(res, status, view);
  // Running sessions live in each bot's own daemon.
  const sessions = (await Promise.all(deps.daemons().map(async d => {
    try {
      const r = await deps.proxyToDaemon(d.larkAppId, '/api/session-env-sessions', { method: 'GET' });
      const body = await r.json() as { sessions?: Array<Record<string, unknown>> };
      return (body.sessions ?? []).map(s => ({ ...s, botName: d.botName }));
    } catch {
      return [];
    }
  }))).flat();
  deps.jsonRes(res, 200, { ...view, sessions, canReveal: deps.canReveal });
}

async function readOps(req: IncomingMessage, res: ServerResponse, deps: SessionEnvApiDeps): Promise<unknown | undefined> {
  try {
    const body = await deps.readJsonBody(req) as { ops?: unknown } | null;
    return body?.ops;
  } catch {
    deps.jsonRes(res, 400, { ok: false, error: 'bad_json' });
    return undefined;
  }
}

/** Returns true when the request was handled. */
export async function handleSessionEnvRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: SessionEnvApiDeps,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const ownerOnly = () => deps.jsonRes(res, 403, { ok: false, error: 'owner_required' });

  if (url.pathname === '/api/session-env') {
    if (method === 'GET') { await globalView(res, deps); return true; }
    if (method === 'PUT') {
      const ops = await readOps(req, res, deps);
      if (ops === undefined && res.writableEnded) return true;
      const parsed = parseEnvOps(ops);
      if (!parsed.ok) {
        deps.jsonRes(res, 400, { ok: false, error: parsed.error, ...(parsed.key ? { key: parsed.key } : {}) });
        return true;
      }
      let applied: { ok: true } | { ok: false; error: string };
      try { applied = deps.applyGlobalOps(parsed.ops); }
      catch (err) {
        deps.jsonRes(res, 409, { ok: false, error: 'config_write_failed', reason: (err as Error)?.message ?? String(err) });
        return true;
      }
      if (!applied.ok) { deps.jsonRes(res, 400, { ok: false, error: applied.error }); return true; }
      await globalView(res, deps);
      return true;
    }
    return false;
  }

  if (url.pathname === '/api/session-env/reveal' && method === 'GET') {
    if (!deps.canReveal) { ownerOnly(); return true; }
    const primary = primaryDaemon(deps);
    const revealPath = `/api/session-env-global/reveal${url.search}`;
    if (!primary) {
      await answerWithoutFleetDaemon(res, deps, revealPath, { method: 'GET' });
      return true;
    }
    await relay(res, await deps.proxyToDaemon(primary.larkAppId, revealPath, { method: 'GET' }), deps);
    return true;
  }

  if (url.pathname === '/api/session-env/tmux/remove' && method === 'POST') {
    if (!deps.canReveal) { ownerOnly(); return true; }
    let body: unknown;
    try { body = await deps.readJsonBody(req); }
    catch { deps.jsonRes(res, 400, { ok: false, error: 'bad_json' }); return true; }
    const primary = primaryDaemon(deps);
    const removeInit: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    };
    if (!primary) {
      await answerWithoutFleetDaemon(res, deps, '/api/session-env-tmux/remove', removeInit);
      return true;
    }
    await relay(res, await deps.proxyToDaemon(primary.larkAppId, '/api/session-env-tmux/remove', removeInit), deps);
    return true;
  }

  const bot = BOT_VIEW_RE.exec(url.pathname);
  if (bot) {
    const appId = decodeURIComponent(bot[1]!);
    const mask = deps.canReveal ? '' : '?maskAll=1';
    if (bot[2]) {
      if (method !== 'GET') return false;
      if (!deps.canReveal) { ownerOnly(); return true; }
      await relay(res, await deps.proxyToDaemon(appId, `/api/bot-session-env/reveal${url.search}`, { method: 'GET' }), deps);
      return true;
    }
    if (method === 'GET') {
      await relay(res, await deps.proxyToDaemon(appId, `/api/bot-session-env${mask}`, { method: 'GET' }), deps, { canReveal: deps.canReveal });
      return true;
    }
    if (method === 'PUT') {
      const ops = await readOps(req, res, deps);
      if (ops === undefined && res.writableEnded) return true;
      await relay(res, await deps.proxyToDaemon(appId, `/api/bot-session-env${mask}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops }),
      }), deps, { canReveal: deps.canReveal });
      return true;
    }
    return false;
  }

  const live = LIVE_VIEW_RE.exec(url.pathname);
  if (live && method === 'GET') {
    const appId = decodeURIComponent(live[1]!);
    const sessionId = encodeURIComponent(decodeURIComponent(live[2]!));
    if (live[3]) {
      if (!deps.canReveal) { ownerOnly(); return true; }
      const key = encodeURIComponent(url.searchParams.get('key') ?? '');
      await relay(res, await deps.proxyToDaemon(appId, `/api/bot-session-env/live/reveal?sessionId=${sessionId}&key=${key}`, { method: 'GET' }), deps);
      return true;
    }
    const mask = deps.canReveal ? '' : '&maskAll=1';
    await relay(res, await deps.proxyToDaemon(appId, `/api/bot-session-env/live?sessionId=${sessionId}${mask}`, { method: 'GET' }), deps, { canReveal: deps.canReveal });
    return true;
  }
  return false;
}
