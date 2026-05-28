/**
 * Federation hub roster aggregation + hub HTTP endpoints (join/sync/roster).
 * Run: pnpm vitest run test/federation-api.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return state.dataDir; } } },
}));

import { handleFederationApi } from '../src/dashboard/federation-api.js';
import { buildFederatedRoster } from '../src/services/federation-roster.js';
import { registerDeployment } from '../src/services/federation-store.js';
import { ensureDefaultTeam, addMember, DEFAULT_TEAM_ID } from '../src/services/team-store.js';
import { createInvite } from '../src/services/invite-store.js';
import { addMembership } from '../src/services/federation-membership-store.js';
import { getDeploymentIdentity, setDeploymentOwner } from '../src/services/deployment-identity.js';
import { setBotOwner } from '../src/services/bot-owner-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-fedapi-')); state.dataDir = dataDir; });

function writeBots(entries: any[]) { writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify(entries)); }
function makeReq(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): any {
  const req: any = { method, url: path, headers };
  req[Symbol.asyncIterator] = async function* () { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); };
  return req;
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
function makeRes(): any {
  const res: any = { statusCode: 0, _headers: {}, _body: '' };
  res.setHeader = (k: string, v: any) => { res._headers[k.toLowerCase()] = v; };
  res.getHeader = (k: string) => res._headers[k.toLowerCase()];
  res.writeHead = (s: number, h?: any) => { res.statusCode = s; if (h) Object.assign(res._headers, h); };
  res.end = (b?: string) => { res._body = b ?? ''; };
  return res;
}
const call = (req: any, res: any, path: string) => handleFederationApi(req, res, new URL('http://x' + path), { dataDir });
const callWithGroup = (req: any, res: any, path: string, createTeamGroup: any) => handleFederationApi(req, res, new URL('http://x' + path), { dataDir, createTeamGroup });
const json = (res: any) => JSON.parse(res._body);

describe('buildFederatedRoster', () => {
  it('merges local bots (tagged local) with federated deployments\' bots', () => {
    writeBots([{ larkAppId: 'cli_local', botOpenId: null, botName: '本地Bot', cliId: 'claude' }]);
    registerDeployment(dataDir, DEFAULT_TEAM_ID, {
      deploymentId: 'dep_remote', name: '同事的部署',
      bots: [{ larkAppId: 'cli_remote', botName: '远端Bot', cliId: 'codex' }],
    });
    const r = buildFederatedRoster(dataDir, DEFAULT_TEAM_ID);
    expect(r.bots.map(b => b.name).sort()).toEqual(['本地Bot', '远端Bot']);
    const local = r.bots.find(b => b.larkAppId === 'cli_local')!;
    const remote = r.bots.find(b => b.larkAppId === 'cli_remote')!;
    expect(local.deployment.local).toBe(true);
    expect(remote.deployment.local).toBe(false);
    expect(remote.deployment.name).toBe('同事的部署');
    // deployments list: local first, then remote
    expect(r.deployments[0].local).toBe(true);
    expect(r.deployments.find(d => d.id === 'dep_remote')?.botCount).toBe(1);
  });
});

describe('handleFederationApi', () => {
  it('returns false for unrelated paths', async () => {
    expect(await call(makeReq('GET', '/api/sessions'), makeRes(), '/api/sessions')).toBe(false);
  });

  it('join → sync → roster full flow', async () => {
    writeBots([{ larkAppId: 'cli_hub', botOpenId: null, botName: 'HubBot', cliId: 'claude' }]);
    ensureDefaultTeam(dataDir);
    addMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_owner' });
    const { code } = createInvite(dataDir, DEFAULT_TEAM_ID, 'on_owner');

    // join with invite
    let res = makeRes();
    await call(makeReq('POST', '/api/federation/join', {
      inviteCode: code,
      deployment: { deploymentId: 'dep_b', name: 'B部署', bots: [{ larkAppId: 'cli_b1', botName: 'B1', cliId: 'codex' }] },
    }), res, '/api/federation/join');
    expect(res.statusCode).toBe(200);
    const { syncToken, teamId } = json(res);
    expect(teamId).toBe(DEFAULT_TEAM_ID);
    expect(syncToken.length).toBeGreaterThan(20);

    // sync updates bots
    res = makeRes();
    await call(makeReq('POST', '/api/federation/sync', { syncToken, bots: [{ larkAppId: 'cli_b1', botName: 'B1', cliId: 'codex' }, { larkAppId: 'cli_b2', botName: 'B2', cliId: 'gemini' }] }), res, '/api/federation/sync');
    expect(res.statusCode).toBe(200);

    // roster reflects hub local + B's two bots (token in Authorization header)
    res = makeRes();
    await call(makeReq('GET', '/api/federation/roster', undefined, bearer(syncToken)), res, '/api/federation/roster');
    expect(res.statusCode).toBe(200);
    expect(json(res).bots.map((b: any) => b.larkAppId).sort()).toEqual(['cli_b1', 'cli_b2', 'cli_hub']);

    // a second deployment can't re-bind by re-joining with the same id → 409
    const { code: code2 } = createInvite(dataDir, DEFAULT_TEAM_ID, 'on_owner');
    res = makeRes();
    await call(makeReq('POST', '/api/federation/join', { inviteCode: code2, deployment: { deploymentId: 'dep_b', name: 'B', bots: [] } }), res, '/api/federation/join');
    expect(res.statusCode).toBe(409);
    expect(json(res).error).toBe('deployment_already_joined');

    // leave (authed by syncToken) drops the deployment; roster then 403s
    res = makeRes();
    await call(makeReq('POST', '/api/federation/leave', { syncToken }), res, '/api/federation/leave');
    expect(res.statusCode).toBe(200);
    res = makeRes();
    await call(makeReq('GET', '/api/federation/roster', undefined, bearer(syncToken)), res, '/api/federation/roster');
    expect(res.statusCode).toBe(403);
  });

  it('roster still accepts ?syncToken= as a short-term compat fallback', async () => {
    writeBots([]);
    ensureDefaultTeam(dataDir);
    addMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_owner' });
    const { code } = createInvite(dataDir, DEFAULT_TEAM_ID, 'on_owner');
    let res = makeRes();
    await call(makeReq('POST', '/api/federation/join', { inviteCode: code, deployment: { deploymentId: 'dep_c', name: 'C', bots: [] } }), res, '/api/federation/join');
    const { syncToken } = json(res);
    res = makeRes();
    await call(makeReq('GET', '/api/federation/roster?syncToken=' + syncToken), res, '/api/federation/roster?syncToken=' + syncToken);
    expect(res.statusCode).toBe(200);
  });

  it('join rejects self-join (same deploymentId) with cannot_join_self', async () => {
    ensureDefaultTeam(dataDir);
    addMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_owner' });
    const { code } = createInvite(dataDir, DEFAULT_TEAM_ID, 'on_owner');
    const me = getDeploymentIdentity(dataDir); // this deployment's own id
    const res = makeRes();
    await call(makeReq('POST', '/api/federation/join', { inviteCode: code, deployment: { deploymentId: me.deploymentId, name: 'self', bots: [] } }), res, '/api/federation/join');
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('cannot_join_self');
  });

  it('join rejects a bad invite code (403)', async () => {
    const res = makeRes();
    await call(makeReq('POST', '/api/federation/join', { inviteCode: 'NOPE', deployment: { deploymentId: 'dep_b', name: 'B', bots: [] } }), res, '/api/federation/join');
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toBe('invite_not_found');
  });

  it('sync / roster reject an unknown token (403)', async () => {
    let res = makeRes();
    await call(makeReq('POST', '/api/federation/sync', { syncToken: 'bogus', bots: [] }), res, '/api/federation/sync');
    expect(res.statusCode).toBe(403);
    res = makeRes();
    await call(makeReq('GET', '/api/federation/roster?syncToken=bogus'), res, '/api/federation/roster');
    expect(res.statusCode).toBe(403);
  });

  it('delegate-group: valid token → creates via createTeamGroup; idempotent on requestId; guardrails', async () => {
    writeBots([{ larkAppId: 'cli_a', botOpenId: null, botName: 'A', cliId: 'claude' }]); // our local bot
    addMembership(dataDir, { hubUrl: 'http://hub:7891', teamId: 'default', teamName: 'T', syncToken: 'st', deploymentId: 'dep_me', delegationToken: 'DTOK' });
    let calls = 0; let captured: any = null;
    const createTeamGroup = vi.fn(async (args: any) => { calls++; captured = args; return { ok: true, chatId: 'oc_deleg', shareLink: 'https://x', invalidBotIds: [] }; });
    // valid token + involves our local bot cli_a → creates
    let res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/delegate-group', { name: 'g', larkAppIds: ['cli_a', 'cli_b'], ownerUnionIds: ['on_1'], requestId: 'req1' }, bearer('DTOK')), res, '/api/federation/delegate-group', createTeamGroup);
    expect(res.statusCode).toBe(200);
    expect(json(res).chatId).toBe('oc_deleg');
    expect(captured).toMatchObject({ name: 'g', larkAppIds: ['cli_a', 'cli_b'], ownerUnionIds: ['on_1'] });
    // replay same requestId → cached, createTeamGroup NOT called again (no dup group)
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/delegate-group', { larkAppIds: ['cli_a'], requestId: 'req1' }, bearer('DTOK')), res, '/api/federation/delegate-group', createTeamGroup);
    expect(res.statusCode).toBe(200);
    expect(json(res).chatId).toBe('oc_deleg');
    expect(calls).toBe(1); // idempotent
    // guardrail: no local bot in selection → 400 no_local_bot
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/delegate-group', { larkAppIds: ['cli_remote_only'], requestId: 'r2' }, bearer('DTOK')), res, '/api/federation/delegate-group', createTeamGroup);
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('no_local_bot');
    // unknown token → 403
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/delegate-group', { larkAppIds: ['cli_a'] }, bearer('NOPE')), res, '/api/federation/delegate-group', createTeamGroup);
    expect(res.statusCode).toBe(403);
    // no createTeamGroup dep → 501
    res = makeRes();
    await call(makeReq('POST', '/api/federation/delegate-group', { larkAppIds: ['cli_a'] }, bearer('DTOK')), res, '/api/federation/delegate-group');
    expect(res.statusCode).toBe(501);
  });

  it('federation/group: spoke initiates; operator is hub-derived from syncToken; requestId required + idempotent', async () => {
    writeBots([{ larkAppId: 'cli_hub', botOpenId: null, botName: 'Hub', cliId: 'claude' }]); // hub local bot
    registerDeployment(dataDir, DEFAULT_TEAM_ID, { deploymentId: 'dep_spoke', name: 'S', ownerUnionId: 'on_spoke', bots: [{ larkAppId: 'cli_sp', botName: 'SP', cliId: 'codex' }] });
    const list = (await import('../src/services/federation-store.js')).listFederatedDeployments(dataDir, DEFAULT_TEAM_ID);
    const syncToken = list[0].syncToken;
    let calls = 0; let captured: any = null;
    const createTeamGroup = vi.fn(async (a: any) => { calls++; captured = a; return { ok: true, chatId: 'oc_g', invalidBotIds: [] }; });
    // missing requestId → 400
    let res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/group', { name: 'g', larkAppIds: ['cli_hub'] }, bearer(syncToken)), res, '/api/federation/group', createTeamGroup);
    expect(json(res).error).toBe('request_id_required');
    // valid → orchestrates; operator (spoke owner, hub-derived) in invitees
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/group', { name: 'g', larkAppIds: ['cli_hub'], requestId: 'r1' }, bearer(syncToken)), res, '/api/federation/group', createTeamGroup);
    expect(res.statusCode).toBe(200);
    expect(json(res).chatId).toBe('oc_g');
    expect(captured.ownerUnionIds).toContain('on_spoke'); // operator from syncToken, NOT request body
    // replay same requestId → idempotent (createTeamGroup not called again)
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/group', { name: 'g', larkAppIds: ['cli_hub'], requestId: 'r1' }, bearer(syncToken)), res, '/api/federation/group', createTeamGroup);
    expect(res.statusCode).toBe(200);
    expect(json(res).chatId).toBe('oc_g');
    expect(calls).toBe(1);
    // unknown token → 403
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/group', { larkAppIds: ['cli_hub'], requestId: 'r2' }, bearer('NOPE')), res, '/api/federation/group', createTeamGroup);
    expect(res.statusCode).toBe(403);
  });

  it('delegate-group: header-only token + requestId mandatory + failure terminal result cached (Codex hardening)', async () => {
    writeBots([{ larkAppId: 'cli_a', botOpenId: null, botName: 'A', cliId: 'claude' }]);
    addMembership(dataDir, { hubUrl: 'http://hub:7891', teamId: 'default', teamName: 'T', syncToken: 'st', deploymentId: 'dep_me', delegationToken: 'DTOK' });
    let calls = 0;
    const createTeamGroup = vi.fn(async () => { calls++; return { ok: false, error: 'group_create_proxy_failed' }; });
    // query token → rejected
    const qp = '/api/federation/delegate-group?syncToken=DTOK';
    let res = makeRes();
    await callWithGroup(makeReq('POST', qp, { larkAppIds: ['cli_a'], requestId: 'd1' }), res, qp, createTeamGroup);
    expect(res.statusCode).toBe(403);
    // body token → rejected
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/delegate-group', { delegationToken: 'DTOK', larkAppIds: ['cli_a'], requestId: 'd1' }), res, '/api/federation/delegate-group', createTeamGroup);
    expect(res.statusCode).toBe(403);
    // valid header token but missing requestId → 400
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/delegate-group', { larkAppIds: ['cli_a'] }, bearer('DTOK')), res, '/api/federation/delegate-group', createTeamGroup);
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('request_id_required');
    expect(calls).toBe(0); // never reached createTeamGroup
    // failure terminal result cached → replay returns 502, createTeamGroup NOT called again
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/delegate-group', { larkAppIds: ['cli_a'], requestId: 'd2' }, bearer('DTOK')), res, '/api/federation/delegate-group', createTeamGroup);
    expect(res.statusCode).toBe(502);
    expect(json(res).error).toBe('group_create_proxy_failed');
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/delegate-group', { larkAppIds: ['cli_a'], requestId: 'd2' }, bearer('DTOK')), res, '/api/federation/delegate-group', createTeamGroup);
    expect(res.statusCode).toBe(502);
    expect(calls).toBe(1);
  });

  it('delegate-add-owner: adds OUR owners via a local bot; token/requestId/guard + idempotent', async () => {
    writeBots([{ larkAppId: 'cli_a', botOpenId: null, botName: 'A', cliId: 'claude' }]);
    setDeploymentOwner(dataDir, { unionId: 'on_ok', name: 'Me' }); // on_ok is OUR deployment owner
    addMembership(dataDir, { hubUrl: 'http://hub:7891', teamId: 'default', teamName: 'T', syncToken: 'st', deploymentId: 'dep_me', delegationToken: 'DTOK' });
    let calls = 0;
    const addOwners = vi.fn(async (_via: string, _chat: string, _ids: string[]) => { calls++; return { invalidUserIds: [] }; });
    const callAO = (req: any, res: any) => handleFederationApi(req, res, new URL('http://x/api/federation/delegate-add-owner'), { dataDir, addOwners });
    let res = makeRes();
    await callAO(makeReq('POST', '/api/federation/delegate-add-owner', { chatId: 'oc', viaLarkAppId: 'cli_a', ownerUnionIds: ['on_ok'], requestId: 'r' }, bearer('NOPE')), res);
    expect(res.statusCode).toBe(403); // unknown token
    res = makeRes();
    await callAO(makeReq('POST', '/api/federation/delegate-add-owner', { chatId: 'oc', viaLarkAppId: 'cli_a', ownerUnionIds: ['on_ok'] }, bearer('DTOK')), res);
    expect(json(res).error).toBe('request_id_required');
    res = makeRes();
    await callAO(makeReq('POST', '/api/federation/delegate-add-owner', { chatId: 'oc', viaLarkAppId: 'cli_nope', ownerUnionIds: ['on_ok'], requestId: 'r1' }, bearer('DTOK')), res);
    expect(json(res).error).toBe('not_a_local_bot');
    expect(calls).toBe(0);
    // success: our owner on_ok added
    res = makeRes();
    await callAO(makeReq('POST', '/api/federation/delegate-add-owner', { chatId: 'oc', viaLarkAppId: 'cli_a', ownerUnionIds: ['on_ok'], requestId: 'r2' }, bearer('DTOK')), res);
    expect(res.statusCode).toBe(200);
    expect(json(res).invalidUserIds).toEqual([]);
    // idempotent replay → addOwners not called again
    res = makeRes();
    await callAO(makeReq('POST', '/api/federation/delegate-add-owner', { chatId: 'oc', viaLarkAppId: 'cli_a', ownerUnionIds: ['on_ok'], requestId: 'r2' }, bearer('DTOK')), res);
    expect(json(res).invalidUserIds).toEqual([]);
    expect(calls).toBe(1);
  });

  it('delegate-add-owner: a NON-owner union_id is rejected without calling Lark (capability limit)', async () => {
    writeBots([{ larkAppId: 'cli_a', botOpenId: null, botName: 'A', cliId: 'claude' }]);
    setDeploymentOwner(dataDir, { unionId: 'on_me', name: 'Me' });
    setBotOwner(dataDir, 'cli_a', { unionId: 'on_me', name: 'Me' });
    addMembership(dataDir, { hubUrl: 'http://hub:7891', teamId: 'default', teamName: 'T', syncToken: 'st', deploymentId: 'dep_me', delegationToken: 'DTOK' });
    const addOwners = vi.fn(async (_via: string, _chat: string, ids: string[]) => ({ invalidUserIds: [] }));
    const res = makeRes();
    await handleFederationApi(makeReq('POST', '/api/federation/delegate-add-owner', { chatId: 'oc', viaLarkAppId: 'cli_a', ownerUnionIds: ['on_me', 'on_stranger'], requestId: 's1' }, bearer('DTOK')), res, new URL('http://x/api/federation/delegate-add-owner'), { dataDir, addOwners });
    expect(res.statusCode).toBe(200);
    expect(json(res).invalidUserIds).toContain('on_stranger'); // not our owner → invalid
    expect(addOwners).toHaveBeenCalledWith('cli_a', 'oc', ['on_me']); // only OUR owner reached Lark
  });

  it('federation/group: no local creator → delegate-build to A, then delegate-add-owner to B for Bs owner', async () => {
    registerDeployment(dataDir, DEFAULT_TEAM_ID, { deploymentId: 'dep_a', name: 'A', ownerUnionId: 'on_a', bots: [{ larkAppId: 'cli_a', botName: 'A1', cliId: 'codex', ownerUnionId: 'on_a' } as any], callbackUrl: 'http://a:7891', delegationToken: 'DTA' });
    registerDeployment(dataDir, DEFAULT_TEAM_ID, { deploymentId: 'dep_b', name: 'B', ownerUnionId: 'on_b', bots: [{ larkAppId: 'cli_b', botName: 'B1', cliId: 'codex', ownerUnionId: 'on_b' } as any], callbackUrl: 'http://b:7891', delegationToken: 'DTB' });
    const syncToken = (await import('../src/services/federation-store.js')).listFederatedDeployments(dataDir, DEFAULT_TEAM_ID).find(d => d.deploymentId === 'dep_a')!.syncToken;
    const createTeamGroup = vi.fn(async () => ({ ok: false, error: 'no_online_daemon' })); // hub has no local creator
    let addOwnerCall: any = null;
    const fetcher = vi.fn(async (u: any, init: any) => {
      const url = String(u);
      if (url === 'http://a:7891/api/federation/delegate-group') return { ok: true, status: 200, json: async () => ({ ok: true, chatId: 'oc_g', invalidOwnerUnionIds: ['on_b'] }) } as any; // A built, couldn't add B's owner
      if (url === 'http://b:7891/api/federation/delegate-add-owner') { addOwnerCall = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ ok: true, invalidUserIds: [] }) } as any; }
      return { ok: true, status: 200, json: async () => ({}) } as any;
    });
    const res = makeRes();
    await handleFederationApi(makeReq('POST', '/api/federation/group', { name: 'g', larkAppIds: ['cli_a', 'cli_b'], requestId: 'g2' }, bearer(syncToken)), res, new URL('http://x/api/federation/group'), { dataDir, createTeamGroup, fetcher: fetcher as any });
    expect(res.statusCode).toBe(200);
    expect(json(res).chatId).toBe('oc_g');
    expect(json(res).delegatedTo).toBe('A');
    expect(json(res).invalidOwnerUnionIds).toEqual([]); // on_b added via B after delegate-build
    expect(addOwnerCall).toMatchObject({ chatId: 'oc_g', viaLarkAppId: 'cli_b', ownerUnionIds: ['on_b'] });
  });

  it('federation/group: a remote owner the creator cant add is delegated to its own deployment', async () => {
    writeBots([{ larkAppId: 'cli_hub', botOpenId: null, botName: 'Hub', cliId: 'claude' }]);
    registerDeployment(dataDir, DEFAULT_TEAM_ID, { deploymentId: 'dep_spoke', name: 'Spoke', ownerUnionId: 'on_spoke', bots: [{ larkAppId: 'cli_sp', botName: 'SP', cliId: 'codex', ownerUnionId: 'on_spoke', ownerName: '博文' } as any], callbackUrl: 'http://spoke:7891', delegationToken: 'DT' });
    const syncToken = (await import('../src/services/federation-store.js')).listFederatedDeployments(dataDir, DEFAULT_TEAM_ID)[0].syncToken;
    // creator adds bots fine but can't add the remote owner on_spoke (Lark 232024)
    const createTeamGroup = vi.fn(async () => ({ ok: true, chatId: 'oc_g', invalidBotIds: [], invalidOwnerUnionIds: ['on_spoke'] }));
    let delegated: any = null;
    const fetcher = vi.fn(async (u: any, init: any) => {
      if (String(u).endsWith('/api/federation/delegate-add-owner')) { delegated = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ ok: true, invalidUserIds: [] }) } as any; }
      return { ok: true, status: 200, json: async () => ({}) } as any;
    });
    const res = makeRes();
    await handleFederationApi(makeReq('POST', '/api/federation/group', { name: 'g', larkAppIds: ['cli_hub', 'cli_sp'], requestId: 'g1' }, bearer(syncToken)), res, new URL('http://x/api/federation/group'), { dataDir, createTeamGroup, fetcher: fetcher as any });
    expect(res.statusCode).toBe(200);
    expect(json(res).chatId).toBe('oc_g');
    expect(json(res).invalidOwnerUnionIds).toEqual([]); // on_spoke delegated to dep_spoke → resolved
    expect(delegated).toMatchObject({ chatId: 'oc_g', viaLarkAppId: 'cli_sp', ownerUnionIds: ['on_spoke'] });
  });

  it('federation/group: a remote bot with unbound owner is skipped (owner-in-group policy)', async () => {
    writeBots([{ larkAppId: 'cli_hub', botOpenId: null, botName: 'Hub', cliId: 'claude' }]);
    registerDeployment(dataDir, DEFAULT_TEAM_ID, { deploymentId: 'dep_u', name: 'U', bots: [{ larkAppId: 'cli_sp', botName: 'SP', cliId: 'codex' } as any] }); // bot has no ownerUnionId
    const syncToken = (await import('../src/services/federation-store.js')).listFederatedDeployments(dataDir, DEFAULT_TEAM_ID)[0].syncToken;
    let captured: any = null;
    const createTeamGroup = vi.fn(async (a: any) => { captured = a; return { ok: true, chatId: 'oc_g', invalidBotIds: [], invalidOwnerUnionIds: [] }; });
    const res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/group', { name: 'g', larkAppIds: ['cli_hub', 'cli_sp'], requestId: 's1' }, bearer(syncToken)), res, '/api/federation/group', createTeamGroup);
    expect(res.statusCode).toBe(200);
    expect(captured.larkAppIds).toEqual(['cli_hub']);        // cli_sp (remote, unbound owner) skipped, not built into the group
    expect(json(res).skippedNoOwner).toEqual(['cli_sp']);
  });

  it('federation/group: all selected bots have no owner → all_bots_skipped_no_owner, no group', async () => {
    registerDeployment(dataDir, DEFAULT_TEAM_ID, { deploymentId: 'dep_u', name: 'U', bots: [{ larkAppId: 'cli_sp', botName: 'SP', cliId: 'codex' } as any] });
    const syncToken = (await import('../src/services/federation-store.js')).listFederatedDeployments(dataDir, DEFAULT_TEAM_ID)[0].syncToken;
    const createTeamGroup = vi.fn(async () => ({ ok: true, chatId: 'x' }));
    const res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/group', { larkAppIds: ['cli_sp'], requestId: 's2' }, bearer(syncToken)), res, '/api/federation/group', createTeamGroup);
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('all_bots_skipped_no_owner');
    expect(createTeamGroup).not.toHaveBeenCalled();
  });

  it('federation/group: token is header-only (rejects ?syncToken= and body token)', async () => {
    writeBots([{ larkAppId: 'cli_hub', botOpenId: null, botName: 'Hub', cliId: 'claude' }]);
    registerDeployment(dataDir, DEFAULT_TEAM_ID, { deploymentId: 'dep_s', name: 'S', ownerUnionId: 'on_s', bots: [{ larkAppId: 'cli_sp', botName: 'SP', cliId: 'codex' }] });
    const syncToken = (await import('../src/services/federation-store.js')).listFederatedDeployments(dataDir, DEFAULT_TEAM_ID)[0].syncToken;
    const createTeamGroup = vi.fn(async () => ({ ok: true, chatId: 'oc', invalidBotIds: [] }));
    // token in query string → NOT accepted (would leak into access logs)
    const qp = '/api/federation/group?syncToken=' + syncToken;
    let res = makeRes();
    await callWithGroup(makeReq('POST', qp, { larkAppIds: ['cli_hub'], requestId: 'q1' }), res, qp, createTeamGroup);
    expect(res.statusCode).toBe(403);
    // token in body → NOT accepted either
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/group', { syncToken, larkAppIds: ['cli_hub'], requestId: 'b1' }), res, '/api/federation/group', createTeamGroup);
    expect(res.statusCode).toBe(403);
    expect(createTeamGroup).not.toHaveBeenCalled();
  });

  it('federation/group: a FAILED terminal result is cached too (replay never re-orchestrates)', async () => {
    writeBots([{ larkAppId: 'cli_hub', botOpenId: null, botName: 'Hub', cliId: 'claude' }]);
    registerDeployment(dataDir, DEFAULT_TEAM_ID, { deploymentId: 'dep_s', name: 'S', ownerUnionId: 'on_s', bots: [] });
    const syncToken = (await import('../src/services/federation-store.js')).listFederatedDeployments(dataDir, DEFAULT_TEAM_ID)[0].syncToken;
    let calls = 0;
    const createTeamGroup = vi.fn(async () => { calls++; return { ok: false, error: 'group_create_proxy_failed' }; });
    let res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/group', { larkAppIds: ['cli_hub'], requestId: 'f1' }, bearer(syncToken)), res, '/api/federation/group', createTeamGroup);
    expect(res.statusCode).toBe(502);
    expect(json(res).error).toBe('group_create_proxy_failed');
    // replay same requestId → cached 502 returned verbatim, createTeamGroup NOT called again
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/federation/group', { larkAppIds: ['cli_hub'], requestId: 'f1' }, bearer(syncToken)), res, '/api/federation/group', createTeamGroup);
    expect(res.statusCode).toBe(502);
    expect(json(res).error).toBe('group_create_proxy_failed');
    expect(calls).toBe(1);
  });

  it('join requires inviteCode + deployment', async () => {
    let res = makeRes();
    await call(makeReq('POST', '/api/federation/join', { deployment: { deploymentId: 'd', name: 'n', bots: [] } }), res, '/api/federation/join');
    expect(json(res).error).toBe('code_required');
    res = makeRes();
    await call(makeReq('POST', '/api/federation/join', { inviteCode: 'x' }), res, '/api/federation/join');
    expect(json(res).error).toBe('deployment_required');
  });
});
