import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ipcRoute, startIpcServer, setIpcAuthSecret, setLarkAppId, readJsonBody, jsonRes,
  type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { authorizeVcMeetingSummaryShare } from '../src/services/vc-meeting-send-policy.js';
import { applyVcMeetingMemberProjection } from '../src/services/vc-meeting-delivery-store.js';
import type { VcMeetingImTurnOrigin } from '../src/types.js';

const PATH = '/api/vc-meetings/share-summary';
const SECRET = 'summary-ipc-host-fixture';
const origin: VcMeetingImTurnOrigin = {
  listenerAppId: 'listener', meetingId: 'meeting', memberId: 'minutes', memberEpoch: 1,
  agentAppId: 'agent', ownerBootId: 'boot', ownerEpoch: 1, membershipGeneration: 1,
  sinkOwnerGeneration: 1, receiverSessionId: 'receiver', larkMessageId: 'om_human',
  replyTargetSenderOpenId: 'ou_human', summaryShareTargetChatId: 'oc_destination',
};
let ipc: IpcServerHandle;
let dir: string;
let handlerHits: number;
let authorized: number;
let hostHits: number;
let liveOrigin: { capability: string; turnId: string; dispatchAttempt?: number };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'summary-ipc-'));
  handlerHits = authorized = hostHits = 0;
  liveOrigin = { capability: 'current-capability', turnId: 'om_human' };
  applyVcMeetingMemberProjection(dir, {
    ...origin, role: 'minutes', status: 'active', responseMode: 'listener_thread',
    capabilities: ['listener.output.request', 'meeting.read'], ownedSinks: [],
    joinedAtIngestSeq: 0, outputChatId: 'oc_source', outputPlacement: 'auto',
    listenerPolicy: { allowSummarySharing: true },
  });
  setIpcAuthSecret(SECRET);
  setLarkAppId('agent');
  // Exercise the real HTTP gateway with the CLI's capability-only request shape
  // and the production authorization helper; no Lark or host credential access.
  ipcRoute('POST', PATH, async (req, res) => {
    handlerHits++;
    const body = await readJsonBody<{ receiverSessionId: string; originCapability?: string; content: string }>(req);
    try {
      authorizeVcMeetingSummaryShare(dir, {
        session: { sessionId: body.receiverSessionId, vcMeetingImTurnOrigins: { om_human: origin } },
        agentAppId: 'agent', liveOrigin, claimedCapability: body.originCapability,
      });
      authorized++;
      jsonRes(res, 200, { ok: true });
    } catch {
      jsonRes(res, 403, { ok: false });
    }
  });
  ipcRoute('POST', '/api/test-summary-host-only', (_req, res) => {
    hostHits++;
    jsonRes(res, 200, { ok: true });
  });
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});
afterEach(async () => {
  await ipc?.close();
  setIpcAuthSecret(null);
  rmSync(dir, { recursive: true, force: true });
});
function call(path = PATH, body: unknown = {
  receiverSessionId: 'receiver', originCapability: 'current-capability', content: 'Minutes',
}, signed = false, method = 'POST') {
  const headers = signed
    ? daemonIpcAuthHeaders({ secret: SECRET, port: ipc.port, method, path, headers: { 'content-type': 'application/json' } })
    : { 'content-type': 'application/json' };
  return fetch(`http://127.0.0.1:${ipc.port}${path}`, { method, headers,
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
}
describe('summary sharing IPC aperture', () => {
  it('admits a capability-only CLI request without host HMAC', async () => {
    expect((await call()).status).toBe(200);
    expect(handlerHits).toBe(1);
    expect(authorized).toBe(1);
  });
  it('does not turn the aperture into authorization for missing, stale or cross-session claims', async () => {
    for (const body of [
      { receiverSessionId: 'receiver', content: 'Minutes' },
      { receiverSessionId: 'receiver', originCapability: 'stale', content: 'Minutes' },
      { receiverSessionId: 'other', originCapability: 'current-capability', content: 'Minutes' },
    ]) expect((await call(PATH, body)).status).toBe(403);
    liveOrigin = { ...liveOrigin, turnId: 'automatic-delivery', dispatchAttempt: 1 };
    expect((await call()).status).toBe(403);
    expect(handlerHits).toBe(4);
    expect(authorized).toBe(0);
  });
  it('keeps host-only routes and other methods protected, and host HMAC cannot replace the human grant', async () => {
    expect((await call('/api/test-summary-host-only')).status).toBe(401);
    expect(hostHits).toBe(0);
    expect((await call('/api/test-summary-host-only', {}, true)).status).toBe(200);
    expect(hostHits).toBe(1);
    expect((await call('/api/vc-meetings-sibling/share-summary')).status).toBe(401);
    expect((await call(PATH, undefined, false, 'GET')).status).toBe(401);
    expect(handlerHits).toBe(0);
    expect((await call(PATH, { receiverSessionId: 'receiver', content: 'Minutes' }, true)).status).toBe(403);
    expect(authorized).toBe(0);
  });
});
