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

import { V3_RUN_ENVELOPE_FILE, frozenNodeProjectDir, frozenNodeWorkingDir, readRunEnvelope, runInitiatorRef } from '../workflows/v3/run-envelope.js';
import type { V3Dag } from '../workflows/v3/dag.js';
import type { V3ExternalNodeExecutor } from '../workflows/v3/external-executor.js';
import { v3AcceptanceProbeUnknownSince } from '../workflows/v3/runtime.js';
import { safeExternalAttemptDir } from '../workflows/v3/external-control.js';
import { v3MainTopicQueueGraceMs } from '../workflows/v3/external-executor.js';
import { DEFAULT_NODE_TIMEOUT_SEC, MAX_NODE_TIMEOUT_SEC } from '../workflows/v3/dag.js';
import { isValidRunId } from '../workflows/v3/ops-projection.js';
import type { LarkAttachment, WorkflowNodeSessionMarker } from '../types.js';
import type { DaemonSession } from './types.js';
import {
  isWorkflowHandoffRevoked,
  lookupWorkflowHandoffByNonce,
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
  workflowNodeMarkerActive,
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
  approvedWorkflowBots,
  deliverWorkflowHandoffWithUser,
  handleWorkflowHandoffIdentityCheck,
  loadWorkflowHandoffIdentityRun,
  parseWorkflowHandoffIdentityCheck,
  planWorkflowHandoffIdentity,
  type WorkflowHandoffIdentityCheck,
  type WorkflowHandoffIdentityCheckRequest,
} from './workflow-handoff-identity.js';
import type { V3HandoffIdentityTool } from '../workflows/v3/run-envelope.js';
import {
  createV3BotHandoffExecutor,
  readV3HandoffCardInput,
  readV3HandoffTopics,
  type V3SelfTurnRequest,
} from '../im/lark/v3-bot-handoff-executor.js';
import { createV3NodeCardSync } from '../im/lark/v3-node-card-sync.js';
import { buildV3NodeReportCard } from '../im/lark/v3-node-card.js';
import type { WorkflowSidebarEntryLink } from '../im/lark/workflow-sidebar-entry.js';
import { checkNodeWorkingDir, comparableSessionDir, describeBotWorkingDirRefusal, type BotWorkingDirConfig, type NodeWorkingDirVerdict } from './working-dir-range.js';
import {
  WORKFLOW_INITIATOR_UNION_ROUTE,
  isWorkflowOpenId,
  isWorkflowUnionId,
  parseWorkflowInitiatorUnionRequest,
  parseWorkflowWorkingDirOperatorRequest,
  withinOperatorBudget,
  type WorkflowCdGateAnswer,
  type WorkflowInitiatorIdentity,
  type WorkflowOperateAnswer,
} from './workflow-working-dir-operator.js';
import { readGrillState } from '../workflows/v3/grill-state.js';
import { loadDag } from '../workflows/v3/dag-loader.js';
import { freezeDagBotSnapshots } from '../workflows/v3/bot-resolve.js';
import { loadAuthorizedV3Run } from '../workflows/v3/run-envelope.js';
import { v3BotExecutorTargets } from '../workflows/v3/node-executor-mode.js';
import { classifyExternalAttempt } from '../workflows/v3/external-control.js';
import { readJournal } from '../workflows/v3/journal.js';
import { effectiveDefaultWorkingDir, type BotConfig } from '../bot-registry.js';

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
    && comparableSessionDir(existingSessionDir) !== pinnedDir;
}

/** Where (or whether) a node may run on its executing bot (§15.4). */
export type WorkflowNodeWorkingDir =
  /** No Gate-2 directory: the bot's own default resolution, as for any
   *  message it receives. */
  | { kind: 'default' }
  /** Start the session in exactly this absolute directory. */
  | { kind: 'pinned'; dir: string }
  /** Do not start (or continue) the node here; the node blocks with `reason`. */
  | { kind: 'refused'; reason: string };

const UNDECIDED_NODE_WORKING_DIR: WorkflowNodeWorkingDir = {
  kind: 'refused',
  reason: '没能确定节点该在哪个目录执行，未启动节点；请重试，或改派',
};

/** `dir` when it is one of the kinds, whole; anything else (a kind added
 *  later, or not a decision at all — e.g. a promise never awaited) refuses:
 *  only `default` may start a node in the bot's default directory. */
function knownNodeWorkingDir(dir: WorkflowNodeWorkingDir): WorkflowNodeWorkingDir {
  if (typeof dir !== 'object' || dir === null) return UNDECIDED_NODE_WORKING_DIR;
  switch (dir.kind) {
    case 'default':
      return dir;
    case 'pinned':
      return typeof dir.dir === 'string' && dir.dir !== '' ? dir : UNDECIDED_NODE_WORKING_DIR;
    case 'refused':
      return typeof dir.reason === 'string' ? dir : UNDECIDED_NODE_WORKING_DIR;
    default: {
      const unhandled: never = dir;
      void unhandled;
      return UNDECIDED_NODE_WORKING_DIR;
    }
  }
}

/** Where a decision that starts the node starts it: the pinned directory, or
 *  `undefined` — the bot's default — for `default` only. */
function startDirOf(dir: Exclude<WorkflowNodeWorkingDir, { kind: 'refused' }>): string | undefined {
  switch (dir.kind) {
    case 'pinned':
      return dir.dir;
    case 'default':
      return undefined;
    default: {
      const unhandled: never = dir;
      return unhandled;
    }
  }
}

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
  /** Whether that bot's running daemon reads a run.json carrying the
   *  launching draft's project (advertised in its descriptor; an older
   *  daemon rejects the whole file and could not start the node at all). */
  daemonReadsNodeProjectDir(larkAppId: string): boolean;
  /** §15.4: may the run's initiator operate `larkAppId` (this daemon's own
   *  bot) in `chatId` — the `/cd` gate plus current membership of the chat,
   *  with the identity converted into that bot's app
   *  (`createWorkflowWorkingDirOperatorWiring`). Absent = no one is taken to
   *  operate it: the configured range applies. */
  initiatorOperates?(input: {
    larkAppId: string;
    chatId: string;
    initiator: WorkflowInitiatorIdentity;
    /** Read the chat's members now, not from the short-lived cache (node
     *  start: someone who just left the chat must not count). */
    freshMembership?: boolean;
  }): Promise<WorkflowOperateAnswer>;
  /** {@link initiatorOperates} without reading the chat's members: whether
   *  the main bot's own node can be refused before its cards go out (the
   *  members are read once, when the node starts). Absent = that question
   *  is left to the node start. */
  initiatorCdGate?(input: {
    larkAppId: string;
    chatId: string;
    initiator: WorkflowInitiatorIdentity;
  }): Promise<WorkflowCdGateAnswer>;
  /** The run's main bot side of {@link WORKFLOW_INITIATOR_UNION_ROUTE}: the
   *  union_id of a person this daemon's own app knows by `openId`. */
  lookupOwnUnionId?(openId: string): Promise<{ unionId: string } | { unknown: string }>;
  /** bots.json as of now (the executing bots of a run not yet approved). */
  currentBots?(): BotConfig[];
  /** Whether that bot's running daemon handles a main-topic handoff (§5.5;
   *  advertised in its descriptor). Absent = every daemon does (tests). */
  daemonHandlesMainPlacement?(larkAppId: string): boolean;
  /** §5.5: the Lark topic id of the run's main topic (display only). */
  mainTopicThreadId?(binding: { chatId: string; rootMessageId: string; sessionId?: string }): string | undefined;
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
  /** Gate for an inbound handoff on the executing bot (design §15.4), with
   *  the run's Gate-2 directory already decided (`workingDir`): when the node
   *  topic already has a session (`existingSessionDir` = the directory it runs
   *  in), checked against that session too. `start: false` = refused (the
   *  main bot is told, so the node blocks with `reason`; nothing may be
   *  registered or started for it); otherwise start / continue the node, a
   *  NEW session in `workingDir` when the run pinned one. `existingMarker`:
   *  that session's workflow-node marker — a main-topic session already
   *  carrying another node in progress refuses the new one (§5.5,
   *  MAIN_TOPIC_BUSY). */
  admitInbound(
    binding: WorkflowHandoffBindingPayload,
    handoffMessageId: string,
    executingLarkAppId: string,
    existingSessionDir: string | undefined,
    existingMarker: WorkflowNodeSessionMarker | undefined,
    workingDir: WorkflowNodeWorkingDir,
  ): WorkflowInboundAdmission;
  /** The inbound route's whole §15.4 gate, in order: decide the directory
   *  ({@link checkNodeWorkingDir} with this daemon's configuration and the
   *  initiator's operate right now — it may ask Lark and the main bot's
   *  daemon, and wait), THEN read the session the handoff would land in
   *  (`currentSession`, so nothing read goes stale across the wait;
   *  `'stale'` = the caller's turn is no longer current), re-check
   *  revocation, and {@link admitInbound} with the decided directory. The
   *  daemon calls only this. */
  admitInboundHandoff<S>(input: {
    binding: WorkflowHandoffBindingPayload;
    handoffMessageId: string;
    executingLarkAppId: string;
    currentSession(): S | 'stale';
    describeSession(session: S): { dir?: string; marker?: WorkflowNodeSessionMarker };
  }): Promise<
    | { kind: 'stale' }
    | { kind: 'revoked' }
    | { kind: 'admission'; admission: WorkflowInboundAdmission; session: S }
  >;
  /** Gate-2 → this bot: may the initiator operate it here (§15.4)? */
  workingDirOperatorRoute(raw: unknown): Promise<RouteResult>;
  /** Executing bot → this (main) bot: the initiator's union_id for a run
   *  with a Gate-2 working dir or a project, looked up through this bot's
   *  own app. */
  initiatorUnionRoute(raw: unknown): Promise<RouteResult>;
  /** Copy the node's upstream products into this turn's attachment dir. */
  stageInbound(binding: WorkflowHandoffBindingPayload, messageId: string): LarkAttachment[];
  /** A session just registered a verified handoff: the node is accepted
   *  (unless it was revoked meanwhile — then its turn is stopped). */
  onRegistered(sessionId: string, marker: WorkflowNodeSessionMarker): void;
  onInputCommitted(ds: DaemonSession, context: { turnId: string; committedAt: number }): void;
  onTurnSettled(ds: DaemonSession, context: { turnId?: string; at: number }): void;
  /** A turn's input was literally written to the CLI (§5.5: a main-topic
   *  handoff queued behind another turn really starts here). */
  onTurnStarted(ds: DaemonSession, context: { turnId: string; startedAt: number }): void;
}

/** The refusal when the session the handoff would land in runs elsewhere
 *  (§15.4); a main-topic session is never closed for a node, so the way out
 *  differs. */
function existingSessionDirRefusal(placement: 'main' | undefined): string {
  return placement === 'main'
    ? '主话题里已有会话，工作目录与指定的不一致；请把节点改成节点话题，或改派'
    : '节点话题里已有会话，工作目录与指定的不一致；请在这个话题里关闭该会话后重试，或改派';
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


  /**
   * Main topic (§5.5): should a stop interrupt what this shared session runs
   * now? While the handoff's own CLI turn is in progress — started and not
   * yet idle again, persisted on the marker so a restart keeps knowing — yes,
   * whatever else was folded into it: a person's message typed in while it
   * ran (a CLI with type-ahead merges it into the running turn) is part of
   * that same CLI turn. Interrupting it interrupts that person's message too;
   * not interrupting it would leave the bot working on a node that is
   * already stopped (timed out, cancelled, reassigned). The node being over
   * wins; the person can send the message again. Before the handoff turn
   * starts nothing is interrupted (it is stopped the moment it starts); after
   * it went idle, only a later turn of the node itself is.
   */
  function mainTopicNodeTurnRunning(ds: DaemonSession, marker: WorkflowNodeSessionMarker): boolean {
    if (!marker.handoffStartedAt) return false;
    // The handoff turn is over once the session went idle after it started
    // (any idle edge, whatever turn it names) — or the worker it started in
    // is gone (restart / respawn: an idle signal may never come).
    const settled = !!marker.handoffSettledAt || marker.handoffWorkerGeneration !== ds.workerGeneration;
    if (!settled) return true;
    // After it: only a later turn of the node itself that has not gone idle
    // (persisted: a CLI a persistent backend kept across a restart may still
    // run it; on an idle screen the interrupt is a no-op anyway).
    const last = marker.lastTurn;
    return !!last && !last.settledAt && last.turnId !== marker.handoffMessageId && !!marker.turnIds?.includes(last.turnId);
  }

  function stopHandoffTurn(nonce: string, sessionId: string | undefined, opts?: { evenIfIdle?: boolean }): boolean {
    for (const ds of deps.activeSessions()) {
      const marker = ds.session.workflowNode;
      if (!marker || marker.nonce !== nonce) continue;
      if (sessionId && ds.session.sessionId !== sessionId) continue;
      withdrawIdentity(ds, marker.handoffMessageId);
      if (marker.placement !== 'main') return deps.interruptTurn(ds, opts);
      // Main topic: the attempt is over for this ordinary session; stop only
      // the handoff's own turn, never someone else's turn in the same session
      // (a queued handoff turn is stopped when it starts, onTurnStarted).
      // Already over before this call (a second stop, a late "revoked"
      // answer): whatever runs now is not the node's — nothing to interrupt.
      if (marker.closedAt || marker.submittedAt) return false;
      ds.session.workflowNode = { ...marker, closedAt: new Date().toISOString() };
      deps.updateSession(ds);
      return mainTopicNodeTurnRunning(ds, marker) ? deps.interruptTurn(ds, opts) : false;
    }
    return false;
  }

  /** Main topic: the attempt ended here without work handed in (the bot
   *  reported it cannot do it) — the session is ordinary again. */
  function closeMainMarker(sessionId: string | undefined, nonce: string): void {
    for (const ds of deps.activeSessions()) {
      const marker = ds.session.workflowNode;
      if ((sessionId !== undefined && ds.session.sessionId !== sessionId) || marker?.nonce !== nonce || marker.placement !== 'main') continue;
      if (marker.closedAt || marker.submittedAt) continue;
      ds.session.workflowNode = { ...marker, closedAt: new Date().toISOString() };
      deps.updateSession(ds);
      withdrawIdentity(ds, marker.handoffMessageId);
    }
  }

  function isRevoked(nonce: string): boolean {
    return isWorkflowHandoffRevoked(readDispatchRegistryLoose(deps.dataDir()), nonce, deps.bindingSecret());
  }

  /** A run as the §15.4 operate check needs it: who started it (open_id
   *  for the main bot's app only), where, and which bots take part.
   *  `pending`: not yet approved (Gate-2 is asking) — read from the grill
   *  state and today's bots.json, exactly as Gate-2 freezes it; only then is
   *  each node's executor known (`executorOf`). */
  interface OperateRun {
    initiator: { sourceLarkAppId: string; openId: string; unionId?: string };
    chatId: string;
    /** Every bot that may execute a node of this run. */
    executors: ReadonlySet<string>;
    /** Pending runs only: the bot that will execute `nodeId`. */
    executorOf?(nodeId: string): string | undefined;
  }

  /**
   * An approved run that pins a working dir or carries the launching draft's
   * project. Its bots are the run's approved scope — the frozen snapshot plus
   * every bot an applied revision brought in and the initiator's own reassignments ({@link approvedWorkflowBots}, the
   * scope 交接带发起人身份 uses) — plus any bot a node was reassigned to by
   * anyone, since that bot then executes it. `undefined`: a readable run.json
   * that pins no working dir nor carries a project, or names no initiator or
   * chat. `unreadable`:
   * run.json, its artifacts or the journal could not be read or verified —
   * not an answer about the initiator.
   */
  function frozenOperateRun(runDir: string, runId: string): OperateRun | { unreadable: string } | undefined {
    const read = readRunEnvelope(runDir, runId);
    if (read.kind !== 'ok') return { unreadable: '读不到这个 run 的批准记录' };
    if (frozenNodeWorkingDir(read.envelope) === undefined && frozenNodeProjectDir(read.envelope) === undefined) return undefined;
    const initiator = runInitiatorRef(read.envelope);
    const chatId = read.envelope.chatBinding?.chatId;
    if (!initiator || !chatId) return undefined;
    let executors: Set<string>;
    try {
      const loaded = loadAuthorizedV3Run(runDir, { expectedRunId: runId });
      const events = readJournal(join(runDir, 'journal.ndjson'));
      executors = approvedWorkflowBots(runDir, loaded, events, initiator.openId);
      for (const event of events) if (event.type === 'nodeReassigned') executors.add(event.to);
    } catch {
      return { unreadable: '读不到这个 run 的批准记录或事件日志' };
    }
    return { initiator, chatId, executors };
  }

  function targetsMap(build: () => Array<{ nodeId: string; larkAppId: string }>): Map<string, string> | undefined {
    try {
      return new Map(build().map((target) => [target.nodeId, target.larkAppId]));
    } catch {
      return undefined;
    }
  }

  /** A run waiting at Gate-2 (no run.json yet). */
  function pendingOperateRun(runDir: string, runId: string): OperateRun | undefined {
    if (readRunEnvelope(runDir, runId).kind !== 'missing') return undefined;
    const grill = readGrillState(runDir);
    const binding = grill?.chatBinding;
    if (!grill || grill.runId !== runId || grill.status !== 'dag_ready' || !grill.dagPath || !binding?.chatId
      || !isWorkflowOpenId(binding.ownerOpenId) || !deps.currentBots) return undefined;
    const bots = deps.currentBots();
    const dagPath = grill.dagPath;
    const targets = targetsMap(() => {
      const dag = loadDag(dagPath);
      return v3BotExecutorTargets(dag, freezeDagBotSnapshots(dag, bots, { defaultSelector: binding.larkAppId }));
    });
    if (!targets) return undefined;
    return {
      initiator: { sourceLarkAppId: binding.larkAppId, openId: binding.ownerOpenId },
      chatId: binding.chatId,
      executorOf: (nodeId) => targets.get(nodeId),
      executors: new Set(targets.values()),
    };
  }

  /** The initiator's union_id from the run's main bot daemon (the only app
   *  their open_id belongs to): the one source both Gate-2 and node start
   *  use when the run froze none. */
  async function initiatorUnionFromMain(sourceLarkAppId: string, runId: string): Promise<{ unionId: string } | { unknown: string }> {
    const mainName = deps.botName(sourceLarkAppId);
    try {
      const port = deps.daemonPort(sourceLarkAppId);
      if (!port) return { unknown: `主 Bot ${mainName} 的 daemon 不在线，拿不到发起人的跨应用身份` };
      const result = await deps.postDaemon(port, WORKFLOW_INITIATOR_UNION_ROUTE,
        { runId, requesterLarkAppId: deps.selfLarkAppId() }, deps.hostSecret());
      if (result.status === 200 && isWorkflowUnionId(result.body.unionId)) return { unionId: result.body.unionId };
      // An older daemon has no such route: its generic 404 carries no `ok`.
      if (result.status === 404 && result.body.ok === undefined) {
        return { unknown: `主 Bot ${mainName} 的 daemon 版本过旧，拿不到发起人的跨应用身份` };
      }
      const said = typeof result.body.error === 'string' ? result.body.error : `HTTP ${result.status}`;
      return { unknown: `主 Bot ${mainName} 没能给出发起人的跨应用身份（${said}）` };
    } catch {
      return { unknown: `连不上主 Bot ${mainName} 的 daemon，拿不到发起人的跨应用身份` };
    }
  }

  /** §15.4: may the run's initiator operate `executingLarkAppId` in the
   *  run's chat? Their open_id is used for the main bot's own app only; for
   *  another bot their union_id — frozen on the run, else from the main bot —
   *  is converted in that bot's app. Bounded by the operator budget. */
  function initiatorOperates(run: OperateRun, runId: string, executingLarkAppId: string, opts: { freshMembership?: boolean } = {}): Promise<WorkflowOperateAnswer> {
    return withinOperatorBudget((async (): Promise<WorkflowOperateAnswer> => {
      if (!deps.initiatorOperates) return 'no';
      let unionId = run.initiator.unionId;
      if (executingLarkAppId !== run.initiator.sourceLarkAppId && !unionId) {
        const got = run.initiator.sourceLarkAppId === deps.selfLarkAppId()
          ? (deps.lookupOwnUnionId ? await deps.lookupOwnUnionId(run.initiator.openId) : { unknown: '拿不到发起人的跨应用身份' })
          : await initiatorUnionFromMain(run.initiator.sourceLarkAppId, runId);
        if ('unknown' in got) return { unknown: got.unknown };
        unionId = got.unionId;
      }
      return deps.initiatorOperates({
        larkAppId: executingLarkAppId,
        chatId: run.chatId,
        initiator: { ...run.initiator, ...(unionId ? { unionId } : {}) },
        ...(opts.freshMembership ? { freshMembership: true } : {}),
      });
    })());
  }

  /** The main bot's own node before its cards go out: everything
   *  {@link initiatorOperates} asks except the chat's members: only the node
   *  start reads them (the handoff identity wait and the card sends lie in
   *  between).
   *  `yes` here only means "not refused before the start". */
  function initiatorOperatesBeforeStart(run: OperateRun): Promise<WorkflowOperateAnswer> {
    return withinOperatorBudget((async (): Promise<WorkflowOperateAnswer> => {
      if (!deps.initiatorOperates) return 'no';
      if (!deps.initiatorCdGate) return 'yes';
      const gate = await deps.initiatorCdGate({ larkAppId: deps.selfLarkAppId(), chatId: run.chatId, initiator: run.initiator });
      return gate === 'passes' ? 'yes' : gate;
    })());
  }

  type NodeWorkingDirInput =
    | { kind: 'decided'; dir: WorkflowNodeWorkingDir }
    /** `label` names where the directory came from, in the refusal. */
    | { kind: 'check'; runDir: string; workingDir: string; config: BotWorkingDirConfig; botName: string; label: string };

  function nodeWorkingDirInput(runDir: string | undefined, runId: string, executingLarkAppId: string): NodeWorkingDirInput {
    // The directory lives in run.json itself (the Gate-2 commit); only that
    // file is read here. Without it, whether a directory was chosen is
    // unknown: never start the node somewhere else on a guess.
    const read = runDir ? readRunEnvelope(runDir, runId) : undefined;
    if (!runDir || read?.kind !== 'ok') return { kind: 'decided', dir: { kind: 'refused', reason: '读不到这个工作流 run 的批准记录，无法确认节点该在哪个目录执行' } };
    const workingDir = frozenNodeWorkingDir(read.envelope);
    const projectDir = frozenNodeProjectDir(read.envelope);
    if (workingDir === undefined && projectDir === undefined) return { kind: 'decided', dir: { kind: 'default' } };
    const botName = deps.botName(executingLarkAppId);
    const config = deps.botWorkingDirConfig(executingLarkAppId);
    if (workingDir !== undefined) {
      if (!config) return { kind: 'decided', dir: { kind: 'refused', reason: `指定的工作目录 ${workingDir}：读不到 ${botName} 的配置，无法核对目录范围` } };
      return { kind: 'check', runDir, workingDir, config, botName, label: '指定的工作目录' };
    }
    // The launching draft's project is for a bot without a default working
    // dir of its own; one with a default keeps it, exactly as before.
    if (!config) return { kind: 'decided', dir: { kind: 'refused', reason: `工作流的项目目录 ${projectDir}：读不到 ${botName} 的配置，无法确认它有没有默认工作目录` } };
    if (effectiveDefaultWorkingDir(config)) return { kind: 'decided', dir: { kind: 'default' } };
    return { kind: 'check', runDir, workingDir: projectDir!, config, botName, label: '工作流的项目目录' };
  }

  function nodeWorkingDirFrom(verdict: NodeWorkingDirVerdict, botName: string, label: string): WorkflowNodeWorkingDir {
    if (verdict.ok) return { kind: 'pinned', dir: verdict.path };
    if (verdict.operateUnknown !== undefined) {
      return {
        kind: 'refused',
        reason: `${label} ${verdict.path}：暂时无法确认发起人能否操作 ${botName}（${verdict.operateUnknown}），`
          + `而这个目录${verdict.reason === 'no_range' ? '不在它的目录范围内（它没有配置目录范围）' : '不在它配置的目录范围内'}。`
          + '稍后重试，或把这个目录加进它的默认工作目录或仓库目录，或改派。',
      };
    }
    return {
      kind: 'refused',
      reason: `${label} ${verdict.path}：${describeBotWorkingDirRefusal(verdict)}。`
        + `以 ${botName} 现在的配置为准（批准后可能改过）；把这个目录加进它的默认工作目录或仓库目录后重试，或改派。`,
    };
  }

  /** §15.4 on the executing bot, now: {@link checkNodeWorkingDir} against
   *  its current configuration and the initiator's operate right.
   *  `preflight`: the main bot's own node before its cards go out — a
   *  refusal there is final, a pass is decided again at the start. */
  async function nodeWorkingDir(
    runDir: string | undefined,
    runId: string,
    executingLarkAppId: string,
    when: 'start' | 'preflight' = 'start',
  ): Promise<WorkflowNodeWorkingDir> {
    const input = nodeWorkingDirInput(runDir, runId, executingLarkAppId);
    if (input.kind === 'decided') return input.dir;
    const verdict = await checkNodeWorkingDir(input.config, input.workingDir, async () => {
      const run = frozenOperateRun(input.runDir, runId);
      if (run === undefined) return 'no';
      if ('unreadable' in run) return { unknown: run.unreadable };
      if (when === 'preflight') return initiatorOperatesBeforeStart(run);
      // The node is about to start: read the chat's members now.
      return initiatorOperates(run, runId, executingLarkAppId, { freshMembership: true });
    });
    return nodeWorkingDirFrom(verdict, input.botName, input.label);
  }

  /** Tell the main bot this handoff's node session was not started. The
   *  reason is first recorded on the handoff's registry entry, where the main
   *  bot's acceptance check reads it; the direct notice that blocks the node
   *  at once is retried once — after an error answer or an unreachable daemon
   *  alike. Should both fail, the node still blocks at the acceptance
   *  deadline (HANDOFF_NOT_ACCEPTED), with this reason in its message. */
  /**
   * §5.5: one main-topic session carries at most one node at a time. Another
   * run in the same topic handing a main-topic node to the same bot while its
   * node is in progress would overwrite that marker — the first node could
   * then neither be stopped nor tell its turns apart. The later handoff is
   * refused, visibly (the node blocks; its main bot is woken and may reassign
   * it or move it to a node topic). An earlier node whose handoff was revoked
   * (its stop may not have reached this daemon) no longer counts.
   */
  function mainTopicBusyReason(
    placement: 'main' | undefined,
    nonce: string,
    existing: WorkflowNodeSessionMarker | undefined,
    executingLarkAppId: string,
  ): string | undefined {
    if (placement !== 'main' || !existing || existing.placement !== 'main' || existing.nonce === nonce) return undefined;
    if (closeMainMarkerIfOver(existing)) return undefined;
    return `${deps.botName(executingLarkAppId)} 在主话题里正在执行另一个工作流节点（run ${existing.runId} 的 ${existing.nodeId}），`
      + '同一个会话不能同时执行两个节点；等它结束后重试，或改派，或把这个节点改成节点话题';
  }

  /** Slack on top of a main-topic attempt's latest possible deadline. */
  const MAIN_MARKER_EXPIRY_SLACK_MS = 10 * 60_000;

  /**
   * F5: is this main-topic marker's attempt over, even though no stop or
   * submission reached this session? Over when it is no longer active, its
   * handoff was revoked, its binding is gone (registry entries are pruned
   * after two days, revocations included — a marker whose binding cannot be
   * found is never treated as a node in progress), or it is past the latest
   * deadline the attempt can have (from its start: the node timeout; never
   * started: acceptance + timeout + queue grace) plus a slack. An over marker
   * is closed in every session holding it, so the session stops counting as
   * occupied and stops reporting for it.
   */
  function closeMainMarkerIfOver(marker: WorkflowNodeSessionMarker): boolean {
    if (marker.placement !== 'main') return false;
    if (!workflowNodeMarkerActive(marker)) return true;
    const found = lookupWorkflowHandoffByNonce({ registry: readDispatchRegistryLoose(deps.dataDir()), nonce: marker.nonce, secret: deps.bindingSecret() });
    let over = found.kind !== 'workflow' || found.revoked;
    if (!over) {
      const runDir = runDirOf(marker.runId);
      // The node's own timeout; when the run or the node cannot be read here,
      // the ceiling any node may have — an early "over" would close the
      // marker of a node that is still running.
      let timeoutSec = MAX_NODE_TIMEOUT_SEC;
      try {
        const node = runDir ? deps.loadRun(runDir)?.dag.nodes.find((candidate) => candidate.id === marker.nodeId) : undefined;
        if (node) timeoutSec = node.timeoutSec ?? DEFAULT_NODE_TIMEOUT_SEC;
      } catch { /* the ceiling */ }
      const timeoutMs = timeoutSec * 1000;
      const started = marker.handoffStartedAt ? Date.parse(marker.handoffStartedAt) : NaN;
      const registered = Date.parse(marker.registeredAt);
      const latest = Number.isFinite(started)
        ? started + timeoutMs
        : (Number.isFinite(registered) ? registered : 0) + timeoutMs + v3MainTopicQueueGraceMs(timeoutMs);
      over = (deps.now ?? Date.now)() > latest + MAIN_MARKER_EXPIRY_SLACK_MS;
    }
    if (over) closeMainMarker(undefined, marker.nonce);
    return over;
  }

  async function refuse(
    binding: { nonce: string; sourceLarkAppId: string },
    handoffMessageId: string,
    reason: string,
    errorCode?: 'MAIN_TOPIC_BUSY',
  ): Promise<void> {
    try {
      await recordWorkflowHandoffRefusal(deps.dataDir(), deps.bindingSecret(), binding.nonce, reason);
    } catch (err) {
      deps.warn(`[workflow] recording the refusal of ${binding.nonce} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const event: WorkflowHandoffEvent = {
      kind: 'refused', nonce: binding.nonce, dispatchRoot: handoffMessageId, reason, ...(errorCode ? { errorCode } : {}),
    };
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
    ...(deps.daemonHandlesMainPlacement ? { daemonHandlesMainPlacement: deps.daemonHandlesMainPlacement } : {}),
    ...(deps.mainTopicThreadId ? { mainTopicThreadId: deps.mainTopicThreadId } : {}),
    workingDirPreflight: async (request) => {
      const self = deps.selfLarkAppId();
      // The main bot's own node: refused here, before its cards go out, when
      // it can be without the chat's members (read once, by startSelfTurn).
      if (request.targetLarkAppId === self) {
        const dir = await nodeWorkingDir(request.runDir, request.runId, self, 'preflight');
        return dir.kind === 'refused' ? dir.reason : undefined;
      }
      // Another bot decides against its own range when the handoff arrives;
      // a daemon that does not know about the directory would start the node
      // in its default one instead, so it is not handed off at all.
      const read = readRunEnvelope(request.runDir, request.runId);
      if (read.kind !== 'ok') return undefined;
      if (frozenNodeWorkingDir(read.envelope) !== undefined && !deps.daemonAppliesNodeWorkingDir(request.targetLarkAppId)) {
        return `${deps.botName(request.targetLarkAppId)} 的 daemon 版本过旧，不支持指定工作目录；把它升级到与主 Bot 相同的版本后重试，或改派`;
      }
      // The launch wrote the project only when every executing bot's daemon
      // read it; a bot reassigned (or downgraded) since cannot read run.json.
      if (frozenNodeProjectDir(read.envelope) !== undefined && !deps.daemonReadsNodeProjectDir(request.targetLarkAppId)) {
        return `${deps.botName(request.targetLarkAppId)} 的 daemon 版本过旧，读不了带项目目录的工作流记录；把它升级到与主 Bot 相同的版本后重试，或改派`;
      }
      return undefined;
    },
    startSelfTurn: async (input: V3SelfTurnRequest) => {
      const runDir = input.runDir;
      // §15.4 for the main bot's own nodes too: its current configuration
      // and the initiator's operate right decide, and a refusal blocks the
      // node (nothing is started). Decided FIRST: it may wait for lookups,
      // and everything below (busy session, existing session, revocation)
      // is read after the wait, never before it.
      const dir = knownNodeWorkingDir(await nodeWorkingDir(runDir, input.marker.runId, deps.selfLarkAppId()));
      // §5.5: the main session already carries another run's main-topic node.
      const reused = deps.findNodeSession(input.publishRoot, deps.selfLarkAppId());
      const busy = reused && reused.session.status !== 'closed'
        ? mainTopicBusyReason(input.marker.placement, input.marker.nonce, reused.session.workflowNode, deps.selfLarkAppId())
        : undefined;
      if (busy) {
        deps.warn(`[workflow] node ${input.marker.nodeId} of ${input.marker.runId} not started: ${busy}`);
        await refuse({ nonce: input.marker.nonce, sourceLarkAppId: deps.selfLarkAppId() }, input.handoffMessageId, busy, 'MAIN_TOPIC_BUSY');
        return { refused: true as const };
      }
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
          const reason = existingSessionDirRefusal(input.marker.placement);
          deps.warn(`[workflow] node ${input.marker.nodeId} of ${input.marker.runId}: the node topic's session runs in ${existingDir}, not ${dir.dir}`);
          await refuse({ nonce: input.marker.nonce, sourceLarkAppId: self }, input.handoffMessageId, reason);
          return { refused: true as const };
        }
      }
      // A cancel / timeout / reassignment may have landed while the directory
      // was being decided: its stop() revoked the binding or closed the
      // attempt. Never start that turn (the executor checked only before).
      if (isRevoked(input.marker.nonce)
        || !classifyExternalAttempt(readJournal(join(runDir, 'journal.ndjson')), input.marker.attemptId).ok) {
        deps.warn(`[workflow] node ${input.marker.nodeId} of ${input.marker.runId} not started: stopped while its directory was being decided`);
        return { refused: true as const };
      }
      const startDir = startDirOf(dir);
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
        ...(startDir !== undefined ? { workingDir: startDir } : {}),
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
    handoffCardInput: (runDir, attemptId) => {
      try {
        return readV3HandoffCardInput(safeExternalAttemptDir(runDir, attemptId));
      } catch {
        return undefined;
      }
    },
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
    return marker && !marker.submittedAt && workflowNodeMarkerActive(marker) ? marker : undefined;
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

  const wiring: WorkflowNodeDaemon = {
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
      markClosed: closeMainMarker,
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
    admitInboundHandoff: async (input) => {
      const decided = await nodeWorkingDir(runDirOf(input.binding.workflow.runId), input.binding.workflow.runId, input.executingLarkAppId);
      const session = input.currentSession();
      if (session === 'stale') return { kind: 'stale' };
      // Stopped while the directory was being decided: never start its turn.
      if (isRevoked(input.binding.nonce)) return { kind: 'revoked' };
      const described = input.describeSession(session);
      return {
        kind: 'admission',
        session,
        admission: wiring.admitInbound(input.binding, input.handoffMessageId, input.executingLarkAppId, described.dir, described.marker, decided),
      };
    },
    workingDirOperatorRoute: async (raw) => {
      const request = parseWorkflowWorkingDirOperatorRequest(raw);
      const runDir = request ? runDirOf(request.runId) : undefined;
      if (!request || !runDir) return { status: 400, body: { ok: false, error: 'invalid_request' } };
      const self = deps.selfLarkAppId();
      // Bound to a run waiting at Gate-2 whose node this bot executes: the
      // asker names no person or chat, this daemon reads both from the run.
      const run = pendingOperateRun(runDir, request.runId);
      if (!run || run.executorOf?.(request.nodeId) !== self) return { status: 404, body: { ok: false, error: 'no_such_node' } };
      const operate = await initiatorOperates(run, request.runId, self);
      return { status: 200, body: { ok: true, operate } };
    },
    initiatorUnionRoute: async (raw) => {
      const request = parseWorkflowInitiatorUnionRequest(raw);
      const runDir = request ? runDirOf(request.runId) : undefined;
      if (!request || !runDir) return { status: 400, body: { ok: false, error: 'invalid_request' } };
      // Only this bot's own runs that pin a working dir or carry a project (or
      // wait at Gate-2, where one may be asked for), and only to one of their
      // executing bots.
      const frozen = frozenOperateRun(runDir, request.runId);
      const run = frozen !== undefined && !('unreadable' in frozen) ? frozen : pendingOperateRun(runDir, request.runId);
      if (!run || run.initiator.sourceLarkAppId !== deps.selfLarkAppId()
        || !run.executors.has(request.requesterLarkAppId) || request.requesterLarkAppId === deps.selfLarkAppId()) {
        return { status: 404, body: { ok: false, error: 'run_not_eligible' } };
      }
      if (run.initiator.unionId) return { status: 200, body: { ok: true, unionId: run.initiator.unionId } };
      let got: { unionId: string } | { unknown: string };
      try {
        got = deps.lookupOwnUnionId ? await deps.lookupOwnUnionId(run.initiator.openId) : { unknown: '主 Bot 查不到发起人的跨应用身份' };
      } catch {
        got = { unknown: '主 Bot 查询发起人的跨应用身份失败' };
      }
      return 'unionId' in got && isWorkflowUnionId(got.unionId)
        ? { status: 200, body: { ok: true, unionId: got.unionId } }
        : { status: 503, body: { ok: false, error: 'unknown' in got ? got.unknown : '主 Bot 查不到发起人的跨应用身份' } };
    },
    admitInbound: (binding, handoffMessageId, executingLarkAppId, existingSessionDir, existingMarker, decidedDir) => {
      const busy = mainTopicBusyReason(binding.placement, binding.nonce, existingMarker, executingLarkAppId);
      if (busy) {
        deps.warn(`[workflow] handoff ${handoffMessageId} not started: ${busy}`);
        void refuse(binding, handoffMessageId, busy, 'MAIN_TOPIC_BUSY');
        return { start: false, reason: busy };
      }
      let dir = knownNodeWorkingDir(decidedDir);
      if (dir === UNDECIDED_NODE_WORKING_DIR && decidedDir !== UNDECIDED_NODE_WORKING_DIR) {
        deps.warn(`[workflow] handoff ${handoffMessageId}: not a working-dir decision (${typeof decidedDir === 'object' && decidedDir !== null ? `kind ${String((decidedDir as { kind?: unknown }).kind)}` : typeof decidedDir})`);
      }
      // The node topic already has a session (someone @-ed the bot there, or
      // moved it with /cd): the handoff would run where that session runs.
      if (dir.kind === 'pinned' && workflowNodeSessionDirConflicts(dir.dir, existingSessionDir)) {
        deps.warn(`[workflow] handoff ${handoffMessageId}: the existing session runs in ${existingSessionDir}, not ${dir.dir}`);
        dir = { kind: 'refused', reason: existingSessionDirRefusal(binding.placement) };
      }
      if (dir.kind === 'refused') {
        void refuse(binding, handoffMessageId, dir.reason);
        return { start: false, reason: dir.reason };
      }
      const workingDir = startDirOf(dir);
      return workingDir !== undefined ? { start: true, workingDir } : { start: true };
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
      // F5: a main-topic marker whose attempt ended out of this daemon's
      // sight (a stop that never arrived) is collected on the next input.
      const held = ds.session.workflowNode;
      // (A revoked one goes the stop path below: its running turn is interrupted.)
      if (held?.placement === 'main' && workflowNodeMarkerActive(held) && !isRevoked(held.nonce)
        && closeMainMarkerIfOver(held)) return;
      const marker = openMarker(ds);
      if (!marker) return;
      const sessionId = ds.session.sessionId;
      if (isRevoked(marker.nonce)) {
        // Stopped while this turn was being handed in: stop it now.
        stopHandoffTurn(marker.nonce, sessionId, { evenIfIdle: true });
        return;
      }
      // A main-topic session is shared with the main bot's own synthetic turns
      // (event wakes, schedules, report relays): only the handoff's turn and
      // turns opened by messages in the topic belong to the node.
      // Before the handoff's own turn started, no other turn is the node's
      // either: it is someone else's turn ahead of it in the queue.
      if (marker.placement === 'main' && context.turnId !== marker.handoffMessageId
        && (!marker.handoffStartedAt || !/^(om_|join_)/.test(context.turnId))) return;
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
      let current = ds.session.workflowNode;
      if (current?.placement === 'main' && current.lastTurn && !current.lastTurn.settledAt) {
        // Whatever turn that was, the session is idle again.
        current = { ...current, lastTurn: { ...current.lastTurn, settledAt: new Date(context.at).toISOString() } };
        ds.session.workflowNode = current;
        deps.updateSession(ds);
      }
      if (current?.placement === 'main' && current.handoffStartedAt && !current.handoffSettledAt) {
        // §5.5: the first working → idle edge after the handoff turn started
        // ends that CLI turn, whatever turn id the frame names (a respawned
        // worker sends none; another turn may have taken over the envelope).
        ds.session.workflowNode = { ...current, handoffSettledAt: new Date(context.at).toISOString() };
        deps.updateSession(ds);
        // The start notice may have been lost; it is idempotent on the main
        // bot's side, so say it once more (the deadline then counts from it).
        if (workflowNodeMarkerActive(current)) {
          const sessionId = ds.session.sessionId;
          const startedAt = Date.parse(current.handoffStartedAt);
          notify({
            kind: 'accepted', nonce: current.nonce, dispatchRoot: current.handoffMessageId, sessionId,
            ...(Number.isFinite(startedAt) ? { startedAt } : {}),
          }, current.orchestratorAppId);
        }
      }
      const marker = openMarker(ds);
      if (!marker || !context.turnId) return;
      // Only turns started under this handoff: an idle edge of a turn that
      // was already in flight before it was registered must not stall it.
      if (context.turnId !== marker.handoffMessageId && !marker.turnIds?.includes(context.turnId)) return;
      notify({ kind: 'stalled', nonce: marker.nonce, dispatchRoot: marker.handoffMessageId, sessionId: ds.session.sessionId, at: context.at },
        marker.orchestratorAppId);
    },
    onTurnStarted: (ds, context) => {
      let marker = ds.session.workflowNode;
      if (!marker) return;
      const sessionId = ds.session.sessionId;
      if (marker.placement === 'main' && workflowNodeMarkerActive(marker) && context.turnId !== marker.handoffMessageId) {
        // Persisted (F2): a stop after a restart still finds the node's
        // later turn — and knows which worker generation it ran in.
        marker = { ...marker, lastTurn: { turnId: context.turnId } };
        ds.session.workflowNode = marker;
        deps.updateSession(ds);
      }
      // Only a main-topic handoff's own turn: a node topic's timeout already
      // counts from acceptance.
      if (marker.placement !== 'main' || context.turnId !== marker.handoffMessageId) return;
      if (!marker.handoffStartedAt) {
        // Persisted: a stop (also after a restart) knows the node's turn runs.
        marker = {
          ...marker,
          handoffStartedAt: new Date(context.startedAt).toISOString(),
          ...(ds.workerGeneration !== undefined ? { handoffWorkerGeneration: ds.workerGeneration } : {}),
        };
        ds.session.workflowNode = marker;
        deps.updateSession(ds);
      }
      const started = marker;
      if (!workflowNodeMarkerActive(marker) || isRevoked(marker.nonce)) {
        // Stopped while it waited in the queue: it must not run.
        if (!marker.closedAt && !marker.submittedAt) {
          ds.session.workflowNode = { ...marker, closedAt: new Date().toISOString() };
          deps.updateSession(ds);
        }
        withdrawIdentity(ds, marker.handoffMessageId);
        deps.interruptTurn(ds, { evenIfIdle: true });
        return;
      }
      // §5.5: queued handoffs were accepted on entering the queue; the node's
      // deadline counts from here.
      notify({
        kind: 'accepted',
        nonce: marker.nonce,
        dispatchRoot: marker.handoffMessageId,
        sessionId,
        startedAt: context.startedAt,
      }, started.orchestratorAppId, (result) => stopIfRevoked(result, sessionId, started.nonce));
    },
  };
  return wiring;
}
