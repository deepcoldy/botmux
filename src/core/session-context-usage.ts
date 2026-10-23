/**
 * 把一次用量快照投影成 `botmux observe` 的 `context` 块（SessionRow.contextUsage）。
 *
 * 纯函数，不读盘：transcript 读取在 cost-calculator（共享同一份文件缓存），
 * statusline 快照读取由调用方做完再传进来。
 *
 * 原则：拿不到就整块缺省，不填 0、不按模型名猜窗口。
 *  - usedTokens：最近一次请求的提示大小（不是累计）。
 *  - windowTokens：Codex 取 rollout 里的 model_context_window；Claude 取 statusline
 *    快照的 context_window_size（快照过期时调用方不传 ⇒ null）。
 *  - compactions：来自 cost-calculator 的计数，未知就是 null。
 */
import type { ObserveContext } from '../services/session-observe.js';
import type { SessionContextObservation, SessionUsageSnapshot } from './cost-calculator.js';

export function buildContextUsage(input: {
  snapshot: Pick<SessionUsageSnapshot, 'context'>;
  contextObservation?: SessionContextObservation;
  /** Claude Code only: `context_window_size` from a fresh statusline snapshot. */
  statuslineWindowTokens?: number;
}): ObserveContext | undefined {
  const { context } = input.snapshot;
  const { contextObservation } = input;
  if (!context || !contextObservation) return undefined;
  if (!(context.usedTokens > 0)) return undefined;

  const reportedWindow = contextObservation.source === 'claude-transcript'
    ? input.statuslineWindowTokens
    : context.windowTokens;
  const windowTokens = typeof reportedWindow === 'number' && Number.isFinite(reportedWindow) && reportedWindow > 0
    ? reportedWindow
    : null;

  return {
    usedTokens: context.usedTokens,
    windowTokens,
    compactions: contextObservation.compactions,
    measuredAt: contextObservation.measuredAtMs,
    source: contextObservation.source,
  };
}
