export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
export type SessionsViewMode = 'kanban' | 'table';

export const THEME_STORAGE_KEY = 'botmux.dashboard.theme';
export const SESSIONS_VIEW_STORAGE_KEY = 'botmux.dashboard.sessions.view';
export const SESSIONS_SHOW_UNKNOWN_CHATS_STORAGE_KEY = 'botmux.dashboard.sessions.showUnknownChats';

// ── 表格视图列显隐（用户可隐藏部分数据列，选择/操作列固定不可隐藏）──────────
export const SESSIONS_TABLE_COLUMNS_STORAGE_KEY = 'botmux.dashboard.sessions.tableColumns';

/** 必须存在的列：选择框 + 操作列，永远不可隐藏。 */
export const FIXED_TABLE_COLUMNS = ['select', 'actions'] as const;

/** 校验存储值：必须是字符串数组，且不包含固定列（固定列不参与持久化）。 */
export function normalizeHiddenTableColumns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const fixed = new Set<string>(FIXED_TABLE_COLUMNS);
  return value
    .filter((v): v is string => typeof v === 'string' && !fixed.has(v))
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

export function readStoredHiddenTableColumns(storage: Storage | undefined): string[] {
  try {
    const raw = storage?.getItem(SESSIONS_TABLE_COLUMNS_STORAGE_KEY);
    if (!raw) return [];
    return normalizeHiddenTableColumns(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function writeStoredHiddenTableColumns(storage: Storage | undefined, hidden: string[]): void {
  try {
    storage?.setItem(SESSIONS_TABLE_COLUMNS_STORAGE_KEY, JSON.stringify(normalizeHiddenTableColumns(hidden)));
  } catch {
    // localStorage 不可用时只在当前页生效
  }
}

export function normalizeThemeMode(value: unknown): ThemeMode | null {
  return value === 'system' || value === 'light' || value === 'dark' ? value : null;
}

/** 会话页只剩「看板」「列表」两个视图。旧版存过的 board（状态板）/ topics（话题）
 *  已并入看板，读到时迁移成 kanban，而不是当脏值丢回默认。 */
export function normalizeSessionsViewMode(value: unknown): SessionsViewMode | null {
  if (value === 'table') return 'table';
  return value === 'kanban' || value === 'board' || value === 'topics' ? 'kanban' : null;
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
  return normalizeSessionsViewMode(storage?.getItem(SESSIONS_VIEW_STORAGE_KEY)) ?? 'kanban';
}

export function readStoredSessionsShowUnknownChats(storage: Storage | undefined): boolean {
  try {
    const raw = storage?.getItem(SESSIONS_SHOW_UNKNOWN_CHATS_STORAGE_KEY);
    return raw == null ? true : raw === '1';
  } catch {
    return true;
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

// ── 创建会话弹窗「连续创建」开关（创建成功后不关闭弹窗）────────────────────────
export const SESSIONS_CREATE_KEEP_OPEN_STORAGE_KEY = 'botmux.dashboard.sessions.createKeepOpen';

export function readStoredCreateKeepOpen(storage: Storage | undefined): boolean {
  try {
    return storage?.getItem(SESSIONS_CREATE_KEEP_OPEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeStoredCreateKeepOpen(storage: Storage | undefined, keepOpen: boolean): void {
  try {
    storage?.setItem(SESSIONS_CREATE_KEEP_OPEN_STORAGE_KEY, keepOpen ? '1' : '0');
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
