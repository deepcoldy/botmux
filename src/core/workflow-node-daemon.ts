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

import { join } from 'node:path';

import { V3_RUN_ENVELOPE_FILE } from '../workflows/v3/run-envelope.js';
import type { V3Dag } from '../workflows/v3/dag.js';
import type { V3ExternalNodeExecutor } from '../workflows/v3/external-executor.js';
import { v3AcceptanceProbeUnknownSince } from '../workflows/v3/runtime.js';
import type { LarkAttachment, WorkflowNodeSessionMarker } from '../types.js';
import type { DaemonSession } from './types.js';
import {
  readDispatchRegistryLoose,
  resolveInboundWorkflowHandoff,
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
  type RouteResult,
  type WorkflowHandoffEvent,
  type WorkflowNodeReportSession,
} from './workflow-handoff-routes.js';
import { createV3BotHandoffExecutor, type V3SelfTurnRequest } from '../im/lark/v3-bot-handoff-executor.js';
import { createV3NodeCardSync } from '../im/lark/v3-node-card-sync.js';
import { buildV3NodeReportCard } from '../im/lark/v3-node-card.js';
import { existsSync } from 'node:fs';
import { isValidRunId } from '../workflows/v3/ops-projection.js';

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
  daemonPort(larkAppId: string): number | undefined;
  hostSecret(): string;
  bindingSecret(): string;
  postDaemon(port: number, path: string, body: unknown, secret: string): Promise<RouteResult>;
  ensureGrant(chatId: string, larkAppIds: string[]): Promise<void>;
  loadSessions(): Iterable<HandoffAcceptanceSession>;
  isProcessAlive(pid: number): boolean;
  activeSessions(): Iterable<DaemonSession>;
  updateSession(ds: DaemonSession): void;
  /** Send ^C to the session's CLI (the "停止" path); false = not possible. */
  interruptTurn(ds: DaemonSession): boolean;
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
  /** The verified binding of an inbound bot message in a thread addressed to
   *  `receiverLarkAppId` (the bot whose routing context received it), if any. */
  resolveInbound(input: {
    receiverLarkAppId: string;
    messageId: string;
    chatId: string;
    threadRootId: string | undefined;
  }): Promise<WorkflowHandoffBindingPayload | undefined>;
  /** Copy the node's upstream products into this turn's attachment dir. */
  stageInbound(binding: WorkflowHandoffBindingPayload): LarkAttachment[];
  /** A session just registered a verified handoff: the node is accepted. */
  onRegistered(sessionId: string, marker: WorkflowNodeSessionMarker): void;
  onInputCommitted(ds: DaemonSession, context: { turnId: string; committedAt: number }): void;
  onTurnSettled(ds: DaemonSession, context: { at: number }): void;
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
        body: { ok: false, error: 'orchestrator_offline', message: '主 Bot 的 daemon 不在线，稍后在本轮重试提交' },
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

  function stopHandoffTurn(handoffMessageId: string, sessionId: string | undefined): boolean {
    for (const ds of deps.activeSessions()) {
      const marker = ds.session.workflowNode;
      if (!marker || marker.handoffMessageId !== handoffMessageId) continue;
      if (sessionId && ds.session.sessionId !== sessionId) continue;
      return deps.interruptTurn(ds);
    }
    return false;
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
        stopHandoffTurn(input.handoffMessageId, input.sessionId);
        return;
      }
      const port = deps.daemonPort(input.targetLarkAppId);
      if (!port) throw new Error(`target daemon ${input.targetLarkAppId} is offline`);
      const result = await deps.postDaemon(port, WORKFLOW_HANDOFF_STOP_ROUTE, {
        dispatchRoot: input.handoffMessageId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        reason: input.reason,
      }, deps.hostSecret());
      if (result.status >= 400) throw new Error(`stop failed: ${String(result.body.error ?? result.status)}`);
    },
    startSelfTurn: async (input: V3SelfTurnRequest) => {
      const staged = stageWorkflowNodeInputs({
        runDir: input.runDir,
        inputs: input.inputs,
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
  });

  function registered(sessionId: string, marker: WorkflowNodeSessionMarker): void {
    const acceptedAt = Date.parse(marker.registeredAt);
    void forward(marker.orchestratorAppId, {
      kind: 'accepted',
      dispatchRoot: marker.handoffMessageId,
      sessionId,
      ...(Number.isFinite(acceptedAt) ? { acceptedAt } : {}),
    }).then((result) => {
      if (result.status >= 400 && result.status !== 409) {
        deps.warn(`[workflow] accepted notice for ${marker.handoffMessageId} failed: ${String(result.body.error ?? result.status)}`);
      }
    }).catch((err) => deps.warn(`[workflow] accepted notice for ${marker.handoffMessageId} failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  function markerSession(ds: DaemonSession): WorkflowNodeSessionMarker | undefined {
    const marker = ds.session.workflowNode;
    return marker && !marker.submittedAt ? marker : undefined;
  }

  function notify(ds: DaemonSession, event: WorkflowHandoffEvent): void {
    const marker = ds.session.workflowNode;
    if (!marker) return;
    void forward(marker.orchestratorAppId, event).then((result) => {
      if (result.status >= 400 && result.status !== 409) {
        deps.warn(`[workflow] ${event.kind} notice for ${marker.handoffMessageId} failed: ${String(result.body.error ?? result.status)}`);
      }
    }).catch((err) => deps.warn(`[workflow] ${event.kind} notice for ${marker.handoffMessageId} failed: ${err instanceof Error ? err.message : String(err)}`));
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
      markSubmitted: (sessionId, handoffMessageId) => {
        for (const ds of deps.activeSessions()) {
          if (ds.session.sessionId !== sessionId || ds.session.workflowNode?.handoffMessageId !== handoffMessageId) continue;
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
      chatId: input.chatId,
      threadRootId: input.threadRootId,
      selfLarkAppId: input.receiverLarkAppId,
    }),
    stageInbound: (binding) => {
      const runDir = runDirOf(binding.workflow.runId);
      const inputs = runDir ? readWorkflowAttemptInputs(runDir, binding.workflow.attemptId) : undefined;
      if (!runDir || !inputs) return [];
      const staged = stageWorkflowNodeInputs({
        runDir,
        inputs,
        // A verified binding names exactly the receiving bot.
        attachmentsDir: deps.attachmentsDir(binding.targetLarkAppId, binding.dispatchRoot),
      });
      for (const skipped of staged.skipped) {
        deps.warn(`[workflow] input ${skipped.from}/${skipped.name} not staged: ${skipped.reason}`);
      }
      return staged.attachments;
    },
    onRegistered: registered,
    onInputCommitted: (ds, context) => {
      const marker = markerSession(ds);
      if (!marker || marker.handoffMessageId !== context.turnId) return;
      notify(ds, {
        kind: 'accepted',
        dispatchRoot: marker.handoffMessageId,
        sessionId: ds.session.sessionId,
        acceptedAt: context.committedAt,
      });
    },
    onTurnSettled: (ds, context) => {
      const marker = markerSession(ds);
      if (!marker) return;
      notify(ds, {
        kind: 'stalled',
        dispatchRoot: marker.handoffMessageId,
        sessionId: ds.session.sessionId,
        at: context.at,
      });
    },
  };
}
