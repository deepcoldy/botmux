// 看板视图的纯数据逻辑：默认列推导、列内排序键、拖拽落点位置计算。
// 与 DOM 解耦便于单测；列 id 与校验复用 daemon 同款 core/session-board。
import {
  KANBAN_COLUMN_IDS,
  normalizeKanbanColumn,
  type SessionKanbanColumn,
} from '../../core/session-board.js';

export { KANBAN_COLUMN_IDS, normalizeKanbanColumn, type SessionKanbanColumn };

interface KanbanRowLike {
  status?: string;
  kanbanColumn?: unknown;
  kanbanPosition?: unknown;
  lastMessageAt?: unknown;
  pendingRepo?: unknown;
  tuiPromptActive?: unknown;
  agentAttention?: unknown;
}

/** 会话归属哪一列：已关闭一律「已完成」；手动放置过以手动为准；其余按运行
 *  状态推导默认列（需人工信号→待确认，启动/干活→进行中，空闲→待办）。
 *  「待办池」只进不出——没有任何自动规则会把卡片放进去，纯手动。 */
export function deriveKanbanColumn(s: KanbanRowLike): SessionKanbanColumn {
  if (s.status === 'closed') return 'done';
  const manual = normalizeKanbanColumn(s.kanbanColumn);
  if (manual) return manual;
  if (s.pendingRepo || s.tuiPromptActive || s.agentAttention || s.status === 'limited') return 'in_review';
  if (s.status === 'starting' || s.status === 'working' || s.status === 'analyzing' || s.status === 'active') {
    return 'in_progress';
  }
  return 'todo';
}

/** 未手动排过序的卡片的排序键基底：量级远大于任何手动位置，保证手动卡片
 *  永远排在自动卡片前面；减 lastMessageAt 让自动区按最近活跃倒序。 */
const UNPINNED_BASE = 1e15;

export function effectiveKanbanPosition(s: KanbanRowLike): number {
  if (typeof s.kanbanPosition === 'number' && Number.isFinite(s.kanbanPosition)) return s.kanbanPosition;
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
