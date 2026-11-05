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
import type { ScheduledTask } from '../../types.js';
import {
  authorizeV3RunEditForCurrentTuple,
  authorizeV3RunMutationForCurrentTuple,
  v3ActionCallerFor,
  V3DaemonCommandAuthorityError,
  workflowEventTurnVerifierFor,
} from './cli-daemon-command-authority.js';
import { isInboundMessageTurnId, parseWorkflowEventTurnId } from '../../core/workflow-event-turn.js';
import { isValidRunId } from './ops-projection.js';
import {
  authorizeScheduledTurn,
  parseScheduledTurnId,
  scheduledTurnAuthErrorMessage,
} from '../../core/scheduled-turn-provenance.js';

export const V3_SESSION_RUN_MUTATION_ROUTE_PREFIX = '/api/v3/session-runs';

export const V3_SESSION_RUN_MUTATIONS = ['start', 'cancel', 'retry', 'grant', 'ask-human'] as const;
export type V3SessionRunMutation = typeof V3_SESSION_RUN_MUTATIONS[number];

export function isV3SessionRunMutation(value: string): value is V3SessionRunMutation {
  return (V3_SESSION_RUN_MUTATIONS as readonly string[]).includes(value);
}

/** The scheduled-turn primitives a relayed workflow route must supply. A
 *  sandboxed CLI presenting a `schedule:` turn cannot be distinguished from a
 *  forged one without all three, so EVERY relayed verb (start/cancel/retry/
 *  grant AND status/edit) constructs its auth input through one factory —
 *  {@link v3ScheduleTurnRelayAuth} — never ad hoc: a new verb that omitted
 *  them would make the initiator's own scheduled turns fail closed (403) on
 *  sandboxed main sessions. */
export type V3RelayScheduleAuth = Pick<
  V3SessionRelayAuthInput,
  'loadScheduledTask' | 'isScheduleOwnerAllowed' | 'isScheduledTurnLive'
>;

/** Single construction point for the scheduled-turn primitives of every
 *  relayed workflow route (see {@link V3RelayScheduleAuth}). */
export function v3ScheduleTurnRelayAuth(input: {
  loadTask: (larkAppId: string, taskId: string) => ScheduledTask | undefined;
  isOwnerAllowed: (larkAppId: string, ownerOpenId: string) => boolean;
  isTurnLive: (turnId: string) => boolean;
}): V3RelayScheduleAuth {
  return {
    loadScheduledTask: input.loadTask,
    isScheduleOwnerAllowed: input.isOwnerAllowed,
    isScheduledTurnLive: input.isTurnLive,
  };
}

/** Live owner gate for scheduled turns on the relay, mirroring `canOperate`:
 *  a bot configured with NO allowlist at all is open to every chat member; a
 *  bot that has any restriction admits only its dashboard admins. Removing a
 *  task creator from the bot therefore revokes that creator's scheduled
 *  workflow authority on the next fire. */
export function v3RelayScheduleBotHasAllowlist(bot: {
  allowedUsers?: unknown[];
  allowedChatGroups?: unknown[];
  globalGrants?: unknown[];
  ownerOpenId?: string;
  p2pOpen?: boolean;
}): boolean {
  return (bot.allowedUsers?.length ?? 0) > 0
    || (bot.allowedChatGroups?.length ?? 0) > 0
    || (bot.globalGrants?.length ?? 0) > 0
    || !!bot.ownerOpenId
    || bot.p2pOpen === true;
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
  /** The session's topic root (thread scope) or current reply-target root —
   * binds a workflow event turn to its run's main session. */
  rootMessageId?: string;
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
const MUTATION_BODY_KEYS: Record<V3SessionRunMutation, readonly string[]> = {
  start: [],
  cancel: ['reason'],
  retry: ['nodeId', 'reason'],
  grant: ['loopId'],
  'ask-human': ['nodeId', 'reason'],
};

/** Mutations that record who decided them: the daemon adds the caller it
 *  derived from its own session record (never one from the body). */
const CALLER_RECORDING_MUTATIONS: ReadonlySet<V3SessionRunMutation> = new Set(['retry', 'ask-human']);

/**
 * Authorize one relayed mutation request. Deliberately pure: the daemon route
 * supplies the live session view and trusted-host flag, so the full
 * capability → session → run-binding chain is unit-testable without HTTP.
 */
export interface V3SessionRelayAuthInput {
  runId: string;
  mutation: string;
  /** Parsed JSON request body (untrusted). */
  raw: unknown;
  trustedHost: boolean;
  /** undefined when the claimed sessionId has no live session on this daemon. */
  session: V3SessionRelaySessionView | undefined;
  selfLarkAppId: string | undefined;
  baseDir: string;
  /** Reads a scheduled turn's task from the host-only authority store. Must
   *  not read schedules.json: that projection lives in BOT_HOME, which the
   *  sandboxed CLI behind this relay can write. Required only when a
   *  `schedule:` turn is presented; absent → fail closed. */
  loadScheduledTask?: (larkAppId: string, taskId: string) => ScheduledTask | undefined;
  /**
   * Live owner gate for scheduled turns: must return true iff the task's
   * creator (ownerOpenId) is still authorized for the bot. The daemon injects
   * its resolvedAllowedUsers membership check, so on THIS relay path a
   * creator removed from the bot loses workflow authority at the next
   * mutation. The default non-sandbox signed-envelope route never reaches
   * this relay and does not re-check membership (see
   * scheduled-turn-provenance). Injected rather than imported to keep this
   * module free of the daemon's bot-registry dependency.
   */
  isScheduleOwnerAllowed?: (larkAppId: string, ownerOpenId: string) => boolean;
  /** Exact daemon-owned in-flight registry check for auto-disabled one-shots. */
  isScheduledTurnLive?: (turnId: string) => boolean;
}

type RelayAuthenticated = {
  ok: true;
  body: Record<string, unknown>;
  sessionId: string;
  current: V3SessionRelaySessionView & { chatId: string; larkAppId: string };
  callerOpenId: string;
  workflowEvent: boolean;
  /** Run of the wake turn the newer message `callerOpenId` sent overtook:
   *  authenticated as that sender, decided by the main bot. */
  overtakenWakeRunId?: string;
  /** A scheduled turn of a task `callerOpenId` created. */
  scheduledTurn: boolean;
  /** The live capability's turn (audit only). */
  turnId?: string;
};

/** Capability → live session → current-turn caller, shared by every relay
 *  route. Identity comes only from the daemon's own session record. */
function authenticateRelaySession(input: V3SessionRelayAuthInput): RelayAuthenticated | Extract<V3SessionRelayDecision, { ok: false }> {
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
    || !nonEmpty(current.chatId)
    || !nonEmpty(current.larkAppId)) {
    return { ok: false, status: 403, error: 'session_identity_incomplete' };
  }
  if (current.larkAppId !== input.selfLarkAppId) {
    return { ok: false, status: 403, error: 'session_identity_incomplete' };
  }

  const liveTurnId = current.liveOrigin?.turnId;

  // Daemon-initiated scheduled turn (`schedule:<taskId>:<uuid>`): no human
  // inbound message exists, so the session row carries no
  // quoteTargetId/lastCallerOpenId for this turn. Authenticate via the task
  // binding + the LIVE owner gate — on this relay path a creator removed
  // from the bot's resolvedAllowedUsers is rejected here (the default
  // non-sandbox signed-envelope route does not reach this path; see
  // scheduled-turn-provenance). The tuple's callerOpenId is the task's
  // creator, never anything the request chooses.
  let callerOpenId: string;
  const workflowEvent = liveTurnId ? parseWorkflowEventTurnId(liveTurnId) : null;
  /** The wake turn was overtaken; the request runs as the newer human turn. */
  let overtakenWakeTurn = false;
  let scheduledTurn = false;
  if (liveTurnId && workflowEvent) {
    // Daemon-minted turn for THIS run's own events (design §13.1): it acts
    // for the run's frozen initiator, so the owner tuple below is unchanged.
    const verdict = workflowEventTurnVerifierFor(input.runId, input.baseDir)({
      ...workflowEvent,
      turnId: liveTurnId,
      session: {
        sessionId,
        larkAppId: current.larkAppId,
        chatId: current.chatId,
        ...(current.rootMessageId ? { rootMessageId: current.rootMessageId } : {}),
        ...(current.quoteTargetId ? { quoteTargetId: current.quoteTargetId } : {}),
        ...(current.currentReplyTargetTurnId ? { currentReplyTargetTurnId: current.currentReplyTargetTurnId } : {}),
      },
    });
    if (verdict.ok) {
      callerOpenId = verdict.callerOpenId;
    } else if (!verdict.stale) {
      return { ok: false, status: 403, error: 'workflow_event_turn_unauthorized', detail: verdict.reason };
    } else {
      // A newer inbound message overtook the wake turn (folded into it, or
      // queued behind it): the request runs as that message's sender.
      // Authenticate it as the session's current generation — the same
      // all-fields-one-generation rule as the human branch below, applied to
      // the turn the pointers name — instead of refusing it, and keep the
      // mark that the main bot, not that sender, decided it (mirrors the host
      // path in current-turn-provenance.ts).
      const overtaking = current.quoteTargetId;
      if (
        !nonEmpty(overtaking) || !isInboundMessageTurnId(overtaking) || !nonEmpty(current.callerOpenId) ||
        (current.currentReplyTargetTurnId !== undefined && current.currentReplyTargetTurnId !== overtaking)
      ) {
        return { ok: false, status: 403, error: 'turn_provenance_stale', detail: verdict.reason };
      }
      callerOpenId = current.callerOpenId;
      overtakenWakeTurn = true;
    }
  } else if (liveTurnId && parseScheduledTurnId(liveTurnId)) {
    if (!input.loadScheduledTask) {
      return {
        ok: false, status: 403, error: 'schedule_turn_unauthorized',
        detail: scheduledTurnAuthErrorMessage('task_not_found'),
      };
    }
    // Fail closed when the daemon did not inject the live gate.
    const gate = input.isScheduleOwnerAllowed ?? (() => false);
    const auth = authorizeScheduledTurn({
      turnId: liveTurnId,
      loadTask: input.loadScheduledTask,
      sessionLarkAppId: current.larkAppId,
      sessionChatId: current.chatId,
      isOwnerAllowed: gate,
      ...(input.isScheduledTurnLive
        ? { isScheduledTurnLive: input.isScheduledTurnLive }
        : {}),
    });
    if ('error' in auth) {
      return {
        ok: false, status: 403, error: 'schedule_turn_unauthorized',
        detail: scheduledTurnAuthErrorMessage(auth.error),
      };
    }
    callerOpenId = auth.ownerOpenId;
    scheduledTurn = true;
  } else {
    // Generation join, mirroring the host path (current-turn-provenance.ts):
    // lastCallerOpenId/quoteTargetId advance the moment the NEXT inbound message
    // arrives, while the capability rotates only when that message is dequeued
    // into the CLI (worker flushPending). The capability therefore proves turn
    // A, but the caller fields may already describe a queued turn B — mixing the
    // two would let A borrow B's identity. Only when the live capability's
    // turnId IS the session's current turn pointer do all tuple fields belong to
    // one generation (they are written atomically per inbound message);
    // anything else fails closed, exactly like the host marker join.
    if (!nonEmpty(current.callerOpenId)) {
      return { ok: false, status: 403, error: 'session_identity_incomplete' };
    }
    const quoteTargetId = current.quoteTargetId;
    const replyTurnId = current.currentReplyTargetTurnId;
    if (!nonEmpty(liveTurnId)
      || !nonEmpty(quoteTargetId)
      || quoteTargetId !== liveTurnId
      || (replyTurnId !== undefined && replyTurnId !== liveTurnId)) {
      return { ok: false, status: 403, error: 'turn_provenance_stale' };
    }
    callerOpenId = current.callerOpenId;
  }

  return {
    ok: true,
    body,
    sessionId,
    current: current as RelayAuthenticated['current'],
    callerOpenId,
    workflowEvent: !!workflowEvent && !overtakenWakeTurn,
    ...(overtakenWakeTurn && workflowEvent ? { overtakenWakeRunId: workflowEvent.runId } : {}),
    scheduledTurn,
    ...(liveTurnId ? { turnId: liveTurnId } : {}),
  };
}

/** The turn shape `v3ActionCallerFor` / the edit check grade, from a relay
 *  authentication. */
function relayTurnFacts(authenticated: RelayAuthenticated, runId: string) {
  return {
    callerOpenId: authenticated.callerOpenId,
    ...(authenticated.workflowEvent ? { workflowRunEvent: { runId } } : {}),
    ...(authenticated.overtakenWakeRunId ? { overtakenWorkflowRunEvent: { runId: authenticated.overtakenWakeRunId } } : {}),
    ...(authenticated.scheduledTurn ? { scheduledTurn: true } : {}),
  };
}

export function authorizeV3SessionRunMutationRequest(input: V3SessionRelayAuthInput): V3SessionRelayDecision {
  if (!isV3SessionRunMutation(input.mutation)) {
    return { ok: false, status: 404, error: 'unknown_mutation' };
  }
  const authenticated = authenticateRelaySession(input);
  if (!authenticated.ok) return authenticated;
  const { body, current, callerOpenId } = authenticated;

  let authority;
  try {
    authority = authorizeV3RunMutationForCurrentTuple({
      runId: input.runId,
      baseDir: input.baseDir,
      current: {
        callerOpenId,
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
  for (const key of MUTATION_BODY_KEYS[input.mutation as V3SessionRunMutation]) {
    if (body[key] !== undefined) subset[key] = body[key];
  }
  if (CALLER_RECORDING_MUTATIONS.has(input.mutation as V3SessionRunMutation)) {
    subset.caller = v3ActionCallerFor({
      runId: input.runId,
      baseDir: input.baseDir,
      current: { ...relayTurnFacts(authenticated, input.runId), ...(authenticated.turnId ? { turnId: authenticated.turnId } : {}) },
    });
  }
  const parsed = parseWorkflowDaemonMutationBody(input.mutation as V3SessionRunMutation, JSON.stringify(subset));
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };

  return {
    ok: true,
    body: parsed.body.value as Record<string, unknown>,
    runDir: authority.runDir,
    larkAppId: authority.larkAppId,
  };
}

// ─── Runtime flow edits over the relay (design §13.1) ──────────────────────

export type V3SessionRunEditDecision =
  | {
      ok: true;
      runDir: string;
      larkAppId: string;
      /** For `edit`: the strictly re-parsed body with the server-derived
       *  caller; absent for `status`. */
      edit?: import('./daemon-ipc-body.js').WorkflowEditMutationBody;
    }
  | Extract<V3SessionRelayDecision, { ok: false }>;

/**
 * `workflow status` / `workflow edit` from an isolated main session. Same
 * capability → live session → caller derivation as the other relayed
 * commands, then the edit-specific main-session check (app, chat, topic root)
 * instead of the owner tuple. The caller and its origin (human / this run's
 * event-woken turn) come from the daemon's session record, never the body.
 */
export function authorizeV3SessionRunEditRequest(
  input: Omit<V3SessionRelayAuthInput, 'mutation'> & { mutation: 'edit' | 'status' },
): V3SessionRunEditDecision {
  const authenticated = authenticateRelaySession(input);
  if (!authenticated.ok) return authenticated;
  const { body, current, callerOpenId, sessionId } = authenticated;
  let authority;
  try {
    authority = authorizeV3RunEditForCurrentTuple({
      runId: input.runId,
      baseDir: input.baseDir,
      current: {
        ...relayTurnFacts(authenticated, input.runId),
        callerOpenId,
        chatId: current.chatId,
        larkAppId: current.larkAppId,
        sessionId,
        ...(current.rootMessageId ? { rootMessageId: current.rootMessageId } : {}),
      },
    });
  } catch (err) {
    if (err instanceof V3DaemonCommandAuthorityError) {
      return { ok: false, status: 403, error: 'run_binding_mismatch', detail: err.message };
    }
    throw err;
  }
  if (authority.larkAppId !== input.selfLarkAppId) {
    return { ok: false, status: 409, error: 'wrong_daemon', detail: `run 归属 ${authority.larkAppId}` };
  }
  if (input.mutation === 'status') return { ok: true, runDir: authority.runDir, larkAppId: authority.larkAppId };
  const parsed = parseWorkflowDaemonMutationBody('edit', JSON.stringify({
    patch: body.patch,
    base: body.base,
    caller: { openId: authority.callerOpenId, origin: authority.origin, ...(authority.wakeTurn ? { wakeTurn: true } : {}) },
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
  }));
  if (!parsed.ok || parsed.body.mutation !== 'edit') {
    return { ok: false, status: 400, error: parsed.ok ? 'bad_edit' : parsed.error };
  }
  return { ok: true, runDir: authority.runDir, larkAppId: authority.larkAppId, edit: parsed.body.value };
}
