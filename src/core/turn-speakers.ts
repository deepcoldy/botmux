import type { TrustedCaller } from '../types.js';

/** One human whose message is part of the running turn, with the message turn that carries their identity material. */
export interface TurnSpeaker { openId: string; turnId: string }

/**
 * The human speaker an inbound message adds to a turn; none for bots, schedules and recoveries.
 * Paired with the turn that carries this person's published identity (`identityTurnId`, else
 * the envelope turn): a restored marker names the preserved principal under a later envelope.
 */
export function speakerOf(identity: { caller?: TrustedCaller; turnId?: string; identityTurnId?: string }): TurnSpeaker | undefined {
  const turnId = identity.identityTurnId ?? identity.turnId;
  const caller = identity.caller;
  return caller?.senderType === 'user' && !caller.source && caller.requestUserOpenId && turnId
    ? { openId: caller.requestUserOpenId, turnId } : undefined;
}

/** Adds a speaker once; a person who speaks again keeps one entry, paired with their latest message turn. */
export function withSpeaker(speakers: readonly TurnSpeaker[] | undefined, speaker: TurnSpeaker | undefined): TurnSpeaker[] {
  return speaker ? [...(speakers ?? []).filter(s => s.openId !== speaker.openId), speaker] : [...(speakers ?? [])];
}

/**
 * Whose credentials a governed call uses. Without `as` it is the turn principal, the person who
 * started the turn: a later speaker merging in never changes the default. The speaker set only
 * validates an explicit `as`, which names a speaker of this turn and nobody else.
 */
export function chooseTurnSpeaker(
  principal: TurnSpeaker | undefined, speakers: readonly TurnSpeaker[] | undefined, as: unknown,
): { ok: true; speaker?: TurnSpeaker } | { ok: false } {
  if (as === undefined) return { ok: true, ...(principal ? { speaker: principal } : {}) };
  const speaker = typeof as === 'string' ? speakers?.find(s => s.openId === as) : undefined;
  return speaker ? { ok: true, speaker } : { ok: false };
}
