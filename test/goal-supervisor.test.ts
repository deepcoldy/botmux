import { afterEach, describe, expect, it } from 'vitest';
import {
  buildGoalParentNotificationPrompt,
  buildGoalSupervisorPrompt,
  ensureGoalSupervisorFromRegistry,
  findGoalParentSession,
} from '../src/core/goal-supervisor.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import { _resetGoalChatStoreForTest } from '../src/services/goal-chat-store.js';

afterEach(() => {
  _resetGoalChatStoreForTest();
});

function ds(input: {
  sessionId: string;
  chatId: string;
  rootMessageId?: string;
  title: string;
  scope?: 'chat' | 'thread';
  larkAppId?: string;
  goalSupervisor?: DaemonSession['session']['goalSupervisor'];
}): DaemonSession {
  return {
    session: {
      sessionId: input.sessionId,
      chatId: input.chatId,
      rootMessageId: input.rootMessageId ?? input.chatId,
      scope: input.scope ?? 'chat',
      title: input.title,
      status: 'active',
      createdAt: new Date(0).toISOString(),
      larkAppId: input.larkAppId ?? 'cli_main',
      goalSupervisor: input.goalSupervisor,
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: input.larkAppId ?? 'cli_main',
    chatId: input.chatId,
    chatType: 'group',
    scope: input.scope ?? 'chat',
    spawnedAt: 0,
    cliVersion: 'test',
    lastMessageAt: 0,
    hasHistory: false,
  };
}

describe('goal supervisor prompt', () => {
  it('pins L2 duties to goal chat, ledger and L1 callback coordinates', () => {
    const prompt = buildGoalSupervisorPrompt({
      chatId: 'oc_goal',
      parentChatId: 'oc_main',
      parentRoot: 'om_root',
      title: '交付可信验收',
      brief: '先整理 charter，再派一个 worker。',
    });

    expect(prompt).toContain('L2 监管 agent');
    expect(prompt).toContain('botmux goal charter current --goal oc_goal --create');
    expect(prompt).toContain('botmux goal charter read --goal oc_goal --json');
    expect(prompt).toContain('botmux goal charter update --goal oc_goal --expected-updated-at');
    expect(prompt).toContain('botmux delivery list --goal oc_goal');
    expect(prompt).toContain('botmux dispatch --chat-id <本 goal 群 chatId>');
    expect(prompt).toContain('L1 主群 chatId: oc_main');
    expect(prompt).toContain('L1 主话题 rootMessageId: om_root');
    expect(prompt).toContain('botmux goal notify-parent --summary');
    expect(prompt).not.toContain('botmux send --chat-id oc_main');
    expect(prompt).toContain('先整理 charter');
    expect(prompt).not.toContain('<whiteboard');
  });

  it('locates the L1 parent session from structured supervisor metadata', () => {
    const active = new Map<string, DaemonSession>();
    const parent = ds({
      sessionId: 'parent-s1',
      chatId: 'oc_main',
      rootMessageId: 'om_main',
      title: 'L1',
      scope: 'chat',
    });
    const supervisor = ds({
      sessionId: 'l2-s1',
      chatId: 'oc_goal',
      title: '[Goal] Delivery',
      goalSupervisor: {
        goalChatId: 'oc_goal',
        title: 'Delivery',
        parentChatId: 'oc_main',
        parentRoot: 'om_main',
        parentSessionId: 'parent-s1',
        createdAt: new Date(0).toISOString(),
      },
    });
    active.set(sessionKey(parent.chatId, parent.larkAppId), parent);
    active.set(sessionKey(supervisor.chatId, supervisor.larkAppId), supervisor);

    expect(findGoalParentSession(active, 'cli_main', supervisor)?.session.sessionId).toBe('parent-s1');
  });

  it('builds a parent notification prompt that tells L1 to verify against ledger state', () => {
    const supervisor = ds({
      sessionId: 'l2-s1',
      chatId: 'oc_goal',
      title: '[Goal] Delivery',
      goalSupervisor: {
        goalChatId: 'oc_goal',
        title: 'Delivery',
        parentChatId: 'oc_main',
        createdAt: new Date(0).toISOString(),
      },
    });

    const prompt = buildGoalParentNotificationPrompt(supervisor, '全部任务 accepted。');

    expect(prompt).toContain('[goal-parent-notify]');
    expect(prompt).toContain('goal: Delivery');
    expect(prompt).toContain('goalChatId: oc_goal');
    expect(prompt).toContain('全部任务 accepted。');
    expect(prompt).toContain('账本仍是真相源');
  });

  it('does not auto-revive a goal that cleanup has closed', async () => {
    _resetGoalChatStoreForTest([{
      chatId: 'oc_goal',
      title: 'Closed goal',
      larkAppId: 'cli_main',
      parentChatId: 'oc_parent',
      closedAt: new Date(1000).toISOString(),
      closedBy: 'ou_owner',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(1000).toISOString(),
    }]);

    const result = await ensureGoalSupervisorFromRegistry('oc_goal', {
      larkAppId: 'cli_main',
      activeSessions: new Map(),
    }, { now: 2000 });

    expect(result).toEqual({
      ok: false,
      goalChatId: 'oc_goal',
      errorCode: 'goal_closed',
      error: 'goal chat was closed at 1970-01-01T00:00:01.000Z',
    });
  });
});
