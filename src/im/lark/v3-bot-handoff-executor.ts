/**
 * Feishu transport for bot-executed workflow nodes (design 2026-11-03 §5.3,
 * §5.4, §6.3, §6.5) — the `V3ExternalNodeExecutor` the main bot's daemon hands
 * to its v3 gate runner. PR 5a places every node in its own topic:
 *
 *   1. re-check the target (daemon online, member of the chat, talk-only
 *      chat grant with the main bot) — a failure is a pre-send rejection;
 *   2. post the NODE CARD as a new top-level message (no mention) with the
 *      attempt's frozen `nodeCard` uuid;
 *   3. leave a pending marker, then reply the HANDOFF CARD into its topic with
 *      the frozen `handoff` uuid (Lark de-duplicates both uuids, so a re-send
 *      after an unknown failure never delivers twice); its footer mentions the
 *      target bot, which is what reaches the target's daemon;
 *   4. publish the host-signed binding keyed by the handoff message id, then
 *      patch the card so it shows that id in the `botmux report` commands.
 *
 * A node assigned to the main bot itself (the default) gets the same two cards
 * without a mention — Lark never delivers a bot's own message back to it —
 * and the turn is started in-process in the node topic (§6.5).
 *
 * Everything that touches Lark, daemons or sessions is injected.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GoalInputs, Spec } from '../../workflows/v3/contract.js';
import { isGoalNode, type V3Dag, type V3GoalNode } from '../../workflows/v3/dag.js';
import type {
  V3ExternalAcceptanceProbe,
  V3ExternalAttemptRef,
  V3ExternalDispatchOutcome,
  V3ExternalDispatchRequest,
  V3ExternalNodeExecutor,
  V3ExternalStopReason,
  V3ExternalStopRequest,
} from '../../workflows/v3/external-executor.js';
import { classifyExternalAttempt } from '../../workflows/v3/external-control.js';
import {
  createWorkflowHandoffBinding,
  isWorkflowHandoffRevoked,
  linkWorkflowHandoffMessage,
  lookupWorkflowHandoff,
  lookupWorkflowHandoffByNonce,
  readDispatchRegistryLoose,
  recordWorkflowHandoffBinding,
  revokeWorkflowHandoff,
  workflowHandoffNonce,
} from '../../core/workflow-handoff-binding.js';
import { WORKFLOW_HANDOFF_TASK_FILE } from '../../core/workflow-node-session.js';
import type { DispatchUserAuthority, WorkflowDispatchUserRef } from '../../core/dispatch-user-delegation.js';
import type { WorkflowHandoffIdentityPlan } from '../../core/workflow-handoff-identity.js';
import type { WorkflowNodeSessionMarker } from '../../types.js';
import { foldV3ExternalAttempts } from '../../workflows/v3/external-attempt-ledger.js';
import { readJournal } from '../../workflows/v3/journal.js';
import {
  WORKFLOW_HANDOFF_ID_PLACEHOLDER,
  buildV3HandoffCard,
  buildV3NodeCard,
  planV3HandoffCard,
  v3HandoffBodyText,
  type V3HandoffCardInput,
} from './v3-node-card.js';
import type { WorkflowSidebarEntryLink } from './workflow-sidebar-entry.js';

export interface V3BotHandoffTransport {
  /** New top-level message in the chat (the node topic's root). */
  sendCard(chatId: string, cardJson: string, uuid: string): Promise<string>;
  /** Reply inside the topic rooted at `rootMessageId`. */
  replyCard(rootMessageId: string, cardJson: string, uuid: string): Promise<string>;
  patchCard(messageId: string, cardJson: string): Promise<void>;
}

export type V3TargetInChat =
  | { ok: true; openId: string }
  | { ok: false; code: 'BOT_NOT_IN_CHAT' | 'COLLABORATION_DENIED'; message: string }
  /** Membership could not be determined: an unknown outcome, not a refusal. */
  | { ok: false; code: 'UNKNOWN'; message: string };

export interface V3SelfTurnRequest {
  chatId: string;
  /** Node card id: the topic the session is anchored at. */
  publishRoot: string;
  handoffMessageId: string;
  marker: WorkflowNodeSessionMarker;
  prompt: string;
  sessionTitle: string;
  inputs: GoalInputs;
  runDir: string;
  /** The handoff carries the initiator's signed delegation (design §10):
   *  the turn's tool identity must be published from it before it starts. */
  identityDelegated?: true;
}

/** 交接带发起人身份 (design §10). Absent, or a `none` plan: every handoff is
 *  sent exactly as without the feature. */
export interface V3HandoffIdentityDeps {
  /** Decided after the target checks and before anything is posted. */
  plan(request: V3ExternalDispatchRequest): Promise<WorkflowHandoffIdentityPlan>;
  /** Sign the delegation around the handoff send (pending → send → bind to
   *  the message id) and return that id. */
  deliver(input: {
    authority: DispatchUserAuthority;
    targetLarkAppId: string;
    chatId: string;
    rootId: string;
    workflow: WorkflowDispatchUserRef;
    send: () => Promise<string>;
  }): Promise<string>;
}

export interface V3BotHandoffExecutorDeps {
  selfLarkAppId: string;
  dataDir: string;
  transport: V3BotHandoffTransport;
  resolveTargetInChat(chatId: string, targetLarkAppId: string): Promise<V3TargetInChat>;
  isDaemonOnline(larkAppId: string): boolean;
  /** §6.1 item 7: does a reply in a node topic of this chat reach the
   *  target as its own topic session (`no` = folds into the group session)? */
  targetOpensTopicSessions(chatId: string, targetLarkAppId: string): Promise<'yes' | 'no' | { unknown: string }>;
  /** Same talk-only grant matrix `botmux dispatch --bot-app` writes. */
  ensureGrant(chatId: string, targetLarkAppId: string): Promise<void>;
  bindingSecret(): string;
  botName(larkAppId: string): string;
  /** The session that registered this handoff turn (receiver's session store). */
  findAcceptance(input: {
    targetLarkAppId: string;
    chatId: string;
    publishRoot: string;
    handoffMessageId: string;
  }): { sessionId: string; acceptedAt?: number } | undefined;
  /** Stop the target's current turn for this handoff (best-effort). The
   *  binding is already revoked when this is called. */
  stopTarget(input: {
    targetLarkAppId: string;
    nonce: string;
    handoffMessageId?: string;
    sessionId?: string;
    reason: V3ExternalStopReason;
  }): Promise<void>;
  /** §15.4, checked before anything is posted: why this attempt cannot be
   *  handed off in the run's Gate-2 working dir (the main bot's own range
   *  for its own node, or a target daemon that would not apply it), or
   *  undefined. A reason blocks the node with WORKING_DIR_REFUSED. */
  workingDirPreflight?(request: V3ExternalDispatchRequest): string | undefined;
  /** §6.5: open the main bot's own node session; idempotent per handoff.
   *  `refused`: nothing was started and the node was blocked with the reason
   *  (the run's working dir is not in the main bot's range, §15.4). */
  startSelfTurn(input: V3SelfTurnRequest): Promise<{ sessionId: string } | { refused: true }>;
  handoffIdentity?: V3HandoffIdentityDeps;
  /** §11: this run's「工作流 ›」sidebar entry (the main bot is this daemon's
   *  bot); undefined = no Dashboard address, the cards carry no entry. */
  workflowEntry?(runId: string): WorkflowSidebarEntryLink | undefined;
  now?(): number;
  /** Wait inside a dispatch call (identity-check retries); rejects on abort. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

/**
 * When the target bot's identity check cannot run (a lookup error, its
 * daemon unreachable), the handoff is retried after these delays before it
 * goes out without the initiator — about a minute in all. A definite answer
 * (not in the chat, not approved, no tool) decides at once. A wait of
 * at most {@link IDENTITY_CHECK_IN_CALL_WAIT_MAX_MS} happens inside the
 * dispatch call (well under the engine's 30 s per-call bound); a longer one
 * leaves the attempt prepared (nothing was sent) for the engine's next
 * same-key re-send.
 */
export const IDENTITY_CHECK_RETRY_DELAYS_MS = [5_000, 15_000, 40_000] as const;
export const IDENTITY_CHECK_IN_CALL_WAIT_MAX_MS = 10_000;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface RunCardContext {
  title: string;
  acceptanceBySketch: Map<string, string>;
  goalNodeIds: string[];
}

function readRunCardContext(runDir: string, runId: string): RunCardContext {
  let title = runId;
  const acceptanceBySketch = new Map<string, string>();
  try {
    const spec = JSON.parse(readFileSync(join(runDir, 'spec.json'), 'utf-8')) as Partial<Spec>;
    if (typeof spec.title === 'string' && spec.title.trim()) title = spec.title.trim();
    for (const sketch of spec.nodes ?? []) {
      if (sketch && typeof sketch.sketchId === 'string' && typeof sketch.acceptance === 'string') {
        acceptanceBySketch.set(sketch.sketchId, sketch.acceptance);
      }
    }
  } catch { /* spec is display-only here */ }
  const goalNodeIds: string[] = [];
  try {
    const dag = JSON.parse(readFileSync(join(runDir, 'dag.json'), 'utf-8')) as V3Dag;
    for (const node of dag.nodes ?? []) if (isGoalNode(node)) goalNodeIds.push(node.id);
  } catch { /* display-only */ }
  return { title, acceptanceBySketch, goalNodeIds };
}

/** Card/prompt content for one handoff (shared by the card and the self turn). */
export function v3HandoffContent(
  request: V3ExternalDispatchRequest,
  context: { title: string; acceptance?: string },
  target: V3HandoffCardInput['target'],
  handoffRef: string,
  nonce: string,
): V3HandoffCardInput {
  const node: V3GoalNode = request.node;
  const resultFields = node.resultSchema
    ? Object.entries(node.resultSchema.properties).map(([name, spec]) => ({
        name,
        type: spec.type,
        required: (node.resultSchema!.required ?? []).includes(name),
        ...(spec.type === 'string' && spec.enum ? { enum: [...spec.enum] } : {}),
      }))
    : [];
  return {
    runTitle: context.title,
    nodeId: request.loop ? request.loop.bodyNodeId : request.nodeId,
    attemptNumber: request.attemptNumber,
    ...(request.loop ? { loopIteration: request.loop.iteration } : {}),
    goal: node.goal ?? '',
    ...(context.acceptance ? { acceptance: context.acceptance } : {}),
    ...(node.override?.systemPromptAppend ? { extraInstructions: node.override.systemPromptAppend } : {}),
    inputs: request.inputs.inputs.map((input) => ({
      from: input.from,
      ...(input.output ? { output: input.output } : {}),
      name: input.name,
    })),
    omitted: (request.inputs.omitted ?? []).map((item) => ({ from: item.from, reason: item.reason })),
    outputs: Object.entries(node.outputs ?? {}).map(([key, declaration]) => ({
      key,
      path: declaration.path,
      kind: declaration.kind,
    })),
    resultFields,
    ...(node.revisitTo && node.revisitTo.length > 0 ? { revisitTo: [...node.revisitTo] } : {}),
    timeoutSec: request.timeoutSec,
    handoffRef,
    nonce,
    ...(request.retryOf ? {
      retryOf: {
        ...(request.retryOf.errorCode ? { errorCode: request.retryOf.errorCode } : {}),
        ...(request.retryOf.message ? { message: request.retryOf.message } : {}),
      },
    } : {}),
    ...(request.reassignedFrom ? { reassignedFrom: request.reassignedFrom } : {}),
    target,
  };
}

/** Topic key of a node: retries, revisits and later loop rounds share it. */
export function v3NodeTopicKey(attempt: { nodeId: string; loop?: { loopId: string; bodyNodeId: string } }): string {
  return attempt.loop ? `${attempt.loop.loopId}/${attempt.loop.bodyNodeId}` : attempt.nodeId;
}

/** Node cards this run has posted, by topic key — written the moment a card
 *  is sent, so a node whose handoff never got a Sent record (e.g. it ended
 *  HANDOFF_UNCERTAIN) still keeps a single topic and an up-to-date card. */
export const V3_HANDOFF_TOPICS_FILE = 'handoff-topics.json';

export function readV3HandoffTopics(runDir: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(runDir, V3_HANDOFF_TOPICS_FILE), 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && /^om_[A-Za-z0-9_-]{1,128}$/.test(entry[1])));
  } catch {
    return {};
  }
}

function recordV3HandoffTopic(runDir: string, topicKey: string, nodeCardMessageId: string): void {
  const topics = readV3HandoffTopics(runDir);
  if (topics[topicKey] === nodeCardMessageId) return;
  topics[topicKey] = nodeCardMessageId;
  const path = join(runDir, V3_HANDOFF_TOPICS_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(topics, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The node card of an earlier attempt of the same node. */
function previousNodeTopic(request: V3ExternalDispatchRequest): string | undefined {
  const wanted = v3NodeTopicKey(request);
  try {
    const attempts = [...foldV3ExternalAttempts(readJournal(join(request.runDir, 'journal.ndjson'))).values()];
    for (const attempt of attempts.reverse()) {
      if (attempt.attemptId === request.attemptId || !attempt.nodeCardMessageId) continue;
      if (v3NodeTopicKey(attempt) === wanted) return attempt.nodeCardMessageId;
    }
  } catch { /* fall back to the topic record */ }
  return readV3HandoffTopics(request.runDir)[wanted];
}

export function createV3BotHandoffExecutor(deps: V3BotHandoffExecutorDeps): V3ExternalNodeExecutor {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  /** attemptId → the identity check's transient failures so far. */
  const identityRetries = new Map<string, { firstAt: number; failures: number }>();

  /** The handoff's identity plan, retrying a check that could not run. */
  async function planIdentity(request: V3ExternalDispatchRequest): Promise<WorkflowHandoffIdentityPlan> {
    const identityDeps = deps.handoffIdentity;
    if (!identityDeps) return { kind: 'none' };
    for (const [attemptId, state] of identityRetries) {
      if (now() - state.firstAt > 10 * 60_000) identityRetries.delete(attemptId);
    }
    for (;;) {
      const state = identityRetries.get(request.attemptId);
      if (state) {
        const dueAt = state.firstAt + IDENTITY_CHECK_RETRY_DELAYS_MS.slice(0, state.failures).reduce((sum, ms) => sum + ms, 0);
        const wait = dueAt - now();
        // Nothing has been sent: an unknown outcome the engine re-sends later.
        if (wait > IDENTITY_CHECK_IN_CALL_WAIT_MAX_MS) {
          throw new Error(`identity check unavailable; retrying in ${Math.ceil(wait / 1000)} s`);
        }
        if (wait > 0) await sleep(wait, request.signal);
      }
      const plan = await identityDeps.plan(request);
      if (plan.kind !== 'unsigned' || !plan.transient) {
        identityRetries.delete(request.attemptId);
        return plan;
      }
      const next = { firstAt: state?.firstAt ?? now(), failures: (state?.failures ?? 0) + 1 };
      if (next.failures > IDENTITY_CHECK_RETRY_DELAYS_MS.length) {
        // Still unable to check: hand off without the initiator (never block
        // the node for an identity it may not need), saying why.
        identityRetries.delete(request.attemptId);
        return { kind: 'unsigned', note: `${plan.note}，已自动重试 ${IDENTITY_CHECK_RETRY_DELAYS_MS.length} 次` };
      }
      identityRetries.set(request.attemptId, next);
    }
  }

  async function dispatch(request: V3ExternalDispatchRequest): Promise<V3ExternalDispatchOutcome> {
    const binding = request.chatBinding;
    if (!binding?.chatId || !binding.rootMessageId) {
      return { kind: 'rejected', code: 'COLLABORATION_DENIED', message: 'the run has no chat topic to hand off into' };
    }
    const chatId = binding.chatId;
    const target = request.targetLarkAppId;
    const selfExecuted = target === deps.selfLarkAppId;
    const nodeCardUuid = request.idempotency.nodeCard;
    if (request.placement !== 'topic' || !nodeCardUuid) {
      // Main-topic placement is a later change; nothing is sent for it here.
      return { kind: 'rejected', code: 'COLLABORATION_DENIED', message: `placement "${request.placement}" is not supported yet` };
    }
    const secret = deps.bindingSecret();
    const nonce = workflowHandoffNonce(secret, request.idempotency.handoff);
    if (lookupWorkflowHandoffByNonceRevoked(nonce)) {
      return { kind: 'rejected', code: 'COLLABORATION_DENIED', message: 'the handoff was revoked before it was sent' };
    }

    // §6.3: re-check the target right before sending anything.
    if (!selfExecuted && !deps.isDaemonOnline(target)) {
      return { kind: 'rejected', code: 'BOT_OFFLINE', message: `${deps.botName(target)} 的 daemon 不在线` };
    }
    const dirRefusal = deps.workingDirPreflight?.(request);
    if (dirRefusal) return { kind: 'rejected', code: 'WORKING_DIR_REFUSED', message: dirRefusal };
    let mention: V3HandoffCardInput['target'] = { kind: 'self' };
    if (!selfExecuted) {
      const inChat = await deps.resolveTargetInChat(chatId, target);
      if (!inChat.ok) {
        if (inChat.code === 'UNKNOWN') throw new Error(`target membership unknown: ${inChat.message}`);
        return { kind: 'rejected', code: inChat.code, message: inChat.message };
      }
      const topics = await deps.targetOpensTopicSessions(chatId, target);
      if (topics === 'no') {
        return {
          kind: 'rejected',
          code: 'COLLABORATION_DENIED',
          message: `${deps.botName(target)} 在本群是「整群一个会话」模式，节点话题里的交接无法单独执行`,
        };
      }
      if (topics !== 'yes') throw new Error(`target topic sessions unknown: ${topics.unknown}`);
      try {
        await deps.ensureGrant(chatId, target);
      } catch (err) {
        return {
          kind: 'rejected',
          code: 'COLLABORATION_DENIED',
          message: `无法和 ${deps.botName(target)} 建立群内协作授权：${err instanceof Error ? err.message : String(err)}`,
        };
      }
      mention = { kind: 'bot', openId: inChat.openId };
    }
    // §10: the initiator goes along when the target can carry them; when not,
    // the node is handed off all the same, saying why (a tool that needs the
    // person asks for authorization when it is called).
    const identity = await planIdentity(request);
    const identityNote = identity.kind === 'unsigned' ? { identityNote: identity.note } : {};
    request.signal.throwIfAborted();

    const context = readRunCardContext(request.runDir, request.runId);
    const sketchId = request.loop ? request.loop.bodyNodeId : request.nodeId;
    const entry = deps.workflowEntry?.(request.runId);
    const content = (handoffRef: string): V3HandoffCardInput => ({
      ...v3HandoffContent(
        request,
        { title: context.title, acceptance: context.acceptanceBySketch.get(sketchId) },
        mention,
        handoffRef,
        nonce,
      ),
      ...identityNote,
      ...(entry ? { entry } : {}),
    });
    const nodeIndex = context.goalNodeIds.indexOf(request.loop ? request.loop.loopId : request.nodeId);
    const nodeCard = buildV3NodeCard({
      runTitle: context.title,
      runId: request.runId,
      nodeId: sketchId,
      ...(nodeIndex >= 0 ? { nodeIndex: nodeIndex + 1, nodeCount: context.goalNodeIds.length } : {}),
      botName: deps.botName(target),
      selfExecuted,
      attemptNumber: request.attemptNumber,
      ...(request.loop ? { loopIteration: request.loop.iteration } : {}),
      status: { kind: 'handing_off' },
      upstream: request.node.depends.map((dep) => ({ nodeId: dep.from, done: true })),
      now: now(),
      ...(entry ? { entry } : {}),
    });
    // Retries, revisits and later loop rounds of a node hand off again in the
    // node's existing topic (§5.4); only its first attempt opens one.
    const topicKey = v3NodeTopicKey(request);
    const existingTopic = previousNodeTopic(request);
    let nodeCardMessageId: string;
    if (existingTopic) {
      nodeCardMessageId = existingTopic;
      await deps.transport.patchCard(nodeCardMessageId, nodeCard).catch(() => undefined);
    } else {
      nodeCardMessageId = await deps.transport.sendCard(chatId, nodeCard, nodeCardUuid);
      recordV3HandoffTopic(request.runDir, topicKey, nodeCardMessageId);
    }
    request.signal.throwIfAborted();

    // Register the binding BEFORE the handoff exists: the receiver recognizes
    // the handoff by the nonce in the card and never waits for the id.
    const signed = createWorkflowHandoffBinding(secret, {
      nonce,
      publishRoot: nodeCardMessageId,
      targetLarkAppId: target,
      targetChatId: chatId,
      sourceLarkAppId: deps.selfLarkAppId,
      workflow: {
        runId: request.runId,
        nodeId: request.nodeId,
        ...(request.instanceId ? { instanceId: request.instanceId } : {}),
        attemptId: request.attemptId,
        revision: request.revision,
      },
      issuedAt: new Date(now()).toISOString(),
    });
    const recorded = await recordWorkflowHandoffBinding(deps.dataDir, secret, signed);
    if (recorded.revoked) {
      return { kind: 'rejected', code: 'COLLABORATION_DENIED', message: 'the handoff was revoked before it was sent' };
    }

    const planned = planV3HandoffCard(content(WORKFLOW_HANDOFF_ID_PLACEHOLDER), WORKFLOW_HANDOFF_TASK_FILE);
    if (planned.overflowTask !== undefined) {
      // The receiver stages it next to the inputs (readWorkflowAttemptInputs).
      writeFileSync(join(request.attemptDir, WORKFLOW_HANDOFF_TASK_FILE), planned.overflowTask, { mode: 0o600 });
    }
    const overflow = planned.overflowTask !== undefined ? { overflowAttachment: WORKFLOW_HANDOFF_TASK_FILE } : {};
    const sendHandoff = () => deps.transport.replyCard(nodeCardMessageId, planned.card, request.idempotency.handoff);
    // Star issuance (§10.2): signed here, from the run, for this attempt only.
    const handoffMessageId = identity.kind === 'sign'
      ? await deps.handoffIdentity!.deliver({
          authority: identity.authority,
          targetLarkAppId: target,
          chatId,
          rootId: nodeCardMessageId,
          workflow: {
            runId: request.runId,
            nodeId: request.nodeId,
            ...(request.instanceId ? { instanceId: request.instanceId } : {}),
            attemptId: request.attemptId,
            revision: request.revision,
            nonce,
          },
          send: sendHandoff,
        })
      : await sendHandoff();
    await linkWorkflowHandoffMessage(deps.dataDir, secret, nonce, handoffMessageId);

    // Show the real id in the visible commands (best-effort: the receiving
    // daemon substitutes it in the turn either way).
    await deps.transport.patchCard(handoffMessageId, buildV3HandoffCard({ ...content(handoffMessageId), ...overflow }))
      .catch(() => undefined);

    if (selfExecuted) {
      // A cancel / timeout / reassignment may have landed while the cards were
      // in flight; its stop() revoked the binding. Never start a stale turn.
      request.signal.throwIfAborted();
      if (lookupWorkflowHandoffByNonceRevoked(nonce)) return { kind: 'sent', handoffMessageId, nodeCardMessageId };
      const current = classifyExternalAttempt(readJournal(join(request.runDir, 'journal.ndjson')), request.attemptId);
      if (!current.ok) return { kind: 'sent', handoffMessageId, nodeCardMessageId };
      const body = v3HandoffBodyText({ ...content(handoffMessageId), ...overflow });
      await deps.startSelfTurn({
        chatId,
        publishRoot: nodeCardMessageId,
        handoffMessageId,
        marker: {
          runId: request.runId,
          nodeId: request.nodeId,
          ...(request.instanceId ? { instanceId: request.instanceId } : {}),
          attemptId: request.attemptId,
          handoffMessageId,
          nonce,
          publishRoot: nodeCardMessageId,
          orchestratorAppId: deps.selfLarkAppId,
          registeredAt: new Date(now()).toISOString(),
        },
        prompt: `【工作流任务】${context.title} · ${sketchId}（第 ${request.attemptNumber} 次）\n\n${body}`,
        sessionTitle: `工作流 ${context.title} · ${sketchId}`,
        inputs: request.inputs,
        runDir: request.runDir,
        ...(identity.kind === 'sign' ? { identityDelegated: true as const } : {}),
      });
    }
    return { kind: 'sent', handoffMessageId, nodeCardMessageId };
  }

  /** A revocation can precede the binding (stop before the send finished). */
  function lookupWorkflowHandoffByNonceRevoked(nonce: string): boolean {
    return isWorkflowHandoffRevoked(readDispatchRegistryLoose(deps.dataDir), nonce, deps.bindingSecret());
  }

  async function probeAcceptance(
    ref: V3ExternalAttemptRef & { handoffMessageId: string },
  ): Promise<V3ExternalAcceptanceProbe> {
    const found = lookupWorkflowHandoff({
      registry: readDispatchRegistryLoose(deps.dataDir),
      dispatchRoot: ref.handoffMessageId,
      secret: deps.bindingSecret(),
    });
    if (found.kind !== 'workflow' || found.binding.sourceLarkAppId !== deps.selfLarkAppId) {
      throw new Error(`no workflow handoff binding for ${ref.handoffMessageId}`);
    }
    const accepted = deps.findAcceptance({
      targetLarkAppId: ref.targetLarkAppId,
      chatId: found.binding.targetChatId,
      publishRoot: found.binding.publishRoot,
      handoffMessageId: ref.handoffMessageId,
    });
    if (accepted) {
      return { status: 'accepted', sessionId: accepted.sessionId, ...(accepted.acceptedAt !== undefined ? { acceptedAt: accepted.acceptedAt } : {}) };
    }
    // The target's daemon refused it (its direct notice may never have
    // arrived): keep its reason in the not-accepted verdict.
    return found.refusal ? { status: 'notAccepted', detail: found.refusal } : { status: 'notAccepted' };
  }

  async function stop(request: V3ExternalStopRequest): Promise<void> {
    // Before Prepared nothing can have been sent (the engine never calls us
    // then); the idempotency keys always name the handoff's nonce.
    if (!request.idempotency) return;
    const secret = deps.bindingSecret();
    const nonce = workflowHandoffNonce(secret, request.idempotency.handoff);
    // Revoke first: the receiver drops a not-yet-delivered handoff, and every
    // report for it is refused, whatever happens to the stop below.
    await revokeWorkflowHandoff(deps.dataDir, secret, nonce, request.reason, now());
    const found = lookupWorkflowHandoffByNonce({ registry: readDispatchRegistryLoose(deps.dataDir), nonce, secret });
    const handoffMessageId = request.handoffMessageId ?? (found.kind === 'workflow' ? found.messageId : undefined);
    await deps.stopTarget({
      targetLarkAppId: request.targetLarkAppId,
      nonce,
      ...(handoffMessageId ? { handoffMessageId } : {}),
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      reason: request.reason,
    });
  }

  return { dispatch, probeAcceptance, stop };
}
