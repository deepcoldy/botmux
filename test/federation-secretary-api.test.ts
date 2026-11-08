/**
 * 群秘书跨机器只读接口的鉴权：只有 federation 团队凭证（hub 记录的 syncToken、或本机发给 hub 的
 * delegationToken）能读，且只能读该凭证所属团队的团队群（与团队看板同一口径）；其它一律拒绝，
 * 且不触碰本机会话数据。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ dataDir: '', observed: 0, transcripts: 0 }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return state.dataDir; } } } }));
vi.mock('../src/services/session-observe-command-fetch.js', () => ({
  fetchObserveSnapshot: async () => {
    state.observed++;
    const s = (id: string, chatId: string) => ({
      schemaVersion: 1, observedAt: 0, probe: { status: 'ok', source: 'daemon-ipc' },
      identity: { sessionId: id, larkAppId: 'cli_fox', botName: 'fox', chatId, chatType: chatId === 'oc_dm' ? 'p2p' : 'group', scope: 'thread', rootMessageId: 'om_t' },
      cli: {}, backend: { adopted: false }, liveness: 'alive', turn: 'working', phase: 'unknown', queued: false, parkedOrSuspended: false, closed: false,
    });
    return {
      schemaVersion: 1, observedAt: 0,
      daemons: [{ larkAppId: 'cli_fox', probe: { status: 'ok', source: 'daemon-ipc' }, sessions: [
        s('s1', 'oc_1'), s('s2', 'oc_2'), s('s3', 'oc_dm'), s('s_b', 'oc_team_b'), s('s_priv', 'oc_private'),
      ] }],
    };
  },
}));
vi.mock('../src/services/group-secretary-transcript.js', () => ({
  fetchSessionRecentTranscript: async () => { state.transcripts++; return [{ role: 'agent', text: '做到第二步了' }]; },
}));

import { handleFederationApi } from '../src/dashboard/federation-api.js';
import { registerDeployment } from '../src/services/federation-store.js';
import { addMembership } from '../src/services/federation-membership-store.js';
import { createTeam, DEFAULT_TEAM_ID } from '../src/services/team-store.js';
import { recordTeamGroup } from '../src/services/team-groups-store.js';

function makeReq(path: string, token?: string): any {
  const req: any = { method: 'GET', url: path, headers: token ? { authorization: `Bearer ${token}` } : {} };
  req[Symbol.asyncIterator] = async function* () {};
  return req;
}
function makeRes(): any {
  const res: any = { statusCode: 0, _headers: {}, _body: '' };
  res.setHeader = (k: string, v: any) => { res._headers[k.toLowerCase()] = v; };
  res.getHeader = (k: string) => res._headers[k.toLowerCase()];
  res.writeHead = (s: number) => { res.statusCode = s; };
  res.end = (b?: string) => { res._body = b ?? ''; };
  return res;
}
async function get(path: string, token?: string) {
  const res = makeRes();
  await handleFederationApi(makeReq(path, token), res, new URL('http://x' + path), { dataDir: state.dataDir });
  return { status: res.statusCode, body: res._body ? JSON.parse(res._body) : undefined };
}

beforeEach(() => { state.dataDir = mkdtempSync(join(tmpdir(), 'fed-sec-')); state.observed = 0; state.transcripts = 0; });

describe('/api/federation/secretary/*', () => {
  it('rejects missing or unknown tokens without reading local sessions', async () => {
    expect((await get('/api/federation/secretary/sessions?chatId=oc_1')).status).toBe(403);
    expect((await get('/api/federation/secretary/sessions?chatId=oc_1', 'nope')).status).toBe(403);
    expect((await get('/api/federation/secretary/transcript?appId=a&sessionId=s&chatId=oc_1', 'nope')).status).toBe(403);
    expect(state.observed).toBe(0);
  });

  it('serves the asked team chat only, to a spoke syncToken (hub side)', async () => {
    recordTeamGroup(state.dataDir, DEFAULT_TEAM_ID, 'oc_1');
    const { syncToken } = registerDeployment(state.dataDir, DEFAULT_TEAM_ID, { deploymentId: 'dep_x', name: 'x', bots: [] });
    const r = await get('/api/federation/secretary/sessions?chatId=oc_1', syncToken);
    expect(r.status).toBe(200);
    expect(r.body.sessions.map((s: any) => s.sessionId)).toEqual(['s1']);
  });

  it('serves a hub presenting the delegationToken this spoke issued (spoke side)', async () => {
    addMembership(state.dataDir, { hubUrl: 'http://hub', teamId: 't', teamName: 'T', syncToken: 'st', deploymentId: 'me', delegationToken: 'dt-123' });
    recordTeamGroup(state.dataDir, 't', 'oc_1');
    const r = await get('/api/federation/secretary/transcript?appId=cli_fox&sessionId=s1&chatId=oc_1', 'dt-123');
    expect(r.status).toBe(200);
    expect(r.body.lines[0].text).toBe('做到第二步了');
  });

  it('never serves DM sessions or sessions of another chat, even with a valid token', async () => {
    addMembership(state.dataDir, { hubUrl: 'http://hub', teamId: 't', teamName: 'T', syncToken: 'st', deploymentId: 'me', delegationToken: 'dt-9' });
    recordTeamGroup(state.dataDir, 't', 'oc_2');
    recordTeamGroup(state.dataDir, 't', 'oc_dm');
    expect((await get('/api/federation/secretary/transcript?appId=cli_fox&sessionId=s3&chatId=oc_dm', 'dt-9')).status).toBe(404);
    expect((await get('/api/federation/secretary/transcript?appId=cli_fox&sessionId=s1&chatId=oc_2', 'dt-9')).status).toBe(404);
    expect((await get('/api/federation/secretary/transcript?appId=cli_fox&sessionId=s1', 'dt-9')).status).toBe(400);
    expect((await get('/api/federation/secretary/sessions?chatId=oc_dm', 'dt-9')).body.sessions).toEqual([]);
  });
});

describe('/api/federation/secretary/* team scope (same as the team board)', () => {
  it('a team-A syncToken cannot read team-B groups or groups outside any team (hub side)', async () => {
    const teamA = createTeam(state.dataDir, 'A');
    const teamB = createTeam(state.dataDir, 'B');
    recordTeamGroup(state.dataDir, teamA.id, 'oc_1');
    recordTeamGroup(state.dataDir, teamB.id, 'oc_team_b');
    const { syncToken } = registerDeployment(state.dataDir, teamA.id, { deploymentId: 'dep_a', name: 'a', bots: [] });

    const own = await get('/api/federation/secretary/sessions?chatId=oc_1', syncToken);
    expect(own.status).toBe(200);
    expect(own.body.sessions.map((s: any) => s.sessionId)).toEqual(['s1']);
    state.observed = 0;

    for (const chatId of ['oc_team_b', 'oc_private']) {
      const r = await get(`/api/federation/secretary/sessions?chatId=${chatId}`, syncToken);
      expect(r.status).toBe(403);
      expect(r.body.sessions).toBeUndefined();
    }
    const transcript = await get('/api/federation/secretary/transcript?appId=cli_fox&sessionId=s_b&chatId=oc_team_b', syncToken);
    expect(transcript.status).toBe(403);
    expect(transcript.body.lines).toBeUndefined();
    expect((await get('/api/federation/secretary/transcript?appId=cli_fox&sessionId=s_priv&chatId=oc_private', syncToken)).status).toBe(403);
    expect(state.observed).toBe(0);
    expect(state.transcripts).toBe(0);
  });

  it('a hub delegationToken only reaches the groups mirrored for its own team (spoke side)', async () => {
    addMembership(state.dataDir, { hubUrl: 'http://hub-a', teamId: 'team_a', teamName: 'A', syncToken: 'st-a', deploymentId: 'me', delegationToken: 'dt-a' });
    addMembership(state.dataDir, { hubUrl: 'http://hub-b', teamId: 'team_b', teamName: 'B', syncToken: 'st-b', deploymentId: 'me', delegationToken: 'dt-b' });
    recordTeamGroup(state.dataDir, 'team_a', 'oc_1');
    recordTeamGroup(state.dataDir, 'team_b', 'oc_team_b');

    expect((await get('/api/federation/secretary/sessions?chatId=oc_1', 'dt-a')).status).toBe(200);
    expect((await get('/api/federation/secretary/sessions?chatId=oc_team_b', 'dt-b')).status).toBe(200);
    state.observed = 0;

    expect((await get('/api/federation/secretary/sessions?chatId=oc_team_b', 'dt-a')).status).toBe(403);
    expect((await get('/api/federation/secretary/sessions?chatId=oc_private', 'dt-a')).status).toBe(403);
    expect((await get('/api/federation/secretary/transcript?appId=cli_fox&sessionId=s_b&chatId=oc_team_b', 'dt-a')).status).toBe(403);
    expect((await get('/api/federation/secretary/transcript?appId=cli_fox&sessionId=s1&chatId=oc_1', 'dt-b')).status).toBe(403);
    expect(state.observed).toBe(0);
    expect(state.transcripts).toBe(0);
  });
});
