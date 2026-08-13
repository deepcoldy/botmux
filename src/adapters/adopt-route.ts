/**
 * adopt-route.ts
 *
 * 为没有 BOTMUX_* 环境变量的"孤立" Claude 进程（即通过 /adopt 接管的外部 CLI）
 * 提供 askUserQuestion hook 的路由解析逻辑。
 *
 * 通过以下步骤确定目标 Lark 会话：
 *   1. 收集 hook 进程的祖先 PID 链
 *   2. 遍历在线 daemon，查询每个 daemon 是否有以某祖先 PID 启动的 adopt 会话
 *   3. 首个命中即返回路由信息
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';

// ── 类型 ───────────────────────────────────────────────────────────────────────

/** 从 daemon 取回的 adopt 会话路由信息 */
export interface AdoptRoute {
  sessionId: string;
  chatId: string;
  larkAppId: string;
  rootMessageId: string;
}

// ── 祖先 PID 收集 ──────────────────────────────────────────────────────────────

/**
 * 读取某进程的父 PID。
 *
 * 默认实现：
 *   1. 优先从 /proc/<pid>/stat 读取（Linux），第 4 字段（0-based）是 ppid。
 *      注意 stat 第 2 字段 comm 可以含括号和空格，所以从最后一个 `)` 之后的子串解析。
 *   2. 失败时回退到 `ps -o ppid= -p <pid>`（macOS/Linux 通用）。
 *
 * 失败/进程不存在 → 返回 null。
 */
function defaultReadParent(pid: number): number | null {
  // 先尝试 /proc（Linux 最快）
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    // stat 格式: "<pid> (<comm>) <state> <ppid> ..."
    // comm 字段可能含空格和括号，取最后一个 ')' 之后的部分
    const lastParen = stat.lastIndexOf(')');
    if (lastParen === -1) throw new Error('unexpected /proc stat format');
    const tail = stat.slice(lastParen + 1).trim();
    // tail: "<state> <ppid> ..."
    const parts = tail.split(' ');
    // parts[0] = state, parts[1] = ppid
    const ppid = parseInt(parts[1], 10);
    if (Number.isInteger(ppid) && ppid > 0) return ppid;
  } catch {
    // /proc 不可用或解析失败，回退到 ps
  }

  // 回退到 ps（macOS / 无 /proc 的 Linux）
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf-8',
    });
    const ppid = parseInt(out.trim(), 10);
    if (Number.isInteger(ppid) && ppid > 0) return ppid;
  } catch {
    // 进程不存在或 ps 调用失败
  }

  return null;
}

/**
 * 沿进程祖先链向上收集 PID（不含 startPid 自己）。
 *
 * @param startPid    起始进程 PID（自身不包含在结果中）
 * @param readParent  注入式父 PID 读取函数（默认使用 /proc 或 ps）
 * @param maxDepth    最大深度，防止意外无限循环（默认 40）
 * @returns           祖先 PID 数组，从最近父进程到最远祖先
 */
export function getAncestorPids(
  startPid: number,
  readParent?: (pid: number) => number | null,
  maxDepth?: number,
): number[] {
  const reader = readParent ?? defaultReadParent;
  const depth = maxDepth ?? 40;
  const ancestors: number[] = [];
  const visited = new Set<number>([startPid]);

  let current = startPid;
  for (let i = 0; i < depth; i++) {
    const parent = reader(current);
    if (parent === null || parent <= 1) break;  // 到 init 或读不到，停止
    if (visited.has(parent)) break;             // 防环
    visited.add(parent);
    ancestors.push(parent);
    current = parent;
  }

  return ancestors;
}

// ── Daemon 查询辅助 ─────────────────────────────────────────────────────────────

/**
 * 查询某个 daemon 是否有以指定 PID 启动的活跃 adopt 会话。
 *
 * GET http://127.0.0.1:<ipcPort>/api/adopt-session/<pid>
 *   200 → 解析 AdoptRoute；其它状态码或异常 → null（不抛）。
 * 超时：2 秒（AbortController）。
 */
export async function queryAdoptSession(
  ipcPort: number,
  pid: number,
): Promise<AdoptRoute | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetchDaemonIpc(
      ipcPort,
      `/api/adopt-session/${pid}`,
      { signal: controller.signal },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    if (
      typeof b.sessionId !== 'string' ||
      typeof b.chatId !== 'string' ||
      typeof b.larkAppId !== 'string' ||
      typeof b.rootMessageId !== 'string'
    ) {
      return null;
    }
    return {
      sessionId: b.sessionId,
      chatId: b.chatId,
      larkAppId: b.larkAppId,
      rootMessageId: b.rootMessageId,
    };
  } catch {
    // 超时、网络错误、JSON 解析失败等 → null
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── 主逻辑 ─────────────────────────────────────────────────────────────────────

/**
 * 通过祖先 PID 匹配在线 adopt 会话。
 *
 * **并发 + 全局 budget 封顶**：候选 = daemon 列表序 × 祖先链序（由近及远）逐个编号；
 * 全部并发查询（每请求各自带 2s 超时），整体不超过 `budgetMs`。命中按候选 index 取
 * 最小，保持确定性。
 *
 * 为何要全局 budget：runHook 在缺 BOTMUX_* 时同步 await 本函数，而全局 hook 会覆盖
 * 非 botmux 的 Claude 会话；若某 daemon still-online 但 IPC 不响应，顺序 await 会
 * `祖先数 × 2s × daemon 数` 线性叠加（可达几十秒），把真·非 botmux 的 ask 卡死。
 * 并发让总耗时收敛到单请求量级，budget 再封顶，保证快速 passthrough。
 *
 * @param deps.startPid      hook 进程自身的 PID
 * @param deps.listDaemons   列出在线 daemon（ipcPort）
 * @param deps.queryDaemon   查询某 daemon 是否有该 pid 的活跃 adopt 会话
 * @param deps.getAncestors  取祖先 PID（默认使用 getAncestorPids）
 * @param deps.budgetMs      整体耗时上限（默认 1500ms；可注入便于测试）
 */
export async function resolveAdoptRoute(deps: {
  startPid: number;
  listDaemons: () => Array<{ ipcPort: number }>;
  queryDaemon: (ipcPort: number, pid: number) => Promise<AdoptRoute | null>;
  getAncestors?: (startPid: number) => number[];
  budgetMs?: number;
}): Promise<AdoptRoute | null> {
  const { startPid, listDaemons, queryDaemon } = deps;
  const getAncestors = deps.getAncestors ?? ((pid) => getAncestorPids(pid));
  const budgetMs = deps.budgetMs ?? 1500;
  const ancestors = getAncestors(startPid);
  if (ancestors.length === 0) return null;

  const daemons = listDaemons();
  if (daemons.length === 0) return null;

  // 候选编号：daemon 列表序 × 祖先链序（由近及远），index 决定确定性优先级。
  const candidates: Array<{ index: number; ipcPort: number; pid: number }> = [];
  let idx = 0;
  for (const daemon of daemons) {
    for (const pid of ancestors) {
      candidates.push({ index: idx++, ipcPort: daemon.ipcPort, pid });
    }
  }

  // 并发发起全部查询，命中按 index 记入 hits；整体被 budget 封顶。
  const hits = new Map<number, AdoptRoute>();
  const queries = candidates.map(async (c) => {
    const route = await queryDaemon(c.ipcPort, c.pid);
    if (route) hits.set(c.index, route);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.allSettled(queries), budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  // 在「budget 内已 settle 的命中」里按候选 index 升序取最早的一个（确定性）。
  let best: AdoptRoute | null = null;
  let bestIdx = Infinity;
  for (const [i, route] of hits) {
    if (i < bestIdx) { bestIdx = i; best = route; }
  }
  if (best && process.env.BOTMUX_HOOK_DEBUG === '1') {
    process.stderr.write(`[adopt-route] matched candidate#${bestIdx} session=${best.sessionId}\n`);
  }
  return best;
}

// ── CLI 原生会话 id 反查（托管 service 场景）────────────────────────────────

/**
 * 单 daemon 的 cliSessionId 反查结果。
 * - hit：该 daemon 内恰好一个活跃会话绑定该 cliSessionId
 * - conflict：该 daemon 内多个会话绑定同一 cliSessionId（两个话题/机器人并发
 *   导入同一外部会话可正常产生重复绑定，cliSessionId 不代表 botmux 绑定唯一）
 * - miss：该 daemon 明确无匹配
 * - unknown：查询失败/超时，结果未知 → 上层必须视为「无法证明唯一」fail closed
 */
export type CliSessionLookup =
  | { kind: 'hit'; route: AdoptRoute }
  | { kind: 'conflict' }
  | { kind: 'miss' }
  | { kind: 'unknown' };

/**
 * 查询某个 daemon 是否有该 CLI 原生会话 id（如 OpenCode 的 `ses_*`）的活跃
 * 会话。反查 identity 是 (cliId, cliSessionId)：OpenCode V1→V2 迁移会原样保留
 * ses_* id，必须带上发起反查的适配器 cliId，否则 V1 会话会被误当成唯一 hit。
 * 本端点只服务 opencode2 共享托管 service 的反查（服务端强制 cliId===opencode2）。
 * GET http://127.0.0.1:<ipcPort>/api/session-by-cli/opencode2/<cliSessionId>
 * 200 → hit；409（重复绑定）→ conflict；404 且 body 为本 endpoint 专用响应
 * `{error:'no_session'}` → miss（明确无匹配）；generic 404 / 401 / 403 / 5xx
 * 等其它状态与无效 body → unknown（协议/查询结果未知，上层必须视为「无法证明
 * 唯一」fail closed）。超时 2s。
 */
export async function queryCliSession(
  ipcPort: number,
  cliSessionId: string,
): Promise<CliSessionLookup> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetchDaemonIpc(
      ipcPort,
      `/api/session-by-cli/opencode2/${encodeURIComponent(cliSessionId)}`,
      { signal: controller.signal },
    );
    if (res.status === 409) return { kind: 'conflict' };
    if (res.status === 404) {
      // 只有本 endpoint 自己稳定的专用 404（{ok:false,error:'no_session'}）才算
      // 「明确无匹配」。IPC 路由全局兜底（core/dashboard-ipc-server.ts）对未注册
      // 路径统一返回 404 {error:'not_found',path}——滚动升级/部分 daemon 未重启
      // 时旧 daemon 没有本路由会撞 generic 404，status 与真 miss 相同但语义是
      // 「无法回答」；若当 miss 处理，「新 daemon hit + 旧 daemon generic 404」
      // 会被聚合器误证唯一命中。generic 404 / 无 body / 畸形 body / JSON 解析
      // 失败（json() 抛错落到外层 catch）一律按 unknown fail closed。
      const body = (await res.json()) as unknown;
      if (
        body && typeof body === 'object'
        && (body as Record<string, unknown>).error === 'no_session'
      ) {
        return { kind: 'miss' };
      }
      return { kind: 'unknown' };
    }
    // 401/403/5xx 等非 2xx 不是否定答案——另一 daemon 可能命中，必须按 unknown。
    if (!res.ok) return { kind: 'unknown' };
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== 'object') return { kind: 'unknown' };
    const b = body as Record<string, unknown>;
    if (
      typeof b.sessionId !== 'string' ||
      typeof b.chatId !== 'string' ||
      typeof b.larkAppId !== 'string' ||
      typeof b.rootMessageId !== 'string'
    ) {
      // 畸形 200 body：协议未知，不能当作否定答案
      return { kind: 'unknown' };
    }
    return {
      kind: 'hit',
      route: {
        sessionId: b.sessionId,
        chatId: b.chatId,
        larkAppId: b.larkAppId,
        rootMessageId: b.rootMessageId,
      },
    };
  } catch {
    return { kind: 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 并发反查全部在线 daemon，按 cliSessionId 找所属 botmux 会话。
 *
 * 托管 service 场景（opencode2 的 ask 插件运行在所有客户端共用的 service 里）：
 * hook 子进程继承的是「启动该 service 的会话」的 ambient env，与当前会话无关，
 * 不能拿来路由 —— 必须用 payload 携带的 native sessionID 显式反查，否则跨会话
 * 错投。
 *
 * **fail closed（恰好一个完整命中才返回）**：必须证明命中唯一才返回路由，
 * 以下任一情况都返回 null（由调用方 passthrough），绝不按网络时序挑一个命中：
 * - 0 个命中 → 未命中
 * - ≥2 个命中（并发导入同一外部会话的重复绑定）→ 歧义
 * - 任一 daemon 报 conflict → 歧义
 * - 任一候选在 budget 内未确定结果（挂起/异常/unknown）→ 无法证明唯一
 *
 * @param deps.cliSessionId   OpenCode 原生会话 id（payload.session_id）
 * @param deps.listDaemons    列出在线 daemon（ipcPort）
 * @param deps.queryDaemon    查询某 daemon 是否有该 cliSessionId 的活跃会话
 * @param deps.budgetMs       整体耗时上限（默认 1500ms；可注入便于测试）
 */
export async function resolveCliSessionRoute(deps: {
  cliSessionId: string;
  listDaemons: () => Array<{ ipcPort: number }>;
  queryDaemon: (ipcPort: number, cliSessionId: string) => Promise<CliSessionLookup>;
  budgetMs?: number;
}): Promise<AdoptRoute | null> {
  const { cliSessionId, listDaemons, queryDaemon } = deps;
  const budgetMs = deps.budgetMs ?? 1500;
  const daemons = listDaemons();
  if (daemons.length === 0) return null;

  // 并发查询全部 daemon（不做提前退出——必须等所有候选出结果才能证明唯一性），
  // 整体耗时被 budget 封顶。
  const hits: AdoptRoute[] = [];
  let conflicted = false;
  let indeterminate = false;
  let settled = 0;
  const queries = daemons.map(async (daemon) => {
    try {
      const lookup = await queryDaemon(daemon.ipcPort, cliSessionId);
      if (lookup.kind === 'hit') hits.push(lookup.route);
      else if (lookup.kind === 'conflict') conflicted = true;
      else if (lookup.kind === 'unknown') indeterminate = true;
    } catch {
      // 查询异常 → 该候选结果未知，无法证明唯一
      indeterminate = true;
    } finally {
      settled++;
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.allSettled(queries), budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  // budget 到期仍有候选未出结果 / 任一歧义 / 命中数≠1 → 全部 fail closed。
  if (settled < daemons.length || conflicted || indeterminate) return null;
  if (hits.length !== 1) return null;
  if (process.env.BOTMUX_HOOK_DEBUG === '1') {
    process.stderr.write(`[adopt-route] cli-session matched session=${hits[0].sessionId}\n`);
  }
  return hits[0];
}
