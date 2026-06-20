/**
 * PR3 `/dashboard workflows` slice 1 — production dispatch path test.
 *
 * Exercises the public `handleCardAction(...)` entry and verifies that the
 * `dash_workflows_*` arm:
 *  - hits `handleWorkflowsCardAction`,
 *  - returns `{ card }` only on the fast path (no toast, no out-of-band
 *    updateMessage — that's the stale-render fix carried over from settings).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/im/lark/client.js')>(
    '../src/im/lark/client.js',
  );
  return {
    ...actual,
    updateMessage: vi.fn(async () => {}),
    resolveUserUnionId: vi.fn(async () => ({})),
  };
});

vi.mock('../src/daemon-internal-client-wrapper.js', () => ({
  createDaemonClientFor: vi.fn(),
}));

vi.mock('../src/bot-registry.js', async () => {
  const actual = await vi.importActual<typeof import('../src/bot-registry.js')>('../src/bot-registry.js');
  return {
    ...actual,
    getOwnerOpenId: vi.fn(() => 'ou_alice'),
    getDashboardAdminOpenIds: vi.fn(() => ['ou_alice']),
  };
});

import { updateMessage } from '../src/im/lark/client.js';
import { createDaemonClientFor } from '../src/daemon-internal-client-wrapper.js';
import { handleCardAction, type CardActionData } from '../src/im/lark/card-handler.js';

const mockedUpdateMessage = vi.mocked(updateMessage);
const mockedCreateClient = vi.mocked(createDaemonClientFor);

const LARK_APP_ID = 'cli_test';
const INVOKER = 'ou_alice';

beforeEach(() => {
  mockedUpdateMessage.mockClear();
  mockedCreateClient.mockReset();
});

function makeDeps(): any {
  return {
    activeSessions: new Map(),
    sessionReply: vi.fn(async () => 'om_reply'),
    getActiveCount: () => 0,
    lastRepoScan: new Map(),
  };
}

describe('handleCardAction → workflows dispatch returns { card } only on success', () => {
  it('refresh: result.card is the rebuilt list card; ?all=1 query sent; updateMessage NOT called on fast path', async () => {
    const requestSpy = vi.fn(async (req: any) => {
      // codex 2026-06-09 blocker: must request with ?all=1 (default listRuns
      // hides terminal runs). Match the path strictly so this test catches
      // any regression that drops the query.
      if (req.method === 'GET' && req.path === '/__daemon/workflows-runs-snapshot?all=1') {
        return {
          status: 200, raw: '',
          body: { runs: [
            { runId: 'r1', workflowId: 'flowAlpha', status: 'running', startedAt: 1_000_000, updatedAt: 1_500_000, nodesDone: 1, nodesTotal: 3 },
          ] },
        };
      }
      throw new Error('unexpected: ' + JSON.stringify(req));
    });
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: 'dash_workflows_refresh', invoker_open_id: INVOKER } },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.toast).toBeUndefined();
    expect(result.card).toBeDefined();
    expect(result.card?.type).toBe('raw');
    const cardJson = JSON.stringify(result.card?.data);
    expect(cardJson).toContain('Dashboard 工作流');
    expect(cardJson).toContain('flowAlpha');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });

  it('page: result.card reflects the requested page; request still carries ?all=1', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      runId: `r_${i}`, workflowId: `wf_${i}`, status: 'running',
      startedAt: 1_000 - i, updatedAt: 1_500, nodesDone: 1, nodesTotal: 3,
    }));
    const requestSpy = vi.fn(async () => ({ status: 200, raw: '', body: { runs: rows } }));
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: 'dash_workflows_page', invoker_open_id: INVOKER, page: '2' } },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.card).toBeDefined();
    const cardJson = JSON.stringify(result.card?.data);
    // PAGE_SIZE=5 (unified 2026-06-10). 25 / 5 = 5 pages.
    expect(cardJson).toContain('第 2/5 页');

    // codex blocker: page action must also carry ?all=1 — same reason as refresh.
    expect(requestSpy).toHaveBeenCalledOnce();
    expect(requestSpy.mock.calls[0][0]).toEqual({
      method: 'GET',
      path: '/__daemon/workflows-runs-snapshot?all=1',
    });

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });

  /* ─── Slice 2a — detail / cancel dispatch ──────────────────────────── */

  it('detail: result.card is the detail card on the fast path; updateMessage NOT called', async () => {
    const runs = [{
      runId: 'r_dispatch_detail',
      workflowId: 'wfDispatchDetail',
      status: 'running',
      startedAt: 1_000_000,
      updatedAt: 1_500_000,
      nodesDone: 1,
      nodesTotal: 3,
      chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
    }];
    const requestSpy = vi.fn(async () => ({ status: 200, raw: '', body: { runs } }));
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: {
        value: {
          action: 'dash_workflows_detail',
          invoker_open_id: INVOKER,
          run_id: 'r_dispatch_detail',
        },
      },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.toast).toBeUndefined();
    expect(result.card).toBeDefined();
    expect(result.card?.type).toBe('raw');
    const cardJson = JSON.stringify(result.card?.data);
    expect(cardJson).toContain('工作流详情');
    expect(cardJson).toContain('r_dispatch_detail');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });

  it('cancel happy: result.card is the cancelled-state detail; no updateMessage', async () => {
    const before = {
      runId: 'r_dispatch_cancel',
      workflowId: 'wfDispatchCancel',
      status: 'running',
      startedAt: 1_000_000,
      updatedAt: 1_500_000,
      nodesDone: 1,
      nodesTotal: 3,
      chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
    };
    const after = { ...before, status: 'cancelled' };
    let getCalls = 0;
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET' && req.path === '/__daemon/workflows-runs-snapshot?all=1') {
        getCalls += 1;
        return { status: 200, raw: '', body: { runs: [getCalls === 1 ? before : after] } };
      }
      if (req.method === 'POST' && req.path === '/__daemon/workflows-runs/r_dispatch_cancel/cancel') {
        return { status: 200, raw: '', body: { ok: true } };
      }
      throw new Error('unexpected: ' + JSON.stringify(req));
    });
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: {
        value: {
          action: 'dash_workflows_cancel',
          invoker_open_id: INVOKER,
          run_id: 'r_dispatch_cancel',
        },
      },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.toast).toBeUndefined();
    expect(result.card).toBeDefined();
    expect(result.card?.type).toBe('raw');
    const cardJson = JSON.stringify(result.card?.data);
    expect(cardJson).toContain('工作流详情');
    // cancelled state → cancel button disabled with alreadyTerminal note.
    expect(cardJson).toContain('"disabled":true');
    expect(cardJson).toContain('运行已处于终态，无法取消');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });

  it('cancel snapshot already terminal: result.toast (alreadyTerminal); no card; no updateMessage', async () => {
    const before = {
      runId: 'r_dispatch_done',
      workflowId: 'wfDispatchDone',
      status: 'succeeded', // terminal
      startedAt: 1_000_000,
      updatedAt: 1_500_000,
      nodesDone: 3,
      nodesTotal: 3,
      chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_demo' },
    };
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET' && req.path === '/__daemon/workflows-runs-snapshot?all=1') {
        return { status: 200, raw: '', body: { runs: [before] } };
      }
      throw new Error('unexpected: ' + JSON.stringify(req));
    });
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: {
        value: {
          action: 'dash_workflows_cancel',
          invoker_open_id: INVOKER,
          run_id: 'r_dispatch_done',
        },
      },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.toast).toBeDefined();
    expect(result.toast?.content).toContain('运行已处于终态，无法取消');
    expect(result.card).toBeUndefined();

    // Defense-in-depth: NO POST was issued.
    const postCalls = requestSpy.mock.calls.filter((c: any[]) => (c[0] as any).method === 'POST');
    expect(postCalls.length).toBe(0);

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });
});
