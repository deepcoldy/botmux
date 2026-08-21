/**
 * P1-11：控制类端点的跨站伪造防线（CSRF / Origin / Fetch-Metadata）。
 *
 * 为什么 `SameSite=Lax` 不够：
 *  - Lax 只拦「跨 **站**」，同站的兄弟子域（`a.example.com` → `b.example.com`）
 *    与 **同域不同端口** 的 `http://127.0.0.1:<别的端口>` 都算 same-site，
 *    cookie 照送。中心化平台把每台机器放在 `m-<id>.<host>` 子域下，本地开发机
 *    上又常年跑着别的 localhost 服务——这两条正是最现实的攻击面。
 *  - `POST /api/sessions/<id>/control/takeover` 与 preview-interaction 的
 *    unlock/activity/lock 都是 **无 body** 的，一个 `<form method=post>` 就能
 *    从任意页面触发（form 提交不受 CORS 限制，也读不到响应——但副作用已经发生：
 *    抢走终端写租约、把预览从蒙层模式解锁成可交互）。
 *
 * 因此控制类请求要同时满足两道：
 *  1. **同源证明**：`Sec-Fetch-Site: same-origin`，或 `Origin` 与本请求 Host
 *     同源（两边归一化成 hostname + 有效端口后相等）。两个信号都没有 → fail
 *     closed（浏览器发起的写请求必然带其中之一；跨站 form 会带一个对不上的
 *     `Origin`，沙箱/不透明来源会带 `null`）。
 *  2. **一次性 CSRF 票据**：页面加载时现签、绑定当前认证会话、随认证结束一起
 *     作废，提交时放在 `X-Botmux-Csrf` 头里。`<form>` 无法设置自定义头，所以
 *     即使第 1 道被某个浏览器的 Fetch-Metadata 实现绕过，无 body 的表单攻击也
 *     依然打不进来。
 *
 * WebSocket 升级（terminal `/s/*`、debug-terminal）走 {@link managementUpgradeOrigin}：
 * upgrade 不经 HTTP 门禁，浏览器对 WS 握手 **一定** 带 `Origin`，所以「带了但对
 * 不上（含 `null`）」一律拒；完全不带 Origin 的是非浏览器客户端（本身就拿不到
 * 浏览器 cookie，不构成 CSRF），放行以免打断本机 CLI / 探针。
 * 注意 Preview 自身的 WS 是不透明来源（`Origin: null`），它走 preview 专用路径
 * 的路径内凭据校验，**不能**用本函数误杀——调用方必须在 preview 分支之后再调。
 */
import { createHash, randomBytes } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { platformBrowserAuthorities, type PlatformBrowserSurface } from '../platform/binding.js';

/** 提交控制类请求时携带 CSRF 票据的头名。`<form>` 设不了自定义头，这是关键。 */
export const CONTROL_CSRF_HEADER = 'x-botmux-csrf';
/** 页面注入票据用的 meta 名（SPA 与 preview guard 壳都读它）。 */
export const CONTROL_CSRF_META_NAME = 'botmux-csrf';

/** 闲置寿命：每次成功校验都续期（滑动窗口）。工作台常年挂在手机上不刷新，固定
 *  寿命会让一个用了几天的页面突然操作失败；而真正的安全事件是登出/rotate/解绑，
 *  那条路径是立即作废，不靠 TTL。TTL 只负责回收没人再用的票据。 */
const DEFAULT_CSRF_IDLE_TTL_MS = 7 * 24 * 60 * 60_000;
/** 票据是每次页面加载现签的，给一个封顶避免刷新页面刷爆内存（FIFO 淘汰）。 */
const DEFAULT_MAX_CSRF_TOKENS = 4096;

export type ControlRequestOriginState = 'same-origin' | 'foreign' | 'unknown';

export interface ControlRequestHeadersLike {
  origin?: string | string[];
  host?: string | string[];
  'sec-fetch-site'?: string | string[];
  [key: string]: string | string[] | undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** 归一化后的 authority：hostname + 端口。端口为空串表示「没有显式端口」。 */
interface NormalizedAuthority {
  hostname: string;
  port: string;
}

/**
 * 候选 authority（`Host` / `X-Forwarded-Host` / `BOTMUX_PUBLIC_URL`）拆成
 * hostname + port。借 `http://` 解析，IPv6 字面量、大小写、尾随点都交给 URL
 * 规范处理，与 Origin 侧用的是同一套归一化。
 *
 * 副作用：显式的 `:80` 会被 URL 当成 http 默认端口抹掉，退化成「无端口」。无端
 * 口只与跑在协议默认端口上的 Origin 相等（见 {@link authorityMatchesOrigin}），
 * 所以「同域别的端口」这条要防的路依旧堵着。
 */
function normalizeAuthority(value: string): NormalizedAuthority | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > 256) return undefined;
  let url: URL;
  try { url = new URL(`http://${trimmed}`); } catch { return undefined; }
  // 只接受纯 authority：带路径/凭据/查询的 Host 头是畸形输入，不是候选。
  if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return undefined;
  }
  return { hostname: url.hostname, port: url.port };
}

/** Origin 侧：隐含的默认端口显式化（https→443 / http→80），这样两边比的是同一
 *  种形式——`https://dash.example` 与 `Host: dash.example:443` 是同一个门。 */
function normalizeOrigin(origin: string | undefined): (NormalizedAuthority & { explicitPort: boolean }) | undefined {
  if (!origin || origin === 'null') return undefined;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return undefined; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return {
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
    explicitPort: parsed.port !== '',
  };
}

function authorityMatchesOrigin(
  candidate: NormalizedAuthority,
  origin: NormalizedAuthority & { explicitPort: boolean },
): boolean {
  if (candidate.hostname !== origin.hostname) return false;
  // 候选不带端口（`proxy_set_header Host $host;`、平台隧道）：本进程无从得知反
  // 代前面是 80 还是 443，只能认「Origin 也跑在协议默认端口上」。通配放行会把
  // 「同域其它端口」这条攻击面重新打开。对外走非默认端口的部署，靠运维显式声明
  // 的 `BOTMUX_PUBLIC_URL` 候选覆盖。
  if (!candidate.port) return !origin.explicitPort;
  return candidate.port === origin.port;
}

/**
 * `Origin` 是否与本请求自己的 authority 同源。两边都归一化成 hostname + 有效端
 * 口后比较，不比 scheme：中心化平台在 TLS 终止后把明文转给本进程，浏览器发的是
 * `https://…` 而本地看到的是明文连接，比 scheme 会把正常访问全判成跨站。
 * hostname + 端口相等已经足以区分兄弟子域与其它端口——那正是本条要防的。
 *
 * 端口必须两边对称归一化：`new URL('https://dash.example').host` 会被 URL 规范
 * 剥成 `dash.example`，而 `Host` 头是原始字符串，反代常写成 `dash.example:443`。
 * 早先直接比字符串，于是 `proxy_set_header Host $host:$server_port;` 这类广为流
 * 传的配置会把自己人的控制请求全判成跨站。
 *
 * `host` 可以给多个候选：反代/平台隧道下 `Host` 可能已被改写成回环地址，浏览器
 * 真正看到的域名在 `X-Forwarded-Host` 里。这不削弱防线——浏览器不允许页面设置
 * `Origin`，而 `X-Forwarded-Host` 是自定义头，跨站 `<form>` 设不了、跨站 fetch
 * 会先触发预检（本服务不答 CORS，预检直接失败），所以攻击页两个头都伪造不了。
 */
export function originMatchesHost(
  origin: string | undefined,
  host: string | undefined | ReadonlyArray<string | undefined>,
): boolean {
  const parsed = normalizeOrigin(origin);
  if (!parsed) return false;
  const candidates = Array.isArray(host) ? host : [host as string | undefined];
  return candidates.some(candidate => {
    if (typeof candidate !== 'string') return false;
    const normalized = normalizeAuthority(candidate);
    return normalized ? authorityMatchesOrigin(normalized, parsed) : false;
  });
}

let publicAuthorityCache: { raw: string; authority: string | undefined } | undefined;

/**
 * 运维显式声明的对外基址（`BOTMUX_PUBLIC_URL`）也算一个候选 authority。
 * 自建反代下 `Host` 与 `X-Forwarded-Host` 可能双双不可信——被改写成上游回环地
 * 址，或被 `$host` 剥掉了非默认端口——这条是唯一由本机配置而来、跨站页面无从
 * 影响的「浏览器实际访问的 authority」，纳入候选不削弱防线。
 */
function publicUrlAuthority(): string | undefined {
  const raw = process.env.BOTMUX_PUBLIC_URL?.trim() ?? '';
  if (publicAuthorityCache?.raw === raw) return publicAuthorityCache.authority;
  let authority: string | undefined;
  if (raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'http:' || url.protocol === 'https:') authority = url.host || undefined;
    } catch { authority = undefined; }
  }
  publicAuthorityCache = { raw, authority };
  return authority;
}

/** 本请求可能的自身 authority：直连是 `Host`，反代/平台隧道下还有转发头，外加
 *  运维显式声明的对外基址；绑定中心平台时再加本机可信的平台浏览器子域
 *  (`m-`/`t-<machineId>.<平台域名>`)——平台隧道反代不透传 `X-Forwarded-Host`，
 *  这是唯一能让平台浏览器终端的同源校验认出「浏览器实际访问的子域」的候选来源
 *  （见 {@link platformBrowserAuthorities}，每请求重读 platform.json、fail-closed）。
 *
 *  `surface` 决定平台子域给到哪一档：终端 WS 升级要认 `t-`（分享出去的终端页就挂
 *  在那儿），管理类 POST 只认 `m-`（SPA 与 CSRF 票据只存在于那张壳页）。 */
function requestAuthorities(
  headers: ControlRequestHeadersLike,
  surface: PlatformBrowserSurface,
): Array<string | undefined> {
  const forwarded = headerValue(headers['x-forwarded-host']);
  return [
    headerValue(headers.host),
    // 逗号分隔时第一个才是最初的客户端所见 host。
    forwarded ? forwarded.split(',')[0] : undefined,
    publicUrlAuthority(),
    ...platformBrowserAuthorities(surface),
  ];
}

/** 日志安全：Origin/Host 都是请求方可控字符串，掐长度并去掉控制字符再落盘。 */
function logSafeValue(value: string): string {
  let out = '';
  for (const ch of value.slice(0, 128)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

/**
 * 判成跨站时留一行线索。这条 403 是硬失败：前端无降级、doctor 也报不出原因，
 * 服务端再零日志，运维只能看到「终端连不上、一点接管就 403」。把 Origin 与全部
 * 候选 authority 打出来，反代配错（Host 被改写 / 端口被剥掉）一眼可辨。
 */
function warnForeignOrigin(
  kind: string,
  origin: string,
  headers: ControlRequestHeadersLike,
  surface: PlatformBrowserSurface,
): void {
  const authorities = requestAuthorities(headers, surface)
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map(logSafeValue);
  logger.warn(`[dashboard-csrf] ${kind} 判为跨站并拒绝：origin=${logSafeValue(origin)}`
    + ` 候选 authority=[${authorities.join(', ')}]`
    + '（反代请原样透传 host:port，或用 BOTMUX_PUBLIC_URL 声明对外基址）');
}

/**
 * 综合 `Sec-Fetch-Site` 与 `Origin` 判定来源。任一信号明确说「不是同源」就是
 * `foreign`；两个信号都缺席是 `unknown`（非浏览器客户端），由调用方决定 fail
 * closed 还是放行。
 */
export function controlRequestOriginState(headers: ControlRequestHeadersLike): ControlRequestOriginState {
  const site = headerValue(headers['sec-fetch-site']);
  const origin = headerValue(headers.origin);
  if (origin !== undefined && !originMatchesHost(origin, requestAuthorities(headers, 'management'))) {
    warnForeignOrigin('控制类请求', origin, headers, 'management');
    return 'foreign';
  }
  if (site !== undefined && site !== 'same-origin') return 'foreign';
  if (origin === undefined && site === undefined) return 'unknown';
  return 'same-origin';
}

/**
 * `Referer` 兜底的同源判定：请求既没带 `Origin` 也没带 `Sec-Fetch-Site` 时，用
 * Referer 的 origin 与本请求的候选 authority 比一次（复用上面那套归一化，不另写
 * 一份比较逻辑）。
 *
 * 为什么需要它：同源 **GET** 在浏览器里通常两个信号都没有——`Origin` 只在跨源和
 * 非 GET 请求上发，`Sec-Fetch-*` 是较新的浏览器才有（Safari 16.4 之前没有）。对
 * 「有副作用的 POST」两信号缺席一律 fail closed 是对的（那条路径没有需要放行的非
 * 浏览器调用方），但一条**发放凭证的 GET** 若照搬那条规则，会把老浏览器上的真
 * owner 一起挡在门外。Referer 在默认的 `strict-origin-when-cross-origin` 策略下
 * 对同源请求带完整 URL，正好补上这一格。
 *
 * 这不放宽防线：Referer 同样是浏览器写、页面改不了的头，而**明确判为跨站**
 * （`controlRequestOriginState` 已经返回 `foreign`）的请求绝不会走到这里——调用方
 * 只在 `unknown` 时才用它兜底。
 */
export function refererMatchesHost(headers: ControlRequestHeadersLike): boolean {
  const referer = headerValue(headers.referer);
  if (!referer) return false;
  let origin: string;
  try {
    const parsed = new URL(referer);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    origin = parsed.origin;
  } catch {
    return false;
  }
  return originMatchesHost(origin, requestAuthorities(headers, 'management'));
}

/**
 * 管理类 WebSocket 升级的 Origin 判定（terminal / debug-terminal）。
 * 带 Origin 就必须同源（`null` 也算带了，直接拒）；不带 Origin 视为非浏览器客
 * 户端放行。Preview 自身的 WS 不走这里，见文件头注释。
 */
export function managementUpgradeOrigin(headers: ControlRequestHeadersLike):
  { ok: true } | { ok: false; error: 'upgrade_origin_forbidden' } {
  const origin = headerValue(headers.origin);
  if (origin === undefined) return { ok: true };
  // 终端页挂在平台的 `t-` 子域下，它的 WS 握手 Origin 就是 `t-`：这一档必须认，
  // 否则平台浏览器终端整片 disconnected（#933/#960）。管理类 POST 不走这里，也就
  // 不会跟着一起把 `t-` 认成可发起写操作的同源。
  if (originMatchesHost(origin, requestAuthorities(headers, 'terminal-upgrade'))) return { ok: true };
  // WS 握手被拒最难查：浏览器拿不到 403 的状态码与响应体，页面只会显示「连不
  // 上」，workbench-doctor 的探测同样说不出原因。日志是唯一的线索。
  warnForeignOrigin('WebSocket 升级', origin, headers, 'terminal-upgrade');
  return { ok: false, error: 'upgrade_origin_forbidden' };
}

function csrfTokenHash(token: string): string {
  return createHash('sha256').update('botmux-dashboard-control-csrf-v1\0').update(token).digest('base64url');
}

export interface ControlCsrfTokensOptions {
  /** 闲置寿命（每次成功校验续期）。 */
  ttlMs?: number;
  maxTokens?: number;
  now?: () => number;
  randomToken?: () => string;
}

/**
 * 一次性签发、绑定认证会话的 CSRF 票据表。
 *
 * - **一次性签发**：每次页面加载现签一枚随机票据，不是从长期密钥推导的稳定值，
 *   页面刷新即换新票，旧票随 TTL / 认证结束消失。
 * - **绑定认证会话**：校验时必须与当前请求解析出的 authSessionId 一致，所以一
 *   枚票据换不到别人的身份，登出后也立刻作废（`revokeAuthSession`）。
 * - 只存 SHA-256 摘要，明文票据只在注入页面和请求头里存在。
 *
 * 不做「用一次即焚」：工作台一次交互会连打多条控制请求（unlock 之后每 20s 一条
 * activity），单次即焚会退化成每个操作都要先取票，多一次往返还会在弱网下把解锁
 * 变成必然失败。这里的安全性来自「跨站拿不到票 + 同源证明」，不来自使用次数。
 */
export class ControlCsrfTokens {
  private readonly byHash = new Map<string, { authSessionId: string; expiresAt: number }>();
  private readonly hashesByAuthSession = new Map<string, Set<string>>();
  private readonly ttlMs: number;
  private readonly maxTokens: number;
  private readonly now: () => number;
  private readonly randomToken: () => string;

  constructor(opts: ControlCsrfTokensOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_CSRF_IDLE_TTL_MS;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_CSRF_TOKENS;
    this.now = opts.now ?? Date.now;
    this.randomToken = opts.randomToken ?? (() => randomBytes(24).toString('base64url'));
  }

  mint(authSessionId: string): string {
    if (!authSessionId) throw new Error('csrf token requires an auth session');
    const token = this.randomToken();
    const hash = csrfTokenHash(token);
    this.sweep();
    // Map 保序，超额时从最老的一枚开始淘汰。
    while (this.byHash.size >= this.maxTokens) {
      const oldest = this.byHash.keys().next();
      if (oldest.done) break;
      this.forget(oldest.value);
    }
    this.byHash.set(hash, { authSessionId, expiresAt: this.now() + this.ttlMs });
    let hashes = this.hashesByAuthSession.get(authSessionId);
    if (!hashes) {
      hashes = new Set();
      this.hashesByAuthSession.set(authSessionId, hashes);
    }
    hashes.add(hash);
    return token;
  }

  verify(token: string | undefined, authSessionId: string): boolean {
    if (!token || token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token)) return false;
    const hash = csrfTokenHash(token);
    const stored = this.byHash.get(hash);
    if (!stored) return false;
    if (this.now() >= stored.expiresAt) {
      this.forget(hash);
      return false;
    }
    if (stored.authSessionId !== authSessionId) return false;
    // 滑动续期：还在用的页面不会因为开得久而突然操作失败。
    stored.expiresAt = this.now() + this.ttlMs;
    return true;
  }

  /** 认证结束（logout / 到期 / rotate / 解绑）时作废该会话的全部票据。 */
  revokeAuthSession(authSessionId: string): number {
    const hashes = this.hashesByAuthSession.get(authSessionId);
    if (!hashes) return 0;
    let removed = 0;
    for (const hash of [...hashes]) {
      if (this.byHash.delete(hash)) removed++;
    }
    this.hashesByAuthSession.delete(authSessionId);
    return removed;
  }

  size(): number {
    return this.byHash.size;
  }

  private forget(hash: string): void {
    const stored = this.byHash.get(hash);
    this.byHash.delete(hash);
    if (!stored) return;
    const hashes = this.hashesByAuthSession.get(stored.authSessionId);
    if (!hashes) return;
    hashes.delete(hash);
    if (hashes.size === 0) this.hashesByAuthSession.delete(stored.authSessionId);
  }

  private sweep(): void {
    const now = this.now();
    for (const [hash, stored] of this.byHash) {
      if (now >= stored.expiresAt) this.forget(hash);
    }
  }
}

/**
 * 把本次页面加载现签的票据注入 HTML 壳（SPA index.html / preview guard 壳）。
 * 票据只进 `<meta>`：跨站页面读不到本源 DOM，`<form>` 也设不了自定义头，所以
 * 「无 body 表单触发接管/解锁」这条路就此断掉。注入后的壳必须 `no-store`，
 * 否则浏览器会把已作废的票据缓存下来复用。
 */
export function injectControlCsrfMeta(html: string, token: string): string {
  const safe = token.replace(/[^A-Za-z0-9_-]/g, '');
  if (!safe) return html;
  const tag = `<meta name="${CONTROL_CSRF_META_NAME}" content="${safe}">`;
  return html.includes('</head>') ? html.replace('</head>', `  ${tag}\n</head>`) : `${tag}\n${html}`;
}

export type ControlRequestGuardResult =
  | { ok: true }
  | { ok: false; status: 403; error: 'control_origin_forbidden' | 'control_csrf_invalid' };

/**
 * 控制类请求（takeover/release、preview-interaction unlock/activity/lock、
 * locate 等有副作用且可被无 body 表单触发的 POST）的统一门禁。
 * 调用点必须已经解析出身份——匿名请求在路由层就该 401，这里只管跨站伪造。
 */
export function guardControlRequest(input: {
  headers: ControlRequestHeadersLike;
  authSessionId: string;
  tokens: ControlCsrfTokens;
}): ControlRequestGuardResult {
  // 两个来源信号都缺席时 fail closed：浏览器对带副作用的 POST 必然带 Origin，
  // 缺席只可能是刻意剥掉的请求，而这条路径上没有需要放行的非浏览器调用方。
  if (controlRequestOriginState(input.headers) !== 'same-origin') {
    return { ok: false, status: 403, error: 'control_origin_forbidden' };
  }
  const token = headerValue(input.headers[CONTROL_CSRF_HEADER]);
  if (!input.tokens.verify(token, input.authSessionId)) {
    return { ok: false, status: 403, error: 'control_csrf_invalid' };
  }
  return { ok: true };
}
