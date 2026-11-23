/**
 * `lark-cli --as user` in a turn nobody started: the bot owner's own grant.
 *
 * A bound session (larkToolBinding, default on) pins lark-cli to the bot's
 * application, and `--as user` used to accept only the person who started the
 * current turn. Turns started by a script, a webhook, the platform or a
 * schedule nobody owns have no such person, so every `--as user` call in them
 * was refused ("No current requesting user"). Before
 * the binding, lark-cli ran with the machine's own login, which is normally the
 * owner's, so those turns used to work.
 *
 * With `larkUserOwnerFallback` on (the default) such a turn uses the owner's
 * grant to the bot application instead. The boundaries:
 *
 * - Only a turn whose origin is positively known to carry no person falls back.
 *   A turn with a person keeps that person's own grant, whoever they are; a
 *   turn whose origin cannot be established (an unknown sender type, a
 *   recovery, a cross-chat reply) keeps the refusal.
 * - Someone other than the owner speaking into the turn (a merged follow-up)
 *   ends the fallback for that turn: the agent may be acting on their request.
 * - A message from another bot falls back only when a signed dispatch record
 *   names the owner as its requester. Any bot can be driven by whoever talks to
 *   it, and an unsigned or unbound handoff says nothing about who that was, so
 *   the absence of a record is never read as "nobody".
 * - Relays the daemon mints with the trigger machinery for someone else's
 *   content (`botmux report`, meeting transcripts, ask continuations) are not
 *   external triggers (core/turn-origin isExternalTriggerTurn).
 * - A bot that applies per-person authorization to lark-cli (triggerUserAuth
 *   with the Feishu user capability) keeps its strict behaviour; so do sessions
 *   that withhold even the bot identity (sandboxWithholdBotSecret) and
 *   personal-assistant sessions that belong to someone other than the owner.
 */
import type { TrustedCaller } from '../types.js';
import type { TurnSpeaker } from './turn-speakers.js';
import { triggerUserAuthApplies, type TriggerUserAuthConfig } from '../services/trigger-user-auth.js';
import { isOwnerActorTurnId } from './workflow-event-turn.js';
import { parseScheduledTurnId } from './scheduled-turn-provenance.js';
import { isAutoCompletedSchedule } from '../services/schedule-until-done.js';

/** Why a turn has no person of its own. Written to the audit log. */
export type OwnerFallbackReason =
  /** A script, webhook, platform or Dashboard request admitted through the public trigger entry. */
  | 'external_trigger'
  /** `trg_owner_…`: a Dashboard administrator continuing the session as the owner. */
  | 'owner_actor'
  /** `schedule:…` whose task records neither a creator nor a claimant. */
  | 'schedule_without_creator'
  /** A signed dispatch whose requester is the owner. */
  | 'owner_dispatch';

/** Why a turn without a person of its own does not fall back to the owner. */
export type OwnerFallbackRefusal =
  | 'switch_off'
  | 'per_person_policy'
  | 'protected_session'
  | 'owner_unresolved'
  | 'other_speaker'
  | 'requester_not_owner'
  | 'task_person_unavailable'
  | 'origin_unknown';

export interface OwnerFallbackBotConfig {
  larkUserOwnerFallback?: boolean;
  triggerUserAuth?: TriggerUserAuthConfig;
  assistantMode?: boolean;
}

export interface OwnerFallbackSession {
  sandboxWithholdBotSecret?: boolean;
  assistantOwnerOpenId?: string;
}

/**
 * Whether the bot and the session allow the fallback at all. Independent of
 * the turn, so routes can re-check it after every await.
 */
export function ownerFallbackPolicy(
  bot: OwnerFallbackBotConfig,
  session: OwnerFallbackSession | undefined,
  ownerOpenId: string | undefined,
): { ok: true; ownerOpenId: string } | { ok: false; refusal: OwnerFallbackRefusal } {
  if (bot.larkUserOwnerFallback === false) return { ok: false, refusal: 'switch_off' };
  // Per-person authorization explicitly covering lark-cli: the operator asked
  // for `--as user` to mean the requester only.
  if (triggerUserAuthApplies(bot.triggerUserAuth, 'lark-cli')) return { ok: false, refusal: 'per_person_policy' };
  if (!ownerOpenId || !ownerOpenId.startsWith('ou_')) return { ok: false, refusal: 'owner_unresolved' };
  // A session that withholds even the bot identity treats its content as
  // untrusted; a personal-assistant session belongs to its own person.
  if (session?.sandboxWithholdBotSecret === true) return { ok: false, refusal: 'protected_session' };
  if ((bot.assistantMode === true || session?.assistantOwnerOpenId)
    && session?.assistantOwnerOpenId !== ownerOpenId) return { ok: false, refusal: 'protected_session' };
  return { ok: true, ownerOpenId };
}

/** Nobody but the owner spoke into the turn. */
export function onlyOwnerSpoke(speakers: readonly TurnSpeaker[] | undefined, ownerOpenId: string): boolean {
  return (speakers ?? []).every(speaker => speaker.openId === ownerOpenId);
}

export interface OwnerFallbackTurn {
  /** The identity turn (identityTurnId, else the envelope turn). */
  turnId: string;
  /** The caller tuple the worker reported for the turn (managedTurnOrigin). */
  trustedCaller: TrustedCaller | null | undefined;
  /** The principal the route resolved for the turn, when there is one. */
  principalOpenId: string | undefined;
  speakers: readonly TurnSpeaker[] | undefined;
  /** A non-speaker adoption or PID-marker recovery made the full input history unavailable. */
  provenanceIncomplete?: boolean;
  /** A signed delegation the per-person policy already remembered for the turn. */
  delegated: boolean;
}

export interface OwnerFallbackLookups {
  /** Whether the turn was submitted from outside through the public trigger entry (core/turn-origin). */
  externalTrigger(turnId: string): boolean;
  /** Whether the scheduled task records a person (creator or claimant): `unknown` when its authority record is missing. */
  scheduledTaskPerson(taskId: string): 'none' | 'person' | 'unknown';
  /** The requester a signed dispatch for the turn names, resolved to this application. */
  signedRequester(): Promise<{ kind: 'none' } | { kind: 'person'; openId: string } | { kind: 'unknown' }>;
}

export type OwnerFallbackDecision =
  | { use: 'owner'; openId: string; reason: OwnerFallbackReason }
  /** The turn has a person of its own; the caller keeps them. */
  | { use: 'principal' }
  | { use: 'none'; refusal: OwnerFallbackRefusal };

/** A turn principal that is a bot rather than a person. */
export function principalIsBot(turn: Pick<OwnerFallbackTurn, 'trustedCaller' | 'principalOpenId'>): boolean {
  return turn.trustedCaller?.senderType === 'bot'
    && !!turn.principalOpenId && turn.principalOpenId === turn.trustedCaller.requestUserOpenId;
}

/**
 * Whose grant `lark-cli --as user` uses in a turn without a person of its own.
 * Owner-actor turns (`trg_owner_…`) already name the owner as their principal;
 * {@link ownerActorTurnFallsBack} decides those.
 */
export async function decideOwnerFallback(input: {
  bot: OwnerFallbackBotConfig;
  session: OwnerFallbackSession | undefined;
  ownerOpenId: string | undefined;
  turn: OwnerFallbackTurn;
  lookups: OwnerFallbackLookups;
}): Promise<OwnerFallbackDecision> {
  const { turn, lookups } = input;
  if (turn.delegated) return { use: 'principal' };
  const botPrincipal = principalIsBot(turn);
  if (turn.principalOpenId && !botPrincipal) return { use: 'principal' };
  // Switched off, or per-person authorization governs lark-cli: the refusal stays as it was.
  if (input.bot.larkUserOwnerFallback === false) return { use: 'none', refusal: 'switch_off' };
  if (triggerUserAuthApplies(input.bot.triggerUserAuth, 'lark-cli')) return { use: 'none', refusal: 'per_person_policy' };
  // The original origin proof covers only the opening input. Once a later input
  // cannot be represented by speakers (or recovery lost that history), the turn
  // is no longer positively known to carry no other person.
  if (turn.provenanceIncomplete) return { use: 'none', refusal: 'origin_unknown' };
  // Only origins positively known to carry no person fall back.
  const origin = botPrincipal ? undefined : originWithoutPerson(turn, lookups);
  if (origin && 'refusal' in origin) return { use: 'none', refusal: origin.refusal };
  const policy = ownerFallbackPolicy(input.bot, input.session, input.ownerOpenId);
  if (!policy.ok) return { use: 'none', refusal: policy.refusal };
  const owner = policy.ownerOpenId;
  if (!onlyOwnerSpoke(turn.speakers, owner)) return { use: 'none', refusal: 'other_speaker' };
  if (origin) return { use: 'owner', openId: owner, reason: origin.reason };
  // A bot's message: only a signed dispatch naming the owner counts. No record,
  // an unbound or unreadable one, or another requester: whoever drove that bot.
  const requester = await lookups.signedRequester();
  if (requester.kind === 'person') {
    return requester.openId === owner
      ? { use: 'owner', openId: owner, reason: 'owner_dispatch' }
      : { use: 'none', refusal: 'requester_not_owner' };
  }
  return { use: 'none', refusal: 'origin_unknown' };
}

/** Why a turn without any principal has no person, or why that cannot be established. */
function originWithoutPerson(
  turn: Pick<OwnerFallbackTurn, 'turnId' | 'trustedCaller'>,
  lookups: Pick<OwnerFallbackLookups, 'externalTrigger' | 'scheduledTaskPerson'>,
): { reason: 'external_trigger' | 'schedule_without_creator' } | { refusal: OwnerFallbackRefusal } {
  // Any caller tuple without a principal (a schedule creator or a recovery whose
  // person is missing, an unknown sender) is not "nobody".
  if (turn.trustedCaller) return { refusal: 'origin_unknown' };
  // A script, a webhook, the platform or the Dashboard — not a relay the
  // daemon minted for someone else's content (a report, a meeting, an answer).
  if (lookups.externalTrigger(turn.turnId) && !isOwnerActorTurnId(turn.turnId)) return { reason: 'external_trigger' };
  const taskId = parseScheduledTurnId(turn.turnId);
  if (taskId) {
    const person = lookups.scheduledTaskPerson(taskId);
    return person === 'none' ? { reason: 'schedule_without_creator' }
      : { refusal: person === 'person' ? 'task_person_unavailable' : 'origin_unknown' };
  }
  return { refusal: 'origin_unknown' };
}

/**
 * Re-check, after an await, that the origin a fallback was decided for still
 * carries no person (a task may have been claimed or given a creator meanwhile).
 * A signed dispatch record and an owner-actor principal do not change; the
 * route re-checks the principal itself.
 */
export function ownerFallbackOriginStillHolds(
  reason: OwnerFallbackReason,
  turnId: string,
  lookups: Pick<OwnerFallbackLookups, 'externalTrigger' | 'scheduledTaskPerson'>,
): boolean {
  if (reason !== 'external_trigger' && reason !== 'schedule_without_creator') return true;
  const origin = originWithoutPerson({ turnId, trustedCaller: undefined }, lookups);
  return 'reason' in origin && origin.reason === reason;
}

/**
 * An owner-actor turn (`trg_owner_…`, a Dashboard administrator continuing as
 * the owner) names the owner as its principal. Per-person policies gate its
 * personal credentials behind `triggerUserAuth.allowOwnerActor`; under the
 * owner fallback it is one more turn nobody started, so it uses the owner's
 * grant like any other trigger.
 */
export function ownerActorTurnFallsBack(input: {
  bot: OwnerFallbackBotConfig;
  session: OwnerFallbackSession | undefined;
  ownerOpenId: string | undefined;
  turnId: string;
  principalOpenId: string | undefined;
  speakers: readonly TurnSpeaker[] | undefined;
  provenanceIncomplete?: boolean;
}): boolean {
  if (!isOwnerActorTurnId(input.turnId) || input.provenanceIncomplete) return false;
  const policy = ownerFallbackPolicy(input.bot, input.session, input.ownerOpenId);
  return policy.ok && input.principalOpenId === policy.ownerOpenId && onlyOwnerSpoke(input.speakers, policy.ownerOpenId);
}

/** What a scheduled task records about the person it runs for. */
export function scheduledTaskPersonOf(record: {
  kind: string;
  state?: string;
  task: {
    ownerOpenId?: string; ownerUnionId?: string; runAsClaim?: unknown; ownerAccess?: string;
  } & Parameters<typeof isAutoCompletedSchedule>[0];
} | undefined): 'none' | 'person' | 'unknown' {
  if (!record || !['active', 'paused', 'completed'].includes(record.state ?? '')) return 'unknown';
  // A revoked row is only a tombstone, never live authority. A completed row is
  // valid only for the existing auto-completed one-shot/until-done completion exception.
  if (record.state === 'completed' && !isAutoCompletedSchedule(record.task)) return 'unknown';
  // Only a delegated task inherently runs for its dispatch's control person.
  // Direct and migrated legacy rows both use their recorded creator/claim fields.
  if (record.kind === 'delegated') return 'person';
  if (record.kind !== 'direct' && record.kind !== 'legacy') return 'unknown';
  const { task } = record;
  return task.ownerOpenId || task.ownerUnionId || task.runAsClaim || task.ownerAccess ? 'person' : 'none';
}

/** One audit line per `--as user` call that considered the owner's grant. */
export function ownerFallbackAuditLine(input: {
  appId: string;
  sessionId: string;
  turnId: string;
  decision: Exclude<OwnerFallbackDecision, { use: 'principal' }>;
  result?: string;
}): string {
  const { decision } = input;
  return `[lark-tool:owner-fallback:audit] bot=${input.appId} session=${input.sessionId} turn=${input.turnId} `
    + (decision.use === 'owner'
      ? `owner=${decision.openId} reason=${decision.reason} result=${input.result ?? 'owner'}`
      : `result=declined refusal=${decision.refusal}`);
}

/** The agent-facing explanation of why there is no person and no owner fallback. */
export function ownerFallbackRefusalText(refusal: OwnerFallbackRefusal): string | undefined {
  switch (refusal) {
    case 'other_speaker':
      return 'No current requesting user: nobody started this turn, and someone other than the bot owner has spoken in it since, so --as user does not use the owner\'s authorization. Use --as bot for data the bot can read; acting as a person needs that person\'s own turn.';
    case 'requester_not_owner':
      return 'No current requesting user: this turn runs for someone other than the bot owner, and this bot does not use per-person authorization for lark-cli, so --as user is unavailable here. Use --as bot for data the bot can read; do not use or ask for the owner\'s authorization.';
    case 'task_person_unavailable':
      return 'No current requesting user: this scheduled task runs for the person who created or claimed it, and that person\'s identity is not available in this run, so --as user does not use the bot owner\'s authorization instead. Use --as bot for data the bot can read, or report that the task\'s person must check their access to this bot.';
    case 'owner_unresolved':
      return 'No current requesting user, and this bot has no resolvable owner whose authorization --as user could use. Use --as bot for data the bot can read, or report that the bot owner is not configured.';
    case 'protected_session':
      return 'No current requesting user; this session does not use the bot owner\'s authorization (a sandbox that withholds bot credentials, or a personal-assistant session of another person). Use --as bot where it is allowed, or report the blocked resource.';
    default:
      return undefined;
  }
}

/** The agent-facing refusal when the owner's grant is used but the owner has not authorized yet. */
export function ownerNotAuthorizedText(appId: string, reason: OwnerFallbackReason): string {
  return `Nobody started this turn (${reason}), so lark-cli --as user acts as the bot owner, and the owner has not authorized application ${appId} yet. `
    + 'Run botmux auth request --scope "<required scopes>" --json: botmux sends the authorization link to the owner privately; the result carries no link. '
    + 'Retry with --as user after the owner authorizes (botmux auth wait), or use --as bot for data the bot can read. '
    + 'Do not ask anyone to post a message in the chat, and never post an authorization link.';
}
