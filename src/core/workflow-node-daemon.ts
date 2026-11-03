/**
 * Daemon wiring for "节点交给群里的 Bot 执行" (design 2026-11-03, PR 5a).
 *
 * One object per daemon process. It is consulted only by:
 * - runs whose `run.json` pins `nodeExecutor: "bot"` (the gate runner never
 *   hands the executor to any other run), and
 * - messages / reports / turns that carry a host-signed workflow handoff
 *   binding or a session marker written after verifying one.
 * With the experimental switch off no such run, binding or marker is ever
 * created, so every entry point below is a no-op for existing behaviour.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { V3_RUN_ENVELOPE_FILE } from '../workflows/v3/run-envelope.js';
import type { V3Dag } from '../workflows/v3/dag.js';
import type { V3ExternalNodeExecutor } from '../workflows/v3/external-executor.js';
import { v3AcceptanceProbeUnknownSince } from '../workflows/v3/runtime.js';
import { isValidRunId } from '../workflows/v3/ops-projection.js';
import type { LarkAttachment, WorkflowNodeSessionMarker } from '../types.js';
import type { DaemonSession } from './types.js';
import {
  isWorkflowHandoffRevoked,
  readDispatchRegistryLoose,
  resolveInboundWorkflowHandoff,
  type InboundWorkflowHandoff,
  type WorkflowHandoffBindingPayload,
} from './workflow-handoff-binding.js';
import {
  findWorkflowHandoffAcceptance,
  readWorkflowAttemptInputs,
  stageWorkflowNodeInputs,
  type HandoffAcceptanceSession,
} from './workflow-node-session.js';
import {
  WORKFLOW_HANDOFF_EVENT_ROUTE,
  WORKFLOW_HANDOFF_STOP_ROUTE,
} from './workflow-node-report.js';
import {
  handleWorkflowHandoffEvent,
  handleWorkflowHandoffStop,
  handleWorkflowNodeReport,
  loadWorkflowNodeContract,
  readWorkflowHandoffActivity,
  stageWorkflowNodeSubmission,
  type RouteResult,
  type WorkflowHandoffEvent,
  type WorkflowNodeReportSession,
} from './workflow-handoff-routes.js';
import { createV3BotHandoffExecutor, readV3HandoffTopics, type V3SelfTurnRequest } from '../im/lark/v3-bot-handoff-executor.js';
import { createV3NodeCardSync } from '../im/lark/v3-node-card-sync.js';
import { buildV3NodeReportCard } from '../im/lark/v3-node-card.js';

export interface WorkflowNodeDaemonDeps {
  selfLarkAppId(): string;
  dataDir(): string;
  baseDir(): string;
  sendCard(chatId: string, cardJson: string, uuid: string): Promise<string>;
  replyCard(rootMessageId: string, cardJson: string, uuid?: string): Promise<string>;
  patchCard(messageId: string, cardJson: string): Promise<void>;
  /** Strict live membership via the main bot's app (dispatch's resolver). */
  resolveBotInChat(chatId: string, targetLarkAppId: string): Promise<
    | { ok: true; openId: string }
    | { ok: false; notInChat: boolean; message: string }
  >;
  /** §6.1 item 7 for the target bot in this chat. */
  targetOpensTopicSessions(chatId: string, targetLarkAppId: string): Promise<'yes' | 'no' | { unknown: string }>;
  daemonPort(larkAppId: string): number | undefined;
  hostSecret(): string;
  bindingSecret(): string;
  postDaemon(port: number, path: string, body: unknown, secret: string): Promise<RouteResult>;
  ensureGrant(chatId: string, larkAppIds: string[]): Promise<void>;
  loadSessions(): Iterable<HandoffAcceptanceSession>;
  isProcessAlive(pid: number): boolean;
  activeSessions(): Iterable<DaemonSession>;
  updateSession(ds: DaemonSession): void;
  /** Send ^C to the session's CLI (the "停止" path); false = not possible.
   *  `evenIfIdle`: the turn is known to have just been handed in (its screen
   *  may not show it yet) — used only for a handoff revoked under it. */
  interruptTurn(ds: DaemonSession, opts?: { evenIfIdle?: boolean }): boolean;
  /** Positive proof that an inbound message's sender is `sourceLarkAppId`'s
   *  bot in this chat, as seen by `receiverLarkAppId` (app-scoped open_id).
   *  Unknown / failed lookups must answer false. */
  proveBotSender(input: { receiverLarkAppId: string; chatId: string; senderOpenId: string | undefined; sourceLarkAppId: string }): Promise<boolean>;
  /** Re-try a best-effort notice once after this many ms (default 3 s). */
  noticeRetryMs?: number;
  deliverSelfTurn(input: {
    larkAppId: string;
    chatId: string;
    publishRoot: string;
    handoffMessageId: string;
    marker: WorkflowNodeSessionMarker;
    prompt: string;
    attachments: LarkAttachment[];
    sessionTitle: string;
  }): Promise<{ sessionId: string }>;
  attachmentsDir(larkAppId: string, messageId: string): string;
  loadRun(runDir: string): { dag: V3Dag; nodeExecutor?: 'bot'; chatId?: string; title: string } | undefined;
  drive(runId: string): void;
  botName(larkAppId: string): string;
  warn(message: string): void;
}

export interface WorkflowNodeDaemon {
  executor: V3ExternalNodeExecutor;
  syncNodeCards(runId: string): Promise<void>;
  eventRoute(raw: unknown): Promise<RouteResult>;
  reportRoute(raw: unknown, authorize: (raw: unknown) => { ok: true; session: WorkflowNodeReportSession } | { ok: false; status: number; error: string }): Promise<RouteResult>;
  stopRoute(raw: unknown): RouteResult;
  /** Whether an inbound bot message in a thread addressed to
   *  `receiverLarkAppId` (the bot whose routing context received it) is a
   *  workflow handoff — or a revoked one, which must be dropped. */
  resolveInbound(input: {
    receiverLarkAppId: string;
    messageId: string;
    content: string;
    chatId: string;
    threadRootId: string | undefined;
    senderOpenId: string | undefined;
  }): Promise<InboundWorkflowHandoff | undefined>;
  /** The handoff was stopped (revoked) — checked again right before a turn
   *  for it starts. */
  isRevoked(nonce: string): boolean;
  /** Copy the node's upstream products into this turn's attachment dir. */
  stageInbound(binding: WorkflowHandoffBindingPayload, messageId: string): LarkAttachment[];
  /** A session just registered a verified handoff: the node is accepted
   *  (unless it was revoked meanwhile — then its turn is stopped). */
  onRegistered(sessionId: string, marker: WorkflowNodeSessionMarker): void;
  onInputCommitted(ds: DaemonSession, context: { turnId: string; committedAt: number }): void;
  onTurnSettled(ds: DaemonSession, context: { turnId?: string; at: number }): void;
}

export function createWorkflowNodeDaemon(deps: WorkflowNodeDaemonDeps): WorkflowNodeDaemon {
  const runDirOf = (runId: string): string | undefined =>
    isValidRunId(runId) ? join(deps.baseDir(), runId) : undefined;

  async function forward(orchestratorAppId: string, event: WorkflowHandoffEvent): Promise<RouteResult> {
    // The main bot's own nodes are settled in-process; no IPC hop.
    if (orchestratorAppId === deps.selfLarkAppId()) return eventRoute(event);
    const port = deps.daemonPort(orchestratorAppId);
    if (!port) {
      return {
        status: 503,
        body: { ok: false, error: 'orchestrator_offline', message: '主 Bot 的 daemon 不在线' },
      };
    }
    return deps.postDaemon(port, WORKFLOW_HANDOFF_EVENT_ROUTE, event, deps.hostSecret());
  }

  function eventRoute(raw: unknown): Promise<RouteResult> {
    return handleWorkflowHandoffEvent(raw, {
      selfLarkAppId: deps.selfLarkAppId(),
      baseDir: deps.baseDir(),
      readRegistry: () => readDispatchRegistryLoose(deps.dataDir()),
      secret: deps.bindingSecret,
      loadRun: deps.loadRun,
      drive: deps.drive,
    });
  }

  function stopHandoffTurn(nonce: string, sessionId: string | undefined, opts?: { evenIfIdle?: boolean }): boolean {
    for (const ds of deps.activeSessions()) {
      const marker = ds.session.workflowNode;
      if (!marker || marker.nonce !== nonce) continue;
      if (sessionId && ds.session.sessionId !== sessionId) continue;
      return deps.interruptTurn(ds, opts);
    }
    return false;
  }

  function isRevoked(nonce: string): boolean {
    return isWorkflowHandoffRevoked(readDispatchRegistryLoose(deps.dataDir()), nonce, deps.bindingSecret());
  }

  const executor = createV3BotHandoffExecutor({
    get selfLarkAppId() { return deps.selfLarkAppId(); },
    get dataDir() { return deps.dataDir(); },
    transport: {
      sendCard: deps.sendCard,
      replyCard: (root, card, uuid) => deps.replyCard(root, card, uuid),
      patchCard: deps.patchCard,
    },
    resolveTargetInChat: async (chatId, target) => {
      try {
        const resolved = await deps.resolveBotInChat(chatId, target);
        if (resolved.ok) return { ok: true, openId: resolved.openId };
        return resolved.notInChat
          ? { ok: false, code: 'BOT_NOT_IN_CHAT', message: `${deps.botName(target)} 不在本群` }
          : { ok: false, code: 'UNKNOWN', message: resolved.message };
      } catch (err) {
        return { ok: false, code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) };
      }
    },
    targetOpensTopicSessions: deps.targetOpensTopicSessions,
    isDaemonOnline: (appId) => deps.daemonPort(appId) !== undefined,
    ensureGrant: (chatId, target) => deps.ensureGrant(chatId, [deps.selfLarkAppId(), target]),
    bindingSecret: deps.bindingSecret,
    botName: deps.botName,
    findAcceptance: (input) => findWorkflowHandoffAcceptance({
      sessions: deps.loadSessions(),
      ...input,
      isWorkerAlive: deps.isProcessAlive,
    }),
    stopTarget: async (input) => {
      if (input.targetLarkAppId === deps.selfLarkAppId()) {
        stopHandoffTurn(input.nonce, input.sessionId);
        return;
      }
      const port = deps.daemonPort(input.targetLarkAppId);
      if (!port) throw new Error(`target daemon ${input.targetLarkAppId} is offline`);
      const result = await deps.postDaemon(port, WORKFLOW_HANDOFF_STOP_ROUTE, {
        nonce: input.nonce,
        ...(input.handoffMessageId ? { dispatchRoot: input.handoffMessageId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        reason: input.reason,
      }, deps.hostSecret());
      if (result.status >= 400) throw new Error(`stop failed: ${String(result.body.error ?? result.status)}`);
    },
    startSelfTurn: async (input: V3SelfTurnRequest) => {
      const runDir = input.runDir;
      const inputs = readWorkflowAttemptInputs(runDir, input.marker.attemptId) ?? input.inputs;
      const staged = stageWorkflowNodeInputs({
        runDir,
        inputs,
        attachmentsDir: deps.attachmentsDir(deps.selfLarkAppId(), input.handoffMessageId),
      });
      for (const skipped of staged.skipped) {
        deps.warn(`[workflow] input ${skipped.from}/${skipped.name} not staged: ${skipped.reason}`);
      }
      const started = await deps.deliverSelfTurn({
        larkAppId: deps.selfLarkAppId(),
        chatId: input.chatId,
        publishRoot: input.publishRoot,
        handoffMessageId: input.handoffMessageId,
        marker: input.marker,
        prompt: input.prompt,
        attachments: staged.attachments,
        sessionTitle: input.sessionTitle,
      });
      // The session registered the handoff: record acceptance now rather than
      // at the acceptance deadline's probe (which would find the same marker).
      registered(started.sessionId, input.marker);
      return started;
    },
  });

  const syncNodeCards = createV3NodeCardSync({
    get baseDir() { return deps.baseDir(); },
    get selfLarkAppId() { return deps.selfLarkAppId(); },
    loadRun: deps.loadRun,
    patchCard: deps.patchCard,
    botName: deps.botName,
    acceptanceUnknownSince: v3AcceptanceProbeUnknownSince,
    activity: readWorkflowHandoffActivity,
    topicCards: readV3HandoffTopics,
  });

  function notify(
    event: WorkflowHandoffEvent,
    orchestratorAppId: string,
    onResult?: (result: RouteResult) => void,
  ): void {
    void forward(orchestratorAppId, event).then((result) => {
      onResult?.(result);
      if (result.status >= 400 && result.status !== 409) {
        deps.warn(`[workflow] ${event.kind} notice for ${event.nonce} failed: ${String(result.body.error ?? result.status)}`);
      }
    }).catch((err) => deps.warn(`[workflow] ${event.kind} notice for ${event.nonce} failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** The main bot says this handoff was stopped: stop its turn here too. */
  function stopIfRevoked(result: RouteResult, sessionId: string, nonce: string): void {
    if (result.status === 409 && result.body.error === 'handoff_revoked') {
      stopHandoffTurn(nonce, sessionId, { evenIfIdle: true });
    }
  }

  function registered(sessionId: string, marker: WorkflowNodeSessionMarker): void {
    // A stop may have landed between recognizing the handoff and registering
    // it: then the turn must not run.
    if (isRevoked(marker.nonce)) {
      stopHandoffTurn(marker.nonce, sessionId, { evenIfIdle: true });
      return;
    }
    const acceptedAt = Date.parse(marker.registeredAt);
    notify({
      kind: 'accepted',
      nonce: marker.nonce,
      dispatchRoot: marker.handoffMessageId,
      sessionId,
      ...(Number.isFinite(acceptedAt) ? { acceptedAt } : {}),
    }, marker.orchestratorAppId, (result) => stopIfRevoked(result, sessionId, marker.nonce));
  }

  function openMarker(ds: DaemonSession): WorkflowNodeSessionMarker | undefined {
    const marker = ds.session.workflowNode;
    return marker && !marker.submittedAt ? marker : undefined;
  }

  const MAX_TRACKED_TURNS = 32;

  function wake(binding: WorkflowHandoffBindingPayload, sessionId: string): void {
    const event: WorkflowHandoffEvent = { kind: 'wake', nonce: binding.nonce, sessionId };
    const attempt = (retry: boolean) => {
      void forward(binding.sourceLarkAppId, event).then((result) => {
        if (result.status === 200 || !retry) return;
        const timer = setTimeout(() => attempt(false), deps.noticeRetryMs ?? 3_000);
        timer.unref?.();
      }).catch(() => undefined);
    };
    attempt(true);
  }

  return {
    executor,
    syncNodeCards: async (runId) => {
      const runDir = runDirOf(runId);
      // Cheap guard: only runs with an envelope can be bot-executed.
      if (!runDir || !existsSync(join(runDir, V3_RUN_ENVELOPE_FILE))) return;
      await syncNodeCards(runId);
    },
    eventRoute,
    reportRoute: (raw, authorize) => handleWorkflowNodeReport(raw, {
      selfLarkAppId: deps.selfLarkAppId(),
      authorize,
      readRegistry: () => readDispatchRegistryLoose(deps.dataDir()),
      secret: deps.bindingSecret,
      loadNodeContract: (binding) => {
        const runDir = runDirOf(binding.workflow.runId);
        const run = runDir ? deps.loadRun(runDir) : undefined;
        if (!runDir || !run) return undefined;
        try {
          return loadWorkflowNodeContract(runDir, run.dag, binding.workflow.attemptId);
        } catch {
          return undefined;
        }
      },
      forward: (binding, event) => forward(binding.sourceLarkAppId, event),
      stageSubmission: async (binding, input) => {
        const runDir = runDirOf(binding.workflow.runId);
        const run = runDir ? deps.loadRun(runDir) : undefined;
        if (!run) return { status: 409, body: { ok: false, error: 'run_not_bot_executed' } };
        return stageWorkflowNodeSubmission(deps.baseDir(), binding, run.dag, input);
      },
      wake,
      markSubmitted: (sessionId, nonce) => {
        for (const ds of deps.activeSessions()) {
          if (ds.session.sessionId !== sessionId || ds.session.workflowNode?.nonce !== nonce) continue;
          ds.session.workflowNode = { ...ds.session.workflowNode, submittedAt: new Date().toISOString() };
          deps.updateSession(ds);
        }
      },
      postReportCard: async (binding, input) => {
        await deps.replyCard(binding.publishRoot, buildV3NodeReportCard({
          nodeId: binding.workflow.nodeId,
          botName: deps.botName(deps.selfLarkAppId()),
          ...input,
        }));
      },
    }),
    stopRoute: (raw) => handleWorkflowHandoffStop(raw, {
      selfLarkAppId: deps.selfLarkAppId(),
      readRegistry: () => readDispatchRegistryLoose(deps.dataDir()),
      secret: deps.bindingSecret,
      stopHandoffTurn,
    }),
    resolveInbound: (input) => resolveInboundWorkflowHandoff({
      readRegistry: () => readDispatchRegistryLoose(deps.dataDir()),
      secret: deps.bindingSecret,
      messageId: input.messageId,
      content: input.content,
      chatId: input.chatId,
      threadRootId: input.threadRootId,
      selfLarkAppId: input.receiverLarkAppId,
      proveSender: async (sourceLarkAppId) => {
        try {
          return await deps.proveBotSender({
            receiverLarkAppId: input.receiverLarkAppId,
            chatId: input.chatId,
            senderOpenId: input.senderOpenId,
            sourceLarkAppId,
          });
        } catch {
          return false;
        }
      },
    }),
    isRevoked,
    stageInbound: (binding, messageId) => {
      const runDir = runDirOf(binding.workflow.runId);
      const inputs = runDir ? readWorkflowAttemptInputs(runDir, binding.workflow.attemptId) : undefined;
      if (!runDir || !inputs) return [];
      const staged = stageWorkflowNodeInputs({
        runDir,
        inputs,
        // A verified binding names exactly the receiving bot.
        attachmentsDir: deps.attachmentsDir(binding.targetLarkAppId, messageId),
      });
      for (const skipped of staged.skipped) {
        deps.warn(`[workflow] input ${skipped.from}/${skipped.name} not staged: ${skipped.reason}`);
      }
      return staged.attachments;
    },
    onRegistered: registered,
    onInputCommitted: (ds, context) => {
      const marker = openMarker(ds);
      if (!marker) return;
      const sessionId = ds.session.sessionId;
      if (isRevoked(marker.nonce)) {
        // Stopped while this turn was being handed in: stop it now.
        stopHandoffTurn(marker.nonce, sessionId, { evenIfIdle: true });
        return;
      }
      // Remember every turn started under this handoff: any of them ending
      // without a submission shows the node as stopped.
      if (!marker.turnIds?.includes(context.turnId)) {
        ds.session.workflowNode = { ...marker, turnIds: [...(marker.turnIds ?? []), context.turnId].slice(-MAX_TRACKED_TURNS) };
        deps.updateSession(ds);
      }
      // The handoff's own turn is the acceptance; any later turn (a human
      // replied in the topic) means the bot works again after a stall.
      notify(marker.handoffMessageId === context.turnId
        ? { kind: 'accepted', nonce: marker.nonce, dispatchRoot: marker.handoffMessageId, sessionId, acceptedAt: context.committedAt }
        : { kind: 'active', nonce: marker.nonce, dispatchRoot: marker.handoffMessageId, sessionId, at: context.committedAt },
      marker.orchestratorAppId, (result) => stopIfRevoked(result, sessionId, marker.nonce));
    },
    onTurnSettled: (ds, context) => {
      const marker = openMarker(ds);
      if (!marker || !context.turnId) return;
      // Only turns started under this handoff: an idle edge of a turn that
      // was already in flight before it was registered must not stall it.
      if (context.turnId !== marker.handoffMessageId && !marker.turnIds?.includes(context.turnId)) return;
      notify({ kind: 'stalled', nonce: marker.nonce, dispatchRoot: marker.handoffMessageId, sessionId: ds.session.sessionId, at: context.at },
        marker.orchestratorAppId);
    },
  };
}
