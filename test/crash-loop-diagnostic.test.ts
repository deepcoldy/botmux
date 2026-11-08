/**
 * Daemon-side crash-loop handling — worker-pool `case 'claude_exit'`, rc.count > 3.
 *
 *   - canParkDiagnostic:true   → KEEP the worker (ask it to park via park_diagnostic),
 *     reset the restart counter, status → idle, and mark the session
 *     suspendedColdResume so the parked diagnostic shell's "send a message to
 *     retry" affordance survives a daemon restart (restore lazy-resumes
 *     instead of zombie-closing).
 *   - canParkDiagnostic:false  → historical path: kill the worker.
 *
 * Run:  pnpm vitest run --project unit test/crash-loop-diagnostic.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ─── Mocks (mirror worker-ready-display-mode.test.ts harness) ────────────────

vi.mock('../src/im/lark/client.js', () => {
  class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  }
  return {
    updateMessage: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    MessageWithdrawnError,
  };
});

vi.mock('../src/im/lark/card-builder.js', () => ({
  buildStreamingCard: vi.fn(() => '{"type":"streaming"}'),
  buildSessionCard: vi.fn(() => '{"type":"session"}'),
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
    session: { dataDir: '/tmp/test-sessions' },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));

const updateSessionMock = vi.fn();
const sessionReplyMock = vi.fn(async () => 'om_reply');
vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: (...args: any[]) => updateSessionMock(...args),
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/core/session-manager.js', () => ({
  persistStreamCardState: vi.fn(),
  ensureSessionWhiteboard: vi.fn(),
  rememberLastCliInput: vi.fn(),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

vi.mock('../src/core/dashboard-rows.js', () => ({
  composeRowFromActive: vi.fn(),
}));

vi.mock('../src/skills/installer.js', () => ({
  ensureSkills: vi.fn(),
}));

vi.mock('../src/adapters/cli/registry.js', () => ({
  createCliAdapterSync: vi.fn(),
}));

vi.mock('../src/adapters/cli/claude-code.js', () => ({
  claudeJsonlPathForSession: vi.fn(),
}));

vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: class {},
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

// ─── Imports under test ──────────────────────────────────────────────────────

import { initWorkerPool, __testOnly_setupWorkerHandlers, __testOnly_resetRestartCoordinator, restartCounts, sendWorkerInput } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { getBot } from '../src/bot-registry.js';
import { createWorkerStderrRing, WORKER_ERROR_MARKER } from '../src/core/worker-stderr-ring.js';
import { sandboxNamespaceNotice } from '../src/core/system-bwrap.js';
import { buildStreamingCard } from '../src/im/lark/card-builder.js';
import { RESTART_WINDOW_MS } from '../src/core/restart-policy.js';

function makeFakeWorker() {
  const w = new EventEmitter() as any;
  w.killed = false;
  w.send = vi.fn();
  w.kill = vi.fn();
  w.pid = 12345;
  w.stdout = new EventEmitter();
  w.stderr = new EventEmitter();
  return w;
}

function makeDs(sessionId: string, worker: any): DaemonSession {
  return {
    session: {
      sessionId,
      rootMessageId: 'om_root',
      chatId: 'oc_chat',
      title: 'Test Session',
      status: 'active' as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pid: null,
      chatType: 'group',
    },
    worker,
    workerPort: null,
    workerToken: null,
    larkAppId: 'app_test',
    chatId: 'oc_chat',
    chatType: 'group',
    spawnedAt: Date.now(),
    cliVersion: '1.0',
    lastMessageAt: Date.now(),
    hasHistory: false,
    displayMode: 'hidden',
    lastScreenContent: '',
    lastScreenStatus: 'working',
    currentTurnTitle: 'Test task',
  } as DaemonSession;
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

async function crashTimes(worker: any, n: number, canParkDiagnostic?: boolean, code: number | null = 1) {
  for (let i = 0; i < n; i++) {
    worker.emit('message', { type: 'claude_exit', code, signal: null, canParkDiagnostic });
  }
  await flush();
}

describe("crash-loop diagnostic terminal (daemon 'claude_exit' handler)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restartCounts.clear();
    __testOnly_resetRestartCoordinator();
    initWorkerPool({
      sessionReply: sessionReplyMock,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
  });

  it('does not auto-restart a crashed Riff worker and tells the user how to recover', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-riff-no-restart', worker);
    ds.session.cliId = 'riff';
    ds.session.backendType = 'riff';
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashTimes(worker, 1);

    expect(worker.send).not.toHaveBeenCalledWith({ type: 'restart' });
    expect(restartCounts.has('sid-riff-no-restart')).toBe(false);
    expect(sessionReplyMock).toHaveBeenCalledWith(
      'om_root',
      expect.stringMatching(/Riff.*不支持重启.*\/close/),
      'text',
      'app_test',
      undefined,
      { sourceSessionId: 'sid-riff-no-restart' },
    );
  });

  it('does not duplicate recovery guidance while an explicit Riff close owns the exit', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-riff-closing', worker);
    ds.session.cliId = 'riff';
    ds.session.backendType = 'riff';
    ds.remoteCloseState = {
      phase: 'preparing',
      requestId: 'close-riff',
      taskId: 'task-riff',
    };
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashTimes(worker, 1);

    expect(worker.send).not.toHaveBeenCalledWith({ type: 'restart' });
    expect(restartCounts.has('sid-riff-closing')).toBe(false);
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  it('after >3 tmux crashes: keeps the worker + marks lazy cold-resume (survives restart)', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-diag-keep', worker);
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashTimes(worker, 4, true);

    // First 3 auto-restart in place; the 4th asks the worker to park a
    // diagnostic shell (deferred park) and keeps it alive (no close).
    // auto-restart 捎带最新 per-bot env + 最新模型 + larkToolBinding（本 fixture 的 mock getBot
    // env/model 未配 → 均为 null；larkToolBinding 默认开启 → 为 true；三分态 contract: true 启用 / null 明确清空 / undefined 保持），
    // 并标记 reason: 'cli_crash' 区分 operator 主动 restart；经 restart coordinator 发出，
    // 必带 attemptId（#1863：只有关联回执能放开 workerReady 栅栏）。
    expect(worker.send).toHaveBeenCalledWith({
      type: 'restart', attemptId: expect.any(String), reason: 'cli_crash',
      env: null, envUnset: null, envFingerprint: expect.any(String), model: null, larkToolBinding: true,
      codexRpcInput: false, traexAutoModel: null, startupCommands: null, launchShell: null,
    });
    expect(worker.send).toHaveBeenCalledWith({ type: 'park_diagnostic' });
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'close' });
    // Survives daemon restart: lazy cold-resume + idle, restart counter reset.
    expect(ds.session.suspendedColdResume).toBe(true);
    expect(ds.lastScreenStatus).toBe('idle');
    expect(restartCounts.has('sid-diag-keep')).toBe(false);
    expect(updateSessionMock).toHaveBeenCalled();
  });

  // The parked worker respawns the CLI ITSELF when the next message arrives
  // (worker.ts `Message received after crash-loop stop`), so that message is the
  // only channel that can refresh its launch snapshot — a model changed while the
  // session sat parked must reach the recovery spawn.
  it('carries the current launch model on the message that triggers the parked retry', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-diag-model', worker);
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashTimes(worker, 4, true);
    expect(ds.crashDiagnosticParked).toBe(true);

    // The user changes the bot's model while the session sits parked.
    vi.mocked(getBot).mockReturnValue({
      config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', model: 'opus', startupCommands: ['/effort xhigh'], launchShell: 'bash' },
      resolvedAllowedUsers: [],
      botOpenId: 'ou_bot',
      botName: 'TestBot',
    } as any);
    worker.send.mockClear();

    sendWorkerInput(ds, 'retry please', 'om_turn_retry');

    const message = worker.send.mock.calls.map((c: any[]) => c[0]).find((m: any) => m.type === 'message');
    expect(message?.model).toBe('opus');
    // Same for the startup commands / shell edited while parked (the recovery
    // spawn replays them).
    expect(message?.startupCommands).toEqual(['/effort xhigh']);
    expect(message?.launchShell).toBe('bash');

    // Once a CLI is live again the refresh stops riding along on every turn.
    worker.emit('message', { type: 'ready', port: 1234, token: 't' });
    expect(ds.crashDiagnosticParked).toBeUndefined();
  });

  it('clears suspendedColdResume once the retried CLI reaches prompt_ready (in-place retry path)', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-diag-cleared', worker);
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashTimes(worker, 4, true);
    expect(ds.session.suspendedColdResume).toBe(true); // parked → marked for restart survival

    // The in-place retry (worker.ts) respawns the CLI WITHOUT going through
    // forkWorker; prompt_ready is the daemon's signal that retry succeeded.
    worker.emit('message', { type: 'prompt_ready' });
    await flush();

    expect(ds.session.suspendedColdResume).toBeFalsy();
  });

  it('after >3 crashes with NO diagnostic terminal: kills the worker (historical path)', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-diag-nokeep', worker);
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashTimes(worker, 4, undefined);

    expect(worker.send).toHaveBeenCalledWith({ type: 'close' });
    expect(ds.session.suspendedColdResume).toBeFalsy();
  });

  it('the crash freeze keeps the terminal keys grid the session had open', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-crash-keys', worker);
    ds.streamCardId = 'om_stream_card';
    ds.streamCardNonce = 'nonce_live';
    ds.keysPanelOpen = true;
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashTimes(worker, 3, undefined);
    // Each auto-restart clears readiness; the card is frozen only when the CLI
    // came back up before the crash that ends the loop.
    ds.workerReady = true;
    await crashTimes(worker, 1, undefined);

    expect(buildStreamingCard).toHaveBeenCalled();
    expect(vi.mocked(buildStreamingCard).mock.calls.at(-1)?.[24]).toBe(true);
  });

  it('crash card falls back to the per-worker stderr ring when logTail is missing', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-diag-ring', worker);
    const ring = createWorkerStderrRing();
    // Banner/progress noise, then a real fault line pinned by the marker.
    ring.push('worker banner line one');
    ring.push(`${WORKER_ERROR_MARKER} RING_ROOT_CAUSE fatal`);
    for (let i = 0; i < 12; i++) ring.push(`noise-after-${i}`);
    __testOnly_setupWorkerHandlers(ds, worker, undefined, undefined, ring);

    await crashTimes(worker, 4, undefined);

    const cardText = sessionReplyMock.mock.calls.at(-1)?.[1] as string;
    expect(cardText).toContain('最近的 worker 输出（可能含死因）：');
    // The pinned marker survives even though 12 newer normal lines followed.
    expect(cardText).toContain('RING_ROOT_CAUSE');
    expect(cardText).toContain('noise-after-11');
  });

  it('crash card keeps a worker-provided logTail and does not duplicate the ring', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-diag-logtail', worker);
    const ring = createWorkerStderrRing();
    ring.push(`${WORKER_ERROR_MARKER} RING_MUST_NOT_APPEAR`);
    __testOnly_setupWorkerHandlers(ds, worker, undefined, undefined, ring);

    for (let i = 0; i < 3; i++) {
      worker.emit('message', { type: 'claude_exit', code: 1, signal: null });
    }
    worker.emit('message', {
      type: 'claude_exit',
      code: 1,
      signal: null,
      logTail: 'WORKER_LOGTAIL_PAYLOAD',
    });
    await flush();

    const cardText = sessionReplyMock.mock.calls.at(-1)?.[1] as string;
    expect(cardText).toContain('WORKER_LOGTAIL_PAYLOAD');
    expect(cardText).toContain('最近终端输出：');
    expect(cardText).not.toContain('RING_MUST_NOT_APPEAR');
    expect(cardText).not.toContain('最近的 worker 输出（可能含死因）：');
  });

  it('crash card names an unsupported bwrap namespace with the docs link', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-diag-namespace', worker);
    __testOnly_setupWorkerHandlers(ds, worker, undefined, undefined, createWorkerStderrRing());
    for (let i = 0; i < 4; i++) {
      worker.emit('message', { type: 'claude_exit', code: 1, signal: null, sandboxNamespace: 'pid' });
    }
    await flush();
    const cardText = sessionReplyMock.mock.calls.at(-1)?.[1] as string;
    expect(cardText).toContain(sandboxNamespaceNotice('pid', 'zh'));
  });

  it('startup-failure notice names an unsupported bwrap namespace', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-start-namespace', worker);
    __testOnly_setupWorkerHandlers(ds, worker, undefined, undefined, createWorkerStderrRing());
    worker.emit('message', { type: 'error', message: 'bwrap failed', sandboxNamespace: 'user' });
    await flush();
    const notice = sessionReplyMock.mock.calls.at(-1)?.[1] as string;
    expect(notice).toContain('bwrap failed');
    expect(notice).toContain(sandboxNamespaceNotice('user', 'zh'));
  });

  it('pre-ready exit notice appends the per-worker stderr ring tail', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-preready-ring', worker);
    const ring = createWorkerStderrRing();
    ring.push(`${WORKER_ERROR_MARKER} EARLY_FATAL_LINE boom`);
    ring.push('early-noise-line');
    __testOnly_setupWorkerHandlers(ds, worker, undefined, undefined, ring);

    worker.emit('exit', 1, null);
    await flush();

    const notice = sessionReplyMock.mock.calls.at(-1)?.[1] as string;
    expect(notice).toContain('exit code: 1');
    expect(notice).toContain('EARLY_FATAL_LINE');
    expect(notice).toContain('最近的 worker 输出（可能含死因）：');
  });

  // ─── 退出码语义（PR #2164） ───────────────────────────────────────────────
  //
  // 永久退出（身份 77 / 命令缺失 127）与「1 分钟内抖动 N 次」是两种不同的停止
  // 原因。永久通道刻意跨 60s 窗口累计，两次崩溃可能相隔很久，所以卡片不能再说
  // 「1 分钟内崩溃 N 次」——那句话在永久场景下是假话。
  it('stops on a permanent exit code and says so, instead of claiming "N crashes in 1 minute"', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-permanent-exit', worker);
    __testOnly_setupWorkerHandlers(ds, worker);

    // 第一次永久退出给一次重启机会，第二次停止。
    await crashTimes(worker, 2, true, 77);

    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'restart', reason: 'cli_crash' }));
    const notice = sessionReplyMock.mock.calls.at(-1)?.[1] as string;
    // 说明是确定性失败 + 退出码，且不再声称时间窗。
    expect(notice).toContain('77');
    expect(notice).not.toContain('1 分钟');
  });

  it('still uses the 1-minute window wording for an ordinary crash loop', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-window-budget', worker);
    __testOnly_setupWorkerHandlers(ds, worker);

    await crashTimes(worker, 4, true);

    const notice = sessionReplyMock.mock.calls.at(-1)?.[1] as string;
    expect(notice).toContain('1 分钟');
  });

  // 恢复健康即清零：CLI 跑到可输入 prompt 并稳定存活，说明此前那些崩溃不构成
  // 持续的确定性故障。不清掉的话，一次历史 127 会让这条会话此后任何一次 127 都
  // 立即放弃自动重启（评审实测隔 90 天仍如此）。不使用假时钟——bun:test 的假定时器
  // 会接管 setTimeout 让 flush() 死锁；改为把 readyAt 直接拨老来模拟「已存活满窗」，
  // 严格的窗口边界（恰好满窗 vs 超 1ms）由 restart-policy 的纯函数用例覆盖。
  it('clears the crash-restart streak once the CLI stays up a full window after ready', async () => {
    const sid = 'sid-ready-clears-streak';
    const worker = makeFakeWorker();
    const ds = makeDs(sid, worker);
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'claude_exit', code: 127, signal: null, canParkDiagnostic: true });
    await flush();
    expect(restartCounts.get(sid)?.permanentCount).toBe(1);

    // The CLI reaches a prompt: prompt_ready stamps readyAt once and keeps the streak.
    worker.emit('message', { type: 'prompt_ready' });
    await flush();
    const firstReadyAt = restartCounts.get(sid)?.readyAt;
    expect(firstReadyAt).not.toBeUndefined();

    // Simulate the CLI having stayed up a full window; a later ready must not re-anchor.
    const agedReadyAt = Date.now() - RESTART_WINDOW_MS - 1;
    restartCounts.get(sid)!.readyAt = agedReadyAt;
    worker.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(restartCounts.get(sid)?.readyAt).toBe(agedReadyAt);

    // So the NEXT permanent exit gets its own fresh single chance instead of
    // being killed on arrival by a stale streak.
    worker.emit('message', { type: 'claude_exit', code: 127, signal: null, canParkDiagnostic: true });
    await flush();
    expect(restartCounts.get(sid)?.permanentCount).toBe(1);
    expect(worker.send).not.toHaveBeenCalledWith({ type: 'park_diagnostic' });
    expect(sessionReplyMock).not.toHaveBeenCalled();
  });

  // #2551：到了 prompt 不等于恢复健康。CLI 每收到（被重投的）同一条输入就退出
  // 时，每次重启都能到 prompt；若 ready 就清零，熔断永远不触发，会话在后台无限
  // 「退出 → 重启 → 重投 → 退出」，用户收不到任何提示。
  it('stops a crash-on-input loop even though every respawn reaches the prompt', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-crash-on-input', worker);
    __testOnly_setupWorkerHandlers(ds, worker);

    for (let i = 0; i < 4; i++) {
      if (i > 0) {
        worker.emit('message', { type: 'prompt_ready' });
        await flush();
      }
      worker.emit('message', { type: 'claude_exit', code: 42, signal: null, canParkDiagnostic: true });
      await flush();
    }

    expect(worker.send).toHaveBeenCalledWith({ type: 'park_diagnostic' });
    const notice = sessionReplyMock.mock.calls.at(-1)?.[1] as string;
    expect(notice).toContain('崩溃 4 次');
  });

  it('stops a permanent exit that recurs right after the respawn reached the prompt', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs('sid-permanent-after-ready', worker);
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'claude_exit', code: 127, signal: null, canParkDiagnostic: true });
    await flush();
    worker.emit('message', { type: 'prompt_ready' });
    await flush();
    worker.emit('message', { type: 'claude_exit', code: 127, signal: null, canParkDiagnostic: true });
    await flush();

    expect(worker.send).toHaveBeenCalledWith({ type: 'park_diagnostic' });
    const notice = sessionReplyMock.mock.calls.at(-1)?.[1] as string;
    expect(notice).toContain('127');
  });

  // Node worker 进程换代（OOM / 管控杀死，没有 claude_exit）是比 in-worker CLI
  // respawn 更强的边界：替代 worker 是全新一代，不能让上一代锚定的 readyAt 与
  // 崩溃计数连坐它——否则新 CLI 在旧 readyAt 的窗口内第一次 127 就被直接熔断，
  // 连自己唯一的一次重启机会都没有。
  it('gives the replacement Node worker its own permanent budget after the old worker died', async () => {
    const sid = 'sid-worker-generation-reset';
    const w1 = makeFakeWorker();
    const ds = makeDs(sid, w1);
    __testOnly_setupWorkerHandlers(ds, w1);

    w1.emit('message', { type: 'claude_exit', code: 127, signal: null, canParkDiagnostic: true });
    await flush();
    expect(restartCounts.get(sid)?.permanentCount).toBe(1);
    w1.emit('message', { type: 'prompt_ready' });
    await flush();
    expect(restartCounts.get(sid)?.readyAt).not.toBeUndefined();

    // The Node worker itself is killed (no claude_exit); the stale streak is
    // still parked on the session until a replacement worker is bound.
    w1.emit('exit', 137, 'SIGKILL');
    await flush();
    expect(restartCounts.get(sid)?.readyAt).not.toBeUndefined();

    // Daemon forks a replacement worker (next user message / continuation resume):
    // binding the new generation voids the old streak and its readyAt.
    const w2 = makeFakeWorker();
    ds.worker = w2;
    __testOnly_setupWorkerHandlers(ds, w2);
    expect(restartCounts.has(sid)).toBe(false);
    w2.emit('message', { type: 'prompt_ready' });
    await flush();
    w2.emit('message', { type: 'claude_exit', code: 127, signal: null, canParkDiagnostic: true });
    await flush();

    // First permanent exit OF THE NEW GENERATION gets its own single restart.
    expect(restartCounts.get(sid)?.permanentCount).toBe(1);
    const w2Messages = w2.send.mock.calls.map((c: any[]) => c[0]);
    expect(w2Messages.some(m => m?.type === 'restart')).toBe(true);
    expect(w2Messages.some(m => m?.type === 'park_diagnostic')).toBe(false);
  });

  // 非 tmux（PTY）后端熔断后走 killWorker（worker 同步解绑，进程随后退出）：
  // 用户下一条消息 fork 出新 worker 代次时必须作废旧计数，与 tmux 的 park 路径
  // 对称——否则新 CLI 第一次崩溃就带着旧计数被再次熔断，只能 /close。
  it('gives the post-crash-loop replacement worker a fresh budget on non-tmux backends', async () => {
    const sid = 'sid-pty-killworker-clears';
    const w1 = makeFakeWorker();
    const ds = makeDs(sid, w1);
    __testOnly_setupWorkerHandlers(ds, w1);

    await crashTimes(w1, 4, false, 1);
    expect(w1.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'close' }));
    // killWorker detached the worker synchronously; the process exit follows.
    w1.emit('exit', 0, null);
    await flush();
    expect(restartCounts.get(sid)?.count).toBe(4);

    // The next user message forks a replacement worker: binding it resets the streak.
    const w2 = makeFakeWorker();
    ds.worker = w2;
    __testOnly_setupWorkerHandlers(ds, w2);
    expect(restartCounts.has(sid)).toBe(false);

    w2.emit('message', { type: 'prompt_ready' });
    await flush();
    w2.emit('message', { type: 'claude_exit', code: 1, signal: null, canParkDiagnostic: false });
    await flush();
    expect(restartCounts.get(sid)?.count).toBe(1);
    expect(w2.send.mock.calls.map((c: any[]) => c[0]).some(m => m?.type === 'restart')).toBe(true);
  });

});
