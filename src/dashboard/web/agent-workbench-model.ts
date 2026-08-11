export const WORKBENCH_MAIN_ROUTE = '#/agent-workbench';
export const WORKBENCH_DOCK_ROUTE = '#/agent-workbench-dock';
export const WORKBENCH_RAIL_DEFAULT = 200;
export const WORKBENCH_RAIL_MIN = 176;
export const WORKBENCH_RAIL_MAX = 280;
export const WORKBENCH_RAIL_COLLAPSED = 40;

export type WorkbenchSurface = 'main' | 'dock';
export type WorkbenchPaneKind = 'terminal' | 'web';
export type WorkbenchSplitAxis = 'horizontal' | 'vertical';
export type WorkbenchSessionGroup = 'needs-you' | 'active' | 'recent';

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

export type WorkbenchListItem =
  | { kind: 'header'; key: string; group: WorkbenchSessionGroup; count: number }
  | { kind: 'session'; key: string; group: WorkbenchSessionGroup; session: WorkbenchSessionRow };

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
  if (viewportWidth < 768) {
    return { mode: 'mobile', step: 'mobile-stack', railCollapsed: true, paneMode: 'focus', chatMode: 'jump' };
  }
  if (viewportWidth < 960) {
    return { mode: 'desktop', step: 'chat-jump', railCollapsed: true, paneMode: 'focus', chatMode: 'jump' };
  }
  if (viewportWidth < 1120) {
    return { mode: 'desktop', step: 'focus', railCollapsed: true, paneMode: 'focus', chatMode: 'native-split' };
  }
  if (viewportWidth < 1280) {
    return {
      mode: 'desktop',
      step: 'rail-collapsed',
      railCollapsed: true,
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
  if (session.agentAttention) return 'Agent requested help';
  if (session.pendingRepo) return 'Choose a repository';
  if (session.tuiPromptActive) return 'Answer the terminal prompt';
  if (session.queued) return 'Ready to start';
  if (session.status === 'limited') return 'Usage limit reached';
  return null;
}

export function classifyWorkbenchSession(session: WorkbenchSessionRow): WorkbenchSessionGroup {
  if (attentionSummary(session)) return 'needs-you';
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

export function flattenWorkbenchGroups(groups: WorkbenchSessionGroups): WorkbenchListItem[] {
  const items: WorkbenchListItem[] = [];
  for (const group of ['needs-you', 'active', 'recent'] as const) {
    const sessions = groups[group];
    items.push({ kind: 'header', key: `header-${group}`, group, count: sessions.length });
    for (const session of sessions) {
      items.push({ kind: 'session', key: `${group}-${session.sessionId}`, group, session });
    }
  }
  return items;
}

export function workbenchListItemHeight(item: WorkbenchListItem): number {
  return item.kind === 'header' ? 30 : 62;
}

export function computeVirtualWindow(
  items: readonly WorkbenchListItem[],
  scrollTop: number,
  viewportHeight: number,
  overscanPx = 240,
): VirtualWindow {
  const positions = new Array<number>(items.length + 1);
  positions[0] = 0;
  for (let index = 0; index < items.length; index += 1) {
    positions[index + 1] = positions[index] + workbenchListItemHeight(items[index]);
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
  if (!session.webPort || !location) return null;
  if (location.protocol === 'https:') {
    return session.proxyPort ? `${location.origin}/s/${encodeURIComponent(session.sessionId)}` : null;
  }
  const port = session.proxyPort ?? session.webPort;
  const suffix = session.proxyPort ? `/s/${encodeURIComponent(session.sessionId)}` : '';
  return `http://${location.hostname}:${port}${suffix}`;
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
