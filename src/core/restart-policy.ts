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
 * 把判定抽成纯函数：连续失败按「同一失败原因」累计，时间窗只用于重置
 * 瞬时抖动；已知永久退出码不被时间窗豁免、且阈值更低。
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
  count: number;
  lastAt: number;
  /** 上一次崩溃的退出码，用于识别「同一确定性原因」的连续失败。 */
  lastCode?: number | null;
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

  // 连续失败计数的归零规则：
  //  - 距上次崩溃超过窗口，且本次是普通（非永久）退出 → 视为新的一轮抖动，重置；
  //  - 永久退出码即使间隔很久也不豁免（同一确定性原因在反复发生）；
  //  - 退出码在两个永久码之间变化也算永久失败（都属「重试无意义」类），保持累计。
  let count = input.prev?.count ?? 0;
  const withinWindow = input.prev !== undefined && input.now - input.prev.lastAt <= windowMs;
  const prevPermanent = input.prev !== undefined && isPermanentCliExitCode(input.prev.lastCode);
  if (permanent && prevPermanent) {
    count += 1;
  } else if (!permanent && !prevPermanent && withinWindow) {
    count += 1;
  } else {
    count = 1;
  }

  const next: RestartCounter = { count, lastAt: input.now, lastCode: input.code ?? null };
  const max = permanent ? fatalMax : defaultMax;
  if (count > max) {
    return { next, shouldRestart: false, reason: permanent ? 'permanent_exit' : 'window_budget' };
  }
  return { next, shouldRestart: true, reason: 'ok' };
}
