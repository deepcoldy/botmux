/**
 * PR3 `/dashboard groups` slice 1 — production dispatch path test.
 *
 * Exercises the public `handleCardAction(...)` entry and verifies that the
 * `dash_groups_*` arm:
 *  - hits `handleGroupsCardAction`,
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

describe('handleCardAction → groups dispatch returns { card } only on success', () => {
  it('refresh: result.card defined; updateMessage NOT called on fast path', async () => {
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET' && req.path === '/__daemon/groups-matrix') {
        return {
          status: 200, raw: '',
          body: {
            chats: [{
              chatId: 'oc_one',
              name: 'cool-room',
              memberBots: [{ larkAppId: LARK_APP_ID, botName: 'self', inChat: true, oncallChat: null }],
            }],
            bots: [{ larkAppId: LARK_APP_ID, botName: 'self' }],
          },
        };
      }
      throw new Error('unexpected: ' + JSON.stringify(req));
    });
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: 'dash_groups_refresh', invoker_open_id: INVOKER } },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.toast).toBeUndefined();
    expect(result.card).toBeDefined();
    expect(result.card?.type).toBe('raw');
    const cardJson = JSON.stringify(result.card?.data);
    expect(cardJson).toContain('Dashboard 群组');
    expect(cardJson).toContain('cool-room');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });

  it('page: result.card reflects requested page; updateMessage NOT called', async () => {
    const chats = Array.from({ length: 25 }, (_, i) => ({
      chatId: `oc_${String(i).padStart(4, '0')}`,
      name: `chat-${i}`,
      memberBots: [{ larkAppId: LARK_APP_ID, botName: 'self', inChat: true, oncallChat: null }],
    }));
    const requestSpy = vi.fn(async () => ({
      status: 200, raw: '',
      body: { chats, bots: [{ larkAppId: LARK_APP_ID, botName: 'self' }] },
    }));
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: 'dash_groups_page', invoker_open_id: INVOKER, page: '2' } },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.card).toBeDefined();
    const cardJson = JSON.stringify(result.card?.data);
    // PAGE_SIZE=5 (unified 2026-06-10). 25 / 5 = 5 pages.
    expect(cardJson).toContain('第 2/5 页');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });
});
