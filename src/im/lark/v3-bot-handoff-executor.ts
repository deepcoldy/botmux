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

import { readFileSync } from 'node:fs';
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
import {
  WORKFLOW_HANDOFF_PENDING_TTL_MS,
  createWorkflowHandoffBinding,
  lookupWorkflowHandoff,
  recordWorkflowHandoffBinding,
  recordWorkflowHandoffPending,
  readDispatchRegistryLoose,
  type WorkflowHandoffBindingPayload,
} from '../../core/workflow-handoff-binding.js';
import type { WorkflowNodeSessionMarker } from '../../types.js';
import { foldV3ExternalAttempts } from '../../workflows/v3/external-attempt-ledger.js';
import { readJournal } from '../../workflows/v3/journal.js';
import {
  WORKFLOW_HANDOFF_ID_PLACEHOLDER,
  buildV3HandoffCard,
  buildV3NodeCard,
  v3HandoffBodyText,
  type V3HandoffCardInput,
} from './v3-node-card.js';

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
}

export interface V3BotHandoffExecutorDeps {
  selfLarkAppId: string;
  dataDir: string;
  transport: V3BotHandoffTransport;
  resolveTargetInChat(chatId: string, targetLarkAppId: string): Promise<V3TargetInChat>;
  isDaemonOnline(larkAppId: string): boolean;
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
  /** Stop the target's current turn for this handoff (best-effort). */
  stopTarget(input: {
    targetLarkAppId: string;
    handoffMessageId: string;
    sessionId?: string;
    reason: V3ExternalStopReason;
  }): Promise<void>;
  /** §6.5: open the main bot's own node session; idempotent per handoff. */
  startSelfTurn(input: V3SelfTurnRequest): Promise<{ sessionId: string }>;
  now?(): number;
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

/** The node card of an earlier attempt of the same node (same authored node,
 *  or the same loop body across rounds), newest first. */
function previousNodeTopic(request: V3ExternalDispatchRequest): string | undefined {
  let attempts;
  try {
    attempts = [...foldV3ExternalAttempts(readJournal(join(request.runDir, 'journal.ndjson'))).values()];
  } catch {
    return undefined;
  }
  const key = (attempt: { nodeId: string; loop?: { loopId: string; bodyNodeId: string } }) =>
    attempt.loop ? `${attempt.loop.loopId}/${attempt.loop.bodyNodeId}` : attempt.nodeId;
  const wanted = key(request);
  for (const attempt of attempts.reverse()) {
    if (attempt.attemptId === request.attemptId || !attempt.nodeCardMessageId) continue;
    if (key(attempt) === wanted) return attempt.nodeCardMessageId;
  }
  return undefined;
}

export function createV3BotHandoffExecutor(deps: V3BotHandoffExecutorDeps): V3ExternalNodeExecutor {
  const now = deps.now ?? Date.now;
  // handoff id → where it lives. Rebuilt from the signed registry after a
  // restart; the journal never needs it.
  const placements = new Map<string, Pick<WorkflowHandoffBindingPayload, 'targetChatId' | 'publishRoot' | 'targetLarkAppId'>>();

  function placementOf(handoffMessageId: string) {
    const cached = placements.get(handoffMessageId);
    if (cached) return cached;
    const found = lookupWorkflowHandoff({
      registry: readDispatchRegistryLoose(deps.dataDir),
      dispatchRoot: handoffMessageId,
      secret: deps.bindingSecret(),
    });
    if (found.kind !== 'workflow' || found.binding.sourceLarkAppId !== deps.selfLarkAppId) return undefined;
    placements.set(handoffMessageId, found.binding);
    return found.binding;
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

    // §6.3: re-check the target right before sending anything.
    let mention: V3HandoffCardInput['target'] = { kind: 'self' };
    if (!selfExecuted) {
      if (!deps.isDaemonOnline(target)) {
        return { kind: 'rejected', code: 'BOT_OFFLINE', message: `${deps.botName(target)} 的 daemon 不在线` };
      }
      const inChat = await deps.resolveTargetInChat(chatId, target);
      if (!inChat.ok) {
        if (inChat.code === 'UNKNOWN') throw new Error(`target membership unknown: ${inChat.message}`);
        return { kind: 'rejected', code: inChat.code, message: inChat.message };
      }
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
    request.signal.throwIfAborted();

    const context = readRunCardContext(request.runDir, request.runId);
    const sketchId = request.loop ? request.loop.bodyNodeId : request.nodeId;
    const content = (handoffRef: string) => v3HandoffContent(
      request,
      { title: context.title, acceptance: context.acceptanceBySketch.get(sketchId) },
      mention,
      handoffRef,
    );
    const nodeIndex = context.goalNodeIds.indexOf(request.loop ? request.loop.loopId : request.nodeId);
    const nodeCard = buildV3NodeCard({
      runTitle: context.title,
      runId: request.runId,
      nodeId: content(WORKFLOW_HANDOFF_ID_PLACEHOLDER).nodeId,
      ...(nodeIndex >= 0 ? { nodeIndex: nodeIndex + 1, nodeCount: context.goalNodeIds.length } : {}),
      botName: deps.botName(target),
      selfExecuted,
      attemptNumber: request.attemptNumber,
      ...(request.loop ? { loopIteration: request.loop.iteration } : {}),
      status: { kind: 'handing_off' },
      upstream: request.node.depends.map((dep) => ({ nodeId: dep.from, done: true })),
      now: now(),
    });
    // Retries, revisits and later loop rounds of a node hand off again in the
    // node's existing topic (§5.4); only its first attempt opens one.
    const existingTopic = previousNodeTopic(request);
    let nodeCardMessageId: string;
    if (existingTopic) {
      nodeCardMessageId = existingTopic;
      await deps.transport.patchCard(nodeCardMessageId, nodeCard).catch(() => undefined);
    } else {
      nodeCardMessageId = await deps.transport.sendCard(chatId, nodeCard, nodeCardUuid);
    }
    request.signal.throwIfAborted();

    if (!selfExecuted) {
      await recordWorkflowHandoffPending(deps.dataDir, request.idempotency.handoff, {
        chatId,
        publishRoot: nodeCardMessageId,
        targetLarkAppId: target,
        expiresAt: now() + WORKFLOW_HANDOFF_PENDING_TTL_MS,
      }, now());
    }
    const handoffMessageId = await deps.transport.replyCard(
      nodeCardMessageId,
      buildV3HandoffCard(content(WORKFLOW_HANDOFF_ID_PLACEHOLDER)),
      request.idempotency.handoff,
    );

    const signed = createWorkflowHandoffBinding(deps.bindingSecret(), {
      dispatchRoot: handoffMessageId,
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
    await recordWorkflowHandoffBinding(deps.dataDir, request.idempotency.handoff, signed, now());
    placements.set(handoffMessageId, signed.payload);

    // Show the real id in the visible commands (best-effort: the receiving
    // daemon substitutes it in the turn either way).
    await deps.transport.patchCard(handoffMessageId, buildV3HandoffCard(content(handoffMessageId))).catch(() => undefined);

    if (selfExecuted) {
      const body = v3HandoffBodyText(content(handoffMessageId));
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
          publishRoot: nodeCardMessageId,
          orchestratorAppId: deps.selfLarkAppId,
          registeredAt: new Date(now()).toISOString(),
        },
        prompt: `【工作流任务】${context.title} · ${content(handoffMessageId).nodeId}（第 ${request.attemptNumber} 次）\n\n${body}`,
        sessionTitle: `工作流 ${context.title} · ${content(handoffMessageId).nodeId}`,
        inputs: request.inputs,
        runDir: request.runDir,
      });
    }
    return { kind: 'sent', handoffMessageId, nodeCardMessageId };
  }

  async function probeAcceptance(
    ref: V3ExternalAttemptRef & { handoffMessageId: string },
  ): Promise<V3ExternalAcceptanceProbe> {
    const placement = placementOf(ref.handoffMessageId);
    if (!placement) throw new Error(`no workflow handoff binding for ${ref.handoffMessageId}`);
    const accepted = deps.findAcceptance({
      targetLarkAppId: ref.targetLarkAppId,
      chatId: placement.targetChatId,
      publishRoot: placement.publishRoot,
      handoffMessageId: ref.handoffMessageId,
    });
    return accepted
      ? { status: 'accepted', sessionId: accepted.sessionId, ...(accepted.acceptedAt !== undefined ? { acceptedAt: accepted.acceptedAt } : {}) }
      : { status: 'notAccepted' };
  }

  async function stop(request: V3ExternalStopRequest): Promise<void> {
    // Without a handoff id nothing reached a session this host can name.
    if (!request.handoffMessageId) return;
    await deps.stopTarget({
      targetLarkAppId: request.targetLarkAppId,
      handoffMessageId: request.handoffMessageId,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      reason: request.reason,
    });
  }

  return { dispatch, probeAcceptance, stop };
}
