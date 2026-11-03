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
 * Every entry re-verifies the host-signed handoff binding keyed by the
 * handoff message id; the engine then decides whether the attempt is still
 * the current one (late / foreign / duplicate submissions are refused there).
 */

import { join } from 'node:path';

import type { V3Dag, V3GoalNode } from '../workflows/v3/dag.js';
import { isGoalNode } from '../workflows/v3/dag.js';
import {
  externalAttemptNode,
  ingestExternalSubmission,
  recordExternalAccepted,
  recordExternalStalled,
  reportExternalBlocked,
} from '../workflows/v3/external-control.js';
import { foldV3ExternalAttempts } from '../workflows/v3/external-attempt-ledger.js';
import { readJournal } from '../workflows/v3/journal.js';
import { isValidRunId } from '../workflows/v3/ops-projection.js';
import { lookupWorkflowHandoff, type WorkflowHandoffBindingPayload } from './workflow-handoff-binding.js';
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

function verifiedBinding(
  registry: Record<string, unknown>,
  secret: () => string,
  dispatchRoot: unknown,
): { ok: true; binding: WorkflowHandoffBindingPayload } | { ok: false; result: RouteResult } {
  if (typeof dispatchRoot !== 'string' || !/^om_[A-Za-z0-9_-]{1,128}$/.test(dispatchRoot)) {
    return { ok: false, result: { status: 400, body: { ok: false, error: 'bad_dispatch_root' } } };
  }
  const found = lookupWorkflowHandoff({ registry, dispatchRoot, secret: secret() });
  if (found.kind === 'none') {
    return { ok: false, result: { status: 404, body: { ok: false, error: 'not_workflow_handoff' } } };
  }
  if (found.kind === 'unproven') {
    return { ok: false, result: { status: 403, body: { ok: false, error: 'workflow_binding_unproven' } } };
  }
  return { ok: true, binding: found.binding };
}

// ─── Main bot's daemon: the journal writer ─────────────────────────────────

export type WorkflowHandoffEvent =
  | { kind: 'accepted'; dispatchRoot: string; sessionId: string; acceptedAt?: number }
  | { kind: 'stalled'; dispatchRoot: string; sessionId: string; at?: number }
  | { kind: 'blocked'; dispatchRoot: string; sessionId: string; reason: string }
  | { kind: 'progress'; dispatchRoot: string; sessionId: string }
  | {
      kind: 'submit';
      dispatchRoot: string;
      sessionId: string;
      summary: string;
      files?: Array<{ key: string; name: string; data: string }>;
      resultText?: string;
    };

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

export async function handleWorkflowHandoffEvent(raw: unknown, deps: WorkflowHandoffEventDeps): Promise<RouteResult> {
  if (!isRecord(raw)) return { status: 400, body: { ok: false, error: 'bad_json' } };
  const verified = verifiedBinding(deps.readRegistry(), deps.secret, raw.dispatchRoot);
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
      const outcome = recordExternalAccepted(runDir, { ...identity, ...(acceptedAt !== undefined ? { acceptedAt } : {}) }, ctx);
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
    case 'blocked': {
      const reason = typeof raw.reason === 'string' ? raw.reason : '';
      const outcome = reportExternalBlocked(runDir, { ...identity, reason });
      if (!outcome.ok) return rejection(outcome.reason);
      deps.drive(runId);
      return { status: 200, body: { ok: true, outcome: 'blocked' } };
    }
    case 'progress':
      return { status: 200, body: { ok: true, outcome: 'progress' } };
    case 'submit': {
      const decoded = decodeWorkflowSubmission(raw);
      if (!decoded.ok) return { status: 400, body: { ok: false, error: decoded.error } };
      let result: unknown;
      if (decoded.value.resultText !== undefined) {
        try {
          result = JSON.parse(decoded.value.resultText);
        } catch (err) {
          return {
            status: 422,
            body: { ok: false, error: 'invalid', problems: [`result.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] },
          };
        }
      }
      const outcome = await ingestExternalSubmission(runDir, {
        ...identity,
        files: decoded.value.files.map((file) => ({ key: file.key, name: file.name, data: file.data })),
        ...(result !== undefined ? { result } : {}),
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

// ─── Executing bot's daemon: CLI submission ────────────────────────────────

export interface WorkflowNodeReportSession {
  sessionId: string;
  larkAppId: string;
  chatId: string;
  scope?: 'thread' | 'chat';
  rootMessageId?: string;
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
  /** Deliver an event to the main bot's daemon. */
  forward(binding: WorkflowHandoffBindingPayload, event: WorkflowHandoffEvent): Promise<RouteResult>;
  /** Remember that this session's handoff was submitted (no stall notice). */
  markSubmitted(sessionId: string, handoffMessageId: string): void;
  /** Publish the report card in the node topic (best-effort). */
  postReportCard(binding: WorkflowHandoffBindingPayload, input: {
    summary: string;
    files: Array<{ key: string; name: string; bytes: number }>;
    elapsedMs?: number;
  }): Promise<void>;
}

const REPORT_STATUSES = new Set<WorkflowReportStatus>(['completed', 'blocked', 'failed', 'in_progress', 'pending']);

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

  const verified = verifiedBinding(deps.readRegistry(), deps.secret, raw.dispatchRoot);
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

  const content = typeof raw.content === 'string' ? raw.content : '';
  if (status === 'blocked' || status === 'failed') {
    return deps.forward(binding, { kind: 'blocked', dispatchRoot: binding.dispatchRoot, sessionId: session.sessionId, reason: content });
  }
  if (status !== 'completed') {
    return deps.forward(binding, { kind: 'progress', dispatchRoot: binding.dispatchRoot, sessionId: session.sessionId });
  }

  const decoded = decodeWorkflowSubmission(raw);
  if (!decoded.ok) return { status: 400, body: { ok: false, error: decoded.error } };
  const contract = deps.loadNodeContract(binding);
  if (contract) {
    const pre = precheckWorkflowSubmission(contract, decoded.value);
    if (!pre.ok) return { status: 422, body: { ok: false, error: 'invalid', problems: pre.problems } };
  }
  const forwarded = await deps.forward(binding, {
    kind: 'submit',
    dispatchRoot: binding.dispatchRoot,
    sessionId: session.sessionId,
    summary: content,
    files: Array.isArray(raw.files) ? raw.files as Array<{ key: string; name: string; data: string }> : [],
    ...(decoded.value.resultText !== undefined ? { resultText: decoded.value.resultText } : {}),
  });
  if (forwarded.status === 200 && forwarded.body.ok === true && forwarded.body.outcome !== 'progress') {
    deps.markSubmitted(session.sessionId, binding.dispatchRoot);
    if (forwarded.body.outcome === 'succeeded') {
      await deps.postReportCard(binding, {
        summary: content,
        files: decoded.value.files.map((file) => ({ key: file.key, name: file.name, bytes: file.data.length })),
        ...(typeof forwarded.body.elapsedMs === 'number' ? { elapsedMs: forwarded.body.elapsedMs } : {}),
      }).catch(() => undefined);
    }
  }
  return forwarded;
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
  stopHandoffTurn(handoffMessageId: string, sessionId: string | undefined): boolean;
}

export function handleWorkflowHandoffStop(raw: unknown, deps: WorkflowHandoffStopDeps): RouteResult {
  if (!isRecord(raw)) return { status: 400, body: { ok: false, error: 'bad_json' } };
  const verified = verifiedBinding(deps.readRegistry(), deps.secret, raw.dispatchRoot);
  if (!verified.ok) return verified.result;
  if (verified.binding.targetLarkAppId !== deps.selfLarkAppId) {
    return { status: 409, body: { ok: false, error: 'wrong_daemon' } };
  }
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : undefined;
  const stopped = deps.stopHandoffTurn(verified.binding.dispatchRoot, sessionId);
  return { status: 200, body: { ok: true, stopped } };
}
