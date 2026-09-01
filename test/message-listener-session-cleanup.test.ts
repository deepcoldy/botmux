import { describe, expect, it } from 'vitest';
import { selectExpiredMessageListenerSessions } from '../src/services/message-listener-session-cleanup.js';
import type { MessageListenerConfig } from '../src/bot-registry.js';
import type { Session } from '../src/types.js';

const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
const hour = 60 * 60 * 1000;

function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    sessionId: id,
    chatId: 'oc_chat',
    chatType: 'group',
    rootMessageId: `om_${id}`,
    title: '<message_listener> alert',
    status: 'active',
    createdAt: new Date(NOW - 200 * hour).toISOString(),
    lastUserPrompt: '<message_listener> alert',
    larkAppId: 'cli_listener',
    scope: 'thread',
    ...patch,
  };
}

describe('message listener session cleanup', () => {
  it('selects active listener sessions older than the configured retention', () => {
    const listeners: Record<string, MessageListenerConfig> = {
      oc_chat: {
        enabled: true,
        prompt: 'listen',
        cleanup: { enabled: true, retentionHours: 168 },
      },
    };

    const selected = selectExpiredMessageListenerSessions({
      sessions: [
        session('old-listener'),
        session('fresh-listener', { createdAt: new Date(NOW - 2 * hour).toISOString() }),
        session('manual-old', { lastUserPrompt: '@bot help', title: '@bot help' }),
        session('other-chat', { chatId: 'oc_other' }),
        session('closed-old', { status: 'closed' }),
      ],
      listeners,
      nowMs: NOW,
    });

    expect(selected.map(s => s.sessionId)).toEqual(['old-listener']);
  });

  it('uses enabled seven-day cleanup by default and honors disabled cleanup', () => {
    expect(selectExpiredMessageListenerSessions({
      sessions: [session('eight-days', { createdAt: new Date(NOW - 8 * 24 * hour).toISOString() })],
      listeners: { oc_chat: { enabled: true, prompt: 'listen' } },
      nowMs: NOW,
    }).map(s => s.sessionId)).toEqual(['eight-days']);

    expect(selectExpiredMessageListenerSessions({
      sessions: [session('old-but-disabled')],
      listeners: { oc_chat: { enabled: true, prompt: 'listen', cleanup: { enabled: false, retentionHours: 24 } } },
      nowMs: NOW,
    })).toEqual([]);
  });

  it('bases age on last activity when available', () => {
    const listeners: Record<string, MessageListenerConfig> = {
      oc_chat: { enabled: true, prompt: 'listen', cleanup: { enabled: true, retentionHours: 24 } },
    };

    expect(selectExpiredMessageListenerSessions({
      sessions: [
        session('recent-activity', {
          createdAt: new Date(NOW - 72 * hour).toISOString(),
          lastMessageAt: new Date(NOW - 2 * hour).toISOString(),
        }),
        session('old-activity', {
          createdAt: new Date(NOW - 72 * hour).toISOString(),
          lastMessageAt: new Date(NOW - 25 * hour).toISOString(),
        }),
      ],
      listeners,
      nowMs: NOW,
    }).map(s => s.sessionId)).toEqual(['old-activity']);
  });

  it('recognizes explicitly stamped listener sessions without marker text', () => {
    expect(selectExpiredMessageListenerSessions({
      sessions: [
        session('stamped', {
          title: '告警自动分析',
          lastUserPrompt: '分析原因',
          messageListener: { chatId: 'oc_chat' },
        }),
      ],
      listeners: { oc_chat: { enabled: true, prompt: 'listen', cleanup: { enabled: true, retentionHours: 24 } } },
      nowMs: NOW,
    }).map(s => s.sessionId)).toEqual(['stamped']);
  });

  it('recognizes legacy listener sessions renamed by later user activity', () => {
    expect(selectExpiredMessageListenerSessions({
      sessions: [
        session('renamed-legacy-listener', {
          title: '告警分析',
          nativeSessionTitle: '<message_listener> alert',
          lastUserPrompt: '@bot follow up',
        }),
      ],
      listeners: { oc_chat: { enabled: true, prompt: 'listen', cleanup: { enabled: true, retentionHours: 24 } } },
      nowMs: NOW,
    }).map(s => s.sessionId)).toEqual(['renamed-legacy-listener']);
  });
});
