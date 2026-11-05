/**
 * Daemon route logic for bot-executed workflow nodes (design 2026-11-03 §7.2,
 * §8, §9.3), kept out of daemon.ts so it is testable with real run
 * directories and fake transports:
 *
 * - {@link handleWorkflowNodeReport}: the executing bot's daemon, called by its
 *   own CLI (`botmux report --dispatch-root <handoff> …`), session-authenticated;
 * - {@link handleWorkflowHandoffEvent}: the main bot's daemon, called by the
 *   executing bot's daemon (or in-process for its own nodes), trusted-host IPC.
 *   It is the only writer of the run journal;
 * - {@link handleWorkflowHandoffStop}: the executing bot's daemon, asked by the
 *   main bot's daemon to stop the node's current turn (cancel / timeout …).
 *
 * Every entry re-verifies the host-signed handoff binding and refuses a
 * revoked one (an attempt the engine stopped); the engine then decides whether
 * the attempt is still the current one (late / foreign / duplicate
 * submissions are refused there).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { V3Dag, V3GoalNode } from '../workflows/v3/dag.js';
import { isGoalNode } from '../workflows/v3/dag.js';
import {
  externalAttemptNode,
  ingestExternalSubmission,
  recordExternalAccepted,
  recordExternalStalled,
  reportExternalBlocked,
  safeExternalAttemptDir,
  stageExternalSubmissionForInstall,
} from '../workflows/v3/external-control.js';
import { foldV3ExternalAttempts } from '../workflows/v3/external-attempt-ledger.js';
import { V3_EXTERNAL_ERROR_CODES } from '../workflows/v3/external-executor.js';
import { readJournal } from '../workflows/v3/journal.js';
import { isValidRunId } from '../workflows/v3/ops-projection.js';
import {
  lookupWorkflowHandoff,
  lookupWorkflowHandoffByNonce,
  type WorkflowHandoffBindingPayload,
  type WorkflowHandoffLookup,
} from './workflow-handoff-binding.js';
import {
  WORKFLOW_REPORT_REJECTION_TEXT,
  decodeWorkflowSubmission,
  precheckWorkflowSubmission,
  type WorkflowReportStatus,
} from './workflow-node-report.js';

export interface RouteResult {
  status: number;
  body: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const REVOKED: RouteResult = {
  status: 409,
  body: { ok: false, error: 'handoff_revoked', message: '这条交接已作废（节点已取消、超时、改派或被替代），提交不再被接受' },
};

/** A verified, unrevoked binding (by nonce when given, else by message id). */
function verifiedBinding(
  registry: Record<string, unknown>,
  secret: () => string,
  key: { nonce?: unknown; dispatchRoot?: unknown },
  opts: { allowRevoked?: boolean } = {},
): { ok: true; binding: WorkflowHandoffBindingPayload; messageId?: string } | { ok: false; result: RouteResult } {
  let found: WorkflowHandoffLookup;
  if (typeof key.nonce === 'string') {
    found = lookupWorkflowHandoffByNonce({ registry, nonce: key.nonce, secret: secret() });
  } else if (typeof key.dispatchRoot === 'string' && /^om_[A-Za-z0-9_-]{1,128}$/.test(key.dispatchRoot)) {
    found = lookupWorkflowHandoff({ registry, dispatchRoot: key.dispatchRoot, secret: secret() });
  } else {
    return { ok: false, result: { status: 400, body: { ok: false, error: 'bad_dispatch_root' } } };
  }
  if (found.kind === 'none') {
    return { ok: false, result: { status: 404, body: { ok: false, error: 'not_workflow_handoff' } } };
  }
  if (found.kind === 'unproven') {
    return { ok: false, result: { status: 403, body: { ok: false, error: 'workflow_binding_unproven' } } };
  }
  if (found.revoked && !opts.allowRevoked) return { ok: false, result: REVOKED };
  return { ok: true, binding: found.binding, ...(found.messageId ? { messageId: found.messageId } : {}) };
}

// ─── Main bot's daemon: the journal writer ─────────────────────────────────

interface EventKey {
  /** The handoff's binding nonce (primary key). */
  nonce: string;
  /** The handoff message id, when known (informational). */
  dispatchRoot?: string;
  sessionId: string;
}

export type WorkflowHandoffEvent =
  /** `startedAt`: the handoff's own turn reached the CLI (input commit) —
   *  for a main-topic handoff the node timeout counts from it (§5.5). */
  | (EventKey & { kind: 'accepted'; acceptedAt?: number; startedAt?: number })
  /** The handoff's own turn ended without an accepted submission. */
  | (EventKey & { kind: 'stalled'; at?: number })
  /** A later turn started in the node session (clears "stopped"). */
  | (EventKey & { kind: 'active'; at?: number })
  | (EventKey & { kind: 'blocked'; reason: string })
  /** The executing bot's daemon refused to start the node session in the
   *  run's Gate-2 working dir (design §15.4); no session exists for it. */
  /** `errorCode`: `MAIN_TOPIC_BUSY` when the bot's main-topic session is
   *  executing another node (§5.5); absent = the working-dir refusal. */
  | (Omit<EventKey, 'sessionId'> & { kind: 'refused'; reason: string; errorCode?: 'MAIN_TOPIC_BUSY' })
  | (EventKey & { kind: 'progress' })
  /** A submission was staged while this daemon looked offline: drive once
   *  so the staged install is committed now rather than at the next wake. */
  | (EventKey & { kind: 'wake' })
  | (EventKey & {
      kind: 'submit';
      summary: string;
      files?: Array<{ key: string; name: string; data: string }>;
      resultText?: string;
    });

export interface WorkflowHandoffEventDeps {
  selfLarkAppId: string;
  baseDir: string;
  readRegistry(): Record<string, unknown>;
  secret(): string;
  /** The authorized run (exact-byte DAG + pinned executor + chat). */
  loadRun(runDir: string): { dag: V3Dag; nodeExecutor?: 'bot'; chatId?: string } | undefined;
  /** Re-drive after a journal append. */
  drive(runId: string): void;
  now?(): number;
}

function rejection(reason: string): RouteResult {
  return {
    status: 409,
    body: { ok: false, error: reason, message: WORKFLOW_REPORT_REJECTION_TEXT[reason] ?? reason },
  };
}

/** Display-only activity of an attempt (a later turn started after a stall);
 *  never authority for anything, read by the node card. */
export const WORKFLOW_HANDOFF_ACTIVITY_FILE = 'handoff-activity.json';

export function readWorkflowHandoffActivity(runDir: string, attemptId: string): { activeAt?: number } {
  try {
    const raw = JSON.parse(readFileSync(join(safeExternalAttemptDir(runDir, attemptId), WORKFLOW_HANDOFF_ACTIVITY_FILE), 'utf-8'));
    return typeof raw?.activeAt === 'number' ? { activeAt: raw.activeAt } : {};
  } catch {
    return {};
  }
}

function writeWorkflowHandoffActivity(runDir: string, attemptId: string, activeAt: number): void {
  const dir = safeExternalAttemptDir(runDir, attemptId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, WORKFLOW_HANDOFF_ACTIVITY_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ activeAt })}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export async function handleWorkflowHandoffEvent(raw: unknown, deps: WorkflowHandoffEventDeps): Promise<RouteResult> {
  if (!isRecord(raw)) return { status: 400, body: { ok: false, error: 'bad_json' } };
  const verified = verifiedBinding(deps.readRegistry(), deps.secret, { nonce: raw.nonce, dispatchRoot: raw.dispatchRoot });
  if (!verified.ok) return verified.result;
  const binding = verified.binding;
  if (binding.sourceLarkAppId !== deps.selfLarkAppId) {
    return { status: 409, body: { ok: false, error: 'wrong_daemon', ownerLarkAppId: binding.sourceLarkAppId } };
  }
  const runId = binding.workflow.runId;
  if (!isValidRunId(runId)) return { status: 400, body: { ok: false, error: 'bad_run_id' } };
  const runDir = join(deps.baseDir, runId);
  const run = deps.loadRun(runDir);
  if (!run || run.nodeExecutor !== 'bot' || (run.chatId && run.chatId !== binding.targetChatId)) {
    return { status: 409, body: { ok: false, error: 'run_not_bot_executed' } };
  }
  if (raw.kind === 'refused') {
    // No session was started; an attempt a session already accepted is not
    // closed by this (reportExternalBlocked: session-mismatch).
    const reason = typeof raw.reason === 'string' ? raw.reason : '';
    const outcome = reportExternalBlocked(runDir, {
      attemptId: binding.workflow.attemptId,
      ...(binding.workflow.instanceId ? { instanceId: binding.workflow.instanceId } : {}),
      reason,
      errorCode: raw.errorCode === V3_EXTERNAL_ERROR_CODES.MAIN_TOPIC_BUSY
        ? V3_EXTERNAL_ERROR_CODES.MAIN_TOPIC_BUSY
        : V3_EXTERNAL_ERROR_CODES.WORKING_DIR_REFUSED,
    });
    if (!outcome.ok) return rejection(outcome.reason);
    deps.drive(runId);
    return { status: 200, body: { ok: true, outcome: 'blocked' } };
  }
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : undefined;
  if (!sessionId) return { status: 400, body: { ok: false, error: 'missing_session_id' } };
  const identity = {
    attemptId: binding.workflow.attemptId,
    ...(binding.workflow.instanceId ? { instanceId: binding.workflow.instanceId } : {}),
    sessionId,
  };
  const ctx = { dag: run.dag, ...(deps.now ? { now: deps.now } : {}) };
  const now = deps.now ?? Date.now;

  switch (raw.kind) {
    case 'accepted': {
      const acceptedAt = typeof raw.acceptedAt === 'number' && Number.isFinite(raw.acceptedAt) ? raw.acceptedAt : undefined;
      const startedAt = typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt) ? raw.startedAt : undefined;
      const outcome = recordExternalAccepted(runDir, {
        ...identity,
        ...(acceptedAt !== undefined ? { acceptedAt } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
      }, ctx);
      if (!outcome.ok) return rejection(outcome.reason);
      if (!outcome.alreadyAccepted) deps.drive(runId);
      return { status: 200, body: { ok: true, deadlineAt: outcome.deadlineAt } };
    }
    case 'stalled': {
      const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : undefined;
      const outcome = recordExternalStalled(runDir, { ...identity, ...(at !== undefined ? { at } : {}) }, ctx);
      if (!outcome.ok) return rejection(outcome.reason);
      deps.drive(runId);
      return { status: 200, body: { ok: true } };
    }
    case 'active': {
      // Display only: the session works again. Same current-attempt rule as
      // every other event, but nothing is journalled.
      const attempt = foldV3ExternalAttempts(readJournal(join(runDir, 'journal.ndjson'))).get(binding.workflow.attemptId);
      if (!attempt || attempt.closed) return rejection('closed');
      if (attempt.sessionId !== undefined && attempt.sessionId !== sessionId) return rejection('session-mismatch');
      const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? Math.min(raw.at, now()) : now();
      writeWorkflowHandoffActivity(runDir, binding.workflow.attemptId, at);
      deps.drive(runId);
      return { status: 200, body: { ok: true } };
    }
    case 'blocked': {
      const reason = typeof raw.reason === 'string' ? raw.reason : '';
      const outcome = reportExternalBlocked(runDir, { ...identity, reason });
      if (!outcome.ok) return rejection(outcome.reason);
      deps.drive(runId);
      return { status: 200, body: { ok: true, outcome: 'blocked' } };
    }
    case 'progress':
      return { status: 200, body: { ok: true, outcome: 'progress' } };
    case 'wake':
      deps.drive(runId);
      return { status: 200, body: { ok: true } };
    case 'submit': {
      const decoded = decodeWorkflowSubmission(raw);
      if (!decoded.ok) return { status: 400, body: { ok: false, error: decoded.error } };
      const parsed = parseResult(decoded.value.resultText);
      if (!parsed.ok) return parsed.result;
      const outcome = await ingestExternalSubmission(runDir, {
        ...identity,
        files: decoded.value.files.map((file) => ({ key: file.key, name: file.name, data: file.data })),
        ...(parsed.result !== undefined ? { result: parsed.result } : {}),
        summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 4000) : '',
      }, ctx);
      if (!outcome.ok) {
        if (outcome.reason === 'invalid') {
          return { status: 422, body: { ok: false, error: 'invalid', problems: outcome.problems } };
        }
        return rejection(outcome.reason);
      }
      deps.drive(runId);
      const accepted = foldV3ExternalAttempts(readJournal(join(runDir, 'journal.ndjson'))).get(binding.workflow.attemptId);
      const elapsedMs = accepted?.acceptedAt !== undefined ? Math.max(0, now() - accepted.acceptedAt) : undefined;
      return {
        status: 200,
        body: {
          ok: true,
          outcome: outcome.kind,
          ...(outcome.kind === 'revisit' ? { toNodeId: outcome.toNodeId } : {}),
          ...(outcome.kind === 'blocked' ? { errorCode: outcome.errorCode } : {}),
          ...(elapsedMs !== undefined ? { elapsedMs } : {}),
        },
      };
    }
    default:
      return { status: 400, body: { ok: false, error: 'bad_event_kind' } };
  }
}

function parseResult(resultText: string | undefined): { ok: true; result?: unknown } | { ok: false; result: RouteResult } {
  if (resultText === undefined) return { ok: true };
  try {
    return { ok: true, result: JSON.parse(resultText) };
  } catch (err) {
    return {
      ok: false,
      result: {
        status: 422,
        body: { ok: false, error: 'invalid', problems: [`result.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] },
      },
    };
  }
}

// ─── Executing bot's daemon: CLI submission ────────────────────────────────

export interface WorkflowNodeReportSession {
  sessionId: string;
  larkAppId: string;
  chatId: string;
  scope?: 'thread' | 'chat';
  rootMessageId?: string;
  /** The session's verified handoff marker, if any. For a main-topic
   *  handoff (§5.5) also whether its own turn has started and whether the
   *  attempt is still in progress in this session. */
  workflowNode?: { handoffMessageId: string; nonce: string; placement?: 'main'; started?: boolean; active?: boolean };
}

export interface WorkflowNodeReportDeps {
  selfLarkAppId: string;
  /** Session-scoped authorization of the calling CLI (live turn capability). */
  authorize(raw: unknown): { ok: true; session: WorkflowNodeReportSession } | { ok: false; status: number; error: string };
  readRegistry(): Record<string, unknown>;
  secret(): string;
  /** The node's contract for pre-validation; undefined = skip (the main
   *  bot's daemon validates anyway). */
  loadNodeContract(binding: WorkflowHandoffBindingPayload): Pick<V3GoalNode, 'id' | 'outputs' | 'resultSchema'> | undefined;
  /** Deliver an event to the main bot's daemon. A rejected promise (network)
   *  or a 503 `orchestrator_offline` means it did not process the event. */
  forward(binding: WorkflowHandoffBindingPayload, event: WorkflowHandoffEvent): Promise<RouteResult>;
  /** Main topic (§5.5): the bot reported the node blocked and the run took
   *  it — its attempt ended without a submission. */
  markClosed?(sessionId: string, nonce: string): void;
  /** §7.2 step 3: the main bot is offline — leave the validated submission
   *  in the attempt's staging area for it to commit on its next drive. */
  stageSubmission(binding: WorkflowHandoffBindingPayload, input: {
    sessionId: string;
    files: Array<{ key: string; name: string; data: Buffer }>;
    result?: unknown;
    summary: string;
  }): Promise<RouteResult>;
  /** Remember that this session's handoff was submitted (no stall notice). */
  markSubmitted(sessionId: string, nonce: string): void;
  /** Best-effort: ask the main bot to drive once after a staged submission
   *  (it may have been online all along). Never awaited for the reply. */
  wake?(binding: WorkflowHandoffBindingPayload, sessionId: string): void;
  /** Publish the report card in the node topic (best-effort). */
  postReportCard(binding: WorkflowHandoffBindingPayload, input: {
    summary: string;
    files: Array<{ key: string; name: string; bytes: number }>;
    elapsedMs?: number;
  }): Promise<void>;
}

const REPORT_STATUSES = new Set<WorkflowReportStatus>(['completed', 'blocked', 'failed', 'in_progress', 'pending']);

const OFFLINE: RouteResult = {
  status: 503,
  body: { ok: false, error: 'orchestrator_offline', message: '主 Bot 的 daemon 不在线，稍后在本轮重试' },
};

async function forwardOrOffline(
  deps: WorkflowNodeReportDeps,
  binding: WorkflowHandoffBindingPayload,
  event: WorkflowHandoffEvent,
): Promise<RouteResult & { offline?: true }> {
  try {
    const result = await deps.forward(binding, event);
    return result.status === 503 && result.body.error === 'orchestrator_offline' ? { ...result, offline: true } : result;
  } catch {
    // The request never got an answer; the main bot did not settle anything
    // we could rely on. A staged copy is safe either way (a duplicate of an
    // already-committed submission is discarded on install).
    return { ...OFFLINE, offline: true };
  }
}

export async function handleWorkflowNodeReport(raw: unknown, deps: WorkflowNodeReportDeps): Promise<RouteResult> {
  if (!isRecord(raw)) return { status: 400, body: { ok: false, error: 'bad_json' } };
  const status = raw.status === undefined ? undefined : raw.status;
  if (status !== undefined && (typeof status !== 'string' || !REPORT_STATUSES.has(status as WorkflowReportStatus))) {
    return { status: 400, body: { ok: false, error: 'bad_status' } };
  }
  const hasFiles = (Array.isArray(raw.files) && raw.files.length > 0) || raw.resultText !== undefined;
  if (hasFiles && status !== 'completed') {
    return {
      status: 400,
      body: { ok: false, error: 'files_require_completed', message: '--output / --result-file 只能和 --status completed 一起用' },
    };
  }
  const authorized = deps.authorize(raw);
  if (!authorized.ok) return { status: authorized.status, body: { ok: false, error: authorized.error } };
  const session = authorized.session;

  const registry = deps.readRegistry();
  let verified = verifiedBinding(registry, deps.secret, { dispatchRoot: raw.dispatchRoot });
  // The message-id link is written right after the send; a session that
  // registered the handoff by its nonce still resolves it if that write was
  // lost (e.g. the main bot crashed in between).
  if (!verified.ok && verified.result.status === 404
    && session.workflowNode && session.workflowNode.handoffMessageId === raw.dispatchRoot) {
    verified = verifiedBinding(registry, deps.secret, { nonce: session.workflowNode.nonce });
  }
  if (!verified.ok) {
    if (verified.result.status === 404 && hasFiles) {
      return {
        status: 404,
        body: { ok: false, error: 'not_workflow_handoff', message: '--output / --result-file 只能用于工作流节点的交接消息（--dispatch-root 要写交接消息的 id）' },
      };
    }
    return verified.result;
  }
  const binding = verified.binding;
  if (binding.targetLarkAppId !== deps.selfLarkAppId || session.larkAppId !== deps.selfLarkAppId) {
    return { status: 403, body: { ok: false, error: 'handoff_target_mismatch', message: '这条交接不是交给本 Bot 的' } };
  }
  if (session.chatId !== binding.targetChatId
    || (session.scope ?? 'thread') !== 'thread'
    || session.rootMessageId !== binding.publishRoot) {
    return { status: 403, body: { ok: false, error: 'handoff_route_mismatch', message: '请在交接消息所在的节点话题里提交' } };
  }
  // §5.5: the main-topic session is shared with the topic's other
  // conversation. A report for the node counts only from the session that
  // holds this handoff, after its own turn started, while the attempt is in
  // progress — not from a turn that ran before it (queued) or after it ended.
  if (binding.placement === 'main') {
    const marker = session.workflowNode;
    if (!marker || marker.nonce !== binding.nonce || marker.active !== true) {
      return { status: 409, body: { ok: false, error: 'handoff_not_active', message: '这个工作流节点在本会话里的这次执行已经结束（或不是交给本会话的），不能再提交' } };
    }
    if (marker.started !== true) {
      return { status: 409, body: { ok: false, error: 'handoff_not_started', message: '这个工作流节点的交接还在排队，它这一轮开始后才能提交' } };
    }
  }

  const key = {
    nonce: binding.nonce,
    ...(typeof raw.dispatchRoot === 'string' ? { dispatchRoot: raw.dispatchRoot } : {}),
    sessionId: session.sessionId,
  };
  const content = typeof raw.content === 'string' ? raw.content : '';
  if (status === 'blocked' || status === 'failed') {
    const blocked = await deps.forward(binding, { ...key, kind: 'blocked', reason: content }).catch(() => OFFLINE);
    // The attempt is over: a main-topic session is an ordinary one again.
    if (blocked.status === 200 && blocked.body.ok === true) deps.markClosed?.(session.sessionId, binding.nonce);
    return blocked;
  }
  if (status !== 'completed') {
    return deps.forward(binding, { ...key, kind: 'progress' }).catch(() => OFFLINE);
  }

  const decoded = decodeWorkflowSubmission(raw);
  if (!decoded.ok) return { status: 400, body: { ok: false, error: decoded.error } };
  const contract = deps.loadNodeContract(binding);
  if (contract) {
    const pre = precheckWorkflowSubmission(contract, decoded.value);
    if (!pre.ok) return { status: 422, body: { ok: false, error: 'invalid', problems: pre.problems } };
  }
  const forwarded = await forwardOrOffline(deps, binding, {
    ...key,
    kind: 'submit',
    summary: content,
    files: Array.isArray(raw.files) ? raw.files as Array<{ key: string; name: string; data: string }> : [],
    ...(decoded.value.resultText !== undefined ? { resultText: decoded.value.resultText } : {}),
  });
  if (forwarded.offline) {
    const parsed = parseResult(decoded.value.resultText);
    if (!parsed.ok) return parsed.result;
    const staged = await deps.stageSubmission(binding, {
      sessionId: session.sessionId,
      files: decoded.value.files,
      ...(parsed.result !== undefined ? { result: parsed.result } : {}),
      summary: content,
    });
    if (staged.status === 202) {
      deps.markSubmitted(session.sessionId, binding.nonce);
      deps.wake?.(binding, session.sessionId);
    }
    return staged;
  }
  if (forwarded.status === 200 && forwarded.body.ok === true && forwarded.body.outcome !== 'progress') {
    deps.markSubmitted(session.sessionId, binding.nonce);
    if (forwarded.body.outcome === 'succeeded') {
      await deps.postReportCard(binding, {
        summary: content,
        files: decoded.value.files.map((file) => ({ key: file.key, name: file.name, bytes: file.data.length })),
        ...(typeof forwarded.body.elapsedMs === 'number' ? { elapsedMs: forwarded.body.elapsedMs } : {}),
      }).catch(() => undefined);
    }
  }
  const { offline: _offline, ...result } = forwarded;
  return result;
}

/** Stage a validated submission for a main bot that is offline (engine
 *  install-intent area); the result shapes for the CLI. */
export async function stageWorkflowNodeSubmission(
  baseDir: string,
  binding: WorkflowHandoffBindingPayload,
  dag: V3Dag,
  input: { sessionId: string; files: Array<{ key: string; name: string; data: Buffer }>; result?: unknown; summary: string },
): Promise<RouteResult> {
  if (!isValidRunId(binding.workflow.runId)) return { status: 400, body: { ok: false, error: 'bad_run_id' } };
  const runDir = join(baseDir, binding.workflow.runId);
  if (!existsSync(join(runDir, 'journal.ndjson'))) return { status: 404, body: { ok: false, error: 'run_missing' } };
  const outcome = await stageExternalSubmissionForInstall(runDir, {
    attemptId: binding.workflow.attemptId,
    ...(binding.workflow.instanceId ? { instanceId: binding.workflow.instanceId } : {}),
    sessionId: input.sessionId,
    files: input.files.map((file) => ({ key: file.key, name: file.name, data: file.data })),
    ...(input.result !== undefined ? { result: input.result } : {}),
    summary: input.summary.slice(0, 4000),
  }, { dag });
  if (outcome.ok) {
    return { status: 202, body: { ok: true, outcome: 'staged', message: '已提交，编排方上线后处理' } };
  }
  if (outcome.reason === 'invalid') return { status: 422, body: { ok: false, error: 'invalid', problems: outcome.problems } };
  if (outcome.reason === 'pending') {
    return { status: 409, body: { ok: false, error: 'submission_pending', message: '已有一份提交在等主 Bot 上线处理' } };
  }
  return rejection(outcome.reason);
}

/** Node contract of a handoff, read from the run's authorized artifacts. */
export function loadWorkflowNodeContract(
  runDir: string,
  dag: V3Dag,
  attemptId: string,
): V3GoalNode | undefined {
  const attempt = foldV3ExternalAttempts(readJournal(join(runDir, 'journal.ndjson'))).get(attemptId);
  if (!attempt) return undefined;
  const node = externalAttemptNode(dag, attempt);
  return node && isGoalNode(node) ? node : undefined;
}

// ─── Executing bot's daemon: stop request ──────────────────────────────────

export interface WorkflowHandoffStopDeps {
  selfLarkAppId: string;
  readRegistry(): Record<string, unknown>;
  secret(): string;
  /** Stop the turn of the session running this handoff; false = no live
   *  session/turn to stop. */
  stopHandoffTurn(nonce: string, sessionId: string | undefined): boolean;
}

export function handleWorkflowHandoffStop(raw: unknown, deps: WorkflowHandoffStopDeps): RouteResult {
  if (!isRecord(raw)) return { status: 400, body: { ok: false, error: 'bad_json' } };
  // A stop always follows the revocation: accept the revoked binding here.
  const verified = verifiedBinding(deps.readRegistry(), deps.secret, { nonce: raw.nonce, dispatchRoot: raw.dispatchRoot }, { allowRevoked: true });
  if (!verified.ok) return verified.result;
  if (verified.binding.targetLarkAppId !== deps.selfLarkAppId) {
    return { status: 409, body: { ok: false, error: 'wrong_daemon' } };
  }
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : undefined;
  const stopped = deps.stopHandoffTurn(verified.binding.nonce, sessionId);
  return { status: 200, body: { ok: true, stopped } };
}
