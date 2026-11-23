import { describe, expect, it, vi } from 'vitest';
import {
  decideOwnerFallback,
  ownerActorTurnFallsBack,
  ownerFallbackAuditLine,
  ownerFallbackOriginStillHolds,
  scheduledTaskPersonOf,
  type OwnerFallbackLookups,
  type OwnerFallbackTurn,
} from '../src/core/lark-user-owner-fallback.js';
import { parseTriggerUserAuthConfig } from '../src/services/trigger-user-auth.js';
import { isExternallySubmittedTriggerSource } from '../src/core/turn-origin.js';

const OWNER = 'ou_owner';
const SCHEDULE = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';
const PEER_BOT = { requestUserOpenId: 'ou_peer_bot', requestUserUnionId: 'on_peer_bot', requestLarkAppId: 'cli_bound', senderType: 'bot' as const };

function lookups(overrides: Partial<OwnerFallbackLookups> = {}): OwnerFallbackLookups {
  return {
    // Recorded by the public trigger entry; schedules and messages never are.
    externalTrigger: turnId => turnId.startsWith('trg_'),
    scheduledTaskPerson: () => 'none',
    signedRequester: async () => ({ kind: 'none' }),
    ...overrides,
  };
}

function decide(turn: Partial<OwnerFallbackTurn>, opts: {
  bot?: Parameters<typeof decideOwnerFallback>[0]['bot'];
  session?: Parameters<typeof decideOwnerFallback>[0]['session'];
  owner?: string | undefined;
  lookups?: OwnerFallbackLookups;
} = {}) {
  return decideOwnerFallback({
    bot: opts.bot ?? {},
    session: opts.session,
    ownerOpenId: 'owner' in opts ? opts.owner : OWNER,
    turn: { turnId: 'trg_abc12345', trustedCaller: undefined, principalOpenId: undefined, speakers: undefined, delegated: false, ...turn },
    lookups: opts.lookups ?? lookups(),
  });
}

describe('which turns fall back to the bot owner', () => {
  it('uses the owner for an external trigger, a creator-less schedule and a bot dispatch signed for the owner', async () => {
    expect(await decide({ turnId: 'trg_abc12345' })).toEqual({ use: 'owner', openId: OWNER, reason: 'external_trigger' });
    expect(await decide({ turnId: 'trg_abc12345', trustedCaller: null })).toEqual({ use: 'owner', openId: OWNER, reason: 'external_trigger' });
    expect(await decide({ turnId: SCHEDULE })).toEqual({ use: 'owner', openId: OWNER, reason: 'schedule_without_creator' });
    expect(await decide({ turnId: 'om_bot_msg', trustedCaller: PEER_BOT, principalOpenId: 'ou_peer_bot' },
      { lookups: lookups({ signedRequester: async () => ({ kind: 'person', openId: OWNER }) }) }))
      .toEqual({ use: 'owner', openId: OWNER, reason: 'owner_dispatch' });
  });

  it('keeps a person of the turn, a delegation and any principal that is not a bot', async () => {
    expect(await decide({ principalOpenId: 'ou_sender' })).toEqual({ use: 'principal' });
    expect(await decide({ principalOpenId: OWNER })).toEqual({ use: 'principal' });
    expect(await decide({ delegated: true })).toEqual({ use: 'principal' });
    // A user-typed caller is a person even if a bot id were reported elsewhere.
    expect(await decide({ trustedCaller: { ...PEER_BOT, senderType: 'user' }, principalOpenId: 'ou_peer_bot' })).toEqual({ use: 'principal' });
  });

  it('never falls back where the origin cannot be shown to carry no person', async () => {
    for (const turnId of ['om_turn', 'cct_click', 'join_x', 'workflow-event:run1:1', 'background:job', 'trg_owner_abc']) {
      expect(await decide({ turnId })).toEqual({ use: 'none', refusal: 'origin_unknown' });
    }
    // A caller tuple whose person is missing (a schedule creator, a recovery) is not "nobody".
    expect(await decide({ turnId: SCHEDULE, trustedCaller: { source: 'schedule_creator', requestUserUnionId: 'on_x' } }))
      .toEqual({ use: 'none', refusal: 'origin_unknown' });
    expect(await decide({ turnId: 'trg_abc12345', trustedCaller: { requestUserUnionId: 'on_x' } }))
      .toEqual({ use: 'none', refusal: 'origin_unknown' });
    // A relay the daemon minted with trigger machinery (a report, a meeting, an answer) is not "nobody".
    expect(await decide({ turnId: 'trg_relay' }, { lookups: lookups({ externalTrigger: () => false }) }))
      .toEqual({ use: 'none', refusal: 'origin_unknown' });
    expect(await decide({ turnId: SCHEDULE }, { lookups: lookups({ scheduledTaskPerson: () => 'person' }) }))
      .toEqual({ use: 'none', refusal: 'task_person_unavailable' });
    expect(await decide({ turnId: SCHEDULE }, { lookups: lookups({ scheduledTaskPerson: () => 'unknown' }) }))
      .toEqual({ use: 'none', refusal: 'origin_unknown' });
  });

  it('a bot turn is the owner\'s only when a signed dispatch names the owner; no record is never "nobody"', async () => {
    const botTurn = { turnId: 'om_bot_msg', trustedCaller: PEER_BOT, principalOpenId: 'ou_peer_bot' };
    // Unsigned, unbound or still pending: whoever drove that bot, unknown.
    expect(await decide(botTurn)).toEqual({ use: 'none', refusal: 'origin_unknown' });
    expect(await decide(botTurn, { lookups: lookups({ signedRequester: async () => ({ kind: 'unknown' }) }) }))
      .toEqual({ use: 'none', refusal: 'origin_unknown' });
    expect(await decide(botTurn, { lookups: lookups({ signedRequester: async () => ({ kind: 'person', openId: 'ou_someone' }) }) }))
      .toEqual({ use: 'none', refusal: 'requester_not_owner' });
    const signed = lookups({ signedRequester: async () => ({ kind: 'person', openId: OWNER }) });
    expect(await decide(botTurn, { lookups: signed })).toEqual({ use: 'owner', openId: OWNER, reason: 'owner_dispatch' });
    // The bot speaking is not a person speaking; a person merging in still ends it.
    expect(await decide({ ...botTurn, speakers: [{ openId: 'ou_someone', turnId: 'om_x' }] }, { lookups: signed }))
      .toEqual({ use: 'none', refusal: 'other_speaker' });
  });

  it('re-checks after an await that the origin still has nobody behind it', () => {
    const base = { externalTrigger: (turnId: string) => turnId.startsWith('trg_'), scheduledTaskPerson: () => 'none' as const };
    expect(ownerFallbackOriginStillHolds('schedule_without_creator', SCHEDULE, base)).toBe(true);
    expect(ownerFallbackOriginStillHolds('schedule_without_creator', SCHEDULE, { ...base, scheduledTaskPerson: () => 'person' })).toBe(false);
    expect(ownerFallbackOriginStillHolds('schedule_without_creator', SCHEDULE, { ...base, scheduledTaskPerson: () => 'unknown' })).toBe(false);
    expect(ownerFallbackOriginStillHolds('external_trigger', 'trg_abc12345', base)).toBe(true);
    expect(ownerFallbackOriginStillHolds('external_trigger', 'trg_abc12345', { ...base, externalTrigger: () => false })).toBe(false);
    expect(ownerFallbackOriginStillHolds('owner_dispatch', 'om_bot_msg', base)).toBe(true);
  });

  it('someone other than the owner speaking into the turn ends the fallback', async () => {
    expect(await decide({ speakers: [{ openId: 'ou_other', turnId: 'om_later' }] })).toEqual({ use: 'none', refusal: 'other_speaker' });
    expect(await decide({ speakers: [{ openId: OWNER, turnId: 'om_later' }, { openId: 'ou_other', turnId: 'om_x' }] }))
      .toEqual({ use: 'none', refusal: 'other_speaker' });
    expect(await decide({ speakers: [{ openId: OWNER, turnId: 'om_later' }] })).toMatchObject({ use: 'owner' });
  });

  it('the switch, a per-person lark-cli policy, a missing owner and protected sessions keep the refusal', async () => {
    expect(await decide({}, { bot: { larkUserOwnerFallback: false } })).toEqual({ use: 'none', refusal: 'switch_off' });
    for (const policy of [{ enabled: true, capabilities: ['lark-user'] }, { enabled: true, tools: ['lark-cli'] }, { enabled: true }]) {
      expect(await decide({}, { bot: { triggerUserAuth: parseTriggerUserAuthConfig(policy) } }))
        .toEqual({ use: 'none', refusal: 'per_person_policy' });
    }
    // Per-person auth that does not govern lark-cli leaves the fallback on.
    for (const policy of [{ enabled: true, tools: ['bytedcli'] }, { enabled: false, capabilities: ['lark-user'] }]) {
      expect(await decide({}, { bot: { triggerUserAuth: parseTriggerUserAuthConfig(policy) } })).toMatchObject({ use: 'owner' });
    }
    // The bot's own opt-out decides before anything about the turn, so a strict bot keeps its old refusal text.
    const withPerson = lookups({ scheduledTaskPerson: () => 'person' });
    expect(await decide({ turnId: SCHEDULE }, { bot: { larkUserOwnerFallback: false }, lookups: withPerson }))
      .toEqual({ use: 'none', refusal: 'switch_off' });
    expect(await decide({ turnId: SCHEDULE }, { bot: { triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, capabilities: ['lark-user'] }) }, lookups: withPerson }))
      .toEqual({ use: 'none', refusal: 'per_person_policy' });
    expect(await decide({}, { owner: undefined })).toEqual({ use: 'none', refusal: 'owner_unresolved' });
    expect(await decide({}, { session: { sandboxWithholdBotSecret: true } })).toEqual({ use: 'none', refusal: 'protected_session' });
    expect(await decide({}, { bot: { assistantMode: true }, session: { assistantOwnerOpenId: 'ou_other' } }))
      .toEqual({ use: 'none', refusal: 'protected_session' });
    expect(await decide({}, { bot: { assistantMode: true }, session: {} })).toEqual({ use: 'none', refusal: 'protected_session' });
    expect(await decide({}, { bot: { assistantMode: true }, session: { assistantOwnerOpenId: OWNER } })).toMatchObject({ use: 'owner' });
  });

  it('an owner-actor trigger acts as the owner under the fallback, and only as the owner', () => {
    const base = { bot: {}, session: undefined, ownerOpenId: OWNER, turnId: 'trg_owner_abc', principalOpenId: OWNER, speakers: undefined };
    expect(ownerActorTurnFallsBack(base)).toBe(true);
    expect(ownerActorTurnFallsBack({ ...base, turnId: 'trg_abc12345' })).toBe(false);
    expect(ownerActorTurnFallsBack({ ...base, principalOpenId: 'ou_other' })).toBe(false);
    expect(ownerActorTurnFallsBack({ ...base, bot: { larkUserOwnerFallback: false } })).toBe(false);
    expect(ownerActorTurnFallsBack({ ...base, bot: { triggerUserAuth: parseTriggerUserAuthConfig({ enabled: true, capabilities: ['lark-user'] }) } })).toBe(false);
    expect(ownerActorTurnFallsBack({ ...base, speakers: [{ openId: 'ou_other', turnId: 'om_x' }] })).toBe(false);
  });

  it('a scheduled task has a person when it records a creator, a claimant or a delegation', () => {
    expect(scheduledTaskPersonOf(undefined)).toBe('unknown');
    expect(scheduledTaskPersonOf({ kind: 'direct', task: {} })).toBe('none');
    expect(scheduledTaskPersonOf({ kind: 'delegated', task: {} })).toBe('person');
    expect(scheduledTaskPersonOf({ kind: 'direct', task: { ownerOpenId: 'ou_x' } })).toBe('person');
    expect(scheduledTaskPersonOf({ kind: 'direct', task: { ownerUnionId: 'on_x' } })).toBe('person');
    expect(scheduledTaskPersonOf({ kind: 'direct', task: { runAsClaim: { openId: 'ou_x' } } })).toBe('person');
    expect(scheduledTaskPersonOf({ kind: 'direct', task: { ownerAccess: 'talk' } })).toBe('person');
  });

  it('only requests submitted from outside count as external triggers at the public entry', () => {
    expect(isExternallySubmittedTriggerSource({ type: 'webhook', connectorId: 'ci' })).toBe(true);
    expect(isExternallySubmittedTriggerSource({ type: 'ui' })).toBe(true);
    expect(isExternallySubmittedTriggerSource({ type: 'schedule' })).toBe(true);
    expect(isExternallySubmittedTriggerSource({ type: 'ui', connectorId: 'botmux-report' })).toBe(false);
    expect(isExternallySubmittedTriggerSource({ type: 'vc_meeting' })).toBe(false);
    expect(isExternallySubmittedTriggerSource({ type: 'headless' })).toBe(false);
    expect(isExternallySubmittedTriggerSource({ type: 'workflow' })).toBe(false);
  });

  it('the audit line names the bot, the session, the turn and why nobody started it', () => {
    const line = ownerFallbackAuditLine({ appId: 'cli_bound', sessionId: 's1', turnId: 'trg_abc12345',
      decision: { use: 'owner', openId: OWNER, reason: 'external_trigger' }, result: 'granted' });
    for (const part of ['bot=cli_bound', 'session=s1', 'turn=trg_abc12345', `owner=${OWNER}`, 'reason=external_trigger', 'result=granted']) {
      expect(line).toContain(part);
    }
  });
});
