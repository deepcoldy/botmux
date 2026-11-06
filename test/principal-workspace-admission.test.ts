import { describe, expect, it } from 'vitest';
import {
  PRINCIPAL_WORKSPACE_GROUP_KEY_VERSION,
  legacyPrincipalWorkspaceGroupId,
  parsePrincipalWorkspaceGroup,
  parsePrincipalWorkspaceMember,
  principalWorkspaceGroupIdV2,
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
});
