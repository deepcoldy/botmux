import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  readSecureHostFileSync,
  withSecureHostParentSync,
} from '../platform/secure-host-file.js';

import { buildSetCookie } from './auth.js';
import { DashboardH5ExchangeGate, dashboardH5ClientIp } from './h5-auth.js';

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
 *  - **绑定 token generation（P1-6）**：见下方「票据 ↔ token generation」小节。
 *  - **跨进程**：mint 发生在 daemon 进程（构建卡片处），验票发生在 dashboard
 *    进程，两边靠 `~/.botmux/.workbench-tickets.json` 交接；进程内 Map 只是
 *    本进程的快路径缓存。落盘复用 secure-host-file 的 0600 + 目录 0700 + 泄漏
 *    检查惯例（与 `.dashboard-token` 同一套），读-并-写走跨进程文件锁，杜绝并发
 *    mint / prune 互相丢条目。
 *  - **文件里绝不存明文**：只存 `sha256(ticket)` 的 base64url + 过期时间 +
 *    generation 标签。拿到文件读权限的人无法还原票据；但能**写**这个文件就等于
 *    能自铸门票，所以文件的安全形状（属主 / 0600 / 拒符号链接）由 secure-host-file
 *    强制，不满足即 fail closed。
 *  - **重启不废票**：dashboard 重启后 Map 为空，验票落到文件比对 hash，刚发出
 *    的卡片链接照常可用。
 *
 * ─── 票据 ↔ token generation（P1-6）────────────────────────────────────────
 * 票据兑换出来的是「**当前**活跃 token」的 cookie。只按 TTL 判活时，rotate 之前
 * 泄漏出去的票据能在 rotate 之后继续兑换——而且兑出来的是**新**管理 cookie。若
 * rotate 的原因正是「链接/卡片泄漏了」，rotation 就此失去全部安全语义：管理员轮
 * 换了凭证，攻击者拿旧票据无缝续上新凭证。
 *
 * 所以每张票在 mint 时钉住当时 token 的 generation 标签（`sha256("…" + token)`），
 * 兑换时要求这个标签仍等于**此刻即将下发的那份 token** 的标签。rotate 换掉 token
 * ⇒ 标签变 ⇒ 旧 generation 的票据一律 410。这条判定是构造性的：不依赖 rotate
 * 路径记得去清理存量票据，清理（{@link revokeWorkbenchTicketsOutsideGeneration}）
 * 只是把死条目从文件里扫掉的保洁。
 *
 * 同一 generation 内仍然**不是**一次性票：多端重复兑换的语义（P2-1）原样保留。
 *
 * ─── 公开兑换端点的 DoS 面（P1-10）────────────────────────────────────────
 * 兑换端点在 auth gate 之前放行（票据自身就是凭证），任何人都能打。旧实现里每个
 * 「形状合法但未知」的票据都会同步 realpath/stat/open/read/fstat 一遍凭证文件再
 * 全表扫描——HOME 挂在 NFS 上时，几百个伪造票据就能把 event loop 焊死。现在三层
 * 一起收口，且都保持 fail closed 与 timingSafeEqual 语义：
 *  1. **限流**：每 IP + 全局滑动窗口（复用 H5 兑换口那套 gate 与可信代理取 IP
 *     口径），拒绝在读任何盘之前发生；
 *  2. **快照**：落盘内容在进程内缓存 {@link STORE_SNAPSHOT_TTL_MS}，打盘次数只跟
 *     时间走、不跟请求量走——请求量翻一万倍，打盘次数不变；
 *  3. **负缓存**：验失败的 (票据 hash, generation) 短期记住，重复打同一张票连
 *     全表扫描都省掉。负缓存条目钉住快照版本号，快照内容一变即失效，所以「刚
 *     mint 出来的新票被前一次探测顺手拉黑」最多只存在一个快照周期。
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

/** 落盘内容在进程内的最长复用时长。取 250ms：人从卡片点到兑换至少是几百毫秒到
 *  几十秒级，跨进程「刚 mint 的票立刻可兑」的体感不受影响；而洪水攻击下打盘次数
 *  被钉死在 4 次/秒，与请求速率彻底解耦。 */
const STORE_SNAPSHOT_TTL_MS = 250;

/** 验失败的 (hash, generation) 记住多久。上限之内重复打同一张废票不再全表扫。 */
const NEGATIVE_CACHE_TTL_MS = 60_000;

/** 负缓存条目上限（LRU）。攻击者用无穷多张废票也只能占住这么多条。 */
const MAX_NEGATIVE_CACHE_ENTRIES = 4_096;

/** 兑换端点限流：滑动窗口长度。 */
export const WORKBENCH_TICKET_RATE_WINDOW_MS = 60_000;
/** 单 IP 每窗口兑换次数上限。管理员多端打开 + 客户端链接预抓取远在这之下。 */
export const WORKBENCH_TICKET_MAX_PER_IP_PER_WINDOW = 20;
/** 端点级每窗口上限：换一堆源地址也绕不开这个天花板。 */
export const WORKBENCH_TICKET_MAX_GLOBAL_PER_WINDOW = 120;
/** 限流表跟踪的 IP 上限（超过按 LRU 淘汰，不做全表扫）。 */
const RATE_MAX_TRACKED_IPS = 4_096;

interface PersistedTicket {
  /** sha256(ticket) 的 base64url（43 字符）。 */
  h: string;
  /** 过期时间（epoch ms）。 */
  exp: number;
  /** mint 时活跃 Dashboard token 的 generation 标签（见 {@link workbenchTicketGeneration}）。 */
  g: string;
}

/** 进程内快路径缓存：hash → 过期时间 + generation。真相在文件里，这里只加速同
 *  进程验票。 */
const liveTickets = new Map<string, { exp: number; g: string }>();

/** 负缓存：`hash|generation` → 失效时间 + 记录时的快照版本号。 */
const negativeCache = new Map<string, { until: number; version: number }>();

/** 落盘内容的进程内快照。`null` 表示需要重新读盘。 */
let storeSnapshot: { entries: PersistedTicket[]; loadedAt: number } | null = null;
/** 上次读到的原始文件内容，用来判断内容是否真的变了（变了才推进版本号）。 */
let storeRaw: string | null = null;
/** 快照版本号：内容每变一次 +1，负缓存据此整体失效。 */
let storeVersion = 0;

let pruneTimer: NodeJS.Timeout | null = null;

/** 诊断计数：**任何**凭证文件的同步读次数 / 负缓存命中次数。前者必须随请求量
 *  保持平坦——票据文件和 token 文件都算，免得「快照挡住了票据文件、却每个请求
 *  还去读一次 token 文件」这种半吊子实现看起来是绿的。 */
let diskReads = 0;
let negativeHits = 0;

/**
 * 兑换端点的进程内限流闸。复用 H5 兑换口那只 gate 的 `admit`（每 IP 滑动窗口 +
 * 全局滑动窗口 + LRU 有界跟踪表），这里只是换一套额度：两个端点都是「auth gate
 * 之前放行的公开面」，限流语义完全一样，没有理由再写一份。
 */
function createRedemptionGate(): DashboardH5ExchangeGate {
  return new DashboardH5ExchangeGate({
    windowMs: WORKBENCH_TICKET_RATE_WINDOW_MS,
    maxPerIpPerWindow: WORKBENCH_TICKET_MAX_PER_IP_PER_WINDOW,
    maxGlobalPerWindow: WORKBENCH_TICKET_MAX_GLOBAL_PER_WINDOW,
    maxTrackedIps: RATE_MAX_TRACKED_IPS,
  });
}

let redemptionGate = createRedemptionGate();

function ticketsFilePath(): string {
  return join(homedir(), '.botmux', '.workbench-tickets.json');
}

function dashboardTokenFilePath(): string {
  return join(homedir(), '.botmux', '.dashboard-token');
}

/** sha256 → base64url。导出仅为测试断言「文件里只有 hash 没有明文」。 */
export function hashWorkbenchTicket(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('base64url');
}

/** 尚无活跃 token 时的 generation 标签。此时 mint 出的票据也只能在「仍然没有
 *  token」的状态下兑换（兑不出 cookie，等于把用户送到登录墙），一旦 dashboard
 *  发出了第一份 token，这些票即刻作废——fail closed 方向。 */
export const WORKBENCH_TICKET_NO_TOKEN_GENERATION = 'none';

/**
 * token 的 generation 标签：`sha256("workbench-ticket-generation:" + token)`。
 *
 * 只用于相等比较，不是凭证：它不可逆推 token（token 本身是高熵随机串），而且和
 * 票据 hash 一起躺在同一个 0600 凭证文件里，不扩大任何暴露面。用 hash 而不是
 * 计数器，是为了让 daemon（mint 侧）与 dashboard（验票侧）无需共享任何额外状态
 * ——两边各自从同一份 token 现算即可，天然跨进程、跨重启一致。
 */
export function workbenchTicketGeneration(token: string | null | undefined): string {
  if (!token) return WORKBENCH_TICKET_NO_TOKEN_GENERATION;
  return createHash('sha256')
    .update(`workbench-ticket-generation:${token}`, 'utf8')
    .digest('base64url');
}

/**
 * 从 `~/.botmux/.dashboard-token` 现算当前 generation。返回 `null` 表示**读不出
 * 来**（目录/文件形状不安全等）——调用方一律 fail closed：mint 抛出（卡片退化成
 * 无凭证登录链接），验票返回 false。「文件不存在」不算读不出来，它是合法的
 * 「还没有 token」状态，归一到 {@link WORKBENCH_TICKET_NO_TOKEN_GENERATION}。
 */
export function currentWorkbenchTokenGeneration(): string | null {
  try {
    diskReads += 1;
    return workbenchTicketGeneration(
      readSecureHostFileSync(dashboardTokenFilePath(), 256)?.trim() || null,
    );
  } catch {
    return null;
  }
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
    const g = (entry as { g?: unknown }).g;
    // 没有 generation 的条目（旧版本残留 / 手工伪造）一律丢弃：绑定关系缺失就
    // 等于不可验证，fail closed。票据 TTL 只有 30 分钟，升级期间最多让一张卡
    // 片链接提前失效。
    if (
      typeof h === 'string' && h.length > 0
      && typeof exp === 'number' && Number.isFinite(exp)
      && typeof g === 'string' && g.length > 0
    ) {
      out.push({ h, exp, g });
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
  for (const [h, entry] of liveTickets) {
    if (entry.exp <= nowMs) liveTickets.delete(h);
  }
}

/** 本进程刚写过盘：快照作废并推进版本号（连带让负缓存整体失效）。 */
function invalidateStoreSnapshot(): void {
  storeSnapshot = null;
  storeRaw = null;
  storeVersion += 1;
}

/**
 * 取落盘内容的快照：{@link STORE_SNAPSHOT_TTL_MS} 之内直接复用上一次的解析结果，
 * 过期才真正打一次盘。返回 `null` 表示这次读盘失败（形状不安全等）——调用方
 * fail closed，且**不得**据此写负缓存（存储抖动不该把好票拉黑）。
 *
 * 时钟是注入的（验票传入 `nowMs`），所以「快照年龄为负」意味着调用方在用一个更
 * 早的时间点，此时一律重读，避免测试/回拨时钟拿到错误的缓存。
 */
function loadStoreSnapshot(nowMs: number): { entries: PersistedTicket[]; loadedAt: number } | null {
  if (storeSnapshot) {
    const age = nowMs - storeSnapshot.loadedAt;
    if (age >= 0 && age < STORE_SNAPSHOT_TTL_MS) return storeSnapshot;
  }
  let raw: string | null;
  try {
    diskReads += 1;
    raw = readSecureHostFileSync(ticketsFilePath());
  } catch {
    invalidateStoreSnapshot();
    return null;
  }
  if (raw !== storeRaw) {
    storeRaw = raw;
    storeVersion += 1;
  }
  storeSnapshot = { entries: parsePersisted(raw), loadedAt: nowMs };
  return storeSnapshot;
}

function rememberNegative(key: string, nowMs: number): void {
  // delete + set = LRU 重排；表满时淘汰最久未用的一条，恒定时间，永不全表扫。
  if (!negativeCache.delete(key) && negativeCache.size >= MAX_NEGATIVE_CACHE_ENTRIES) {
    const oldest = negativeCache.keys().next();
    if (!oldest.done) negativeCache.delete(oldest.value);
  }
  negativeCache.set(key, { until: nowMs + NEGATIVE_CACHE_TTL_MS, version: storeVersion });
}

/**
 * Mint 一张新票据并落盘，返回**明文票据**（只出现在返回值和最终 URL 里，不进
 * 日志不进文件）。落盘失败直接抛出——文件是 daemon(mint) 与 dashboard(验票)
 * 之间唯一的交接面，写不进去的票据必然兑换失败，调用方（workbench-link）捕获
 * 后退化为不带票据的登录墙链接，而不是发出一个注定 404 的死链。
 *
 * 读不出当前 token 的 generation 时同样抛出：宁可发无凭证链接，也不发一张绑不上
 * generation、语义不明的票。
 */
export function mintWorkbenchTicket(nowMs = Date.now()): string {
  const generation = currentWorkbenchTokenGeneration();
  if (generation === null) {
    throw new Error('workbench ticket mint aborted: dashboard token generation unreadable');
  }
  const ticket = randomBytes(24).toString('base64url');
  const hash = hashWorkbenchTicket(ticket);
  const exp = nowMs + WORKBENCH_TICKET_TTL_MS;
  // 读-并-写整段持跨进程文件锁：并发的另一处 mint / 定期 prune 不会把这条刚写的
  // 票据覆盖掉（与 loadOrCreatePersistedToken 的 get-or-create 同一套串行化）。
  withSecureHostParentSync(ticketsFilePath(), (parent) =>
    parent.withLeafLock(() => {
      // 顺手扔掉过期条目**和**上一代 token 的条目：后者已经不可能验过，留着只是
      // 占位。这也让 rotate 后的文件在下一次 mint 时自愈，不依赖 revoke 跑过。
      const entries = parsePersisted(parent.readLeaf())
        .filter((e) => e.exp > nowMs && e.g === generation);
      entries.push({ h: hash, exp, g: generation });
      entries.sort((a, b) => b.exp - a.exp);
      parent.writeLeaf(JSON.stringify(entries.slice(0, MAX_PERSISTED_TICKETS)));
    }),
  );
  // 文件写成功才进缓存：Map 里绝不出现 dashboard 进程看不见的「幽灵票」。
  invalidateStoreSnapshot();
  pruneLiveMap(nowMs);
  liveTickets.set(hash, { exp, g: generation });
  ensurePruneTimer();
  return ticket;
}

/**
 * 验票：格式门 → generation 门 → 进程内缓存 → 快照（跨进程 / 重启恢复路径）。
 * 任何读盘异常（目录形状不安全、文件损坏）一律 fail closed 返回 false，绝不因为
 * 存储出问题就放行。hash 比对用 timingSafeEqual 且**不提前退出**，不给远端留计时
 * 侧信道。
 *
 * `generation` 默认从磁盘现算；兑换端点会显式传入「即将下发的那份 token」的
 * generation，把票据直接绑到真正要交出去的凭证上。传入 `null`（读不出来）即
 * fail closed。
 */
export function verifyWorkbenchTicket(
  ticket: string,
  nowMs = Date.now(),
  generation: string | null = currentWorkbenchTokenGeneration(),
): boolean {
  if (typeof ticket !== 'string' || !TICKET_SHAPE.test(ticket)) return false;
  if (generation === null) return false;
  const hash = hashWorkbenchTicket(ticket);
  pruneLiveMap(nowMs);
  const cached = liveTickets.get(hash);
  if (cached !== undefined && cached.exp > nowMs && cached.g === generation) {
    ensurePruneTimer();
    return true;
  }
  // 先（按时间闸）刷新快照再查负缓存：否则负缓存会把自己钉死在一个旧版本号上，
  // 新 mint 的票据永远等不到重新判定。
  const snapshot = loadStoreSnapshot(nowMs);
  if (!snapshot) return false;
  const negativeKey = `${hash}|${generation}`;
  const negative = negativeCache.get(negativeKey);
  if (negative !== undefined && negative.version === storeVersion && negative.until > nowMs) {
    negativeHits += 1;
    return false;
  }
  const hashBuf = Buffer.from(hash, 'utf8');
  let matched: PersistedTicket | undefined;
  for (const entry of snapshot.entries) {
    const entryBuf = Buffer.from(entry.h, 'utf8');
    if (entryBuf.length !== hashBuf.length) continue;
    // 不 break：把 hash 命中位置从响应时间里抹掉。条目数有上限，全量扫描便宜。
    if (
      timingSafeEqual(entryBuf, hashBuf)
      && entry.g === generation
      && (matched === undefined || entry.exp > matched.exp)
    ) {
      matched = entry;
    }
  }
  if (matched !== undefined && matched.exp > nowMs) {
    liveTickets.set(hash, { exp: matched.exp, g: matched.g });
    ensurePruneTimer();
    return true;
  }
  rememberNegative(negativeKey, nowMs);
  return false;
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
    invalidateStoreSnapshot();
  } catch {
    /* best effort */
  }
}

/**
 * 作废「不属于 `generation` 这一代」的全部票据（P1-6）。`botmux dashboard rotate`
 * 落盘成功后调用，传入**新** token 的 generation。
 *
 * 这是保洁，不是防线：真正的防线是验票时的 generation 相等判定，即使这里一次都
 * 没跑过（进程崩了、文件临时不可写），旧票也一样兑不出新 cookie。所以整段吞异常
 * ——rotate 绝不能因为清理失败而失败。
 */
export function revokeWorkbenchTicketsOutsideGeneration(
  generation: string,
  nowMs = Date.now(),
): void {
  for (const [h, entry] of liveTickets) {
    if (entry.g !== generation) liveTickets.delete(h);
  }
  try {
    withSecureHostParentSync(ticketsFilePath(), (parent) =>
      parent.withLeafLock(() => {
        const raw = parent.readLeaf();
        if (raw === null) return; // 还没有票据文件：无需（也不该）凭空创建
        const entries = parsePersisted(raw).filter((e) => e.g === generation && e.exp > nowMs);
        parent.writeLeaf(JSON.stringify(entries));
      }),
    );
  } catch {
    /* best effort：generation 判定已经让旧票验不过 */
  }
  invalidateStoreSnapshot();
}

/** 测试专用：清空进程内缓存、限流闸与定时器，模拟进程重启（文件保留）。 */
export function resetWorkbenchTicketStoreForTests(): void {
  liveTickets.clear();
  negativeCache.clear();
  storeSnapshot = null;
  storeRaw = null;
  storeVersion = 0;
  diskReads = 0;
  negativeHits = 0;
  redemptionGate = createRedemptionGate();
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

/** 测试专用诊断：真正打盘次数与负缓存命中次数。`diskReads` 必须随请求量保持
 *  平坦，否则说明请求路径又退回到「每次同步读凭证文件」。 */
export function workbenchTicketStoreStatsForTests(): {
  diskReads: number;
  negativeHits: number;
  negativeEntries: number;
} {
  return { diskReads, negativeHits, negativeEntries: negativeCache.size };
}

// ─── 兑换端点 ────────────────────────────────────────────────────────────────

/** 过期 / 无效票据的提示页正文（测试断言用同一常量）。零凭据、零回显：不含
 *  token、不含来访票据本身，只告诉用户下一步怎么拿新入口。 */
export const WORKBENCH_TICKET_EXPIRED_MESSAGE =
  '链接已过期，请在会话里重新发送 /dashboard 获取新入口';

/** 触发限流时的提示页正文。同样零凭据、零回显，且不透露票据是否存在。 */
export const WORKBENCH_TICKET_RATE_LIMITED_MESSAGE =
  '兑换请求过于频繁，请稍后再试';

function noticePageHtml(title: string, message: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${title}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0b0e14;color:#e6e6e6">`
    + `<p style="padding:24px;text-align:center;line-height:1.8">${message}</p>`
    + `</body></html>`;
}

export interface WorkbenchTicketRedemptionDeps {
  /** 当前活跃的 legacy 管理 token（`null` = dashboard 还没发过号）。 */
  activeToken: () => string | null;
  /** 反代跳数，语义同 {@link dashboardH5ClientIp}：0（默认）= 只认 socket 对端，
   *  完全不看客户端可伪造的 `x-forwarded-for`。 */
  trustedProxyHops?: number;
}

/**
 * `GET /workbench-ticket/<ticket>` 兑换处理器。命中路径返回 true（响应已写完），
 * 未命中返回 false 交还路由。语义对齐既有 `?t=` 流程（auth.ts 的
 * `allow+set-cookie` 分支）：验票通过 → 种同一个 legacy cookie → 302 进工作台。
 *
 *  - 触发限流：429 + Retry-After + 无凭据提示页（在读任何盘之前就返回，见文件
 *    顶部 P1-10）。名额按尝试消耗，与 LocateRateLimiter 一致。
 *  - 票据有效（含 generation 命中）且有活跃 token：
 *    `Set-Cookie: botmux_dashboard_token=<active>` + 302 `/#/agent-workbench`。
 *  - 票据有效但当前没有活跃 token（dashboard 从未发号）：302 进工作台但不种
 *    cookie，用户面对正常登录墙。这是旧「读不到 token 就发裸链接」行为的对位，
 *    绝不在匿名请求侧顺手铸造新 token。
 *  - 票据无效 / 过期 / 属于 rotate 之前那一代：410 + 无凭据中文提示页。
 *
 * 所有响应一律 no-store：兑换 URL 本身携带凭据性质的票据，任何中间缓存都不该
 * 存它的响应。
 */
export function handleWorkbenchTicketRedemption(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: WorkbenchTicketRedemptionDeps,
): boolean {
  if (req.method !== 'GET') return false;
  const match = url.pathname.match(WORKBENCH_TICKET_ROUTE_RE);
  if (!match) return false;
  const admission = redemptionGate.admit(dashboardH5ClientIp(req, deps.trustedProxyHops ?? 0));
  if (!admission.ok) {
    res.writeHead(429, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': String(Math.max(1, Math.ceil(admission.retryAfterMs / 1000))),
    });
    res.end(noticePageHtml('请求过于频繁', WORKBENCH_TICKET_RATE_LIMITED_MESSAGE));
    return true;
  }
  let ticket = match[1];
  try { ticket = decodeURIComponent(ticket); } catch { /* 保留原样进验票（会被格式门拒掉） */ }
  let token: string | null = null;
  try { token = deps.activeToken(); } catch { token = null; }
  // 绑定的是「此刻真正要交出去的这份 token」的 generation：rotate 之后旧票据既
  // 兑不出新 cookie，也不会退化成「无 cookie 但仍然 302」的半通过。
  if (verifyWorkbenchTicket(ticket, Date.now(), workbenchTicketGeneration(token))) {
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
  res.end(noticePageHtml('入口已过期', WORKBENCH_TICKET_EXPIRED_MESSAGE));
  return true;
}
