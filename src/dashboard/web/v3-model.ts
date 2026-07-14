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

export const V3_DECISION_LABEL: Record<string, string> = {
  exit: '✓ 通过',
  continue: '↻ 继续返工',
  exhausted: '⛔ 轮数耗尽',
};

export const V3_GRAPH = {
  nodeWidth: 168,
  plainHeight: 48,
  loopHeight: 70,
  columnGap: 226,
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
  return status === 'succeeded' || status === 'failed';
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
  live: boolean;
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
      });
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
