/**
 * Who executes a run's goal nodes (design 2026-11-03 §6, D1/D3, P4).
 *
 * The experimental switch `workflow.nodeExecutor` is read once, when a run is
 * authorized (Gate-2 `approve-dag`, or Saved Workflow materialization), and the
 * outcome is frozen into `run.json` as `nodeExecutor: "bot"`. Everything here
 * is decided before that write; nothing in this module is consulted by a run
 * that is already authorized.
 *
 * Kept out of the host-neutral runtime graph (workflow-core): it knows about
 * chats, threads and bot membership, all of which are host concerns. Live
 * probes (Lark membership, daemon discovery, chat grants) are injected.
 */

import type { BotSnapshot } from './contract.js';
import { isGoalNode, isLoopNode, type V3Dag } from './dag.js';
import type { RunChatBinding } from './grill-state.js';
import { v3OrderedAncestorSets, v3OrderingBreak, v3ReachableAncestorSets, v3PlacementProblems, type V3MainTopicAvailability } from './placement.js';
import type { V3HandoffIdentityRecord, V3HandoffIdentityTool, V3HandoffIdentityUnavailableReason } from './run-envelope.js';

export type V3NodeExecutorSwitch = 'ephemeral' | 'bot';

/** Why a run stays on temporary workers although the switch says `bot`. */
export type V3EphemeralReason =
  | 'switch_off'
  | 'no_chat_binding'
  | 'not_group_chat'
  | 'no_thread_root'
  | 'multi_topic_disabled';

export type V3NodeExecutorDecision =
  | { mode: 'bot' }
  | { mode: 'ephemeral'; reason: V3EphemeralReason };

/**
 * PR 5a places every node in its own topic (§5.1 `topic`), so a bot run needs
 * a group chat, a thread root for the run (the main topic the progress and
 * blocked cards live in), and the machine-wide multi-topic switch (§6.1 item
 * 5). A private chat cannot host other bots at all (P4).
 */
export function decideV3NodeExecutor(input: {
  switchMode: V3NodeExecutorSwitch;
  binding: RunChatBinding | undefined;
  multiTopicEnabled: boolean;
}): V3NodeExecutorDecision {
  if (input.switchMode !== 'bot') return { mode: 'ephemeral', reason: 'switch_off' };
  const binding = input.binding;
  if (!binding?.larkAppId || !binding.chatId) return { mode: 'ephemeral', reason: 'no_chat_binding' };
  if (binding.chatType !== 'group') return { mode: 'ephemeral', reason: 'not_group_chat' };
  if (!binding.rootMessageId) return { mode: 'ephemeral', reason: 'no_thread_root' };
  if (!input.multiTopicEnabled) return { mode: 'ephemeral', reason: 'multi_topic_disabled' };
  return { mode: 'bot' };
}

const EPHEMERAL_REASON_TEXT: Record<Exclude<V3EphemeralReason, 'switch_off'>, string> = {
  no_chat_binding: '这个 run 不是在群聊里发起的，没有可以交接的群',
  not_group_chat: '私聊里其他 Bot 进不来，节点没法交给群里的 Bot',
  no_thread_root: '这个 run 没有主话题根，节点话题无处挂靠',
  multi_topic_disabled: '本机关闭了「多话题协作」，不能为节点开话题',
};

/** One user-facing line for an ephemeral decision; `undefined` when the
 *  switch is simply off (nothing to explain — that is today's behaviour). */
export function describeV3EphemeralFallback(decision: V3NodeExecutorDecision): string | undefined {
  if (decision.mode !== 'ephemeral' || decision.reason === 'switch_off') return undefined;
  return `「节点交给群里的 Bot 执行」已开启，但本次仍用临时进程执行节点：${EPHEMERAL_REASON_TEXT[decision.reason]}。`;
}

/**
 * §5.2 hard rule 3: can this run's main topic host `main` nodes? Only when
 * the run is anchored at a topic root AND its main session is that topic's
 * own session. A normal group whose main bot keeps one chat-wide session
 * (P4) has a root to reply under, but its main session is not in it: every
 * node there gets a node topic. `mainSession` is the persisted row of
 * `binding.sessionId` (undefined = not found / unreadable).
 */
export function v3MainTopicAvailability(
  binding: RunChatBinding | undefined,
  mainSession: { scope?: 'thread' | 'chat'; rootMessageId?: string | null } | undefined,
): V3MainTopicAvailability {
  if (!binding?.chatId || !binding.rootMessageId) return { available: false, why: '这个 run 没有主话题根' };
  if (binding.chatType !== 'group') return { available: false, why: '这个 run 不在群聊里' };
  if (!binding.sessionId || !mainSession) return { available: false, why: '查不到主会话，无法确认它在不在话题里' };
  if ((mainSession.scope ?? 'thread') !== 'thread') {
    return { available: false, why: '主 Bot 在本群是「整群一个会话」，主会话不在话题里' };
  }
  if (mainSession.rootMessageId !== binding.rootMessageId) {
    return { available: false, why: '主会话不在这个 run 的主话题里' };
  }
  return { available: true };
}

export interface V3NodeExecutorTarget {
  /** Authored goal node id, or `<loopId>.<bodyNodeId>` for a loop body. */
  nodeId: string;
  /** The bot that will execute it (the frozen snapshot's app id). */
  larkAppId: string;
  /** Set for a loop body node (authored ids may themselves contain dots). */
  loop?: { loopId: string; bodyNodeId: string };
  /** Declared outputs of kind `directory`: a bot cannot submit a directory
   *  (`botmux report --output` carries files), so such a node can never
   *  complete when handed to a bot. */
  directoryOutputs?: string[];
  /** §5.1: set only for a top-level goal node handed off in the main topic. */
  placement?: 'main';
  /** With `placement`: why a `depends` ancestor is NOT among `ancestors`
   *  (a one_success / quorum join lets the node start before it ends). */
  unorderedAncestors?: Array<{ nodeId: string; joinId: string; rule: string }>;
  /** With `placement`: the node's transitive `depends` ancestors (top-level
   *  ids), so the §5.2 hard rules can be checked from the targets alone. */
  ancestors?: string[];
}

function directoryOutputsOf(outputs: Record<string, { kind: string }> | undefined): string[] | undefined {
  const keys = Object.entries(outputs ?? {}).filter(([, declaration]) => declaration.kind === 'directory').map(([key]) => key);
  return keys.length > 0 ? keys : undefined;
}

/**
 * Node → executing bot exactly as the runtime will resolve it: the frozen
 * snapshot keyed by the node's `bot` selector ('' = default, which approve-dag
 * freezes to the main bot). Loop bodies inherit the loop's selector.
 */
export function v3BotExecutorTargets(
  dag: V3Dag,
  snapshots: ReadonlyMap<string, BotSnapshot>,
): V3NodeExecutorTarget[] {
  const out: V3NodeExecutorTarget[] = [];
  const targetOf = (selector: string | undefined, nodeId: string): string => {
    const snapshot = snapshots.get(selector ?? '');
    if (!snapshot) throw new Error(`v3 node executor: no frozen bot for node "${nodeId}"`);
    return snapshot.larkAppId;
  };
  const withOutputs = (target: V3NodeExecutorTarget, outputs: Record<string, { kind: string }> | undefined) => {
    const directoryOutputs = directoryOutputsOf(outputs);
    return directoryOutputs ? { ...target, directoryOutputs } : target;
  };
  // §5.2: only ancestors guaranteed to finish first (all_success joins on
  // the whole path) order two main-topic nodes; the same rule as placement.ts.
  const ordered = v3OrderedAncestorSets(dag);
  const main = dag.nodes.filter((node) => isGoalNode(node) && node.placement === 'main');
  // The explanation is only needed for a pair that conflicts (same executor,
  // linked by `depends` yet unordered); computed once per DAG, not per pair.
  const executorOfMain = new Map(main.map((node) => [node.id, isGoalNode(node) ? targetOf(node.bot, node.id) : undefined]));
  let reach: Map<string, Set<string>> | undefined;
  for (const node of dag.nodes) {
    if (isGoalNode(node)) {
      const target = withOutputs({ nodeId: node.id, larkAppId: targetOf(node.bot, node.id) }, node.outputs);
      if (node.placement !== 'main') {
        out.push(target);
        continue;
      }
      const unorderedAncestors = main.flatMap(({ id: other }) => {
        if (other === node.id || ordered.get(node.id)?.has(other)) return [];
        if (executorOfMain.get(other) !== executorOfMain.get(node.id)) return [];
        reach ??= v3ReachableAncestorSets(dag);
        const why = v3OrderingBreak(dag, other, node.id, reach);
        return why ? [{ nodeId: other, ...why }] : [];
      });
      out.push({
        ...target,
        placement: 'main',
        ancestors: [...(ordered.get(node.id) ?? [])].sort(),
        ...(unorderedAncestors.length > 0 ? { unorderedAncestors } : {}),
      });
    }
    if (isLoopNode(node)) {
      for (const body of node.body.nodes) {
        const nodeId = `${node.id}.${body.id}`;
        out.push(withOutputs({
          nodeId,
          larkAppId: targetOf(body.bot ?? node.bot, nodeId),
          loop: { loopId: node.id, bodyNodeId: body.id },
        }, body.outputs));
      }
    }
  }
  return out;
}

/**
 * §5.2 hard rules over the frozen targets (who executes each node is already
 * resolved): rules 1–2 from the `ancestors` the main targets carry, rule 3
 * against `mainTopic`. Messages say which rule; empty = fine.
 */
export function v3TargetPlacementProblems(input: {
  targets: readonly V3NodeExecutorTarget[];
  orchestratorAppId: string;
  mainTopic: V3MainTopicAvailability;
  nameOf?: (larkAppId: string) => string;
}): string[] {
  const main = input.targets.filter((target) => target.placement === 'main' && !target.loop);
  if (main.length === 0) return [];
  const executor = new Map(main.map((target) => [target.nodeId, target.larkAppId]));
  return v3PlacementProblems({
    dag: {
      runId: 'placement-check',
      nodes: main.map((target) => ({
        id: target.nodeId,
        type: 'goal' as const,
        goal: target.nodeId,
        placement: 'main' as const,
        // Ancestors are already transitive: direct edges to them suffice.
        depends: (target.ancestors ?? []).map((from) => ({ from })),
        inputs: [],
      })),
    },
    mainLarkAppId: input.orchestratorAppId,
    executorOf: (nodeId) => executor.get(nodeId) ?? input.orchestratorAppId,
    explainUnordered: (a, b) => {
      const find = (later: string, first: string) =>
        main.find((target) => target.nodeId === later)?.unorderedAncestors?.find((entry) => entry.nodeId === first);
      const ab = find(b, a);
      if (ab) return { joinId: ab.joinId, rule: ab.rule, first: a };
      const ba = find(a, b);
      return ba ? { joinId: ba.joinId, rule: ba.rule, first: b } : undefined;
    },
    mainTopic: input.mainTopic,
    ...(input.nameOf ? { nameOf: input.nameOf } : {}),
  }).map((problem) => problem.message);
}

/** The refusal text when placements break the §5.2 hard rules. */
export function formatV3PlacementRefusal(problems: readonly string[]): string {
  return [
    '节点落点不满足硬规则，已拒绝批准：',
    ...problems.map((problem) => `- ${problem}`),
    '把相关节点改成节点话题或调整依赖后重试（即兴 run 可用 revise-dag 让 Architect 重排）。',
  ].join('\n');
}

export type V3BotEligibilityCode =
  | 'BOT_NOT_CONFIGURED'
  | 'BOT_NOT_IN_CHAT'
  | 'BOT_OFFLINE'
  | 'COLLABORATION_DENIED'
  | 'MEMBERSHIP_UNKNOWN'
  /** §6.1 item 7: in this normal group the bot folds topic replies into one
   *  group-wide session, so it can never run (or submit from) a node topic. */
  | 'NO_TOPIC_SESSION'
  | 'TOPIC_SESSION_UNKNOWN'
  /** The node declares a directory output, which a bot cannot submit. */
  | 'DIRECTORY_OUTPUT'
  /** `approve-dag --working-dir` lies outside this bot's configured
   *  directory range (design §15.4). */
  | 'WORKING_DIR_OUT_OF_RANGE'
  /** `approve-dag --working-dir`, but this bot configures no directory. */
  | 'WORKING_DIR_NO_RANGE';

export interface V3BotEligibilityProblem {
  nodeId: string;
  larkAppId: string;
  code: V3BotEligibilityCode;
  detail?: string;
}

/** Live facts about one candidate bot; implemented against Lark + the local
 *  daemon registry in production, faked in tests. */
export interface V3BotEligibilityProbe {
  /** §6.1 item 1: configured in this deployment's bots.json. */
  isConfigured(larkAppId: string): boolean;
  /** §6.1 item 3: its daemon is online on this host. */
  isDaemonOnline(larkAppId: string): boolean;
  /** §6.1 item 2: a current member of the run's chat (`unknown` = could not
   *  be determined; refused, never assumed). */
  inChat(larkAppId: string): Promise<'yes' | 'no' | { unknown: string }>;
  /** §6.1 item 7: whether a reply in a node topic of this chat reaches this
   *  bot as its own topic session (`no` = it folds into the group session). */
  opensTopicSessions(larkAppId: string): Promise<'yes' | 'no' | { unknown: string }>;
  /** §6.1 item 4: establish (idempotently) the talk-only chat grant between
   *  the main bot and this bot, the same matrix `dispatch --bot-app` writes.
   *  Throws with a readable message when it cannot. */
  ensureGrant(larkAppId: string): Promise<void>;
}

/**
 * Gate-2 / Saved-Workflow eligibility (§6.3): every distinct target bot other
 * than the main bot must satisfy §6.1 items 1–4. The main bot executes its own
 * nodes in-process (§6.5) and needs none of them. Returns one problem per
 * affected node so the refusal can list "node → bot: reason". Never adds a
 * bot to the chat.
 */
export async function checkV3BotExecutorEligibility(input: {
  orchestratorAppId: string;
  targets: readonly V3NodeExecutorTarget[];
  probe: V3BotEligibilityProbe;
}): Promise<{ ok: true } | { ok: false; problems: V3BotEligibilityProblem[] }> {
  const verdicts = new Map<string, { code: V3BotEligibilityCode; detail?: string } | null>();
  for (const target of input.targets) {
    const appId = target.larkAppId;
    if (appId === input.orchestratorAppId || verdicts.has(appId)) continue;
    verdicts.set(appId, await judgeV3BotEligibility(appId, input.probe));
  }
  const problems: V3BotEligibilityProblem[] = [];
  for (const target of input.targets) {
    // Applies to every bot, the main bot included: no bot can submit it.
    if (target.directoryOutputs) {
      problems.push({ nodeId: target.nodeId, larkAppId: target.larkAppId, code: 'DIRECTORY_OUTPUT', detail: target.directoryOutputs.join(', ') });
    }
    const verdict = verdicts.get(target.larkAppId);
    if (verdict) problems.push({ nodeId: target.nodeId, larkAppId: target.larkAppId, ...verdict });
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/**
 * §6.1 items 1–4 (plus 7) for one non-main bot; `null` = eligible. With
 * `grant: false` the check stays read-only (no chat grant is written) — for
 * listing candidates that may never be used; whoever commits to a bot checks
 * with the grant.
 */
export async function judgeV3BotEligibility(
  appId: string,
  probe: V3BotEligibilityProbe,
  opts: { grant?: boolean } = {},
): Promise<{ code: V3BotEligibilityCode; detail?: string } | null> {
  if (!probe.isConfigured(appId)) return { code: 'BOT_NOT_CONFIGURED' };
  if (!probe.isDaemonOnline(appId)) return { code: 'BOT_OFFLINE' };
  let membership: Awaited<ReturnType<V3BotEligibilityProbe['inChat']>>;
  try {
    membership = await probe.inChat(appId);
  } catch (err) {
    membership = { unknown: err instanceof Error ? err.message : String(err) };
  }
  if (membership === 'no') return { code: 'BOT_NOT_IN_CHAT' };
  if (membership !== 'yes') return { code: 'MEMBERSHIP_UNKNOWN', detail: membership.unknown };
  let topics: Awaited<ReturnType<V3BotEligibilityProbe['opensTopicSessions']>>;
  try {
    topics = await probe.opensTopicSessions(appId);
  } catch (err) {
    topics = { unknown: err instanceof Error ? err.message : String(err) };
  }
  if (topics === 'no') return { code: 'NO_TOPIC_SESSION' };
  if (topics !== 'yes') return { code: 'TOPIC_SESSION_UNKNOWN', detail: topics.unknown };
  if (opts.grant === false) return null;
  try {
    await probe.ensureGrant(appId);
  } catch (err) {
    return { code: 'COLLABORATION_DENIED', detail: err instanceof Error ? err.message : String(err) };
  }
  return null;
}

const PROBLEM_TEXT: Record<V3BotEligibilityCode, string> = {
  BOT_NOT_CONFIGURED: '不是本机 bots.json 里配置的 Bot（跨机器的 Bot 不支持）',
  BOT_NOT_IN_CHAT: '不在本群（请把它拉进群，或改派给群里的 Bot）',
  BOT_OFFLINE: '它的 daemon 不在线',
  COLLABORATION_DENIED: '无法和主 Bot 建立群内协作授权',
  MEMBERSHIP_UNKNOWN: '暂时查不到它是否在本群，请稍后重试',
  NO_TOPIC_SESSION: '它在本群设成了「整群一个会话」（chat / shared），节点话题里的交接会并进群会话，无法提交；请把它在本群的回复模式改成 new-topic 或 chat-topic，或改派',
  TOPIC_SESSION_UNKNOWN: '暂时查不到本群是话题群还是普通群，请稍后重试',
  DIRECTORY_OUTPUT: '节点声明了目录型产出，交给 Bot 执行时无法提交目录；请改成文件产出，或在 Dashboard 关闭该开关改用临时进程执行',
  WORKING_DIR_OUT_OF_RANGE: '指定的工作目录不在它配置的目录范围内（默认工作目录 / 仓库目录）',
  WORKING_DIR_NO_RANGE: '它没有配置目录范围（默认工作目录 / 仓库目录），不能给它指定工作目录',
};

const WORKING_DIR_CODES: ReadonlySet<V3BotEligibilityCode> = new Set(['WORKING_DIR_OUT_OF_RANGE', 'WORKING_DIR_NO_RANGE']);

/** One user-facing reason for an eligibility code. */
export function describeV3BotEligibilityCode(code: V3BotEligibilityCode): string {
  return PROBLEM_TEXT[code];
}

/** "Node → bot: reason" lines for a refused approval. `workingDir`: the
 *  directory `approve-dag --working-dir` asked for, named once when a node
 *  was refused for it. */
export function formatV3BotEligibilityRefusal(
  problems: readonly V3BotEligibilityProblem[],
  nameOf: (larkAppId: string) => string,
  opts: { workingDir?: string } = {},
): string {
  const lines = problems.map((problem) =>
    `- ${problem.nodeId} → ${nameOf(problem.larkAppId)}：${PROBLEM_TEXT[problem.code]}` +
    (problem.detail ? `（${problem.detail}）` : ''));
  const dirRefused = opts.workingDir !== undefined && problems.some((problem) => WORKING_DIR_CODES.has(problem.code));
  return [
    '「节点交给群里的 Bot 执行」已开启，但以下节点的执行 Bot 不满足条件，已拒绝批准：',
    ...(dirRefused ? [`指定的工作目录：${opts.workingDir}`] : []),
    ...lines,
    ...(dirRefused
      ? ['节点在执行 Bot 自己的会话里跑，指定的目录必须落在每个执行 Bot 配置的默认工作目录或仓库目录之内；'
        + '可换一个目录、给这些 Bot 的默认工作目录或仓库目录补上它，或去掉 --working-dir 让各 Bot 用自己的默认目录。']
      : []),
    '处理后重新批准；或用 revise-dag 改派节点，或在 Dashboard 关闭该开关改用临时进程执行。',
  ].join('\n');
}

/** The Gate-2 summary line for a bot run approved with `--working-dir`. */
export function describeV3NodeWorkingDir(workingDir: string): string {
  return `工作目录：${workingDir}（每个执行 Bot 起节点会话时会按它当时的配置再核对一次；`
    + '到时不在它的目录范围内，该节点会受阻并写明原因，不会改用它的默认目录）';
}

/** The summary heading of a bot run: unchanged while every node gets its own
 *  topic; a run that also hands nodes off in the main topic says so. */
export function v3BotExecutorPlanHeading(targets: readonly Pick<V3NodeExecutorTarget, 'placement'>[]): string {
  return targets.some((target) => target.placement === 'main')
    ? '执行方式：节点交给群里的 Bot 执行（按节点在主话题交接或开节点话题，见每行括号）'
    : '执行方式：节点交给群里的 Bot 执行（每个节点开一个节点话题）';
}

/** 「主话题」/「节点话题」for one target. */
export function v3PlacementLabel(target: Pick<V3NodeExecutorTarget, 'placement'>): string {
  return target.placement === 'main' ? '主话题' : '节点话题';
}

/** "Node → executing bot" lines for the Gate-2 summary of a bot run. */
export function formatV3BotExecutorPlan(
  targets: readonly V3NodeExecutorTarget[],
  orchestratorAppId: string,
  nameOf: (larkAppId: string) => string,
): string {
  return [
    v3BotExecutorPlanHeading(targets),
    ...targets.map((target) => {
      const detail = [
        target.larkAppId === orchestratorAppId ? '主 Bot 自己' : undefined,
        // Named only when some node goes to the main topic (lines unchanged otherwise).
        targets.some((other) => other.placement === 'main') ? v3PlacementLabel(target) : undefined,
      ].filter(Boolean).join('，');
      return `- ${target.nodeId} → ${nameOf(target.larkAppId)}${detail ? `（${detail}）` : ''}`;
    }),
  ].join('\n');
}

// ─── 交接带发起人身份 (design §10.2, D5): frozen at authorization ─────────

/** open_id → union_id through the main bot's own app (`resolveUnionIdFromOpenIdStrict`). */
export type V3InitiatorUnionLookup =
  | { status: 'resolved'; unionId: string }
  /** Definitive: the app may not see this person's union_id (scope / visibility). */
  | { status: 'unavailable' }
  | { status: 'retryable'; error: string };

/** Live seams for freezing the initiator; present only while the switch is on. */
export interface V3HandoffIdentityPolicy {
  lookupUnionId(larkAppId: string, openId: string): Promise<V3InitiatorUnionLookup>;
  /** The tools a sender runs as themselves on this bot right now
   *  (`triggerUserAuth.tools` when enabled, else none). */
  botTools(larkAppId: string): V3HandoffIdentityTool[];
}

export type V3HandoffIdentityResolution = {
  /** What run.json records: the frozen initiator, or why there is none. */
  record: V3HandoffIdentityRecord;
  /** A line for the Gate-2 / command reply; empty when there is nothing a
   *  person needs to know (no node bot runs a tool as its trigger user). */
  summary: string;
};

/** Plain-language reason a run carries no initiator identity. */
export const V3_HANDOFF_IDENTITY_UNAVAILABLE_TEXT: Record<V3HandoffIdentityUnavailableReason, string> = {
  not_human_turn: '这次批准不是发起人本人在群里发来的消息（定时任务、事件唤醒等自动回合）',
  no_initiator: '这个 run 没有经过认证的发起人',
  lookup_unavailable: '主 Bot 查不到发起人的跨应用身份（通常是缺少通讯录权限，或发起人对本应用不可见）',
  lookup_failed: '批准时查询发起人的跨应用身份失败',
  no_tools: '主 Bot 没开「按触发人鉴权」，发起人没有可交出的工具',
};

/**
 * Freeze the initiator of a bot-executed run (design §10.2 item 1): the
 * authenticated person of the authorizing turn (`binding.ownerOpenId`, the
 * main bot's view), their union_id resolved now through the main bot's app,
 * and the tools they had on the main bot now — the ceiling every later
 * handoff's delegation is narrowed from (§10.2 item 5).
 *
 * Never refuses the authorization (design §10 principle: permission is asked
 * for only when a tool really needs it). When the identity cannot be frozen —
 * a scheduled task's or other synthetic turn (ADR dispatch-user-delegation §7:
 * such turns carry no delegation), no authenticated initiator, the lookup
 * unavailable or failing, no tool to hand on — the run records why and is
 * approved without it; the summary names the nodes whose bot runs tools as
 * its trigger user, since only those will ask for authorization later.
 */
export async function resolveV3HandoffIdentity(
  binding: RunChatBinding,
  policy: V3HandoffIdentityPolicy,
  /** The authorizing turn was opened by a human message (`om_…` / `join_…`). */
  turn: { humanTurn: boolean },
  plan: { targets: readonly V3NodeExecutorTarget[]; nameOf: (larkAppId: string) => string },
): Promise<V3HandoffIdentityResolution> {
  const unavailable = (reason: V3HandoffIdentityUnavailableReason): V3HandoffIdentityResolution => {
    const governing = plan.targets.filter((target) => policy.botTools(target.larkAppId).length > 0);
    return {
      record: { unavailable: reason },
      summary: governing.length === 0 ? '' : `这个 run 不带发起人身份：${V3_HANDOFF_IDENTITY_UNAVAILABLE_TEXT[reason]}；`
        + `开了「按触发人鉴权」的 Bot（${governing.map((target) => `${target.nodeId} → ${plan.nameOf(target.larkAppId)}`).join('、')}）`
        + '调用需要个人授权的工具时，会提示授权',
    };
  };
  if (!turn.humanTurn) return unavailable('not_human_turn');
  if (!binding.ownerOpenId) return unavailable('no_initiator');
  let lookup: V3InitiatorUnionLookup;
  try {
    lookup = await policy.lookupUnionId(binding.larkAppId, binding.ownerOpenId);
  } catch (err) {
    lookup = { status: 'retryable', error: err instanceof Error ? err.message : String(err) };
  }
  if (lookup.status === 'retryable') return unavailable('lookup_failed');
  if (lookup.status === 'unavailable') return unavailable('lookup_unavailable');
  const tools = [...new Set(policy.botTools(binding.larkAppId))];
  if (tools.length === 0) return unavailable('no_tools');
  return {
    record: { unionId: lookup.unionId, tools },
    summary: `交接带发起人身份：开。开了「按触发人鉴权」的子 Bot 以发起人本人的身份执行，可委托工具不超过：${tools.join('、')}；`
      + '某个节点交接时带不上身份的，照常交接，用到需要个人授权的工具时会提示授权',
  };
}

/** Everything an authorization entry point needs to decide the executor. */
export interface V3NodeExecutorPolicy {
  switchMode: V3NodeExecutorSwitch;
  multiTopicEnabled: boolean;
  /** Built only for a `bot` decision (it may talk to Lark / daemons). */
  probe: (binding: RunChatBinding) => V3BotEligibilityProbe | Promise<V3BotEligibilityProbe>;
  nameOf: (larkAppId: string) => string;
  /** 交接带发起人身份 switch: present only while it is on. */
  handoffIdentity?: V3HandoffIdentityPolicy;
  /** §5.2 rule 3 (read only when some node is placed in the main topic):
   *  absent = unknown, and such a run is refused rather than guessed. */
  mainTopic?: (binding: RunChatBinding) => V3MainTopicAvailability;
}

export type V3NodeExecutorResolution =
  /** `note` explains a fallback when the switch is on (P4 / §6.1 item 5). */
  | { kind: 'ephemeral'; note?: string }
  /** `summary` lists node → executing bot for the Gate-2 / command reply;
   *  `handoffIdentity` is the initiator to freeze when that switch is on. */
  | { kind: 'bot'; targets: V3NodeExecutorTarget[]; summary: string; handoffIdentity?: V3HandoffIdentityRecord }
  /** Refuse the authorization; `message` lists node → bot: reason. */
  | { kind: 'refused'; problems: V3BotEligibilityProblem[]; message: string };

/**
 * Decide + check in one step for an authorization entry point. `targetsFor`
 * is only called for a `bot` decision and must freeze bots exactly as the
 * authorization will (default selector = the run's own bot).
 */
export async function resolveV3NodeExecutor(input: {
  policy: V3NodeExecutorPolicy;
  binding: RunChatBinding | undefined;
  targetsFor: (binding: RunChatBinding) => V3NodeExecutorTarget[];
  /** See {@link resolveV3HandoffIdentity}; absent = not proven human. */
  humanTurn?: boolean;
}): Promise<V3NodeExecutorResolution> {
  const decision = decideV3NodeExecutor({
    switchMode: input.policy.switchMode,
    binding: input.binding,
    multiTopicEnabled: input.policy.multiTopicEnabled,
  });
  if (decision.mode === 'ephemeral') {
    const note = describeV3EphemeralFallback(decision);
    return note ? { kind: 'ephemeral', note } : { kind: 'ephemeral' };
  }
  const binding = input.binding!;
  const targets = input.targetsFor(binding);
  // §5.2 hard rules first: pure, and a refusal needs no live probe.
  if (targets.some((target) => target.placement === 'main')) {
    const placement = v3TargetPlacementProblems({
      targets,
      orchestratorAppId: binding.larkAppId,
      mainTopic: input.policy.mainTopic?.(binding) ?? { available: false, why: '无法确认主会话是不是话题里的会话' },
      nameOf: input.policy.nameOf,
    });
    if (placement.length > 0) return { kind: 'refused', problems: [], message: formatV3PlacementRefusal(placement) };
  }
  const checked = await checkV3BotExecutorEligibility({
    orchestratorAppId: binding.larkAppId,
    targets,
    probe: await input.policy.probe(binding),
  });
  if (!checked.ok) {
    return {
      kind: 'refused',
      problems: checked.problems,
      message: formatV3BotEligibilityRefusal(checked.problems, input.policy.nameOf),
    };
  }
  const summary = formatV3BotExecutorPlan(targets, binding.larkAppId, input.policy.nameOf);
  if (!input.policy.handoffIdentity) return { kind: 'bot', targets, summary };
  const identity = await resolveV3HandoffIdentity(binding, input.policy.handoffIdentity,
    { humanTurn: input.humanTurn === true }, { targets, nameOf: input.policy.nameOf });
  return {
    kind: 'bot',
    targets,
    summary: identity.summary ? `${summary}\n${identity.summary}` : summary,
    handoffIdentity: identity.record,
  };
}

/**
 * §6.1 item 7 as a pure rule: does a reply inside a node topic of this chat
 * reach `botConfig` as its own topic-scoped session? In a topic chat always;
 * in a normal group only when the bot's reply mode for this chat keeps native
 * topics apart (`new-topic` / `chat-topic`) — `chat` and `shared` fold them
 * into one group-wide session (event-dispatcher's regular-group fold).
 */
export function v3OpensTopicSessions(
  chatMode: 'group' | 'topic' | 'p2p' | 'unknown',
  botConfig: { regularGroupReplyMode?: string; chatReplyModes?: Record<string, string> } | undefined,
  chatId: string,
): 'yes' | 'no' | { unknown: string } {
  if (chatMode === 'unknown') return { unknown: 'chat mode unavailable' };
  if (chatMode === 'topic') return 'yes';
  if (chatMode === 'p2p') return 'no';
  const mode = botConfig?.chatReplyModes?.[chatId] ?? botConfig?.regularGroupReplyMode ?? 'chat-topic';
  return mode === 'new-topic' || mode === 'chat-topic' ? 'yes' : 'no';
}
