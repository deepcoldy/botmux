export const WORKBENCH_MAIN_ROUTE = '#/agent-workbench';
export const WORKBENCH_DOCK_ROUTE = '#/agent-workbench-dock';
export const WORKBENCH_RAIL_DEFAULT = 300;
export const WORKBENCH_RAIL_MIN = 176;
export const WORKBENCH_RAIL_MAX = 460;
export const WORKBENCH_RAIL_COLLAPSED = 40;

export type WorkbenchSurface = 'main' | 'dock';
export type WorkbenchPaneKind = 'terminal' | 'web';
export type WorkbenchSplitAxis = 'horizontal' | 'vertical';
export type WorkbenchSessionGroup = 'needs-you' | 'active' | 'recent';

/** 列表分组维度。'status' 是默认，也是旧三组（待你处理/进行中/最近）的那套语义。 */
export type WorkbenchGroupDimension = 'status' | 'bot' | 'chat' | 'kind' | 'cli' | 'time';

/** 下拉里的六个维度，顺序即展示顺序。 */
export const WORKBENCH_GROUP_DIMENSIONS: readonly { value: WorkbenchGroupDimension; label: string }[] = [
  { value: 'status', label: '状态' },
  { value: 'bot', label: '机器人' },
  { value: 'chat', label: '会话位置' },
  { value: 'kind', label: '类型' },
  { value: 'cli', label: 'CLI' },
  { value: 'time', label: '活跃时间' },
];

export function isWorkbenchGroupDimension(value: unknown): value is WorkbenchGroupDimension {
  return typeof value === 'string' && WORKBENCH_GROUP_DIMENSIONS.some(option => option.value === value);
}

export interface WorkbenchPreviewDescriptor {
  path: string;
  registeredAt: string;
}

export interface WorkbenchSessionRow {
  sessionId: string;
  status: string;
  larkAppId?: string;
  botName?: string;
  cliId?: string;
  title?: string;
  workingDir?: string;
  repoName?: string;
  gitBranch?: string;
  spawnedAt?: number;
  lastMessageAt?: number;
  closedAt?: number;
  chatId?: string;
  chatType?: 'group' | 'p2p';
  chatDisplayName?: string;
  scope?: 'thread' | 'chat';
  feishuChatLink?: string;
  webPort?: number | null;
  proxyPort?: number;
  riffAccessUrl?: string;
  preview?: WorkbenchPreviewDescriptor | null;
  pendingRepo?: boolean;
  queued?: boolean;
  tuiPromptActive?: boolean;
  agentAttention?: { kind?: string; reason?: string; at?: number } | null;
  [key: string]: unknown;
}

export type WorkbenchPaneTree =
  | { type: 'pane'; id: string; pane: WorkbenchPaneKind }
  | {
      type: 'split';
      id: string;
      axis: WorkbenchSplitAxis;
      ratio: number;
      first: WorkbenchPaneTree;
      second: WorkbenchPaneTree;
    };

export interface WorkbenchLayoutState {
  version: 1;
  railWidth: number;
  railCollapsed: boolean;
  focus: WorkbenchPaneKind;
  paneMode: 'focus' | 'split';
  splitAxis: WorkbenchSplitAxis;
  splitRatio: number;
  chatRequested: boolean;
}

export interface ResponsiveWorkbenchLayout {
  mode: 'desktop' | 'mobile';
  step: 'full' | 'rail-collapsed' | 'focus' | 'chat-jump' | 'mobile-stack';
  railCollapsed: boolean;
  paneMode: 'focus' | 'split';
  chatMode: 'native-split' | 'jump';
}

export interface WorkbenchSessionGroups {
  'needs-you': WorkbenchSessionRow[];
  active: WorkbenchSessionRow[];
  recent: WorkbenchSessionRow[];
}

/** 一个渲染出来的分组。维度是动态的（机器人名 / 会话名 / CLI 都是数据里来的），
 *  所以组不再是固定三格，而是一串带 key 和中文标签的桶。`kind` 只区分「待你处理」
 *  和普通组——前者永远置顶且用高亮样式，后者一律中性。 */
export interface WorkbenchDynamicGroup {
  key: string;
  label: string;
  kind: 'needs-you' | 'plain';
  sessions: WorkbenchSessionRow[];
}

export type WorkbenchListItem =
  | {
      kind: 'header';
      key: string;
      /** 旧三分类，动态维度下只用于样式回退（行前状态点、分组头配色）。 */
      group: WorkbenchSessionGroup;
      /** 所属分组的稳定 key，动态维度下形如 `bot:Builder`。 */
      groupKey: string;
      label: string;
      count: number;
      isNeedsYou: boolean;
      /** 该组当前是折叠的：组头照常渲染，但它下面的会话行一个都不在列表里。 */
      collapsed?: boolean;
    }
  | {
      kind: 'session';
      key: string;
      group: WorkbenchSessionGroup;
      groupKey: string;
      label: string;
      isNeedsYou: boolean;
      session: WorkbenchSessionRow;
    };

export interface VirtualWindow {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
  positions: number[];
}

const ACTIVE_STATUSES = new Set(['starting', 'working', 'analyzing', 'active', 'idle', 'limited']);
const SESSION_ID_MAX = 512;

export function validWorkbenchSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= SESSION_ID_MAX
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function buildWorkbenchHash(surface: WorkbenchSurface, sessionId?: string): string {
  const base = surface === 'dock' ? WORKBENCH_DOCK_ROUTE : WORKBENCH_MAIN_ROUTE;
  return validWorkbenchSessionId(sessionId) ? `${base}/${encodeURIComponent(sessionId)}` : base;
}

export function parseWorkbenchHash(hash: string): { surface: WorkbenchSurface; sessionId: string | null } | null {
  const path = String(hash || '').split('?')[0].replace(/\/+$/, '');
  for (const [surface, base] of [['dock', WORKBENCH_DOCK_ROUTE], ['main', WORKBENCH_MAIN_ROUTE]] as const) {
    if (path === base) return { surface, sessionId: null };
    if (!path.startsWith(`${base}/`)) continue;
    const encoded = path.slice(base.length + 1);
    let sessionId: string;
    try { sessionId = decodeURIComponent(encoded); } catch { return null; }
    return validWorkbenchSessionId(sessionId) ? { surface, sessionId } : null;
  }
  return null;
}

/** Only the two Workbench routes may cross the H5 login page. */
export function safeWorkbenchReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/#')) return '/';
  const parsed = parseWorkbenchHash(value.slice(1));
  return parsed ? `/${buildWorkbenchHash(parsed.surface, parsed.sessionId ?? undefined)}` : '/';
}

export function clampRailWidth(value: number): number {
  if (!Number.isFinite(value)) return WORKBENCH_RAIL_DEFAULT;
  return Math.min(WORKBENCH_RAIL_MAX, Math.max(WORKBENCH_RAIL_MIN, Math.round(value)));
}

export function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(0.72, Math.max(0.28, Math.round(value * 1000) / 1000));
}

export function defaultWorkbenchLayout(): WorkbenchLayoutState {
  return {
    version: 1,
    railWidth: WORKBENCH_RAIL_DEFAULT,
    railCollapsed: false,
    focus: 'terminal',
    paneMode: 'focus',
    splitAxis: 'horizontal',
    splitRatio: 0.5,
    chatRequested: false,
  };
}

export function normalizeWorkbenchLayout(value: unknown): WorkbenchLayoutState {
  const fallback = defaultWorkbenchLayout();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const input = value as Partial<WorkbenchLayoutState>;
  return {
    version: 1,
    railWidth: clampRailWidth(Number(input.railWidth)),
    railCollapsed: input.railCollapsed === true,
    focus: input.focus === 'web' ? 'web' : 'terminal',
    paneMode: input.paneMode === 'split' ? 'split' : 'focus',
    splitAxis: input.splitAxis === 'vertical' ? 'vertical' : 'horizontal',
    splitRatio: clampSplitRatio(Number(input.splitRatio)),
    chatRequested: input.chatRequested === true,
  };
}

export function paneTreeForLayout(layout: WorkbenchLayoutState): WorkbenchPaneTree {
  if (layout.paneMode === 'focus') {
    return { type: 'pane', id: `pane-${layout.focus}`, pane: layout.focus };
  }
  return {
    type: 'split',
    id: 'split-terminal-web',
    axis: layout.splitAxis,
    ratio: clampSplitRatio(layout.splitRatio),
    first: { type: 'pane', id: 'pane-terminal', pane: 'terminal' },
    second: { type: 'pane', id: 'pane-web', pane: 'web' },
  };
}

export function isValidPaneTree(value: unknown): value is WorkbenchPaneTree {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const node = value as Partial<WorkbenchPaneTree> & Record<string, unknown>;
  if (node.type === 'pane') return node.pane === 'terminal' || node.pane === 'web';
  if (node.type !== 'split') return false;
  return (node.axis === 'horizontal' || node.axis === 'vertical')
    && Number.isFinite(node.ratio)
    && isValidPaneTree(node.first)
    && isValidPaneTree(node.second);
}

/**
 * Ordered 1280px degradation: collapse rail, then Focus, then native Chat jump.
 * Mobile is a fixed single-column page stack and never restores a split itself.
 */
export function deriveResponsiveWorkbenchLayout(
  viewportWidth: number,
  requested: WorkbenchLayoutState,
): ResponsiveWorkbenchLayout {
  // Below this the page stacks into a single paged surface. Keep it tight: a
  // ~600px Feishu column still reads fine as a plain list, and the page tabs
  // cost more room than they earn there.
  if (viewportWidth < 620) {
    return { mode: 'mobile', step: 'mobile-stack', railCollapsed: true, paneMode: 'focus', chatMode: 'jump' };
  }
  // The rail is the product, not a side panel: collapsing it automatically left
  // narrow windows showing an expand handle and nothing else. Width now decides
  // how much *else* fits (chat mode, split panes); whether the session list is
  // collapsed stays the user's own choice at every size.
  if (viewportWidth < 960) {
    return {
      mode: 'desktop',
      step: 'chat-jump',
      railCollapsed: requested.railCollapsed,
      paneMode: 'focus',
      chatMode: 'jump',
    };
  }
  if (viewportWidth < 1120) {
    return {
      mode: 'desktop',
      step: 'focus',
      railCollapsed: requested.railCollapsed,
      paneMode: 'focus',
      chatMode: 'native-split',
    };
  }
  if (viewportWidth < 1280) {
    return {
      mode: 'desktop',
      step: 'rail-collapsed',
      railCollapsed: requested.railCollapsed,
      paneMode: requested.paneMode,
      chatMode: 'native-split',
    };
  }
  return {
    mode: 'desktop',
    step: 'full',
    railCollapsed: requested.railCollapsed,
    paneMode: requested.paneMode,
    chatMode: 'native-split',
  };
}

export function attentionSummary(session: WorkbenchSessionRow): string | null {
  if (session.status === 'closed') return null;
  const explicit = String(session.agentAttention?.reason ?? '').trim();
  if (explicit) return explicit;
  if (session.agentAttention) return 'Agent 请求协助';
  if (session.pendingRepo) return '需要选择仓库';
  if (session.tuiPromptActive) return '终端有待确认的提示';
  if (session.queued) return '待启动';
  if (session.status === 'limited') return '用量已达上限';
  return null;
}

/** 会话类型徽标用的三分类。`null` = 数据不足（旧 daemon 既没给 scope 也没给
 *  chatType），此时不渲染徽标，而不是猜一个可能是错的标签。 */
export type WorkbenchSessionKind = 'thread' | 'group' | 'p2p';

export function workbenchSessionKind(session: WorkbenchSessionRow): WorkbenchSessionKind | null {
  if (session.chatType === 'p2p') return 'p2p';
  if (session.scope === 'thread') return 'thread';
  if (session.scope === 'chat') return 'group';
  return null;
}

/** `unread` 为真时，一个没有 attention 理由的会话也算「待你处理」——bot 刚回完话
 *  但你还没看。已关闭的会话不参与：它不会再有新回复。旧调用不传第二个参数，行为
 *  和以前完全一致。 */
export function classifyWorkbenchSession(session: WorkbenchSessionRow, unread = false): WorkbenchSessionGroup {
  if (attentionSummary(session)) return 'needs-you';
  if (unread && session.status !== 'closed') return 'needs-you';
  if (session.status !== 'closed' && session.status !== 'dormant' && ACTIVE_STATUSES.has(session.status)) return 'active';
  if (session.status !== 'closed' && session.status !== 'dormant') return 'active';
  return 'recent';
}

export function sessionActivityAt(session: WorkbenchSessionRow): number {
  const value = Number(session.agentAttention?.at ?? session.lastMessageAt ?? session.closedAt ?? session.spawnedAt ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function workbenchSessionTitle(session: WorkbenchSessionRow): string {
  return String(session.title ?? '').trim() || String(session.chatDisplayName ?? '').trim() || session.sessionId;
}

export function sessionSearchText(session: WorkbenchSessionRow): string {
  return [
    workbenchSessionTitle(session),
    session.sessionId,
    session.botName,
    session.cliId,
    session.repoName,
    session.workingDir,
    session.gitBranch,
    session.chatDisplayName,
    attentionSummary(session),
  ].filter(Boolean).join('\n').toLocaleLowerCase();
}

export function groupWorkbenchSessions(
  sessions: readonly WorkbenchSessionRow[],
  query = '',
): WorkbenchSessionGroups {
  const needle = query.trim().toLocaleLowerCase();
  const groups: WorkbenchSessionGroups = { 'needs-you': [], active: [], recent: [] };
  for (const session of sessions) {
    if (!validWorkbenchSessionId(session.sessionId)) continue;
    if (needle && !sessionSearchText(session).includes(needle)) continue;
    groups[classifyWorkbenchSession(session)].push(session);
  }
  for (const list of Object.values(groups) as WorkbenchSessionRow[][]) {
    list.sort((a, b) => sessionActivityAt(b) - sessionActivityAt(a) || a.sessionId.localeCompare(b.sessionId));
  }
  return groups;
}

const NEEDS_YOU_LABEL = '待你处理';

/** 旧三组的中文标签。status 维度沿用同一套 key（needs-you/active/recent），
 *  所以老的分组头配色和行前状态点在默认维度下完全不变。 */
const LEGACY_GROUP_LABEL: Record<WorkbenchSessionGroup, string> = {
  'needs-you': NEEDS_YOU_LABEL,
  active: '进行中',
  recent: '最近',
};

/** 会话类型徽标 → 分组标签，和 KIND_COPY 的文案保持一致。 */
const KIND_GROUP_LABEL: Record<WorkbenchSessionKind, string> = {
  thread: '话题',
  group: '群',
  p2p: '单聊',
};

const KIND_GROUP_ORDER = ['话题', '群', '单聊', '其他'] as const;
const TIME_GROUP_ORDER = ['今天', '昨天', '本周', '更早'] as const;

/** 固定语义顺序的维度：组之间的先后是语义决定的，不看活跃时间。
 *  bot/chat/cli 的组名是数据里的自由文本，没有语义顺序，按最新活跃降序排。 */
const FIXED_GROUP_ORDER: Partial<Record<WorkbenchGroupDimension, readonly string[]>> = {
  status: ['active', 'recent'],
  kind: KIND_GROUP_ORDER.map(label => `kind:${label}`),
  time: TIME_GROUP_ORDER.map(label => `time:${label}`),
};

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 当天零点（本地时区）。now 由调用方给，分桶结果才可预测、可测。 */
function startOfLocalDay(at: number): Date {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date;
}

interface TimeBucketBounds {
  today: number;
  yesterday: number;
  week: number;
}

function timeBucketBounds(now: number): TimeBucketBounds {
  const today = startOfLocalDay(now);
  // 用 setDate 而不是减固定毫秒：跨夏令时的那一天差一小时，会把「昨天」整体错位。
  const yesterday = startOfLocalDay(now);
  yesterday.setDate(yesterday.getDate() - 1);
  // 「本周」= 含今天在内的最近 7 个自然日，比按周一切更贴近「最近还在动」的直觉。
  const week = startOfLocalDay(now);
  week.setDate(week.getDate() - 6);
  return { today: today.getTime(), yesterday: yesterday.getTime(), week: week.getTime() };
}

function timeGroupLabel(activityAt: number, bounds: TimeBucketBounds): string {
  if (!(activityAt > 0)) return '更早';
  if (activityAt >= bounds.today) return '今天';
  if (activityAt >= bounds.yesterday) return '昨天';
  if (activityAt >= bounds.week) return '本周';
  return '更早';
}

/** 一个会话在某个维度下落进哪个桶。key 带维度前缀，避免和 needs-you/active/recent
 *  这些保留 key 撞车（真有机器人叫「active」也不会串组）。 */
function sessionBucket(
  session: WorkbenchSessionRow,
  dimension: WorkbenchGroupDimension,
  bounds: TimeBucketBounds,
): { key: string; label: string } {
  switch (dimension) {
    case 'bot': {
      const label = trimmed(session.botName) || '未知机器人';
      return { key: `bot:${label}`, label };
    }
    case 'chat': {
      const label = trimmed(session.chatDisplayName) || trimmed(session.chatId) || '未知会话';
      return { key: `chat:${label}`, label };
    }
    case 'kind': {
      const kind = workbenchSessionKind(session);
      const label = kind ? KIND_GROUP_LABEL[kind] : '其他';
      return { key: `kind:${label}`, label };
    }
    case 'cli': {
      const label = trimmed(session.cliId) || 'unknown';
      return { key: `cli:${label}`, label };
    }
    case 'time': {
      const label = timeGroupLabel(sessionActivityAt(session), bounds);
      return { key: `time:${label}`, label };
    }
    case 'status':
    default: {
      // 沿用旧分类：关闭/休眠进「最近」，其余都在「进行中」。
      const group: WorkbenchSessionGroup = classifyWorkbenchSession(session) === 'recent' ? 'recent' : 'active';
      return { key: group, label: LEGACY_GROUP_LABEL[group] };
    }
  }
}

function byActivityDesc(a: WorkbenchSessionRow, b: WorkbenchSessionRow): number {
  return sessionActivityAt(b) - sessionActivityAt(a) || a.sessionId.localeCompare(b.sessionId);
}

export interface WorkbenchGroupingOptions {
  query?: string;
  dimension: WorkbenchGroupDimension;
  /** 未读会话 id。它们和 attention 会话一起被抽进置顶的「待你处理」。 */
  unreadIds?: ReadonlySet<string>;
  /** 时间维度分桶的基准时刻，由调用方传入（组件里就是那一帧的 now）。 */
  now?: number;
}

/**
 * 按维度分组：先抽「待你处理」置顶，剩下的按维度分桶。
 * 空桶不产出——动态维度下的组本来就是数据长出来的，一个「0 个会话」的组头只是噪音。
 */
export function groupWorkbenchSessionsForDimension(
  sessions: readonly WorkbenchSessionRow[],
  options: WorkbenchGroupingOptions,
): WorkbenchDynamicGroup[] {
  const needle = String(options.query ?? '').trim().toLocaleLowerCase();
  const unreadIds = options.unreadIds;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const bounds = timeBucketBounds(now);
  const dimension = isWorkbenchGroupDimension(options.dimension) ? options.dimension : 'status';

  const needsYou: WorkbenchSessionRow[] = [];
  const buckets = new Map<string, WorkbenchDynamicGroup>();
  for (const session of sessions) {
    if (!validWorkbenchSessionId(session.sessionId)) continue;
    if (needle && !sessionSearchText(session).includes(needle)) continue;
    const unread = unreadIds?.has(session.sessionId) === true;
    if (classifyWorkbenchSession(session, unread) === 'needs-you') {
      needsYou.push(session);
      continue;
    }
    const bucket = sessionBucket(session, dimension, bounds);
    const existing = buckets.get(bucket.key);
    if (existing) existing.sessions.push(session);
    else buckets.set(bucket.key, { key: bucket.key, label: bucket.label, kind: 'plain', sessions: [session] });
  }

  const order = FIXED_GROUP_ORDER[dimension];
  const plain = [...buckets.values()];
  if (order) {
    plain.sort((a, b) => {
      const left = order.indexOf(a.key);
      const right = order.indexOf(b.key);
      return (left < 0 ? order.length : left) - (right < 0 ? order.length : right)
        || a.label.localeCompare(b.label);
    });
  } else {
    // 自由文本维度：最近有人干活的组排前面，组内也是最新在上。
    const freshness = new Map(plain.map(group => [
      group.key,
      group.sessions.reduce((latest, session) => Math.max(latest, sessionActivityAt(session)), 0),
    ]));
    plain.sort((a, b) => (freshness.get(b.key) ?? 0) - (freshness.get(a.key) ?? 0) || a.label.localeCompare(b.label));
  }
  for (const group of plain) group.sessions.sort(byActivityDesc);

  const groups: WorkbenchDynamicGroup[] = [];
  if (needsYou.length > 0) {
    needsYou.sort(byActivityDesc);
    groups.push({ key: 'needs-you', label: NEEDS_YOU_LABEL, kind: 'needs-you', sessions: needsYou });
  }
  groups.push(...plain);
  return groups;
}

function legacyGroupsToDynamic(groups: WorkbenchSessionGroups): WorkbenchDynamicGroup[] {
  return (['needs-you', 'active', 'recent'] as const).map(group => ({
    key: group,
    label: LEGACY_GROUP_LABEL[group],
    kind: group === 'needs-you' ? ('needs-you' as const) : ('plain' as const),
    sessions: groups[group],
  }));
}

/** 行前状态点/分组头配色仍按旧三分类走：动态维度下一个会话该显示什么颜色的点，
 *  取决于它自己的状态，而不是它被分到了哪个桶。 */
function legacyGroupOf(group: WorkbenchDynamicGroup, session?: WorkbenchSessionRow): WorkbenchSessionGroup {
  if (group.kind === 'needs-you') return 'needs-you';
  if (session) return classifyWorkbenchSession(session);
  return group.key === 'recent' ? 'recent' : 'active';
}

/**
 * 三组记录和动态组都能拍平；旧调用（dock、脚本、测试）传前者，行为不变。
 * `collapsedKeys` 命中的组只留一个组头——会话行不进列表，虚拟滚动的总高度就跟着
 * 缩回去，这是折叠真正省下滚动距离的地方。组头上的 count 仍是折叠前的真实条数。
 */
export function flattenWorkbenchGroups(
  groups: WorkbenchSessionGroups | readonly WorkbenchDynamicGroup[],
  collapsedKeys?: ReadonlySet<string>,
): WorkbenchListItem[] {
  const dynamic = Array.isArray(groups)
    ? (groups as readonly WorkbenchDynamicGroup[])
    : legacyGroupsToDynamic(groups as WorkbenchSessionGroups);
  const items: WorkbenchListItem[] = [];
  for (const group of dynamic) {
    const isNeedsYou = group.kind === 'needs-you';
    const collapsed = collapsedKeys?.has(group.key) === true;
    items.push({
      kind: 'header',
      key: `header-${group.key}`,
      group: legacyGroupOf(group),
      groupKey: group.key,
      label: group.label,
      count: group.sessions.length,
      isNeedsYou,
      collapsed,
    });
    if (collapsed) continue;
    for (const session of group.sessions) {
      items.push({
        kind: 'session',
        key: `${group.key}-${session.sessionId}`,
        group: legacyGroupOf(group, session),
        groupKey: group.key,
        label: group.label,
        isNeedsYou,
        session,
      });
    }
  }
  return items;
}

/** Must match the CSS row height exactly — virtualisation positions rows from
 *  this number, and any disagreement makes the list scroll past its own end.
 *  Touch layouts use taller rows for 44px targets, so the measurement is passed
 *  in rather than assumed.
 *  桌面 54px 与 style.css 的 `.wb-session-row { height: 54px }` 一一对应；触屏
 *  84px 对应 620px 断点里的那条。改一处必须同时改另一处。 */
export function workbenchListItemHeight(item: WorkbenchListItem, touch = false): number {
  if (item.kind === 'header') return 30;
  return touch ? 84 : 54;
}

export function computeVirtualWindow(
  items: readonly WorkbenchListItem[],
  scrollTop: number,
  viewportHeight: number,
  overscanPx = 240,
  touch = false,
): VirtualWindow {
  const positions = new Array<number>(items.length + 1);
  positions[0] = 0;
  for (let index = 0; index < items.length; index += 1) {
    positions[index + 1] = positions[index] + workbenchListItemHeight(items[index], touch);
  }
  const totalHeight = positions[items.length] ?? 0;
  const from = Math.max(0, Number.isFinite(scrollTop) ? scrollTop - overscanPx : 0);
  const to = Math.min(totalHeight, Math.max(0, scrollTop) + Math.max(0, viewportHeight) + overscanPx);
  let start = 0;
  while (start < items.length && positions[start + 1] < from) start += 1;
  let end = start;
  while (end < items.length && positions[end] <= to) end += 1;
  return { start, end, offsetTop: positions[start] ?? 0, totalHeight, positions };
}

export function formatWorkbenchRelativeTime(epochMs: number, nowMs = Date.now(), locale = 'en'): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '—';
  const deltaSeconds = Math.round((epochMs - nowMs) / 1000);
  const absolute = Math.abs(deltaSeconds);
  if (absolute < 45) return locale.toLowerCase().startsWith('zh') ? '刚刚' : 'just now';
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 24 * 60 * 60],
    ['month', 30 * 24 * 60 * 60],
    ['day', 24 * 60 * 60],
    ['hour', 60 * 60],
    ['minute', 60],
  ];
  const [unit, seconds] = units.find(([, threshold]) => absolute >= threshold) ?? ['minute', 60];
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })
    .format(Math.round(deltaSeconds / seconds), unit);
}

export interface WorkbenchTerminalLocation {
  protocol: string;
  origin: string;
  hostname: string;
}

export function workbenchTerminalHref(
  session: WorkbenchSessionRow,
  location: WorkbenchTerminalLocation | null,
): string | null {
  const external = workbenchExternalTerminalHref(session);
  if (external) return external;
  if (!session.webPort || !session.proxyPort || !location) return null;
  // All Workbench terminals use the same-origin central front proxy. That hop
  // strips browser credentials and injects the short signed read/write grant;
  // dialing proxyPort directly on HTTP would bypass it and make takeover a
  // silent no-op at the worker.
  return `${location.origin}/s/${encodeURIComponent(session.sessionId)}`;
}

/** Session metadata may originate in another daemon. Treat external URLs and
 * preview descriptors as untrusted at the final DOM boundary. */
export function workbenchExternalTerminalHref(session: WorkbenchSessionRow): string | null {
  if (typeof session.riffAccessUrl !== 'string' || session.riffAccessUrl.length > 2_048) return null;
  try {
    const url = new URL(session.riffAccessUrl);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function workbenchPreviewHref(session: WorkbenchSessionRow): string | null {
  const path = session.preview?.path;
  if (typeof path !== 'string' || path.length > 2_048) return null;
  const expected = `/preview/${encodeURIComponent(session.sessionId)}/`;
  return path === expected ? path : null;
}
