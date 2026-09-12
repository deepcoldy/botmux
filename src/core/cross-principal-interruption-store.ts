import { createHash } from 'node:crypto';
import type {
  CrossPrincipalInterruption,
  CrossPrincipalInterruptionMessage,
  Session,
  TrustedCaller,
} from '../types.js';

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
