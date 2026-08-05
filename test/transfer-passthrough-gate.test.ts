import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  process.env.SESSION_DATA_DIR =
    `${process.env.TMPDIR ?? '/tmp'}/botmux-transfer-passthrough-${process.pid}`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  return {
    replyMessage: vi.fn(async () => 'om_reply'),
    updateSession: vi.fn(),
  };
});

vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return {
    ...actual,
    replyMessage: (...args: any[]) => mocks.replyMessage(...args),
  };
});

vi.mock('../src/services/session-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/session-store.js')>();
  return {
    ...actual,
    updateSession: (...args: any[]) => mocks.updateSession(...args),
  };
});

vi.mock('../src/bot-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return {
    ...actual,
    getBot: vi.fn(() => ({
      config: {
        larkAppId: 'app-transfer-passthrough',
        cliId: 'claude-code',
      },
      botName: 'TestBot',
      botOpenId: 'ou_bot',
      resolvedAllowedUsers: [],
    })),
  };
});

import {
  __testOnly_deliverPassthroughToExistingSession as deliverPassthrough,
} from '../src/daemon.js';
import {
  isSessionTransferring,
  setActiveSessionsRegistry,
  transferSession,
} from '../src/core/worker-pool.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';

describe('mid-transfer literal passthrough', () => {
  it('buffers raw input while worker=null and replays it on the target replacement', async () => {
    const ds = {
      session: {
        sessionId: 'session-transfer-passthrough',
        chatId: 'oc_source',
        rootMessageId: 'om_source',
        title: 'passthrough transfer',
        status: 'active',
        createdAt: new Date().toISOString(),
        scope: 'thread',
        chatType: 'group',
        larkAppId: 'app-transfer-passthrough',
        ownerOpenId: 'ou_owner',
        workingDir: '/tmp',
        cliId: 'claude-code',
      },
      worker: null,
      workerPort: null,
      workerToken: null,
      larkAppId: 'app-transfer-passthrough',
      chatId: 'oc_source',
      chatType: 'group',
      scope: 'thread',
      spawnedAt: Date.now(),
      cliVersion: '1.0.0',
      lastMessageAt: Date.now(),
      hasHistory: true,
      workingDir: '/tmp',
      lastScreenStatus: 'idle',
    } as DaemonSession;
    const registry = new Map<string, DaemonSession>([
      [sessionKey('om_source', ds.larkAppId), ds],
    ]);
    setActiveSessionsRegistry(registry);

    let releaseDetach!: (completed: boolean) => void;
    const detach = vi.fn(() => new Promise<boolean>((resolve) => {
      releaseDetach = resolve;
    }));
    const replacementSend = vi.fn();
    const replacement = Object.assign(new EventEmitter(), {
      killed: false,
      connected: true,
      exitCode: null,
      signalCode: null,
      send: replacementSend,
      kill: vi.fn(),
    }) as any;
    const replacementFork = vi.fn(() => {
      ds.worker = replacement;
    });

    const moving = transferSession(
      ds.session.sessionId,
      'oc_target',
      'om_target',
      'group',
      'chat',
      {
        detachWorkerImpl: detach,
        forkWorkerImpl: replacementFork as any,
      },
    );
    await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());
    expect(isSessionTransferring(ds)).toBe(true);
    expect(ds.worker).toBeNull();

    deliverPassthrough(
      ds,
      '/model',
      '/model opus',
      'om_source',
      ds.larkAppId,
      {
        messageId: 'om_passthrough_turn',
        senderOpenId: 'ou_owner',
        senderIsBot: false,
        substitute: false,
      },
    );

    expect(mocks.replyMessage).not.toHaveBeenCalled();
    expect(replacementSend).not.toHaveBeenCalled();

    releaseDetach(true);
    await expect(moving).resolves.toEqual({ ok: true });

    expect(replacementFork).toHaveBeenCalledWith(ds, '', true);
    expect(replacementSend).toHaveBeenCalledWith({
      type: 'raw_input',
      content: '/model opus',
      turnId: 'om_passthrough_turn',
    });
  });
});
