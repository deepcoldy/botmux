import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', () => ({
  deleteMessage: vi.fn(),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {},
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: ['ou_owner'],
    botName: 'Test Bot',
    botOpenId: 'ou_bot',
  })),
  getAllBots: vi.fn(() => []),
  getBotClient: vi.fn(),
  getOwnerOpenId: vi.fn(() => 'ou_owner'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'pty', cliId: 'claude-code' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  updateSession: vi.fn(),
  closeSession: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('../src/core/worker-pool.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/core/worker-pool.js')>();
  return {
    ...orig,
    forkWorker: vi.fn(),
    killWorker: vi.fn(),
  };
});

vi.mock('../src/core/session-manager.js', () => ({
  buildNewTopicPrompt: vi.fn(() => 'mock-prompt'),
  getAvailableBots: vi.fn(async () => []),
  getSessionWorkingDir: vi.fn(() => '/tmp'),
  persistStreamCardState: vi.fn(),
  rememberLastCliInput: vi.fn((ds: any, userPrompt: string, cliInput: string) => {
    ds.lastUserPrompt = userPrompt;
    ds.lastCliInput = cliInput;
  }),
  resumeSession: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import { forkWorker } from '../src/core/worker-pool.js';
import * as sessionManager from '../src/core/session-manager.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import { handleCardAction, type CardHandlerDeps } from '../src/im/lark/card-handler.js';
import * as sessionStore from '../src/services/session-store.js';

const APP_ID = 'app_test';
const ROOT_ID = 'om_root';

function makePendingRepoSession(): DaemonSession {
  return {
    session: {
      sessionId: 'sess-manual',
      rootMessageId: ROOT_ID,
      chatId: 'oc_chat',
      chatType: 'group',
      title: 'Manual Repo',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      ownerOpenId: 'ou_owner',
      cliId: 'claude-code',
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: APP_ID,
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    pendingRepo: true,
    pendingPrompt: 'run the queued task',
  } as DaemonSession;
}

function repoManualSubmit(path: string) {
  return {
    action: {
      value: { action: 'repo_manual_submit', root_id: ROOT_ID },
      form_value: { repo_manual_path: path },
    },
    operator: { open_id: 'ou_owner' },
  };
}

describe('repo manual card action', () => {
  it('starts a pending session in the manually submitted existing directory', async () => {
    const selectedPath = mkdtempSync(join(tmpdir(), 'botmux-manual-repo-'));
    const ds = makePendingRepoSession();
    const activeSessions = new Map<string, DaemonSession>([[sessionKey(ROOT_ID, APP_ID), ds]]);
    const deps: CardHandlerDeps = {
      activeSessions,
      lastRepoScan: new Map(),
      sessionReply: vi.fn(async () => 'om_reply'),
    };

    await handleCardAction(repoManualSubmit(selectedPath), deps, APP_ID);

    expect(ds.pendingRepo).toBe(false);
    expect(ds.workingDir).toBe(selectedPath);
    expect(ds.session.workingDir).toBe(selectedPath);
    expect(sessionStore.updateSession).toHaveBeenCalledWith(ds.session);
    expect(sessionManager.buildNewTopicPrompt).toHaveBeenCalledWith(
      'run the queued task',
      'sess-manual',
      'claude-code',
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      { name: 'Test Bot', openId: 'ou_bot' },
      'zh',
      undefined,
      { larkAppId: APP_ID, chatId: 'oc_chat' },
    );
    expect(forkWorker).toHaveBeenCalledWith(ds, 'mock-prompt');
    expect(deps.sessionReply).toHaveBeenCalledWith(
      ROOT_ID,
      expect.stringContaining(basename(selectedPath)),
      undefined,
      APP_ID,
    );
  });
});
