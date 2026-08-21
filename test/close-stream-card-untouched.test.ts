import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Lark client so we can observe deleteMessage without real API calls.
const { deleteMessage } = vi.hoisted(() => ({ deleteMessage: vi.fn(async () => undefined) }));
vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return { ...actual, deleteMessage };
});

import { config } from '../src/config.js';
import * as workerPool from '../src/core/worker-pool.js';
import { activeSessionKey } from '../src/core/types.js';
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

describe('closeSession leaves the streaming card alone', () => {
  beforeEach(() => {
    deleteMessage.mockClear();
  });
  afterEach(() => {
    workerPool.setActiveSessionsRegistry(new Map());
    sessionStore.init();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Close is not a card-cleanup step: the streaming card (and its buttons) is a
  // resume-time concern. The Lark card close button patches the clicked card in
  // place into the "会话已关闭" card; closeSession itself must never delete it.
  it('does NOT delete the streaming card on close', async () => {
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
      expect(sessionStore.getSession(s.sessionId)?.status).toBe('closed');
    } finally {
      config.session.dataDir = prev;
    }
  });
});
