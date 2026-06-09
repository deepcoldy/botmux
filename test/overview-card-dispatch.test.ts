/**
 * PR3 `/dashboard overview` slice 1 — production dispatch path test.
 *
 * Exercises the public `handleCardAction(...)` entry and verifies that the
 * `dash_overview_*` arm:
 *  - hits `handleOverviewCardAction`,
 *  - returns `{ card }` only on the fast path (no toast, no out-of-band
 *    updateMessage — same stale-render fix as sessions/schedules/settings).
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

function sampleSnapshotBody() {
  return {
    sessions: [
      { sessionId: 's1', rootMessageId: 'om', chatId: 'oc', chatType: 'group',
        title: 'one', cliId: 'claude-code', workingDir: '~/x', status: 'working',
        lastMessageAt: 1_000_000, cliVersion: 'v', webPort: 7891, scope: 'thread',
        spawnedAt: 0, larkAppId: LARK_APP_ID, isOncall: false, hasHistory: true },
    ],
    schedules: [
      { id: 's_1', name: 'daily-ping', enabled: true,
        parsed: { kind: 'cron', display: '0 9 * * *', expr: '0 9 * * *' },
        nextRunAt: '2026-06-09T13:00:00.000Z',
        lastRunAt: '2026-06-08T13:00:00.000Z',
        lastStatus: 'ok', larkAppId: LARK_APP_ID, chatId: 'oc' },
    ],
    settings: { publicReadOnly: false, openTerminalInFeishu: false, maintenance: {}, localDevInstall: false },
  };
}

describe('handleCardAction → overview dispatch returns { card } only on success', () => {
  it('dash_overview_refresh: result.card is the rebuilt overview card; updateMessage NOT called', async () => {
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET' && req.path === '/__daemon/overview-snapshot') {
        return { status: 200, raw: '', body: sampleSnapshotBody() };
      }
      throw new Error('unexpected: ' + JSON.stringify(req));
    });
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: 'dash_overview_refresh', invoker_open_id: INVOKER } },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.toast).toBeUndefined();
    expect(result.card).toBeDefined();
    expect(result.card?.type).toBe('raw');
    const cardJson = JSON.stringify(result.card?.data);
    expect(cardJson).toContain('Dashboard 总览');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });

  it('dash_overview_goto_sessions: result.card is the sessions card body; updateMessage NOT called', async () => {
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET' && req.path === '/__daemon/sessions-list') {
        return {
          status: 200, raw: '',
          body: { sessions: [
            { sessionId: 's1', rootMessageId: 'om', chatId: 'oc', chatType: 'group',
              title: 'one', cliId: 'claude-code', workingDir: '~/x', status: 'working',
              lastMessageAt: 1_000_000, cliVersion: 'v', webPort: 7891, scope: 'thread',
              spawnedAt: 0, larkAppId: LARK_APP_ID, isOncall: false, hasHistory: true },
          ] },
        };
      }
      throw new Error('unexpected: ' + JSON.stringify(req));
    });
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: 'dash_overview_goto_sessions', invoker_open_id: INVOKER } },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.toast).toBeUndefined();
    expect(result.card).toBeDefined();
    expect(result.card?.type).toBe('raw');
    // Goto lands on the sessions card body, not the overview card.
    const cardJson = JSON.stringify(result.card?.data);
    expect(cardJson).toContain('Dashboard 会话');
    expect(cardJson).not.toContain('Dashboard 总览');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });
});
