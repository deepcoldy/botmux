/**
 * planGroupCreator: only auto-invite the web user when their paired bot is the
 * creator (Lark open_id is per-app scoped — wrong-scope open_id must not be
 * forwarded to a different creator daemon).
 * Run: pnpm vitest run test/team-group.test.ts
 */
import { describe, it, expect } from 'vitest';
import { buildTeamGroupCreatePayload, planGroupCreator } from '../src/dashboard/team-group.js';

const onlineAll = () => true;
const pick = (ids: string[]) => ids[0] ?? null;

describe('planGroupCreator', () => {
  it('uses the paired bot as creator and invites the user when it is selected + online', () => {
    expect(planGroupCreator(['cli_a', 'cli_b'], 'cli_a', onlineAll, pick)).toEqual({ creatorLarkAppId: 'cli_a', inviteUser: true });
  });

  it('does NOT invite (no wrong-scope open_id) when paired bot is not selected', () => {
    // paired bot cli_x not in selection → fallback creator, inviteUser false
    expect(planGroupCreator(['cli_a', 'cli_b'], 'cli_x', onlineAll, pick)).toEqual({ creatorLarkAppId: 'cli_a', inviteUser: false });
  });

  it('does NOT invite when paired bot is selected but offline', () => {
    const isOnline = (id: string) => id !== 'cli_a';
    const pickOnline = (ids: string[]) => ids.find(isOnline) ?? null; // realistic: fallback picks an online bot
    expect(planGroupCreator(['cli_a', 'cli_b'], 'cli_a', isOnline, pickOnline)).toEqual({ creatorLarkAppId: 'cli_b', inviteUser: false });
  });

  it('no preferred creator → fallback, no invite', () => {
    expect(planGroupCreator(['cli_a'], undefined, onlineAll, pick)).toEqual({ creatorLarkAppId: 'cli_a', inviteUser: false });
  });

  it('null creator when nothing pickable', () => {
    expect(planGroupCreator(['cli_a'], 'cli_x', onlineAll, () => null)).toEqual({ creatorLarkAppId: null, inviteUser: false });
  });
});

describe('buildTeamGroupCreatePayload', () => {
  it('forwards the authenticated operator union_id as the team-group owner transfer target', () => {
    expect(buildTeamGroupCreatePayload({
      name: '协作群',
      larkAppIds: ['cli_a', 'cli_b'],
      userOpenIds: [],
      ownerUnionIds: ['on_operator', 'on_other_owner'],
      transferOwnerUnionId: 'on_operator',
    })).toEqual({
      name: '协作群',
      larkAppIds: ['cli_a', 'cli_b'],
      userOpenIds: [],
      ownerUnionIds: ['on_operator', 'on_other_owner'],
      transferOwnerUnionId: 'on_operator',
    });
  });

  it('does not guess a transfer target from bot owners when the operator identity is unavailable', () => {
    expect(buildTeamGroupCreatePayload({
      name: '无人群',
      larkAppIds: ['cli_a'],
      userOpenIds: [],
      ownerUnionIds: ['on_bot_owner'],
    })).not.toHaveProperty('transferOwnerUnionId');
  });
});
