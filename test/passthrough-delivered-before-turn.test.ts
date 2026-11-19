import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.SESSION_DATA_DIR =
    `${process.env.TMPDIR ?? '/tmp'}/botmux-passthrough-delivered-${process.pid}`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  return {
    replyMessage: vi.fn(async () => 'om_reply'),
    updateSession: vi.fn(),
    rejectInput: false,
  };
});

vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return { ...actual, replyMessage: (...args: any[]) => mocks.replyMessage(...args) };
});

vi.mock('../src/services/session-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/session-store.js')>();
  return { ...actual, updateSession: (...args: any[]) => mocks.updateSession(...args) };
});

vi.mock('../src/core/worker-pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/worker-pool.js')>();
  return { ...actual, sendWorkerSessionInput: (...args: Parameters<typeof actual.sendWorkerSessionInput>) =>
    mocks.rejectInput ? false : actual.sendWorkerSessionInput(...args) };
});

vi.mock('../src/bot-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return {
    ...actual,
    getBot: vi.fn(() => ({
      config: { larkAppId: 'app-passthrough-delivered', cliId: 'claude-code' },
      botName: 'TestBot',
      botOpenId: 'ou_bot',
      resolvedAllowedUsers: [],
    })),
  };
});

import { __testOnly_deliverPassthroughToExistingSession as deliverPassthrough } from '../src/daemon.js';
import { setActiveSessionsRegistry } from '../src/core/worker-pool.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';

function liveSession(): DaemonSession {
  const worker = Object.assign(new EventEmitter(), {
    killed: false, connected: true, exitCode: null, signalCode: null,
    send: vi.fn(() => true), kill: vi.fn(),
  }) as any;
  const ds = {
    session: {
      sessionId: 'session-passthrough-delivered', chatId: 'oc_x', rootMessageId: 'om_root',
      title: 't', status: 'active', createdAt: new Date().toISOString(), scope: 'thread',
      chatType: 'group', larkAppId: 'app-passthrough-delivered', ownerOpenId: 'ou_owner',
      workingDir: '/tmp', cliId: 'claude-code',
    },
    worker, workerPort: null, workerToken: null,
    larkAppId: 'app-passthrough-delivered', chatId: 'oc_x', chatType: 'group', scope: 'thread',
    spawnedAt: Date.now(), cliVersion: '1.0.0', lastMessageAt: Date.now(), hasHistory: true,
    workingDir: '/tmp', lastScreenStatus: 'idle',
  } as DaemonSession;
  setActiveSessionsRegistry(new Map([[sessionKey('om_root', ds.larkAppId), ds]]));
  return ds;
}

describe('passthrough delivery is reported at the worker-accept boundary', () => {
  beforeEach(() => { mocks.updateSession.mockReset(); mocks.rejectInput = false; });

  it.each(['thread', 'chat-root', 'chat-rootless'])('restores the full reply binding when IPC rejects %s', scope => {
    const ds = liveSession();
    if (scope !== 'thread') ds.scope = ds.session.scope = 'chat';
    ds.session.quoteTargetId = 'om_business';
    ds.session.quoteTargetSenderOpenId = 'ou_business';
    ds.session.quoteTargetSenderIsBot = false;
    ds.session.lastCallerOpenId = 'ou_business';
    ds.session.replyTargets = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`turn-${i}`, { updatedAt: '2026-01-01T00:00:00.000Z' }]));
    ds.session.turnReplyContexts = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`turn-${i}`, { target: { mode: 'plain', chatId: ds.chatId } }])) as any;
    ds.session.replyTargetsPrunedThrough = '2025-01-01T00:00:00.000Z';
    ds.replyThreadAliases = ds.session.replyThreadAliases = { om_previous: { createdAt: '2026-01-01', lastUsedAt: '2026-01-01' } };
    ds.currentReplyTarget = ds.session.currentReplyTarget = { rootMessageId: 'om_previous', turnId: 'business', updatedAt: '2026-01-01' };
    const before = structuredClone(ds.session);
    const aliases = ds.replyThreadAliases;
    const current = ds.currentReplyTarget;
    let saved: unknown;
    mocks.updateSession.mockImplementation((session: unknown) => { saved = structuredClone(session); });
    // External IPC rejects the enqueue; daemon and reply-binding code stay real.
    mocks.rejectInput = true;
    const onDelivered = vi.fn();
    const accepted = deliverPassthrough(ds, '/model', '/model sonnet', 'om_root', ds.larkAppId, {
      messageId: 'om_picker', replyRootId: scope === 'chat-rootless' ? undefined : 'om_new_root',
      senderOpenId: 'ou_operator', senderIsBot: true, substitute: false, turnId: 'model-new', onDelivered,
    });
    expect(accepted).toBe(false);
    expect(onDelivered).not.toHaveBeenCalled();
    expect(ds.session).toEqual(before);
    expect(saved).toEqual(before);
    expect(ds.replyThreadAliases).toBe(aliases);
    expect(ds.currentReplyTarget).toBe(current);
  });

  it('restores absent binding fields when persistence fails before sending', () => {
    const ds = liveSession();
    const before = structuredClone(ds.session);
    mocks.updateSession.mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => deliverPassthrough(ds, '/model', '/model sonnet', 'om_root', ds.larkAppId, {
      messageId: 'om_picker', senderOpenId: 'ou_operator', senderIsBot: false, substitute: false,
    })).toThrow('disk full');
    expect(ds.session).toEqual(before);
    expect(Object.hasOwn(ds.session, 'quoteTargetSenderIsBot')).toBe(false);
    expect((ds.worker as any).send).not.toHaveBeenCalled();
  });

  it('calls onDelivered even when the post-send turn bookkeeping throws', () => {
    const ds = liveSession();
    // Fail only the persistence that happens after the worker accepted the input.
    mocks.updateSession.mockImplementation(() => {
      if ((ds.worker as any).send.mock.calls.length > 0) throw new Error('transient store error');
    });
    const onDelivered = vi.fn();
    let thrown: unknown;
    try {
      deliverPassthrough(ds, '/compact', '/compact', 'om_root', ds.larkAppId, {
        messageId: 'om_root', replyRootId: 'om_root', senderIsBot: true,
        substitute: false, inThread: true, turnId: 'turn-1', onDelivered,
      });
    } catch (err) { thrown = err; }
    expect((ds.worker as any).send).toHaveBeenCalled();
    expect(onDelivered).toHaveBeenCalledOnce();
    // The bookkeeping failure must actually have happened for this test to mean anything.
    expect(thrown).toBeInstanceOf(Error);
  });
});
