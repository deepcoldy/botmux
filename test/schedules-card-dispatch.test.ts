/**
 * PR3 `/dashboard schedules` slice 1 — production dispatch path.
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

describe('handleCardAction → schedules dispatch returns { card } only on success', () => {
  it('refresh: result.card is the rebuilt list card; updateMessage NOT called on fast path', async () => {
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET' && req.path === '/__daemon/schedules-list') {
        return {
          status: 200, raw: '',
          body: { schedules: [
            { id: 'sch1', name: 'daily-ping', enabled: true,
              parsed: { kind: 'cron', display: '0 9 * * *', expr: '0 9 * * *' },
              nextRunAt: '2026-06-09T13:00:00.000Z', lastRunAt: '2026-06-08T13:00:00.000Z',
              lastStatus: 'ok', larkAppId: LARK_APP_ID, chatId: 'oc' },
          ] },
        };
      }
      throw new Error('unexpected: ' + JSON.stringify(req));
    });
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: 'dash_schedules_refresh', invoker_open_id: INVOKER } },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.toast).toBeUndefined();
    expect(result.card).toBeDefined();
    const cardJson = JSON.stringify(result.card?.data);
    expect(cardJson).toContain('Dashboard 定时任务');
    expect(cardJson).toContain('daily-ping');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });

  it('page: result.card reflects requested page; updateMessage NOT called', async () => {
    const tasks = Array.from({ length: 25 }, (_, i) => ({
      id: `t_${i}`, name: `task-${i}`, enabled: true,
      parsed: { kind: 'cron', display: '0 9 * * *', expr: '0 9 * * *' },
      nextRunAt: `2026-06-09T${String(13 + (i % 10)).padStart(2, '0')}:00:00.000Z`,
      lastRunAt: '2026-06-08T13:00:00.000Z', lastStatus: 'ok',
      larkAppId: LARK_APP_ID, chatId: 'oc',
    }));
    const requestSpy = vi.fn(async () => ({ status: 200, raw: '', body: { schedules: tasks } }));
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: 'dash_schedules_page', invoker_open_id: INVOKER, page: '2' } },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.card).toBeDefined();
    // PAGE_SIZE=5 (unified 2026-06-10). 25 / 5 = 5 pages.
    expect(JSON.stringify(result.card?.data)).toContain('第 2/5 页');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });

  // ─── Slice 2a: detail + pause dispatch ──────────────────────────────
  it('detail: fast path returns { card } with detail body; updateMessage NOT called', async () => {
    const tasks = [
      { id: 'sch_detail', name: 'detail me', enabled: true,
        parsed: { kind: 'cron', display: '0 9 * * *', expr: '0 9 * * *' },
        nextRunAt: '2026-06-09T13:00:00.000Z', lastRunAt: '2026-06-08T13:00:00.000Z',
        lastStatus: 'ok', larkAppId: LARK_APP_ID, chatId: 'oc' },
    ];
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET' && req.path === '/__daemon/schedules-list') {
        return { status: 200, raw: '', body: { schedules: tasks } };
      }
      throw new Error('unexpected: ' + JSON.stringify(req));
    });
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: 'dash_schedules_detail', invoker_open_id: INVOKER, schedule_id: 'sch_detail' } },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.toast).toBeUndefined();
    expect(result.card).toBeDefined();
    const cardJson = JSON.stringify(result.card?.data);
    expect(cardJson).toContain('定时任务详情');
    expect(cardJson).toContain('dash_schedules_pause');
    expect(cardJson).toContain('dash_schedules_resume');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });

  it('pause (happy): returns { card } with enabled=false detail; updateMessage NOT called', async () => {
    const tasks = [
      { id: 'sch_pause', name: 'pause me', enabled: true,
        parsed: { kind: 'cron', display: '0 9 * * *', expr: '0 9 * * *' },
        nextRunAt: '2026-06-09T13:00:00.000Z', lastRunAt: '2026-06-08T13:00:00.000Z',
        lastStatus: 'ok', larkAppId: LARK_APP_ID, chatId: 'oc' },
    ];
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET' && req.path === '/__daemon/schedules-list') {
        return { status: 200, raw: '', body: { schedules: tasks } };
      }
      if (req.method === 'POST' && req.path === '/__daemon/schedules/sch_pause/pause') {
        return { status: 200, raw: '', body: { ok: true } };
      }
      throw new Error('unexpected: ' + JSON.stringify(req));
    });
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: 'dash_schedules_pause', invoker_open_id: INVOKER, schedule_id: 'sch_pause' } },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.toast).toBeUndefined();
    expect(result.card).toBeDefined();
    const cardJson = JSON.stringify(result.card?.data);
    // synth-detail with enabled=false → renders the paused disabled note.
    expect(cardJson).toContain('定时任务详情');
    expect(cardJson).toContain('"disabled":true');
    expect(cardJson).toContain('任务已暂停');

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });

  it('pause (snapshot already paused): { toast }, no card, updateMessage NOT called', async () => {
    const tasks = [
      { id: 'sch_alreadypaused', name: 'already paused', enabled: false,
        parsed: { kind: 'cron', display: '0 9 * * *', expr: '0 9 * * *' },
        nextRunAt: '2026-06-09T13:00:00.000Z', lastRunAt: '2026-06-08T13:00:00.000Z',
        lastStatus: 'ok', larkAppId: LARK_APP_ID, chatId: 'oc' },
    ];
    const postSpy = vi.fn();
    const requestSpy = vi.fn(async (req: any) => {
      if (req.method === 'GET' && req.path === '/__daemon/schedules-list') {
        return { status: 200, raw: '', body: { schedules: tasks } };
      }
      // SECURITY: handler MUST refuse to POST when snapshot disagrees with
      // the click. Track if any POST sneaks past.
      postSpy(req);
      throw new Error('unexpected POST: ' + JSON.stringify(req));
    });
    mockedCreateClient.mockReturnValue({ request: requestSpy } as any);

    const data: CardActionData = {
      operator: { open_id: INVOKER },
      action: { value: { action: 'dash_schedules_pause', invoker_open_id: INVOKER, schedule_id: 'sch_alreadypaused' } },
      context: { open_message_id: 'om_card' },
    };
    const result = await handleCardAction(data, makeDeps(), LARK_APP_ID);

    expect(result.toast?.content).toContain('任务已暂停');
    expect(result.card).toBeUndefined();
    // Server-side matrix check: pause POST MUST NOT have been issued.
    expect(postSpy).not.toHaveBeenCalled();

    await new Promise(resolve => setImmediate(resolve));
    expect(mockedUpdateMessage).not.toHaveBeenCalled();
  });
});
