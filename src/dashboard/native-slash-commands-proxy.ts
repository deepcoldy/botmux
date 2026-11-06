/**
 * Dashboard → 各 Bot daemon 的「飞书原生命令面板」代理。
 *
 * GET  /api/bots/:appId/slash-commands                       — 只读快照，不进 CSRF 门禁
 * POST /api/bots/:appId/slash-commands/{sync,sync-one,delete} — 改飞书应用配置的写操作
 *
 * 写操作会改应用级 Slash 命令（对所有用户可见），而且 `sync` 是**无 body** 也能触发
 * 的 POST：同站兄弟子域或本机其它端口的页面靠 SameSite=Lax 的管理 cookie 用一个
 * `<form method=post>` 就能打进来。所以写操作与终端接管、Oncall 凭据一样走 P1-11
 * 控制类门禁（同源证明 + 绑定认证会话的一次性 CSRF 票据），且只给有主机管理能力
 * 的身份；GET 不设门禁（无副作用）。
 *
 * 凭据始终在对应 Bot 的 daemon 里：本进程只转发，不打开 bots.json。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { guardControlRequest, type ControlCsrfTokens } from './control-csrf.js';
import type { DashboardRequestIdentity } from './request-identity.js';
import { jsonRes } from './http.js';

export const NATIVE_SLASH_PROXY_BODY_LIMIT = 16 * 1024;

const READ_ROUTE = /^\/api\/bots\/([^/]+)\/slash-commands$/;
const WRITE_ROUTE = /^\/api\/bots\/([^/]+)\/slash-commands\/(sync|sync-one|delete)$/;

export interface NativeSlashCommandsProxyDeps {
  identity: Pick<DashboardRequestIdentity, 'canManageHost' | 'authSessionId'> | null;
  csrfTokens: ControlCsrfTokens;
  proxy: (larkAppId: string, daemonPath: string, init: RequestInit) => Promise<Response>;
}

async function relay(res: ServerResponse, upstream: Response): Promise<true> {
  res.writeHead(upstream.status, { 'content-type': 'application/json' });
  res.end(await upstream.text());
  return true;
}

function decodeAppId(raw: string): string | null {
  try { return decodeURIComponent(raw); } catch { return null; }
}

/** 返回 true = 已处理（含拒绝）；false = 不是本模块的路由。 */
export async function handleNativeSlashCommandsProxy(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: NativeSlashCommandsProxyDeps,
): Promise<boolean> {
  const method = (req.method ?? 'GET').toUpperCase();
  let match: RegExpMatchArray | null;
  if (method === 'GET' && (match = url.pathname.match(READ_ROUTE))) {
    const appId = decodeAppId(match[1]!);
    if (appId === null) { jsonRes(res, 400, { ok: false, error: 'invalid_app_id' }); return true; }
    return relay(res, await deps.proxy(appId, '/api/bot-slash-commands', { method: 'GET' }));
  }
  if (method !== 'POST' || !(match = url.pathname.match(WRITE_ROUTE))) return false;

  if (!deps.identity?.canManageHost) {
    jsonRes(res, 403, { ok: false, error: 'host_management_required' });
    return true;
  }
  const guard = guardControlRequest({
    headers: req.headers,
    authSessionId: deps.identity.authSessionId,
    tokens: deps.csrfTokens,
  });
  if (!guard.ok) { jsonRes(res, guard.status, { ok: false, error: guard.error }); return true; }

  const appId = decodeAppId(match[1]!);
  if (appId === null) { jsonRes(res, 400, { ok: false, error: 'invalid_app_id' }); return true; }
  const action = match[2]!;
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    received += (chunk as Buffer).length;
    if (received > NATIVE_SLASH_PROXY_BODY_LIMIT) {
      jsonRes(res, 413, { ok: false, error: 'body_too_large' });
      return true;
    }
    chunks.push(chunk as Buffer);
  }
  return relay(res, await deps.proxy(appId, `/api/bot-slash-commands/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.concat(chunks).toString('utf8') || '{}',
  }));
}
