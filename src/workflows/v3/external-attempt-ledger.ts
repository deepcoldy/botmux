/**
 * Pure replay fold for external (bot-executed) goal attempts.
 *
 * An external attempt is opened by `nodeDispatched{nodeExecutor:"bot"}` and
 * advances through Prepared → Sent → Accepted. It owns no local process, so
 * its close proof is the journal itself: the first verdict, drain, run-cancel
 * or reassignment event for the attempt closes the handoff binding, and every
 * later submission for it is rejected.
 */
import type { StoredEvent } from './event-contract.js';
import type {
  V3ExternalPlacement,
  V3HandoffIdempotency,
  V3LoopRef,
} from './event-contract.js';

export type V3ExternalAttemptPhase = 'dispatched' | 'prepared' | 'sent' | 'accepted';

export type V3ExternalAttemptClosure =
  | { kind: 'succeeded' }
  | { kind: 'blocked'; errorCode?: string }
  | { kind: 'failed'; errorCode?: string }
  | { kind: 'cancelled' }
  | { kind: 'drained'; reason: Extract<StoredEvent, { type: 'nodeAttemptDrained' }>['reason'] }
  | { kind: 'reassigned'; to: string };

export interface V3ExternalAttempt {
  nodeId: string;
  instanceId?: string;
  attemptId: string;
  loop?: V3LoopRef;
  phase: V3ExternalAttemptPhase;
  targetLarkAppId?: string;
  placement?: V3ExternalPlacement;
  revision?: number;
  idempotency?: V3HandoffIdempotency;
  preparedAt?: number;
  handoffMessageId?: string;
  nodeCardMessageId?: string;
  threadId?: string;
  sentAt?: number;
  acceptDeadlineAt?: number;
  sessionId?: string;
  acceptedAt?: number;
  deadlineAt?: number;
  stalledAt?: number;
  /** A `nodeHandedToHuman` was recorded while the attempt was still open:
   *  its closing `nodeBlocked(HANDED_TO_HUMAN)` is owed (crash between the
   *  two writes) and the runtime writes it with this reason. */
  handedToHuman?: { reason: string };
  closed?: V3ExternalAttemptClosure;
}

function closureOf(event: StoredEvent): V3ExternalAttemptClosure | undefined {
  switch (event.type) {
    case 'nodeSucceeded':
      return { kind: 'succeeded' };
    case 'nodeBlocked':
      return { kind: 'blocked', ...(event.errorCode ? { errorCode: event.errorCode } : {}) };
    case 'nodeFailed':
      return { kind: 'failed', ...(event.errorCode ? { errorCode: event.errorCode } : {}) };
    case 'nodeCancelled':
      // An early-release cancel is a scheduling decision; the runtime still
      // stops the bot and records a drain before the binding counts closed.
      return event.reason === 'runCancelled' && event.attemptId ? { kind: 'cancelled' } : undefined;
    case 'nodeAttemptDrained':
      return { kind: 'drained', reason: event.reason };
    case 'nodeReassigned':
      return event.attemptId ? { kind: 'reassigned', to: event.to } : undefined;
    default:
      return undefined;
  }
}

function attemptIdOf(event: StoredEvent): string | undefined {
  return 'attemptId' in event && typeof event.attemptId === 'string' ? event.attemptId : undefined;
}

function identityOf(event: StoredEvent): { nodeId?: string; instanceId?: string } {
  const record = event as { nodeId?: unknown; instanceId?: unknown };
  return {
    ...(typeof record.nodeId === 'string' ? { nodeId: record.nodeId } : {}),
    ...(typeof record.instanceId === 'string' ? { instanceId: record.instanceId } : {}),
  };
}

/** Every external attempt in journal order, with its folded phase/closure. */
export function foldV3ExternalAttempts(
  events: readonly StoredEvent[],
): Map<string, V3ExternalAttempt> {
  const attempts = new Map<string, V3ExternalAttempt>();
  for (const event of events) {
    if (event.type === 'nodeDispatched') {
      if (event.nodeExecutor !== 'bot') continue;
      const prior = attempts.get(event.attemptId);
      if (prior) {
        if (prior.nodeId !== event.nodeId || prior.instanceId !== event.instanceId) {
          throw new Error(`v3 external ledger: identity changed for ${event.attemptId}`);
        }
        continue; // exact duplicate is audit-only; never reopen
      }
      attempts.set(event.attemptId, {
        nodeId: event.nodeId,
        ...(event.instanceId ? { instanceId: event.instanceId } : {}),
        attemptId: event.attemptId,
        ...(event.loop ? { loop: event.loop } : {}),
        phase: 'dispatched',
      });
      continue;
    }
    const attemptId = attemptIdOf(event);
    if (!attemptId) continue;
    const attempt = attempts.get(attemptId);
    if (!attempt) continue;
    // First close wins; later events are audit-only (a completed loop also
    // re-uses its output body attempt id on the loop's own nodeSucceeded).
    if (attempt.closed) continue;
    const identity = identityOf(event);
    if (identity.nodeId !== attempt.nodeId || identity.instanceId !== attempt.instanceId) {
      throw new Error(`v3 external ledger: event identity changed for ${attemptId}`);
    }
    switch (event.type) {
      case 'nodeHandoffPrepared':
        if (attempt.phase !== 'dispatched') break; // keys are frozen by the first intent
        attempt.phase = 'prepared';
        attempt.targetLarkAppId = event.targetLarkAppId;
        attempt.placement = event.placement;
        attempt.revision = event.revision;
        attempt.idempotency = event.idempotency;
        attempt.preparedAt = event.preparedAt;
        break;
      case 'nodeHandoffSent':
        // The target may accept before dispatch() returns, so Sent can follow
        // Accepted: it then only fills the message ids, never regresses phase.
        if (attempt.phase === 'dispatched' || attempt.handoffMessageId !== undefined) break;
        if (attempt.phase === 'prepared') attempt.phase = 'sent';
        attempt.handoffMessageId = event.handoffMessageId;
        if (event.nodeCardMessageId) attempt.nodeCardMessageId = event.nodeCardMessageId;
        if (event.threadId) attempt.threadId = event.threadId;
        attempt.sentAt = event.sentAt;
        attempt.acceptDeadlineAt = event.acceptDeadlineAt;
        break;
      case 'nodeHandoffAccepted':
        // Acceptance is never lost: it may precede the Sent record.
        if (attempt.phase !== 'prepared' && attempt.phase !== 'sent') break;
        attempt.phase = 'accepted';
        attempt.sessionId = event.sessionId;
        attempt.acceptedAt = event.acceptedAt;
        attempt.deadlineAt = event.deadlineAt;
        break;
      case 'nodeStalled':
        attempt.stalledAt = event.at;
        break;
      case 'nodeHandedToHuman':
        attempt.handedToHuman = { reason: event.reason };
        break;
      default: {
        const closure = closureOf(event);
        if (closure) attempt.closed = closure;
      }
    }
  }
  return attempts;
}

/** External attempts whose handoff binding is still open. */
export function openV3ExternalAttempts(events: readonly StoredEvent[]): V3ExternalAttempt[] {
  return [...foldV3ExternalAttempts(events).values()].filter((attempt) => !attempt.closed);
}
