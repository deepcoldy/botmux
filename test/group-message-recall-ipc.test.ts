import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
const mocks = vi.hoisted(() => ({ list: vi.fn(), recall: vi.fn() }));
vi.mock('../src/services/group-message-recall-lark.js', () => ({ createGroupMessageRecallService: vi.fn(() => mocks) }));
import { createGroupMessageRecallService } from '../src/services/group-message-recall-lark.js';
import { GroupRecallError } from '../src/services/group-message-recall.js';
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
const secret = 'recall-route-unit-test-secret';
let server: IpcServerHandle;
async function call(path: string, method = 'GET', body?: string, auth = true) {
  const headers = auth ? Object.fromEntries(daemonIpcAuthHeaders({ secret, port: server.port, method, path })) : {};
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, method, headers: { ...headers, 'content-type': 'application/json' } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body);
  });
}
beforeEach(async () => {
  vi.clearAllMocks(); setLarkAppId('cli_bound'); setIpcAuthSecret(secret);
  mocks.list.mockResolvedValue({ ok: true, messages: [] }); mocks.recall.mockResolvedValue({ ok: true, results: [] });
  server = await startIpcServer({ host: '127.0.0.1', port: 0, authRequired: true });
});
afterEach(async () => { await server.close(); setIpcAuthSecret(null); });

describe('group recall IPC trusted-host boundary', () => {
  it.each([['GET', '/api/groups/oc_group/messages'], ['POST', '/api/groups/oc_group/messages/recall']])('rejects unsigned %s before any message IO', async (method, path) => {
    expect((await call(path, method, '{"messageIds":["om_x"]}', false)).status).toBe(401);
    expect(createGroupMessageRecallService).not.toHaveBeenCalled();
  });
  it('binds listing to the daemon bot and forwards pagination and root parameters', async () => {
    const result = await call('/api/groups/oc_group/messages?pageToken=next%2B%2F%3D&threadRootId=om_root');
    expect(result.status).toBe(200);
    expect(createGroupMessageRecallService).toHaveBeenCalledExactlyOnceWith('cli_bound');
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith('oc_group', { pageToken: 'next+/=', threadRootId: 'om_root' });
  });
  it('preserves partial outcomes and maps validation failures without changing sender identity', async () => {
    mocks.recall.mockResolvedValueOnce({ ok: false, results: [{ messageId: 'om_x', ok: false, error: 'not_bot_message' }] });
    const partial = await call('/api/groups/oc_group/messages/recall', 'POST', '{"messageIds":["om_x"]}');
    expect(partial).toMatchObject({ status: 200, body: { ok: false, results: [{ ok: false }] } });
    expect(mocks.recall).toHaveBeenCalledWith('oc_group', { messageIds: ['om_x'] });
    mocks.recall.mockRejectedValueOnce(new GroupRecallError(400, 'invalid_message_ids'));
    expect(await call('/api/groups/oc_group/messages/recall', 'POST', '{}')).toMatchObject({ status: 400, body: { error: 'invalid_message_ids' } });
  });
  it('rejects malformed JSON before invoking the mutation', async () => {
    expect((await call('/api/groups/oc_group/messages/recall', 'POST', '{')).status).toBe(400);
    expect(mocks.recall).not.toHaveBeenCalled();
  });
});
