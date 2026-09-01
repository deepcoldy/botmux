/**
 * P1-13：previewTarget 在 worker 生命周期边界上的闭环。
 *
 * previewTarget 指向「当代 CLI 在本机 loopback 上拉起来的 Web 服务」。worker 一换代
 * （refork / 切 CLI / adopt）、被 suspend、或者进程退出，那棵进程树就没了，端口号随时
 * 会被别的本机进程接管——目标必须在同一次落盘里失效，并且向 Dashboard 广播
 * `preview: null`，否则会话卡片继续显示预览入口、既有的预览长连接也拿不到断流信号。
 *
 * 这里驱动的是真实的生命周期函数（reserveWorkerGeneration / suspendWorker / worker
 * 'exit' 事件处理器），不是任何「清理 helper」的直接调用。
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'bun:test';

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
  MessageWithdrawnError: class extends Error {},
}));

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{}'),
  buildSessionCard: vi.fn(() => '{}'),
  buildTuiPromptCard: vi.fn(() => '{}'),
  buildTuiPromptResolvedCard: vi.fn(() => '{}'),
  getCliDisplayName: vi.fn(() => 'Claude'),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
}));

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/test-preview-lifecycle' },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  updateSessionPid: vi.fn(),
  getOwnedSession: vi.fn(() => undefined),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  ensureSessionWhiteboard: vi.fn(),
  persistStreamCardState: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(() => ({ tokenUsage: null })),
  composeRowFromClosed: vi.fn(() => ({})),
}));

vi.mock('../src/skills/installer.js', () => ({ ensureSkills: vi.fn() }));
vi.mock('../src/adapters/cli/registry.js', () => ({ createCliAdapterSync: vi.fn() }));
vi.mock('../src/adapters/cli/claude-code.js', () => ({ claudeJsonlPathForSession: vi.fn() }));
vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: class {
    static killSession() {}
    static diagnosticSessionName(id: string) { return `bmx-diag-${id}`; }
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import {
  initWorkerPool,
  suspendWorker,
  __testOnly_reserveWorkerGeneration,
  __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import * as sessionStore from '../src/services/session-store.js';
import type { DaemonSession } from '../src/core/types.js';

const PREVIEW_TARGET = {
  host: '127.0.0.1' as const,
  port: 4173,
  registeredAt: '2026-08-11T12:00:00.000Z',
  owner: { pid: 4242, procStart: '918273', inode: '556677' },
  workerGeneration: 5,
};

function makeFakeWorker(pid = 12345) {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.pid = pid;
  worker.exitCode = null;
  worker.signalCode = null;
  worker.send = vi.fn();
  worker.kill = vi.fn();
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return worker;
}

function makeDs(overrides?: Partial<DaemonSession>): DaemonSession {
  return {
    session: {
      sessionId: 'sid-preview-lifecycle',
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'Preview lifecycle',
      status: 'active',
      createdAt: '2026-08-11T00:00:00.000Z',
      chatType: 'group',
      cliId: 'claude-code',
      workingDir: '/repo',
      workerGeneration: 5,
      previewTarget: { ...PREVIEW_TARGET },
    },
    workerGeneration: 5,
    worker: makeFakeWorker(),
    workerPort: 9999,
    workerToken: 'tok',
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1234,
    lastMessageAt: 5678,
    hasHistory: false,
    workingDir: '/repo',
    displayMode: 'hidden',
    initConfig: { backendType: 'tmux' },
    ...overrides,
  } as unknown as DaemonSession;
}

function previewClearEvents(): unknown[] {
  return (dashboardEventBus.publish as any).mock.calls
    .map((call: unknown[]) => call[0])
    .filter((event: any) => event?.type === 'session.update'
      && event.body?.patch
      && Object.prototype.hasOwnProperty.call(event.body.patch, 'previewTarget')
      && event.body.patch.previewTarget === null);
}

beforeEach(() => {
  vi.clearAllMocks();
  initWorkerPool({
    sessionReply: vi.fn(async () => 'om_reply'),
    getSessionWorkingDir: () => '/repo',
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  });
});

describe('P1-13 worker generation boundaries drop the preview target', () => {
  it('clears and persists on generation reservation (refork / CLI switch / adopt all reserve here)', () => {
    const ds = makeDs();

    const generation = __testOnly_reserveWorkerGeneration(ds);

    expect(generation).toBe(6);
    expect(ds.session.previewTarget).toBeUndefined();
    // 同一次 save：磁盘上不能出现「代次已经是 6、预览还指着第 5 代那个端口」。
    const saved = (sessionStore.updateSession as any).mock.calls.at(-1)[0];
    expect(saved.workerGeneration).toBe(6);
    expect(saved.previewTarget).toBeUndefined();
    expect(previewClearEvents()).toHaveLength(1);
  });

  it('rolls back the whole reservation when the durable save fails', () => {
    const ds = makeDs();
    (sessionStore.updateSession as any).mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(() => __testOnly_reserveWorkerGeneration(ds)).toThrow('disk full');

    // 预留失败 = 上一代仍然是权威的：代次与预览必须一起回到原样。
    expect(ds.session.workerGeneration).toBe(5);
    expect(ds.workerGeneration).toBe(5);
    expect(ds.session.previewTarget).toEqual(PREVIEW_TARGET);
    expect(previewClearEvents()).toHaveLength(0);
  });

  it('publishes nothing extra when the session had no preview target', () => {
    const ds = makeDs();
    ds.session.previewTarget = undefined;

    __testOnly_reserveWorkerGeneration(ds);

    expect(previewClearEvents()).toHaveLength(0);
  });

  it('clears on suspend: the CLI and its dev server are destroyed, the session stays active', () => {
    const ds = makeDs();

    expect(suspendWorker(ds, 'suspended_idle')).toBe(true);

    expect(ds.session.previewTarget).toBeUndefined();
    expect((sessionStore.updateSession as any).mock.calls.at(-1)[0].previewTarget).toBeUndefined();
    expect(previewClearEvents()).toHaveLength(1);
  });

  it('clears when the worker process exits', () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker });
    __testOnly_setupWorkerHandlers(ds, worker, { ready: false, failureNotified: false }, 5);
    // setupWorkerHandlers 本身不换代（沿用已预留的代次），此刻目标仍在。
    expect(ds.session.previewTarget).toEqual(PREVIEW_TARGET);

    worker.emit('exit', 1, null);

    expect(ds.session.previewTarget).toBeUndefined();
    const saved = (sessionStore.updateSession as any).mock.calls.at(-1)[0];
    expect(saved.previewTarget).toBeUndefined();
    // 退出围栏推进代次，预览随同一次落盘失效。
    expect(saved.workerGeneration).toBeGreaterThan(5);
    expect(previewClearEvents()).toHaveLength(1);
  });

  it('leaves a replacement worker alone when a stale worker exits', () => {
    const stale = makeFakeWorker(111);
    const live = makeFakeWorker(222);
    const ds = makeDs({ worker: stale });
    __testOnly_setupWorkerHandlers(ds, stale, { ready: false, failureNotified: false }, 5);
    // takeover：新 worker 已经接管，旧 worker 的 exit 才姗姗来迟。
    ds.worker = live;

    stale.emit('exit', 0, null);

    expect(ds.session.previewTarget).toEqual(PREVIEW_TARGET);
    expect(previewClearEvents()).toHaveLength(0);
  });
});
