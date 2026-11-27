import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WecomDashboardSessions } from './sessions.js';
import type { WecomTerminalFront } from './terminal.js';
import type { WecomSessionRead } from './session-observer.js';
import { jsonRes } from '../http.js';
import { selectSessionPage } from '../session-pagination.js';
export async function handleWecomSessionApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: {
  hostAdmin: boolean;
  csrfValid(): boolean;
  readBody(): Promise<Record<string, unknown>>;
  sessions: Pick<WecomDashboardSessions, 'request' | 'terminal'>;
  terminal: Pick<WecomTerminalFront, 'control'>;
}): Promise<boolean> {
  const path = /^\/api\/sessions\/([^/]+)(?:\/(control(?:\/(?:takeover|release))?|insight(?:\/turn\/\d{1,6})?|[^/]+))?$/.exec(url.pathname);
  if (!path) {
    return false;
  }
  let sid = '';
  try {
    sid = decodeURIComponent(path[1]);
  } catch {}
  if (!sid.startsWith('wecom:')) {
    return false;
  }
  if (!deps.hostAdmin) {
    jsonRes(res, 403, { ok: false, error: 'wecom_host_admin_required' });
    return true;
  }
  if (req.method !== 'GET' && !deps.csrfValid()) {
    return true;
  }
  const suffix = path[2] ?? 'detail';
  const operation = suffix.startsWith('control') ? 'control' : suffix;
  if (operation === 'control') {
    try {
      const answer = await deps.terminal.control(req, sid, suffix.split('/')[1] as 'takeover' | 'release' | undefined, url.searchParams);
      jsonRes(res, answer.status, answer.body);
    } catch {
      jsonRes(res, 409, { ok: false, error: 'wecom_terminal_unavailable' });
    }
    return true;
  }
  if (['view-link', 'write-link'].includes(operation) && req.method === 'GET') {
    try {
      await deps.sessions.terminal(sid);
      jsonRes(res, 200, { ok: true, url: `/wecom-terminal/${encodeURIComponent(sid)}/` });
    } catch {
      jsonRes(res, 409, { ok: false, error: 'wecom_terminal_unavailable' });
    }
    return true;
  }
  const read = ['detail', 'history', 'insight', 'view-link', 'write-link'].includes(operation) || operation.startsWith('insight/turn/');
  if ((read && req.method !== 'GET') || (!read && req.method !== 'POST')) {
    jsonRes(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }
  let body: Record<string, unknown> = {};
  if (req.method === 'POST') {
    try {
      body = await deps.readBody();
    } catch {
      jsonRes(res, 400, { ok: false, error: 'bad_json' });
      return true;
    }
  }
  const upstream = await deps.sessions.request(sid, operation, body, url.searchParams);
  res.writeHead(upstream.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(await upstream.text());
  return true;
}
/** Called before pagination. Presence of the complete ID list is authoritative;
 * an incomplete read is intentionally represented without deletion metadata. */
export function mergeWecomSessionSnapshot<T extends { sessionId: string }>(
  legacy: T[],
  hostAdmin: boolean,
  privateSnapshot: { sessions: T[]; complete: boolean },
) {
  return {
    sessions: hostAdmin ? [...legacy, ...privateSnapshot.sessions] : legacy,
    ...(hostAdmin && privateSnapshot.complete ? { wecomSessionIds: privateSnapshot.sessions.map(row => row.sessionId) } : {}),
  };
}

/**
 * The body of `GET /api/wecom/sessions` (host admin only): the WeCom rows the
 * board would carry (every open row and the newest page of closed ones), with
 * `wecomSessionIds` on the same terms as the board snapshot (only for a
 * complete read), and the connection count.
 */
export function wecomSessionsResponse(read: WecomSessionRead) {
  const merged = mergeWecomSessionSnapshot([], true, read);
  const page = selectSessionPage(merged.sessions, new URLSearchParams({ view: 'board' }));
  return {
    sessions: page.sessions,
    ...(merged.wecomSessionIds ? { wecomSessionIds: merged.wecomSessionIds } : {}),
    wecomConnectionCount: read.connectionCount,
  };
}
