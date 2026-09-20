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

/**
 * How many consecutive interruptions from *one* bot proposer still get the
 * normal acknowledgement prompt before it is suppressed. Two `mentionMode:
 * always` bots can otherwise ping-pong the "请选择独立任务/建议" card forever:
 * each bot's card @-mentions the other, whose auto-reply is itself a fresh
 * cross-principal message, and so on. A human proposer never counts toward
 * this (and clears every bot's tally), so ordinary human interruptions are
 * never suppressed.
 *
 * Set to 1: only the first interruption from a given bot in a consecutive run
 * gets a prompt; every later one *from that same bot* is silenced until a human
 * breaks the run. (Suppression fires when the counter is strictly greater than
 * this value — so `1` → prompt on the 1st interruption, suppress from the 2nd
 * on.) The extra cards a larger value would emit are pure noise: a cooperating
 * bot classifies via `--as` (which never advances this counter), and a bot that
 * does not classify is the runaway loop this breaker exists to stop.
 */
export const CROSS_PRINCIPAL_BOT_LOOP_THRESHOLD = 1;

/** Stable per-proposer key for the bot-loop counter. Kept consistent with
 * {@link sameTrustedPrincipal}: identity is scoped by lark app, and a bot is
 * distinguished by its own union/open id. A bot proposer with no id at all
 * collapses to a single shared `unknown` bucket, which preserves the
 * conservative (suppress-rather-than-miss) behaviour for unattributable
 * senders without ever penalising an identifiable bot for another's tally. */
export function crossPrincipalProposerKey(proposer: TrustedCaller): string {
  const app = proposer.requestLarkAppId ?? '';
  const id = proposer.requestUserUnionId || proposer.requestUserOpenId || 'unknown';
  return `${app}\0${id}`;
}

/**
 * Update the per-proposer consecutive-bot-interruption counter for a newly
 * staged interruption and decide whether the acknowledgement prompt must be
 * suppressed to break a bot↔bot auto-reply loop.
 *
 * - A human proposer clears all per-bot tallies and never suppresses. A person
 *   choosing to keep messaging is not the runaway loop this targets, and a
 *   human turn is the natural "the room is sane again" signal.
 * - A bot proposer increments *its own* counter (keyed by identity); once that
 *   counter exceeds the threshold the prompt is suppressed. Counting per
 *   proposer means an unrelated bot's first legitimate interruption is never
 *   dropped just because a different bot was looping — only the bot that keeps
 *   interrupting without classifying is throttled.
 * - The interruption itself is still staged durably — we only stop the outbound
 *   @-mention that keeps the looping bot replying.
 *
 * Pure and idempotent per call: callers invoke it exactly once per genuinely
 * new staged interruption (i.e. when `inserted` is true), so a retried/merged
 * duplicate does not advance the counter.
 */
export function noteCrossPrincipalProposer(
  session: Session,
  proposer: TrustedCaller | null,
): { consecutiveBotInterruptions: number; suppressAckPrompt: boolean } {
  if (!proposer || proposer.senderType !== 'bot') {
    // Any non-bot (human or unknown) proposer clears every bot's tally: the run
    // of consecutive bot interruptions this breaker watches for is broken.
    session.crossPrincipalBotInterruptionCounts = undefined;
    return { consecutiveBotInterruptions: 0, suppressAckPrompt: false };
  }
  const counts = session.crossPrincipalBotInterruptionCounts
    ?? (session.crossPrincipalBotInterruptionCounts = {});
  const key = crossPrincipalProposerKey(proposer);
  const next = (counts[key] ?? 0) + 1;
  counts[key] = next;
  return {
    consecutiveBotInterruptions: next,
    suppressAckPrompt: next > CROSS_PRINCIPAL_BOT_LOOP_THRESHOLD,
  };
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
