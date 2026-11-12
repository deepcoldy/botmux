import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DashboardRequestIdentity } from './request-identity.js';
import { guardControlRequest, type ControlCsrfTokens } from './control-csrf.js';
import { jsonRes } from './http.js';

export async function handleGoalControlProxy(
  req: IncomingMessage, res: ServerResponse, url: URL,
  deps: {
    identity: DashboardRequestIdentity | null;
    csrfTokens: ControlCsrfTokens;
    ownerOf: (sessionId: string) => string | undefined;
    proxy: (appId: string, path: string, init: RequestInit) => Promise<Response>;
  },
): Promise<boolean> {
  const match = /^\/api\/sessions\/([^/]+)\/goal$/.exec(url.pathname);
  if (!match) return false;
  const canWrite = deps.identity?.kind === 'legacy-dashboard';
  if (!canWrite) { jsonRes(res, 403, { ok: false, error: 'legacy_owner_required' }); return true; }
  if (req.method !== 'GET' && req.method !== 'POST') {
    jsonRes(res, 405, { ok: false, error: 'method_not_allowed' }); return true;
  }
  if (req.method === 'POST') {
    const guard = guardControlRequest({ headers: req.headers, authSessionId: deps.identity!.authSessionId, tokens: deps.csrfTokens });
    if (!guard.ok) { jsonRes(res, guard.status, { ok: false, error: guard.error }); return true; }
  }
  let sessionId: string;
  try { sessionId = decodeURIComponent(match[1]!); }
  catch { jsonRes(res, 400, { ok: false, error: 'invalid_session_id' }); return true; }
  const owner = deps.ownerOf(sessionId);
  if (!owner) { jsonRes(res, 404, { ok: false, error: 'unknown_session' }); return true; }
  const chunks: Buffer[] = [];
  let bytes = 0;
  if (req.method === 'POST') for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    if (bytes > 20 * 1024) { jsonRes(res, 413, { ok: false, error: 'body_too_large' }); return true; }
    chunks.push(chunk as Buffer);
  }
  try {
    const upstream = await deps.proxy(owner, `/api/sessions/${encodeURIComponent(sessionId)}/goal`, {
      method: req.method,
      ...(req.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks).toString('utf8') } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    res.writeHead(upstream.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(await upstream.text());
  } catch { jsonRes(res, 502, { ok: false, error: 'goal_control_unavailable' }); }
  return true;
}
