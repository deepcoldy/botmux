// src/core/dashboard-ipc-server.ts
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { logger } from '../utils/logger.js';
import * as sessionStore from '../services/session-store.js';
import { listActiveSessions, findActiveBySessionId, closeSession } from './worker-pool.js';
import { replyMessage } from '../im/lark/client.js';
import { locateLimiter } from './dashboard-locate.js';
import type { DaemonSession } from './types.js';
import type { Session } from '../types.js';
import type { CliId } from '../adapters/cli/types.js';

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

export interface SessionRow {
  sessionId: string;
  larkAppId: string;
  botName: string;
  cliId: CliId | 'unknown';
  status: 'starting' | 'working' | 'idle' | 'analyzing' | 'closed';
  adopt: boolean;
  spawnedAt: number;
  lastMessageAt: number;
  closedAt?: number;
  workingDir?: string;
  chatId: string;
  rootMessageId: string;
  threadId?: string;
  title?: string;
  ownerOpenId?: string;
  webPort: number | null;
  cliVersion?: string;
  hasHistory?: boolean;
  feishuChatLink: string;
}

function feishuChatLink(chatId: string): string {
  return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}

let cachedBotName = '';
export function setBotName(name: string): void { cachedBotName = name; }

export function composeRowFromActive(ds: DaemonSession): SessionRow {
  return {
    sessionId: ds.session.sessionId,
    larkAppId: ds.larkAppId,
    botName: cachedBotName,
    cliId: ds.session.cliId ?? 'unknown',
    status: ds.lastScreenStatus ?? 'starting',
    adopt: !!ds.adoptedFrom,
    spawnedAt: ds.spawnedAt,
    lastMessageAt: ds.lastMessageAt,
    workingDir: ds.workingDir,
    chatId: ds.chatId,
    rootMessageId: ds.session.rootMessageId,
    title: ds.session.title,
    ownerOpenId: ds.ownerOpenId,
    webPort: ds.workerPort ?? null,
    cliVersion: ds.cliVersion,
    hasHistory: ds.hasHistory,
    feishuChatLink: feishuChatLink(ds.chatId),
  };
}

export function composeRowFromClosed(s: Session): SessionRow {
  return {
    sessionId: s.sessionId,
    larkAppId: s.larkAppId ?? '',
    botName: cachedBotName,
    cliId: s.cliId ?? 'unknown',
    status: 'closed',
    adopt: !!s.adoptedFrom,
    spawnedAt: Date.parse(s.createdAt),
    lastMessageAt: s.closedAt ? Date.parse(s.closedAt) : Date.parse(s.createdAt),
    closedAt: s.closedAt ? Date.parse(s.closedAt) : undefined,
    workingDir: s.workingDir,
    chatId: s.chatId,
    rootMessageId: s.rootMessageId,
    title: s.title,
    ownerOpenId: s.ownerOpenId,
    webPort: s.webPort ?? null,
    feishuChatLink: feishuChatLink(s.chatId),
  };
}

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
  // Resolve owning session (active first, then closed-store fallback)
  const ds = findActiveBySessionId(sid);
  const closed = ds ? null : sessionStore.getSession(sid);
  const ctx = ds
    ? {
        larkAppId: ds.larkAppId,
        rootMessageId: ds.session.rootMessageId,
        title: ds.session.title || `Dashboard 定位 (${sid.slice(0, 8)})`,
      }
    : closed
      ? {
          larkAppId: closed.larkAppId ?? '',
          rootMessageId: closed.rootMessageId,
          title: closed.title || `Dashboard 定位 (${sid.slice(0, 8)})`,
        }
      : null;
  if (!ctx || !ctx.larkAppId) {
    return jsonRes(res, 404, { ok: false, error: 'session_not_found' });
  }
  try {
    const messageId = await replyMessage(
      ctx.larkAppId,
      ctx.rootMessageId,
      `📍 Dashboard 定位 ${ctx.title}`,
      'text',
      true,
    );
    jsonRes(res, 200, { ok: true, messageId });
  } catch (err) {
    jsonRes(res, 502, { ok: false, error: String(err) });
  }
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
