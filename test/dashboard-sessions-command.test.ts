/**
 * PR3 `/dashboard sessions` slice 1 — command dispatch + DM owner flow.
 *
 * Mirrors the structure of dashboard-settings-smoke-c5: drives
 * `handleDashboardSessions` against a stubbed Route B client and asserts:
 *   - command-path: card is DM'd to the owner; topic gets `dm_sent`.
 *   - upstream failures surface as `list_failed` text in the topic.
 *   - dispatch from `/dashboard sessions` routes here (vs. stub fallback).
 */

import { describe, expect, it, vi } from 'vitest';

import type { CommandHandlerDeps } from '../src/core/command-handler.js';
import { handleDashboardCommand } from '../src/core/dashboard-command/index.js';
import { handleDashboardSessions } from '../src/core/dashboard-command/sessions.js';
import type { LarkMessage } from '../src/types.js';

const LARK_APP_ID = 'cli_test';
const OWNER = 'ou_owner';

function makeMessage(over: Partial<LarkMessage> = {}): LarkMessage {
  return {
    senderId: OWNER,
    senderUnionId: undefined,
    content: '/dashboard sessions',
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

describe('handleDashboardSessions (command path)', () => {
  it('happy: GET sessions-list → DM owner interactive card → topic gets dm_sent', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const requestSpy = vi.fn(async () => ({
      status: 200,
      body: { sessions: [
        { sessionId: 's1', rootMessageId: 'om_a', chatId: 'oc_a', chatType: 'group', title: 'one', cliId: 'claude-code', workingDir: '~/x', status: 'working', lastMessageAt: 1_000_000, cliVersion: 'v', webPort: 7891, scope: 'thread', spawnedAt: 0, larkAppId: LARK_APP_ID, isOncall: false, hasHistory: true },
      ] },
      raw: '',
    }));
    const createClient = vi.fn(() => ({ request: requestSpy } as any));

    await handleDashboardSessions(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh', nowMs: () => 2_000_000 },
    );

    expect(requestSpy).toHaveBeenCalledOnce();
    expect(requestSpy.mock.calls[0][0]).toEqual({ method: 'GET', path: '/__daemon/sessions-list?scope=global' });
    expect(dm.calls.length).toBe(1);
    expect(dm.calls[0].openId).toBe(OWNER);
    expect(dm.calls[0].msgType).toBe('interactive');
    expect(dm.calls[0].content).toContain('Dashboard 会话');
    expect(dm.calls[0].content).toContain('one');  // session title rendered

    const topicCalls = (deps.sessionReply as any).mock.calls;
    expect(topicCalls.length).toBe(1);
    expect(topicCalls[0][1]).toContain('📬');
    expect(topicCalls[0][2]).toBeUndefined();  // not interactive
  });

  it('empty list still DMs the card (with empty state)', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({
      request: async () => ({ status: 200, body: { sessions: [] }, raw: '' }),
    } as any));

    await handleDashboardSessions(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh', nowMs: () => 2_000_000 },
    );

    expect(dm.calls.length).toBe(1);
    expect(dm.calls[0].content).toContain('_当前没有会话_');
  });

  it('Route B throws → topic gets `list_failed` text, NO DM sent', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({
      request: async () => { throw new Error('econnrefused'); },
    } as any));

    await handleDashboardSessions(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh' },
    );

    expect(dm.calls.length).toBe(0);
    const topicCalls = (deps.sessionReply as any).mock.calls;
    expect(topicCalls.length).toBe(1);
    expect(topicCalls[0][1]).toContain('拉取会话列表失败');
    expect(topicCalls[0][1]).toContain('econnrefused');
  });

  it('Route B 5xx → topic gets `list_failed` with http_status reason, NO DM sent', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({
      request: async () => ({ status: 500, body: { error: 'oops' }, raw: '' }),
    } as any));

    await handleDashboardSessions(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh' },
    );

    expect(dm.calls.length).toBe(0);
    const topicCalls = (deps.sessionReply as any).mock.calls;
    expect(topicCalls[0][1]).toContain('http_500');
  });

  it('DM send failure → topic gets `dm_failed` with reason', async () => {
    const deps = makeDeps();
    const createClient = vi.fn(() => ({
      request: async () => ({ status: 200, body: { sessions: [] }, raw: '' }),
    } as any));
    const sendUserMessage = vi.fn(async () => { throw new Error('lark_dm_403'); });

    await handleDashboardSessions(
      makeMessage(), '', 'om_root', 'oc_test', deps, LARK_APP_ID, OWNER,
      { createClient, sendUserMessage, locale: 'zh' },
    );

    const topicCalls = (deps.sessionReply as any).mock.calls;
    expect(topicCalls[0][1]).toContain('lark_dm_403');
  });
});

describe('handleDashboardCommand dispatches `/dashboard sessions` to the real handler', () => {
  it('owner /dashboard sessions → real handler invoked (DM contains 会话 title, not stub)', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({
      request: async () => ({ status: 200, body: { sessions: [] }, raw: '' }),
    } as any));

    await handleDashboardCommand(
      makeMessage(), 'sessions', 'om_root', 'oc_test', deps, LARK_APP_ID,
      {
        getOwnerOpenId: () => OWNER,
        sendUserMessage: dm.sendUserMessage,
        // sendUserMessage must be in the inner deps too — the sessions handler
        // owns its own DM hook (DashboardSessionsCommandDeps.sendUserMessage).
        sessions: { createClient, sendUserMessage: dm.sendUserMessage, locale: 'zh', nowMs: () => 2_000_000 },
      },
    );

    expect(dm.calls.length).toBe(1);
    // DM body is the real interactive card, not the i18n stub text.
    expect(dm.calls[0].content).toContain('Dashboard 会话');
    expect(dm.calls[0].content).not.toContain('🚧');
    expect(dm.calls[0].msgType).toBe('interactive');
  });

  it('non-owner /dashboard sessions → owner_only in topic, NEVER DMs the list', async () => {
    const deps = makeDeps();
    const dm = captureDM();
    const createClient = vi.fn(() => ({ request: vi.fn() } as any));
    await handleDashboardCommand(
      makeMessage({ senderId: 'ou_stranger' }), 'sessions', 'om_root', 'oc_test', deps, LARK_APP_ID,
      {
        getOwnerOpenId: () => OWNER,
        sendUserMessage: dm.sendUserMessage,
        sessions: { createClient, locale: 'zh' },
      },
    );

    expect(dm.calls.length).toBe(0);
    expect(createClient).not.toHaveBeenCalled();
    const topicCalls = (deps.sessionReply as any).mock.calls;
    expect(topicCalls[0][1]).toContain('🔒');
  });
});
