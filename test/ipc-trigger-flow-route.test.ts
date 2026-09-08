// POST /api/trigger 的 `target.kind: 'flow'` 分支：起真实 IPC server（port 0，无 auth）+ fetch。
// flow 处理器由 daemon 启动时注册；未注册（core-only bot / 旧 daemon）必须明确 501，
// 而不是掉进 turn 路径。turn 请求的路由保持不变（不受 flow 处理器影响）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFlowTriggerHandler, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';

let handle: IpcServerHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setFlowTriggerHandler(null);
  vi.restoreAllMocks();
});

function flowBody(overrides: Partial<TriggerRequest['target']> = {}, options: TriggerRequest['options'] = {}): TriggerRequest {
  return {
    source: { type: 'webhook', connectorId: 'conn_ci', requestId: 'req_1' },
    target: { kind: 'flow', botId: 'app_flow', chatId: 'oc_chat', script: 'flows/on-push.mjs', ...overrides },
    envelope: { format: 'botmux.webhook.v1', sourceName: 'ci', trusted: false, payload: { ref: 'main' } },
    options,
  };
}

async function post(body: unknown): Promise<{ status: number; json: any }> {
  if (!handle) {
    setLarkAppId('app_flow');
    vi.spyOn(workerPool, 'getActiveSessionsRegistry').mockReturnValue(new Map());
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  }
  const res = await fetch(`http://127.0.0.1:${handle.port}/api/trigger`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe('POST /api/trigger — flow target', () => {
  it('501 flow_not_enabled when no flow handler is registered (core-only bot / old daemon)', async () => {
    const r = await post(flowBody());
    expect(r.status).toBe(501);
    expect(r.json).toMatchObject({ ok: false, errorCode: 'flow_not_enabled' });
  });

  it('routes a validated flow request to the registered handler and maps its outcome to HTTP', async () => {
    const seen: TriggerRequest[] = [];
    setFlowTriggerHandler(async (req) => {
      seen.push(req);
      return { ok: true, triggerId: 'trg_1', action: 'queued', target: { kind: 'flow', chatId: 'oc_chat', flowRunId: 'run_1', rootMessageId: 'om_seed' } };
    });
    const queued = await post(flowBody());
    expect(queued.status).toBe(200);
    expect(queued.json).toMatchObject({ ok: true, action: 'queued', target: { flowRunId: 'run_1' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.target).toEqual({ kind: 'flow', botId: 'app_flow', chatId: 'oc_chat', script: 'flows/on-push.mjs' });

    setFlowTriggerHandler(async () => ({ ok: false, triggerId: 'trg_2', errorCode: 'flow_interrupted', error: 'runner died' }));
    expect((await post(flowBody())).status).toBe(502);
    setFlowTriggerHandler(async () => ({ ok: false, triggerId: 'trg_3', errorCode: 'wait_timeout', error: 'still running' }));
    expect((await post(flowBody({}, { waitForFinalOutput: true }))).status).toBe(504);
    setFlowTriggerHandler(async () => ({ ok: false, triggerId: 'trg_4', errorCode: 'bot_not_in_chat', error: 'not in chat' }));
    expect((await post(flowBody())).status).toBe(403);
  });

  it('validator rejects a flow request without script or chat before the handler runs; wrong botId is rejected too', async () => {
    const handler = vi.fn(async () => ({ ok: true, triggerId: 'x', action: 'queued' as const }));
    setFlowTriggerHandler(handler);
    expect((await post(flowBody({ script: undefined }))).status).toBe(400);
    expect((await post(flowBody({ chatId: undefined }))).status).toBe(400);
    expect((await post(flowBody({}, { asyncReturnSessionId: true }))).status).toBe(400);
    const wrongBot = await post(flowBody({ botId: 'app_other' }));
    expect(wrongBot.status).toBe(400);
    expect(wrongBot.json).toMatchObject({ errorCode: 'bot_not_found' });
    expect(handler).not.toHaveBeenCalled();
  });
});
