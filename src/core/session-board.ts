// 会话看板（kanban）的列定义与输入校验 — daemon 写端点与 dashboard 前端共用，
// 保证两侧对「合法列 / 合法排序值 / 合法标题」的口径一致。保持零依赖：
// 该模块会被 esbuild 打进浏览器 bundle。

export const KANBAN_COLUMN_IDS = ['backlog', 'todo', 'in_progress', 'in_review', 'done'] as const;
export type SessionKanbanColumn = (typeof KANBAN_COLUMN_IDS)[number];

export const SESSION_TITLE_MAX = 200;

export function normalizeKanbanColumn(value: unknown): SessionKanbanColumn | null {
  return typeof value === 'string' && (KANBAN_COLUMN_IDS as readonly string[]).includes(value)
    ? (value as SessionKanbanColumn)
    : null;
}

/** 排序位置是任意有限数（拖拽用相邻中点插入，会出现小数/大数）。 */
export function normalizeKanbanPosition(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 重命名标题：去首尾空白、压缩换行、限长；空串视为非法。 */
export function normalizeSessionTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const title = value.replace(/\s*\n\s*/g, ' ').trim();
  if (!title) return null;
  return title.slice(0, SESSION_TITLE_MAX);
}
