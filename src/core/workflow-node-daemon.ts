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
import { join, resolve } from 'node:path';

import { V3_RUN_ENVELOPE_FILE, frozenNodeWorkingDir, readRunEnvelope } from '../workflows/v3/run-envelope.js';
import type { V3Dag } from '../workflows/v3/dag.js';
import type { V3ExternalNodeExecutor } from '../workflows/v3/external-executor.js';
import { v3AcceptanceProbeUnknownSince } from '../workflows/v3/runtime.js';
import { isValidRunId } from '../workflows/v3/ops-projection.js';
import type { LarkAttachment, WorkflowNodeSessionMarker } from '../types.js';
import type { DaemonSession } from './types.js';
import {
  isWorkflowHandoffRevoked,
  readDispatchRegistryLoose,
  recordWorkflowHandoffRefusal,
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
import {
  WORKFLOW_HANDOFF_IDENTITY_CHECK_ROUTE,
  deliverWorkflowHandoffWithUser,
  handleWorkflowHandoffIdentityCheck,
  loadWorkflowHandoffIdentityRun,
  parseWorkflowHandoffIdentityCheck,
  planWorkflowHandoffIdentity,
  type WorkflowHandoffIdentityCheck,
  type WorkflowHandoffIdentityCheckRequest,
} from './workflow-handoff-identity.js';
import type { V3HandoffIdentityTool } from '../workflows/v3/run-envelope.js';
import { createV3BotHandoffExecutor, readV3HandoffTopics, type V3SelfTurnRequest } from '../im/lark/v3-bot-handoff-executor.js';
import { createV3NodeCardSync } from '../im/lark/v3-node-card-sync.js';
import { buildV3NodeReportCard } from '../im/lark/v3-node-card.js';
import type { WorkflowSidebarEntryLink } from '../im/lark/workflow-sidebar-entry.js';
import { checkBotWorkingDir, describeBotWorkingDirRefusal, realWorkingDir, type BotWorkingDirConfig } from './working-dir-range.js';
import { expandHome } from './working-dir.js';

/** Where a node session for one handoff starts on the executing bot
 *  (design §15.4). */
export type WorkflowInboundAdmission =
  | { start: false; reason: string }
  | { start: true; workingDir?: string };

/**
 * Where a NEW session for an admitted handoff starts, in the shape of the
 * daemon's ordinary start-dir resolution: exactly the run's directory when it
 * pinned one — none of the oncall / inherited / bot-default layers, no oncall
 * auto-bind — otherwise `undefined`, and the caller resolves as for any
 * message.
 */
export function workflowNodePinnedStart(admission: WorkflowInboundAdmission | undefined):
  | { pinnedWorkingDir: string; oncallEntry: undefined; inheritedFrom: null; pinnedFromBotDefault: false }
  | undefined {
  if (!admission?.start || admission.workingDir === undefined) return undefined;
  return { pinnedWorkingDir: admission.workingDir, oncallEntry: undefined, inheritedFrom: null, pinnedFromBotDefault: false };
}

/** §15.4: a pinned node may not land in a node-topic session that runs
 *  elsewhere — someone @-ed the bot there first, or moved it with `/cd`.
 *  Both sides are realpaths (a link in the pinned directory retargeted
 *  elsewhere counts as elsewhere). Applied on the inbound route for another
 *  bot's handoff and on the main bot's own node delivery, with one rule. */
export function workflowNodeSessionDirConflicts(pinnedDir: string, existingSessionDir: string | undefined): boolean {
  return existingSessionDir !== undefined
    && realWorkingDir(resolve(expandHome(existingSessionDir))) !== pinnedDir;
}

type WorkflowNodeWorkingDir =
  /** No Gate-2 directory: the bot's own default resolution, as for any
   *  message it receives. */
  | { kind: 'default' }
  /** Start the session in exactly this absolute directory. */
  | { kind: 'pinned'; dir: string }
  /** Do not start (or continue) the node here; the node blocks with `reason`. */
  | { kind: 'refused'; reason: string };

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
  /** The directory a session actually launches the CLI in, with the same
   *  default-dir fallbacks the spawn paths use (§15.4 existing-session
   *  comparison for the main bot's own nodes). */
  getSessionWorkingDir(ds: DaemonSession): string;
  /** The session a node turn delivered to this topic anchor would reuse —
   *  the exact lookup {@link deliverWorkflowNodeTurn} performs
   *  (`activeSessions.get(sessionKey(anchor, app))`, a virtual principal-lane
   *  anchor included), NOT a re-derivation from `session.rootMessageId`. The
   *  §15.4 existing-session gate must judge the same session reuse actually
   *  happens; a lookup of its own would both false-block a principal-lane
   *  session and miss a session stored under a deferred-routing anchor. */
  findNodeSession(anchor: string, larkAppId: string): DaemonSession | undefined;
  /** Send ^C to the session's CLI (the "停止" path); false = not possible.
   *  `evenIfIdle`: the turn is known to have just been handed in (its screen
   *  may not show it yet) — used only for a handoff revoked under it. */
  interruptTurn(ds: DaemonSession, opts?: { evenIfIdle?: boolean }): boolean;
  /** The handoff `turnId` of `ds` was stopped: withdraw the tool identity a
   *  workflow delegation published for it (design §10.3: the delegation ends
   *  with the attempt even when ^C cannot reach the CLI). Best-effort. */
  withdrawHandoffIdentity?(ds: DaemonSession, turnId: string): Promise<void>;
  /** Positive proof that an inbound message's sender is `sourceLarkAppId`'s
   *  bot in this chat, as seen by `receiverLarkAppId` (app-scoped open_id).
   *  Unknown / failed lookups must answer false. */
  proveBotSender(input: { receiverLarkAppId: string; chatId: string; senderOpenId: string | undefined; sourceLarkAppId: string }): Promise<boolean>;
  /** Re-try a best-effort notice once after this many ms (default 3 s). */
  noticeRetryMs?: number;
  /** Engine-aligned clock / wait for the handoff executor (tests). */
  now?(): number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  deliverSelfTurn(input: {
    larkAppId: string;
    chatId: string;
    publishRoot: string;
    handoffMessageId: string;
    marker: WorkflowNodeSessionMarker;
    prompt: string;
    attachments: LarkAttachment[];
    sessionTitle: string;
    /** Present only when the handoff carries the initiator's delegation:
     *  publish the turn's tool identity before the CLI gets the turn. */
    prepareTurnIdentity?: (ds: DaemonSession, turnId: string) => void | Promise<void>;
    /** The run's Gate-2 directory, already checked: start a new node
     *  session there (an existing one keeps its directory). */
    workingDir?: string;
  }): Promise<{ sessionId: string }>;
  attachmentsDir(larkAppId: string, messageId: string): string;
  loadRun(runDir: string): { dag: V3Dag; nodeExecutor?: 'bot'; chatId?: string; title: string } | undefined;
  /** A bot's directory configuration as this daemon runs it right now
   *  (§15.4: checked when the node session starts, not as approved). */
  botWorkingDirConfig(larkAppId: string): BotWorkingDirConfig | undefined;
  /** Whether that bot's running daemon applies a run's Gate-2 working dir
   *  (advertised in its descriptor; an older daemon would ignore it). */
  daemonAppliesNodeWorkingDir(larkAppId: string): boolean;
  drive(runId: string): void;
  botName(larkAppId: string): string;
  /** §11: a run's「工作流 ›」sidebar entry, keyed by its main bot; undefined
   *  when this host cannot name its Dashboard address (no entry on cards). */
  workflowEntry?(mainLarkAppId: string, runId: string): WorkflowSidebarEntryLink | undefined;
  warn(message: string): void;
  /** Publish a turn's tool identity (the daemon's per-turn preparation,
   *  which resolves a signed delegation for it). */
  prepareTurnIdentity(ds: DaemonSession, turnId: string): void | Promise<void>;
  /** 交接带发起人身份 (design §10): consulted only for runs whose run.json
   *  froze an initiator. */
  handoffIdentity: {
    /** A bot's `triggerUserAuth.tools` right now (this daemon's own bot when
     *  signing: the ceiling can only narrow). */
    botTools(larkAppId: string): V3HandoffIdentityTool[];
    /** This daemon's own bot's check of the initiator in `chatId` (the
     *  dispatch delegation check). Serves the identity-check route too. */
    checkSelf(request: WorkflowHandoffIdentityCheckRequest): Promise<WorkflowHandoffIdentityCheck>;
  };
}

export interface WorkflowNodeDaemon {
  executor: V3ExternalNodeExecutor;
  syncNodeCards(runId: string): Promise<void>;
  eventRoute(raw: unknown): Promise<RouteResult>;
  reportRoute(raw: unknown, authorize: (raw: unknown) => { ok: true; session: WorkflowNodeReportSession } | { ok: false; status: number; error: string }): Promise<RouteResult>;
  stopRoute(raw: unknown): RouteResult;
  /** Target side of 交接带发起人身份: would this bot carry the initiator? */
  identityCheckRoute(raw: unknown): Promise<RouteResult>;
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
  /** Gate for an inbound handoff on the executing bot (design §15.4): the
   *  run's Gate-2 directory checked against `executingLarkAppId`'s configured
   *  range now — and, when the node topic already has a session
   *  (`existingSessionDir` = the directory it runs in), against that session.
   *  `start: false` = refused (the main bot is told, so the node blocks with
   *  `reason`; nothing may be registered or started for it); otherwise start
   *  / continue the node, a NEW session in `workingDir` when the run pinned
   *  one. */
  admitInbound(
    binding: WorkflowHandoffBindingPayload,
    handoffMessageId: string,
    executingLarkAppId: string,
    existingSessionDir?: string,
  ): WorkflowInboundAdmission;
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

  /** End the workflow delegation a handoff turn was given (best-effort). */
  function withdrawIdentity(ds: DaemonSession, turnId: string): void {
    if (!deps.withdrawHandoffIdentity) return;
    void deps.withdrawHandoffIdentity(ds, turnId)
      .catch((err) => deps.warn(`[workflow] withdrawing identity of ${turnId} failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  function stopHandoffTurn(nonce: string, sessionId: string | undefined, opts?: { evenIfIdle?: boolean }): boolean {
    for (const ds of deps.activeSessions()) {
      const marker = ds.session.workflowNode;
      if (!marker || marker.nonce !== nonce) continue;
      if (sessionId && ds.session.sessionId !== sessionId) continue;
      withdrawIdentity(ds, marker.handoffMessageId);
      return deps.interruptTurn(ds, opts);
    }
    return false;
  }

  function isRevoked(nonce: string): boolean {
    return isWorkflowHandoffRevoked(readDispatchRegistryLoose(deps.dataDir()), nonce, deps.bindingSecret());
  }

  function nodeWorkingDir(runDir: string | undefined, runId: string, executingLarkAppId: string): WorkflowNodeWorkingDir {
    // The directory lives in run.json itself (the Gate-2 commit); only that
    // file is read here. Without it, whether a directory was chosen is
    // unknown: never start the node somewhere else on a guess.
    const read = runDir ? readRunEnvelope(runDir, runId) : undefined;
    if (read?.kind !== 'ok') return { kind: 'refused', reason: '读不到这个工作流 run 的批准记录，无法确认节点该在哪个目录执行' };
    const workingDir = frozenNodeWorkingDir(read.envelope);
    if (workingDir === undefined) return { kind: 'default' };
    const botName = deps.botName(executingLarkAppId);
    const config = deps.botWorkingDirConfig(executingLarkAppId);
    if (!config) return { kind: 'refused', reason: `指定的工作目录 ${workingDir}：读不到 ${botName} 的配置，无法核对目录范围` };
    const verdict = checkBotWorkingDir(config, workingDir);
    if (verdict.ok) return { kind: 'pinned', dir: verdict.path };
    return {
      kind: 'refused',
      reason: `指定的工作目录 ${verdict.path}：${describeBotWorkingDirRefusal(verdict)}。`
        + `以 ${botName} 现在的配置为准（批准后可能改过）；把这个目录加进它的默认工作目录或仓库目录后重试，或改派。`,
    };
  }

  /** Tell the main bot this handoff's node session was not started. The
   *  reason is first recorded on the handoff's registry entry, where the main
   *  bot's acceptance check reads it; the direct notice that blocks the node
   *  at once is retried once — after an error answer or an unreachable daemon
   *  alike. Should both fail, the node still blocks at the acceptance
   *  deadline (HANDOFF_NOT_ACCEPTED), with this reason in its message. */
  async function refuse(binding: { nonce: string; sourceLarkAppId: string }, handoffMessageId: string, reason: string): Promise<void> {
    try {
      await recordWorkflowHandoffRefusal(deps.dataDir(), deps.bindingSecret(), binding.nonce, reason);
    } catch (err) {
      deps.warn(`[workflow] recording the refusal of ${binding.nonce} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const event: WorkflowHandoffEvent = { kind: 'refused', nonce: binding.nonce, dispatchRoot: handoffMessageId, reason };
    /** undefined = delivered (or refused for good: 409); else why it failed. */
    const send = async (): Promise<string | undefined> => {
      try {
        const result = await forward(binding.sourceLarkAppId, event);
        return result.status < 400 || result.status === 409 ? undefined : String(result.body.error ?? result.status);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };
    const first = await send();
    if (first === undefined) return;
    await new Promise((resolve) => { const timer = setTimeout(resolve, deps.noticeRetryMs ?? 3_000); timer.unref?.(); });
    const second = await send();
    if (second !== undefined) {
      deps.warn(`[workflow] refused notice for ${binding.nonce} failed twice (${first}; ${second}); `
        + `the node blocks at the acceptance deadline instead. Reason: ${reason}`);
    }
  }

  /** The target bot's own check, in-process for the main bot itself, else
   *  over the host-trusted daemon IPC. */
  async function checkTargetIdentity(targetLarkAppId: string, request: WorkflowHandoffIdentityCheckRequest): Promise<WorkflowHandoffIdentityCheck> {
    if (targetLarkAppId === deps.selfLarkAppId()) return deps.handoffIdentity.checkSelf(request);
    // A bot that governs no tool needs no delegation; asked only when it does.
    if (deps.handoffIdentity.botTools(targetLarkAppId).length === 0) return { status: 'not_required' };
    const port = deps.daemonPort(targetLarkAppId);
    if (!port) return { status: 'unavailable', detail: `${deps.botName(targetLarkAppId)} 的 daemon 不在线` };
    const result = await deps.postDaemon(port, WORKFLOW_HANDOFF_IDENTITY_CHECK_ROUTE, request, deps.hostSecret());
    if (result.status !== 200) {
      return { status: 'unavailable', detail: `${deps.botName(targetLarkAppId)} 的 daemon 无法校验（${String(result.body.error ?? result.status)}）` };
    }
    return parseWorkflowHandoffIdentityCheck(result.body);
  }

  const executor = createV3BotHandoffExecutor({
    get selfLarkAppId() { return deps.selfLarkAppId(); },
    get dataDir() { return deps.dataDir(); },
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    handoffIdentity: {
      plan: async (request) => {
        const run = loadWorkflowHandoffIdentityRun(request.runDir);
        if (!run) return { kind: 'none' };
        const self = deps.selfLarkAppId();
        const targetGovernsTools = deps.handoffIdentity.botTools(request.targetLarkAppId).length > 0;
        // Only the run's own main bot signs, only for the run's own chat
        // (§10.3); anything else goes out without the initiator.
        const chatId = request.chatBinding?.chatId;
        if (!chatId || chatId !== run.chatId || run.sourceLarkAppId !== self) {
          return targetGovernsTools
            ? { kind: 'unsigned', note: '这次交接的群或主 Bot 与批准时的不一致' }
            : { kind: 'none' };
        }
        const identity = run.identity;
        return planWorkflowHandoffIdentity({
          run,
          sourceLarkAppId: self,
          targetLarkAppId: request.targetLarkAppId,
          sourceBotTools: deps.handoffIdentity.botTools(self),
          targetGovernsTools,
          botName: deps.botName,
          check: (offered) => identity
            ? checkTargetIdentity(request.targetLarkAppId, { chatId, unionId: identity.unionId, tools: offered, sourceLarkAppId: self })
            : Promise.resolve({ status: 'not_required' } as const),
        });
      },
      deliver: (input) => deliverWorkflowHandoffWithUser({
        dataDir: deps.dataDir(),
        secret: deps.bindingSecret(),
        sourceLarkAppId: deps.selfLarkAppId(),
        ...input,
      }),
    },
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
    workflowEntry: (runId) => deps.workflowEntry?.(deps.selfLarkAppId(), runId),
    workingDirPreflight: (request) => {
      const self = deps.selfLarkAppId();
      // The main bot's own node: decided here, before its cards go out.
      if (request.targetLarkAppId === self) {
        const dir = nodeWorkingDir(request.runDir, request.runId, self);
        return dir.kind === 'refused' ? dir.reason : undefined;
      }
      // Another bot decides against its own range when the handoff arrives;
      // a daemon that does not know about the directory would start the node
      // in its default one instead, so it is not handed off at all.
      const read = readRunEnvelope(request.runDir, request.runId);
      if (read.kind !== 'ok' || frozenNodeWorkingDir(read.envelope) === undefined) return undefined;
      if (deps.daemonAppliesNodeWorkingDir(request.targetLarkAppId)) return undefined;
      return `${deps.botName(request.targetLarkAppId)} 的 daemon 版本过旧，不支持指定工作目录；把它升级到与主 Bot 相同的版本后重试，或改派`;
    },
    startSelfTurn: async (input: V3SelfTurnRequest) => {
      const runDir = input.runDir;
      // §15.4 for the main bot's own nodes too: its current configuration
      // decides, and a refusal blocks the node (nothing is started).
      const dir = nodeWorkingDir(runDir, input.marker.runId, deps.selfLarkAppId());
      if (dir.kind === 'refused') {
        deps.warn(`[workflow] node ${input.marker.nodeId} of ${input.marker.runId} not started: ${dir.reason}`);
        await refuse({ nonce: input.marker.nonce, sourceLarkAppId: deps.selfLarkAppId() }, input.handoffMessageId, dir.reason);
        return { refused: true as const };
      }
      if (dir.kind === 'pinned') {
        // §15.4, the same gate the receiving daemon applies to another bot's
        // handoff: the main bot's own node topic may already hold a session
        // (someone @-ed it there first, or moved it with /cd). Reusing it would
        // execute the node outside the pinned directory, so block instead —
        // never hand the turn to that session or fall back to any default.
        const self = deps.selfLarkAppId();
        const found = deps.findNodeSession(input.publishRoot, self);
        // A closed session at this key is not reused either — the turn starts
        // a new one in the pinned directory, so it is no conflict.
        const existing = found && found.session.status !== 'closed' ? found : undefined;
        const existingDir = existing ? deps.getSessionWorkingDir(existing) : undefined;
        if (workflowNodeSessionDirConflicts(dir.dir, existingDir)) {
          const reason = '节点话题里已有会话，工作目录与指定的不一致；请在这个话题里关闭该会话后重试，或改派';
          deps.warn(`[workflow] node ${input.marker.nodeId} of ${input.marker.runId}: the node topic's session runs in ${existingDir}, not ${dir.dir}`);
          await refuse({ nonce: input.marker.nonce, sourceLarkAppId: self }, input.handoffMessageId, reason);
          return { refused: true as const };
        }
      }
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
        ...(input.identityDelegated ? { prepareTurnIdentity: deps.prepareTurnIdentity } : {}),
        ...(dir.kind === 'pinned' ? { workingDir: dir.dir } : {}),
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
    workflowEntry: (runId) => deps.workflowEntry?.(deps.selfLarkAppId(), runId),
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
          // The node handed in its work: its delegation ends now (design §10.3).
          withdrawIdentity(ds, ds.session.workflowNode.handoffMessageId);
        }
      },
      postReportCard: async (binding, input) => {
        const entry = deps.workflowEntry?.(binding.sourceLarkAppId, binding.workflow.runId);
        await deps.replyCard(binding.publishRoot, buildV3NodeReportCard({
          nodeId: binding.workflow.nodeId,
          botName: deps.botName(deps.selfLarkAppId()),
          ...input,
          ...(entry ? { entry } : {}),
        }));
      },
    }),
    identityCheckRoute: (raw) => handleWorkflowHandoffIdentityCheck(raw, deps.handoffIdentity.checkSelf),
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
    admitInbound: (binding, handoffMessageId, executingLarkAppId, existingSessionDir) => {
      let dir = nodeWorkingDir(runDirOf(binding.workflow.runId), binding.workflow.runId, executingLarkAppId);
      // The node topic already has a session (someone @-ed the bot there, or
      // moved it with /cd): the handoff would run where that session runs.
      if (dir.kind === 'pinned' && workflowNodeSessionDirConflicts(dir.dir, existingSessionDir)) {
        deps.warn(`[workflow] handoff ${handoffMessageId}: the node topic's session runs in ${existingSessionDir}, not ${dir.dir}`);
        dir = { kind: 'refused', reason: '节点话题里已有会话，工作目录与指定的不一致；请在这个话题里关闭该会话后重试，或改派' };
      }
      if (dir.kind === 'refused') {
        void refuse(binding, handoffMessageId, dir.reason);
        return { start: false, reason: dir.reason };
      }
      return dir.kind === 'pinned' ? { start: true, workingDir: dir.dir } : { start: true };
    },
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
