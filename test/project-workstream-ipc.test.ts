import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import * as registry from '../src/bot-registry.js';
import * as pool from '../src/core/worker-pool.js';
import * as client from '../src/im/lark/client.js';
import * as runtime from '../src/services/project-workstream-runtime.js';
import { setIpcAuthSecret, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';

const APP = 'cli_project_main', CHAT = 'oc_project_ipc', CAP = 'ab'.repeat(32);
let handle: IpcServerHandle;
let ds: any;
let attach: ReturnType<typeof vi.spyOn>;
const oldDir = config.session.dataDir;

async function post(action: string, extra: Record<string, unknown> = {}, host = false) {
  const path = '/api/sessions/main-ipc/project-workstream';
  const body = JSON.stringify({ action, ...extra, ...(host ? {} : {
    originCapability: CAP, originTurnId: 'om_human', originDispatchAttempt: 1,
  }) });
  const headers = new Headers({ 'content-type': 'application/json' });
  return fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST', body,
    headers: host ? daemonIpcAuthHeaders({ secret: 'synthetic-ipc-secret', port: handle.port, method: 'POST', path, headers }) : headers,
  });
}
beforeEach(async () => {
  const bot = registry.registerBot({
    larkAppId: APP, larkAppSecret: 'synthetic-only', cliId: 'codex', allowedUsers: ['ou_owner'],
  });
  bot.resolvedAllowedUsers = ['ou_owner'];
  ds = {
    session: { sessionId: 'main-ipc', chatId: CHAT, rootMessageId: 'om_main', scope: 'chat', status: 'active' },
    larkAppId: APP, chatId: CHAT, chatType: 'group', scope: 'chat',
    managedTurnOrigin: { capability: CAP, turnId: 'om_human', dispatchAttempt: 1, trustedCaller: {
      requestLarkAppId: APP, requestUserOpenId: 'ou_owner', requestUserUnionId: 'on_owner', senderType: 'user',
    } },
  };
  vi.spyOn(pool, 'findActiveBySessionId').mockImplementation(id => id === 'main-ipc' ? ds : undefined);
  vi.spyOn(client, 'resolveUnionIdFromOpenIdStrict').mockResolvedValue({ status: 'resolved', unionId: 'on_owner' });
  attach = vi.spyOn(runtime.projectWorkstreamAttachments, 'attach').mockResolvedValue({
    registered: true, cardSynced: true, attachment: {
      sourceSessionId: 'worker', sourceLarkAppId: 'cli_worker', revision: 1, routeRevision: 1,
      source: 'relay', state: 'active', reportCapability: 'verified',
    },
  });
  vi.spyOn(runtime.projectWorkstreamAttachments, 'rename').mockResolvedValue({ cardSynced: true, project: {} as any });
  setIpcAuthSecret('synthetic-ipc-secret');
  handle = await startIpcServer({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => {
  await handle?.close();
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
  config.session.dataDir = oldDir;
});
const source = { sourceSessionId: 'worker', sourceLarkAppId: 'cli_worker', rootMessageId: 'om_task', title: '迁入任务' };

describe('project workstream IPC boundary', () => {
  it('binds actor to the live human chat coordinator, not request JSON', async () => {
    expect((await post('attach', source)).status).toBe(200);
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'main-ipc', larkAppId: APP, chatId: CHAT, ownerKey: 'union:on_owner', turnId: 'om_human',
    }), expect.objectContaining(source));
  });
  it('rejects stale capability before source lookup/registration', async () => {
    ds.managedTurnOrigin.capability = 'cd'.repeat(32);
    expect((await post('attach', source)).status).toBe(403);
    expect(attach).not.toHaveBeenCalled();
  });
  it('does not let a host signature substitute for a current CLI turn proof', async () => {
    expect((await post('attach', source, true)).status).toBe(403);
    expect(attach).not.toHaveBeenCalled();
  });
  it('does not treat a bot/unknown/scheduled caller or owner fallback as a human', async () => {
    for (const caller of [
      { requestLarkAppId: APP, requestUserOpenId: 'ou_owner', senderType: 'bot' },
      { requestLarkAppId: APP, requestUserOpenId: 'ou_owner' },
      { requestLarkAppId: APP, requestUserOpenId: 'ou_owner', senderType: 'user', source: 'schedule_creator' },
    ]) {
      ds.managedTurnOrigin.trustedCaller = caller;
      ds.session.ownerOpenId = 'ou_owner';
      expect((await post('attach', source, true)).status).toBe(403);
    }
    expect(attach).not.toHaveBeenCalled();
  });
  it('refuses a guest and a thread-scoped worker even with valid turn identity', async () => {
    ds.managedTurnOrigin.trustedCaller.requestUserOpenId = 'ou_guest';
    expect((await post('attach', source)).status).toBe(403);
    ds.managedTurnOrigin.trustedCaller.requestUserOpenId = 'ou_owner';
    ds.scope = 'thread';
    expect((await post('attach', source)).status).toBe(403);
    expect(attach).not.toHaveBeenCalled();
  });
  it('rejects forged authority and numeric coercions without writes', async () => {
    for (const extra of [
      { ownerKey: 'union:on_other' }, { chatId: 'oc_other' },
      { expectedRevision: '1' }, { progress: '100' }, { title: { arbitrary: true } },
    ]) {
      expect((await post('attach', { ...source, ...extra })).status).toBe(400);
    }
    expect(attach).not.toHaveBeenCalled();
  });
  it('allows dedicated rename action without an extra task kickoff', async () => {
    expect((await post('rename', { rootMessageId: 'om_task', title: '实现迁入任务' })).status).toBe(200);
    expect(runtime.projectWorkstreamAttachments.rename).toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });
});
