/**
 * PR3 `/dashboard schedules` slice 1 — command dispatch + DM owner flow.
 */

import { describe, expect, it, vi } from 'vitest';

import type { CommandHandlerDeps } from '../src/core/command-handler.js';
import { handleDashboardCommand } from '../src/core/dashboard-command/index.js';
import { handleDashboardSchedules } from '../src/core/dashboard-command/schedules.js';
import type { LarkMessage } from '../src/types.js';

const LARK_APP_ID = 'cli_test';
const OWNER = 'ou_owner';

function makeMessage(over: Partial<LarkMessage> = {}): LarkMessage {
  return {
    senderId: OWNER, senderUnionId: undefined,
    content: '/dashboard schedules', chatId: 'oc_test', rootMessageId: 'om_root',
    ...over,
  } as LarkMessage;
}

function makeDeps(): CommandHandlerDeps {
  return {
    activeSessions: new Map() as any,
    sessionReply: vi.fn(async () => 'om_reply'),
    getActiveCount: () => 0,
    lastRepoScan: new Map() as any,
  };
}

function captureDM(): {
  sendUserMessage: (a: string, o: string, c: string, m?: string) => Promise<string>;
  calls: Array<{ openId: string; content: string; msgType?: string }>;
} {
  const calls: Array<{ openId: string; content: string; msgType?: string }> = [];
  return {
    sendUserMessage: async (_a, openId, content, msgType) => {
      calls.push({ openId, content, msgType });
      return 'om_dm';
    },
    calls,
  };
}

function sampleTask() {
  return {
    id: 's_1', name: 'daily-ping', enabled: true,
    parsed: { kind: 'cron', display: '0 9 * * *', expr: '0 9 * * *' },
    nextRunAt: '2026-06-09T13:00:00.000Z',
    lastRunAt: '2026-06-08T13:00:00.000Z',
    lastStatus: 'ok',
    larkAppId: LARK_APP_ID, chatId: 'oc_a',
  };
}

describe('handleDashboardSchedules (command path)', () => {
  it('happy: GET schedules-list → DM owner card → topic gets dm_sent', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const requestSpy = vi.fn(async () => ({ status: 200, body: { schedules: [sampleTask()] }, raw: '' }));
    const createClient = vi.fn(() => ({ request: requestSpy } as any));

    await handleDashboardSchedules(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh', nowMs: () => Date.parse('2026-06-09T12:00:00.000Z') },
    );

    expect(requestSpy).toHaveBeenCalledOnce();
    // global-schedules slice (2026-06-11): standalone `/dashboard schedules`
    // is also part of the global tool-panel — first-open GET MUST carry
    // `?scope=global` so the card shows schedules from any bot, not just
    // the caller. Without this lock the entry-scope could silently drift
    // back to per-bot and the regression would only surface in production.
    expect(requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/schedules-list?scope=global' });
    expect(dm.calls.length).toBe(1);
    expect(dm.calls[0].openId).toBe(OWNER);
    expect(dm.calls[0].msgType).toBe('interactive');
    expect(dm.calls[0].content).toContain('Dashboard 定时任务');
    expect(dm.calls[0].content).toContain('daily-ping');

    const topicCalls = (deps.sessionReply as any).mock.calls;
    expect(topicCalls.length).toBe(1);
    expect(topicCalls[0][1]).toContain('📬');
    expect(topicCalls[0][2]).toBeUndefined();
  });

  it('empty list still DMs the card with empty state', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({
      request: async () => ({ status: 200, body: { schedules: [] }, raw: '' }),
    } as any));

    await handleDashboardSchedules(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh', nowMs: () => 0 },
    );

    expect(dm.calls.length).toBe(1);
    expect(dm.calls[0].content).toContain('_当前没有定时任务_');
  });

  it('Route B throws → topic gets list_failed, NO DM', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({
      request: async () => { throw new Error('econnrefused'); },
    } as any));

    await handleDashboardSchedules(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh' },
    );

    expect(dm.calls.length).toBe(0);
    const topicCalls = (deps.sessionReply as any).mock.calls;
    expect(topicCalls[0][1]).toContain('拉取定时任务列表失败');
    expect(topicCalls[0][1]).toContain('econnrefused');
  });

  it('Route B 500 → topic list_failed with http_500, NO DM', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({
      request: async () => ({ status: 500, body: {}, raw: '' }),
    } as any));

    await handleDashboardSchedules(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh' },
    );

    expect(dm.calls.length).toBe(0);
    expect((deps.sessionReply as any).mock.calls[0][1]).toContain('http_500');
  });

  it('DM send failure → topic gets dm_failed with reason', async () => {
    const deps = makeDeps();
    const createClient = vi.fn(() => ({
      request: async () => ({ status: 200, body: { schedules: [] }, raw: '' }),
    } as any));
    const sendUserMessage = vi.fn(async () => { throw new Error('lark_403'); });

    await handleDashboardSchedules(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage, locale: 'zh' },
    );
    expect((deps.sessionReply as any).mock.calls[0][1]).toContain('lark_403');
  });
});

describe('handleDashboardCommand routes `/dashboard schedules` to the real handler', () => {
  it('owner /dashboard schedules → real handler invoked (DM contains 定时任务 title)', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({
      request: async () => ({ status: 200, body: { schedules: [] }, raw: '' }),
    } as any));

    await handleDashboardCommand(
      makeMessage(), 'schedules', 'om_root', 'oc_test', deps, LARK_APP_ID,
      {
        getOwnerOpenId: () => OWNER,
        sendUserMessage: dm.sendUserMessage,
        schedules: { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh', nowMs: () => 0 },
      },
    );

    expect(dm.calls.length).toBe(1);
    expect(dm.calls[0].content).toContain('Dashboard 定时任务');
    expect(dm.calls[0].content).not.toContain('🚧');
    expect(dm.calls[0].msgType).toBe('interactive');
  });

  it('non-owner /dashboard schedules → owner_only in topic, NEVER DMs', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({ request: vi.fn() } as any));

    await handleDashboardCommand(
      makeMessage({ senderId: 'ou_stranger' }), 'schedules', 'om_root', 'oc_test', deps, LARK_APP_ID,
      {
        getOwnerOpenId: () => OWNER,
        sendUserMessage: dm.sendUserMessage,
        schedules: { createClient, locale: 'zh' },
      },
    );

    expect(dm.calls.length).toBe(0);
    expect(createClient).not.toHaveBeenCalled();
    expect((deps.sessionReply as any).mock.calls[0][1]).toContain('🔒');
  });
});
