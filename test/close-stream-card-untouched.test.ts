import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Lark client so we can observe deleteMessage without real API calls.
const { deleteMessage, pinMessage, unpinMessage } = vi.hoisted(() => ({
  deleteMessage: vi.fn(async () => undefined),
  pinMessage: vi.fn(async () => true),
  unpinMessage: vi.fn(async () => true),
}));
const getBotMock = vi.hoisted(() => vi.fn());
vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return { ...actual, deleteMessage, pinMessage, unpinMessage };
});
vi.mock('../src/bot-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return { ...actual, getBot: (...args: any[]) => getBotMock(...args) };
});

import { config } from '../src/config.js';
import * as workerPool from '../src/core/worker-pool.js';
import { activeSessionKey } from '../src/core/types.js';
import { saveFrozenCards } from '../src/services/frozen-card-store.js';
import * as sessionStore from '../src/services/session-store.js';

const tempDirs: string[] = [];

function makeDs(sessionId: string, appId: string, streamCardId: string) {
  const session = sessionStore.getSession(sessionId)!;
  const worker = Object.assign(new EventEmitter(), { killed: false, send: vi.fn() });
  return {
    session,
    worker,
    workerPort: 12345,
    workerToken: 'wt',
    workerViewToken: 'vt',
    workerReady: true,
    larkAppId: appId,
    chatId: session.chatId,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: 'test',
    lastMessageAt: Date.now(),
    hasHistory: true,
    streamCardId,
    initConfig: { backendType: 'tmux' },
  } as any;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('closeSession leaves the streaming card alone', () => {
  beforeEach(() => {
    deleteMessage.mockClear();
    pinMessage.mockClear();
    unpinMessage.mockClear();
    getBotMock.mockReturnValue({ config: { pinStreamingCard: false } });
  });
  afterEach(() => {
    workerPool.setActiveSessionsRegistry(new Map());
    sessionStore.init();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Close is not a card-cleanup step for an opt-out bot: the streaming card
  // (and any manual Pin on it) remains a resume-time concern. The Lark card
  // close button patches the clicked card in place into the "会话已关闭" card.
  it('does NOT delete or unpin the streaming card when Pin was never enabled', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-close-card-'));
    tempDirs.push(dataDir);
    const prev = config.session.dataDir;
    config.session.dataDir = dataDir;
    sessionStore.init('app-close-card');
    try {
      const s = sessionStore.createSession('oc_closecard', 'om_closecard', 'closecard', 'group');
      s.larkAppId = 'app-close-card';
      sessionStore.updateSession(s);
      const ds = makeDs(s.sessionId, 'app-close-card', 'om_stream_card');
      workerPool.setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));

      await workerPool.closeSession(s.sessionId, { awaitWorkerExit: false });

      expect(deleteMessage).not.toHaveBeenCalledWith('app-close-card', 'om_stream_card');
      expect(unpinMessage).not.toHaveBeenCalled();
      expect(sessionStore.getSession(s.sessionId)?.status).toBe('closed');
    } finally {
      config.session.dataDir = prev;
    }
  });

  it('returns close success before a slow enabled-card Unpin settles', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-close-card-enabled-'));
    tempDirs.push(dataDir);
    const prev = config.session.dataDir;
    config.session.dataDir = dataDir;
    sessionStore.init('app-close-card');
    try {
      const s = sessionStore.createSession('oc_closecard', 'om_closecard', 'closecard', 'group');
      s.larkAppId = 'app-close-card';
      sessionStore.updateSession(s);
      const ds = makeDs(s.sessionId, 'app-close-card', 'om_stream_card');
      workerPool.setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
      getBotMock.mockReturnValue({ config: { pinStreamingCard: true } });
      const unpinStarted = deferred<void>();
      const releaseUnpin = deferred<boolean>();
      unpinMessage.mockImplementationOnce(() => {
        unpinStarted.resolve();
        return releaseUnpin.promise;
      });

      await expect(workerPool.closeSession(s.sessionId, { awaitWorkerExit: false })).resolves.toEqual({
        ok: true, outcome: 'closed', alreadyClosed: false, known: true,
      });
      await unpinStarted.promise;
      expect(unpinMessage).toHaveBeenCalledWith('app-close-card', 'om_stream_card');
      expect(sessionStore.getSession(s.sessionId)?.status).toBe('closed');

      releaseUnpin.resolve(false);
      await workerPool.__testOnly_waitForPinStreamingCardIdle();
    } finally {
      config.session.dataDir = prev;
    }
  });

  it('cleans current and frozen cards from a workerless persisted row when enabled', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-close-card-workerless-'));
    tempDirs.push(dataDir);
    const prev = config.session.dataDir;
    config.session.dataDir = dataDir;
    sessionStore.init('app-close-card');
    try {
      const s = sessionStore.createSession('oc_closecard', 'om_closecard', 'closecard', 'group');
      s.larkAppId = 'app-close-card';
      s.streamCardId = 'om_stored_current';
      sessionStore.updateSession(s);
      saveFrozenCards(s.sessionId, new Map([
        ['old', { messageId: 'om_stored_frozen', content: '', title: '', displayMode: 'hidden' }],
      ]));
      workerPool.setActiveSessionsRegistry(new Map());
      getBotMock.mockReturnValue({ config: { pinStreamingCard: true } });

      await expect(workerPool.closeSession(s.sessionId)).resolves.toEqual({
        ok: true, outcome: 'closed', alreadyClosed: false, known: true,
      });
      await workerPool.__testOnly_waitForPinStreamingCardIdle();

      expect(new Set(unpinMessage.mock.calls.map(([, messageId]) => messageId))).toEqual(
        new Set(['om_stored_current', 'om_stored_frozen']),
      );
    } finally {
      config.session.dataDir = prev;
    }
  });

  it('leaves a workerless persisted row untouched when Pin was never enabled', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-close-card-workerless-off-'));
    tempDirs.push(dataDir);
    const prev = config.session.dataDir;
    config.session.dataDir = dataDir;
    sessionStore.init('app-close-card');
    try {
      const s = sessionStore.createSession('oc_closecard', 'om_closecard', 'closecard', 'group');
      s.larkAppId = 'app-close-card';
      s.streamCardId = 'om_stored_current';
      sessionStore.updateSession(s);
      saveFrozenCards(s.sessionId, new Map([
        ['old', { messageId: 'om_stored_frozen', content: '', title: '', displayMode: 'hidden' }],
      ]));
      workerPool.setActiveSessionsRegistry(new Map());

      await workerPool.closeSession(s.sessionId);
      await workerPool.__testOnly_waitForPinStreamingCardIdle();

      expect(unpinMessage).not.toHaveBeenCalled();
    } finally {
      config.session.dataDir = prev;
    }
  });

  it('does not start cleanup when the durable close save fails', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-close-card-save-fail-'));
    tempDirs.push(dataDir);
    const prev = config.session.dataDir;
    config.session.dataDir = dataDir;
    sessionStore.init('app-close-card');
    try {
      const s = sessionStore.createSession('oc_closecard', 'om_closecard', 'closecard', 'group');
      s.larkAppId = 'app-close-card';
      s.streamCardId = 'om_stored_current';
      sessionStore.updateSession(s);
      getBotMock.mockReturnValue({ config: { pinStreamingCard: true } });
      const failingClose = vi.spyOn(sessionStore, 'closeSession')
        .mockImplementationOnce(() => { throw new Error('disk full'); });

      await expect(workerPool.closeSession(s.sessionId)).rejects.toThrow('disk full');
      await workerPool.__testOnly_waitForPinStreamingCardIdle();
      expect(unpinMessage).not.toHaveBeenCalled();
      failingClose.mockRestore();
    } finally {
      config.session.dataDir = prev;
    }
  });

  it('makes no Lark call for an enabled close on an apiOnly transport', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-close-card-api-only-'));
    tempDirs.push(dataDir);
    const prev = config.session.dataDir;
    config.session.dataDir = dataDir;
    sessionStore.init('app-close-card');
    try {
      const s = sessionStore.createSession('oc_closecard', 'om_closecard', 'closecard', 'group');
      s.larkAppId = 'app-close-card';
      s.streamCardId = 'om_stream_card';
      sessionStore.updateSession(s);
      getBotMock.mockReturnValue({ config: { pinStreamingCard: true, apiOnly: true } });

      await workerPool.closeSession(s.sessionId);
      await workerPool.__testOnly_waitForPinStreamingCardIdle();

      expect(unpinMessage).not.toHaveBeenCalled();
    } finally {
      config.session.dataDir = prev;
    }
  });

  it('explicit per-chat on-to-off close cleanup remains authoritative for previously owned Pins', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-close-card-chat-optout-cleanup-'));
    tempDirs.push(dataDir);
    const prev = config.session.dataDir;
    config.session.dataDir = dataDir;
    sessionStore.init('app-close-card');
    try {
      const s = sessionStore.createSession('oc_closecard', 'om_closecard', 'closecard', 'group');
      s.larkAppId = 'app-close-card';
      sessionStore.updateSession(s);
      const ds = makeDs(s.sessionId, 'app-close-card', 'om_stream_card');
      workerPool.setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
      getBotMock.mockReturnValue({ config: { pinStreamingCard: true } });

      await expect(workerPool.pinStreamingCardIfEnabled(ds, 'om_stream_card')).resolves.toBe(true);
      expect(pinMessage).toHaveBeenCalledWith('app-close-card', 'om_stream_card');
      expect(unpinMessage).not.toHaveBeenCalled();
      unpinMessage.mockClear();
      getBotMock.mockReturnValue({
        config: {
          pinStreamingCard: true,
          noPinStreamingCardChats: ['oc_closecard'],
        },
      });

      await workerPool.closeSession(s.sessionId, { awaitWorkerExit: false });
      await workerPool.__testOnly_waitForPinStreamingCardIdle();

      expect(unpinMessage).toHaveBeenCalledWith('app-close-card', 'om_stream_card');
    } finally {
      config.session.dataDir = prev;
    }
  });

  it('an always-opted-out chat close is not authority to unpin manual Pins', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-close-card-chat-optout-manual-'));
    tempDirs.push(dataDir);
    const prev = config.session.dataDir;
    config.session.dataDir = dataDir;
    sessionStore.init('app-close-card');
    try {
      const s = sessionStore.createSession('oc_closecard', 'om_closecard', 'closecard', 'group');
      s.larkAppId = 'app-close-card';
      s.streamCardId = 'om_stored_current';
      sessionStore.updateSession(s);
      saveFrozenCards(s.sessionId, new Map([
        ['old', { messageId: 'om_stored_frozen', content: '', title: '', displayMode: 'hidden' }],
      ]));
      workerPool.setActiveSessionsRegistry(new Map());
      getBotMock.mockReturnValue({
        config: {
          pinStreamingCard: true,
          noPinStreamingCardChats: ['oc_closecard'],
        },
      });

      await workerPool.closeSession(s.sessionId);
      await workerPool.__testOnly_waitForPinStreamingCardIdle();

      expect(unpinMessage).not.toHaveBeenCalled();
    } finally {
      config.session.dataDir = prev;
    }
  });
});
