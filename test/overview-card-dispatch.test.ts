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
      // Global dashboard scope: overview-snapshot is fetched with
      // `?scope=global` so list modules are returned cross-bot.
      if (req.method === 'GET' && req.path === '/__daemon/overview-snapshot?scope=global') {
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
      if (req.method === 'GET' && req.path === '/__daemon/sessions-list?scope=global') {
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
    expect(cardJson).toContain('"dashboard_scope":"global"');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });

  /** ─── Overview drilldown (2026-06-10) ───
   *  Verifies the 3 goto handlers thread `origin=overview` into the sub-card
   *  body (no `pageSize` — global default is 5/page after unification, so
   *  drilldown doesn't need to override). The footer of each sub-card
   *  renders "↩ 总览" via the shared `dash_overview_refresh` action so
   *  the parent overview rebuilds without a custom return route. */
  describe('overview drilldown — goto threads origin into sub-card', () => {
    function makeRows(n: number) {
      return Array.from({ length: n }, (_, i) => ({
        sessionId: `s_${i}`,
        rootMessageId: 'om',
        chatId: 'oc',
        chatType: 'group',
        title: `t${i}`,
        cliId: 'claude-code',
        workingDir: '~/x',
        status: 'idle',
        lastMessageAt: 1_000_000 - i * 100,
        cliVersion: 'v',
        webPort: 7891,
        scope: 'thread',
        spawnedAt: 0,
        larkAppId: LARK_APP_ID,
        isOncall: false,
        hasHistory: true,
      }));
    }

    it('goto_sessions → sessions card has 5/page, ↩ 总览, origin/page_size on all child buttons', async () => {
      // 12 rows → with pageSize=5, 3 pages, select_static jump appears.
      const rows = makeRows(12);
      const requestSpy = vi.fn(async () => ({ status: 200, raw: '', body: { sessions: rows } }));
      mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

      const data: CardActionData = {
        operator: { open_id: INVOKER },
        action: { value: { action: 'dash_overview_goto_sessions', invoker_open_id: INVOKER } },
        context: { open_message_id: 'om_card' },
      };
      const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

      expect(result.card).toBeDefined();
      const cardJson = JSON.stringify(result.card?.data);

      // 1) 5/page → 12 rows → 3 pages (PAGE_SIZE=5 default after 2026-06-10 unification).
      expect(cardJson).toContain('第 1/3 页');

      // 2) Back-to-overview button present.
      expect(cardJson).toContain('"action":"dash_overview_refresh"');
      expect(cardJson).toContain('↩ 总览');

      // 3) Origin threaded onto button.value. page_size is OMITTED when
      //    effective size equals default (5 == PAGE_SIZE) — origin alone is
      //    the canonical drilldown signal.
      expect(cardJson).toContain('"origin":"overview"');
      expect(cardJson).not.toContain('"page_size"');

      // 4) select_static jump-page picker present (3 pages > 2).
      expect(cardJson).toContain('select_static');
    });

    it('goto_schedules → schedules card has 5/page, ↩ 总览, origin threaded (page_size omitted at default)', async () => {
      const tasks = Array.from({ length: 12 }, (_, i) => ({
        id: `sch_${i}`,
        name: `daily-${i}`,
        prompt: 'say hi',
        parsed: { kind: 'cron', display: '0 9 * * *', expr: '0 9 * * *' },
        enabled: true,
        larkAppId: LARK_APP_ID,
        chatId: 'oc',
        nextRunAt: `2026-06-09T13:0${i % 10}:00.000Z`,
        lastRunAt: '2026-06-08T13:00:00.000Z',
        lastStatus: 'ok',
      }));
      const requestSpy = vi.fn(async () => ({ status: 200, raw: '', body: { schedules: tasks } }));
      mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

      const data: CardActionData = {
        operator: { open_id: INVOKER },
        action: { value: { action: 'dash_overview_goto_schedules', invoker_open_id: INVOKER } },
        context: { open_message_id: 'om_card' },
      };
      const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

      expect(result.card).toBeDefined();
      const cardJson = JSON.stringify(result.card?.data);
      // PAGE_SIZE=5 (unified 2026-06-10). 12 / 5 = 3 pages.
      expect(cardJson).toContain('第 1/3 页');
      expect(cardJson).toContain('"action":"dash_overview_refresh"');
      expect(cardJson).toContain('↩ 总览');
      expect(cardJson).toContain('"origin":"overview"');
      // page_size omitted: drilldown uses default (5 == PAGE_SIZE).
      expect(cardJson).not.toContain('"page_size"');
    });

    it('goto_settings → settings card has ↩ 总览 + origin on every action.value; NO page_size', async () => {
      const requestSpy = vi.fn(async () => ({
        status: 200, raw: '',
        body: { settings: { publicReadOnly: false, openTerminalInFeishu: false, maintenance: {}, localDevInstall: false } },
      }));
      mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

      const data: CardActionData = {
        operator: { open_id: INVOKER },
        action: { value: { action: 'dash_overview_goto_settings', invoker_open_id: INVOKER } },
        context: { open_message_id: 'om_card' },
      };
      const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

      expect(result.card).toBeDefined();
      const cardJson = JSON.stringify(result.card?.data);
      // Settings sub-card.
      expect(cardJson).toContain('Dashboard 全局设置');
      // Back-to-overview button + origin threaded.
      expect(cardJson).toContain('"action":"dash_overview_refresh"');
      expect(cardJson).toContain('↩ 总览');
      expect(cardJson).toContain('"origin":"overview"');
      // Settings single-layer → never carries page_size.
      expect(cardJson).not.toContain('"page_size"');
    });

    it('goto_groups → groups card has ↩ 总览 + origin threaded; pageSize at default omits page_size', async () => {
      const chats = Array.from({ length: 12 }, (_, i) => ({
        chatId: `oc_${String(i).padStart(4, '0')}`,
        name: `chat-${i}`,
        memberBots: [{ larkAppId: LARK_APP_ID, botName: 'self', inChat: true, oncallChat: null }],
      }));
      const requestSpy = vi.fn(async (req: any) => {
        if (req.path === '/__daemon/groups-matrix?scope=global') {
          return { status: 200, raw: '', body: { chats, bots: [{ larkAppId: LARK_APP_ID, botName: 'self' }] } };
        }
        throw new Error('unexpected: ' + JSON.stringify(req));
      });
      mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

      const data: CardActionData = {
        operator: { open_id: INVOKER },
        action: { value: { action: 'dash_overview_goto_groups', invoker_open_id: INVOKER } },
        context: { open_message_id: 'om_card' },
      };
      const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

      expect(result.card).toBeDefined();
      const cardJson = JSON.stringify(result.card?.data);
      // Groups sub-card.
      expect(cardJson).toContain('Dashboard 群组');
      // PAGE_SIZE=5 → 12 chats / 5 = 3 pages.
      expect(cardJson).toContain('第 1/3 页');
      // Back-to-overview + origin.
      expect(cardJson).toContain('"action":"dash_overview_refresh"');
      expect(cardJson).toContain('↩ 总览');
      expect(cardJson).toContain('"origin":"overview"');
      expect(cardJson).toContain('"dashboard_scope":"global"');
      // page_size omitted at default.
      expect(cardJson).not.toContain('"page_size"');
    });

  });
});
