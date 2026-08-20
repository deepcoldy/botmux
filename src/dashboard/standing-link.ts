import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  controlAuditRecord,
  type ControlAuditSink,
} from './control-audit.js';
import {
  controlRequestOriginState,
  refererMatchesHost,
  type ControlRequestHeadersLike,
} from './control-csrf.js';

/**
 * owner 工作台内「自取常驻链接」（`GET /api/workbench/standing-link`）。
 *
 * ─── 为什么要有这条端点 ────────────────────────────────────────────────────
 * botmux 自部署用户就是自己这台实例的 owner，但拿一条能收藏进书签的常驻工作台
 * 入口，此前只有一条路：SSH 上服务器跑 `botmux dashboard`。飞书卡片那条按钮给的
 * 是 30 分钟短票（P2-1），到期即死——这是刻意的红线：**长期 token 不得进聊天
 * 记录**（卡片历史、转发、截图都比首次投递活得久）。这条红线原样保留，这里只是
 * 把「自取」搬进 owner 已经登录的工作台页面本身：页面是私人上下文，响应
 * `no-store`，链接既不落盘也不进任何持久化载体。
 *
 * ─── 谁能取 ────────────────────────────────────────────────────────────────
 * 只有**本机完整管理身份**（legacy owner cookie —— `?t=` 种的，或短票兑换出的
 * 那一枚）。两层门禁，彼此独立、谁都不依赖对方：
 *
 *  1. **路由级**：这条路径既不在 `workbenchH5Capability` 的能力表里，也不在
 *     `PUBLIC_READ_PATHS` 里，所以 `decideWorkbenchH5Auth` / `decideDashboardAuth`
 *     对 workbench-only（飞书 H5）、平台 owner/teammate/guest、匿名一律 deny401
 *     —— 请求根本到不了这里。新增路由默认私有，这一层是构造性的。
 *  2. **处理器级**：本文件再自己判一次 `kind === 'legacy-dashboard'`，不满足直接
 *     404。平台身份即使角色叫 owner 也在此止步——它证明的是「机器跳板 + 平台角色」，
 *     不是本机管理权限（与 dashboard.ts 里 `authed = legacyAuthed` 同一口径）。
 *
 * ─── 其余约束 ──────────────────────────────────────────────────────────────
 *  - **同源**：跨站页面拿着 owner 浏览器里的 cookie 打这条 GET 一律 403，判定复用
 *    control-csrf 的归一化（`Sec-Fetch-Site` / `Origin`，两者都缺席时 `Referer`
 *    兜底，全无信号 fail closed）。
 *  - **no-store**：响应体里就是长期凭证，任何中间缓存都不该留。
 *  - **取用必留痕**：每发一次写一条 `auth.standing_link_issued`（含身份，不含
 *    token 与链接）。审计写不进去就不发链接——这是唯一一处「审计失败即拒绝」，
 *    因为这条端点交出去的是常驻凭证，留不下痕就等于凭空多一份无人知晓的副本。
 *  - **token 只有一个出处**：`activeToken()` 每次现读落盘的活跃 token，所以
 *    `botmux dashboard rotate` 之后这里自然返回新 token 拼的链接，无需任何同步。
 */

/** 端点路径。auth.ts 的能力表 / 公开白名单都**不**包含它（fail closed 的默认）。 */
export const WORKBENCH_STANDING_LINK_PATH = '/api/workbench/standing-link';

/** 处理器只关心身份的这两个切面（结构上兼容 dashboard.ts 的
 *  `DashboardRequestIdentity`）。 */
export interface StandingLinkIdentityLike {
  kind: string;
  userId?: string;
}

export interface WorkbenchStandingLinkDeps {
  /** 本请求已解析出的身份（`resolveDashboardIdentity` 的结论），匿名为 null。 */
  identity: StandingLinkIdentityLike | null;
  /** 当前活跃的 legacy 管理 token（单一出处：落盘文件）。 */
  activeToken: () => string | null;
  /** token → 常驻工作台入口 URL（`<base>/workbench?t=<token>`）。base 的解析复用
   *  core/dashboard-url.ts 那一份；不可解析时返回 null，调用方据此 503 而不是拼
   *  出半截链接。 */
  standingLinkUrl: (token: string) => string | null;
  /** 审计落点（dashboard.ts 传的是与 takeover / 登录同一个 sink）。 */
  audit: ControlAuditSink;
  now?: () => Date;
}

/**
 * 这次请求是否来自本源页面。
 *
 * `controlRequestOriginState` 明确判 `foreign` 就是跨站，**不给 Referer 翻案的
 * 机会**；只有两个来源信号都缺席（`unknown`）时才用 Referer 兜底，把老浏览器上
 * 的真 owner 救回来（见 {@link refererMatchesHost} 的注释）。全无信号 = 拒绝。
 */
export function standingLinkSameOrigin(headers: ControlRequestHeadersLike): boolean {
  const state = controlRequestOriginState(headers);
  if (state === 'same-origin') return true;
  if (state === 'foreign') return false;
  return refererMatchesHost(headers);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // 响应体是常驻凭证：不进任何中间缓存，也不把它当 Referer 带去别处。
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}

/**
 * `GET /api/workbench/standing-link` 处理器。命中返回 true（响应已写完），未命中
 * 返回 false 交还路由（非 GET / 别的路径一律不自己兜底）。
 *
 * 成功：`200 { ok: true, url }`；无权：`404 { ok: false, error: 'not_found' }`；
 * 跨站：`403 control_origin_forbidden`；没有活跃 token / 链接拼不出 / 审计落不下：
 * `503 standing_link_unavailable`。失败分支一律不回显 token、不回显链接。
 */
export function handleWorkbenchStandingLink(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: WorkbenchStandingLinkDeps,
): boolean {
  if ((req.method ?? 'GET').toUpperCase() !== 'GET') return false;
  if (url.pathname !== WORKBENCH_STANDING_LINK_PATH) return false;

  // 身份门在同源门之前：无权身份不论从哪个源来，看到的都是同一个 404，端点对它
  // 而言就是不存在。
  const identity = deps.identity;
  if (!identity || identity.kind !== 'legacy-dashboard') {
    json(res, 404, { ok: false, error: 'not_found' });
    return true;
  }

  if (!standingLinkSameOrigin(req.headers)) {
    json(res, 403, { ok: false, error: 'control_origin_forbidden' });
    return true;
  }

  let link: string | null = null;
  try {
    const token = deps.activeToken();
    link = token ? deps.standingLinkUrl(token) : null;
  } catch {
    link = null;
  }
  if (!link) {
    json(res, 503, { ok: false, error: 'standing_link_unavailable' });
    return true;
  }

  try {
    deps.audit.append(controlAuditRecord(
      identity.userId ?? 'legacy-owner',
      'dashboard',
      'auth.standing_link_issued',
      { now: deps.now?.() },
    ));
  } catch {
    // 留不下痕就不发：这条端点交出去的是常驻凭证，宁可让 owner 重试，也不留一份
    // 无人知晓的副本。
    json(res, 503, { ok: false, error: 'standing_link_unavailable' });
    return true;
  }

  json(res, 200, { ok: true, url: link });
  return true;
}
