import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  readSecureHostFileSync,
  withSecureHostParentSync,
} from '../platform/secure-host-file.js';

import { buildSetCookie } from './auth.js';

/**
 * 工作台入口短时票据（P2-1）。
 *
 * 背景：`/dashboard` 飞书卡片的「打开工作台」按钮曾直接把长期 Dashboard 管理
 * token 拼进 URL 写入持久化卡片——管理员门禁只保护首次投递，覆盖不了卡片历史、
 * 转发和截图，等于把常驻凭证抄送给未来所有能看到这张卡的人。改为：卡片构建时
 * 现 mint 一张 **30 分钟 TTL 的不可预测票据**，按钮链接只携带票据；访客打开
 * `GET /workbench-ticket/<ticket>` 时由 dashboard 验票，通过则按既有 `?t=` 流程
 * 同款种 legacy cookie 再 302 进工作台。到期后卡片历史/转发/截图里的链接一律
 * 作废，只回一个无凭据的提示页。
 *
 * 设计要点：
 *  - **非一次性**：同一张卡片会被同一个管理员在 PC / 手机多端点开，票据在 TTL
 *    内可重复兑换，到期即死。不做兑换计数，避免飞书链接预抓取把票据「烧」掉。
 *  - **跨进程**：mint 发生在 daemon 进程（构建卡片处），验票发生在 dashboard
 *    进程，两边靠 `~/.botmux/.workbench-tickets.json` 交接；进程内 Map 只是
 *    本进程的快路径缓存。落盘复用 secure-host-file 的 0600 + 目录 0700 + 泄漏
 *    检查惯例（与 `.dashboard-token` 同一套），读-并-写走跨进程文件锁，杜绝并发
 *    mint / prune 互相丢条目。
 *  - **文件里绝不存明文**：只存 `sha256(ticket)` 的 base64url + 过期时间。拿到
 *    文件读权限的人无法还原票据；但能**写**这个文件就等于能自铸门票，所以文件
 *    的安全形状（属主 / 0600 / 拒符号链接）由 secure-host-file 强制，不满足即
 *    fail closed。
 *  - **重启不废票**：dashboard 重启后 Map 为空，验票落到文件比对 hash，刚发出
 *    的卡片链接照常可用。
 */

/** 票据有效期：30 分钟。够管理员从卡片点进去（含转发到手机再点），又短到卡片
 *  历史里的旧链接很快失效。 */
export const WORKBENCH_TICKET_TTL_MS = 30 * 60_000;

/** 定期清理间隔。mint / 验票时也会顺手清，这只是兜底节拍。 */
const PRUNE_INTERVAL_MS = 5 * 60_000;

/** 落盘条目上限（按过期时间保最新）。正常量级是每次 /dashboard 卡片 mint 一张、
 *  30 分钟自然过期，这里只防异常调用方把文件刷爆。 */
const MAX_PERSISTED_TICKETS = 256;

/** mint 出的票据形状：24 字节随机数的 base64url（32 字符）。验票先过这个格式
 *  门，明显不是我们发的串直接拒绝，不进 hash 比对。 */
const TICKET_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

/** 兑换端点路径：`GET /workbench-ticket/<ticket>`。auth.ts 的公共面豁免与这里
 *  必须保持同一个 pattern（那边按 `/^\/workbench-ticket\/[^/]+$/` 放行）。 */
export const WORKBENCH_TICKET_ROUTE_RE = /^\/workbench-ticket\/([^/]+)$/;

interface PersistedTicket {
  /** sha256(ticket) 的 base64url（43 字符）。 */
  h: string;
  /** 过期时间（epoch ms）。 */
  exp: number;
}

/** 进程内快路径缓存：hash → 过期时间。真相在文件里，这里只加速同进程验票。 */
const liveTickets = new Map<string, number>();

let pruneTimer: NodeJS.Timeout | null = null;

function ticketsFilePath(): string {
  return join(homedir(), '.botmux', '.workbench-tickets.json');
}

/** sha256 → base64url。导出仅为测试断言「文件里只有 hash 没有明文」。 */
export function hashWorkbenchTicket(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('base64url');
}

function parsePersisted(raw: string | null): PersistedTicket[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: PersistedTicket[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const h = (entry as { h?: unknown }).h;
    const exp = (entry as { exp?: unknown }).exp;
    if (typeof h === 'string' && h.length > 0 && typeof exp === 'number' && Number.isFinite(exp)) {
      out.push({ h, exp });
    }
  }
  return out;
}

function ensurePruneTimer(): void {
  if (pruneTimer) return;
  // unref：清理节拍不该拖住进程退出。回调吞错——prune 是保洁，不是正确性关键路径
  // （验票自身按 exp 判断过期，从不依赖 prune 已经跑过）。
  pruneTimer = setInterval(() => {
    try { pruneExpiredWorkbenchTickets(); } catch { /* best effort */ }
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();
}

function pruneLiveMap(nowMs: number): void {
  for (const [h, exp] of liveTickets) {
    if (exp <= nowMs) liveTickets.delete(h);
  }
}

/**
 * Mint 一张新票据并落盘，返回**明文票据**（只出现在返回值和最终 URL 里，不进
 * 日志不进文件）。落盘失败直接抛出——文件是 daemon(mint) 与 dashboard(验票)
 * 之间唯一的交接面，写不进去的票据必然兑换失败，调用方（workbench-link）捕获
 * 后退化为不带票据的登录墙链接，而不是发出一个注定 404 的死链。
 */
export function mintWorkbenchTicket(nowMs = Date.now()): string {
  const ticket = randomBytes(24).toString('base64url');
  const hash = hashWorkbenchTicket(ticket);
  const exp = nowMs + WORKBENCH_TICKET_TTL_MS;
  // 读-并-写整段持跨进程文件锁：并发的另一处 mint / 定期 prune 不会把这条刚写的
  // 票据覆盖掉（与 loadOrCreatePersistedToken 的 get-or-create 同一套串行化）。
  withSecureHostParentSync(ticketsFilePath(), (parent) =>
    parent.withLeafLock(() => {
      const entries = parsePersisted(parent.readLeaf())
        .filter((e) => e.exp > nowMs);
      entries.push({ h: hash, exp });
      entries.sort((a, b) => b.exp - a.exp);
      parent.writeLeaf(JSON.stringify(entries.slice(0, MAX_PERSISTED_TICKETS)));
    }),
  );
  // 文件写成功才进缓存：Map 里绝不出现 dashboard 进程看不见的「幽灵票」。
  pruneLiveMap(nowMs);
  liveTickets.set(hash, exp);
  ensurePruneTimer();
  return ticket;
}

/**
 * 验票：格式门 → 进程内缓存 → 落盘文件（跨进程 / 重启恢复路径）。任何读盘异常
 * （目录形状不安全、文件损坏）一律 fail closed 返回 false，绝不因为存储出问题就
 * 放行。hash 比对用 timingSafeEqual 且**不提前退出**，不给远端留计时侧信道。
 */
export function verifyWorkbenchTicket(ticket: string, nowMs = Date.now()): boolean {
  if (typeof ticket !== 'string' || !TICKET_SHAPE.test(ticket)) return false;
  const hash = hashWorkbenchTicket(ticket);
  pruneLiveMap(nowMs);
  const cached = liveTickets.get(hash);
  if (cached !== undefined && cached > nowMs) {
    ensurePruneTimer();
    return true;
  }
  let entries: PersistedTicket[];
  try {
    entries = parsePersisted(readSecureHostFileSync(ticketsFilePath()));
  } catch {
    return false;
  }
  const hashBuf = Buffer.from(hash, 'utf8');
  let matchedExp: number | undefined;
  for (const entry of entries) {
    const entryBuf = Buffer.from(entry.h, 'utf8');
    if (entryBuf.length !== hashBuf.length) continue;
    if (timingSafeEqual(entryBuf, hashBuf) && entry.exp > nowMs) {
      matchedExp = entry.exp;
      // 不 break：把 hash 命中位置从响应时间里抹掉。条目数有上限，全量扫描便宜。
    }
  }
  if (matchedExp === undefined) return false;
  liveTickets.set(hash, matchedExp);
  ensurePruneTimer();
  return true;
}

/**
 * 定期清理：进程内 Map 直接清；落盘文件只在真有过期条目时才持锁重写（避免每个
 * 节拍都空转写盘）。文件不存在 / 目录形状不安全时静默跳过——prune 是保洁工作，
 * 不能因为存储异常把进程打崩。
 */
export function pruneExpiredWorkbenchTickets(nowMs = Date.now()): void {
  pruneLiveMap(nowMs);
  try {
    const current = parsePersisted(readSecureHostFileSync(ticketsFilePath()));
    if (!current.some((e) => e.exp <= nowMs)) return;
    withSecureHostParentSync(ticketsFilePath(), (parent) =>
      parent.withLeafLock(() => {
        // 锁内重读：以持锁瞬间的真实内容为准，避免覆盖并发 mint 刚追加的条目。
        const entries = parsePersisted(parent.readLeaf()).filter((e) => e.exp > nowMs);
        parent.writeLeaf(JSON.stringify(entries));
      }),
    );
  } catch {
    /* best effort */
  }
}

/** 测试专用：清空进程内缓存与定时器，模拟进程重启（文件保留）。 */
export function resetWorkbenchTicketStoreForTests(): void {
  liveTickets.clear();
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

// ─── 兑换端点 ────────────────────────────────────────────────────────────────

/** 过期 / 无效票据的提示页正文（测试断言用同一常量）。零凭据、零回显：不含
 *  token、不含来访票据本身，只告诉用户下一步怎么拿新入口。 */
export const WORKBENCH_TICKET_EXPIRED_MESSAGE =
  '链接已过期，请在会话里重新发送 /dashboard 获取新入口';

function expiredPageHtml(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>入口已过期</title></head>`
    + `<body style="font-family:system-ui,sans-serif;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0b0e14;color:#e6e6e6">`
    + `<p style="padding:24px;text-align:center;line-height:1.8">${WORKBENCH_TICKET_EXPIRED_MESSAGE}</p>`
    + `</body></html>`;
}

/**
 * `GET /workbench-ticket/<ticket>` 兑换处理器。命中路径返回 true（响应已写完），
 * 未命中返回 false 交还路由。语义对齐既有 `?t=` 流程（auth.ts 的
 * `allow+set-cookie` 分支）：验票通过 → 种同一个 legacy cookie → 302 进工作台。
 *
 *  - 票据有效且有活跃 token：`Set-Cookie: botmux_dashboard_token=<active>` +
 *    302 `/#/agent-workbench`。cookie 值是**当前**活跃 token——token rotate 后
 *    旧卡片的存量票据兑出来的也是新 token，不会复活旧凭证。
 *  - 票据有效但当前没有活跃 token（dashboard 从未发号）：302 进工作台但不种
 *    cookie，用户面对正常登录墙。这是旧「读不到 token 就发裸链接」行为的对位，
 *    绝不在匿名请求侧顺手铸造新 token。
 *  - 票据无效 / 过期：410 + 无凭据中文提示页。
 *
 * 所有响应一律 no-store：兑换 URL 本身携带凭据性质的票据，任何中间缓存都不该
 * 存它的响应。
 */
export function handleWorkbenchTicketRedemption(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: { activeToken: () => string | null },
): boolean {
  if (req.method !== 'GET') return false;
  const match = url.pathname.match(WORKBENCH_TICKET_ROUTE_RE);
  if (!match) return false;
  let ticket = match[1];
  try { ticket = decodeURIComponent(ticket); } catch { /* 保留原样进验票（会被格式门拒掉） */ }
  if (verifyWorkbenchTicket(ticket)) {
    let token: string | null = null;
    try { token = deps.activeToken(); } catch { token = null; }
    res.writeHead(302, {
      location: '/#/agent-workbench',
      'cache-control': 'no-store',
      ...(token ? { 'set-cookie': buildSetCookie(token) } : {}),
    });
    res.end();
    return true;
  }
  res.writeHead(410, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(expiredPageHtml());
  return true;
}
