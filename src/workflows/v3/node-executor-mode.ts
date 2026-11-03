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
  for (const node of dag.nodes) {
    if (isGoalNode(node)) out.push(withOutputs({ nodeId: node.id, larkAppId: targetOf(node.bot, node.id) }, node.outputs));
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
  | 'DIRECTORY_OUTPUT';

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
};

/** One user-facing reason for an eligibility code. */
export function describeV3BotEligibilityCode(code: V3BotEligibilityCode): string {
  return PROBLEM_TEXT[code];
}

/** "Node → bot: reason" lines for a refused approval. */
export function formatV3BotEligibilityRefusal(
  problems: readonly V3BotEligibilityProblem[],
  nameOf: (larkAppId: string) => string,
): string {
  const lines = problems.map((problem) =>
    `- ${problem.nodeId} → ${nameOf(problem.larkAppId)}：${PROBLEM_TEXT[problem.code]}` +
    (problem.detail ? `（${problem.detail}）` : ''));
  return [
    '「节点交给群里的 Bot 执行」已开启，但以下节点的执行 Bot 不满足条件，已拒绝批准：',
    ...lines,
    '处理后重新批准；或用 revise-dag 改派节点，或在 Dashboard 关闭该开关改用临时进程执行。',
  ].join('\n');
}

/** "Node → executing bot" lines for the Gate-2 summary of a bot run. */
export function formatV3BotExecutorPlan(
  targets: readonly V3NodeExecutorTarget[],
  orchestratorAppId: string,
  nameOf: (larkAppId: string) => string,
): string {
  return [
    '执行方式：节点交给群里的 Bot 执行（每个节点开一个节点话题）',
    ...targets.map((target) =>
      `- ${target.nodeId} → ${nameOf(target.larkAppId)}` +
      (target.larkAppId === orchestratorAppId ? '（主 Bot 自己）' : '')),
  ].join('\n');
}

/** Everything an authorization entry point needs to decide the executor. */
export interface V3NodeExecutorPolicy {
  switchMode: V3NodeExecutorSwitch;
  multiTopicEnabled: boolean;
  /** Built only for a `bot` decision (it may talk to Lark / daemons). */
  probe: (binding: RunChatBinding) => V3BotEligibilityProbe | Promise<V3BotEligibilityProbe>;
  nameOf: (larkAppId: string) => string;
}

export type V3NodeExecutorResolution =
  /** `note` explains a fallback when the switch is on (P4 / §6.1 item 5). */
  | { kind: 'ephemeral'; note?: string }
  /** `summary` lists node → executing bot for the Gate-2 / command reply. */
  | { kind: 'bot'; targets: V3NodeExecutorTarget[]; summary: string }
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
  return { kind: 'bot', targets, summary: formatV3BotExecutorPlan(targets, binding.larkAppId, input.policy.nameOf) };
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
