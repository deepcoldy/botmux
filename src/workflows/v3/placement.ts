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
 * The same three entry points also refuse a checkpoint nothing depends on
 * (design §13.6, {@link v3CheckpointsWithoutDependants}): the main bot is
 * woken only while the run still goes on, so a checkpoint that is the last
 * node to finish would end the run without anybody looking at it.
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

/** Why a checkpoint without dependants is refused, and what to do instead. */
const V3_CHECKPOINT_WITHOUT_DEPENDANTS = '检查点后面没有节点，主 Bot 不会被叫来；去掉这个标记，或在后面加一个汇总节点';

/**
 * Top-level goal nodes marked `checkpoint: true` that no top-level node
 * depends on. Such a checkpoint holds nothing: when it is the last node to
 * finish the run ends at once, and the main bot is only woken while a run is
 * still running or blocked — the mark would silently do nothing. Checked
 * after the Architect, at approval and on runtime edits of bot-executed runs
 * only (the mark has no effect on temporary workers), never when an existing
 * run, journal or saved template is read.
 */
export function v3CheckpointsWithoutDependants(dag: Pick<V3Dag, 'nodes'>): string[] {
  const dependedOn = new Set(dag.nodes.flatMap((node) => node.depends.map((dep) => dep.from)));
  return dag.nodes
    .filter((node) => isGoalNode(node) && node.checkpoint === true && !dependedOn.has(node.id))
    .map((node) => node.id);
}

/** One refusal line per checkpoint without dependants. */
export function v3CheckpointProblems(nodeIds: Iterable<string>): string[] {
  return [...nodeIds].map((nodeId) => `节点 ${nodeId}：${V3_CHECKPOINT_WITHOUT_DEPENDANTS}`);
}

/** Does `node` start only after EVERY node it depends on has finished?
 *  Exactly when its join needs all of them (the scheduler's `required` is at
 *  least the in-degree): all_success (a conditional `when` edge included:
 *  it still waits for its source), a one_success with a single source, a
 *  quorum equal to the in-degree. A smaller one_success / quorum may start as
 *  soon as some of its sources are done — the rest may still run. */
export function v3JoinPreservesOrder(node: Pick<V3Node, 'triggerRule' | 'depends'> | undefined): boolean {
  const rule = node?.triggerRule;
  if (rule === undefined || rule === 'all_success') return true;
  const required = rule === 'one_success' ? 1 : rule.quorum;
  return required >= (node?.depends.length ?? 0);
}

function describeTriggerRule(node: Pick<V3Node, 'triggerRule' | 'depends'> | undefined): string {
  const rule = node?.triggerRule;
  return typeof rule === 'object' && rule ? `quorum ${rule.quorum}` : String(rule ?? 'all_success');
}

/**
 * Every node that is guaranteed to have finished before each node starts
 * (top-level graph): a `depends` ancestor reached only through joins that
 * wait for all their sources — the node itself and every join on the path
 * all_success (§5.2 rule 1). A one_success / quorum join breaks the chain:
 * it may start while one of its sources still runs.
 */
export function v3OrderedAncestorSets(dag: Pick<V3Dag, 'nodes'>): Map<string, Set<string>> {
  const byId = new Map(dag.nodes.map((node) => [node.id, node]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, stack: Set<string>): Set<string> => {
    const known = memo.get(id);
    if (known) return known;
    const out = new Set<string>();
    if (stack.has(id)) return out; // validateDag rejects cycles; never loop here
    stack.add(id);
    const node = byId.get(id);
    if (v3JoinPreservesOrder(node)) {
      for (const dep of node?.depends ?? []) {
        out.add(dep.from);
        for (const up of visit(dep.from, stack)) out.add(up);
      }
    }
    stack.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const node of dag.nodes) visit(node.id, new Set());
  return memo;
}

/** Plain `depends` reachability (whatever the joins). Pass it to
 *  {@link v3OrderingBreak} when asking about many pairs of one DAG. */
export function v3ReachableAncestorSets(dag: Pick<V3Dag, 'nodes'>): Map<string, Set<string>> {
  const byId = new Map(dag.nodes.map((node) => [node.id, node]));
  const out = new Map<string, Set<string>>();
  for (const node of dag.nodes) {
    const seen = new Set<string>();
    const stack = [...node.depends.map((dep) => dep.from)];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const dep of byId.get(next)?.depends ?? []) stack.push(dep.from);
    }
    out.set(node.id, seen);
  }
  return out;
}

/**
 * Why `ancestor` is reachable from `node` through `depends` but not
 * guaranteed to finish first: the join (`node` itself or one on the path)
 * whose trigger rule lets it start early. Undefined when not reachable.
 */
export function v3OrderingBreak(
  dag: Pick<V3Dag, 'nodes'>,
  ancestor: string,
  node: string,
  reachable?: ReadonlyMap<string, ReadonlySet<string>>,
): { joinId: string; rule: string } | undefined {
  const byId = new Map(dag.nodes.map((candidate) => [candidate.id, candidate]));
  const reach = reachable ?? v3ReachableAncestorSets(dag);
  if (!reach.get(node)?.has(ancestor)) return undefined;
  for (const joinId of [node, ...[...(reach.get(node) ?? [])].sort()]) {
    const join = byId.get(joinId);
    if (v3JoinPreservesOrder(join)) continue;
    const viaJoin = joinId === node || reach.get(node)?.has(joinId);
    if (viaJoin && reach.get(joinId)?.has(ancestor)) return { joinId, rule: describeTriggerRule(join) };
  }
  return undefined;
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
  /** Why `a` and `b` are linked by `depends` yet not ordered (default: read
   *  from `dag`); appended to the refusal. */
  explainUnordered?: (a: string, b: string) => { joinId: string; rule: string; first: string } | undefined;
}): V3PlacementProblem[] {
  // A bot is named by its display name, the app id kept beside it.
  const nameOf = (appId: string): string => {
    const name = input.nameOf?.(appId);
    return name && name !== appId ? `${name}（${appId}）` : appId;
  };
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

  const ancestors = v3OrderedAncestorSets(input.dag);
  let reach: Map<string, Set<string>> | undefined;
  const explain = input.explainUnordered ?? ((a: string, b: string) => {
    reach ??= v3ReachableAncestorSets(input.dag);
    const ab = v3OrderingBreak(input.dag, a, b, reach);
    if (ab) return { ...ab, first: a };
    const ba = v3OrderingBreak(input.dag, b, a, reach);
    return ba ? { ...ba, first: b } : undefined;
  });
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
        const why = explain(a, b);
        const because = why
          ? `（${why.joinId} 的触发规则是 ${why.rule}，${why.first} 不一定先于它结束）`
          : '';
        problems.push({
          rule: self ? 2 : 1,
          nodeIds: [a, b],
          larkAppId: appId,
          message: self
            ? `落点硬规则 2：节点 ${a} 和 ${b} 都由主 Bot 自己在主话题执行，也就是都在主会话里跑，`
              + `但两者没有先后依赖、可能同时运行${because}；请让一个依赖另一个（经过的汇合节点都要等全部上游结束），或把其中一个改成节点话题`
            : `落点硬规则 1：节点 ${a} 和 ${b} 都交给 ${nameOf(appId)} 在主话题执行，`
              + `它在主话题里只有一个会话，但两者没有先后依赖、可能同时运行${because}；请让一个依赖另一个（经过的汇合节点都要等全部上游结束），或把其中一个改成节点话题`,
        });
      }
    }
  }
  return problems;
}

/**
 * §5.2 rule 2 × §15.4: the main bot's own main-topic nodes run IN the main
 * session, and that session already runs in its own directory (it was
 * started when `/workflow` was sent). A frozen node working directory other
 * than that one can never be honoured for them — the runtime blocks such a
 * node with WORKING_DIR_REFUSED — so every entry that freezes the directory
 * or makes a node one of them refuses it up front, through this one check.
 *
 * `nodes`: the nodes to judge, each with the bot that will execute it and its
 * placement (an entry passes only the nodes it is responsible for: Gate-2 all
 * of them, a runtime change the ones it turns into this kind). Both
 * directories are in comparison form (`comparableSessionDir`), compared as
 * strings. `mainSessionDir` undefined = unknown: nothing is refused here and
 * the runtime gate stays the only check. Pure.
 */
export function v3MainSessionDirProblem(input: {
  nodes: Iterable<{ nodeId: string; larkAppId: string; placement?: V3NodePlacement }>;
  mainLarkAppId: string;
  workingDir: string | undefined;
  mainSessionDir: string | undefined;
}): string | undefined {
  const { workingDir, mainSessionDir } = input;
  if (workingDir === undefined || mainSessionDir === undefined || workingDir === mainSessionDir) return undefined;
  const nodeIds = [...input.nodes]
    .filter((node) => node.placement === 'main' && node.larkAppId === input.mainLarkAppId)
    .map((node) => node.nodeId);
  if (nodeIds.length === 0) return undefined;
  return `节点 ${nodeIds.join('、')} 由主 Bot 自己在主话题执行，工作目录 ${workingDir} 不是主会话的目录：`
    + `主 Bot 自己在主话题执行的节点只能在主会话的目录 ${mainSessionDir} 里跑；`
    + `把节点改成节点话题，或不指定工作目录，或指定为 ${mainSessionDir}`;
}
