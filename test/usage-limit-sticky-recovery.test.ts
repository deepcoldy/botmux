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
import { describe, it, expect, vi, beforeEach } from 'bun:test';
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
import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import type { CliUsageLimitState } from '../src/utils/cli-usage-limit.js';
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
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SESSION_DATA_DIR = mkdtempSync(join(tmpdir(), 'botmux-limit-'));
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
});
