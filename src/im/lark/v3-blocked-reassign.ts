/**
 * 受阻卡上的「改派」（design 2026-11-03 §9.2 / §10.3）：只在节点交给群里 Bot
 * 执行的 run 上出现。渲染时按本 run 的批准范围（`v3ApprovedBotScope`：批准时
 * 选定的 Bot，加上发起人在修改确认卡上批准加入的 Bot）现查谁还能接手；点
 * 「确认改派」时只认发起人，再现查一次目标 Bot，然后交给引擎的 `reassignNode`
 * （受阻节点在同一实例里以新 attempt 交给新 Bot），最后重驱动。节点按有效流程
 * （含运行中修改）查找。
 *
 * 普通 run（临时进程执行）的受阻卡与以前逐字节一致：这里根本不读它的 Bot。
 * 改派给批准范围之外的 Bot 要走运行中修改（`workflow edit` 的 reassign，新 Bot
 * 由发起人在修改确认卡上确认，§13.5），这里的下拉框和点击都只认批准范围。
 * 待确认的修改挂着这个节点时不改派（与 ask 作答一致），先处理修改确认卡。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { latestAttemptIdFor } from '../../workflows/v3/attempt-numbering.js';

import { parseFrozenBotSnapshots } from '../../workflows/v3/bot-resolve.js';
import type { BotSnapshot } from '../../workflows/v3/contract.js';
import { requestV3Retry, type V3BlockedInfo } from '../../workflows/v3/daemon-run.js';
import { isGoalNode, type V3Dag } from '../../workflows/v3/dag.js';
import { externalAttemptNode, reassignNode, type V3ReassignOutcome } from '../../workflows/v3/external-control.js';
import type { V3ExternalNodeExecutor } from '../../workflows/v3/external-executor.js';
import type { RunChatBinding } from '../../workflows/v3/grill-state.js';
import { readJournal, type StoredEvent } from '../../workflows/v3/journal.js';
import {
  describeV3BotEligibilityCode,
  judgeV3BotEligibility,
  type V3BotEligibilityProbe,
} from '../../workflows/v3/node-executor-mode.js';
import { isValidRunId } from '../../workflows/v3/ops-projection.js';
import { loadAuthorizedV3Run } from '../../workflows/v3/run-envelope.js';
import { materialize } from '../../workflows/v3/state.js';
import {
  loadEffectiveV3Dag,
  v3ApprovedBotScope,
  v3PendingProposalHolds,
} from '../../workflows/v3/dag-revision.js';
import {
  V3_BLOCKED_REASSIGN_FIELD,
  buildV3BlockedCard,
  v3BlockedCardNonce,
  type V3BlockedCardInput,
  type V3BlockedReassignOffer,
  type V3ReassignActionValue,
} from './v3-blocked-card.js';

export interface V3BlockedReassignDeps {
  /** Live §6.1 probe for the run's chat; re-run on every render and click. */
  probe: (binding: RunChatBinding) => V3BotEligibilityProbe | Promise<V3BotEligibilityProbe>;
  nameOf: (larkAppId: string) => string;
  /** The bot's CLI for the option label (default: the frozen snapshot's). */
  cliOf?: (larkAppId: string) => string | undefined;
  /** Stops an open attempt should the node be running (normally it is blocked). */
  executor?: V3ExternalNodeExecutor;
}

interface V3BotRunView {
  /** The approved flow (`dag.json`): what the engine folds revisions onto. */
  baseDag: V3Dag;
  /** The effective flow (every applied runtime revision folded in). */
  dag: V3Dag;
  /** The snapshots frozen at approval. */
  frozen: Map<string, BotSnapshot>;
  /** The run's approved bot scope ({@link v3ApprovedBotScope}). */
  snapshots: Map<string, BotSnapshot>;
  binding: RunChatBinding;
  /** The run's initiator as the main bot's app sees them (§10.3). */
  initiatorOpenId?: string;
  /** The approved bots' app ids, frozen ones first. */
  approved: string[];
}

/** A validated bot-executed run, or `undefined` for every other run. */
function loadBotRun(runDir: string): V3BotRunView | undefined {
  const loaded = loadAuthorizedV3Run(runDir);
  const envelope = loaded.envelope;
  if (!('nodeExecutor' in envelope) || envelope.nodeExecutor !== 'bot' || !envelope.chatBinding) return undefined;
  const frozen = parseFrozenBotSnapshots(loaded.botSnapshots, loaded.dag);
  const journalPath = join(runDir, 'journal.ndjson');
  const effective = loadEffectiveV3Dag(runDir, loaded.dag, existsSync(journalPath) ? readJournal(journalPath) : []);
  const snapshots = v3ApprovedBotScope(frozen, effective.botAdditions);
  // Ad-hoc: the Gate-2 approver. Saved Workflow: the person who sent
  // `/workflow run` (its chat binding owner) — both authenticated turns.
  const initiatorOpenId = envelope.source.kind === 'ad_hoc' && 'authorizedByOpenId' in envelope.authorization
    ? envelope.authorization.authorizedByOpenId
    : envelope.source.kind === 'saved_definition' ? envelope.chatBinding.ownerOpenId : undefined;
  return {
    baseDag: loaded.dag,
    dag: effective.dag,
    frozen,
    snapshots,
    binding: envelope.chatBinding,
    ...(initiatorOpenId ? { initiatorOpenId } : {}),
    approved: [...new Set([...snapshots.values()].map((snapshot) => snapshot.larkAppId))],
  };
}

/** Who executes `nodeId` now: the latest reassignment, else the frozen bot of
 *  its definition. `undefined` for anything but a goal node. */
function currentTarget(view: V3BotRunView, events: readonly StoredEvent[], nodeId: string): string | undefined {
  const assigned = materialize([...events]).assignments.get(nodeId);
  if (assigned) return assigned;
  let node = view.dag.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    const dispatched = events.find((event): event is StoredEvent & { type: 'nodeDispatched' } =>
      event.type === 'nodeDispatched' && event.nodeId === nodeId && !!event.loop);
    if (dispatched?.loop) node = externalAttemptNode(view.dag, { nodeId, loop: dispatched.loop });
  }
  if (!node || !isGoalNode(node)) return undefined;
  return view.snapshots.get(node.bot ?? '')?.larkAppId;
}

function labelOf(view: V3BotRunView, deps: V3BlockedReassignDeps, larkAppId: string): string {
  const cli = deps.cliOf?.(larkAppId)
    ?? [...view.snapshots.values()].find((snapshot) => snapshot.larkAppId === larkAppId)?.cliId;
  return `${deps.nameOf(larkAppId)}${cli ? `（${cli}）` : ''}`;
}

/** Why `larkAppId` cannot take over a node now (`undefined` = it can). The
 *  main bot runs its nodes in-process and needs no probe. */
async function unavailableReason(
  view: V3BotRunView,
  larkAppId: string,
  probe: () => Promise<V3BotEligibilityProbe>,
  opts: { grant: boolean },
): Promise<string | undefined> {
  if (larkAppId === view.binding.larkAppId) return undefined;
  const problem = await judgeV3BotEligibility(larkAppId, await probe(), opts);
  return problem ? describeV3BotEligibilityCode(problem.code) + (problem.detail ? `（${problem.detail}）` : '') : undefined;
}

function lazyProbe(deps: V3BlockedReassignDeps, binding: RunChatBinding): () => Promise<V3BotEligibilityProbe> {
  let built: Promise<V3BotEligibilityProbe> | undefined;
  return () => (built ??= Promise.resolve(deps.probe(binding)));
}

async function reassignOffer(
  view: V3BotRunView,
  runDir: string,
  nodeId: string,
  deps: V3BlockedReassignDeps,
): Promise<V3BlockedReassignOffer | undefined> {
  const events = readJournal(join(runDir, 'journal.ndjson'));
  const current = currentTarget(view, events, nodeId);
  if (!current) return undefined;
  const probe = lazyProbe(deps, view.binding);
  const offer: V3BlockedReassignOffer = { currentName: deps.nameOf(current), candidates: [], unavailable: [] };
  for (const larkAppId of view.approved) {
    if (larkAppId === current) continue;
    const label = labelOf(view, deps, larkAppId);
    // Listing writes nothing: the chat grant is only made for the bot picked.
    const why = await unavailableReason(view, larkAppId, probe, { grant: false });
    if (why) offer.unavailable.push({ label, why });
    else offer.candidates.push({ larkAppId, label });
  }
  return offer;
}

/**
 * The blocked card the daemon posts. For a bot-executed run with a blocked
 * goal node it carries the 改派 section; for any other run (or when `reassign`
 * is not wired) it is exactly today's card.
 */
export async function buildV3BlockedCardForRun(input: {
  runDir: string;
  runId: string;
  info: V3BlockedInfo;
  reassign?: V3BlockedReassignDeps;
}): Promise<string> {
  const { info } = input;
  const base: V3BlockedCardInput = {
    runId: input.runId,
    nodeId: info.nodeId,
    attemptId: info.attemptId,
    errorClass: info.errorClass,
    errorCode: info.errorCode,
    message: info.message,
    retryForbidden: info.retryForbidden,
    // human-ask 受阻 → 渲染问题 + 选项按钮卡（替代纯重试卡）；流程修改后已作废
    // → 只留「按新定义重跑」。ask 卡（含作废态）都不出改派区。
    ...(info.ask ? { ask: info.ask } : {}),
    ...(info.askVoided ? { askVoided: true } : {}),
  };
  if (!input.reassign || info.ask || info.retryForbidden) return buildV3BlockedCard(base);
  let offer: V3BlockedReassignOffer | undefined;
  try {
    const view = loadBotRun(input.runDir);
    // Only the initiator may reassign; without one nobody could ever use it.
    if (view?.initiatorOpenId) offer = await reassignOffer(view, input.runDir, info.nodeId, input.reassign);
  } catch {
    offer = undefined; // the plain card still lets a human retry
  }
  return buildV3BlockedCard(offer ? { ...base, reassign: offer } : base);
}

export interface V3BlockedReassignHandlerDeps {
  baseDir: string;
  driveRun: (runId: string) => void;
  /** The blocked card's general permission (canOperate); the initiator must
   *  pass it too. */
  canResolve?: (binding: RunChatBinding | undefined, operatorOpenId: string | undefined) => boolean;
  reassign?: V3BlockedReassignDeps;
}

type Toast = { toast: { type: 'info' | 'warning' | 'error'; content: string } };
const toast = (type: Toast['toast']['type'], content: string): Toast => ({ toast: { type, content } });

const REJECTION_TEXT: Record<Extract<V3ReassignOutcome, { kind: 'rejected' }>['reason'], string> = {
  missing: '该 run 不存在或已清理',
  'run-not-running': '这个工作流已经结束，不能再改派',
  'unknown-node': '找不到这个节点，卡片已失效',
  'not-in-bot-set': '只能改派给本 run 已批准的 Bot（批准时选定的，或在修改确认卡上批准加入的）',
  'same-bot': '这个节点已经由这个 Bot 执行',
  'not-reassignable': '该节点已不在受阻状态，这张卡已失效（看最新那张卡）',
  'stale-attempt': '该节点已进入新一轮 attempt，这张旧卡失效（看最新那张卡）',
  'revise-workflow-required': '产物契约与 Workflow 定义不一致，改派也无法完成；请修订并发布新版本',
  'not-bot-run': '这个 run 的节点不是交给群里的 Bot 执行的，不能改派',
  'revision-pending': '这个节点有待确认的流程修改，请先处理修改确认卡',
};

type V3ClickState =
  | { kind: 'missing' }
  | { kind: 'run-over' }
  /** The node is no longer blocked on the card's attempt. */
  | { kind: 'moved'; current?: string }
  /** A pending revision proposal touches the node. */
  | { kind: 'held' }
  /** An applied flow revision removed the node. */
  | { kind: 'removed' }
  | { kind: 'blocked'; current?: string };

/** The node (or the loop it ran in) is no longer in the effective flow. */
function removedByRevision(view: V3BotRunView, events: readonly StoredEvent[], nodeId: string): boolean {
  if (view.dag.nodes.some((node) => node.id === nodeId)) return false;
  const loopId = events.find((event): event is StoredEvent & { type: 'nodeDispatched' } =>
    event.type === 'nodeDispatched' && event.nodeId === nodeId && !!event.loop)?.loop?.loopId;
  return loopId === undefined || !view.dag.nodes.some((node) => node.id === loopId);
}

/** Where the run and the card's node stand now, from the journal alone. */
function clickState(runDir: string, view: V3BotRunView, nodeId: string, attemptId: string): V3ClickState {
  const journalPath = join(runDir, 'journal.ndjson');
  if (!existsSync(journalPath)) return { kind: 'missing' };
  const events = readJournal(journalPath);
  const snap = materialize([...events]);
  if (snap.runStatus !== 'running' && snap.runStatus !== 'blocked') return { kind: 'run-over' };
  if (removedByRevision(view, events, nodeId)) return { kind: 'removed' };
  if (v3PendingProposalHolds(events, nodeId)) return { kind: 'held' };
  const current = currentTarget(view, events, nodeId);
  const node = snap.nodes.get(nodeId);
  const blockedHere = node?.status === 'blocked'
    && latestAttemptIdFor([...events], node.effectiveInstanceId ?? nodeId) === attemptId;
  return { kind: blockedHere ? 'blocked' : 'moved', ...(current ? { current } : {}) };
}

function reassignedCard(
  runDir: string,
  value: V3ReassignActionValue,
  toName: string,
  nextAttemptId: string | undefined,
  by: string,
): unknown {
  const events = readJournal(join(runDir, 'journal.ndjson'));
  const blocked = [...events].reverse().find((event): event is StoredEvent & { type: 'nodeBlocked' } =>
    event.type === 'nodeBlocked' && event.nodeId === value.nodeId && event.attemptId === value.attemptId);
  return JSON.parse(buildV3BlockedCard({
    runId: value.runId,
    nodeId: value.nodeId,
    attemptId: value.attemptId,
    errorClass: blocked?.errorClass,
    errorCode: blocked?.errorCode,
    message: blocked?.message,
    reassigned: { toName, ...(nextAttemptId ? { nextAttemptId } : {}), by },
  }));
}

/**
 * A 「确认改派」 click. Only the run's initiator may reassign (§10.3); the
 * target must be one of the bots frozen at approval and pass §6.1 right now
 * (the chat grant is made here). The engine closes the blocked attempt and
 * opens a new one for the new bot; the run is re-driven to send the handoff.
 */
export async function handleV3BlockedReassign(
  value: V3ReassignActionValue,
  operatorOpenId: string | undefined,
  larkAppId: string | undefined,
  formValue: Record<string, unknown> | undefined,
  deps: V3BlockedReassignHandlerDeps,
): Promise<unknown> {
  if (!isValidRunId(value.runId)) return toast('warning', '改派已失效（非法 run）');
  // The card always names the blocked attempt; without it neither the nonce
  // nor the engine's freshness check would mean anything.
  if (typeof value.nodeId !== 'string' || !value.nodeId || typeof value.attemptId !== 'string' || !value.attemptId) {
    return toast('warning', '这张卡已失效（缺少节点或 attempt）');
  }
  if (value.nonce !== v3BlockedCardNonce(value.runId, value.nodeId, value.attemptId)) {
    return toast('warning', '这张卡已失效（nonce 不匹配）');
  }
  if (!deps.reassign) return toast('warning', '本机还不支持在卡片上改派');
  const runDir = join(deps.baseDir, value.runId);
  let view: V3BotRunView | undefined;
  try {
    view = loadBotRun(runDir);
  } catch (err) {
    return toast('error', `改派失败：run 校验未通过（${err instanceof Error ? err.message : String(err)}）`);
  }
  if (!view) return toast('warning', REJECTION_TEXT['not-bot-run']);
  // open_id is app-scoped: compare it only on the app that owns the run.
  if (larkAppId !== undefined && larkAppId !== view.binding.larkAppId) {
    return toast('warning', '这张卡不属于这个工作流的主 Bot');
  }
  if (!operatorOpenId || !view.initiatorOpenId || operatorOpenId !== view.initiatorOpenId) {
    return toast('warning', '只有发起这个工作流的人能改派节点');
  }
  if (deps.canResolve && !deps.canResolve(view.binding, operatorOpenId)) {
    return toast('warning', '你没有权限操作这个节点');
  }
  const raw = formValue?.[V3_BLOCKED_REASSIGN_FIELD];
  const target = typeof raw === 'string' ? raw.trim() : '';
  if (!target) return toast('warning', '请先选择接手的 Bot');
  if (!view.approved.includes(target)) return toast('warning', REJECTION_TEXT['not-in-bot-set']);

  const reassignDeps = deps.reassign;
  const name = reassignDeps.nameOf(target);
  // The journal decides before anything is written (no chat grant for a run
  // that is over or a node that moved on).
  const state = clickState(runDir, view, value.nodeId, value.attemptId);
  if (state.kind === 'missing') return toast('warning', REJECTION_TEXT.missing);
  if (state.kind === 'run-over') return toast('warning', REJECTION_TEXT['run-not-running']);
  if (state.kind === 'removed') return toast('warning', '这个节点已被流程修改删除，这张卡已失效');
  // Before the chat grant: nothing is written for a node a proposal holds.
  if (state.kind === 'held') return toast('warning', REJECTION_TEXT['revision-pending']);
  if (state.kind === 'moved') {
    if (state.current !== target) return toast('warning', REJECTION_TEXT['stale-attempt']);
    // A repeated click after the node already went to this bot.
    deps.driveRun(value.runId);
    return toast('info', `已改派给 ${name}，正在交接`);
  }

  let why: string | undefined;
  try {
    why = await unavailableReason(view, target, lazyProbe(reassignDeps, view.binding), { grant: true });
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  }
  if (why) return toast('warning', `不能改派给 ${name}：${why}`);
  // The chat grant was an await: a proposal touching the node may have been
  // filed meanwhile. Re-check before finishing a half-written reassignment or
  // calling the engine (which re-checks under its lock too). The grant itself
  // is idempotent and stays.
  if (v3PendingProposalHolds(readJournal(join(runDir, 'journal.ndjson')), value.nodeId)) {
    return toast('warning', REJECTION_TEXT['revision-pending']);
  }

  if (state.current === target) {
    // Still blocked although already assigned to this bot: an earlier
    // reassignment wrote its nodeReassigned but not its retry. Finish it.
    const retried = requestV3Retry(deps.baseDir, value.runId, { nodeId: value.nodeId, expectedAttemptId: value.attemptId });
    if (retried.kind === 'stale-run') return toast('warning', REJECTION_TEXT['not-reassignable']);
    deps.driveRun(value.runId);
    if (retried.kind === 'already-requested') return toast('info', `已改派给 ${name}，正在交接`);
    return reassignedCard(runDir, value, name, retried.nextAttemptId, operatorOpenId);
  }

  let outcome: V3ReassignOutcome;
  try {
    outcome = await reassignNode(runDir, {
      nodeId: value.nodeId,
      toLarkAppId: target,
      by: operatorOpenId,
      expectedAttemptId: value.attemptId,
      requireBlocked: true,
    }, {
      // The engine folds the applied revisions and the approved bots onto these itself.
      dag: view.baseDag,
      botSnapshots: view.frozen,
      nodeExecutor: 'bot',
      ...(reassignDeps.executor ? { executor: reassignDeps.executor } : {}),
    });
  } catch (err) {
    return toast('error', `改派失败，请再试：${err instanceof Error ? err.message : String(err)}`);
  }
  // Raced with another change between the read above and the locked write.
  if (outcome.kind === 'rejected') return toast('warning', REJECTION_TEXT[outcome.reason]);
  deps.driveRun(value.runId);
  return reassignedCard(runDir, value, name, outcome.nextAttemptId, operatorOpenId);
}
