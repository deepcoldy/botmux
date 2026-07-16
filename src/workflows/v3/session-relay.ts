/**
 * Session-scoped relay authorization for Workflow v3 daemon mutations.
 *
 * A sandboxed (Linux bwrap) or read-isolated (macOS) chat CLI cannot use the
 * host mutation path: the process-tree markers, the run directory, and the
 * host `.dashboard-secret` are all masked by design, so
 * `authorizeV3DaemonCommand` + `postWorkflowDaemonMutation` fail before any
 * request leaves the sandbox. Instead of carving the global secret into the
 * sandbox (which would collapse the isolation boundary), the CLI presents its
 * per-turn rotating capability — the same aperture `/api/asks` already uses —
 * and this host-side module re-derives EVERY identity field from the daemon's
 * own live session record. The caller chooses nothing but the target runId
 * and the mutation payload; session/chat/caller identity is bound server-side.
 */

import { authorizeSessionScopedIpc } from '../../core/daemon-ipc-session-auth.js';
import {
  parseWorkflowDaemonMutationBody,
} from './daemon-ipc-body.js';
import type { WorkflowDaemonMutation } from './daemon-ipc-client.js';
import {
  authorizeV3RunMutationForCurrentTuple,
  V3DaemonCommandAuthorityError,
} from './cli-daemon-command-authority.js';
import { isValidRunId } from './ops-projection.js';

export const V3_SESSION_RUN_MUTATION_ROUTE_PREFIX = '/api/v3/session-runs';

export const V3_SESSION_RUN_MUTATIONS = ['start', 'cancel', 'retry', 'grant'] as const;

export function isV3SessionRunMutation(value: string): value is WorkflowDaemonMutation {
  return (V3_SESSION_RUN_MUTATIONS as readonly string[]).includes(value);
}

/** Live view of the claimed session, provided by the daemon's own registry. */
export interface V3SessionRelaySessionView {
  receiver: boolean;
  liveOrigin?: { capability: string; turnId?: string; dispatchAttempt?: number };
  callerOpenId?: string;
  chatId?: string;
  larkAppId?: string;
  /** The session's CURRENT inbound turn pointer — advances the moment the next
   * message arrives, while liveOrigin only rotates when that message is
   * actually dequeued into the CLI. The generation join below compares them. */
  quoteTargetId?: string;
  /** Chat-scope fold-back turn pointer (currentReplyTarget.turnId), advanced
   * together with quoteTargetId. */
  currentReplyTargetTurnId?: string;
}

export type V3SessionRelayDecision =
  | {
      ok: true;
      body: Record<string, unknown>;
      runDir: string;
      /** Owning bot from the run binding (== the daemon's own app id). */
      larkAppId: string;
    }
  | { ok: false; status: number; error: string; detail?: string };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Mutation payload keys the relay forwards; everything else is dropped so a
 * sandboxed caller cannot smuggle fields past the shared body parser. */
const MUTATION_BODY_KEYS: Record<WorkflowDaemonMutation, readonly string[]> = {
  start: [],
  cancel: ['reason'],
  retry: ['nodeId'],
  grant: ['loopId'],
};

/**
 * Authorize one relayed mutation request. Deliberately pure: the daemon route
 * supplies the live session view and trusted-host flag, so the full
 * capability → session → run-binding chain is unit-testable without HTTP.
 */
export function authorizeV3SessionRunMutationRequest(input: {
  runId: string;
  mutation: string;
  /** Parsed JSON request body (untrusted). */
  raw: unknown;
  trustedHost: boolean;
  /** undefined when the claimed sessionId has no live session on this daemon. */
  session: V3SessionRelaySessionView | undefined;
  selfLarkAppId: string | undefined;
  baseDir: string;
}): V3SessionRelayDecision {
  if (!isV3SessionRunMutation(input.mutation)) {
    return { ok: false, status: 404, error: 'unknown_mutation' };
  }
  if (!isValidRunId(input.runId)) {
    return { ok: false, status: 400, error: 'bad_run_id' };
  }
  if (!nonEmpty(input.selfLarkAppId)) {
    return { ok: false, status: 503, error: 'workflow_ipc_identity_unavailable' };
  }
  const body = input.raw && typeof input.raw === 'object' && !Array.isArray(input.raw)
    ? input.raw as Record<string, unknown>
    : undefined;
  if (!body) return { ok: false, status: 400, error: 'bad_json' };
  const sessionId = body.sessionId;
  if (!nonEmpty(sessionId)) return { ok: false, status: 400, error: 'missing_session_id' };

  const claimedAttempt = typeof body.originDispatchAttempt === 'number'
    && Number.isSafeInteger(body.originDispatchAttempt)
    && body.originDispatchAttempt > 0
    ? body.originDispatchAttempt
    : undefined;
  const verified = authorizeSessionScopedIpc({
    trustedHost: input.trustedHost,
    sessionExists: !!input.session,
    receiverSession: !!input.session?.receiver,
    // A meeting receiver must not drive workflow runs: its side effects belong
    // to the managed action ledger, same posture as /api/asks.
    allowReceiver: false,
    sessionId,
    ...(input.session?.liveOrigin ? { liveOrigin: input.session.liveOrigin } : {}),
    ...(typeof body.originCapability === 'string'
      ? { claimedCapability: body.originCapability }
      : {}),
    ...(typeof body.originTurnId === 'string' ? { claimedTurnId: body.originTurnId } : {}),
    ...(claimedAttempt !== undefined ? { claimedDispatchAttempt: claimedAttempt } : {}),
  });
  if (!verified.ok) return { ok: false, status: 403, error: verified.error };
  if (input.session?.receiver) {
    return { ok: false, status: 403, error: 'managed_action_required' };
  }

  // The capability authenticates exactly one live daemon session. Every field
  // of the mutation tuple now comes from that session record — the request
  // body cannot select another caller/chat/bot.
  const current = input.session;
  if (!current
    || !nonEmpty(current.callerOpenId)
    || !nonEmpty(current.chatId)
    || !nonEmpty(current.larkAppId)) {
    return { ok: false, status: 403, error: 'session_identity_incomplete' };
  }
  if (current.larkAppId !== input.selfLarkAppId) {
    return { ok: false, status: 403, error: 'session_identity_incomplete' };
  }

  // Generation join, mirroring the host path (current-turn-provenance.ts):
  // lastCallerOpenId/quoteTargetId advance the moment the NEXT inbound message
  // arrives, while the capability rotates only when that message is dequeued
  // into the CLI (worker flushPending). The capability therefore proves turn
  // A, but the caller fields may already describe a queued turn B — mixing the
  // two would let A borrow B's identity. Only when the live capability's
  // turnId IS the session's current turn pointer do all tuple fields belong to
  // one generation (they are written atomically per inbound message);
  // anything else fails closed, exactly like the host marker join.
  const liveTurnId = current.liveOrigin?.turnId;
  const quoteTargetId = current.quoteTargetId;
  const replyTurnId = current.currentReplyTargetTurnId;
  if (!nonEmpty(liveTurnId)
    || !nonEmpty(quoteTargetId)
    || quoteTargetId !== liveTurnId
    || (replyTurnId !== undefined && replyTurnId !== liveTurnId)) {
    return { ok: false, status: 403, error: 'turn_provenance_stale' };
  }

  let authority;
  try {
    authority = authorizeV3RunMutationForCurrentTuple({
      runId: input.runId,
      baseDir: input.baseDir,
      current: {
        callerOpenId: current.callerOpenId,
        chatId: current.chatId,
        larkAppId: current.larkAppId,
      },
    });
  } catch (err) {
    if (err instanceof V3DaemonCommandAuthorityError) {
      return { ok: false, status: 403, error: 'run_binding_mismatch', detail: err.message };
    }
    throw err;
  }
  if (authority.larkAppId !== input.selfLarkAppId) {
    return {
      ok: false,
      status: 409,
      error: 'wrong_daemon',
      detail: `run 归属 ${authority.larkAppId}`,
    };
  }

  // Re-validate the payload with the exact same parser the signed-envelope
  // route uses, from an allowlisted subset only.
  const subset: Record<string, unknown> = {};
  for (const key of MUTATION_BODY_KEYS[input.mutation]) {
    if (body[key] !== undefined) subset[key] = body[key];
  }
  const parsed = parseWorkflowDaemonMutationBody(input.mutation, JSON.stringify(subset));
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };

  return {
    ok: true,
    body: parsed.body.value as Record<string, unknown>,
    runDir: authority.runDir,
    larkAppId: authority.larkAppId,
  };
}
