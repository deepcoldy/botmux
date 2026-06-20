/**
 * PR3 `/dashboard overview` slice 1 — command dispatch + DM owner flow.
 *
 * Mirrors dashboard-sessions-command / dashboard-schedules-command: drives
 * `handleDashboardOverview` against a stubbed Route B client and asserts:
 *   - happy path: GET /__daemon/overview-snapshot → DM owner the overview
 *     card → topic gets `overview.dm_sent` confirmation.
 *   - upstream failures surface as `overview_failed` text in the topic.
 *   - dispatch from `/dashboard` (empty args) or `/dashboard overview` both
 *     reach the real handler (vs the C1 stub fallback).
 *   - non-owner is blocked at the owner gate before reaching the handler.
 */

import { describe, expect, it, vi } from 'vitest';

import type { CommandHandlerDeps } from '../src/core/command-handler.js';
import { handleDashboardCommand } from '../src/core/dashboard-command/index.js';
import { handleDashboardOverview } from '../src/core/dashboard-command/overview.js';
import type { LarkMessage } from '../src/types.js';

const LARK_APP_ID = 'cli_test';
const OWNER = 'ou_owner';

function makeMessage(over: Partial<LarkMessage> = {}): LarkMessage {
  return {
    senderId: OWNER,
    senderUnionId: undefined,
    content: '/dashboard overview',
    chatId: 'oc_test',
    rootMessageId: 'om_root',
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
  sendUserMessage: (larkAppId: string, openId: string, content: string, msgType?: string) => Promise<string>;
  calls: Array<{ openId: string; content: string; msgType?: string }>;
} {
  const calls: Array<{ openId: string; content: string; msgType?: string }> = [];
  return {
    sendUserMessage: async (_appId, openId, content, msgType) => {
      calls.push({ openId, content, msgType });
      return 'om_dm';
    },
    calls,
  };
}

function defaultSnapshotBody() {
  return {
    sessions: [
      { sessionId: 's1', rootMessageId: 'om_a', chatId: 'oc_a', chatType: 'group',
        title: 'one', cliId: 'claude-code', workingDir: '~/x', status: 'working',
        lastMessageAt: 1_000_000, cliVersion: 'v', webPort: 7891, scope: 'thread',
        spawnedAt: 0, larkAppId: LARK_APP_ID, isOncall: false, hasHistory: true },
    ],
    schedules: [
      { id: 's_1', name: 'daily-ping', enabled: true,
        parsed: { kind: 'cron', display: '0 9 * * *', expr: '0 9 * * *' },
        nextRunAt: '2026-06-09T13:00:00.000Z',
        lastRunAt: '2026-06-08T13:00:00.000Z',
        lastStatus: 'ok', larkAppId: LARK_APP_ID, chatId: 'oc_a' },
    ],
    settings: { publicReadOnly: false, openTerminalInFeishu: false, maintenance: {}, localDevInstall: false },
  };
}

describe('handleDashboardOverview (command path)', () => {
  it('happy: GET overview-snapshot → DM owner interactive card → topic dm_sent', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const requestSpy = vi.fn(async () => ({ status: 200, body: defaultSnapshotBody(), raw: '' }));
    const createClient = vi.fn(() => ({ request: requestSpy } as any));

    await handleDashboardOverview(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh' },
    );

    expect(requestSpy).toHaveBeenCalledOnce();
    // Global dashboard scope: `/dashboard` first-open MUST request
    // `?scope=global` so list modules surface cross-bot on the initial
    // card, matching the refresh-callback view.
    expect(requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/overview-snapshot?scope=global' });
    expect(dm.calls.length).toBe(1);
    expect(dm.calls[0].openId).toBe(OWNER);
    expect(dm.calls[0].msgType).toBe('interactive');
    expect(dm.calls[0].content).toContain('Dashboard 总览');

    const topicCalls = (deps.sessionReply as any).mock.calls;
    expect(topicCalls.length).toBe(1);
    expect(topicCalls[0][1]).toContain('📬');
    // Topic confirmation is NOT interactive.
    expect(topicCalls[0][2]).toBeUndefined();
  });

  it('Route B throws → topic overview_failed, NO DM', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({
      request: async () => { throw new Error('econnrefused'); },
    } as any));

    await handleDashboardOverview(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh' },
    );

    expect(dm.calls.length).toBe(0);
    const topicCalls = (deps.sessionReply as any).mock.calls;
    expect(topicCalls.length).toBe(1);
    expect(topicCalls[0][1]).toContain('拉取总览快照失败');
    expect(topicCalls[0][1]).toContain('econnrefused');
  });

  it('Route B 500 → topic overview_failed with http_500, NO DM', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({
      request: async () => ({ status: 500, body: {}, raw: '' }),
    } as any));

    await handleDashboardOverview(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh' },
    );

    expect(dm.calls.length).toBe(0);
    const topicCalls = (deps.sessionReply as any).mock.calls;
    expect(topicCalls.length).toBe(1);
    expect(topicCalls[0][1]).toContain('http_500');
  });

  it('DM send failure → topic dm_failed with reason', async () => {
    const deps = makeDeps();
    const createClient = vi.fn(() => ({
      request: async () => ({ status: 200, body: defaultSnapshotBody(), raw: '' }),
    } as any));
    const sendUserMessage = vi.fn(async () => { throw new Error('lark_dm_403'); });

    await handleDashboardOverview(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage, locale: 'zh' },
    );

    const topicCalls = (deps.sessionReply as any).mock.calls;
    // dm_failed uses the overview-scoped key — contains lark_dm_403.
    expect(topicCalls[0][1]).toContain('lark_dm_403');
  });
});

describe('handleDashboardCommand dispatches `/dashboard overview` to the real handler', () => {
  it('owner /dashboard overview → real handler invoked (DM contains 总览 title, not stub)', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({
      request: async () => ({ status: 200, body: defaultSnapshotBody(), raw: '' }),
    } as any));

    await handleDashboardCommand(
      makeMessage(), 'overview', 'om_root', 'oc_test', deps, LARK_APP_ID,
      {
        getOwnerOpenId: () => OWNER,
        sendUserMessage: dm.sendUserMessage,
        overview: { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh' },
      },
    );

    expect(dm.calls.length).toBe(1);
    // DM body is the real interactive card, not the i18n stub text.
    expect(dm.calls[0].content).toContain('Dashboard 总览');
    expect(dm.calls[0].content).not.toContain('🚧 `/dashboard overview`');
    expect(dm.calls[0].msgType).toBe('interactive');
  });

  it('owner /dashboard (empty args) → defaults to overview real handler', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({
      request: async () => ({ status: 200, body: defaultSnapshotBody(), raw: '' }),
    } as any));

    await handleDashboardCommand(
      makeMessage({ content: '/dashboard' }), '', 'om_root', 'oc_test', deps, LARK_APP_ID,
      {
        getOwnerOpenId: () => OWNER,
        sendUserMessage: dm.sendUserMessage,
        overview: { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh' },
      },
    );

    expect(dm.calls.length).toBe(1);
    expect(dm.calls[0].content).toContain('Dashboard 总览');
    // Should NOT have been routed to the stub.
    expect(dm.calls[0].content).not.toContain('🚧 `/dashboard overview`');
  });

  it('non-owner /dashboard overview → owner_only in topic, NEVER DMs', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({ request: vi.fn() } as any));

    await handleDashboardCommand(
      makeMessage({ senderId: 'ou_stranger' }), 'overview', 'om_root', 'oc_test', deps, LARK_APP_ID,
      {
        getOwnerOpenId: () => OWNER,
        sendUserMessage: dm.sendUserMessage,
        overview: { createClient, locale: 'zh' },
      },
    );

    expect(dm.calls.length).toBe(0);
    expect(createClient).not.toHaveBeenCalled();
    const topicCalls = (deps.sessionReply as any).mock.calls;
    expect(topicCalls[0][1]).toContain('🔒');
  });
});
