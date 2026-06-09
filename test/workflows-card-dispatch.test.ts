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
  it('refresh: result.card is the rebuilt list card; updateMessage NOT called on fast path', async () => {
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET' && req.path === '/__daemon/workflows-runs-snapshot') {
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

  it('page: result.card reflects the requested page', async () => {
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
    expect(cardJson).toContain('第 2/3 页');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });
});
