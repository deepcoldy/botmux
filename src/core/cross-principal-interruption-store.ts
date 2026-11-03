import { createHash } from 'node:crypto';
import type {
  CrossPrincipalInterruption,
  CrossPrincipalInterruptionCancellation,
  CrossPrincipalInterruptionMessage,
  Session,
  TrustedCaller,
} from '../types.js';

const MAX_XPI_CANCELLATION_AUDIT = 50;

/** Logical idempotency key for one rejected inbound message. Worker generation
 * and delivery attempt are deliberately excluded: both may change while the
 * same turnId is retried after a crash or IPC race. */
export function crossPrincipalInterruptionId(sourceSessionId: string, turnId: string): string {
  return `xpi_${createHash('sha256').update(`${sourceSessionId}\0${turnId}`).digest('hex').slice(0, 24)}`;
}

export function stageCrossPrincipalInterruptionRecord(args: {
  session: Session;
  ownerTurnId: string;
  owner: TrustedCaller;
  ownerUserPrompt?: string;
  proposer: TrustedCaller;
  message: CrossPrincipalInterruptionMessage;
}): { record: CrossPrincipalInterruption; inserted: boolean } {
  const id = crossPrincipalInterruptionId(args.session.sessionId, args.message.turnId);
  const queue = args.session.crossPrincipalInterruptions
    ?? (args.session.crossPrincipalInterruptions = []);
  const existing = queue.find(item => item.id === id);
  if (existing) return { record: existing, inserted: false };

  const record: CrossPrincipalInterruption = {
    version: 1,
    id,
    ownerTurnId: args.ownerTurnId,
    owner: { ...args.owner },
    ...(args.ownerUserPrompt?.trim() ? { ownerUserPrompt: args.ownerUserPrompt } : {}),
    proposer: { ...args.proposer },
    // Human and bot proposers follow the same explicit classification protocol.
    // No deadline starts here: the proposer cannot act until the card/protocol
    // is confirmed delivered.
    phase: 'awaiting_classification',
    messages: [{ ...args.message }],
  };
  queue.push(record);
  return { record, inserted: true };
}

export function markCrossPrincipalSuggestionWaiting(
  record: CrossPrincipalInterruption,
  now: number,
  waitMs: number,
): void {
  record.phase = 'awaiting_owner';
  record.ownerWaitDeadlineAt = now + waitMs;
  record.waitDecisionRound = record.waitDecisionRound ?? 0;
}

export function crossPrincipalOwnerWaitDisposition(
  record: CrossPrincipalInterruption,
  activeTurn: boolean,
  now: number,
  waitMs: number,
): 'owner_ready' | 'waiting' | 'proposer_decision' {
  if (!activeTurn) return 'owner_ready';
  record.ownerWaitDeadlineAt ??= now + waitMs;
  return now < record.ownerWaitDeadlineAt ? 'waiting' : 'proposer_decision';
}

export function continueCrossPrincipalOwnerWait(
  record: CrossPrincipalInterruption,
  now: number,
  waitMs: number,
): void {
  record.ownerWaitDeadlineAt = now + waitMs;
  record.waitDecisionRound = (record.waitDecisionRound ?? 0) + 1;
}

/**
 * Permanently terminalise every staged XPI item when the feature is disabled.
 * The active queue is removed in the same in-memory mutation, so neither a
 * daemon restart nor a later re-enable can resume historical business input.
 */
export function cancelCrossPrincipalInterruptionsForFeatureDisable(
  session: Session,
  cancelledAt = new Date().toISOString(),
): CrossPrincipalInterruptionCancellation[] {
  const queue = session.crossPrincipalInterruptions ?? [];
  if (queue.length === 0) return [];
  const cancelled = queue.map((record): CrossPrincipalInterruptionCancellation => ({
    version: 1,
    id: record.id,
    ownerTurnId: record.ownerTurnId,
    proposer: { ...record.proposer },
    messageTurnIds: record.messages.map(message => message.turnId),
    cancelledAt,
    reason: 'feature_disabled',
  }));
  session.crossPrincipalInterruptions = undefined;
  session.crossPrincipalInterruptionCancellations = [
    ...(session.crossPrincipalInterruptionCancellations ?? []),
    ...cancelled,
  ].slice(-MAX_XPI_CANCELLATION_AUDIT);
  return cancelled;
}
