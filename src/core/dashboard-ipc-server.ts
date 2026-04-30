// src/core/dashboard-ipc-server.ts
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { logger } from '../utils/logger.js';
import * as sessionStore from '../services/session-store.js';
import * as scheduleStore from '../services/schedule-store.js';
import * as groupsStore from '../services/groups-store.js';
import * as scheduler from './scheduler.js';
import { listActiveSessions, findActiveBySessionId, closeSession } from './worker-pool.js';
import { replyMessage } from '../im/lark/client.js';
import { locateLimiter } from './dashboard-locate.js';
import { dashboardEventBus } from './dashboard-events.js';
import {
  composeRowFromActive,
  composeRowFromClosed,
  feishuChatLink,
  setBotName as setRowsBotName,
  getBotName,
  type SessionRow,
} from './dashboard-rows.js';
import type { ScheduledTask, ParsedSchedule } from '../types.js';

export interface IpcServerHandle {
  port: number;
  close: () => Promise<void>;
}

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];

/** Register a handler. Path supports `:name` segments captured into the params object. */
export function ipcRoute(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$',
  );
  routes.push({ method: method.toUpperCase(), pattern, keys, handler });
}

export function jsonRes(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

ipcRoute('GET', '/__health', (_req, res) => {
  jsonRes(res, 200, { ok: true });
});

// ─── Session list / detail ─────────────────────────────────────────────────
// Row shape + composers live in dashboard-rows.ts so worker-pool can publish
// SessionRow events without importing this module (which would create a cycle:
// worker-pool → dashboard-ipc-server → worker-pool).

export type { SessionRow };
export { composeRowFromActive, composeRowFromClosed };

// Re-export setBotName for backwards-compatible imports (daemon.ts).  Both
// callers (this module's cachedBotName + dashboard-rows' cachedBotName) need
// to be primed; here we forward to the rows module which is the canonical
// holder.
export function setBotName(name: string): void { setRowsBotName(name); }

// The daemon's own larkAppId, primed at startup. Required for the groups
// endpoints below which proxy calls into groups-store on this bot's behalf.
let cachedLarkAppId = '';
export function setLarkAppId(id: string): void { cachedLarkAppId = id; }

ipcRoute('GET', '/api/sessions', (_req, res) => {
  // Active first (live state), closed appended (historical)
  const active = listActiveSessions().map(composeRowFromActive);
  const activeIds = new Set(active.map(r => r.sessionId));
  const closed = sessionStore.listSessions()
    .filter(s => s.status === 'closed' && !activeIds.has(s.sessionId))
    .map(composeRowFromClosed);
  jsonRes(res, 200, { sessions: [...active, ...closed] });
});

ipcRoute('GET', '/api/sessions/:sessionId', (_req, res, params) => {
  const ds = findActiveBySessionId(params.sessionId);
  if (ds) return jsonRes(res, 200, { session: composeRowFromActive(ds) });
  const closed = sessionStore.listSessions().find(s => s.sessionId === params.sessionId);
  if (closed) return jsonRes(res, 200, { session: composeRowFromClosed(closed) });
  jsonRes(res, 404, { error: 'not_found' });
});

ipcRoute('POST', '/api/sessions/:sessionId/close', async (_req, res, params) => {
  const r = await closeSession(params.sessionId);
  jsonRes(res, 200, r);
});

ipcRoute('POST', '/api/sessions/:sessionId/locate', async (_req, res, params) => {
  const sid = params.sessionId;
  const acq = locateLimiter.tryAcquire(sid);
  if (!acq.ok) {
    res.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': String(Math.ceil(acq.retryAfterMs / 1000)),
    });
    res.end(JSON.stringify({ ok: false, error: 'rate_limited', retryAfterMs: acq.retryAfterMs }));
    return;
  }
  // Resolve owning session (active first, then closed-store fallback). The
  // locate marker is a bare @-mention of the session's owner — no other text,
  // no AppLink redirect on the frontend. The notification on the user's
  // device is enough to navigate them back to the topic.
  const ds = findActiveBySessionId(sid);
  const closed = ds ? null : sessionStore.getSession(sid);
  const ctx = ds
    ? {
        larkAppId: ds.larkAppId,
        rootMessageId: ds.session.rootMessageId,
        ownerOpenId: ds.session.ownerOpenId,
      }
    : closed
      ? {
          larkAppId: closed.larkAppId ?? '',
          rootMessageId: closed.rootMessageId,
          ownerOpenId: closed.ownerOpenId,
        }
      : null;
  if (!ctx || !ctx.larkAppId) {
    return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  }
  if (!ctx.ownerOpenId) {
    return jsonRes(res, 422, { ok: false, error: 'no_owner' });
  }
  try {
    const messageId = await replyMessage(
      ctx.larkAppId,
      ctx.rootMessageId,
      `<at user_id="${ctx.ownerOpenId}"></at>`,
      'text',
      true,
    );
    jsonRes(res, 200, { ok: true, messageId });
  } catch (err) {
    jsonRes(res, 502, { ok: false, error: String(err) });
  }
});

// ─── Schedules ─────────────────────────────────────────────────────────────

export interface ScheduleRow {
  id: string;
  name: string;
  parsed: ParsedSchedule;
  prompt: string;
  workingDir: string;
  chatId: string;
  rootMessageId?: string;
  larkAppId?: string;
  botName?: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastStatus?: 'ok' | 'error';
  lastError?: string;
  repeat?: { times: number | null; completed: number };
  feishuChatLink: string;
}

function composeScheduleRow(t: ScheduledTask): ScheduleRow {
  return {
    id: t.id,
    name: t.name,
    parsed: t.parsed,
    prompt: t.prompt,
    workingDir: t.workingDir,
    chatId: t.chatId,
    rootMessageId: t.rootMessageId,
    larkAppId: t.larkAppId,
    botName: getBotName(),
    enabled: t.enabled,
    createdAt: t.createdAt,
    lastRunAt: t.lastRunAt,
    nextRunAt: t.nextRunAt,
    lastStatus: t.lastStatus,
    lastError: t.lastError,
    repeat: t.repeat,
    feishuChatLink: feishuChatLink(t.chatId),
  };
}

ipcRoute('GET', '/api/schedules', (_req, res) => {
  // Filter to tasks owned by this daemon's bot (multi-bot setups run one
  // daemon per bot — each only manages its own schedules).  belongsToOwner
  // falls through to "all tasks" when no owner filter is configured (tests).
  const all = scheduleStore.listTasks().filter(t => scheduler.belongsToOwner(t));
  jsonRes(res, 200, { schedules: all.map(composeScheduleRow) });
});

ipcRoute('POST', '/api/schedules/:id/run',    (_req, res, p) => jsonRes(res, 200, scheduler.runNow(p.id)));
ipcRoute('POST', '/api/schedules/:id/pause',  (_req, res, p) => jsonRes(res, 200, scheduler.setEnabled(p.id, false)));
ipcRoute('POST', '/api/schedules/:id/resume', (_req, res, p) => jsonRes(res, 200, scheduler.setEnabled(p.id, true)));

// ─── Groups (Phase B) ──────────────────────────────────────────────────────

ipcRoute('GET', '/api/groups', async (_req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  try {
    const chats = await groupsStore.listChats(cachedLarkAppId);
    jsonRes(res, 200, { chats });
  } catch (e) {
    jsonRes(res, 502, { error: String(e) });
  }
});

ipcRoute('GET', '/api/groups/:chatId/membership', async (_req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  try {
    const inChat = await groupsStore.isInChat(cachedLarkAppId, p.chatId);
    jsonRes(res, 200, { inChat });
  } catch (e) {
    jsonRes(res, 502, { error: String(e) });
  }
});

ipcRoute('POST', '/api/groups/:chatId/add-bots', async (req, res, p) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { larkAppIds?: unknown };
  try {
    body = await readJsonBody<{ larkAppIds?: string[] }>(req);
  } catch {
    return jsonRes(res, 400, { error: 'bad_json' });
  }
  if (!Array.isArray(body.larkAppIds) || !body.larkAppIds.every(x => typeof x === 'string')) {
    return jsonRes(res, 400, { error: 'larkAppIds_required' });
  }
  try {
    const result = await groupsStore.addBotToChat(cachedLarkAppId, p.chatId, body.larkAppIds as string[]);
    jsonRes(res, 200, { result });
  } catch (e) {
    jsonRes(res, 502, { error: String(e) });
  }
});

// Create a brand-new chat with this bot as creator/owner and `larkAppIds` as
// initial bot members. The dashboard's public route picks any online daemon
// to act as creator, then forwards here.
ipcRoute('POST', '/api/groups/create', async (req, res) => {
  if (!cachedLarkAppId) return jsonRes(res, 503, { error: 'larkAppId_not_set' });
  let body: { name?: unknown; larkAppIds?: unknown; userOpenIds?: unknown; transferOwnerTo?: unknown };
  try {
    body = await readJsonBody<{
      name?: string;
      larkAppIds?: string[];
      userOpenIds?: string[];
      transferOwnerTo?: string;
    }>(req);
  } catch {
    return jsonRes(res, 400, { error: 'bad_json' });
  }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined;
  if (!Array.isArray(body.larkAppIds) || !body.larkAppIds.every(x => typeof x === 'string')) {
    return jsonRes(res, 400, { error: 'larkAppIds_required' });
  }
  // userOpenIds and transferOwnerTo are optional; pre-validated upstream by
  // the dashboard route. transferOwnerTo's open_id MUST be in the calling
  // bot's app scope (caller is responsible for that — Lark open_ids are
  // app-scoped; see dashboard/operator-selector.ts).
  const userIds = Array.isArray(body.userOpenIds) && body.userOpenIds.every(x => typeof x === 'string')
    ? (body.userOpenIds as string[])
    : [];
  const transferTo = typeof body.transferOwnerTo === 'string' && body.transferOwnerTo.trim()
    ? body.transferOwnerTo.trim()
    : null;
  try {
    const r = await groupsStore.createChat(cachedLarkAppId, {
      name,
      botIds: body.larkAppIds as string[],
      userIds,
    });
    let ownerTransferredTo: string | null = null;
    let transferError: string | null = null;
    if (transferTo) {
      // Skip transfer if Feishu rejected the invite — transferring to a
      // non-member returns "user not in chat" anyway.
      if (r.invalidUserIds.includes(transferTo)) {
        transferError = 'invitee_rejected';
      } else {
        const tr = await groupsStore.transferChatOwner(cachedLarkAppId, r.chatId, transferTo);
        if (tr.ok) ownerTransferredTo = transferTo;
        else transferError = tr.error;
      }
    }
    jsonRes(res, 200, {
      ok: true,
      chatId: r.chatId,
      invalidBotIds: r.invalidBotIds,
      invalidUserIds: r.invalidUserIds,
      creator: cachedLarkAppId,
      ownerTransferredTo,
      transferError,
    });
  } catch (e) {
    jsonRes(res, 502, { ok: false, error: String((e as Error).message ?? e) });
  }
});

// ─── SSE event stream ──────────────────────────────────────────────────────

ipcRoute('GET', '/api/events', (_req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
  });
  // Initial flush so the client sees the connection alive immediately.
  res.write('retry: 5000\n\n');

  const off = dashboardEventBus.subscribe(ev => {
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.body)}\n\n`);
  });

  const hb = setInterval(() => {
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  }, 15_000);

  res.on('close', () => { off(); clearInterval(hb); });
});

export function startIpcServer(opts: { port: number; host: string }): Promise<IpcServerHandle> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.pattern.exec(url.pathname);
          if (!m) continue;
          const params: Record<string, string> = {};
          r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
          await r.handler(req, res, params);
          return;
        }
        jsonRes(res, 404, { error: 'not_found', path: url.pathname });
      } catch (err) {
        logger.error('[dashboard-ipc] handler error', err);
        if (!res.headersSent) jsonRes(res, 500, { error: String(err) });
      }
    });
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        port,
        close: () => new Promise(r => server.close(() => r())),
      });
    });
    server.once('error', reject);
  });
}
