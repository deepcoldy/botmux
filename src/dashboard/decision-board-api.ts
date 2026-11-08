/**
 * Dashboard ↔ 管家 daemon 的决策看板接口。浏览器只和 Dashboard 说话，Dashboard 补上
 * 草稿归属与提交人后转给管家 bot 的 daemon（看板唯一写入方）。
 *
 * 谁能用：本机管理身份（本机 token / 平台协管者），以及飞书 H5 免登名单里的人（H5 只额外
 * 放开 /api/decision-board/* 这组接口，见 auth.ts 的 board.view / board.decide）。
 *
 * 草稿归属固定为 'owner'：一张看板一份草稿，owner 在飞书侧栏和电脑上看到的是同一份。
 * 实际点提交的人（'local' 或 'u:<union_id>'）单独记进批次。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DashboardRequestIdentity } from './request-identity.js';
import type { StewardConfig } from '../core/decision-board/model.js';
import { immersiveWorkbenchHash } from '../core/workbench-shell.js';
import { BOARD_HTML_CSP, boardFileKind, isSingleByteRange } from '../core/decision-board/files.js';

export const DECISION_BOARD_IMAGE_BODY_MAX_BYTES = 16 * 1024 * 1024;
const JSON_BODY_MAX_BYTES = 1024 * 1024;
const DRAFT_AUTHOR = 'owner';

export interface DecisionBoardApiDeps {
  identity: DashboardRequestIdentity | null;
  canManageHost: boolean;
  proxyToDaemon(larkAppId: string, daemonPath: string, init: RequestInit): Promise<Response>;
  /** bots.json 里的 bot（含 steward 配置）与在线 daemon 的展示名。 */
  bots(): Array<{ larkAppId: string; botName: string; steward?: StewardConfig; online: boolean }>;
  readJsonBody(req: IncomingMessage, maxBytes?: number): Promise<unknown>;
}

const PREFIX = '/api/decision-board';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** 看板接口的访问者：管理身份或 H5 免登身份（H5 身份只有非 result-only 才会被解析出来）。 */
export function decisionBoardAccess(identity: DashboardRequestIdentity | null, canManageHost: boolean): boolean {
  return canManageHost || identity?.kind === 'feishu-h5';
}

/**
 * 事项链接 `/board/<app>/<seq>` 的跳转目标（不是这种路径返回 null）。只做跳转、不返回数据：
 *   - 已登录 → 无边框壳里的 `#/board/<app>/<seq>`（飞书侧栏只有 350–800px，不放 Dashboard 顶栏 / 侧栏）；
 *   - 未登录且配了 H5 免登 → 先走飞书免登，回跳同一路径；
 *   - 其余 → 同样进 SPA，由它的登录层接手（平台托管时平台反代已先做完 SSO）。
 * 用路径不用 `#`：平台冷访问 SSO 只把 pathname+search 带进 next。
 */
export function decisionBoardEntryRedirect(
  pathname: string,
  opts: { signedIn: boolean; h5: { enabled: boolean; entryPath: string } },
): string | null {
  if (!/^\/board\/[A-Za-z0-9_-]{1,64}\/\d{1,9}$/.test(pathname)) return null;
  if (!opts.signedIn && opts.h5.enabled) return `${opts.h5.entryPath}?returnTo=${encodeURIComponent(pathname)}`;
  return `/${immersiveWorkbenchHash(`#${pathname}`)}`;
}

export function decisionBoardSubmitter(identity: DashboardRequestIdentity | null): string {
  const union = identity?.principalUnionId;
  return union && /^[A-Za-z0-9_-]{1,128}$/.test(union) ? `u:${union}` : 'local';
}

async function relay(res: ServerResponse, upstream: Response): Promise<void> {
  const type = upstream.headers.get('content-type') ?? 'application/json';
  if (type.startsWith('image/')) {
    const data = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'content-type': type,
      'content-length': String(data.length),
      'cache-control': upstream.headers.get('cache-control') ?? 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
    return;
  }
  const text = await upstream.text();
  res.writeHead(upstream.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

/** `Content-Range: bytes a-b/size` → 三个数；其它写法返回 null。 */
function contentRange(value: string | null): { start: number; end: number; size: number } | null {
  const m = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/.exec(value ?? '');
  if (!m) return null;
  const [start, end, size] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return start <= end && end < size ? { start, end, size } : null;
}

/** 写入后缓冲满了就等浏览器读走（或断开）。已经断开的不写也不等：那时 drain / close 都不会再来。 */
async function writeDrained(res: ServerResponse, data: Buffer): Promise<void> {
  if (res.destroyed) return;
  if (res.write(data)) return;
  await new Promise<void>(resolve => {
    if (res.destroyed) return resolve();
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.on('drain', done);
    res.on('close', done);
  });
}

/**
 * 浏览器没要 Range（下载、curl，或者多段 / 写错的 Range）时也回整份 200，但从 daemon 按块拿：
 * loopbackFetch 收响应不做背压，整份要会把 50MB 全收进 Dashboard 内存。这里一次只拿一块（daemon 每次
 * 最多回 BOARD_VIDEO_RANGE_CHUNK），等浏览器读走再拿下一块，浏览器断开就停。
 */
async function relayWholeVideo(
  res: ServerResponse,
  first: Response,
  headers: Record<string, string>,
  fetchRange: (range: string) => Promise<Response>,
): Promise<void> {
  const head = contentRange(first.headers.get('content-range'));
  if (first.status !== 206 || !head || head.start !== 0) {
    await first.body?.cancel().catch(() => undefined);
    json(res, 502, { ok: false, error: 'bad_upstream_range' });
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': String(head.size) });
  let closed = false;
  res.once('close', () => { closed = true; });
  try {
    let upstream: Response | null = first;
    let pos = 0;
    while (pos < head.size && !closed) {
      upstream ??= await fetchRange(`bytes=${pos}-`);
      const span = contentRange(upstream.headers.get('content-range'));
      const data = Buffer.from(await upstream.arrayBuffer());
      upstream = null;
      if (closed) return;
      if (!span || span.start !== pos || span.size !== head.size || data.length !== span.end - span.start + 1) {
        res.destroy();
        return;
      }
      pos += data.length;
      await writeDrained(res, data);
    }
    if (!closed) res.end();
  } catch {
    res.destroy();
  }
}

/**
 * 附件下载。截图和报错照旧走 relay；图文说明：
 *   - HTML：响应头由这里自己写（不信上游），始终带 CSP sandbox——说明页与控制台同域名，就靠它不跑脚本、
 *     拿不到控制台的源；
 *   - 视频：浏览器要了 Range 就透传 206 / 416 和 Content-Range（daemon 每段最多回一块）；没要就由
 *     relayWholeVideo 按块拼成 200。
 * `fetchWhole` 只在浏览器没要 Range、转给 daemon 的是 `bytes=0-` 时传。
 */
async function relayFile(res: ServerResponse, upstream: Response, fetchWhole?: (range: string) => Promise<Response>): Promise<void> {
  const type = (upstream.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const kind = boardFileKind(type);
  if (upstream.status === 416) {
    await upstream.arrayBuffer().catch(() => undefined);
    res.writeHead(416, { 'content-range': upstream.headers.get('content-range') ?? '', 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
    res.end();
    return;
  }
  if (!upstream.ok || (kind !== 'html' && kind !== 'video')) return relay(res, upstream);
  const cache = upstream.headers.get('cache-control') ?? 'private, max-age=3600';
  if (kind === 'html') {
    const data = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(data.length),
      'content-security-policy': BOARD_HTML_CSP,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'cache-control': cache,
    });
    res.end(data);
    return;
  }
  const headers: Record<string, string> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    'cache-control': cache,
  };
  if (fetchWhole) return relayWholeVideo(res, upstream, headers, fetchWhole);
  const length = upstream.headers.get('content-length');
  if (length) headers['content-length'] = length;
  const range = upstream.headers.get('content-range');
  if (upstream.status === 206 && range) headers['content-range'] = range;
  res.writeHead(upstream.status === 206 ? 206 : 200, headers);
  if (!upstream.body) { res.end(); return; }
  // 浏览器拖进度条会中途断开上一个请求：pipeline 以 premature close 结束，不算错。
  await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), res).catch(() => { res.destroy(); });
}

function isJsonRequest(req: IncomingMessage): boolean {
  return String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json');
}

export async function handleDecisionBoardApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: DecisionBoardApiDeps,
): Promise<boolean> {
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
  if (!decisionBoardAccess(deps.identity, deps.canManageHost)) {
    json(res, 401, { ok: false, error: 'unauthorized' });
    return true;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const tail = url.pathname.slice(PREFIX.length);

  if (method === 'GET' && tail === '/boards') {
    const bots = deps.bots().filter(b => b.steward?.enabled === true);
    const boards = await Promise.all(bots.map(async b => {
      let counts: unknown;
      if (b.online) {
        try {
          const r = await deps.proxyToDaemon(b.larkAppId, `${PREFIX}/meta`, { method: 'GET' });
          const body = await r.json().catch(() => undefined) as { ok?: boolean; counts?: unknown } | undefined;
          if (r.ok && body?.ok) counts = body.counts;
        } catch { /* 离线或慢：只是不显示计数 */ }
      }
      return {
        larkAppId: b.larkAppId,
        botName: b.botName,
        online: b.online,
        steward: { enabled: true, ready: !!b.steward?.chatId, ...(b.steward?.chatId ? { chatId: b.steward.chatId } : {}) },
        ...(counts ? { counts } : {}),
      };
    }));
    json(res, 200, { ok: true, boards });
    return true;
  }

  const m = /^\/([^/]+)(\/.*)$/.exec(tail);
  if (!m) {
    json(res, 404, { ok: false, error: 'not_found' });
    return true;
  }
  let appId: string;
  try { appId = decodeURIComponent(m[1]); } catch { json(res, 400, { ok: false, error: 'bad_app_id' }); return true; }
  const rest = m[2];
  const bot = deps.bots().find(b => b.larkAppId === appId);
  if (!bot) {
    json(res, 404, { ok: false, error: 'bot_not_found' });
    return true;
  }
  const forward = (path: string, init: RequestInit) => deps.proxyToDaemon(appId, path, init).then(r => relay(res, r));
  const readBody = async (max: number): Promise<Record<string, unknown> | null> => {
    if (!isJsonRequest(req)) return null;
    try {
      const body = await deps.readJsonBody(req, max);
      return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
    } catch { return null; }
  };
  const post = (path: string, body: unknown) => forward(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  if (method === 'GET' && rest === '/items') {
    const qs = new URLSearchParams({ author: DRAFT_AUTHOR });
    const view = url.searchParams.get('view');
    if (view) qs.set('view', view);
    const q = url.searchParams.get('q');
    if (q) qs.set('q', q.slice(0, 200));
    await forward(`${PREFIX}?${qs.toString()}`, { method: 'GET' });
    return true;
  }
  if (method === 'GET' && rest === '/guide') {
    await forward(`${PREFIX}/guide`, { method: 'GET' });
    return true;
  }
  let mm = /^\/items\/(\d{1,9})$/.exec(rest);
  if (method === 'GET' && mm) {
    await forward(`${PREFIX}/items/${mm[1]}?author=${DRAFT_AUTHOR}`, { method: 'GET' });
    return true;
  }
  mm = /^\/items\/(\d{1,9})\/seen$/.exec(rest);
  if (method === 'POST' && mm) {
    await post(`${PREFIX}/items/${mm[1]}/seen`, {});
    return true;
  }
  mm = /^\/items\/(\d{1,9})\/draft$/.exec(rest);
  if (method === 'PUT' && mm) {
    const body = await readBody(JSON_BODY_MAX_BYTES);
    if (!body) { json(res, 400, { ok: false, error: 'bad_json' }); return true; }
    await post(`${PREFIX}/items/${mm[1]}/draft`, {
      author: DRAFT_AUTHOR, choice: body.choice, text: body.text, fileIds: body.fileIds, baseRev: body.baseRev,
    });
    return true;
  }
  if (method === 'POST' && rest === '/files') {
    const body = await readBody(DECISION_BOARD_IMAGE_BODY_MAX_BYTES);
    if (!body) { json(res, 400, { ok: false, error: 'bad_json' }); return true; }
    await post(`${PREFIX}/files`, { author: DRAFT_AUTHOR, image: body.image });
    return true;
  }
  mm = /^\/files\/([A-Za-z0-9]{8,40})$/.exec(rest);
  if (method === 'GET' && mm) {
    // 只透传单段 Range（daemon 按块回 206）；别的都按整份处理，转给 daemon 的是 `bytes=0-`，
    // daemon 对截图 / 说明页不看 Range，照旧回整份 200。
    const path = `${PREFIX}/files/${mm[1]}`;
    const asked = typeof req.headers.range === 'string' ? req.headers.range : '';
    const single = asked.length <= 200 && isSingleByteRange(asked);
    const fetchRange = (range: string) => deps.proxyToDaemon(appId, path, { method: 'GET', headers: { range } });
    const upstream = await fetchRange(single ? asked : 'bytes=0-');
    await relayFile(res, upstream, single ? undefined : fetchRange);
    return true;
  }
  if (method === 'POST' && rest === '/submit') {
    const body = await readBody(JSON_BODY_MAX_BYTES);
    if (!body) { json(res, 400, { ok: false, error: 'bad_json' }); return true; }
    await post(`${PREFIX}/submit`, {
      author: DRAFT_AUTHOR,
      submitter: decisionBoardSubmitter(deps.identity),
      nonce: body.nonce,
      items: body.items,
    });
    return true;
  }
  mm = /^\/batches\/(\d{1,9})\/redeliver$/.exec(rest);
  if (method === 'POST' && mm) {
    await post(`${PREFIX}/batches/${mm[1]}/redeliver`, {});
    return true;
  }
  json(res, 404, { ok: false, error: 'not_found' });
  return true;
}
