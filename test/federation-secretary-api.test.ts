/**
 * 群秘书跨机器只读接口的鉴权：只有 federation 团队凭证（hub 记录的 syncToken、或本机发给 hub 的
 * delegationToken）能读；其它一律 403，且不触碰本机会话数据。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ dataDir: '', observed: 0 }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return state.dataDir; } } } }));
vi.mock('../src/services/session-observe-command-fetch.js', () => ({
  fetchObserveSnapshot: async () => {
    state.observed++;
    const s = (id: string, chatId: string) => ({
      schemaVersion: 1, observedAt: 0, probe: { status: 'ok', source: 'daemon-ipc' },
      identity: { sessionId: id, larkAppId: 'cli_fox', botName: 'fox', chatId, chatType: chatId === 'oc_dm' ? 'p2p' : 'group', scope: 'thread', rootMessageId: 'om_t' },
      cli: {}, backend: { adopted: false }, liveness: 'alive', turn: 'working', phase: 'unknown', queued: false, parkedOrSuspended: false, closed: false,
    });
    return { schemaVersion: 1, observedAt: 0, daemons: [{ larkAppId: 'cli_fox', probe: { status: 'ok', source: 'daemon-ipc' }, sessions: [s('s1', 'oc_1'), s('s2', 'oc_2'), s('s3', 'oc_dm')] }] };
  },
}));
vi.mock('../src/services/group-secretary-transcript.js', () => ({
  fetchSessionRecentTranscript: async () => [{ role: 'agent', text: '做到第二步了' }],
}));

import { handleFederationApi } from '../src/dashboard/federation-api.js';
import { registerDeployment } from '../src/services/federation-store.js';
import { addMembership } from '../src/services/federation-membership-store.js';
import { DEFAULT_TEAM_ID } from '../src/services/team-store.js';

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

beforeEach(() => { state.dataDir = mkdtempSync(join(tmpdir(), 'fed-sec-')); state.observed = 0; });

describe('/api/federation/secretary/*', () => {
  it('rejects missing or unknown tokens without reading local sessions', async () => {
    expect((await get('/api/federation/secretary/sessions?chatId=oc_1')).status).toBe(403);
    expect((await get('/api/federation/secretary/sessions?chatId=oc_1', 'nope')).status).toBe(403);
    expect((await get('/api/federation/secretary/transcript?appId=a&sessionId=s&chatId=oc_1', 'nope')).status).toBe(403);
    expect(state.observed).toBe(0);
  });

  it('serves the asked chat only, to a spoke syncToken (hub side)', async () => {
    const { syncToken } = registerDeployment(state.dataDir, DEFAULT_TEAM_ID, { deploymentId: 'dep_x', name: 'x', bots: [] });
    const r = await get('/api/federation/secretary/sessions?chatId=oc_1', syncToken);
    expect(r.status).toBe(200);
    expect(r.body.sessions.map((s: any) => s.sessionId)).toEqual(['s1']);
  });

  it('serves a hub presenting the delegationToken this spoke issued (spoke side)', async () => {
    addMembership(state.dataDir, { hubUrl: 'http://hub', teamId: 't', teamName: 'T', syncToken: 'st', deploymentId: 'me', delegationToken: 'dt-123' });
    const r = await get('/api/federation/secretary/transcript?appId=cli_fox&sessionId=s1&chatId=oc_1', 'dt-123');
    expect(r.status).toBe(200);
    expect(r.body.lines[0].text).toBe('做到第二步了');
  });

  it('never serves DM sessions or sessions of another chat, even with a valid token', async () => {
    addMembership(state.dataDir, { hubUrl: 'http://hub', teamId: 't', teamName: 'T', syncToken: 'st', deploymentId: 'me', delegationToken: 'dt-9' });
    expect((await get('/api/federation/secretary/transcript?appId=cli_fox&sessionId=s3&chatId=oc_dm', 'dt-9')).status).toBe(404);
    expect((await get('/api/federation/secretary/transcript?appId=cli_fox&sessionId=s1&chatId=oc_2', 'dt-9')).status).toBe(404);
    expect((await get('/api/federation/secretary/transcript?appId=cli_fox&sessionId=s1', 'dt-9')).status).toBe(400);
    expect((await get('/api/federation/secretary/sessions?chatId=oc_dm', 'dt-9')).body.sessions).toEqual([]);
  });
});
