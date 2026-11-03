import type { RunNodeView, RunView } from '../../workflows/v3/ops-projection.js';

export const V3_POLL_MS = 2000;

export const V3_NODE_LABEL: Record<RunNodeView['status'], string> = {
  pending: '待机',
  gateWaiting: '等审批',
  running: '运行中',
  done: '完成',
  skipped: '已跳过',
  cancelled: '已取消',
  blocked: '受阻',
  superseded: '已刷新',
  failed: '失败',
};

/**
 * The five states people read a workflow by, plus the three "this path did
 * not run" states. Gate waits and blocked nodes both need a person, so they
 * share one bucket; the node panel still names the precise raw state.
 */
export type V3DisplayStatus =
  | 'waiting'
  | 'running'
  | 'done'
  | 'failed'
  | 'needsHuman'
  | 'skipped'
  | 'cancelled'
  | 'superseded';

export const V3_DISPLAY_STATUS: Record<RunNodeView['status'], V3DisplayStatus> = {
  pending: 'waiting',
  running: 'running',
  done: 'done',
  failed: 'failed',
  gateWaiting: 'needsHuman',
  blocked: 'needsHuman',
  skipped: 'skipped',
  cancelled: 'cancelled',
  superseded: 'superseded',
};

export const V3_DISPLAY_LABEL: Record<V3DisplayStatus, string> = {
  waiting: '等待',
  running: '进行中',
  done: '完成',
  failed: '失败',
  needsHuman: '等人工确认',
  skipped: '已跳过',
  cancelled: '已取消',
  superseded: '已替代',
};

/** Legend order: the five states first, then the not-run states. */
export const V3_DISPLAY_LEGEND: V3DisplayStatus[] = [
  'waiting', 'running', 'done', 'failed', 'needsHuman', 'skipped', 'cancelled',
];

export const V3_ATTEMPT_OUTCOME_LABEL: Record<string, string> = {
  succeeded: '完成',
  failed: '失败',
  blocked: '受阻',
  cancelled: '已取消',
  interrupted: '中断',
  superseded: '已替代',
};

/** Compact duration for an SVG node row: 45秒 / 6分 / 1时20分 / 2天3时. */
export function formatV3Duration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}分`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return minutes ? `${totalHours}时${minutes}分` : `${totalHours}时`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours ? `${days}天${hours}时` : `${days}天`;
}

/** How long the node has been working (running) or worked (finished), measured
 *  on the server clock carried by the view. Undefined when it never started. */
export function nodeElapsedMs(node: RunNodeView, generatedAt: number): number | undefined {
  if (node.startedAt === undefined) return undefined;
  const end = node.endedAt ?? (node.status === 'running' ? generatedAt : undefined);
  return end === undefined ? undefined : Math.max(0, end - node.startedAt);
}

/** How long a person has been needed: gate wait, or time since it blocked. */
export function nodeWaitingMs(node: RunNodeView, generatedAt: number): number | undefined {
  const since = node.status === 'gateWaiting'
    ? node.gateSince
    : node.status === 'blocked' ? node.endedAt : undefined;
  return since === undefined ? undefined : Math.max(0, generatedAt - since);
}

/** Third row of a graph node: display state, then elapsed / attempt count. */
export function nodeStatusLine(node: RunNodeView, generatedAt: number | undefined): string {
  const label = V3_DISPLAY_LABEL[V3_DISPLAY_STATUS[node.status]];
  const parts = [label];
  if (node.status === 'gateWaiting') parts.push('审批');
  else if (node.status === 'blocked') parts.push('受阻');
  if (generatedAt !== undefined) {
    const elapsed = nodeElapsedMs(node, generatedAt);
    if (elapsed !== undefined && (node.status === 'running' || node.status === 'done' || node.status === 'failed')) {
      parts.push(formatV3Duration(elapsed));
    }
  }
  if (node.attempts.length > 1 && node.status !== 'pending') parts.push(`第${node.attempts.length}次`);
  return parts.join(' · ');
}

/** Second row of a graph node: who executes it. */
export function nodeBotLine(node: RunNodeView): string {
  if (node.host) return `宿主动作 · ${node.host.executor}`;
  const bot = node.bot;
  if (!bot) return '';
  const who = bot.name ?? bot.larkAppId ?? bot.selector ?? '默认 Bot';
  return bot.cliId ? `${who} · ${bot.cliId}` : who;
}

export const V3_DECISION_LABEL: Record<string, string> = {
  exit: '✓ 通过',
  continue: '↻ 继续返工',
  exhausted: '⛔ 轮数耗尽',
};

export const V3_GRAPH = {
  nodeWidth: 196,
  plainHeight: 66,
  loopHeight: 70,
  columnGap: 254,
  verticalGap: 30,
  padding: 26,
  maxDots: 8,
} as const;

const MINI = {
  width: 104,
  height: 30,
  columnGap: 138,
  rowGap: 42,
  padding: 6,
} as const;

export function isTerminalRunStatus(status: RunView['runStatus'] | undefined): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

export function v3RunIdFromHash(hash = typeof location !== 'undefined' ? location.hash : ''): string | null {
  const m = hash.match(/^#\/workflows\/([^?#]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

export function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function nodeHeight(node: RunNodeView): number {
  return node.isLoop ? V3_GRAPH.loopHeight : V3_GRAPH.plainHeight;
}

export function graphNodes(view: RunView): RunNodeView[] {
  return view.nodes.filter((node) => !node.loop);
}

export interface V3GraphNodeLayout {
  node: RunNodeView;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface V3GraphEdgeLayout {
  fromId: string;
  toId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mx: number;
  /** Vertical layouts only: the curve's vertical midpoint (edges run top → bottom). */
  my?: number;
  live: boolean;
  /** Edge exists only in a pending (unconfirmed) flow revision. */
  pending: boolean;
}

export interface V3GraphLayout {
  width: number;
  height: number;
  nodes: V3GraphNodeLayout[];
  edges: V3GraphEdgeLayout[];
}

export function buildGraphLayout(view: RunView): V3GraphLayout {
  const nodes = graphNodes(view);
  const depthOf = computeDepth(nodes);
  const byDepth = new Map<number, RunNodeView[]>();
  for (const node of nodes) {
    const depth = depthOf.get(node.id) ?? 0;
    const bucket = byDepth.get(depth);
    if (bucket) bucket.push(node);
    else byDepth.set(depth, [node]);
  }

  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const laidOutNodes: V3GraphNodeLayout[] = [];
  const pos = new Map<string, V3GraphNodeLayout>();
  let height = 0;
  for (const depth of depths) {
    const column = byDepth.get(depth) ?? [];
    let y = V3_GRAPH.padding;
    for (const node of column) {
      const box = {
        node,
        x: V3_GRAPH.padding + depth * V3_GRAPH.columnGap,
        y,
        width: V3_GRAPH.nodeWidth,
        height: nodeHeight(node),
      };
      laidOutNodes.push(box);
      pos.set(node.id, box);
      y += box.height + V3_GRAPH.verticalGap;
    }
    height = Math.max(height, y - V3_GRAPH.verticalGap + V3_GRAPH.padding);
  }

  const width = V3_GRAPH.padding * 2 + (depths.length === 0 ? 0 : Math.max(...depths) * V3_GRAPH.columnGap + V3_GRAPH.nodeWidth);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: V3GraphEdgeLayout[] = [];
  for (const node of nodes) {
    const to = pos.get(node.id);
    if (!to) continue;
    for (const dep of node.depends) {
      const from = pos.get(dep);
      const fromNode = byId.get(dep);
      if (!from || !fromNode) continue;
      const x1 = from.x + V3_GRAPH.nodeWidth;
      const y1 = from.y + nodeHeight(fromNode) / 2;
      const x2 = to.x;
      const y2 = to.y + nodeHeight(node) / 2;
      edges.push({
        fromId: dep,
        toId: node.id,
        x1,
        y1,
        x2,
        y2,
        mx: (x1 + x2) / 2,
        live: node.status === 'running',
        pending: node.pendingChange === 'add',
      });
    }
  }

  return { width, height, nodes: laidOutNodes, edges };
}

/** Spacing of the sidebar's top-to-bottom layout (design §11.4, 350–800px). */
export const V3_VERTICAL_GRAPH = {
  padding: 10,
  horizontalGap: 10,
  verticalGap: 34,
  /** Three parallel nodes still fit the narrowest (350px) sidebar's graph area. */
  minNodeWidth: 88,
} as const;

/**
 * Top-to-bottom variant of {@link buildGraphLayout} for the Feishu sidebar
 * (350–800px wide): one row per depth, rows centered, a uniform box width that
 * shrinks to fit the widest row into `containerWidth` (never below
 * `minNodeWidth` — a wider row scrolls sideways instead of becoming unreadable).
 */
export function buildVerticalGraphLayout(view: RunView, containerWidth: number): V3GraphLayout {
  const nodes = graphNodes(view);
  const depthOf = computeDepth(nodes);
  const byDepth = new Map<number, RunNodeView[]>();
  for (const node of nodes) {
    const depth = depthOf.get(node.id) ?? 0;
    const bucket = byDepth.get(depth);
    if (bucket) bucket.push(node);
    else byDepth.set(depth, [node]);
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  const G = V3_VERTICAL_GRAPH;
  const widest = Math.max(1, ...depths.map((depth) => byDepth.get(depth)!.length));
  const avail = Math.max(G.minNodeWidth, Math.floor(containerWidth) - G.padding * 2);
  const nodeWidth = Math.max(
    G.minNodeWidth,
    Math.min(V3_GRAPH.nodeWidth, Math.floor((avail - (widest - 1) * G.horizontalGap) / widest)),
  );
  const rowWidth = (count: number) => count * nodeWidth + Math.max(0, count - 1) * G.horizontalGap;
  const width = Math.max(Math.floor(containerWidth), G.padding * 2 + rowWidth(widest));

  const laidOutNodes: V3GraphNodeLayout[] = [];
  const pos = new Map<string, V3GraphNodeLayout>();
  let y = G.padding;
  for (const depth of depths) {
    const row = byDepth.get(depth)!;
    let x = Math.round((width - rowWidth(row.length)) / 2);
    let rowHeight = 0;
    for (const node of row) {
      const box = { node, x, y, width: nodeWidth, height: nodeHeight(node) };
      laidOutNodes.push(box);
      pos.set(node.id, box);
      x += nodeWidth + G.horizontalGap;
      rowHeight = Math.max(rowHeight, box.height);
    }
    y += rowHeight + G.verticalGap;
  }
  const height = depths.length ? y - G.verticalGap + G.padding : G.padding * 2;

  const edges: V3GraphEdgeLayout[] = [];
  for (const node of nodes) {
    const to = pos.get(node.id);
    if (!to) continue;
    for (const dep of node.depends) {
      const from = pos.get(dep);
      if (!from) continue;
      const x1 = from.x + from.width / 2;
      const y1 = from.y + from.height;
      const x2 = to.x + to.width / 2;
      const y2 = to.y;
      edges.push({ fromId: dep, toId: node.id, x1, y1, x2, y2, mx: (x1 + x2) / 2, my: (y1 + y2) / 2, live: node.status === 'running', pending: node.pendingChange === 'add' });
    }
  }
  return { width, height, nodes: laidOutNodes, edges };
}

export function computeDepth(nodes: RunNodeView[]): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  function depth(id: string): number {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const node = byId.get(id);
    const deps = (node?.depends ?? []).filter((dep) => byId.has(dep));
    const value = deps.length ? 1 + Math.max(...deps.map(depth)) : 0;
    visiting.delete(id);
    memo.set(id, value);
    return value;
  }

  for (const node of nodes) depth(node.id);
  return memo;
}

export function loopInstances(view: RunView | null | undefined, loopId: string): RunNodeView[] {
  return (view?.nodes ?? []).filter((node) => node.loop?.loopId === loopId);
}

export function resolveLoopTerminalNode(instances: RunNodeView[], pinnedId: string | null, pinned: boolean): RunNodeView | null {
  if (pinned && pinnedId) {
    const node = instances.find((instance) => instance.id === pinnedId);
    if (node) return node;
  }
  const running = instances.filter((instance) => instance.status === 'running');
  return running[running.length - 1] ?? instances[instances.length - 1] ?? null;
}

export interface V3LoopRound {
  iteration: number;
  instances: RunNodeView[];
}

export function loopRounds(instances: RunNodeView[]): V3LoopRound[] {
  const byIter = new Map<number, RunNodeView[]>();
  for (const instance of instances) {
    const iteration = instance.loop?.iteration;
    if (iteration === undefined) continue;
    const bucket = byIter.get(iteration);
    if (bucket) bucket.push(instance);
    else byIter.set(iteration, [instance]);
  }
  return [...byIter.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([iteration, roundInstances]) => ({ iteration, instances: roundInstances }));
}

export function loopBudget(node: RunNodeView): number | undefined {
  const maxIterations = node.loopState?.maxIterations;
  return node.loopState && maxIterations !== undefined
    ? maxIterations + node.loopState.granted
    : undefined;
}

export interface V3MiniDagNodeLayout {
  templateId: string;
  node: RunNodeView | undefined;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface V3MiniDagEdgeLayout {
  fromId: string;
  toId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  mx: number;
  live: boolean;
}

export interface V3MiniDagLayout {
  width: number;
  height: number;
  nodes: V3MiniDagNodeLayout[];
  edges: V3MiniDagEdgeLayout[];
}

export function buildRoundMiniDagLayout(
  template: Array<{ id: string; depends: string[] }>,
  instanceByBodyId: Map<string, RunNodeView>,
): V3MiniDagLayout {
  const templateById = new Map(template.map((node) => [node.id, node]));
  const memo = new Map<string, number>();

  function depth(id: string): number {
    if (memo.has(id)) return memo.get(id)!;
    memo.set(id, 0);
    const deps = (templateById.get(id)?.depends ?? []).filter((dep) => templateById.has(dep));
    const value = deps.length ? 1 + Math.max(...deps.map(depth)) : 0;
    memo.set(id, value);
    return value;
  }

  const rowByDepth = new Map<number, number>();
  let maxRow = 0;
  const nodes: V3MiniDagNodeLayout[] = [];
  const pos = new Map<string, V3MiniDagNodeLayout>();
  for (const item of template) {
    const d = depth(item.id);
    const row = rowByDepth.get(d) ?? 0;
    rowByDepth.set(d, row + 1);
    maxRow = Math.max(maxRow, row);
    const box = {
      templateId: item.id,
      node: instanceByBodyId.get(item.id),
      x: MINI.padding + d * MINI.columnGap,
      y: MINI.padding + row * MINI.rowGap,
      width: MINI.width,
      height: MINI.height,
    };
    nodes.push(box);
    pos.set(item.id, box);
  }

  const maxDepth = memo.size ? Math.max(...memo.values()) : 0;
  const edges: V3MiniDagEdgeLayout[] = [];
  for (const item of template) {
    const to = pos.get(item.id);
    if (!to) continue;
    for (const dep of item.depends) {
      const from = pos.get(dep);
      if (!from) continue;
      const x1 = from.x + MINI.width;
      const y1 = from.y + MINI.height / 2;
      const x2 = to.x;
      const y2 = to.y + MINI.height / 2;
      edges.push({
        fromId: dep,
        toId: item.id,
        x1,
        y1,
        x2,
        y2,
        mx: (x1 + x2) / 2,
        live: instanceByBodyId.get(item.id)?.status === 'running',
      });
    }
  }

  return {
    width: MINI.padding * 2 + (template.length ? maxDepth * MINI.columnGap + MINI.width : 0),
    height: MINI.padding * 2 + maxRow * MINI.rowGap + MINI.height,
    nodes,
    edges,
  };
}

/** Graph badge for a node a runtime flow revision added / changed, or one a
 *  pending proposal would add / remove / change (design §13.7). */
export function nodeRevisionBadge(node: RunNodeView): string | undefined {
  if (node.pendingChange === 'add') return '待确认 · 新增';
  if (node.pendingChange === 'remove') return '待确认 · 删除';
  if (node.pendingChange === 'change') return '待确认 · 修改';
  if (node.revisionMark === 'added') return '新增';
  if (node.revisionMark === 'changed') return '已修改';
  return undefined;
}

/** One-character form of {@link nodeRevisionBadge} for a box too narrow for
 *  the full badge (the box styling still tells add / remove / change apart). */
function nodeRevisionMark(node: RunNodeView): string | undefined {
  if (node.pendingChange) return '待';
  if (node.revisionMark === 'added') return '新';
  if (node.revisionMark === 'changed') return '改';
  return undefined;
}

/** Text geometry of a plain node box's first line: the id at `inset`, the
 *  badge right-aligned `badgeInset` from the edge. Width estimates are upper
 *  bounds: the id is 12px monospace (0.6em per character); the badge is 10px,
 *  CJK at 1em and anything else at most 0.6em. */
export const V3_NODE_HEADING = {
  inset: 14,
  badgeInset: 10,
  gap: 6,
  idCharPx: 7.2,
  /** Below this many id characters beside the full badge, use the short one. */
  minIdChars: 8,
} as const;

function badgeWidthPx(text: string): number {
  let px = 0;
  for (const ch of text) px += /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 10 : 6;
  return px;
}

/**
 * The first line of a node box: how many id characters fit, and which badge
 * goes beside them. The id gets whatever the box width leaves after the
 * badge, so the two never overlap; when the full badge would squeeze the id
 * below a readable share, a one-character mark replaces it and the full text
 * moves to the node's tooltip. `plainIdChars` is the id budget without a badge.
 */
export function nodeBoxHeading(
  node: RunNodeView,
  boxWidth: number,
  plainIdChars: number,
): { idChars: number; badge?: string; badgeTitle?: string } {
  const full = nodeRevisionBadge(node);
  if (!full) return { idChars: plainIdChars };
  const H = V3_NODE_HEADING;
  const room = (badge: string) =>
    Math.floor((boxWidth - H.inset - H.badgeInset - H.gap - badgeWidthPx(badge)) / H.idCharPx);
  if (room(full) >= Math.min(node.id.length, H.minIdChars)) {
    return { idChars: Math.max(1, Math.min(plainIdChars, room(full))), badge: full };
  }
  const short = nodeRevisionMark(node) ?? full;
  return { idChars: Math.max(1, Math.min(plainIdChars, room(short))), badge: short, badgeTitle: full };
}

export const V3_REVISION_ROLE_LABEL: Record<NonNullable<RunView['revision']>['history'][number]['by'], string> = {
  mainBot: '主 Bot',
  initiator: '发起人',
  other: '其他成员',
};

export const V3_REVISION_STATE_LABEL: Record<NonNullable<RunView['revision']>['history'][number]['state'], string> = {
  applied: '已生效',
  pending: '待确认',
  rejected: '未生效',
};
