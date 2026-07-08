export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
export type SessionsViewMode = 'kanban' | 'board' | 'table';

export const THEME_STORAGE_KEY = 'botmux.dashboard.theme';
export const SESSIONS_VIEW_STORAGE_KEY = 'botmux.dashboard.sessions.view';
export const SESSIONS_SHOW_UNKNOWN_CHATS_STORAGE_KEY = 'botmux.dashboard.sessions.showUnknownChats';

export function normalizeThemeMode(value: unknown): ThemeMode | null {
  return value === 'system' || value === 'light' || value === 'dark' ? value : null;
}

export function normalizeSessionsViewMode(value: unknown): SessionsViewMode | null {
  return value === 'kanban' || value === 'board' || value === 'table' ? value : null;
}

export function resolveThemeMode(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light';
  return mode;
}

export function readStoredThemeMode(storage: Storage | undefined): ThemeMode {
  // 数字员工工作台视觉以 dark 为第一公民 — 未显式选择过主题时默认深色，
  // light / system 仍可在顶栏切换（保留原有功能入口）。
  return normalizeThemeMode(storage?.getItem(THEME_STORAGE_KEY)) ?? 'dark';
}

export function readStoredSessionsViewMode(storage: Storage | undefined): SessionsViewMode {
  return normalizeSessionsViewMode(storage?.getItem(SESSIONS_VIEW_STORAGE_KEY)) ?? 'board';
}

export function readStoredSessionsShowUnknownChats(storage: Storage | undefined): boolean {
  try {
    const raw = storage?.getItem(SESSIONS_SHOW_UNKNOWN_CHATS_STORAGE_KEY);
    return raw == null ? true : raw === '1';
  } catch {
    return true;
  }
}

// ── 看板列顺序（用户可拖拽/按钮自定义，从左到右）─────────────────────────────
export const SESSIONS_BOARD_ORDER_STORAGE_KEY = 'botmux.dashboard.sessions.boardOrder';
export const DEFAULT_BOARD_ORDER = ['needs-you', 'starting', 'working', 'idle'] as const;

/** 必须是默认四列的一个排列（防旧版本残留/手改 localStorage 的脏值）。 */
export function normalizeBoardOrder(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length !== DEFAULT_BOARD_ORDER.length) return null;
  const seen = new Set(value);
  if (seen.size !== value.length) return null;
  for (const id of DEFAULT_BOARD_ORDER) if (!seen.has(id)) return null;
  return value.slice();
}

export function readStoredBoardOrder(storage: Storage | undefined): string[] {
  try {
    const raw = storage?.getItem(SESSIONS_BOARD_ORDER_STORAGE_KEY);
    if (!raw) return [...DEFAULT_BOARD_ORDER];
    return normalizeBoardOrder(JSON.parse(raw)) ?? [...DEFAULT_BOARD_ORDER];
  } catch {
    return [...DEFAULT_BOARD_ORDER];
  }
}

export function writeStoredBoardOrder(storage: Storage | undefined, order: string[]): void {
  try {
    storage?.setItem(SESSIONS_BOARD_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // localStorage 不可用时顺序只在当前页生效
  }
}

export function writeStoredSessionsViewMode(storage: Storage | undefined, mode: SessionsViewMode): void {
  try {
    storage?.setItem(SESSIONS_VIEW_STORAGE_KEY, mode);
  } catch {
    // Some embedded browsers deny localStorage. The current page still updates.
  }
}

export function writeStoredSessionsShowUnknownChats(storage: Storage | undefined, show: boolean): void {
  try {
    storage?.setItem(SESSIONS_SHOW_UNKNOWN_CHATS_STORAGE_KEY, show ? '1' : '0');
  } catch {
    // localStorage 不可用时只在当前页生效
  }
}

// ── 看板分组维度：工作流列 / 团队（筛选某团队的工作流）/ 机器人列 ─────────────
export type KanbanGroupBy = 'flow' | 'team' | 'bot';

export const KANBAN_GROUPBY_STORAGE_KEY = 'botmux.dashboard.sessions.kanbanGroupBy';
export const KANBAN_TEAM_STORAGE_KEY = 'botmux.dashboard.sessions.kanbanTeam';

export function normalizeKanbanGroupBy(value: unknown): KanbanGroupBy | null {
  return value === 'flow' || value === 'team' || value === 'bot' ? value : null;
}

export function readStoredKanbanGroupBy(storage: Storage | undefined): KanbanGroupBy {
  return normalizeKanbanGroupBy(storage?.getItem(KANBAN_GROUPBY_STORAGE_KEY)) ?? 'flow';
}

export function writeStoredKanbanGroupBy(storage: Storage | undefined, mode: KanbanGroupBy): void {
  try {
    storage?.setItem(KANBAN_GROUPBY_STORAGE_KEY, mode);
  } catch {
    // localStorage 不可用时只在当前页生效
  }
}

// ── Skin (visual identity, orthogonal to light/dark) ──────────────────────────
// `default` = the regular botmux look (honours the light/dark theme mode).
// Every other id is a self-contained palette distilled from the kaboo webui; each
// ships its own light/dark palette and ignores the light/dark theme mode.
// `cyber` additionally layers on animated neon FX (the "2077" skin).
export type SkinId =
  | 'default'
  | 'cyber'
  | 'fallout';

export const SKIN_IDS: readonly SkinId[] = [
  'default',
  'cyber',
  'fallout',
];

export const SKIN_STORAGE_KEY = 'botmux.dashboard.skin';

export function normalizeSkin(value: unknown): SkinId | null {
  return typeof value === 'string' && (SKIN_IDS as readonly string[]).includes(value)
    ? (value as SkinId)
    : null;
}

export function readStoredSkin(storage: Storage | undefined): SkinId {
  return normalizeSkin(storage?.getItem(SKIN_STORAGE_KEY)) ?? 'default';
}
