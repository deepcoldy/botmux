/**
 * Team platform routes: pairing-login flow + authenticated roster, via mock
 * req/res. Underlying stores/handlers are unit-tested separately; this guards
 * the routing + cookie + auth-gate glue.
 * Run: pnpm vitest run test/team-routes.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Make config.session.dataDir track the per-test temp dir, so the connector
// write delegation (handleConnectorApi uses config-default dataDir) and the
// team-routes desensitized GET (uses deps.dataDir) share one store. Covers the
// production "same dataDir" path Codex called out.
const state = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../src/config.js', () => ({
  config: {
    session: { get dataDir() { return state.dataDir; } },
    web: { externalHost: 'localhost' },
    dashboard: { externalHost: 'localhost', port: 7891 },
  },
}));

import { handleTeamRoute } from '../src/dashboard/team-routes.js';
import { claimPairing } from '../src/services/pairing-store.js';
import { removeMember, DEFAULT_TEAM_ID, createTeam, deleteTeam } from '../src/services/team-store.js';
import { createInvite } from '../src/services/invite-store.js';

let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-teamroutes-')); state.dataDir = dataDir; });

function makeReq(method: string, path: string, opts: { cookie?: string; body?: unknown } = {}): any {
  const req: any = { method, url: path, headers: { cookie: opts.cookie } };
  req[Symbol.asyncIterator] = async function* () {
    if (opts.body !== undefined) yield Buffer.from(JSON.stringify(opts.body));
  };
  return req;
}
function makeRes(): any {
  const res: any = { statusCode: 0, _headers: {} as Record<string, any>, _body: '' };
  res.setHeader = (k: string, v: any) => { res._headers[k.toLowerCase()] = v; };
  res.getHeader = (k: string) => res._headers[k.toLowerCase()];
  res.writeHead = (s: number, h?: Record<string, any>) => {
    res.statusCode = s;
    if (h) for (const [k, v] of Object.entries(h)) res._headers[k.toLowerCase()] = v;
  };
  res.end = (b?: string) => { res._body = b ?? ''; };
  return res;
}
const call = (req: any, res: any, path: string) => handleTeamRoute(req, res, new URL('http://x' + path), { dataDir });
// Variant that injects a fake createTeamGroup (daemon proxy is dashboard-side).
const callWithGroup = (req: any, res: any, path: string, createTeamGroup: any) =>
  handleTeamRoute(req, res, new URL('http://x' + path), { dataDir, createTeamGroup });
const json = (res: any) => JSON.parse(res._body);
function cookieValue(res: any, name: string): string {
  const sc = res._headers['set-cookie'];
  const arr = Array.isArray(sc) ? sc : [sc];
  const hit = arr.find((c: string) => c?.startsWith(`${name}=`))!;
  return decodeURIComponent(hit.slice(name.length + 1, hit.indexOf(';')));
}

describe('handleTeamRoute', () => {
  it('returns false for unrelated paths', async () => {
    expect(await call(makeReq('GET', '/api/sessions'), makeRes(), '/api/sessions')).toBe(false);
  });

  it('full login flow: start → claim → consume → authed roster', async () => {
    writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'cli_a', botOpenId: 'ou_a', botName: '后端Bot', cliId: 'codex' },
    ]));

    // start
    let res = makeRes();
    expect(await call(makeReq('POST', '/api/pairing/start'), res, '/api/pairing/start')).toBe(true);
    const { pairingId, code } = json(res);
    const browserToken = cookieValue(res, 'bmx_pair');

    // user sends the code to the bot → daemon claims
    claimPairing(dataDir, code, { openId: 'ou_1', unionId: 'on_1', name: '张三' });

    // consume (first login bootstraps the team) → session cookie
    res = makeRes();
    await call(makeReq('POST', '/api/pairing/consume', { cookie: `bmx_pair=${browserToken}`, body: { pairingId } }), res, '/api/pairing/consume');
    expect(res.statusCode).toBe(200);
    const session = cookieValue(res, 'bmx_session');
    expect(session.length).toBeGreaterThan(20);

    // authed roster
    res = makeRes();
    await call(makeReq('GET', '/api/team/roster', { cookie: `bmx_session=${session}` }), res, '/api/team/roster');
    expect(res.statusCode).toBe(200);
    const roster = json(res);
    expect(roster.bots.map((b: any) => b.name)).toEqual(['后端Bot']);
    expect(roster.team.memberCount).toBe(1);
  });

  it('serves the team SPA page at GET /team (public)', async () => {
    const res = makeRes();
    expect(await call(makeReq('GET', '/team'), res, '/team')).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res._headers['content-type']).toContain('text/html');
    expect(res._body).toContain('botmux 团队平台');
    // Regression: overlays use class="overlay hide"; .overlay sets display:flex,
    // so a compound .overlay.hide rule must exist or modals show on load + won't close.
    expect(res._body).toContain('.overlay.hide { display: none; }');
    // Roster filter bar (① organization): search + CLI filter + selection count.
    expect(res._body).toContain('id="rf-search"');
    expect(res._body).toContain('id="rf-cli"');
    expect(res._body).toContain('已选');
    // mentionable is per-chat, not on the team roster schema — the "仅可点名"
    // filter was removed so it can't empty the list. Guard it stays gone.
    expect(res._body).not.toContain('rf-ment');
  });

  it('team APIs require a session (401 without bmx_session)', async () => {
    const res = makeRes();
    await call(makeReq('GET', '/api/team/roster'), res, '/api/team/roster');
    expect(res.statusCode).toBe(401);
  });

  async function login(): Promise<string> {
    writeFileSync(join(dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'cli_a', botOpenId: 'ou_a', botName: '后端Bot', cliId: 'codex' },
    ]));
    let res = makeRes();
    await call(makeReq('POST', '/api/pairing/start'), res, '/api/pairing/start');
    const { pairingId, code } = json(res);
    const browserToken = cookieValue(res, 'bmx_pair');
    claimPairing(dataDir, code, { openId: 'ou_1', unionId: 'on_1', name: '张三', larkAppId: 'cli_login' });
    res = makeRes();
    await call(makeReq('POST', '/api/pairing/consume', { cookie: 'bmx_pair=' + browserToken, body: { pairingId } }), res, '/api/pairing/consume');
    return cookieValue(res, 'bmx_session');
  }

  it('PUT capability is reflected in the roster', async () => {
    const session = await login();
    const c = 'bmx_session=' + session;
    let res = makeRes();
    await call(makeReq('PUT', '/api/team/bots/cli_a/capability', { cookie: c, body: { capability: '服务端排查' } }), res, '/api/team/bots/cli_a/capability');
    expect(res.statusCode).toBe(200);
    res = makeRes();
    await call(makeReq('GET', '/api/team/roster', { cookie: c }), res, '/api/team/roster');
    expect(json(res).bots.find((b: any) => b.larkAppId === 'cli_a').capability).toBe('服务端排查');
  });

  it('PUT then GET team role round-trips', async () => {
    const session = await login();
    const c = 'bmx_session=' + session;
    await call(makeReq('PUT', '/api/team/bots/cli_a/role', { cookie: c, body: { role: '# 后端\n严谨' } }), makeRes(), '/api/team/bots/cli_a/role');
    const res = makeRes();
    await call(makeReq('GET', '/api/team/bots/cli_a/role', { cookie: c }), res, '/api/team/bots/cli_a/role');
    expect(json(res).role).toContain('后端');
    // roster shows hasTeamRole now
    const rres = makeRes();
    await call(makeReq('GET', '/api/team/roster', { cookie: c }), rres, '/api/team/roster');
    expect(json(rres).bots.find((b: any) => b.larkAppId === 'cli_a').hasTeamRole).toBe(true);
  });

  it('editing requires a session (401)', async () => {
    const res = makeRes();
    await call(makeReq('PUT', '/api/team/bots/cli_a/capability', { body: { capability: 'x' } }), res, '/api/team/bots/cli_a/capability');
    expect(res.statusCode).toBe(401);
  });

  it('a member invites and the invitee joins via the invite code', async () => {
    const session = await login(); // 张三 bootstrapped as the first member
    const c = 'bmx_session=' + session;
    // member mints an invite
    let res = makeRes();
    await call(makeReq('POST', '/api/team/invite', { cookie: c }), res, '/api/team/invite');
    const code = json(res).code;
    expect(code).toBeTruthy();
    // invitee: new browser starts pairing
    res = makeRes();
    await call(makeReq('POST', '/api/pairing/start'), res, '/api/pairing/start');
    const { pairingId, code: pairCode } = json(res);
    const bt = cookieValue(res, 'bmx_pair');
    claimPairing(dataDir, pairCode, { openId: 'ou_2', unionId: 'on_2', name: '李四' });
    // consume with the invite code → joins + session
    res = makeRes();
    await call(makeReq('POST', '/api/pairing/consume', { cookie: 'bmx_pair=' + bt, body: { pairingId, inviteCode: code } }), res, '/api/pairing/consume');
    expect(res.statusCode).toBe(200);
    // team now has 2 members
    res = makeRes();
    await call(makeReq('GET', '/api/team/members', { cookie: c }), res, '/api/team/members');
    expect(json(res).members.length).toBe(2);
  });

  it('a removed member loses access immediately (403)', async () => {
    const session = await login(); // 张三 is a member
    removeMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_1' }); // kicked out
    const res = makeRes();
    await call(makeReq('GET', '/api/team/roster', { cookie: 'bmx_session=' + session }), res, '/api/team/roster');
    expect(res.statusCode).toBe(403);
  });

  it('cannot delete self', async () => {
    const session = await login();
    const res = makeRes();
    await call(makeReq('DELETE', '/api/team/members', { cookie: 'bmx_session=' + session, body: { unionId: 'on_1' } }), res, '/api/team/members');
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('cannot_delete_self');
  });

  it('cannot delete the last member', async () => {
    const session = await login(); // only 张三 in the team
    const res = makeRes();
    await call(makeReq('DELETE', '/api/team/members', { cookie: 'bmx_session=' + session, body: { unionId: 'on_other' } }), res, '/api/team/members');
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('cannot_delete_last');
  });

  it('rejects writes to an unknown bot id (404)', async () => {
    const session = await login();
    const res = makeRes();
    await call(makeReq('PUT', '/api/team/bots/cli_nope/capability', { cookie: 'bmx_session=' + session, body: { capability: 'x' } }), res, '/api/team/bots/cli_nope/capability');
    expect(res.statusCode).toBe(404);
    expect(json(res).error).toBe('unknown_bot');
  });

  it('authed create returns secret once; GET list excludes plaintext secret and secretRef', async () => {
    const session = await login();
    const c = 'bmx_session=' + session;
    let res = makeRes();
    await call(makeReq('POST', '/api/team/connectors', { cookie: c, body: {
      name: '线上报警', source: { type: 'generic' },
      target: { kind: 'turn', mode: 'dynamic', botId: 'cli_a' },
      promptEnvelope: { sourceName: '线上报警' },
    } }), res, '/api/team/connectors');
    expect(res.statusCode).toBe(201);
    expect(json(res).secret).toBeTruthy(); // generated secret returned once
    // GET list must not leak the plaintext secret nor the secretRef
    res = makeRes();
    await call(makeReq('GET', '/api/team/connectors', { cookie: c }), res, '/api/team/connectors');
    const raw = JSON.stringify(json(res));
    expect(json(res).connectors.length).toBe(1);
    expect(raw).not.toContain(json(res).connectors[0].secret ?? '__none__');
    expect(raw).not.toContain('secretRef');
    expect(JSON.stringify(json(res).connectors[0])).not.toMatch(/secret/i);
  });

  it('a removed member cannot write a connector (403)', async () => {
    const session = await login();
    removeMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_1' });
    const res = makeRes();
    await call(makeReq('POST', '/api/team/connectors', { cookie: 'bmx_session=' + session, body: { name: 'x', source: { type: 'generic' }, target: { kind: 'turn', mode: 'dynamic', botId: 'cli_a' } } }), res, '/api/team/connectors');
    expect(res.statusCode).toBe(403);
  });

  it('web 拉群: only roster bots, invites self, surfaces invalid lists', async () => {
    const session = await login(); // 张三, roster has cli_a
    const c = 'bmx_session=' + session;
    let captured: any = null;
    const fakeCreate = async (args: any) => { captured = args; return { ok: true, chatId: 'oc_new', invalidBotIds: [], invalidUserIds: [] }; };
    // unknown bot rejected (not on roster)
    let res = makeRes();
    await callWithGroup(makeReq('POST', '/api/team/group', { cookie: c, body: { name: 'g', larkAppIds: ['cli_ghost'] } }), res, '/api/team/group', fakeCreate);
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('unknown_bot');
    expect(captured).toBeNull(); // never proxied
    // valid roster bot → creates; passes the user's open_id + their paired bot
    // (createTeamGroup decides scope-safe auto-invite, not the route)
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/team/group', { cookie: c, body: { name: '排障', larkAppIds: ['cli_a'] } }), res, '/api/team/group', fakeCreate);
    expect(res.statusCode).toBe(200);
    expect(json(res).chatId).toBe('oc_new');
    expect(captured.larkAppIds).toEqual(['cli_a']);
    expect(captured.userOpenId).toBe('ou_1');          // user's open_id forwarded
    expect(captured.preferredCreator).toBe('cli_login'); // the bot they paired with
  });

  it('web 拉群 requires a session (401) and rejects empty selection (400)', async () => {
    let res = makeRes();
    await callWithGroup(makeReq('POST', '/api/team/group', { body: { larkAppIds: ['cli_a'] } }), res, '/api/team/group', async () => ({ ok: true }));
    expect(res.statusCode).toBe(401);
    const session = await login();
    res = makeRes();
    await callWithGroup(makeReq('POST', '/api/team/group', { cookie: 'bmx_session=' + session, body: { larkAppIds: [] } }), res, '/api/team/group', async () => ({ ok: true }));
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('no_bots_selected');
  });

  it('归到我名下: claim sets owner (override), reflected in roster; unknown bot 404', async () => {
    const session = await login(); // 张三 (on_1), bots-info has cli_a
    const c = 'bmx_session=' + session;
    let res = makeRes();
    await call(makeReq('POST', '/api/team/bots/cli_a/owner', { cookie: c }), res, '/api/team/bots/cli_a/owner');
    expect(res.statusCode).toBe(200);
    res = makeRes();
    await call(makeReq('GET', '/api/team/roster', { cookie: c }), res, '/api/team/roster');
    expect(json(res).bots.find((b: any) => b.larkAppId === 'cli_a').owner.unionId).toBe('on_1');
    // unknown bot
    res = makeRes();
    await call(makeReq('POST', '/api/team/bots/cli_ghost/owner', { cookie: c }), res, '/api/team/bots/cli_ghost/owner');
    expect(res.statusCode).toBe(404);
  });

  it('multi-team: /me lists my teams; create adds a team and switches to it', async () => {
    const session = await login(); // 张三 bootstrapped into DEFAULT
    const c = 'bmx_session=' + session;
    let res = makeRes();
    await call(makeReq('GET', '/api/team/me', { cookie: c }), res, '/api/team/me');
    expect(json(res).teams.map((t: any) => t.id)).toEqual([DEFAULT_TEAM_ID]);
    expect(json(res).teamId).toBe(DEFAULT_TEAM_ID);
    // create a new team → joins it + session switches
    res = makeRes();
    await call(makeReq('POST', '/api/team/create', { cookie: c, body: { name: '支付组' } }), res, '/api/team/create');
    expect(res.statusCode).toBe(200);
    const tid = json(res).teamId;
    res = makeRes();
    await call(makeReq('GET', '/api/team/me', { cookie: c }), res, '/api/team/me');
    expect(json(res).teamId).toBe(tid);
    expect(json(res).teams.length).toBe(2);
    expect(json(res).teams.map((t: any) => t.name)).toContain('支付组');
  });

  it('multi-team: create requires a name (400)', async () => {
    const session = await login();
    const res = makeRes();
    await call(makeReq('POST', '/api/team/create', { cookie: 'bmx_session=' + session, body: { name: '  ' } }), res, '/api/team/create');
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('name_required');
  });

  it('multi-team: switch rejects a team I am not a member of (403), allows one I am', async () => {
    const session = await login();
    const c = 'bmx_session=' + session;
    let res = makeRes();
    await call(makeReq('POST', '/api/team/switch', { cookie: c, body: { teamId: 'team_ghost' } }), res, '/api/team/switch');
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toBe('not_a_member');
    // create then switch back to DEFAULT works
    await call(makeReq('POST', '/api/team/create', { cookie: c, body: { name: 'B' } }), makeRes(), '/api/team/create');
    res = makeRes();
    await call(makeReq('POST', '/api/team/switch', { cookie: c, body: { teamId: DEFAULT_TEAM_ID } }), res, '/api/team/switch');
    expect(res.statusCode).toBe(200);
    expect(json(res).teamId).toBe(DEFAULT_TEAM_ID);
  });

  it('multi-team: join another team via invite switches into it; bad code 403', async () => {
    const session = await login(); // 张三, member of DEFAULT only
    const c = 'bmx_session=' + session;
    // an external team with an outstanding invite (minted by someone else)
    const ext = createTeam(dataDir, '外部团队');
    const inv = createInvite(dataDir, ext.id, 'someone');
    let res = makeRes();
    await call(makeReq('POST', '/api/team/join', { cookie: c, body: { code: inv.code } }), res, '/api/team/join');
    expect(res.statusCode).toBe(200);
    expect(json(res).teamId).toBe(ext.id);
    // now a member of ext + session switched there
    res = makeRes();
    await call(makeReq('GET', '/api/team/me', { cookie: c }), res, '/api/team/me');
    expect(json(res).teamId).toBe(ext.id);
    expect(json(res).teams.map((t: any) => t.id)).toContain(ext.id);
    // a bogus code is rejected
    res = makeRes();
    await call(makeReq('POST', '/api/team/join', { cookie: c, body: { code: 'NOPE' } }), res, '/api/team/join');
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toBe('invite_not_found');
  });

  it('multi-team: removed from the active team can still /me + /switch to another (account APIs not gated on active team)', async () => {
    const session = await login(); // 张三 member of DEFAULT, active=DEFAULT
    const c = 'bmx_session=' + session;
    // create team B → member of DEFAULT + B, active=B
    let res = makeRes();
    await call(makeReq('POST', '/api/team/create', { cookie: c, body: { name: 'B' } }), res, '/api/team/create');
    const teamB = json(res).teamId;
    // switch active back to DEFAULT, then get kicked out of DEFAULT (still in B)
    await call(makeReq('POST', '/api/team/switch', { cookie: c, body: { teamId: DEFAULT_TEAM_ID } }), makeRes(), '/api/team/switch');
    removeMember(dataDir, DEFAULT_TEAM_ID, { unionId: 'on_1' });
    // /me still works, flags the active team invalid, lists only the teams still joined
    res = makeRes();
    await call(makeReq('GET', '/api/team/me', { cookie: c }), res, '/api/team/me');
    expect(res.statusCode).toBe(200);
    expect(json(res).currentTeamValid).toBe(false);
    expect(json(res).teams.map((t: any) => t.id)).toEqual([teamB]);
    // can still switch to B despite the active team being invalid
    res = makeRes();
    await call(makeReq('POST', '/api/team/switch', { cookie: c, body: { teamId: teamB } }), res, '/api/team/switch');
    expect(res.statusCode).toBe(200);
    // but a current-team RESOURCE API on an invalid active team is still 403
    // (switch back to DEFAULT is blocked since 张三 is no longer a member)
    res = makeRes();
    await call(makeReq('POST', '/api/team/switch', { cookie: c, body: { teamId: DEFAULT_TEAM_ID } }), res, '/api/team/switch');
    expect(res.statusCode).toBe(403);
  });

  it('multi-team: rejects an over-long team name (400)', async () => {
    const session = await login();
    const res = makeRes();
    await call(makeReq('POST', '/api/team/create', { cookie: 'bmx_session=' + session, body: { name: 'x'.repeat(65) } }), res, '/api/team/create');
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('name_too_long');
  });

  it('multi-team: DELETE /api/team drops the team and hops the session to a remaining one', async () => {
    const session = await login(); // 张三 in DEFAULT, active=DEFAULT
    const c = 'bmx_session=' + session;
    // create B → active=B, member of DEFAULT + B
    let res = makeRes();
    await call(makeReq('POST', '/api/team/create', { cookie: c, body: { name: 'B' } }), res, '/api/team/create');
    const teamB = json(res).teamId;
    // delete active team B → session hops to DEFAULT (the remaining team)
    res = makeRes();
    await call(makeReq('DELETE', '/api/team', { cookie: c }), res, '/api/team');
    expect(res.statusCode).toBe(200);
    expect(json(res).switchedTo).toBe(DEFAULT_TEAM_ID);
    // B is gone; /me now lists only DEFAULT and is active there
    res = makeRes();
    await call(makeReq('GET', '/api/team/me', { cookie: c }), res, '/api/team/me');
    expect(json(res).teamId).toBe(DEFAULT_TEAM_ID);
    expect(json(res).teams.map((t: any) => t.id)).toEqual([DEFAULT_TEAM_ID]);
    expect(json(res).teams.find((t: any) => t.id === teamB)).toBeUndefined();
  });

  it('multi-team: deleting a team invalidates its invites; join with a stale code fails and does not switch', async () => {
    const session = await login(); // 张三 in DEFAULT
    const c = 'bmx_session=' + session;
    // create B (active=B), mint an invite for B
    let res = makeRes();
    await call(makeReq('POST', '/api/team/create', { cookie: c, body: { name: 'B' } }), res, '/api/team/create');
    const teamB = json(res).teamId;
    res = makeRes();
    await call(makeReq('POST', '/api/team/invite', { cookie: c }), res, '/api/team/invite');
    const staleCode = json(res).code;
    // delete B (active hops to DEFAULT)
    res = makeRes();
    await call(makeReq('DELETE', '/api/team', { cookie: c }), res, '/api/team');
    expect(res.statusCode).toBe(200);
    // the stale invite for B can no longer be consumed (dropped on delete) → not_found
    res = makeRes();
    await call(makeReq('POST', '/api/team/join', { cookie: c, body: { code: staleCode } }), res, '/api/team/join');
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toBe('invite_not_found');
    // session stayed on DEFAULT, never switched to the deleted team
    res = makeRes();
    await call(makeReq('GET', '/api/team/me', { cookie: c }), res, '/api/team/me');
    expect(json(res).teamId).toBe(DEFAULT_TEAM_ID);
    expect(json(res).teams.map((t: any) => t.id)).toEqual([DEFAULT_TEAM_ID]);
  });

  it('multi-team: a pre-cleanup stale invite (team gone) is rejected by the join guard', async () => {
    const session = await login();
    const c = 'bmx_session=' + session;
    // mint an invite for an external team, then delete that team WITHOUT cleanup
    // (simulates a historical residual invite) — join must still refuse it.
    const ext = createTeam(dataDir, '外部');
    const inv = createInvite(dataDir, ext.id, 'someone');
    deleteTeam(dataDir, ext.id); // delete via store directly, leaving the invite behind
    const res = makeRes();
    await call(makeReq('POST', '/api/team/join', { cookie: c, body: { code: inv.code } }), res, '/api/team/join');
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toBe('invite_team_deleted');
  });

  it('logout clears the session cookie', async () => {
    const res = makeRes();
    await call(makeReq('POST', '/api/team/logout'), res, '/api/team/logout');
    expect(res.statusCode).toBe(200);
    expect(res._headers['set-cookie']).toBeDefined();
  });
});
