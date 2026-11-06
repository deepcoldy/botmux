import { describe, expect, it } from 'vitest';
import { platformTeammateVerdict } from '../src/core/platform-teammate.js';
import { platformMachineOwner } from '../src/platform/binding.js';

const team = (memberUnionIds: string[]) => ({ teamId: 't', teamName: 'T', groupChatIds: [], bots: [], memberUnionIds });

describe('platformTeammateVerdict', () => {
  it('recognizes the owner without any team', () => {
    expect(platformTeammateVerdict({ senderUnionId: 'on_o', ownerUnionId: 'on_o', teams: [] })).toBe('owner');
    expect(platformTeammateVerdict({ senderUnionId: 'on_o', ownerUnionId: 'on_o', teams: null })).toBe('owner');
  });

  it('accepts a member of any of the owner\'s teams', () => {
    expect(platformTeammateVerdict({
      senderUnionId: 'on_m', ownerUnionId: 'on_o', teams: [team(['on_o']), team(['on_o', 'on_m'])],
    })).toBe('teammate');
  });

  it('flags a sender outside every team', () => {
    expect(platformTeammateVerdict({ senderUnionId: 'on_x', ownerUnionId: 'on_o', teams: [team(['on_o', 'on_m'])] })).toBe('not_teammate');
    // Owner without teams: nobody else can be a teammate.
    expect(platformTeammateVerdict({ senderUnionId: 'on_x', ownerUnionId: 'on_o', teams: [] })).toBe('not_teammate');
    // Owner id unreadable, but a non-empty roster that lacks the sender also excludes the owner.
    expect(platformTeammateVerdict({ senderUnionId: 'on_x', teams: [team(['on_o'])] })).toBe('not_teammate');
  });

  it('stays unknown when the answer is not provable', () => {
    expect(platformTeammateVerdict({ ownerUnionId: 'on_o', teams: [team(['on_o'])] })).toBe('unknown');
    expect(platformTeammateVerdict({ senderUnionId: 'on_x', ownerUnionId: 'on_o', teams: null })).toBe('unknown');
    expect(platformTeammateVerdict({ senderUnionId: 'on_x', teams: [] })).toBe('unknown');
  });
});

describe('platformMachineOwner', () => {
  const binding = (machineToken: string) => ({ platformUrl: 'https://p.example', machineId: 'm1', machineToken });
  const token = (payload: unknown) => `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

  it('reads owner union_id and name from the signed token payload', () => {
    expect(platformMachineOwner(binding(token({ kind: 'machine', unionId: 'on_o', ownerName: 'Owner' }))))
      .toEqual({ unionId: 'on_o', name: 'Owner' });
  });

  it('returns nothing for an unbound machine or an unreadable token', () => {
    expect(platformMachineOwner(null)).toEqual({});
    expect(platformMachineOwner(binding('not-json.sig'))).toEqual({});
    expect(platformMachineOwner(binding(token({ unionId: 42 })))).toEqual({});
  });
});
