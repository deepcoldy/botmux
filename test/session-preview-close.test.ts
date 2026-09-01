/**
 * P1-13：会话关闭必须把预览一起收掉——磁盘上的 previewTarget 归零，并且**显式广播**
 * `preview: null`。
 *
 * 光靠 `session.exited` 不够：浏览器 store 只会把行标成 closed，卡片上的预览入口与
 * 已经建立的预览 SSE/WS 都拿不到「目标没了」这个信号；而磁盘上留着的 (host, port) 会
 * 在 resume/离线快照里被当成一条有效路由，指向一个早已换主的端口号。
 *
 * 用真实 sessionStore + 真实临时数据目录跑真实的 closeSession。
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ resolvedAllowedUsers: [], config: {} })),
  getBotBrand: vi.fn(() => 'feishu'),
  getAllBots: vi.fn(() => []),
  loadBotConfigs: vi.fn(),
  resolveBrandLabel: vi.fn(() => undefined),
}));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  sendEphemeralCard: vi.fn(),
  sendUserMessage: vi.fn(),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  getMessageChatId: vi.fn(),
  MessageWithdrawnError: class extends Error {},
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
  deleteFrozenCards: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { config } from '../src/config.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import {
  closeSession,
  initWorkerPool,
  setActiveSessionsRegistry,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';

const PREVIEW_TARGET = {
  host: '127.0.0.1' as const,
  port: 4173,
  registeredAt: '2026-08-11T12:00:00.000Z',
  owner: { pid: 4242, procStart: '918273', inode: '556677' },
  workerGeneration: 2,
};

let dataDir: string;
let previousDataDir: string;
let published: any[];

function createFixture() {
  sessionStore.init('app');
  const session = sessionStore.createSession('oc_preview', 'om_preview', 'preview close', 'group');
  session.larkAppId = 'app';
  session.scope = 'chat';
  session.backendType = 'pty';
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.exitCode = null;
  worker.signalCode = null;
  worker.send = vi.fn();
  // 真实的 close 会等这一代 worker 真的退出（close fence）。
  worker.kill = vi.fn(() => {
    queueMicrotask(() => { worker.exitCode = 0; worker.emit('exit', 0, null); });
    return true;
  });
  const ds = {
    larkAppId: 'app',
    chatId: session.chatId,
    chatType: 'group',
    scope: 'chat',
    worker,
    session,
    initConfig: { backendType: 'pty' },
  } as unknown as DaemonSession;
  __testOnly_setupWorkerHandlers(ds, worker);
  // 注册发生在这一代 worker 就位之后（reserveWorkerGeneration 会清掉更早的目标）。
  session.previewTarget = { ...PREVIEW_TARGET, workerGeneration: ds.workerGeneration ?? 1 };
  sessionStore.updateSession(session);
  published.length = 0;
  setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
  return { session, ds };
}

beforeEach(() => {
  vi.clearAllMocks();
  published = [];
  vi.spyOn(dashboardEventBus, 'publish').mockImplementation((event: any) => {
    published.push(event);
  });
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-preview-close-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  initWorkerPool({
    sessionReply: vi.fn(async () => 'om_reply'),
    getSessionWorkingDir: () => '/repo',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  setActiveSessionsRegistry(new Map());
  config.session.dataDir = previousDataDir;
  sessionStore.init();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('P1-13 closing a session retires its preview target', () => {
  it('drops the durable target and publishes preview: null alongside session.exited', async () => {
    const { session } = createFixture();

    const result = await closeSession(session.sessionId);
    expect(result.ok).toBe(true);

    // 磁盘：重新 load 也不能再看到那个端口。
    sessionStore.init('app');
    expect(sessionStore.getSession(session.sessionId)?.previewTarget).toBeUndefined();

    const cleared = published.filter(event => event.type === 'session.update'
      && event.body?.patch?.previewTarget === null
      && event.body.sessionId === session.sessionId);
    expect(cleared).toHaveLength(1);
    expect(published.some(event => event.type === 'session.exited')).toBe(true);
  });

  it('does not announce a preview clear for a session that never registered one', async () => {
    const { session } = createFixture();
    session.previewTarget = undefined;
    sessionStore.updateSession(session);

    await closeSession(session.sessionId);

    expect(published.filter(event => event.type === 'session.update'
      && event.body?.patch?.previewTarget === null)).toHaveLength(0);
  });

  it('does not resurrect the target when the closed session is resumed', async () => {
    const { session } = createFixture();
    await closeSession(session.sessionId);

    const revived = sessionStore.reactivateClosedSession(session.sessionId);
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    // resume 开的是新一代 worker，它还没注册过任何端口。
    expect(revived.session.previewTarget).toBeUndefined();
    sessionStore.init('app');
    expect(sessionStore.getSession(session.sessionId)?.previewTarget).toBeUndefined();
  });
});
