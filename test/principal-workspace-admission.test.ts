import { describe, expect, it } from 'vitest';
import {
  PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION,
  legacyPrincipalWorkspaceGroupId,
  parsePrincipalWorkspaceGroup,
  parsePrincipalWorkspaceMember,
  parsePrincipalWorkspaceTicket,
  parsePrincipalWorkspaceTicketSequence,
  principalWorkspaceGroupIdV2,
  principalWorkspaceTicketIdV1,
  validPrincipalWorkspaceGroupIdentity,
} from '../src/core/principal-workspace-admission.js';

describe('principal workspace admission identity', () => {
  const now = '2026-09-19T08:00:00.000Z';

  it('reproduces legacy v1 exactly and keeps v2 shared by app and canonical cwd', () => {
    expect(legacyPrincipalWorkspaceGroupId('source-a', '/repo', 7))
      .toBe('principal-workspace:a1b192386c7ac874d6bf1e97');
    expect(legacyPrincipalWorkspaceGroupId('source-a', '/repo', 7))
      .not.toBe(legacyPrincipalWorkspaceGroupId('source-b', '/repo', 7));

    const first = principalWorkspaceGroupIdV2('app-a', '/repo');
    expect(first).toMatch(/^principal-workspace:v2:[a-f0-9]{64}$/);
    expect(first).toBe(principalWorkspaceGroupIdV2('app-a', '/repo'));
    expect(first).not.toBe(principalWorkspaceGroupIdV2('app-b', '/repo'));
    expect(first).not.toBe(principalWorkspaceGroupIdV2('app-a', '/repo-other'));
  });

  it('treats an absent key version as provable v1 only and rejects null or unknown versions', () => {
    const sourceSessionId = 'source-a';
    const canonicalCwd = '/repo';
    const workspaceEpoch = 3;
    const v1Id = legacyPrincipalWorkspaceGroupId(sourceSessionId, canonicalCwd, workspaceEpoch);
    const common = {
      sourceSessionId,
      larkAppId: 'app-a',
      canonicalCwd,
      workspaceEpoch,
      workspaceGroupId: v1Id,
    };
    expect(validPrincipalWorkspaceGroupIdentity({
      ...common,
      workspaceGroupKeyVersionPresent: false,
    })).toEqual({ ok: true, version: 1 });
    expect(validPrincipalWorkspaceGroupIdentity({
      ...common,
      workspaceGroupKeyVersion: null,
      workspaceGroupKeyVersionPresent: true,
    })).toEqual({ ok: false, error: 'invalid_workspace_group_key_version' });
    expect(validPrincipalWorkspaceGroupIdentity({
      ...common,
      workspaceGroupKeyVersion: 1,
      workspaceGroupKeyVersionPresent: true,
    })).toEqual({ ok: false, error: 'invalid_workspace_group_key_version' });
  });

  it('parses complete group and member rows and rejects malformed metadata', () => {
    const groupId = principalWorkspaceGroupIdV2('app-a', '/repo');
    const group = {
      version: 1,
      groupId,
      groupKeyVersion: PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION,
      larkAppId: 'app-a',
      canonicalCwd: '/repo',
      phase: 'active',
      revision: 1,
      lastLeaseGeneration: 0,
      createdAt: now,
      updatedAt: now,
    };
    expect(parsePrincipalWorkspaceGroup(group)).toEqual({ ok: true, value: group });
    expect(parsePrincipalWorkspaceGroup({ ...group, updatedAt: 'bad' }))
      .toEqual({ ok: false, error: 'invalid_group_metadata' });

    const member = {
      version: 1,
      sourceSessionId: 'source-a',
      laneId: 'source',
      sessionId: 'source-a',
      groupId,
      workspaceEpoch: 1,
      membershipPhase: 'active',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    expect(parsePrincipalWorkspaceMember(member)).toEqual({ ok: true, value: member });
    expect(parsePrincipalWorkspaceMember({ ...member, workspaceEpoch: 0 }))
      .toEqual({ ok: false, error: 'invalid_member_metadata' });
  });

  it('derives and validates deterministic ticket, locator, and counter identities', () => {
    const identity = {
      groupId: principalWorkspaceGroupIdV2('app-a', '/repo'),
      sourceSessionId: 'source-a', laneId: 'lane-a', sessionId: 'session-a', turnId: 'turn-a',
    };
    const ticketId = principalWorkspaceTicketIdV1(identity);
    expect(ticketId).toMatch(/^principal-workspace-ticket:v1:[a-f0-9]{64}$/);
    expect(ticketId).toBe(principalWorkspaceTicketIdV1(identity));
    const locator = {
      namespaceVersion: 1 as const,
      namespace: `plq_v1_${'1'.repeat(64)}`,
      recordVersion: 1 as const,
      recordId: `plr_v1_${'2'.repeat(64)}`,
      turnId: identity.turnId,
      payloadEncoding: 'canonical-json-utf8-base64' as const,
      payloadHash: `sha256:${'3'.repeat(64)}`,
      exactFileLength: 512,
    };
    const ticket = {
      version: 1 as const, ticketId, ...identity, sequence: 7,
      workspaceEpoch: 2, status: 'queued' as const, revision: 1, locator,
      createdAt: now, updatedAt: now,
    };
    expect(parsePrincipalWorkspaceTicket(ticket)).toEqual({ ok: true, value: ticket });
    expect(parsePrincipalWorkspaceTicket({ ...ticket, ticketId: `${ticketId}x` }))
      .toEqual({ ok: false, error: 'ticket_id_mismatch' });
    expect(parsePrincipalWorkspaceTicket({ ...ticket, locator: { ...locator, turnId: 'other' } }))
      .toEqual({ ok: false, error: 'ticket_turn_mismatch' });
    const counter = {
      version: 1 as const, groupId: identity.groupId, lastSequence: 7,
      revision: 3, createdAt: now, updatedAt: now,
    };
    expect(parsePrincipalWorkspaceTicketSequence(counter)).toEqual({ ok: true, value: counter });
    expect(parsePrincipalWorkspaceTicketSequence({ ...counter, lastSequence: -1 }))
      .toEqual({ ok: false, error: 'invalid_ticket_sequence' });
  });
});
