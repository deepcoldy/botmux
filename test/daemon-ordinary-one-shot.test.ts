/**
 * Direct orchestration coverage for an ordinary per-message TraeX session.
 *
 * Run: pnpm vitest run --project unit test/daemon-ordinary-one-shot.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let sequence = 0;
  const sessions = new Map<string, any>();
  return {
    sessions,
    createSession: vi.fn((
      chatId: string,
      rootMessageId: string,
      title: string,
      chatType?: 'group' | 'p2p',
      scope?: 'thread' | 'chat',
      intent?: { oneShot?: any; initialize?: (row: any) => void },
    ) => {
      const row: any = {
        sessionId: `one-shot-session-${++sequence}`,
        chatId,
        rootMessageId,
        title,
        chatType,
        scope,
        status: 'active',
        createdAt: new Date().toISOString(),
        ...(intent?.oneShot ? { oneShot: structuredClone(intent.oneShot) } : {}),
      };
      // Match the store contract: the trusted initializer is applied before
      // the first durable insert / before the row becomes observable.
      intent?.initialize?.(row);
      sessions.set(row.sessionId, structuredClone(row));
      return row;
    }),
    closeSession: vi.fn((sessionId: string) => {
      const row = sessions.get(sessionId);
      if (row) row.status = 'closed';
    }),
    closeSessionForBackgroundCleanup: vi.fn(),
    updateSession: vi.fn(),
    forkWorker: vi.fn(),
    downloadResources: vi.fn(async () => ({ attachments: [], needLogin: false })),
    buildNewTopicCliInput: vi.fn(),
    replyMessage: vi.fn(async () => 'om_notice'),
    resolveSender: vi.fn(async (_appId: string, openId: string) => ({
      openId, type: 'user' as const, name: 'Alice',
    })),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return {
    ...actual,
    createSession: (...args: any[]) => (mocks.createSession as any)(...args),
    closeSession: (...args: any[]) => (mocks.closeSession as any)(...args),
    updateSession: (...args: any[]) => (mocks.updateSession as any)(...args),
  };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return {
    ...actual,
    forkWorker: (...args: any[]) => (mocks.forkWorker as any)(...args),
    closeSessionForBackgroundCleanup: (...args: any[]) =>
      (mocks.closeSessionForBackgroundCleanup as any)(...args),
  };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return {
    ...actual,
    downloadResources: (...args: any[]) => (mocks.downloadResources as any)(...args),
    buildNewTopicCliInput: (...args: any[]) => (mocks.buildNewTopicCliInput as any)(...args),
  };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return {
    ...actual,
    resolveSender: (...args: any[]) => (mocks.resolveSender as any)(...args),
  };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    replyMessage: (...args: any[]) => (mocks.replyMessage as any)(...args),
  };
});

import { registerBot } from '../src/bot-registry.js';
import { sessionKey } from '../src/core/types.js';
import { ordinaryOneShotVisibleLaneKey } from '../src/im/lark/event-dispatcher.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleOrdinaryOneShot as handleOrdinaryOneShot,
  __testOnly_ordinaryOneShotLanes as oneShotLanes,
  __testOnly_claimOrdinaryOneShotStartupOccupancy as claimStartupOccupancy,
} from '../src/daemon.js';

const APP = 'ordinary_one_shot_app';
const CHAT = 'oc_one_shot_chat';
const OWNER = 'ou_owner';
const ROOT = 'om_visible_root';
const LEGACY_LANE = `\0ordinary-visible:${APP}:${CHAT}:chat:${ROOT}`;
const LANE = ordinaryOneShotVisibleLaneKey(APP, CHAT, 'chat', ROOT);

function makeData(messageId: string, content: string): any {
  return {
    sender: {
      sender_id: { open_id: OWNER, union_id: 'on_owner' },
      sender_type: 'user',
    },
    message: {
      message_id: messageId,
      root_id: ROOT,
      chat_id: CHAT,
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: content }),
      create_time: String(Date.now()),
    },
  };
}

function makeCtx(messageId: string): any {
  const routingAnchor = `\0ordinary-one-shot:${APP}:${messageId}`;
  return {
    chatId: CHAT,
    messageId,
    chatType: 'group' as const,
    scope: 'chat' as const,
    anchor: ROOT,
    replyRootId: ROOT,
    larkAppId: APP,
    ordinaryOneShot: Object.freeze({
      physicalMessageId: messageId,
      routingAnchor,
      visibleLaneKey: LANE,
      visibleRoute: Object.freeze({
        chatId: CHAT,
        chatType: 'group' as const,
        scope: 'chat' as const,
        rootMessageId: ROOT,
        replyRootId: ROOT,
      }),
    }),
  };
}

function releaseClosedSession(session: any): void {
  const exactRelease = (oneShotLanes as any).releaseClosed;
  if (typeof exactRelease === 'function') {
    session.status = 'closed';
    exactRelease(structuredClone(session));
    return;
  }
  // The reset seam also resolves all lane promises. Keep this fallback until
  // the narrower exact-close helper is present on every implementation branch.
  oneShotLanes.reset();
}

describe('ordinary per-message daemon handler', () => {
  beforeEach(() => {
    oneShotLanes.reset();
    vi.clearAllMocks();
    mocks.sessions.clear();
    activeSessions.clear();
    const bot = registerBot({
      larkAppId: APP,
      larkAppSecret: 'secret',
      cliId: 'traex',
      ordinarySessionMode: 'per_message',
      defaultWorkingDir: '/tmp',
      allowedUsers: [OWNER],
    });
    bot.resolvedAllowedUsers = [OWNER];
    bot.botName = 'OneShotBot';
    bot.botOpenId = 'ou_one_shot_bot';
    mocks.downloadResources.mockResolvedValue({ attachments: [], needLogin: false });
    mocks.buildNewTopicCliInput.mockImplementation((content: string, _sessionId: string, _cliId: string, _path: unknown, _attachments: unknown, _mentions: unknown, _bots: unknown, _followUps: unknown, _identity: unknown, _locale: unknown, _sender: unknown, opts: unknown) => ({ content, trustedCaller: (opts as any)?.trustedCaller }));
    mocks.resolveSender.mockResolvedValue({ openId: OWNER, type: 'user', name: 'Alice' });
    mocks.replyMessage.mockResolvedValue('om_notice');
    mocks.closeSessionForBackgroundCleanup.mockImplementation(async (sessionId: string) => {
      let closed: any;
      for (const [key, ds] of activeSessions) {
        if (ds.session.sessionId !== sessionId) continue;
        activeSessions.delete(key);
        ds.session.status = 'closed';
        closed = ds.session;
      }
      const stored = mocks.sessions.get(sessionId);
      if (stored) stored.status = 'closed';
      if (closed) releaseClosedSession(closed);
      return { ok: true as const, outcome: 'closed' as const, alreadyClosed: false, known: !!closed };
    });
  });

  afterEach(() => {
    oneShotLanes.reset();
    activeSessions.clear();
  });

  it('atomically initializes one-shot routing/reply metadata and forks exactly once without resume', async () => {
    const messageId = 'om_turn_atomic';
    const ctx = makeCtx(messageId);
    let persistedAtCreate: any;
    mocks.createSession.mockImplementationOnce((chatId, rootMessageId, title, chatType, scope, intent) => {
      const row: any = {
        sessionId: 'one-shot-atomic', chatId, rootMessageId, title, chatType, scope,
        status: 'active', createdAt: new Date().toISOString(),
        oneShot: structuredClone(intent?.oneShot),
      };
      intent?.initialize?.(row);
      persistedAtCreate = structuredClone(row);
      mocks.sessions.set(row.sessionId, structuredClone(row));
      return row;
    });
    mocks.forkWorker.mockImplementation((_ds: any, _input: any, _start: any, hooks: any) => {
      hooks?.onAdmission?.('accepted');
      return true;
    });

    const handling = handleOrdinaryOneShot(makeData(messageId, '  inspect this diff  '), ctx);
    await vi.waitFor(() => expect(mocks.forkWorker).toHaveBeenCalledTimes(1));

    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(persistedAtCreate).toMatchObject({
      sessionId: 'one-shot-atomic',
      chatId: CHAT,
      rootMessageId: ROOT,
      title: 'inspect this diff',
      chatType: 'group',
      scope: 'chat',
      larkAppId: APP,
      ownerOpenId: OWNER,
      ownerUnionId: 'on_owner',
      creatorOpenId: OWNER,
      lastCallerOpenId: OWNER,
      quoteTargetId: messageId,
      quoteTargetSenderOpenId: OWNER,
      quoteTargetSenderIsBot: false,
      workingDir: '/tmp',
      cliId: 'traex',
      agentFrozen: true,
      oneShot: {
        version: 1,
        mode: 'ordinary_per_message',
        routingAnchor: ctx.ordinaryOneShot.routingAnchor,
        visibleLaneKey: LANE,
        visibleRoute: {
          chatId: CHAT, chatType: 'group', scope: 'chat',
          rootMessageId: ROOT, replyRootId: ROOT,
        },
        turn: { turnId: messageId },
      },
      turnReplyContexts: {
        [messageId]: {
          target: { mode: 'thread', rootMessageId: ROOT },
          quoteTargetId: messageId,
          replyTargetSenderOpenId: OWNER,
          replyTargetSenderIsBot: false,
          inThread: false,
        },
      },
      replyTargets: {
        [messageId]: {
          senderOpenId: OWNER,
          participants: [{ openId: OWNER, name: 'Alice', isBot: false }],
          rootMessageId: ROOT,
        },
      },
      currentReplyTarget: { rootMessageId: ROOT, turnId: messageId },
    });
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    const [ds, input, start, hooks] = mocks.forkWorker.mock.calls[0] as any[];
    expect(ds.session).toBeDefined();
    expect(input).toMatchObject({
      content: expect.stringContaining('inspect this diff'),
      trustedCaller: {
        requestUserOpenId: OWNER,
        requestUserUnionId: 'on_owner',
        requestLarkAppId: APP,
        senderType: 'user',
      },
    });
    expect(start).toEqual({ resume: false, turnId: messageId });
    expect(hooks).toEqual({ onAdmission: expect.any(Function) });
    expect(mocks.buildNewTopicCliInput.mock.calls[0]?.[11]).toMatchObject({
      suppressPersistedContext: true,
    });
    expect(ctx.ingressAdmission).toEqual({ admitted: true });
    expect(activeSessions.has(sessionKey(ctx.ordinaryOneShot.routingAnchor, APP))).toBe(true);
    expect(oneShotLanes.blockedSessionIds(LANE)).toEqual(['one-shot-atomic']);

    releaseClosedSession(persistedAtCreate);
    await expect(handling).resolves.toBeUndefined();
    expect(mocks.closeSessionForBackgroundCleanup).not.toHaveBeenCalled();
  });

  it('publishes the lane before fork side effects and keeps it blocked when cleanup fails', async () => {
    const messageId = 'om_turn_cleanup_failed';
    const ctx = makeCtx(messageId);
    mocks.closeSessionForBackgroundCleanup.mockRejectedValueOnce(new Error('disk unavailable'));
    mocks.forkWorker.mockImplementation((ds: any, _input: any, _start: any, hooks: any) => {
      expect(oneShotLanes.blockedSessionIds(LANE)).toEqual([ds.session.sessionId]);
      hooks?.onAdmission?.('rejected');
      return false;
    });

    await expect(handleOrdinaryOneShot(makeData(messageId, 'cleanup must fail closed'), ctx))
      .rejects.toThrow('ordinary one-shot worker admission rejected');

    const session = mocks.createSession.mock.results[0].value;
    expect(activeSessions.has(sessionKey(ctx.ordinaryOneShot.routingAnchor, APP))).toBe(true);
    expect(oneShotLanes.blockedSessionIds(LANE)).toEqual([session.sessionId]);
  });

  it('uses the frozen reply target for attachment-login warnings', async () => {
    const messageId = 'om_turn_login_warning';
    const ctx = makeCtx(messageId);
    mocks.downloadResources.mockResolvedValueOnce({ attachments: [], needLogin: true });
    mocks.forkWorker.mockImplementation((_ds: any, _input: any, _start: any, hooks: any) => {
      hooks?.onAdmission?.('accepted');
      return true;
    });

    const handling = handleOrdinaryOneShot(makeData(messageId, 'attachment prompt'), ctx);
    await vi.waitFor(() => expect(mocks.forkWorker).toHaveBeenCalledTimes(1));
    const session = (mocks.forkWorker.mock.calls[0] as any[])[0].session;
    expect(mocks.replyMessage).toHaveBeenCalledWith(
      APP,
      ROOT,
      expect.any(String),
      'text',
      true,
      undefined,
      undefined,
    );
    expect(session.turnReplyContexts[messageId].target).toEqual({
      mode: 'thread', rootMessageId: ROOT,
    });
    releaseClosedSession(session);
    await handling;
  });

  it('reserves valid same-app and ownerless boot lanes, including malformed one-shot rows', () => {
    const sameApp = {
      sessionId: 'boot-same', status: 'active', larkAppId: APP,
      oneShot: { visibleLaneKey: LANE },
    };
    const ownerless = {
      sessionId: 'boot-ownerless', status: 'active',
      oneShot: { visibleLaneKey: LANE, malformed: true },
    };
    const foreign = {
      sessionId: 'boot-foreign', status: 'active', larkAppId: 'other-app',
      oneShot: { visibleLaneKey: LANE },
    };
    oneShotLanes.reserveFromBoot([sameApp, ownerless, foreign] as any, APP);
    expect(oneShotLanes.blockedSessionIds(LANE)).toEqual(['boot-same', 'boot-ownerless']);
  });

  it('blocks the canonical visible lane for an active legacy NUL-key boot row', async () => {
    const legacy = {
      sessionId: 'boot-legacy-blocker',
      status: 'active',
      larkAppId: APP,
      oneShot: {
        version: 1,
        mode: 'ordinary_per_message',
        routingAnchor: `\0ordinary-one-shot:${APP}:om_legacy_active`,
        visibleLaneKey: LEGACY_LANE,
        visibleRoute: {
          chatId: CHAT,
          chatType: 'group',
          scope: 'chat',
          rootMessageId: ROOT,
          replyRootId: ROOT,
        },
        createdAt: new Date().toISOString(),
        turn: { turnId: 'om_legacy_active' },
      },
    };
    oneShotLanes.reserveFromBoot([legacy] as any, APP);

    expect(oneShotLanes.blockedSessionIds(LEGACY_LANE)).toEqual([legacy.sessionId]);
    expect(oneShotLanes.blockedSessionIds(LANE)).toEqual([legacy.sessionId]);

    mocks.forkWorker.mockImplementation((_ds: any, _input: any, _start: any, hooks: any) => {
      hooks?.onAdmission?.('accepted');
      return true;
    });
    const ctx = makeCtx('om_after_upgrade');
    const handling = handleOrdinaryOneShot(makeData('om_after_upgrade', 'wait for legacy'), ctx);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(ctx.ingressAdmission).toEqual({ admitted: false });

    releaseClosedSession(legacy);
    await vi.waitFor(() => expect(mocks.forkWorker).toHaveBeenCalledTimes(1));
    const admitted = (mocks.forkWorker.mock.calls[0] as any[])[0].session;
    releaseClosedSession(admitted);
    await expect(handling).resolves.toBeUndefined();
  });

  it('releases both raw legacy and canonical boot aliases on authoritative close', () => {
    const legacy = {
      sessionId: 'boot-legacy-close',
      status: 'active',
      larkAppId: APP,
      oneShot: {
        version: 1,
        mode: 'ordinary_per_message',
        routingAnchor: `\0ordinary-one-shot:${APP}:om_legacy_close`,
        visibleLaneKey: LEGACY_LANE,
        visibleRoute: {
          chatId: CHAT,
          chatType: 'group',
          scope: 'chat',
          rootMessageId: ROOT,
          replyRootId: ROOT,
        },
        createdAt: new Date().toISOString(),
        turn: { turnId: 'om_legacy_close' },
      },
    };
    oneShotLanes.reserveFromBoot([legacy] as any, APP);

    releaseClosedSession(legacy);

    expect(oneShotLanes.blockedSessionIds(LEGACY_LANE)).toEqual([]);
    expect(oneShotLanes.blockedSessionIds(LANE)).toEqual([]);
  });

  it.each(['displaced', 'unavailable'] as const)(
    'aborts per-message startup on a %s occupancy result',
    state => {
      expect(() => claimStartupOccupancy(
        { ordinarySessionMode: 'per_message' },
        () => state,
      )).toThrow(`claim=${state}`);
    },
  );

  it('aborts per-message startup when the occupancy claim throws', () => {
    expect(() => claimStartupOccupancy(
      { ordinarySessionMode: 'per_message' },
      () => { throw new Error('sqlite unavailable'); },
    )).toThrow('claim=error');
  });

  it('accepts a held per-message occupancy claim and skips legacy modes', () => {
    const held = vi.fn(() => 'held' as const);
    expect(claimStartupOccupancy({ ordinarySessionMode: 'per_message' }, held)).toBe('held');
    expect(held).toHaveBeenCalledTimes(1);
    const legacyClaim = vi.fn(() => 'displaced' as const);
    expect(claimStartupOccupancy({}, legacyClaim)).toBeUndefined();
    expect(legacyClaim).not.toHaveBeenCalled();
  });

  it('removes and closes a pre-admission rejected row, leaving ingress unadmitted', async () => {
    const messageId = 'om_turn_rejected';
    const ctx = makeCtx(messageId);
    mocks.forkWorker.mockImplementation((_ds: any, _input: any, _start: any, hooks: any) => {
      hooks?.onAdmission?.('rejected');
      return false;
    });

    await expect(handleOrdinaryOneShot(makeData(messageId, 'rejected task'), ctx))
      .rejects.toThrow('ordinary one-shot worker admission rejected');

    const session = mocks.createSession.mock.results[0].value;
    expect(mocks.closeSessionForBackgroundCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.closeSessionForBackgroundCleanup).toHaveBeenCalledWith(
      session.sessionId,
      'ordinary one-shot pre-admission cleanup',
    );
    expect(mocks.closeSession).not.toHaveBeenCalled();
    expect(activeSessions.has(sessionKey(ctx.ordinaryOneShot.routingAnchor, APP))).toBe(false);
    expect(oneShotLanes.blockedSessionIds(LANE)).toEqual([]);
    expect(ctx.ingressAdmission).toEqual({ admitted: false });
  });

  it('holds a visible destination lane until close release before admitting the next message', async () => {
    mocks.forkWorker.mockImplementation((_ds: any, _input: any, _start: any, hooks: any) => {
      hooks?.onAdmission?.('accepted');
      return true;
    });
    const firstCtx = makeCtx('om_turn_first');
    const secondCtx = makeCtx('om_turn_second');

    const first = handleOrdinaryOneShot(makeData('om_turn_first', 'first prompt'), firstCtx);
    await vi.waitFor(() => expect(mocks.forkWorker).toHaveBeenCalledTimes(1));
    const firstSession = (mocks.forkWorker.mock.calls[0] as any[])[0].session;
    expect(firstCtx.ingressAdmission).toEqual({ admitted: true });
    expect(oneShotLanes.blockedSessionIds(LANE)).toEqual([firstSession.sessionId]);

    const second = handleOrdinaryOneShot(makeData('om_turn_second', 'second prompt'), secondCtx);
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.forkWorker).toHaveBeenCalledTimes(1);
    expect(secondCtx.ingressAdmission).toEqual({ admitted: false });

    releaseClosedSession(firstSession);
    await expect(first).resolves.toBeUndefined();
    await vi.waitFor(() => expect(mocks.forkWorker).toHaveBeenCalledTimes(2));

    const secondSession = (mocks.forkWorker.mock.calls[1] as any[])[0].session;
    const secondInput = (mocks.forkWorker.mock.calls[1] as any[])[1];
    expect(secondCtx.ingressAdmission).toEqual({ admitted: true });
    expect(secondInput.content).toContain('second prompt');
    expect(oneShotLanes.blockedSessionIds(LANE)).toEqual([secondSession.sessionId]);

    releaseClosedSession(secondSession);
    await expect(second).resolves.toBeUndefined();
  });
});
