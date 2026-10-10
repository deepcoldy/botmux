import { describe, expect, it } from 'vitest';
import type { Session } from '../src/types.js';
import { durableSessionShadowProjection } from '../src/services/durable-session-shadow.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    title: 'sensitive title',
    status: 'active',
    createdAt: '2026-10-05T00:00:00.000Z',
    larkAppId: 'cli_app',
    ownerOpenId: 'ou_owner',
    workingDir: '/private/worktree',
    queuedPrompt: 'secret prompt',
    ...overrides,
  };
}

describe('durable Session shadow projection', () => {
  it('uses the stable thread key and copies only the audited fields', () => {
    expect(durableSessionShadowProjection(session({
      scope: 'thread',
      lastMessageAt: '2026-10-05T00:01:00.000Z',
    }))).toEqual({
      sessionKey: 'om_root::cli_app',
      value: {
        version: 1,
        type: 'botmux.session.shadow',
        sessionId: 'session-1',
        larkAppId: 'cli_app',
        anchorId: 'om_root',
        scope: 'thread',
        status: 'active',
        createdAt: '2026-10-05T00:00:00.000Z',
        lastMessageAt: '2026-10-05T00:01:00.000Z',
      },
    });
  });

  it('uses chatId for chat scope and carries the terminal lifecycle edge', () => {
    expect(durableSessionShadowProjection(session({
      scope: 'chat',
      status: 'closed',
      closedAt: '2026-10-05T00:02:00.000Z',
    }))).toMatchObject({
      sessionKey: 'oc_chat::cli_app',
      value: {
        anchorId: 'oc_chat',
        scope: 'chat',
        status: 'closed',
        closedAt: '2026-10-05T00:02:00.000Z',
      },
    });
  });

  it('rejects a row before its bot identity is committed', () => {
    expect(() => durableSessionShadowProjection(session({ larkAppId: undefined })))
      .toThrow(/larkAppId/);
  });
});
