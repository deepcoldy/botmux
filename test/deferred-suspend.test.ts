// 延迟挂起（deferred suspend）的兑现半边：会话正在产出时 IPC 路由只记
// `pendingSuspendReason`，真正的 kill 推迟到会话转入 idle/limited 后由
// runPendingSuspendIfSettled 兑现。这里钉住兑现函数的状态门控与幂等；
// 排队半边（IPC 路由）见 ipc-suspend-route.test.ts。
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { spawnTsEval } from './helpers/ts-runner.js';
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

import {
  __testOnly_runPendingSuspendIfSettled as runPendingSuspendIfSettled,
  suspendWorker,
  setSessionReasoningEffort,
  sessionReasoningControl,
  __testOnly_sessionAgentConfig as sessionAgentConfig,
} from '../src/core/worker-pool.js';
vi.mock('../src/services/codex-transcript.js', async orig => ({
  ...await orig<typeof import('../src/services/codex-transcript.js')>(),
  findCodexRolloutBySessionId: vi.fn(() => new URL('../package.json', import.meta.url).pathname),
  drainCodexRollout: vi.fn(() => ({ events: [{ kind: 'assistant_final' }], newOffset: 1, pendingTail: '' })),
}));
import { drainCodexRollout, findCodexRolloutBySessionId } from '../src/services/codex-transcript.js';
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

  // 钉住 predicate 的防御语义（defense-in-depth）：当传入的 generation 判定为假
  // —— 排队那一代已不再持有会话 —— 兑现必须早退，且不能吃掉排队，留给真正属主的
  // 那一代 settle 时再兑现。此前这里写过两版「陈旧 idle 落在 refork 后的会话上」的
  // 具体 race，均已被推翻为不可达；predicate 为何仍值得保留，见 worker-pool.ts
  // runPendingSuspendIfSettled 上方注释。
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

/**
 * claim 的生命周期必须止于它自己那一代 worker。
 *
 * 原实现只在兑现函数内部清标志，而兑现函数只被 screen_update /
 * screenshot_uploaded 两个 checkpoint 调用 —— 会话一旦安静下来就再没有
 * checkpoint。于是「排队之后 worker 崩了，或被 /cd、读隔离切换先挂起」这类路径
 * 会把标志留到下一代，下一代第一次 idle 时被平白挂一次；而 ownsGeneration 谓词
 * 挡不住，因为那时传进来的正是新 worker 自己的闭包。
 */
describe('queued suspend claim lifecycle', () => {
  function claimedSession(status = 'idle') {
    const worker = fakeWorker();
    const ds: any = {
      session: { sessionId: 'sid-claim', status: 'active' },
      initConfig: { backendType: 'tmux' },
      worker,
      workerGeneration: 7,
      lastScreenStatus: status,
      exitEventEmitted: false,
      pendingSuspendReason: 'manual_suspend',
      pendingSuspendGeneration: 7,
    };
    return { ds, worker };
  }

  // /cd、读隔离切换、idle sweeper 都是直接调 suspendWorker，从不路过兑现函数。
  // 目标态（这一代被挂起）已经达成，claim 必须就地消费掉。
  it('is consumed by ANY successful suspend, not just the deferred checkpoint', () => {
    const { ds, worker } = claimedSession('working');   // 注意：还在产出也不影响

    expect(suspendWorker(ds, 'role_switch')).toBe(true);

    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
    expect(ds.pendingSuspendReason).toBeUndefined();
    expect(ds.pendingSuspendGeneration).toBeUndefined();
  });

  // 拒绝是暂时的，claim 不能被吃掉（与既有 pty 用例同一条不变式，这里补上
  // generation 字段一并保留的断言）。
  it('survives a refused suspend together with its generation', () => {
    const { ds } = claimedSession();
    ds.initConfig = { backendType: 'pty' };

    expect(suspendWorker(ds, 'manual_suspend')).toBe(false);

    expect(ds.pendingSuspendReason).toBe('manual_suspend');
    expect(ds.pendingSuspendGeneration).toBe(7);
  });

  // 兜底：claim 万一漏过了上面的消费点，到了下一代也绝不能挂新 worker。
  it('never suspends a LATER generation — it consumes the stale claim instead', () => {
    const { ds, worker } = claimedSession();
    ds.workerGeneration = 8;              // 已经 refork 过，claim 属于第 7 代

    runPendingSuspendIfSettled(ds);

    expect(worker.send).not.toHaveBeenCalled();   // 新 worker 毫发无伤
    expect(ds.worker).toBe(worker);
    expect(ds.pendingSuspendReason).toBeUndefined();
    expect(ds.pendingSuspendGeneration).toBeUndefined();
  });

  // 同一代则照常兑现 —— 上面那条门控不能把正常路径也一并挡掉。
  it('still fulfills when the claim belongs to the CURRENT generation', () => {
    const { ds, worker } = claimedSession();

    runPendingSuspendIfSettled(ds);

    expect(worker.send).toHaveBeenCalledWith({ type: 'suspend' });
    expect(ds.pendingSuspendReason).toBeUndefined();
  });
});


describe('session reasoning effort changes', () => {
  function session(status = 'idle') {
    const pair = busySession(status, { pending: undefined });
    Object.assign(pair.ds.session, { cliId: 'codex', cliSessionId: 'native-original', reasoningEffort: 'ultra' });
    Object.assign(pair.ds.initConfig, { cliId: 'codex', wrapperCli: 'aiden x codex', model: 'gpt-5.6-sol' });
    Object.assign(pair.ds, { workerReady: true, activeReasoningEffort: 'ultra' });
    return pair;
  }

  it('saves without retiring the worker and clears pending only after the new effort is observed', () => {
    const { ds, worker } = session();
    expect(setSessionReasoningEffort(ds, 'high')).toBe('saved');
    expect(ds.session).toMatchObject({ reasoningEffort: 'high', cliSessionId: 'native-original', status: 'active' });
    expect(ds.session.suspendedColdResume).toBeUndefined();
    expect(ds.activeReasoningEffort).toBe('ultra');
    expect(sessionReasoningControl(ds)).toMatchObject({ selected: 'high', pending: true });
    expect(setSessionReasoningEffort(ds, 'high')).toBe('saved');
    expect(setSessionReasoningEffort(ds, 'low')).toBe('saved');
    expect(ds.worker).toBe(worker);
    expect(worker.send).not.toHaveBeenCalled();
    ds.activeReasoningEffort = 'low';
    expect(sessionReasoningControl(ds)?.pending).toBe(false);
  });

  it('keeps a running preview process reachable across repeated changes', async () => {
    const child = spawnTsEval(`
      const { createServer } = await import('node:http');
      const server = createServer((_, res) => res.end('preview-alive'));
      process.on('message', msg => { if (msg.type === 'suspend') server.close(() => process.exit(0)); });
      server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
    `, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    try {
      const [{ port }] = await once(child, 'message');
      const { ds } = session();
      ds.worker = child;
      ds.workerPort = port;
      ds.session.previewTarget = { url: `http://127.0.0.1:${port}` };
      const preview = structuredClone(ds.session.previewTarget);
      const pid = child.pid;
      for (const effort of ['high', 'low', 'low']) {
        expect(setSessionReasoningEffort(ds, effort)).toBe('saved');
        expect(await (await fetch(preview.url)).text()).toBe('preview-alive');
        expect(ds.worker.pid).toBe(pid);
        expect(ds.workerPort).toBe(port);
        expect(ds.session.previewTarget).toEqual(preview);
      }
    } finally {
      if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    }
  });

  it('updates the selected CLI snapshot used by a later cold launch', async () => {
    const { ds } = session();
    ds.session.cliLaunchSnapshot = { state: 'resolved', cliId: 'codex', reasoningEffort: 'ultra', startupCommands: [] };
    expect(setSessionReasoningEffort(ds, 'high')).toBe('saved');
    const restored = { ...ds, session: JSON.parse(JSON.stringify(ds.session)), worker: null };
    expect(sessionAgentConfig(restored, { cliId: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'ultra' }).reasoningEffort).toBe('high');
    const { updateSession } = await import('../src/services/session-store.js');
    vi.mocked(updateSession).mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => setSessionReasoningEffort(ds, 'low')).toThrow('disk full');
    expect(ds.session.reasoningEffort).toBe('high');
    expect(ds.session.cliLaunchSnapshot.reasoningEffort).toBe('high');
  });

  it('reads only the bound instance history and fails closed when that history is missing', async () => {
    const native = await vi.importActual<typeof import('../src/services/codex-transcript.js')>('../src/services/codex-transcript.js');
    const dir = mkdtempSync(join(tmpdir(), 'effort-instance-'));
    const oldHome = process.env.CODEX_HOME;
    try {
      const { ds } = session();
      delete ds.initConfig.wrapperCli;
      const boundHome = join(dir, 'bound');
      const globalHome = join(dir, 'global');
      process.env.CODEX_HOME = globalHome;
      ds.session.cliInstanceBinding = { source: 'pool', codexHome: boundHome };
      for (const home of [boundHome, globalHome]) {
        mkdirSync(join(home, 'sessions'), { recursive: true });
        writeFileSync(join(home, 'sessions', 'rollout-test-native-original.jsonl'), JSON.stringify({
          type: 'event_msg', timestamp: '2026-01-01T00:00:00Z',
          payload: { type: 'task_complete', turn_id: 'test-turn', last_agent_message: 'Done' },
        }) + '\n');
      }
      vi.mocked(findCodexRolloutBySessionId).mockImplementationOnce(native.findCodexRolloutBySessionId);
      vi.mocked(drainCodexRollout).mockImplementationOnce(native.drainCodexRollout);
      expect(setSessionReasoningEffort(ds, 'high')).toBe('saved');
      expect(findCodexRolloutBySessionId).toHaveBeenLastCalledWith('native-original', { codexHome: boundHome, noFollow: true });
      rmSync(join(boundHome, 'sessions'), { recursive: true });
      vi.mocked(findCodexRolloutBySessionId).mockImplementationOnce(native.findCodexRolloutBySessionId);
      expect(setSessionReasoningEffort(ds, 'low')).toBe('busy');
      expect(ds.session.reasoningEffort).toBe('high');
    } finally {
      if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['working', 'analyzing', 'starting', 'limited', 'waiting_input'])('does not change or interrupt %s', status => {
    const { ds, worker } = session(status);
    expect(setSessionReasoningEffort(ds, 'high')).toBe('busy');
    expect(ds.session.reasoningEffort).toBe('ultra');
    expect(worker.send).not.toHaveBeenCalled();
  });

  it.each(['adoptedFrom', 'codexRpcInput', 'backendType', 'wrapperCli', 'sandbox', 'readIsolation'])('refuses an unsupported %s path', field => {
    const { ds, worker } = session();
    if (field === 'adoptedFrom') ds.session.adoptedFrom = { pane: 'external' };
    else ds.initConfig[field] = { codexRpcInput: true, backendType: 'riff', wrapperCli: 'other codex', sandbox: true, readIsolation: true }[field];
    expect(setSessionReasoningEffort(ds, 'high')).toBe('unsupported');
    expect(worker.send).not.toHaveBeenCalled();
    expect(ds.session.reasoningEffort).toBe('ultra');
  });

  it('rejects unsupported effort and protects queued work even with an idle screen', () => {
    const { ds, worker } = session();
    expect(setSessionReasoningEffort(ds, 'typo')).toBe('invalid');
    ds.initConfig.model = 'gpt-5.5';
    expect(setSessionReasoningEffort(ds, 'ultra')).toBe('invalid');
    ds.session.queued = true;
    expect(setSessionReasoningEffort(ds, 'high')).toBe('busy');
    expect(worker.send).not.toHaveBeenCalled();
  });

  it('does not trust an idle screen while native history still has an unfinished turn', () => {
    const { ds, worker } = session();
    vi.mocked(drainCodexRollout).mockReturnValueOnce({ events: [{ kind: 'user', text: 'ongoing', uuid: 'u', timestampMs: 1 }], newOffset: 1, pendingTail: '' });
    expect(setSessionReasoningEffort(ds, 'high')).toBe('busy');
    expect(worker.send).not.toHaveBeenCalled();
    expect(ds.session.reasoningEffort).toBe('ultra');
  });

  it('does not retire a worker if saving the new selection fails', async () => {
    const { updateSession } = await import('../src/services/session-store.js');
    const { ds, worker } = session();
    vi.mocked(updateSession).mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => setSessionReasoningEffort(ds, 'high')).toThrow('disk full');
    expect(ds.session.reasoningEffort).toBe('ultra');
    expect(worker.send).not.toHaveBeenCalled();
  });
});
