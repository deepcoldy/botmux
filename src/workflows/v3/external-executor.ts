/**
 * External goal-node executor seam (design §9.1, "落盘等待的外部执行").
 *
 * When a run's envelope pins `nodeExecutor: "bot"`, goal nodes are no longer
 * run by an in-memory `RunNode` Promise. The runtime instead writes a durable
 * handoff intent, asks this executor to deliver it, and suspends; the node
 * finishes when a later journal event (submission, timeout, human action)
 * arrives and the run is driven again.
 *
 * This module is transport-neutral: it carries no Lark/IM types. The Feishu
 * implementation (handoff cards, chat grants, session registry) plugs in
 * behind this interface in a later change; tests use a fake.
 */

import type { GoalInputs } from './contract.js';
import type { V3GoalNode } from './dag.js';
import type {
  V3ExternalPlacement,
  V3HandoffIdempotency,
  V3LoopRef,
} from './event-contract.js';
import type { RunChatBinding } from './grill-state.js';

export type { V3ExternalPlacement, V3HandoffIdempotency } from './event-contract.js';

/** Error codes an external attempt can settle with (journal `errorCode`). */
export const V3_EXTERNAL_ERROR_CODES = {
  BOT_NOT_IN_CHAT: 'BOT_NOT_IN_CHAT',
  BOT_OFFLINE: 'BOT_OFFLINE',
  COLLABORATION_DENIED: 'COLLABORATION_DENIED',
  IDENTITY_UNAVAILABLE: 'IDENTITY_UNAVAILABLE',
  HANDOFF_NOT_ACCEPTED: 'HANDOFF_NOT_ACCEPTED',
  HANDOFF_UNCERTAIN: 'HANDOFF_UNCERTAIN',
  BOT_REPORTED_BLOCKED: 'BOT_REPORTED_BLOCKED',
  /** The executing bot's daemon would not start the node session in the
   *  run's Gate-2 working dir: not inside its configured range (design §15.4). */
  WORKING_DIR_REFUSED: 'WORKING_DIR_REFUSED',
  NODE_TIMEOUT: 'NODE_TIMEOUT',
  /** The main bot (or the initiator) handed the node to a human (§13.6). */
  HANDED_TO_HUMAN: 'HANDED_TO_HUMAN',
} as const;

export type V3ExternalErrorCode =
  typeof V3_EXTERNAL_ERROR_CODES[keyof typeof V3_EXTERNAL_ERROR_CODES];

/** Pre-send refusals: the executor proved nothing was delivered. */
export type V3HandoffRejectionCode =
  | 'BOT_NOT_IN_CHAT'
  | 'BOT_OFFLINE'
  | 'COLLABORATION_DENIED'
  | 'IDENTITY_UNAVAILABLE'
  /** The run's Gate-2 working dir cannot be honoured by the target (design
   *  §15.4): the main bot's own range, or a target daemon too old to apply it. */
  | 'WORKING_DIR_REFUSED';

/**
 * How long a prepared-but-unconfirmed handoff may be re-sent with the same
 * idempotency keys. Lark de-duplicates message `uuid`s for one hour. Measuring
 * from `preparedAt` (which precedes every send) already keeps re-sends inside
 * the original's window; the engine additionally stops re-sending 10 minutes
 * early (50 min) to absorb clock skew between this host and Lark and the time
 * an in-flight send can take (bounded by {@link V3_EXTERNAL_CALL_TIMEOUT_MS}).
 */
export const V3_HANDOFF_IDEMPOTENCY_WINDOW_MS = 50 * 60 * 1000;

/** Engine-side bound on every transport call (dispatch / probe / stop). A
 *  call that does not settle in time is treated as an unknown outcome, so a
 *  hung transport can never freeze the run or its cancellation. */
export const V3_EXTERNAL_CALL_TIMEOUT_MS = 30_000;

/** Default acceptance window (mirrors `botmux dispatch`). */
export const V3_DEFAULT_HANDOFF_ACCEPT_TIMEOUT_MS = 15_000;

/** Identity of one external attempt as seen by the transport. */
export interface V3ExternalAttemptRef {
  runId: string;
  nodeId: string;
  instanceId?: string;
  attemptId: string;
  /** Flow revision the attempt was dispatched under (design §13.3; 1 = the
   *  approved DAG). */
  revision: number;
  targetLarkAppId: string;
  placement: V3ExternalPlacement;
}

export interface V3ExternalDispatchRequest extends V3ExternalAttemptRef {
  /** Frozen in `nodeHandoffPrepared`; identical on every re-dispatch. */
  idempotency: V3HandoffIdempotency;
  /** True when this is a same-key re-send of an earlier unconfirmed dispatch. */
  redispatch: boolean;
  /** The effective node definition (loop bodies already expanded). */
  node: V3GoalNode;
  /** 1-based attempt number within the instance ("第 N 次"). */
  attemptNumber: number;
  loop?: V3LoopRef;
  /** Upstream products resolved for this attempt (absolute paths). */
  inputs: GoalInputs;
  inputsPath: string;
  attemptDir: string;
  runDir: string;
  timeoutSec: number;
  chatBinding?: RunChatBinding;
  /** Present when this attempt is a retry of a blocked attempt. */
  retryOf?: { attemptId: string; errorCode?: string; message?: string };
  /** Present when the node was reassigned before this attempt. */
  reassignedFrom?: string;
  /** Present when this attempt replaces work a runtime flow revision
   *  invalidated (the handoff should say the requirements changed). */
  revisedBy?: { revision: number; summary: string };
  /** Aborted when the run is cancelled while the send is in flight. */
  signal: AbortSignal;
}

export type V3ExternalDispatchOutcome =
  | {
      kind: 'sent';
      handoffMessageId: string;
      nodeCardMessageId?: string;
      threadId?: string;
    }
  | {
      /** Nothing was sent; the node blocks with `code`. */
      kind: 'rejected';
      code: V3HandoffRejectionCode;
      message?: string;
    };

export type V3ExternalAcceptanceProbe =
  | { status: 'accepted'; sessionId: string; acceptedAt?: number }
  /** `detail`: why the target did not take it, when the transport knows
   *  (kept in the HANDOFF_NOT_ACCEPTED message). */
  | { status: 'notAccepted'; detail?: string };

export type V3ExternalStopReason =
  | 'runCancelled'
  | 'timeout'
  | 'notAccepted'
  | 'uncertain'
  | 'reassigned'
  | 'obsolete'
  | 'runBoundary'
  | 'handedToHuman';

export interface V3ExternalStopRequest extends V3ExternalAttemptRef {
  reason: V3ExternalStopReason;
  /** The keys the handoff was (or may have been) sent with: lets the
   *  transport find a delivery whose Sent record never reached the journal. */
  idempotency?: V3HandoffIdempotency;
  handoffMessageId?: string;
  nodeCardMessageId?: string;
  threadId?: string;
  sessionId?: string;
}

/**
 * Injectable transport for `nodeExecutor: "bot"` goal nodes.
 *
 * Contract:
 * - `dispatch` must be idempotent per `idempotency` keys: re-sending the same
 *   keys must not deliver a second handoff. Resolve `sent` only after the
 *   handoff message exists; resolve `rejected` only when nothing was sent.
 *   Throwing means "unknown" — the engine re-sends with the same keys inside
 *   {@link V3_HANDOFF_IDEMPOTENCY_WINDOW_MS}, then blocks HANDOFF_UNCERTAIN.
 * - `probeAcceptance` reports whether the target session registered the
 *   handoff (cold attach and acceptance deadline). Throwing = unknown: the
 *   engine backs off and probes again, and only a persistently unknown
 *   answer becomes HANDOFF_UNCERTAIN (never HANDOFF_NOT_ACCEPTED).
 * - Every call is bounded by {@link V3_EXTERNAL_CALL_TIMEOUT_MS} engine-side.
 * - `stop` stops the target bot's current turn for this attempt and
 *   invalidates its handoff binding. Must be idempotent and must tolerate
 *   attempts whose handoff never reached the target. Failures are reported
 *   through the runtime's error hook; the journal close remains authoritative
 *   (late submissions are rejected by the engine either way).
 */
export interface V3ExternalNodeExecutor {
  dispatch(request: V3ExternalDispatchRequest): Promise<V3ExternalDispatchOutcome>;
  probeAcceptance(
    ref: V3ExternalAttemptRef & { handoffMessageId: string },
  ): Promise<V3ExternalAcceptanceProbe>;
  stop(request: V3ExternalStopRequest): Promise<void>;
}
