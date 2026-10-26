/**
 * CLI 崩溃自动重启的速率限制判定（纯逻辑）。
 *
 * 旧实现只在 worker-pool 内联维护一个「60 秒滚动窗内最多 3 次」计数：
 *   if (now - rc.lastAt > 60_000) rc.count = 0;
 *   rc.count++;
 * 它完全不看退出码，有两个洞：
 *  1. 确定性失败如果每次从启动到崩溃超过 60 秒（启动慢的 CLI 很常见），每次
 *     都被当成「新窗口第一次」→ 永不熔断、无限静默重启。
 *  2. 身份/凭证类失败（exit 77）重试本身无意义且会反复触发受管工具调用，
 *     应当更快停止，而不是和普通抖动一样等满 3 次。
 *
 * 把判定抽成纯函数：连续失败累计，已知永久退出码不被时间窗豁免、且阈值更低。
 *
 * 两个必须守住的边界（评审实测出来的）：
 *  - **性质切换不清零**：崩溃码在「永久 / 普通」之间来回跳（77,1,77,1…）时，
 *    两套计数各自从 1 起算会把限流整个绕过去（实测 20 次崩溃停止 0 次）。因此
 *    两个计数（总次数 `count`、永久次数 `permanentCount`）都只增不减，永久通道
 *    用自己的累计值判闸，而不是本次退出码。
 *  - **恢复健康即清零**：计数只在「连续失败」里才有意义。CLI 一旦报告 ready
 *    （prompt_ready），说明它真的跑起来了；此前那次历史性 127 不该让这条会话
 *    此后任何一次 127 都立即不重启（实测隔 90 天仍如此）。清零由调用方在 ready
 *    时做（worker-pool 的 prompt_ready 分支 delete 掉该 session 的计数）。
 *    本模块因此不缓存任何跨会话状态，重置语义天然成立。
 */

export const RESTART_WINDOW_MS = 60_000;
export const DEFAULT_MAX_RESTARTS = 3;
/** 身份/凭证等确定性失败：更保守的重启上限。 */
export const FATAL_MAX_RESTARTS = 1;

/**
 * 已知「重试不会变好」的退出码。命中即走确定性失败通道：
 *  - 77：botmux 身份/凭证缺失或失效（lark-tool-runner 约定）；
 *  - 127：命令/可执行文件不存在（CLI 没装或路径错）。
 * 信号杀死（code 为 null）不算确定性失败——那通常是外部 OOM/管控，值得重试。
 */
export function isPermanentCliExitCode(code: number | null | undefined): boolean {
  return code === 77 || code === 127;
}

export interface RestartCounter {
  /** 连续失败总次数（跨性质累计；CLI ready 后由调用方清掉整条记录）。 */
  count: number;
  lastAt: number;
  /** 上一次崩溃的退出码，用于日志与性质判断。 */
  lastCode?: number | null;
  /** 本轮连续失败里命中永久退出码的次数（跨性质累计）。 */
  permanentCount?: number;
}

export interface RestartDecisionInput {
  prev: RestartCounter | undefined;
  now: number;
  code: number | null | undefined;
  windowMs?: number;
  defaultMax?: number;
  fatalMax?: number;
}

export interface RestartDecision {
  /** 更新后的计数（调用方据此 set/delete）。 */
  next: RestartCounter;
  /** 这次是否还允许自动重启；false 表示应停止并进入诊断/人工处理。 */
  shouldRestart: boolean;
  /** 触发停止的原因，便于日志/卡片区分。 */
  reason: 'ok' | 'window_budget' | 'permanent_exit';
}

export function decideAutoRestart(input: RestartDecisionInput): RestartDecision {
  const windowMs = input.windowMs ?? RESTART_WINDOW_MS;
  const defaultMax = input.defaultMax ?? DEFAULT_MAX_RESTARTS;
  const fatalMax = input.fatalMax ?? FATAL_MAX_RESTARTS;
  const permanent = isPermanentCliExitCode(input.code);

  const withinWindow = input.prev !== undefined && input.now - input.prev.lastAt <= windowMs;
  const prevPermanent = input.prev !== undefined && isPermanentCliExitCode(input.prev.lastCode);
  const prevCount = input.prev?.count ?? 0;
  const prevPermanentCount = input.prev?.permanentCount
    // 兼容老记录（引入 permanentCount 前写入的项）：按上一次退出码补算。
    ?? (prevPermanent ? prevCount : 0);

  // 计数只增不减 —— 性质切换（永久↔普通）**不**重置，否则来回横跳即可无限续命。
  // 唯一的重置入口是「恢复健康」（调用方在 prompt_ready 时删除计数）。
  // 时间窗只用来判断「这次普通崩溃是否属于同一轮抖动」。
  let count: number;
  if (input.prev === undefined) {
    count = 1;
  } else if (permanent && prevPermanent) {
    // 同一类确定性失败反复发生：跨窗也累计（本 PR 主治的慢启动必崩场景）。
    count = prevCount + 1;
  } else if (!permanent && !prevPermanent) {
    // 都是普通退出：窗口内累计，超窗视为新的一轮抖动（与旧实现边界等价）。
    count = withinWindow ? prevCount + 1 : 1;
  } else {
    // 性质切换：不清零，在上一轮基础上继续往上数。
    count = prevCount + 1;
  }

  const permanentCount = prevPermanentCount + (permanent ? 1 : 0);
  const next: RestartCounter = {
    count,
    lastAt: input.now,
    lastCode: input.code ?? null,
    permanentCount,
  };

  // 永久通道用自己的累计值判闸：首次永久失败给一次重启，第二次（无论中间是否
  // 夹了普通崩溃）即停。不看 count，否则一笔陈年普通崩溃会吞掉这唯一的机会。
  if (permanent && permanentCount > fatalMax) {
    return { next, shouldRestart: false, reason: 'permanent_exit' };
  }
  // 普通通道：窗口内预算耗尽。permanentCount 一旦超限，普通退出也不再放行
  // ——否则「永久失败→普通失败」交替就能让限流整体失效。
  if (!permanent && permanentCount > fatalMax) {
    return { next, shouldRestart: false, reason: 'permanent_exit' };
  }
  if (!permanent && count > defaultMax) {
    return { next, shouldRestart: false, reason: 'window_budget' };
  }
  return { next, shouldRestart: true, reason: 'ok' };
}
