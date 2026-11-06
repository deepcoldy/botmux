/**
 * Agent ↔ Bot 关联图的纯布局。卡片定高，所以纵向坐标完全由数据决定，不依赖 DOM 测量；
 * 横向由 CSS 三列网格负责，连线 SVG 只占中间列并用 0..100 的归一化横坐标
 * （preserveAspectRatio="none" + non-scaling-stroke），列宽变化时无需重算。
 *
 * 排列规则：每个 Agent 一个分段，分段内 Agent 卡片顶对齐，其关联 Bot 依次排在右侧，
 * 因此连线互不交叉；未关联（或关联到已不存在 Agent）的 Bot 统一放在最后的「独立配置」段。
 */

export interface AgentGraphMetrics {
  agentHeight: number;
  botHeight: number;
  /** 同一分段内相邻 Bot 卡片的间距。 */
  rowGap: number;
  /** 分段之间的间距。 */
  groupGap: number;
  /** 「独立配置」段标题占用的高度。 */
  unlinkedHeaderHeight: number;
}

export const DEFAULT_AGENT_GRAPH_METRICS: AgentGraphMetrics = {
  agentHeight: 108,
  botHeight: 64,
  rowGap: 10,
  groupGap: 28,
  unlinkedHeaderHeight: 30,
};

export interface AgentGraphNode {
  id: string;
  y: number;
  height: number;
}

export interface AgentGraphBotNode extends AgentGraphNode {
  /** 生效的关联；null = 独立配置。 */
  agentId: string | null;
}

export interface AgentGraphEdge {
  agentId: string;
  botId: string;
  /** 起点（Agent 端口）纵坐标。 */
  y1: number;
  /** 终点（Bot 卡片左缘中点）纵坐标。 */
  y2: number;
}

export interface AgentGraphLayout {
  height: number;
  agents: AgentGraphNode[];
  bots: AgentGraphBotNode[];
  edges: AgentGraphEdge[];
  /** 「独立配置」段标题的纵坐标；没有独立 Bot 时为 null。 */
  unlinkedTop: number | null;
}

/** Agent 卡片上连线端口的纵向位置（相对卡片顶部）。与 CSS 的 `.ag-port` 对齐。 */
export function agentPortOffset(metrics: AgentGraphMetrics): number {
  return metrics.agentHeight / 2;
}

export function layoutAgentGraph(
  agents: readonly { id: string }[],
  bots: readonly { larkAppId: string }[],
  links: Readonly<Record<string, string>>,
  metrics: AgentGraphMetrics = DEFAULT_AGENT_GRAPH_METRICS,
): AgentGraphLayout {
  const agentIds = new Set(agents.map(agent => agent.id));
  const effective = (appId: string): string | null => {
    const id = links[appId];
    return id && agentIds.has(id) ? id : null;
  };
  const stack = (count: number, height: number) => (count ? count * height + (count - 1) * metrics.rowGap : 0);

  const outAgents: AgentGraphNode[] = [];
  const outBots: AgentGraphBotNode[] = [];
  const edges: AgentGraphEdge[] = [];
  let y = 0;
  let blocks = 0;

  for (const agent of agents) {
    if (blocks > 0) y += metrics.groupGap;
    const group = bots.filter(bot => effective(bot.larkAppId) === agent.id);
    outAgents.push({ id: agent.id, y, height: metrics.agentHeight });
    const portY = y + agentPortOffset(metrics);
    group.forEach((bot, index) => {
      const botY = y + index * (metrics.botHeight + metrics.rowGap);
      outBots.push({ id: bot.larkAppId, y: botY, height: metrics.botHeight, agentId: agent.id });
      edges.push({ agentId: agent.id, botId: bot.larkAppId, y1: portY, y2: botY + metrics.botHeight / 2 });
    });
    y += Math.max(metrics.agentHeight, stack(group.length, metrics.botHeight));
    blocks++;
  }

  const unlinked = bots.filter(bot => effective(bot.larkAppId) === null);
  let unlinkedTop: number | null = null;
  if (unlinked.length) {
    if (blocks > 0) y += metrics.groupGap;
    unlinkedTop = y;
    y += metrics.unlinkedHeaderHeight;
    unlinked.forEach((bot, index) => {
      outBots.push({
        id: bot.larkAppId,
        y: y + index * (metrics.botHeight + metrics.rowGap),
        height: metrics.botHeight,
        agentId: null,
      });
    });
    y += stack(unlinked.length, metrics.botHeight);
  }

  return { height: y, agents: outAgents, bots: outBots, edges, unlinkedTop };
}

/** 归一化横坐标（0 = Agent 端口，100 = Bot 左缘）下的三次贝塞尔路径。 */
export function edgePath(y1: number, y2: number, x2 = 100): string {
  const mid = x2 / 2;
  return `M0,${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
}
