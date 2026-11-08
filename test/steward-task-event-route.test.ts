// POST /api/steward/task-event：本机其他 daemon 把「某个群的会话记下了本轮结果 / 举了手」转给管家所在的
// daemon。只认宿主签名、只收一个合法的 chatId，内容不被信任（服务自己重新读群状态）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setDecisionBoardService,
  setIpcAuthSecret,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import type { DecisionBoardService } from '../src/core/decision-board/service.js';

const HOST_SECRET = 'steward-task-event-secret';
const PATH = '/api/steward/task-event';
let handle: IpcServerHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  setLarkAppId('');
  setDecisionBoardService(null);
});

async function post(body: unknown, signed = true): Promise<Response> {
  setIpcAuthSecret(HOST_SECRET);
  setLarkAppId('cli_steward');
  handle ??= await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  const headers = signed
    ? daemonIpcAuthHeaders({ secret: HOST_SECRET, port: handle.port, method: 'POST', path: PATH, headers: { 'content-type': 'application/json' } })
    : { 'content-type': 'application/json' };
  return fetch(`http://127.0.0.1:${handle.port}${PATH}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('POST /api/steward/task-event', () => {
  it('宿主签名的合法请求转给看板服务；没签名、chatId 不合法的不转', async () => {
    const noteTaskEvent = vi.fn();
    setDecisionBoardService({ noteTaskEvent } as unknown as DecisionBoardService);

    expect((await post({ chatId: 'oc_abc' }, false)).status).toBe(401);
    for (const body of [{}, { chatId: 'ou_abc' }, { chatId: 'oc_a/b' }, { chatId: 42 }]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(noteTaskEvent).not.toHaveBeenCalled();

    const ok = await post({ chatId: 'oc_abc', sessionId: 'ignored' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(noteTaskEvent).toHaveBeenCalledTimes(1);
    expect(noteTaskEvent).toHaveBeenCalledWith('oc_abc');
  });

  it('没挂全局鉴权门的形态（authRequired 缺省）：路由内宿主守卫 fail-closed 回 403', async () => {
    const bare = await startIpcServer({ port: 0, host: '127.0.0.1' });
    try {
      const res = await fetch(`http://127.0.0.1:${bare.port}${PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: 'oc_abc' }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: 'trusted_host_required' });
    } finally {
      await bare.close();
    }
  });

  it('这个 daemon 没有看板服务（不是管家）：照样回 ok，不报错', async () => {
    const res = await post({ chatId: 'oc_abc' });
    expect(res.status).toBe(200);
  });
});
