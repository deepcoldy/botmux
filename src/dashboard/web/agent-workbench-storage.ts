import {
  clampRailWidth,
  defaultWorkbenchLayout,
  isWorkbenchGroupDimension,
  normalizeWorkbenchLayout,
  type WorkbenchGroupDimension,
  type WorkbenchLayoutState,
} from './agent-workbench-model.js';

export interface WorkbenchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

const STORAGE_PREFIX = 'botmux.agent-workbench.layout.v1:';
const RAIL_PREFS_KEY = 'botmux.agent-workbench.rail.v1';
const SEEN_LEDGER_KEY = 'botmux.agent-workbench.seen.v1';
const GROUP_DIMENSION_KEY = 'botmux.agent-workbench.group-dim.v1';
const COLLAPSED_GROUPS_KEY = 'botmux.agent-workbench.collapsed.v1';
/** 账本只是本地未读提示，不需要记住所有历史会话。超过这个数就按时间新旧砍掉最老的，
 *  免得一台常年不关的机器把 localStorage 撑爆。 */
const SEEN_LEDGER_MAX_ENTRIES = 500;
/** 折叠状态存的是组 key。换一次分组维度就可能长出一批新组名（机器人名、会话名、
 *  仓库名都是数据里的自由文本），不封顶的话这张表只会越堆越长。 */
const COLLAPSED_GROUPS_MAX_ENTRIES = 200;

export function workbenchLayoutStorageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(sessionId)}`;
}

export function loadWorkbenchLayout(
  sessionId: string,
  storage: WorkbenchStorage | null | undefined,
): WorkbenchLayoutState {
  if (!storage) return defaultWorkbenchLayout();
  try {
    const raw = storage.getItem(workbenchLayoutStorageKey(sessionId));
    return raw ? normalizeWorkbenchLayout(JSON.parse(raw)) : defaultWorkbenchLayout();
  } catch {
    return defaultWorkbenchLayout();
  }
}

/** Persists layout primitives only. URLs, grants, cookies and frame state are never serialised. */
export function saveWorkbenchLayout(
  sessionId: string,
  layout: WorkbenchLayoutState,
  storage: WorkbenchStorage | null | undefined,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(workbenchLayoutStorageKey(sessionId), JSON.stringify(normalizeWorkbenchLayout(layout)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Rail geometry belongs to the window, not to a session. Keeping it per session
 * made the sidebar jump to a different width on every selection change, so the
 * width and the collapsed flag live in one global record instead.
 */
export interface WorkbenchRailPrefs {
  railWidth: number;
  railCollapsed: boolean;
}

export function loadWorkbenchRailPrefs(
  storage: WorkbenchStorage | null | undefined,
): WorkbenchRailPrefs | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(RAIL_PREFS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const input = parsed as Partial<WorkbenchRailPrefs>;
    return {
      railWidth: clampRailWidth(Number(input.railWidth)),
      railCollapsed: input.railCollapsed === true,
    };
  } catch {
    return null;
  }
}

export function saveWorkbenchRailPrefs(
  storage: WorkbenchStorage | null | undefined,
  prefs: WorkbenchRailPrefs,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(RAIL_PREFS_KEY, JSON.stringify({
      railWidth: clampRailWidth(Number(prefs.railWidth)),
      railCollapsed: prefs.railCollapsed === true,
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * 未读账本，纯前端的一份小记录：
 * - `seen[sessionId]`  —— 你最后一次「点开」这个会话的时刻，未读的清零线。
 * - `unread[sessionId]` —— 本地侦测到 bot 干完活（working→idle）的时刻。
 * 两者都是 epoch 毫秒。`unread > seen` 即未读；页面关闭期间的动静另有活动时间兜底。
 * 只存 id 和时间戳，不存标题、聊天内容或任何链接。
 */
export interface WorkbenchSeenLedger {
  seen: Record<string, number>;
  unread: Record<string, number>;
}

export function emptyWorkbenchSeenLedger(): WorkbenchSeenLedger {
  return { seen: {}, unread: {} };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 丢掉坏条目，再按时间保留最近 N 条。 */
function normalizeStamps(value: unknown, max: number): Record<string, number> {
  if (!isPlainRecord(value)) return {};
  const entries: [string, number][] = [];
  for (const [sessionId, raw] of Object.entries(value)) {
    const at = Number(raw);
    if (!sessionId || !Number.isFinite(at) || at <= 0) continue;
    entries.push([sessionId, at]);
  }
  if (entries.length > max) {
    entries.sort((a, b) => b[1] - a[1]);
    entries.length = max;
  }
  return Object.fromEntries(entries);
}

export function pruneWorkbenchSeenLedger(
  ledger: WorkbenchSeenLedger,
  max = SEEN_LEDGER_MAX_ENTRIES,
): WorkbenchSeenLedger {
  return {
    seen: normalizeStamps(ledger.seen, max),
    unread: normalizeStamps(ledger.unread, max),
  };
}

/** 坏数据（不是 JSON、不是对象、两张表都不成形）一律回 null，让调用方走首次基线。 */
export function loadWorkbenchSeenLedger(
  storage: WorkbenchStorage | null | undefined,
): WorkbenchSeenLedger | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SEEN_LEDGER_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed)) return null;
    if (!isPlainRecord(parsed.seen) && !isPlainRecord(parsed.unread)) return null;
    return pruneWorkbenchSeenLedger({
      seen: (parsed.seen ?? {}) as Record<string, number>,
      unread: (parsed.unread ?? {}) as Record<string, number>,
    });
  } catch {
    return null;
  }
}

export function saveWorkbenchSeenLedger(
  storage: WorkbenchStorage | null | undefined,
  ledger: WorkbenchSeenLedger,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SEEN_LEDGER_KEY, JSON.stringify(pruneWorkbenchSeenLedger(ledger)));
    return true;
  } catch {
    return false;
  }
}

/** 分组维度是全局偏好（不分会话）。白名单外的值一律当没存过。 */
export function loadWorkbenchGroupDimension(
  storage: WorkbenchStorage | null | undefined,
): WorkbenchGroupDimension | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(GROUP_DIMENSION_KEY);
    return isWorkbenchGroupDimension(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function saveWorkbenchGroupDimension(
  storage: WorkbenchStorage | null | undefined,
  dimension: WorkbenchGroupDimension,
): boolean {
  if (!storage || !isWorkbenchGroupDimension(dimension)) return false;
  try {
    storage.setItem(GROUP_DIMENSION_KEY, dimension);
    return true;
  } catch {
    return false;
  }
}

/** 去重 + 封顶。数组按「加入顺序」存，所以超出上限时砍掉最前面的（最早折叠的那些组）。 */
function pruneCollapsedGroups(keys: readonly unknown[], max = COLLAPSED_GROUPS_MAX_ENTRIES): string[] {
  const valid = keys.filter((key): key is string => typeof key === 'string' && key.length > 0);
  const unique = [...new Set(valid)];
  return unique.length > max ? unique.slice(unique.length - max) : unique;
}

/**
 * 折叠起来的分组 key（`bot:Builder` 这种带维度前缀的稳定 key，全维度唯一，
 * 所以一份平铺的数组就够，不需要按维度分表）。
 * 坏 JSON 或压根不是数组 → null，让调用方走「全部展开」的默认；数组里混进
 * 非字符串只剔掉那一项，不为一颗老鼠屎丢掉整份记忆。
 */
export function loadWorkbenchCollapsedGroups(
  storage: WorkbenchStorage | null | undefined,
): string[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return pruneCollapsedGroups(parsed);
  } catch {
    return null;
  }
}

export function saveWorkbenchCollapsedGroups(
  storage: WorkbenchStorage | null | undefined,
  keys: Iterable<string>,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(pruneCollapsedGroups([...keys])));
    return true;
  } catch {
    return false;
  }
}
