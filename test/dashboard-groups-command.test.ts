/**
 * PR3 `/dashboard groups` slice 1 — command dispatch + DM owner flow.
 *
 * Mirrors dashboard-sessions-command: drives `handleDashboardGroups`
 * against a stubbed Route B client and asserts the command-path delivers
 * the matrix card to the owner DM and confirms via `dm_sent` in the topic.
 */

import { describe, expect, it, vi } from 'vitest';

import type { CommandHandlerDeps } from '../src/core/command-handler.js';
import { handleDashboardCommand } from '../src/core/dashboard-command/index.js';
import { handleDashboardGroups } from '../src/core/dashboard-command/groups.js';
import type { LarkMessage } from '../src/types.js';

const LARK_APP_ID = 'cli_test';
const OWNER = 'ou_owner';

function makeMessage(over: Partial<LarkMessage> = {}): LarkMessage {
  return {
    senderId: OWNER,
    senderUnionId: undefined,
    content: '/dashboard groups',
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

describe('handleDashboardGroups (command path)', () => {
  it('happy: GET groups-matrix → DM owner card → topic dm_sent', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const requestSpy = vi.fn(async () => ({
      status: 200,
      body: {
        chats: [{
          chatId: 'oc_one_groups',
          name: 'cool-room',
          memberBots: [{ larkAppId: LARK_APP_ID, botName: 'self', inChat: true, oncallChat: null }],
        }],
        bots: [{ larkAppId: LARK_APP_ID, botName: 'self' }],
      },
      raw: '',
    }));
    const createClient = vi.fn(() => ({ request: requestSpy } as any));

    await handleDashboardGroups(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh' },
    );

    expect(requestSpy).toHaveBeenCalledOnce();
    expect(requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/groups-matrix?scope=global' });
    expect(dm.calls.length).toBe(1);
    expect(dm.calls[0].openId).toBe(OWNER);
    expect(dm.calls[0].msgType).toBe('interactive');
    expect(dm.calls[0].content).toContain('Dashboard 群组');
    expect(dm.calls[0].content).toContain('cool-room');

    const topicCalls = (deps.sessionReply as any).mock.calls;
    expect(topicCalls.length).toBe(1);
    expect(topicCalls[0][1]).toContain('📬');
    expect(topicCalls[0][2]).toBeUndefined();  // not interactive
  });

  it('empty matrix still DMs (with empty state)', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({
      request: async () => ({ status: 200, body: { chats: [], bots: [] }, raw: '' }),
    } as any));

    await handleDashboardGroups(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh' },
    );

    expect(dm.calls.length).toBe(1);
    expect(dm.calls[0].content).toContain('_当前没有群_');
  });

  it('Route B throws → topic list_failed (no DM)', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({
      request: async () => { throw new Error('econnrefused'); },
    } as any));

    await handleDashboardGroups(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh' },
    );

    expect(dm.calls.length).toBe(0);
    const topicCalls = (deps.sessionReply as any).mock.calls;
    expect(topicCalls.length).toBe(1);
    expect(topicCalls[0][1]).toContain('拉取群组失败');
    expect(topicCalls[0][1]).toContain('econnrefused');
  });

  it('Route B 500 → topic list_failed (no DM)', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({
      request: async () => ({ status: 500, body: { error: 'oops' }, raw: '' }),
    } as any));

    await handleDashboardGroups(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh' },
    );

    expect(dm.calls.length).toBe(0);
    const topicCalls = (deps.sessionReply as any).mock.calls;
    expect(topicCalls[0][1]).toContain('oops');
  });

  it('DM send failure → topic dm_failed with reason', async () => {
    const deps = makeDeps();
    const createClient = vi.fn(() => ({
      request: async () => ({ status: 200, body: { chats: [], bots: [] }, raw: '' }),
    } as any));
    const sendUserMessage = vi.fn(async () => { throw new Error('lark_dm_403'); });

    await handleDashboardGroups(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage, locale: 'zh' },
    );

    const topicCalls = (deps.sessionReply as any).mock.calls;
    expect(topicCalls[0][1]).toContain('lark_dm_403');
  });
});

describe('handleDashboardCommand dispatches `/dashboard groups` to the real handler', () => {
  it('owner /dashboard groups → real handler invoked (DM contains 群组 title, not stub)', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({
      request: async () => ({ status: 200, body: { chats: [], bots: [] }, raw: '' }),
    } as any));

    await handleDashboardCommand(
      makeMessage(), 'groups', 'om_root', 'oc_test', deps, LARK_APP_ID,
      {
        getOwnerOpenId: () => OWNER,
        sendUserMessage: dm.sendUserMessage,
        groups: { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh' },
      },
    );

    expect(dm.calls.length).toBe(1);
    expect(dm.calls[0].content).toContain('Dashboard 群组');
    // Real handler renders the empty-state card body, NOT the stub `🚧` text.
    expect(dm.calls[0].content).not.toContain('🚧');
    expect(dm.calls[0].msgType).toBe('interactive');
  });

  it('non-owner /dashboard groups → owner_only in topic, NEVER DMs', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({ request: vi.fn() } as any));
    await handleDashboardCommand(
      makeMessage({ senderId: 'ou_stranger' }), 'groups', 'om_root', 'oc_test', deps, LARK_APP_ID,
      {
        getOwnerOpenId: () => OWNER,
        sendUserMessage: dm.sendUserMessage,
        groups: { createClient, locale: 'zh' },
      },
    );

    expect(dm.calls.length).toBe(0);
    expect(createClient).not.toHaveBeenCalled();
    const topicCalls = (deps.sessionReply as any).mock.calls;
    expect(topicCalls[0][1]).toContain('🔒');
  });
});
