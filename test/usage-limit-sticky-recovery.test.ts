/**
 * 限额状态的粘性与自愈（daemon 侧 screen_update / screenshot_uploaded 处理器）。
 *
 * 背景：限额状态一旦命中会粘在 ds.usageLimit 上，直到下一轮用户消息才清除。
 * 2026-08 的线上误报（Codex/Hermes）有一类是：CLI 实际仍在工作（worker 持续
 * 上报 working），卡片却一直显示「限额已达」。修复约定：
 *   - worker 帧带新鲜 usageLimit → limited（权威判定）
 *   - worker 帧无 usageLimit 且状态为 working/analyzing → 旧限额是误报，清除
 *   - worker 帧无 usageLimit 且状态为 idle/stalled → 保持 limited（冷却/重试 UX）
 *
 * Run: pnpm vitest run test/usage-limit-sticky-recovery.test.ts
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

import { registerBot } from '../src/bot-registry.js';
import { initWorkerPool, restoreUsageLimitRuntimeState, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import type { CliUsageLimitState } from '../src/utils/cli-usage-limit.js';
import { detectCliUsageLimit } from '../src/utils/cli-usage-limit.js';
import { annotateAntigravityUsageLimit } from '../src/adapters/cli/antigravity.js';
import type { WorkerToDaemon } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';

const APP = 'limit_app';

function makeDs(over: Partial<DaemonSession> = {}): DaemonSession {
  // status:'active' 是 screen_update 处理器 ownsLifecycleMutation 守卫的要求；
  // workerPort 让 workerHasInitialized 通过（与 turn-reactions 测试同型）。
  const session: any = { sessionId: 'sess-' + Math.random().toString(36).slice(2), chatId: 'oc_x', rootMessageId: 'om_root', status: 'active' };
  return { session, larkAppId: APP, chatId: 'oc_x', scope: 'chat', ...over } as unknown as DaemonSession;
}

function makeFakeWorker() {
  const worker = new EventEmitter() as any;
  worker.killed = false;
  worker.send = vi.fn();
  worker.kill = vi.fn();
  worker.pid = 4242;
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  return worker;
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function dispatch(worker: EventEmitter, message: WorkerToDaemon): Promise<void> {
  for (const listener of worker.listeners('message')) await listener(message);
  await vi.advanceTimersByTimeAsync(0);
}

function rateLimitState(): CliUsageLimitState {
  return {
    limited: true,
    kind: 'rate',
    retryAtMs: Date.now() + 60_000,
    retryLabel: '5-10 min',
    retryReady: false,
  };
}

describe('usage-limit sticky state self-heal', () => {
  afterEach(() => {
    sessionStore.__testOnly_setBeforeRowPersist(undefined);
    vi.useRealTimers();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SESSION_DATA_DIR = mkdtempSync(join(tmpdir(), 'botmux-limit-'));
    sessionStore.init(APP);
    registerBot({
      larkAppId: APP,
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_o'],
      disableStreamingCard: true,
    });
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    });
  });

  it('limited → working(无 usageLimit) 自愈：清除限额状态', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'screen_update', content: '429 Too Many Requests', status: 'limited', usageLimit: rateLimitState() });
    await flush();
    expect(ds.usageLimit).toBeDefined();
    expect(ds.lastScreenStatus).toBe('limited');

    // CLI 恢复工作：worker 上报 working 且不带新鲜 usageLimit。
    worker.emit('message', { type: 'screen_update', content: 'working output continues', status: 'working' });
    await flush();

    expect(ds.usageLimit).toBeUndefined();
    expect(ds.usageLimitRetryTimer).toBeUndefined();
    expect(ds.lastScreenStatus).toBe('working');
  });

  it('keeps a relative refusal deadline across repeated worker screenshots and a persisted restore', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 1));
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(ds, worker);
    const text = 'Individual quota reached. Resets in 1m.\nError ID: episode-one';
    const initial = detectCliUsageLimit(text);
    if (!initial.limited) throw new Error('Expected relative quota');
    worker.emit('message', { type: 'screen_update', content: text, status: 'limited', usageLimit: initial });
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.usageLimit?.retryAtMs).toBe(initial.retryAtMs);
    await vi.advanceTimersByTimeAsync(20_000);
    const repeated = detectCliUsageLimit(text);
    worker.emit('message', { type: 'screenshot_uploaded', imageKey: 'img_relative', status: 'limited', usageLimit: repeated });
    await vi.advanceTimersByTimeAsync(0);
    expect(ds.usageLimit?.retryAtMs).toBe(initial.retryAtMs);

    const restored = makeDs({ usageLimit: JSON.parse(JSON.stringify(ds.usageLimit)) });
    restoreUsageLimitRuntimeState(restored);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(restored.usageLimit?.retryReady).toBe(true);
    expect(ds.usageLimit?.retryReady).toBe(true);
  });

  it('keeps a native quota through syslog/screenshot noise and SQLite reload, then releases on actual CLI work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 1));
    const worker = makeFakeWorker();
    const session = sessionStore.createSession('oc_x', 'om_native', 'native error', 'group', 'chat');
    const ds = makeDs({ worker, workerPort: 9999, session });
    __testOnly_setupWorkerHandlers(ds, worker);
    const text = '⚠ Individual quota reached. Resets in 1m.\nError ID: native-episode\n────\n>\n────\n';
    const detected = detectCliUsageLimit(text);
    if (!detected.limited) throw new Error('Expected relative quota');
    const initial = annotateAntigravityUsageLimit(text, detected);
    await dispatch(worker, { type: 'screen_update', content: text, status: 'limited', usageLimit: initial });
    await vi.advanceTimersByTimeAsync(20_000);
    await dispatch(worker, { type: 'screen_update', content: 'kernel: unrelated interface state changed', status: 'working' });
    await dispatch(worker, { type: 'screenshot_uploaded', imageKey: 'img_noise', status: 'working' });
    expect(ds.lastScreenStatus).toBe('limited');
    expect(ds.usageLimit?.retryAtMs).toBe(initial.retryAtMs);
    const stored = sessionStore.getSessionFresh(session.sessionId)!;
    const restoredWorker = makeFakeWorker();
    const restored = makeDs({ session: stored, usageLimit: stored.usageLimit, worker: restoredWorker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(restored, restoredWorker);
    restoreUsageLimitRuntimeState(restored);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(restored.usageLimit?.retryReady).toBe(true);
    expect(restored.usageLimit?.retryAtMs).toBe(initial.retryAtMs);
    await dispatch(restoredWorker, { type: 'screen_update', content: '⣻ Running command...\n>\nesc to cancel · 1 task(s)', status: 'working' });
    expect(restored.lastScreenStatus).toBe('working');
    expect(restored.usageLimit).toBeUndefined();
  });

  it('persists native provenance when a partial quota frame later gains its complete composer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 1));
    const worker = makeFakeWorker();
    const session = sessionStore.createSession('oc_x', 'om_provenance', 'native quota provenance', 'group', 'chat');
    const ds = makeDs({ worker, workerPort: 9999, session });
    __testOnly_setupWorkerHandlers(ds, worker);
    const partial = '⚠ Individual quota reached. Resets in 1m.\nError ID: partial-episode';
    const initial = detectCliUsageLimit(partial);
    if (!initial.limited) throw new Error('Expected quota');
    await dispatch(worker, { type: 'screen_update', content: partial, status: 'limited', usageLimit: initial });
    await vi.advanceTimersByTimeAsync(10_000);
    const complete = partial + '\n────\n>\n────\n';
    const confirmed = annotateAntigravityUsageLimit(complete, initial);
    await dispatch(worker, { type: 'screen_update', content: complete, status: 'limited', usageLimit: confirmed });
    expect(sessionStore.getSessionFresh(session.sessionId)?.usageLimit?.source).toBe('antigravity-error-composer');
    expect(ds.usageLimit?.retryAtMs).toBe(initial.retryAtMs);
  });

  it('retries a failed first persistence without moving the episode deadline or losing its timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 1));
    const worker = makeFakeWorker();
    const session = sessionStore.createSession('oc_x', 'om_retry', 'retry state write', 'group', 'chat');
    const ds = makeDs({ worker, workerPort: 9999, session });
    __testOnly_setupWorkerHandlers(ds, worker);
    const text = 'Individual quota reached. Resets in 1m.\nError ID: write-episode';
    const initial = detectCliUsageLimit(text);
    if (!initial.limited) throw new Error('Expected relative quota');
    sessionStore.__testOnly_setBeforeRowPersist(() => { throw new Error('injected quota write failure'); });
    await expect(dispatch(worker, { type: 'screen_update', content: text, status: 'limited', usageLimit: initial })).rejects.toThrow('injected quota write failure');
    sessionStore.__testOnly_setBeforeRowPersist(undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    const repeated = detectCliUsageLimit(text);
    if (!repeated.limited) throw new Error('Expected repeated quota');
    await dispatch(worker, { type: 'screen_update', content: text, status: 'limited', usageLimit: repeated });
    expect(ds.usageLimit?.retryAtMs).toBe(initial.retryAtMs);
    expect(ds.usageLimitRetryTimer).toBeDefined();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(ds.usageLimit?.retryReady).toBe(true);
    expect(sessionStore.getSessionFresh(session.sessionId)?.usageLimit?.retryReady).toBe(true);
  });

  it.each(['timer', 'expired restore'] as const)('retries a failed retry-ready write from %s on the next unchanged frame', async path => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 1));
    const worker = makeFakeWorker();
    const session = sessionStore.createSession('oc_x', 'om_ready_write', 'retry-ready write', 'group', 'chat');
    const ds = makeDs({ worker, workerPort: 9999, session });
    __testOnly_setupWorkerHandlers(ds, worker);
    const text = 'Individual quota reached. Resets in 1m.\nError ID: ready-write-episode';
    const initial = detectCliUsageLimit(text);
    if (!initial.limited) throw new Error('Expected relative quota');
    await dispatch(worker, { type: 'screen_update', content: text, status: 'limited', usageLimit: initial });
    if (path === 'expired restore') {
      clearTimeout(ds.usageLimitRetryTimer);
      ds.usageLimitRetryTimer = undefined;
    }
    sessionStore.__testOnly_setBeforeRowPersist(() => { throw new Error('injected retry-ready write failure'); });
    await vi.advanceTimersByTimeAsync(60_000);
    if (path === 'expired restore') expect(() => restoreUsageLimitRuntimeState(ds)).toThrow('injected retry-ready write failure');
    expect(ds.usageLimitPersistPending).toBe(true);
    sessionStore.__testOnly_setBeforeRowPersist(undefined);
    const repeated = detectCliUsageLimit(text);
    if (!repeated.limited) throw new Error('Expected repeated quota');
    await dispatch(worker, { type: 'screen_update', content: text, status: 'limited', usageLimit: repeated });
    expect(ds.usageLimit?.retryAtMs).toBe(initial.retryAtMs);
    expect(sessionStore.getSessionFresh(session.sessionId)?.usageLimit?.retryReady).toBe(true);
    expect(ds.usageLimitPersistPending).toBe(false);
  });

  it('does not release a long restored quota when the platform timer reaches its maximum delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 1));
    const resetAfter = 30 * 24 * 60 * 60 * 1000;
    const ds = makeDs({ usageLimit: { ...rateLimitState(), retryAtMs: Date.now() + resetAfter } });
    restoreUsageLimitRuntimeState(ds);
    await vi.advanceTimersByTimeAsync(resetAfter - 1);
    expect(ds.usageLimit?.retryReady).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ds.usageLimit?.retryReady).toBe(true);
  });

  it('ignores an old retry timer after active work clears the quota', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 1));
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(ds, worker);
    worker.emit('message', { type: 'screen_update', content: 'limited', status: 'limited', usageLimit: rateLimitState() });
    await vi.advanceTimersByTimeAsync(0);
    worker.emit('message', { type: 'screen_update', content: 'new output', status: 'working' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ds.usageLimit).toBeUndefined();
    expect(ds.lastScreenStatus).toBe('working');
  });

  it('limited → idle(无 usageLimit) 保持 limited：冷却/重试 UX 不被普通 idle 帧冲掉', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(ds, worker);

    const limit = rateLimitState();
    worker.emit('message', { type: 'screen_update', content: '429 Too Many Requests', status: 'limited', usageLimit: limit });
    await flush();

    worker.emit('message', { type: 'screen_update', content: 'still blocked', status: 'idle' });
    await flush();

    expect(ds.usageLimit).toBeDefined();
    expect(ds.lastScreenStatus).toBe('limited');
  });

  it('limited → working(带新鲜 usageLimit) 保持 limited：新鲜判定优先', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'screen_update', content: '429 Too Many Requests', status: 'limited', usageLimit: rateLimitState() });
    await flush();

    const fresh = rateLimitState();
    worker.emit('message', { type: 'screen_update', content: '429 Too Many Requests', status: 'working', usageLimit: fresh });
    await flush();

    expect(ds.usageLimit).toBe(fresh);
    expect(ds.lastScreenStatus).toBe('limited');
  });

  it('screenshot_uploaded 通道同样自愈', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999, displayMode: 'screenshot' });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'screenshot_uploaded', imageKey: 'img_1', status: 'limited', usageLimit: rateLimitState() });
    await flush();
    expect(ds.usageLimit).toBeDefined();
    expect(ds.lastScreenStatus).toBe('limited');

    worker.emit('message', { type: 'screenshot_uploaded', imageKey: 'img_2', status: 'working' });
    await flush();

    expect(ds.usageLimit).toBeUndefined();
    expect(ds.lastScreenStatus).toBe('working');
  });

  it('stalled 帧不触发自愈：停滞会话可能真的卡在限额错误屏', async () => {
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'screen_update', content: '429 Too Many Requests', status: 'limited', usageLimit: rateLimitState() });
    await flush();

    worker.emit('message', { type: 'screen_update', content: 'no progress', status: 'stalled' });
    await flush();

    expect(ds.usageLimit).toBeDefined();
    expect(ds.lastScreenStatus).toBe('limited');
  });

  it('publishes every accepted screen status to the external runtime-card sink even when default cards are off', async () => {
    const onScreenStatus = vi.fn(async () => undefined);
    initWorkerPool({
      sessionReply: vi.fn(async () => 'om_reply'),
      getSessionWorkingDir: () => '/repo',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
      onScreenStatus,
    });
    const worker = makeFakeWorker();
    const ds = makeDs({ worker, workerPort: 9999 });
    __testOnly_setupWorkerHandlers(ds, worker);

    worker.emit('message', { type: 'screen_update', content: 'busy', status: 'working' });
    worker.emit('message', { type: 'screen_update', content: 'still busy', status: 'working' });
    worker.emit('message', { type: 'screen_update', content: 'stuck', status: 'stalled' });
    await flush();

    expect(onScreenStatus.mock.calls.map(call => call[1].status)).toEqual(['working', 'working', 'stalled']);
  });
});
