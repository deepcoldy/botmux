/**
 * Federation stores: deployment identity, hub-side federation, spoke-side membership.
 * Run: pnpm vitest run test/federation-store.test.ts
 */
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { getDeploymentIdentity, setDeploymentName } from '../src/services/deployment-identity.js';
import {
  registerDeployment, syncDeployment, getDeploymentByToken, removeDeploymentByToken,
  listFederatedDeployments, removeDeployment, removeTeamFederation,
} from '../src/services/federation-store.js';
import { addMembership, listMemberships, removeMembership, findMembershipByDelegationToken } from '../src/services/federation-membership-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-fed-')); });

const bot = (app: string, name = app) => ({ larkAppId: app, botName: name, cliId: 'codex' });

describe('deployment-identity', () => {
  it('generates + persists a stable id on first call, reuses it after', () => {
    const a = getDeploymentIdentity(dataDir);
    expect(a.deploymentId).toMatch(/^dep_/);
    expect(existsSync(join(dataDir, 'deployment-identity.json'))).toBe(true);
    const b = getDeploymentIdentity(dataDir);
    expect(b.deploymentId).toBe(a.deploymentId); // stable
  });

  it('binding an owner adopts the owner Feishu name as the deployment name', async () => {
    const { setDeploymentOwner } = await import('../src/services/deployment-identity.js');
    const a = getDeploymentIdentity(dataDir);
    const r = setDeploymentOwner(dataDir, { unionId: 'on_x', name: '申晗' });
    expect(r.ownerUnionId).toBe('on_x');
    expect(r.ownerName).toBe('申晗');
    expect(r.name).toBe('申晗');             // deployment label defaults to the Feishu name
    expect(r.deploymentId).toBe(a.deploymentId);
    expect(getDeploymentIdentity(dataDir).name).toBe('申晗');
  });

  it('renames without changing the id', () => {
    const a = getDeploymentIdentity(dataDir);
    const r = setDeploymentName(dataDir, '申晗的部署');
    expect(r.name).toBe('申晗的部署');
    expect(r.deploymentId).toBe(a.deploymentId);
    expect(getDeploymentIdentity(dataDir).name).toBe('申晗的部署');
  });
});

describe('federation-store (hub)', () => {
  it('registers a deployment, issues a syncToken, resolves it back', () => {
    const { syncToken, created } = registerDeployment(dataDir, 'default', { deploymentId: 'dep_x', name: 'X', bots: [bot('cli_a')] });
    expect(created).toBe(true);
    expect(syncToken.length).toBeGreaterThan(20);
    const r = getDeploymentByToken(dataDir, syncToken);
    expect(r?.teamId).toBe('default');
    expect(r?.deployment.deploymentId).toBe('dep_x');
    expect(listFederatedDeployments(dataDir, 'default').map(d => d.deploymentId)).toEqual(['dep_x']);
  });

  it('re-registering an existing deploymentId is refused with NO token (no hijack)', () => {
    const first = registerDeployment(dataDir, 'default', { deploymentId: 'dep_x', name: 'X', bots: [bot('cli_a')] });
    const second = registerDeployment(dataDir, 'default', { deploymentId: 'dep_x', name: 'X2', bots: [bot('cli_b')] });
    expect(second.created).toBe(false);
    expect(second.syncToken).toBe(''); // never hand back the existing token
    const list = listFederatedDeployments(dataDir, 'default');
    expect(list.length).toBe(1);            // not duplicated
    expect(list[0].syncToken).toBe(first.syncToken); // unchanged
    expect(list[0].name).toBe('X');         // not overwritten by the rejected re-register
  });

  it('stores callbackUrl + delegationToken for hub→spoke delegation', () => {
    registerDeployment(dataDir, 'default', { deploymentId: 'dep_x', name: 'X', bots: [], callbackUrl: 'http://spoke:7891', delegationToken: 'dtok' });
    const d = listFederatedDeployments(dataDir, 'default')[0];
    expect(d.callbackUrl).toBe('http://spoke:7891');
    expect(d.delegationToken).toBe('dtok');
  });

  it('removeDeploymentByToken drops the owning deployment; unknown token is false', () => {
    const { syncToken } = registerDeployment(dataDir, 'default', { deploymentId: 'dep_x', name: 'X', bots: [] });
    expect(removeDeploymentByToken(dataDir, 'nope')).toBe(false);
    expect(removeDeploymentByToken(dataDir, syncToken)).toBe(true);
    expect(listFederatedDeployments(dataDir, 'default')).toEqual([]);
  });

  it('syncDeployment updates bots + heartbeat by token; unknown token is false', () => {
    const { syncToken } = registerDeployment(dataDir, 'default', { deploymentId: 'dep_x', name: 'X', bots: [bot('cli_a')] }, 1000);
    expect(syncDeployment(dataDir, syncToken, [bot('cli_a'), bot('cli_c')], undefined, 5000)).toBe(true);
    const d = getDeploymentByToken(dataDir, syncToken)!.deployment;
    expect(d.bots.map(b => b.larkAppId)).toEqual(['cli_a', 'cli_c']);
    expect(d.lastSeenAt).toBe(5000);
    expect(syncDeployment(dataDir, 'bogus', [], undefined, 6000)).toBe(false);
  });

  it('syncDeployment propagates a changed name + owner (binding adopts the Feishu name)', () => {
    const { syncToken } = registerDeployment(dataDir, 'default', { deploymentId: 'dep_x', name: 'n37-097-123', bots: [] }, 1000);
    expect(syncDeployment(dataDir, syncToken, [bot('cli_a')], { ownerUnionId: 'on_x', ownerName: '申晗', name: '申晗' }, 5000)).toBe(true);
    const d = listFederatedDeployments(dataDir, 'default')[0];
    expect(d.name).toBe('申晗');        // Hub-side grouping name follows the owner's Feishu name
    expect(d.ownerUnionId).toBe('on_x');
    expect(d.ownerName).toBe('申晗');
    // empty name on a later sync must NOT wipe it
    expect(syncDeployment(dataDir, syncToken, [bot('cli_a')], { name: '' }, 6000)).toBe(true);
    expect(listFederatedDeployments(dataDir, 'default')[0].name).toBe('申晗');
  });

  it('removeDeployment / removeTeamFederation drop records', () => {
    registerDeployment(dataDir, 'default', { deploymentId: 'dep_x', name: 'X', bots: [] });
    registerDeployment(dataDir, 'default', { deploymentId: 'dep_y', name: 'Y', bots: [] });
    expect(removeDeployment(dataDir, 'default', 'dep_x')).toBe(true);
    expect(listFederatedDeployments(dataDir, 'default').map(d => d.deploymentId)).toEqual(['dep_y']);
    expect(removeDeployment(dataDir, 'default', 'nope')).toBe(false);
    removeTeamFederation(dataDir, 'default');
    expect(listFederatedDeployments(dataDir, 'default')).toEqual([]);
  });
});

describe('federation-membership-store (spoke)', () => {
  it('adds, lists, and removes remote memberships; supports multiple hubs/teams', () => {
    addMembership(dataDir, { hubUrl: 'http://hub1:7891', teamId: 'default', teamName: 'T1', syncToken: 'tok1', deploymentId: 'dep_me' });
    addMembership(dataDir, { hubUrl: 'http://hub2:7891', teamId: 'team_b', teamName: 'T2', syncToken: 'tok2', deploymentId: 'dep_me' });
    expect(listMemberships(dataDir).map(m => m.teamName).sort()).toEqual(['T1', 'T2']);
    // re-add same hub+team replaces (idempotent key)
    addMembership(dataDir, { hubUrl: 'http://hub1:7891', teamId: 'default', teamName: 'T1b', syncToken: 'tok1b', deploymentId: 'dep_me' });
    expect(listMemberships(dataDir).length).toBe(2);
    expect(removeMembership(dataDir, 'http://hub1:7891', 'default')).toBe(true);
    expect(listMemberships(dataDir).map(m => m.hubUrl)).toEqual(['http://hub2:7891']);
    expect(removeMembership(dataDir, 'http://nope', 'x')).toBe(false);
  });

  it('findMembershipByDelegationToken resolves the issuing membership', () => {
    addMembership(dataDir, { hubUrl: 'http://hub:7891', teamId: 'default', teamName: 'T', syncToken: 'tok', deploymentId: 'dep_me', delegationToken: 'DTOK' });
    expect(findMembershipByDelegationToken(dataDir, 'DTOK')?.hubUrl).toBe('http://hub:7891');
    expect(findMembershipByDelegationToken(dataDir, 'nope')).toBeNull();
    expect(findMembershipByDelegationToken(dataDir, '')).toBeNull();
  });
});
