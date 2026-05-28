/**
 * Federation spoke endpoints (join-remote / remote-roster / leave-remote) with a
 * mock fetcher standing in for the hub.
 * Run: pnpm vitest run test/federation-spoke-api.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../src/config.js', () => ({ config: {
  session: { get dataDir() { return state.dataDir; } },
  dashboard: { externalHost: 'localhost', port: 7891 },
} }));

import { handleFederationSpokeApi, resolveOwnerCandidatesFromAllowedUsers } from '../src/dashboard/federation-spoke-api.js';
import { listMemberships, addMembership } from '../src/services/federation-membership-store.js';
import { getDeploymentIdentity } from '../src/services/deployment-identity.js';
import { consumeInvite } from '../src/services/invite-store.js';
import { DEFAULT_TEAM_ID } from '../src/services/team-store.js';
import { registerDeployment, listFederatedDeployments } from '../src/services/federation-store.js';
import { setBotOwner, getBotOwner } from '../src/services/bot-owner-store.js';
import { claimPairing } from '../src/services/pairing-store.js';

function url(p: string) { return new URL('http://x' + p); }

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-spoke-')); state.dataDir = dataDir; });

function writeBots(entries: any[]) { writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify(entries)); }
function makeReq(method: string, path: string, body?: unknown): any {
  const req: any = { method, url: path, headers: {} };
  req[Symbol.asyncIterator] = async function* () { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); };
  return req;
}
function makeRes(): any {
  const res: any = { statusCode: 0, _headers: {}, _body: '' };
  res.setHeader = (k: string, v: any) => { res._headers[k.toLowerCase()] = v; };
  res.writeHead = (s: number, h?: any) => { res.statusCode = s; if (h) Object.assign(res._headers, h); };
  res.end = (b?: string) => { res._body = b ?? ''; };
  return res;
}
const json = (res: any) => JSON.parse(res._body);
const jsonResp = (status: number, body: any) => ({ ok: status >= 200 && status < 300, status, json: async () => body } as any);

describe('handleFederationSpokeApi', () => {
  it('local: GET /api/team/local returns this deployment + own roster + suggested hub url', async () => {
    writeBots([{ larkAppId: 'cli_me1', botOpenId: null, botName: '我的Bot', cliId: 'claude' }]);
    const res = makeRes();
    const handled = await handleFederationSpokeApi(makeReq('GET', '/api/team/local'), res, new URL('http://x/api/team/local'), { dataDir });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const b = json(res);
    expect(b.deployment.deploymentId).toMatch(/^dep_/);
    expect(b.suggestedHubUrl).toBe('http://localhost:7891');
    expect(b.bots.map((x: any) => x.larkAppId)).toEqual(['cli_me1']);
    expect(b.bots[0].deployment.local).toBe(true);
  });

  it('local: POST /api/team/local-invite mints a usable invite for my default team', async () => {
    writeBots([]);
    const res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/local-invite'), res, new URL('http://x/api/team/local-invite'), { dataDir });
    expect(res.statusCode).toBe(200);
    const code = json(res).code;
    expect(code).toBeTruthy();
    // the minted code admits to the default team
    expect(consumeInvite(dataDir, code)).toEqual({ ok: true, teamId: DEFAULT_TEAM_ID });
  });

  it('local-bots: PUT capability/role on a LOCAL bot works; federated/unknown → not_a_local_bot', async () => {
    writeBots([{ larkAppId: 'cli_local', botOpenId: null, botName: '本地Bot', cliId: 'claude' }]);
    // capability on local bot
    let res = makeRes();
    await handleFederationSpokeApi(makeReq('PUT', '/api/team/local-bots/cli_local/capability', { capability: '排障' }), res, new URL('http://x/api/team/local-bots/cli_local/capability'), { dataDir });
    expect(res.statusCode).toBe(200);
    // reflected in local roster
    res = makeRes();
    await handleFederationSpokeApi(makeReq('GET', '/api/team/local'), res, new URL('http://x/api/team/local'), { dataDir });
    expect(json(res).bots.find((b: any) => b.larkAppId === 'cli_local').capability).toBe('排障');
    // role round-trips
    await handleFederationSpokeApi(makeReq('PUT', '/api/team/local-bots/cli_local/role', { role: '# 后端\n严谨' }), makeRes(), new URL('http://x/api/team/local-bots/cli_local/role'), { dataDir });
    res = makeRes();
    await handleFederationSpokeApi(makeReq('GET', '/api/team/local-bots/cli_local/role'), res, new URL('http://x/api/team/local-bots/cli_local/role'), { dataDir });
    expect(json(res).role).toContain('后端');
    // a non-local (unknown / federated) bot can't be edited here
    res = makeRes();
    await handleFederationSpokeApi(makeReq('PUT', '/api/team/local-bots/cli_remote/capability', { capability: 'x' }), res, new URL('http://x/api/team/local-bots/cli_remote/capability'), { dataDir });
    expect(res.statusCode).toBe(404);
    expect(json(res).error).toBe('not_a_local_bot');
  });

  it('identity: bind via /pair sets deployment owner + owns local bots (no-steal)', async () => {
    writeBots([
      { larkAppId: 'cli_mine', botOpenId: null, botName: '我的', cliId: 'claude' },
      { larkAppId: 'cli_owned', botOpenId: null, botName: '已归属', cliId: 'codex' },
    ]);
    setBotOwner(dataDir, 'cli_owned', { unionId: 'on_existing', name: '别人' }); // pre-owned
    // start → get code → simulate owner /pair → consume
    let res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/identity/start'), res, url('/api/team/identity/start'), { dataDir });
    const { pairingId, code, browserToken } = json(res);
    claimPairing(dataDir, code, { openId: 'ou_me', unionId: 'on_me', name: '申晗', larkAppId: 'cli_mine' });
    res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/identity/consume', { pairingId, browserToken }), res, url('/api/team/identity/consume'), { dataDir });
    expect(res.statusCode).toBe(200);
    expect(json(res).owner).toMatchObject({ unionId: 'on_me', name: '申晗' });
    // deployment owner bound
    expect(getDeploymentIdentity(dataDir).ownerUnionId).toBe('on_me');
    // unassigned bot now owned by me; pre-owned bot NOT stolen
    expect(getBotOwner(dataDir, 'cli_mine')!.unionId).toBe('on_me');
    expect(getBotOwner(dataDir, 'cli_owned')!.unionId).toBe('on_existing');
  });

  it('identity: binding owner immediately pushes ownerUnionId to already-joined hubs (#3 fix)', async () => {
    writeBots([{ larkAppId: 'cli_mine', botOpenId: null, botName: '我的', cliId: 'claude' }]);
    // joined a remote team BEFORE binding identity → hub has no ownerUnionId yet
    addMembership(dataDir, { hubUrl: 'http://hub:7891', teamId: 'default', teamName: 'T', syncToken: 'STOK', deploymentId: 'dep_me' });
    let synced: any = null;
    const fetcher = vi.fn(async (u: any, init: any) => {
      if (String(u).endsWith('/api/federation/sync')) synced = JSON.parse(init.body);
      return jsonResp(200, { ok: true });
    });
    let res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/identity/start'), res, url('/api/team/identity/start'), { dataDir });
    const s = json(res);
    claimPairing(dataDir, s.code, { openId: 'ou_me', unionId: 'on_me', name: '申晗', larkAppId: 'cli_mine' });
    res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/identity/consume', { pairingId: s.pairingId, browserToken: s.browserToken }), res, url('/api/team/identity/consume'), { dataDir, fetcher: fetcher as any });
    expect(res.statusCode).toBe(200);
    expect(json(res).hubsSynced).toBe(1);
    expect(synced).toMatchObject({ syncToken: 'STOK', ownerUnionId: 'on_me' }); // hub gets owner NOW, not 2 min later
  });

  it('resolveOwnerCandidatesFromAllowedUsers (default resolver): ensures a client, skips empty/failing bots, dedups', async () => {
    const ensured: string[] = [];
    const cands = await resolveOwnerCandidatesFromAllowedUsers({
      configs: () => ([
        { larkAppId: 'cli_empty', larkAppSecret: 's', allowedUsers: [] },
        { larkAppId: 'cli_a', larkAppSecret: 's', allowedUsers: ['a@x.com'] },          // resolves to nothing → try next
        { larkAppId: 'cli_b', larkAppSecret: 's', allowedUsers: ['b@x.com', 'b2@x.com'] },
      ] as any),
      ensureClient: (cfg) => { ensured.push(cfg.larkAppId); }, // dashboard registers on demand (the blocker Codex caught)
      resolveAllowed: async (id) => (id === 'cli_a' ? [] : ['ou_1', 'ou_1', 'ou_2']),
      resolveUnion: async (_id, oid) => (oid === 'ou_1' ? { unionId: 'on_1', name: '甲' } : { unionId: 'on_2', name: '乙' }),
    });
    expect(ensured).toEqual(['cli_a', 'cli_b']);   // skipped the empty bot; ensured a client for each candidate bot
    expect(cands).toEqual([{ unionId: 'on_1', name: '甲' }, { unionId: 'on_2', name: '乙' }]); // ou_1 deduped
  });

  it('identity/auto-bind: single candidate binds owner + owns bots (no /pair) + pushes to hub', async () => {
    writeBots([{ larkAppId: 'cli_a', botOpenId: null, botName: 'A', cliId: 'claude' }]);
    addMembership(dataDir, { hubUrl: 'http://hub:7891', teamId: 'default', teamName: 'T', syncToken: 'STOK', deploymentId: 'dep_me' });
    let synced: any = null;
    const fetcher = vi.fn(async (u: any, init: any) => { if (String(u).endsWith('/api/federation/sync')) synced = JSON.parse(init.body); return jsonResp(200, { ok: true }); });
    const res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/identity/auto-bind', {}), res, url('/api/team/identity/auto-bind'),
      { dataDir, fetcher: fetcher as any, ownerCandidates: async () => [{ unionId: 'on_me', name: '申晗' }] });
    expect(res.statusCode).toBe(200);
    expect(json(res).owner).toMatchObject({ unionId: 'on_me', name: '申晗' });
    expect(getDeploymentIdentity(dataDir).ownerUnionId).toBe('on_me'); // bound, no /pair
    expect(getBotOwner(dataDir, 'cli_a')!.unionId).toBe('on_me');       // owns local bot
    expect(synced).toMatchObject({ ownerUnionId: 'on_me' });            // pushed to hub
  });

  it('identity/auto-bind: multiple candidates → needChoice, then bind the chosen one', async () => {
    writeBots([{ larkAppId: 'cli_a', botOpenId: null, botName: 'A', cliId: 'claude' }]);
    const cands = async () => [{ unionId: 'on_1', name: '甲' }, { unionId: 'on_2', name: '乙' }];
    let res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/identity/auto-bind', {}), res, url('/api/team/identity/auto-bind'), { dataDir, ownerCandidates: cands });
    expect(json(res).needChoice).toBe(true);
    expect(json(res).candidates.length).toBe(2);
    expect(getDeploymentIdentity(dataDir).ownerUnionId).toBeUndefined(); // not bound yet
    res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/identity/auto-bind', { unionId: 'on_2' }), res, url('/api/team/identity/auto-bind'), { dataDir, ownerCandidates: cands });
    expect(json(res).owner).toMatchObject({ unionId: 'on_2', name: '乙' });
    expect(getDeploymentIdentity(dataDir).ownerUnionId).toBe('on_2');
  });

  it('identity/auto-bind: no candidates → ok:false no_candidates', async () => {
    const res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/identity/auto-bind', {}), res, url('/api/team/identity/auto-bind'), { dataDir, ownerCandidates: async () => [] });
    expect(json(res).ok).toBe(false);
    expect(json(res).error).toBe('no_candidates');
  });

  it('remote-group: pushes owner+bots to the hub BEFORE initiating the group (fresh operator)', async () => {
    writeBots([{ larkAppId: 'cli_a', botOpenId: null, botName: 'A', cliId: 'claude' }]);
    addMembership(dataDir, { hubUrl: 'http://hub:7891', teamId: 'default', teamName: 'T', syncToken: 'STOK', deploymentId: 'dep_me' });
    const calls: string[] = [];
    const fetcher = vi.fn(async (u: any) => { calls.push(String(u)); return jsonResp(200, { ok: true, chatId: 'oc' }); });
    const res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/remote-group', { hubUrl: 'http://hub:7891', teamId: 'default', name: 'g', larkAppIds: ['cli_a'] }), res, url('/api/team/remote-group'), { dataDir, fetcher: fetcher as any });
    const iSync = calls.findIndex(u => u.endsWith('/api/federation/sync'));
    const iGroup = calls.findIndex(u => u.endsWith('/api/federation/group'));
    expect(iSync).toBeGreaterThanOrEqual(0);
    expect(iGroup).toBeGreaterThan(iSync); // sync strictly before group
  });

  it('hosted teams: list has default; create adds (roster includes my bots); delete removes; default protected', async () => {
    writeBots([{ larkAppId: 'cli_a', botOpenId: null, botName: 'A', cliId: 'claude' }]);
    let res = makeRes();
    await handleFederationSpokeApi(makeReq('GET', '/api/team/hosted'), res, url('/api/team/hosted'), { dataDir });
    expect(json(res).ok).toBe(true);
    expect(json(res).teams.some((t: any) => t.isDefault)).toBe(true);
    // create
    res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/hosted', { name: '排障组' }), res, url('/api/team/hosted'), { dataDir });
    const tid = json(res).teamId; expect(json(res).ok).toBe(true);
    // appears in list + its roster includes my local bot
    res = makeRes();
    await handleFederationSpokeApi(makeReq('GET', '/api/team/hosted'), res, url('/api/team/hosted'), { dataDir });
    const created = json(res).teams.find((t: any) => t.teamId === tid);
    expect(created?.name).toBe('排障组');
    expect(created.bots.some((b: any) => b.larkAppId === 'cli_a')).toBe(true);
    // default delete refused
    res = makeRes();
    await handleFederationSpokeApi(makeReq('DELETE', '/api/team/hosted/default'), res, url('/api/team/hosted/default'), { dataDir });
    expect(json(res).error).toBe('cannot_delete_default');
    // delete created → gone
    res = makeRes();
    await handleFederationSpokeApi(makeReq('DELETE', '/api/team/hosted/' + tid), res, url('/api/team/hosted/' + tid), { dataDir });
    expect(json(res).ok).toBe(true);
    res = makeRes();
    await handleFederationSpokeApi(makeReq('GET', '/api/team/hosted'), res, url('/api/team/hosted'), { dataDir });
    expect(json(res).teams.some((t: any) => t.teamId === tid)).toBe(false);
  });

  it('federated-group: a deleted/unknown teamId is refused (no fallback to default team)', async () => {
    writeBots([{ larkAppId: 'cli_a', botOpenId: null, botName: 'A', cliId: 'claude' }]);
    // create then delete a team
    let res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/hosted', { name: 'Temp' }), res, url('/api/team/hosted'), { dataDir });
    const tid = json(res).teamId;
    res = makeRes();
    await handleFederationSpokeApi(makeReq('DELETE', '/api/team/hosted/' + tid), res, url('/api/team/hosted/' + tid), { dataDir });
    // 拉群 with the deleted teamId → 404, createTeamGroup NOT called
    const createTeamGroup = vi.fn(async () => ({ ok: true, chatId: 'oc', invalidBotIds: [] }));
    res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/federated-group', { name: 'g', larkAppIds: ['cli_a'], teamId: tid }), res, url('/api/team/federated-group'), { dataDir, createTeamGroup: createTeamGroup as any });
    expect(res.statusCode).toBe(404);
    expect(json(res).error).toBe('team_not_found');
    expect(createTeamGroup).not.toHaveBeenCalled();
  });

  it('federated-group: requires a selected local online bot (operator guarantee)', async () => {
    writeBots([{ larkAppId: 'cli_a', botOpenId: null, botName: 'A', cliId: 'claude' }]);
    registerDeployment(dataDir, 'default', { deploymentId: 'dep_r', name: 'R', bots: [{ larkAppId: 'cli_remote', botName: 'R', cliId: 'codex', ownerUnionId: 'on_r' } as any] });
    const createTeamGroup = vi.fn(async () => ({ ok: true, chatId: 'oc', invalidBotIds: [] }));
    // this deployment HAS an online bot (cli_a) but the user selected only the
    // remote bot → refused (operator couldn't be added by a remote creator)
    let res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/federated-group', { name: 'g', larkAppIds: ['cli_remote'] }), res, url('/api/team/federated-group'), { dataDir, createTeamGroup: createTeamGroup as any, liveBots: () => [{ larkAppId: 'cli_a', botName: 'A', cliId: 'claude' } as any] });
    expect(json(res).error).toBe('no_local_online_bot');
    expect(createTeamGroup).not.toHaveBeenCalled();
    // a local online bot in the selection → proceeds
    res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/federated-group', { name: 'g', larkAppIds: ['cli_a', 'cli_remote'] }), res, url('/api/team/federated-group'), { dataDir, createTeamGroup: createTeamGroup as any, liveBots: () => [{ larkAppId: 'cli_a', botName: 'A', cliId: 'claude' } as any] });
    expect(createTeamGroup).toHaveBeenCalled();
  });

  it('hosted member remove: hub kicks a joined deployment; cannot remove self; unknown → 404', async () => {
    writeBots([{ larkAppId: 'cli_a', botOpenId: null, botName: 'A', cliId: 'claude' }]);
    registerDeployment(dataDir, 'default', { deploymentId: 'dep_spoke', name: 'S', bots: [{ larkAppId: 'cli_sp', botName: 'SP', cliId: 'codex' }] });
    // remove the joined member → gone
    let res = makeRes();
    await handleFederationSpokeApi(makeReq('DELETE', '/api/team/hosted/default/members/dep_spoke'), res, url('/api/team/hosted/default/members/dep_spoke'), { dataDir });
    expect(json(res).ok).toBe(true);
    expect(listFederatedDeployments(dataDir, 'default').some(d => d.deploymentId === 'dep_spoke')).toBe(false);
    // removing self (this deployment) → refused
    const me = getDeploymentIdentity(dataDir).deploymentId;
    res = makeRes();
    await handleFederationSpokeApi(makeReq('DELETE', '/api/team/hosted/default/members/' + me), res, url('/api/team/hosted/default/members/' + me), { dataDir });
    expect(json(res).error).toBe('cannot_remove_self');
    // unknown member → 404
    res = makeRes();
    await handleFederationSpokeApi(makeReq('DELETE', '/api/team/hosted/default/members/dep_nope'), res, url('/api/team/hosted/default/members/dep_nope'), { dataDir });
    expect(res.statusCode).toBe(404);
    expect(json(res).error).toBe('member_not_found');
  });

  it('local-invite accepts a teamId; unknown team → 404', async () => {
    let res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/hosted', { name: 'X' }), res, url('/api/team/hosted'), { dataDir });
    const tid = json(res).teamId;
    res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/local-invite', { teamId: tid }), res, url('/api/team/local-invite'), { dataDir });
    expect(json(res).ok).toBe(true); expect(json(res).teamId).toBe(tid); expect(typeof json(res).code).toBe('string');
    res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/local-invite', { teamId: 'nope' }), res, url('/api/team/local-invite'), { dataDir });
    expect(json(res).error).toBe('team_not_found');
  });

  it('federated-group: includes the bound operator (this deployment owner) in invitees', async () => {
    writeBots([{ larkAppId: 'cli_local', botOpenId: null, botName: '本地', cliId: 'claude' }]);
    // bind owner
    let res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/identity/start'), res, url('/api/team/identity/start'), { dataDir });
    const s = json(res);
    claimPairing(dataDir, s.code, { openId: 'ou_op', unionId: 'on_operator', name: 'Op', larkAppId: 'cli_local' });
    await handleFederationSpokeApi(makeReq('POST', '/api/team/identity/consume', { pairingId: s.pairingId, browserToken: s.browserToken }), makeRes(), url('/api/team/identity/consume'), { dataDir });
    // federated-group → operator union_id in ownerUnionIds
    let captured: any = null;
    const createTeamGroup = vi.fn(async (a: any) => { captured = a; return { ok: true, chatId: 'oc', invalidBotIds: [] }; });
    res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/federated-group', { name: 'g', larkAppIds: ['cli_local'] }), res, url('/api/team/federated-group'), { dataDir, createTeamGroup: createTeamGroup as any });
    expect(res.statusCode).toBe(200);
    expect(captured.ownerUnionIds).toContain('on_operator'); // operator pulled in
    expect(json(res).missingOperatorIdentity).toBeFalsy();
  });

  it('remote-group: forwards to hub /api/federation/group with Bearer + requestId', async () => {
    writeBots([]);
    // join a hub (mock)
    const joinFetcher = vi.fn(async () => jsonResp(200, { ok: true, teamId: 'default', teamName: 'T', syncToken: 'TOK' }));
    await handleFederationSpokeApi(makeReq('POST', '/api/team/join-remote', { hubUrl: 'http://hub:7891', inviteCode: 'INV' }), makeRes(), url('/api/team/join-remote'), { dataDir, fetcher: joinFetcher as any });
    // remote-group → hub /api/federation/group
    let captured: any = null;
    const grpFetcher = vi.fn(async (u: any, init: any) => { captured = { url: String(u), body: JSON.parse(init.body), auth: init.headers.authorization }; return jsonResp(200, { ok: true, chatId: 'oc_r' }); });
    const res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/remote-group', { hubUrl: 'http://hub:7891', teamId: 'default', name: 'x', larkAppIds: ['cli_a'] }), res, url('/api/team/remote-group'), { dataDir, fetcher: grpFetcher as any });
    expect(res.statusCode).toBe(200);
    expect(captured.url).toBe('http://hub:7891/api/federation/group');
    expect(captured.auth).toBe('Bearer TOK');
    expect(captured.body.requestId).toBeTruthy();
    expect(captured.body.larkAppIds).toEqual(['cli_a']);
  });

  it('local: POST /api/team/rename-deployment changes the name (id stable)', async () => {
    writeBots([]);
    const before = getDeploymentIdentity(dataDir);
    const res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/rename-deployment', { name: '申晗的部署' }), res, new URL('http://x/api/team/rename-deployment'), { dataDir });
    expect(res.statusCode).toBe(200);
    expect(json(res).deployment).toMatchObject({ deploymentId: before.deploymentId, name: '申晗的部署' });
  });

  it('federated-group: validates roster, delegates local+federated app_ids + pulls owners (union_id) into createTeamGroup', async () => {
    writeBots([{ larkAppId: 'cli_local', botOpenId: null, botName: '本地Bot', cliId: 'claude' }]);
    setBotOwner(dataDir, 'cli_local', { unionId: 'on_local', name: '我' }); // local bot owner
    // federated bot carries its owner's union_id
    registerDeployment(dataDir, DEFAULT_TEAM_ID, { deploymentId: 'dep_r', name: '远端', bots: [{ larkAppId: 'cli_remote', botName: '远端Bot', cliId: 'codex', ownerUnionId: 'on_remote', ownerName: '同事' }] });
    let captured: any = null;
    const createTeamGroup = vi.fn(async (args: any) => { captured = args; return { ok: true, chatId: 'oc_x', shareLink: 'https://x/join', invalidBotIds: [] }; });
    const url = new URL('http://x/api/team/federated-group');
    // valid local + federated selection → delegated, with both owners pulled in
    let res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/federated-group', { name: '排障', larkAppIds: ['cli_local', 'cli_remote'] }), res, url, { dataDir, createTeamGroup: createTeamGroup as any });
    expect(res.statusCode).toBe(200);
    expect(json(res).chatId).toBe('oc_x');
    expect(captured.larkAppIds.sort()).toEqual(['cli_local', 'cli_remote']);
    expect(captured.ownerUnionIds.sort()).toEqual(['on_local', 'on_remote']); // both bots' owners pulled in
    // unknown bot (not on aggregated roster) → 400, never delegated
    res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/federated-group', { larkAppIds: ['cli_ghost'] }), res, url, { dataDir, createTeamGroup: createTeamGroup as any });
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('unknown_bot');
    // empty selection → 400
    res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/federated-group', { larkAppIds: [] }), res, url, { dataDir, createTeamGroup: createTeamGroup as any });
    expect(json(res).error).toBe('no_bots_selected');
    // no creator dep → 501
    res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/federated-group', { larkAppIds: ['cli_local'] }), res, url, { dataDir });
    expect(res.statusCode).toBe(501);
  });

  it('federated-group: no local creator → delegates to a capable spoke (hub→spoke)', async () => {
    writeBots([{ larkAppId: 'cli_local', botOpenId: null, botName: '本地', cliId: 'claude' }]);
    // a federated deployment that owns cli_remote + is reachable for delegation
    registerDeployment(dataDir, DEFAULT_TEAM_ID, {
      deploymentId: 'dep_r', name: '远端', bots: [{ larkAppId: 'cli_remote', botName: '远端Bot', cliId: 'codex', ownerUnionId: 'on_r' } as any],
      callbackUrl: 'http://spoke:7891', delegationToken: 'DTOK',
    });
    // local create has no online bot
    const createTeamGroup = vi.fn(async () => ({ ok: false, error: 'no_online_daemon' }));
    // hub→spoke delegate call succeeds
    const fetcher = vi.fn(async (u: any, init: any) => {
      expect(String(u)).toBe('http://spoke:7891/api/federation/delegate-group');
      expect(init.headers.authorization).toBe('Bearer DTOK');
      expect(JSON.parse(init.body).larkAppIds).toEqual(['cli_local', 'cli_remote']);
      return jsonResp(200, { ok: true, chatId: 'oc_byspoke', shareLink: 'https://x', invalidBotIds: [] });
    });
    const res = makeRes();
    await handleFederationSpokeApi(
      makeReq('POST', '/api/team/federated-group', { name: 'x', larkAppIds: ['cli_local', 'cli_remote'] }),
      res, new URL('http://x/api/team/federated-group'), { dataDir, createTeamGroup: createTeamGroup as any, fetcher: fetcher as any },
    );
    expect(res.statusCode).toBe(200);
    expect(json(res).chatId).toBe('oc_byspoke');
    expect(json(res).delegatedTo).toBe('远端');
    expect(fetcher).toHaveBeenCalled();
  });

  it('federated-group: delegate timeout → stops (no duplicate group), does not try next deployment', async () => {
    writeBots([{ larkAppId: 'cli_local', botOpenId: null, botName: '本地', cliId: 'claude' }]);
    registerDeployment(dataDir, DEFAULT_TEAM_ID, { deploymentId: 'dep_a', name: 'A', bots: [{ larkAppId: 'cli_remote', botName: 'R', cliId: 'codex', ownerUnionId: 'on_r' } as any], callbackUrl: 'http://a:7891', delegationToken: 'TA' });
    registerDeployment(dataDir, DEFAULT_TEAM_ID, { deploymentId: 'dep_b', name: 'B', bots: [{ larkAppId: 'cli_remote', botName: 'R', cliId: 'codex', ownerUnionId: 'on_r' } as any], callbackUrl: 'http://b:7891', delegationToken: 'TB' });
    const createTeamGroup = vi.fn(async () => ({ ok: false, error: 'no_online_daemon' }));
    // first delegate call times out — must NOT fall through to the second deployment
    const fetcher = vi.fn(async () => { const e: any = new Error('aborted'); e.name = 'AbortError'; throw e; });
    const res = makeRes();
    await handleFederationSpokeApi(
      makeReq('POST', '/api/team/federated-group', { name: 'x', larkAppIds: ['cli_local', 'cli_remote'] }),
      res, new URL('http://x/api/team/federated-group'), { dataDir, createTeamGroup: createTeamGroup as any, fetcher: fetcher as any },
    );
    expect(res.statusCode).toBe(504);
    expect(json(res).error).toBe('delegation_timeout');
    expect(fetcher).toHaveBeenCalledTimes(1); // stopped after timeout, did not try dep_b
  });

  it('join-remote: posts local bots to the hub and stores the membership', async () => {
    writeBots([{ larkAppId: 'cli_me1', botOpenId: null, botName: '我的Bot', cliId: 'claude' }]);
    let captured: any = null;
    const fetcher = vi.fn(async (u: any, init: any) => {
      captured = { url: String(u), body: JSON.parse(init.body) };
      return jsonResp(200, { ok: true, teamId: 'default', teamName: '研发团队', syncToken: 'TOK123' });
    });
    const res = makeRes();
    const handled = await handleFederationSpokeApi(
      makeReq('POST', '/api/team/join-remote', { hubUrl: 'http://hub:7891/', inviteCode: 'INV' }),
      res, new URL('http://x/api/team/join-remote'), { dataDir, fetcher: fetcher as any },
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    // called the hub join endpoint with our deployment + bots
    expect(captured.url).toBe('http://hub:7891/api/federation/join'); // trailing slash normalized
    expect(captured.body.inviteCode).toBe('INV');
    expect(captured.body.deployment.bots.map((b: any) => b.larkAppId)).toEqual(['cli_me1']);
    expect(captured.body.deployment.deploymentId).toMatch(/^dep_/);
    // membership stored
    const ms = listMemberships(dataDir);
    expect(ms.length).toBe(1);
    expect(ms[0]).toMatchObject({ hubUrl: 'http://hub:7891', teamId: 'default', teamName: '研发团队', syncToken: 'TOK123' });
  });

  it('join-remote: surfaces hub rejection (403 invite) without storing membership', async () => {
    writeBots([]);
    const fetcher = vi.fn(async () => jsonResp(403, { ok: false, error: 'invite_used' }));
    const res = makeRes();
    await handleFederationSpokeApi(
      makeReq('POST', '/api/team/join-remote', { hubUrl: 'http://hub:7891', inviteCode: 'INV' }),
      res, new URL('http://x/api/team/join-remote'), { dataDir, fetcher: fetcher as any },
    );
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toBe('invite_used');
    expect(listMemberships(dataDir).length).toBe(0);
  });

  it('join-remote: hub unreachable → 502 hub_unreachable', async () => {
    writeBots([]);
    const fetcher = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const res = makeRes();
    await handleFederationSpokeApi(
      makeReq('POST', '/api/team/join-remote', { hubUrl: 'http://hub:7891', inviteCode: 'INV' }),
      res, new URL('http://x/api/team/join-remote'), { dataDir, fetcher: fetcher as any },
    );
    expect(res.statusCode).toBe(502);
    expect(json(res).error).toBe('hub_unreachable');
  });

  it('join-remote: rejects bad hub url and missing code', async () => {
    let res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/join-remote', { hubUrl: 'ftp://x', inviteCode: 'a' }), res, new URL('http://x/api/team/join-remote'), { dataDir, fetcher: (async () => jsonResp(200, {})) as any });
    expect(json(res).error).toBe('bad_hub_url');
    res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/join-remote', { hubUrl: 'http://h:1' }), res, new URL('http://x/api/team/join-remote'), { dataDir, fetcher: (async () => jsonResp(200, {})) as any });
    expect(json(res).error).toBe('code_required');
  });

  it('join-remote: hub timeout → 504 hub_timeout', async () => {
    writeBots([]);
    const timeoutFetcher = vi.fn(async () => { const e: any = new Error('aborted'); e.name = 'AbortError'; throw e; });
    const res = makeRes();
    await handleFederationSpokeApi(
      makeReq('POST', '/api/team/join-remote', { hubUrl: 'http://hub:7891', inviteCode: 'INV' }),
      res, new URL('http://x/api/team/join-remote'), { dataDir, fetcher: timeoutFetcher as any },
    );
    expect(res.statusCode).toBe(504);
    expect(json(res).error).toBe('hub_timeout');
  });

  it('remote-roster: sends token in header (not URL); leave-remote revokes at hub + forgets locally', async () => {
    writeBots([]);
    // join one hub
    const joinFetcher = vi.fn(async () => jsonResp(200, { ok: true, teamId: 'default', teamName: 'T', syncToken: 'TOK' }));
    await handleFederationSpokeApi(makeReq('POST', '/api/team/join-remote', { hubUrl: 'http://hub:7891', inviteCode: 'INV' }), makeRes(), new URL('http://x/api/team/join-remote'), { dataDir, fetcher: joinFetcher as any });

    // remote-roster pulls the hub roster — token in Authorization header, NOT the URL
    const rosterFetcher = vi.fn(async (u: any, init: any) => {
      expect(String(u)).toBe('http://hub:7891/api/federation/roster'); // no ?syncToken=
      expect(init.headers.authorization).toBe('Bearer TOK');
      return jsonResp(200, { ok: true, team: { id: 'default', name: 'T', memberCount: 1 }, deployments: [], bots: [{ larkAppId: 'cli_x', name: 'X' }] });
    });
    let res = makeRes();
    await handleFederationSpokeApi(makeReq('GET', '/api/team/remote-roster'), res, new URL('http://x/api/team/remote-roster'), { dataDir, fetcher: rosterFetcher as any });
    expect(res.statusCode).toBe(200);
    expect(json(res).memberships[0].roster.bots[0].larkAppId).toBe('cli_x');

    // leave-remote calls the hub's /leave (with the token) then forgets locally
    const leaveFetcher = vi.fn(async (u: any, init: any) => {
      expect(String(u)).toBe('http://hub:7891/api/federation/leave');
      expect(init.headers.authorization).toBe('Bearer TOK');
      return jsonResp(200, { ok: true });
    });
    res = makeRes();
    await handleFederationSpokeApi(makeReq('POST', '/api/team/leave-remote', { hubUrl: 'http://hub:7891', teamId: 'default' }), res, new URL('http://x/api/team/leave-remote'), { dataDir, fetcher: leaveFetcher as any });
    expect(res.statusCode).toBe(200);
    expect(json(res).hubRevoked).toBe(true);
    expect(leaveFetcher).toHaveBeenCalled();
    expect(listMemberships(dataDir).length).toBe(0);
  });
});
