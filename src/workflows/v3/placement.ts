/**
 * Where a bot-executed run hands each goal node off (design 2026-11-03 §5.1,
 * D2) and the three hard rules every placement must satisfy (§5.2). The rules
 * are checked by code, never left to the model: after the Architect writes the
 * DAG, at `approve-dag`, and on every runtime flow edit.
 *
 * 1. In the main topic, two nodes of the same executing bot may never run at
 *    the same time: one must be an ancestor of the other. Sessions are keyed
 *    by bot × topic, so one bot has exactly one session in the main topic.
 * 2. The main bot's own main-topic nodes run in the main session itself:
 *    rule 1 with the main bot as the executing bot (reported as its own rule
 *    so the message says what is special about it).
 * 3. Without a main topic there is no `main` placement: the run has no topic
 *    root, or its main session is the chat-wide session of a normal group
 *    (P4). Private chats never reach bot execution at all.
 *
 * Pure: the caller resolves who executes each node and whether the run has a
 * main topic. Part of workflow-core (no IO, no daemon imports).
 */

import { isGoalNode, type V3Dag, type V3Node } from './dag.js';

export type V3NodePlacement = 'topic' | 'main';

/** A node's effective placement (absent = `topic`). */
export function v3NodePlacement(node: Pick<V3Node, 'type' | 'placement'> | undefined): V3NodePlacement {
  return node?.type === 'goal' && node.placement === 'main' ? 'main' : 'topic';
}

/** Whether the run's main topic can host `main` nodes (rule 3). */
export type V3MainTopicAvailability =
  | { available: true }
  /** `why`: one plain-language reason (no topic root, chat-wide session,
   *  main session unreadable). */
  | { available: false; why: string };

export interface V3PlacementProblem {
  rule: 1 | 2 | 3;
  nodeIds: string[];
  /** The executing bot the conflict is about (rules 1 and 2). */
  larkAppId?: string;
  message: string;
}

/** Every transitive `depends` ancestor of each node (top-level graph). */
function ancestorSets(dag: V3Dag): Map<string, Set<string>> {
  const byId = new Map(dag.nodes.map((node) => [node.id, node]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, stack: Set<string>): Set<string> => {
    const known = memo.get(id);
    if (known) return known;
    const out = new Set<string>();
    if (stack.has(id)) return out; // validateDag rejects cycles; never loop here
    stack.add(id);
    for (const dep of byId.get(id)?.depends ?? []) {
      out.add(dep.from);
      for (const up of visit(dep.from, stack)) out.add(up);
    }
    stack.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const node of dag.nodes) visit(node.id, new Set());
  return memo;
}

/**
 * The §5.2 hard-rule violations of `dag`'s placements, one entry per
 * conflicting pair (rules 1 and 2) and one for rule 3.
 *
 * `executorOf` names the bot that will execute a top-level goal node (its
 * larkAppId; an unresolvable selector may be returned as-is — it only has to
 * tell bots apart). `mainTopic` absent skips rule 3 (the caller checks it
 * where it knows the main session); `rule3Nodes` limits rule 3 to the nodes
 * whose placement a runtime edit just made `main` — placements that already
 * took effect passed it when they did, and the main session's shape cannot
 * change during a run.
 */
export function v3PlacementProblems(input: {
  dag: V3Dag;
  mainLarkAppId: string;
  executorOf: (nodeId: string) => string;
  mainTopic?: V3MainTopicAvailability;
  rule3Nodes?: ReadonlySet<string>;
  nameOf?: (larkAppId: string) => string;
}): V3PlacementProblem[] {
  const nameOf = input.nameOf ?? ((appId: string) => appId);
  const mainNodes = input.dag.nodes.filter((node) => isGoalNode(node) && v3NodePlacement(node) === 'main');
  const problems: V3PlacementProblem[] = [];
  if (mainNodes.length === 0) return problems;

  if (input.mainTopic && !input.mainTopic.available) {
    const affected = mainNodes.map((node) => node.id).filter((id) => !input.rule3Nodes || input.rule3Nodes.has(id));
    if (affected.length > 0) {
      problems.push({
        rule: 3,
        nodeIds: affected,
        message: `落点硬规则 3：这个 run 没有可用的主话题（${input.mainTopic.why}），`
          + `节点 ${affected.join('、')} 不能放主话题，请改成节点话题（placement 去掉或写 "topic"）`,
      });
    }
  }

  const ancestors = ancestorSets(input.dag);
  const byBot = new Map<string, string[]>();
  for (const node of mainNodes) {
    const appId = input.executorOf(node.id);
    byBot.set(appId, [...(byBot.get(appId) ?? []), node.id]);
  }
  for (const [appId, nodeIds] of byBot) {
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        const a = nodeIds[i]!;
        const b = nodeIds[j]!;
        if (ancestors.get(a)?.has(b) || ancestors.get(b)?.has(a)) continue;
        const self = appId === input.mainLarkAppId;
        problems.push({
          rule: self ? 2 : 1,
          nodeIds: [a, b],
          larkAppId: appId,
          message: self
            ? `落点硬规则 2：节点 ${a} 和 ${b} 都由主 Bot 自己在主话题执行，也就是都在主会话里跑，`
              + '但两者没有先后依赖、可能同时运行；请让一个依赖另一个，或把其中一个改成节点话题'
            : `落点硬规则 1：节点 ${a} 和 ${b} 都交给 ${nameOf(appId)} 在主话题执行，`
              + `它在主话题里只有一个会话，但两者没有先后依赖、可能同时运行；请让一个依赖另一个，或把其中一个改成节点话题`,
        });
      }
    }
  }
  return problems;
}
