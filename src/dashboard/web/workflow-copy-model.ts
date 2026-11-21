/**
 * 基于历史创建（design 2026-11-03 workflow-dashboard-orchestration §6，D6）
 * 页面上的纯逻辑：来源说明、改目标的两个选项、哪些编辑能做。页面按钮的禁用
 * 只是展示，daemon 会再校验（§7.2）。
 */
import type { WorkflowDraftView } from '../../workflows/v3/draft-service.js';
import type { V3Dag, V3Node } from '../../workflows/v3/dag.js';
import type { V3Gate2BotPlanRow } from '../../workflows/v3/bot-assignment.js';

export type DraftCopyView = NonNullable<WorkflowDraftView['copy']>;

/** 「复制自 …」那一行的文案键与参数。 */
export function copySourceLine(copy: Pick<DraftCopyView, 'source'>): { key: string; params: Record<string, string | number> } {
  return copy.source.kind === 'run'
    ? { key: 'workflow.copy.fromRun', params: { runId: copy.source.runId } }
    : { key: 'workflow.copy.fromTemplate', params: { name: copy.source.displayName, version: copy.source.humanVersion } };
}

/** 改目标：「只改文字」，或「按新目标重新编排」（先重新澄清 / 直接重新编排）。 */
export type CopyGoalChoice = { kind: 'text_only' } | { kind: 'reorchestrate'; reclarify: boolean };

export function copyGoalMode(choice: CopyGoalChoice): 'text_only' | 'rearchitect' | 'reclarify' {
  if (choice.kind === 'text_only') return 'text_only';
  return choice.reclarify ? 'reclarify' : 'rearchitect';
}

/** 改目标只在复制出来、还在「待确认需求」的草稿上，由发起人做。 */
export function canEditCopyGoal(view: Pick<WorkflowDraftView, 'phase' | 'copy' | 'launch'>, isInitiator: boolean): boolean {
  return isInitiator && !!view.copy && view.phase === 'spec_ready' && !view.launch;
}

/** 改节点目标 / 完成标准：复制出来的草稿在「待确认流程 / 已确认流程」、还没拉群。 */
export function canEditCopyNodes(view: Pick<WorkflowDraftView, 'phase' | 'copy' | 'launch'>, isInitiator: boolean): boolean {
  return isInitiator && !!view.copy && (view.phase === 'dag_ready' || view.phase === 'flow_confirmed') && !view.launch;
}

/** 还没换成具体内容的参数名（拉群开始会被拒）。 */
export function copyUnresolvedNames(copy: Pick<DraftCopyView, 'unresolved'> | undefined): string[] {
  if (!copy?.unresolved) return [];
  return [...copy.unresolved.params, ...copy.unresolved.context.map((name) => `context.${name}`)];
}

/** 复制来的流程的节点数（循环体内的任务节点也算）。 */
export function copyNodeCount(nodes: readonly V3Node[]): number {
  return nodes.reduce((count, node) => count + 1 + (node.type === 'loop' && node.body ? node.body.nodes.length : 0), 0);
}

/** 流程图上每个任务节点的执行 Bot（预览用，与模板详情页同一口径）。 */
export function copyGraphRows(dag: Pick<V3Dag, 'nodes'>, orchestratorAppId: string, nameOf: (appId: string) => string): V3Gate2BotPlanRow[] {
  const rows: V3Gate2BotPlanRow[] = [];
  const visit = (nodes: readonly V3Node[], prefix: string, inherited?: string) => {
    for (const node of nodes) {
      const id = prefix ? `${prefix}.${node.id}` : node.id;
      const bot = node.bot ?? inherited ?? orchestratorAppId;
      if (node.type === 'loop' && node.body) visit(node.body.nodes, id, bot);
      else if (node.type !== 'host') rows.push({ nodeId: id, larkAppId: bot, name: nameOf(bot), main: bot === orchestratorAppId });
    }
  };
  visit(dag.nodes, '');
  return rows;
}

/** 一个任务节点现在的目标与完成标准（`override.systemPromptAppend`）。 */
export function copyNodeText(dag: Pick<V3Dag, 'nodes'>, nodeId: string): { goal: string; completion: string } | undefined {
  const find = (nodes: readonly V3Node[], prefix: string): V3Node | undefined => {
    for (const node of nodes) {
      const id = prefix ? `${prefix}.${node.id}` : node.id;
      if (id === nodeId && (node.type === undefined || node.type === 'goal')) return node;
      if (node.type === 'loop' && node.body) {
        const hit = find(node.body.nodes, id);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  const node = find(dag.nodes, '');
  return node ? { goal: node.goal ?? '', completion: node.override?.systemPromptAppend ?? '' } : undefined;
}
