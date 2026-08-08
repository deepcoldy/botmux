// 延迟挂起（deferred suspend）的兑现半边：会话正在产出时 IPC 路由只记
// `pendingSuspendReason`，真正的 kill 推迟到会话转入 idle/limited 后由
// runPendingSuspendIfSettled 兑现。这里钉住兑现函数的状态门控与幂等；
// 排队半边（IPC 路由）见 ipc-suspend-route.test.ts。
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  updateSessionPid: vi.fn(),
  updateSession: vi.fn(),
}));
vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { __testOnly_runPendingSuspendIfSettled as runPendingSuspendIfSettled } from '../src/core/worker-pool.js';
import { logger } from '../src/utils/logger.js';

function fakeWorker() {
  return {
    killed: false,
    pid: 12345,
    send: vi.fn(),
    once: vi.fn(),
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
  } as any;
}

function busySession(status: string, opts: { pending?: string } = {}) {
  const worker = fakeWorker();
  const ds: any = {
    session: { sessionId: `sid-${status}`, status: 'active' },
    initConfig: { backendType: 'tmux' },
    worker,
    workerPort: 3456,
    workerToken: 'token',
    lastScreenStatus: status,
    exitEventEmitted: false,
    pendingSuspendReason: 'pending' in opts ? opts.pending : 'manual_suspend',
  };
  return { ds, worker };
}

describe('runPendingSuspendIfSettled', () => {
  it('is a no-op with no queued suspend', () => {
    const { ds, worker } = busySession('idle', { pending: undefined });

    runPendingSuspendIfSettled(ds);

    expect(worker.send).not.toHaveBeenCalled();
    expect(ds.worker).toBe(worker);
  });

  // 排队的全部理由：这两个状态正在产出，杀 worker 会丢掉这一轮回复。
  it.each(['working', 'analyzing'])('is a no-op while still producing (%s)', (status) => {
    const { ds, worker } = busySession(status);

    runPendingSuspendIfSettled(ds);

    expect(worker.send).not.toHaveBeenCalled();
    expect(ds.worker).toBe(worker);
    // 标志必须留着 —— 否则这次排队就被静默吞掉，会话永远挂不起来。
    expect(ds.pendingSuspendReason).toBe('manual_suspend');
  });

  // limited 同样没有在产出内容，挂起不切断任何东西，而且这类会话正是内存回收最该清理的。
  it.each(['idle', 'limited'])('fulfills once the turn settles (%s)', (status) => {
    const { ds, worker } = busySession(status);

    runPendingSuspendIfSettled(ds);

    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
    expect(ds.worker).toBe(null);
    expect(ds.session.status).toBe('active');
    expect(ds.session.suspendedColdResume).toBe(true);
    expect(ds.pendingSuspendReason).toBeUndefined();
  });

  it('carries the queued reason through to suspendWorker', () => {
    const { ds } = busySession('idle');
    ds.pendingSuspendReason = 'rotation_xyz';

    runPendingSuspendIfSettled(ds);

    // reason 只经由日志可观测——断言它真的被透传，而不是只断言标志被清（那样
    // 实现把 reason 写死也会绿）。
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('rotation_xyz'));
  });

  // suspendWorker 会拒绝（返回 false）而不做任何改动：routing transfer 进行中，
  // 或 backend 不可挂起。拒绝是**暂时**的，吃掉标志会让这次请求一路丢到下一个
  // `suspend all` 周期才补回来。routing transfer 的门是模块私有的，这里用同样走
  // 「早退且零副作用」的 pty 分支来钉住「拒绝 ⇒ 标志保留」这条不变式。
  it('keeps the flag queued when suspendWorker refuses', () => {
    const { ds, worker } = busySession('idle');
    ds.initConfig = { backendType: 'pty' };

    runPendingSuspendIfSettled(ds);

    expect(worker.send).not.toHaveBeenCalled();
    expect(ds.pendingSuspendReason).toBe('manual_suspend');
  });

  // 只保留标志还不够：会话安静下来后就不再有 screen_update，可能永远等不到下一个
  // checkpoint。transfer 结算后必须有一个显式的重试触发点。
  it('re-arms on transfer settle rather than waiting for a checkpoint that may never come', () => {
    const src = readFileSync(join(process.cwd(), 'src/core/worker-pool.ts'), 'utf8');
    const fn = src.slice(
      src.indexOf('function runPendingSuspendIfSettled'),
      src.indexOf('export const __testOnly_runPendingSuspendIfSettled'),
    );
    expect(fn).toContain('deferUntilSessionTransferSettled(ds, () => runPendingSuspendIfSettled(ds, ownsGeneration))');
    // 传的必须是纯 generation 判定：ownsLifecycleMutation 把「不在 transfer 中」
    // 也折了进去，用它会让 transfer 期间被当成「不是我们的」而跳过重试注册。
    expect(src).toContain('runPendingSuspendIfSettled(ds, ownsWorkerSession)');
    expect(src).not.toContain('runPendingSuspendIfSettled(ds, ownsLifecycleMutation)');
  });

  // 最危险的一条：`screenshot_uploaded` 自己没有 ownership 守卫，旧 worker 退出前
  // 排队的 idle 可能晚到并落在已经 refork 过的会话上。放行就会把**刚起来的**
  // worker 挂掉 —— 正在产出时就是原样复现本功能要消灭的截断 bug。
  it('refuses to fulfill from a stale worker generation', () => {
    const { ds, worker } = busySession('idle');

    runPendingSuspendIfSettled(ds, () => false);

    expect(worker.send).not.toHaveBeenCalled();
    expect(ds.worker).toBe(worker);
    // 陈旧的 checkpoint 不该消费掉排队 —— 当前 generation 自己 settle 时还要兑现。
    expect(ds.pendingSuspendReason).toBe('manual_suspend');
  });

  it('fulfills when the calling generation still owns the session', () => {
    const { ds, worker } = busySession('idle');

    runPendingSuspendIfSettled(ds, () => true);

    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
    expect(ds.pendingSuspendReason).toBeUndefined();
  });

  it('does not re-suspend on a second settled tick', () => {
    const { ds, worker } = busySession('idle');

    runPendingSuspendIfSettled(ds);
    worker.send.mockClear();
    // suspendWorker 会把 lastScreenStatus 清空；模拟随后又来一个 idle 更新。
    ds.lastScreenStatus = 'idle';
    runPendingSuspendIfSettled(ds);

    expect(worker.send).not.toHaveBeenCalled();
  });

  // 排队期间 worker 崩溃 / 被 idle-worker-sweeper 抢先挂起：目标态已达成，清标志即可。
  it.each([
    ['missing', null],
    ['already killed', { killed: true, send: vi.fn() }],
  ])('clears the flag without suspending when the worker is %s', (_state, worker) => {
    const ds: any = {
      session: { sessionId: 'sid-gone', status: 'active' },
      initConfig: { backendType: 'tmux' },
      worker,
      lastScreenStatus: 'idle',
      pendingSuspendReason: 'manual_suspend',
    };

    runPendingSuspendIfSettled(ds);

    expect(ds.pendingSuspendReason).toBeUndefined();
    // suspendWorker 的 no-worker 分支会顺手清 managedTurnOrigin/workerReady；
    // 兑现函数必须在它之前 return，不产生这些副作用。
    expect(ds.workerReady).toBeUndefined();
    if (worker) expect((worker as any).send).not.toHaveBeenCalled();
  });
});
