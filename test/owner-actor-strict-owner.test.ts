import { beforeEach, describe, expect, it } from 'vitest';
import {
  __testOnly_resetBotRegistry, getOwnerOpenId, getStrictOwnerOpenId, ownerUnionIdVerdict,
  parseBotConfigsFromText, registerBot,
} from '../src/bot-registry.js';

const APP = 'fixture-app';
const OWNER = 'ou_fixture_owner';
const OTHER = 'ou_fixture_other';
const OWNER_UNION = 'on_fixture_owner';
const OTHER_UNION = 'on_fixture_other';

/** Registers a bot whose allowlist resolved as `resolution` (raw entry → open_id). */
function bot(entry: Record<string, unknown>, resolution: Record<string, string>) {
  const state = registerBot(parseBotConfigsFromText(JSON.stringify([{
    larkAppId: APP, larkAppSecret: 'fixture', cliId: 'codex', ...entry,
  }]))[0]!);
  state.rawAllowedUserResolution = new Map(Object.entries(resolution));
  state.resolvedAllowedUsers = [...new Set(Object.values(resolution))];
  return state;
}

describe('owner a host administrator may act as', () => {
  beforeEach(() => __testOnly_resetBotRegistry());

  it.each([
    ['a union_id', OWNER_UNION],
    ['an email', 'owner@example.com'],
    ['an open_id', OWNER],
  ])('defaults to the only person of an allowlist that lists them by %s', (_kind, entry) => {
    bot({ allowedUsers: [entry] }, { [entry]: OWNER });
    expect(getStrictOwnerOpenId(APP)).toBe(OWNER);
  });

  it('defaults to a literal open_id the resolver has not mapped yet', () => {
    registerBot(parseBotConfigsFromText(JSON.stringify([{
      larkAppId: APP, larkAppSecret: 'fixture', cliId: 'codex', allowedUsers: [OWNER],
    }]))[0]!);
    expect(getStrictOwnerOpenId(APP)).toBe(OWNER);
  });

  it('treats several entries for the same person as one person', () => {
    bot({ allowedUsers: [OWNER_UNION, 'owner@example.com'] }, { [OWNER_UNION]: OWNER, 'owner@example.com': OWNER });
    expect(getStrictOwnerOpenId(APP)).toBe(OWNER);
  });

  it('does not pick among several people without an explicit owner', () => {
    bot({ allowedUsers: [OWNER_UNION, OTHER_UNION] }, { [OWNER_UNION]: OWNER, [OTHER_UNION]: OTHER });
    expect(getStrictOwnerOpenId(APP)).toBeUndefined();
    // The loose owner keeps its legacy first-entry choice.
    expect(getOwnerOpenId(APP)).toBe(OWNER);
  });

  it('does not default while another configured entry failed to resolve', () => {
    bot({ allowedUsers: [OWNER_UNION, 'other@example.com'] }, { [OWNER_UNION]: OWNER });
    expect(getStrictOwnerOpenId(APP)).toBeUndefined();
  });

  it('does not default while the resolved allowlist holds a person no entry names', () => {
    const state = bot({ allowedUsers: [OWNER_UNION] }, { [OWNER_UNION]: OWNER });
    state.resolvedAllowedUsers = [OWNER, OTHER];
    expect(getStrictOwnerOpenId(APP)).toBeUndefined();
  });

  it('has no owner for an empty allowlist', () => {
    bot({ allowedUsers: [] }, {});
    expect(getStrictOwnerOpenId(APP)).toBeUndefined();
  });

  it('uses an explicit ownerOpenId among several people', () => {
    bot({ allowedUsers: [OTHER_UNION, OWNER_UNION], ownerOpenId: OWNER }, { [OTHER_UNION]: OTHER, [OWNER_UNION]: OWNER });
    expect(getStrictOwnerOpenId(APP)).toBe(OWNER);
  });

  it('does not fall back to the only allowed person when the explicit owner left the allowlist', () => {
    bot({ allowedUsers: [OTHER_UNION], ownerOpenId: OWNER }, { [OTHER_UNION]: OTHER });
    expect(getStrictOwnerOpenId(APP)).toBeUndefined();
    expect(getOwnerOpenId(APP)).toBe(OTHER);
  });

  it('uses an explicit ownerUnionId that is an allowlist entry, for both owner views', () => {
    bot({ allowedUsers: [OTHER_UNION, OWNER_UNION], ownerUnionId: OWNER_UNION }, { [OTHER_UNION]: OTHER, [OWNER_UNION]: OWNER });
    expect(getStrictOwnerOpenId(APP)).toBe(OWNER);
    expect(getOwnerOpenId(APP)).toBe(OWNER);
  });

  it('refuses an ownerUnionId that no allowlist entry resolves', () => {
    bot({ allowedUsers: ['owner@example.com'], ownerUnionId: OWNER_UNION }, { 'owner@example.com': OWNER });
    expect(getStrictOwnerOpenId(APP)).toBeUndefined();
  });

  it('refuses ownerOpenId and ownerUnionId that name different people', () => {
    bot({ allowedUsers: [OWNER_UNION, OTHER_UNION], ownerOpenId: OWNER, ownerUnionId: OTHER_UNION },
      { [OWNER_UNION]: OWNER, [OTHER_UNION]: OTHER });
    expect(getStrictOwnerOpenId(APP)).toBeUndefined();
  });

  it('accepts ownerOpenId and ownerUnionId that name the same person', () => {
    bot({ allowedUsers: [OWNER_UNION, OTHER_UNION], ownerOpenId: OWNER, ownerUnionId: OWNER_UNION },
      { [OWNER_UNION]: OWNER, [OTHER_UNION]: OTHER });
    expect(getStrictOwnerOpenId(APP)).toBe(OWNER);
  });

  it.each(['ou_not_a_union', 'owner@example.com', 'on_', 42])('ignores a malformed ownerUnionId %s', ownerUnionId => {
    const state = bot({ allowedUsers: [OWNER_UNION], ownerUnionId }, { [OWNER_UNION]: OWNER });
    expect(state.config.ownerUnionId).toBeUndefined();
    expect(getStrictOwnerOpenId(APP)).toBe(OWNER);
  });
});

describe('whether a union_id names the owner', () => {
  beforeEach(() => __testOnly_resetBotRegistry());

  it('answers from the allowlist entries', () => {
    bot({ allowedUsers: [OWNER_UNION, OTHER_UNION], ownerOpenId: OWNER }, { [OWNER_UNION]: OWNER, [OTHER_UNION]: OTHER });
    expect(ownerUnionIdVerdict(APP, OWNER, OWNER_UNION)).toBe('match');
    expect(ownerUnionIdVerdict(APP, OWNER, OTHER_UNION)).toBe('mismatch');
  });

  it('refuses any other union_id once an ownerUnionId is declared', () => {
    bot({ allowedUsers: [OWNER_UNION], ownerUnionId: OWNER_UNION }, { [OWNER_UNION]: OWNER });
    expect(ownerUnionIdVerdict(APP, OWNER, 'on_fixture_unlisted')).toBe('mismatch');
  });

  it('needs a lookup when the owner is not listed by union_id', () => {
    bot({ allowedUsers: ['owner@example.com'] }, { 'owner@example.com': OWNER });
    expect(ownerUnionIdVerdict(APP, OWNER, OWNER_UNION)).toBe('lookup');
  });
});
