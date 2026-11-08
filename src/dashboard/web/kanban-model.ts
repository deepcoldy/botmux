// 看板视图的纯数据逻辑：默认列推导、列内排序键、拖拽落点位置计算。
// 与 DOM 解耦便于单测；列 id 与校验复用 daemon 同款 core/session-board，
// 列归属复用 core/session-task-status 的会话任务状态。
import {
  KANBAN_COLUMN_IDS,
  normalizeKanbanColumn,
  type SessionKanbanColumn,
} from '../../core/session-board.js';
import {
  BUSY_RUNTIME_STATUSES,
  RECENT_TURN_WINDOW_MS,
  deriveSessionTaskStatus,
  normalizeLastTurn,
  taskStatusChangedAt,
  type SessionTaskFacts,
  type SessionTaskStatus,
} from '../../core/session-task-status.js';

export { KANBAN_COLUMN_IDS, normalizeKanbanColumn, type SessionKanbanColumn };

interface KanbanRowLike extends SessionTaskFacts {
  status?: string;
  queued?: unknown;
  kanbanColumn?: unknown;
  kanbanColumnAt?: unknown;
  kanbanPosition?: unknown;
}

/** 休眠会话最近一轮在这个窗口内结束的，仍留在看板上。 */
export const RECENT_TURN_ON_BOARD_MS = RECENT_TURN_WINDOW_MS;

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function attentionAt(s: KanbanRowLike): number {
  const a = s.agentAttention;
  return a && typeof a === 'object' ? finiteOrZero((a as Record<string, unknown>).at) : 0;
}

/** 手动放置的列，只管到下一次任务状态变化（新消息、新一轮、一轮结束、举手）。
 *  「待办池」只管到会话开始：开跑或跑完过一轮即失效。
 *  没有放置时刻的手动列来自升级之前：那时的最近消息时间一定晚于拖动，不能拿来比，
 *  只认升级后才会出现的事实（开跑、一轮结束、举手）。 */
export function activeManualColumn(s: KanbanRowLike): SessionKanbanColumn | null {
  const manual = normalizeKanbanColumn(s.kanbanColumn);
  if (!manual) return null;
  const at = finiteOrZero(s.kanbanColumnAt);
  const startedAt = Math.max(finiteOrZero(s.busySinceAt), normalizeLastTurn(s.lastTurn)?.at ?? 0);
  if (manual === 'backlog') {
    if (BUSY_RUNTIME_STATUSES.has(String(s.status ?? ''))) return null;
    return startedAt > at ? null : manual;
  }
  const changedAt = at > 0 ? taskStatusChangedAt(s) : Math.max(startedAt, attentionAt(s));
  return changedAt > at ? null : manual;
}

/** 任务状态对应的默认列。 */
export function kanbanColumnForTaskStatus(status: SessionTaskStatus): SessionKanbanColumn {
  switch (status.kind) {
    case 'closed':
    case 'delivered':
      return 'done';
    case 'needs_you':
      return 'in_review';
    case 'working':
      return 'in_progress';
    default:
      return 'todo';
  }
}

/** 会话归属哪一列：已关闭一律「已完成」；停起未开始的在「待办池」；仍有效的手动
 *  放置以手动为准；其余按会话任务状态归列。 */
export function deriveKanbanColumn(s: KanbanRowLike): SessionKanbanColumn {
  if (s.status === 'closed') return 'done';
  if (s.queued) return 'backlog';
  return activeManualColumn(s) ?? kanbanColumnForTaskStatus(deriveSessionTaskStatus(s));
}

/** 看板上默认不放的会话：休眠（进程已退出、下条消息冷恢复）、没有仍有效的手动放置，
 *  且最近一轮不在 24 小时内。休眠会话动辄几千个，全铺上去既看不过来、又拖垮渲染。 */
export function isOffBoardDormant(s: KanbanRowLike, now: number = Date.now()): boolean {
  if (s.status !== 'dormant' || activeManualColumn(s)) return false;
  const turnAt = normalizeLastTurn(s.lastTurn)?.at;
  return turnAt === undefined || now - turnAt >= RECENT_TURN_ON_BOARD_MS;
}

/** 未手动排过序的卡片的排序键基底：量级远大于任何手动位置，保证手动卡片
 *  永远排在自动卡片前面；减 lastMessageAt 让自动区按最近活跃倒序。 */
const UNPINNED_BASE = 1e15;

export function effectiveKanbanPosition(s: KanbanRowLike): number {
  if (typeof s.kanbanPosition === 'number' && Number.isFinite(s.kanbanPosition) && activeManualColumn(s)) {
    return s.kanbanPosition;
  }
  const last = typeof s.lastMessageAt === 'number' && Number.isFinite(s.lastMessageAt) ? s.lastMessageAt : 0;
  return UNPINNED_BASE - last;
}

/** 拖拽落点的持久化位置：夹在两卡之间取中点；落在列首/列尾向外步进；空列取常数。 */
export function computeDropPosition(prevEff: number | null, nextEff: number | null): number {
  if (prevEff !== null && nextEff !== null) return (prevEff + nextEff) / 2;
  if (prevEff !== null) return prevEff + 1024;
  if (nextEff !== null) return nextEff - 1024;
  return 1024;
}

export interface ColumnPagingEntry {
  /** 成员单位数：单卡 1，群簇为成员数。 */
  size: number;
  /** 群簇是否展开。折叠时只渲染标题（成员经展开可达，不算隐藏）；单卡恒为 false，
   *  其 1 个成员始终渲染。 */
  expanded: boolean;
}

export interface ColumnPagingResult {
  /** 预算内整体纳入的条目数（单卡或群簇，含仅显示标题的折叠簇）。 */
  visibleCount: number;
  /** 每个可见条目可渲染的成员数：单卡与折叠簇为 -1（分别渲染整卡/只渲染标题），
   *  展开的簇为截断后的成员上限。下标与「可见条目」一一对应。 */
  memberCaps: number[];
  /** 当前预算下不可达的成员数：未纳入条目的全部成员 + 展开簇被截断的剩余成员，
   *  驱动列底「显示更多（N）」。 */
  hiddenUnits: number;
}

/** 按「实际要渲染的卡片数」给一列分页：
 *  - 单卡占 1；折叠簇只画一个标题，占 1（它的几十上百个成员一个都不渲染，
 *    绝不能按成员数整块吃掉列预算——最近活跃的大群恒在列首，按 size 占位会把
 *    同列其它会话全部推到几十次「显示更多」之后）；
 *  - 展开簇按真实成员卡占预算：还剩位置就纳入并按剩余预算截断、逐页补齐；
 *    一个成员位都不剩时才整体留给下一页（标题本身在折叠态只值 1 个单位）；
 *  - 单卡与折叠标题不跨预算边界拆开。 */
export function paginateColumnEntries(
  entries: ReadonlyArray<ColumnPagingEntry>,
  budget: number,
): ColumnPagingResult {
  const memberCaps: number[] = [];
  let reserved = 0;
  let visibleCount = 0;
  const hideFrom = (start: number): ColumnPagingResult => {
    let hidden = 0;
    for (let j = start; j < entries.length; j++) hidden += entries[j]!.size;
    return { visibleCount, memberCaps, hiddenUnits: hidden };
  };
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry.expanded) {
      // 单卡 / 折叠簇标题：一个渲染单位，放不下就整体留给下一页。
      if (reserved + 1 > budget) return hideFrom(i);
      visibleCount++;
      memberCaps.push(-1);
      reserved += 1;
      continue;
    }
    // 展开簇：按剩余预算截断成员；一个成员位都没有时整条留给下一页。
    const cap = budget - reserved;
    if (cap <= 0) return hideFrom(i);
    const shown = Math.min(entry.size, cap);
    visibleCount++;
    memberCaps.push(shown);
    reserved += shown;
    if (shown < entry.size) {
      let hidden = entry.size - shown;
      for (let j = i + 1; j < entries.length; j++) hidden += entries[j]!.size;
      return { visibleCount, memberCaps, hiddenUnits: hidden };
    }
  }
  return { visibleCount, memberCaps, hiddenUnits: 0 };
}
