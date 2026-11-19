/**
 * busySinceAt（这一段忙碌从什么时候开始）的边界：经真实的 worker-pool 运行态边沿（stampIdleSinceAt）
 * 和真实的提示缓存保活扫描驱动，再交给任务状态、看板的推导看结果。
 *
 * Run: bun run vitest run test/session-busy-since.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const globalConfig: { promptCache?: unknown } = {};

vi.mock('../src/config.js', () => ({
  config: {
    web: { externalHost: 'localhost' },
    session: { dataDir: '/tmp/session-busy-since-unused' },
    daemon: { backendType: 'tmux', cliId: 'claude-code' },
  },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/services/session-store.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/session-store.js')>(),
  updateSession: () => {},
}));
vi.mock('../src/global-config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/global-config.js')>(),
  readGlobalConfig: () => globalConfig,
}));
vi.mock('../src/services/statusline-snapshot.js', () => ({
  readStatuslineSnapshot: () => ({ ts: Date.now(), contextPercent: 40, contextWindowTokens: 1_000_000 }),
}));

import { dashboardEventBus } from '../src/core/dashboard-events.js';
import { notePromptCacheKeepaliveResult, resetPromptCacheKeepalive, runPromptCacheKeepaliveSweep } from '../src/core/prompt-cache-keepalive.js';
import { deriveSessionTaskStatus } from '../src/core/session-task-status.js';
import { stampIdleSinceAt } from '../src/core/worker-pool.js';
import { deriveKanbanColumn } from '../src/dashboard/web/kanban-model.js';
import type { DaemonSession } from '../src/core/types.js';

const SEC = 1_000;
const MIN = 60_000;
const NOON = new Date(2026, 9, 23, 12, 0, 0).getTime();
const IDLE_SINCE = NOON - 55 * MIN;
const RAISED_AT = NOON - 30 * MIN;
const PLACED_AT = NOON - 20 * MIN;

type ScreenStatus = 'idle' | 'starting' | 'working' | 'analyzing' | 'active' | 'limited';

/** 空闲了 55 分钟的 Claude Code 会话：agent 举手等决定，之后有人把卡片手动拖到「已完成」。 */
function makeDs(): DaemonSession {
  return {
    session: { sessionId: 'b5b5b5b5-0000-0000-0000-000000000000' },
    worker: { killed: false },
    workerReady: true,
    initConfig: { cliId: 'claude-code', backendType: 'tmux', locale: 'zh' },
    lastScreenStatus: 'idle',
    idleSinceAt: IDLE_SINCE,
    agentAttention: { kind: 'decision', reason: '要不要合入？', at: RAISED_AT, source: 'agent' },
  } as unknown as DaemonSession;
}

/** worker 上报一次屏幕状态（可以和上一次相同），走生产代码的盖戳。 */
function screenUpdate(ds: DaemonSession, status: ScreenStatus, at: number): void {
  const prev = ds.lastScreenStatus;
  ds.lastScreenStatus = status;
  stampIdleSinceAt(ds, prev, at);
}

/** daemon 的保活扫描在 at 这一刻给这个空闲会话打了一次保活。 */
function keepalive(ds: DaemonSession, at: number): void {
  globalConfig.promptCache = { keepalive: { enabled: true } };
  const sent = runPromptCacheKeepaliveSweep([ds], {
    bot: {} as never, dataDir: '/tmp/unused', send: () => true, log: () => {}, now: new Date(at),
  });
  expect(sent).toBe(1);
}

/** 任务状态和看板看到的这一行。 */
function row(ds: DaemonSession) {
  return {
    status: ds.lastScreenStatus,
    busySinceAt: ds.busySinceAt,
    agentAttention: ds.agentAttention,
    kanbanColumn: 'done',
    kanbanColumnAt: PLACED_AT,
  };
}

const patches: Array<Record<string, unknown>> = [];
dashboardEventBus.subscribe(event => {
  const patch = event.type === 'session.update' ? (event.body as { patch?: Record<string, unknown> }).patch : undefined;
  if (patch && 'busySinceAt' in patch) patches.push(patch);
});

beforeEach(() => {
  globalConfig.promptCache = undefined;
  patches.length = 0;
});

describe('busySinceAt', () => {
  it('进入忙碌时记下时刻，一直忙着不动，离开忙碌就清掉', () => {
    const ds = makeDs();
    screenUpdate(ds, 'starting', NOON);
    expect(ds.busySinceAt).toBe(NOON);
    screenUpdate(ds, 'working', NOON + 5 * SEC);
    screenUpdate(ds, 'working', NOON + 6 * SEC);
    screenUpdate(ds, 'analyzing', NOON + 10 * SEC);
    screenUpdate(ds, 'active', NOON + 15 * SEC);
    expect(ds.busySinceAt).toBe(NOON);
    screenUpdate(ds, 'idle', NOON + 20 * SEC);
    expect(ds.busySinceAt).toBeUndefined();
    screenUpdate(ds, 'working', NOON + 30 * SEC);
    expect(ds.busySinceAt).toBe(NOON + 30 * SEC);
    screenUpdate(ds, 'limited', NOON + 40 * SEC);
    expect(ds.busySinceAt).toBeUndefined();
    // 状态变化时的时刻跟着 screen_update 自己的补丁走，这里不重复推。
    expect(patches).toEqual([]);
  });

  it('真的开始干活：举手被新一轮盖过，手动放的列也失效', () => {
    const ds = makeDs();
    expect(deriveSessionTaskStatus(row(ds))).toMatchObject({ kind: 'needs_you', reason: 'attention' });
    expect(deriveKanbanColumn(row(ds))).toBe('done');
    screenUpdate(ds, 'working', NOON);
    expect(deriveSessionTaskStatus(row(ds))).toEqual({ kind: 'working', since: NOON });
    expect(deriveKanbanColumn(row(ds))).toBe('in_progress');
  });

  it('提示缓存保活自己的忙碌段不算新一轮：举手还挡着，手动放的列也还在', () => {
    const ds = makeDs();
    keepalive(ds, NOON);
    screenUpdate(ds, 'working', NOON + 2 * SEC);
    expect(ds.busySinceAt).toBeUndefined();
    expect(deriveSessionTaskStatus(row(ds))).toMatchObject({ kind: 'needs_you', reason: 'attention' });
    expect(deriveKanbanColumn(row(ds))).toBe('done');
    screenUpdate(ds, 'idle', NOON + 20 * SEC);
    expect(ds.busySinceAt).toBeUndefined();
    expect(ds.idleSinceAt).toBe(IDLE_SINCE);
    expect(deriveKanbanColumn(row(ds))).toBe('done');
    expect(patches).toEqual([]);
  });

  it('保活还没回到空闲就开始了真的一轮：这段忙碌算到真的一轮上，并推给看板', () => {
    const ds = makeDs();
    keepalive(ds, NOON);
    screenUpdate(ds, 'working', NOON + 2 * SEC);
    // daemon 派发新一轮时（beginNewTurn）重置保活。
    resetPromptCacheKeepalive(ds, NOON + 5 * SEC);
    expect(ds.busySinceAt).toBe(NOON + 5 * SEC);
    expect(patches).toEqual([{ busySinceAt: NOON + 5 * SEC }]);
    expect(deriveSessionTaskStatus(row(ds))).toEqual({ kind: 'working', since: NOON + 5 * SEC });
    expect(deriveKanbanColumn(row(ds))).toBe('in_progress');
    screenUpdate(ds, 'analyzing', NOON + 8 * SEC);
    expect(ds.busySinceAt).toBe(NOON + 5 * SEC);
    screenUpdate(ds, 'idle', NOON + 30 * SEC);
    expect(ds.busySinceAt).toBeUndefined();
    expect(ds.idleSinceAt).toBe(NOON + 30 * SEC);
  });

  it('开始新一轮时屏幕还没转忙，或这段忙碌已经记过：不动 busySinceAt', () => {
    const ds = makeDs();
    keepalive(ds, NOON);
    // 保活已打出、屏幕还没转忙：留给接下来的忙碌边沿去记。
    resetPromptCacheKeepalive(ds, NOON + 1 * SEC);
    expect(ds.busySinceAt).toBeUndefined();
    screenUpdate(ds, 'working', NOON + 2 * SEC);
    expect(ds.busySinceAt).toBe(NOON + 2 * SEC);
    resetPromptCacheKeepalive(ds, NOON + 9 * SEC);
    expect(ds.busySinceAt).toBe(NOON + 2 * SEC);
    expect(patches).toEqual([]);
  });

  it('保活打进去以后一直没回到空闲（比如网页终端接着敲了字）：过了 10 分钟的在飞窗口就补记，并推给看板', () => {
    const ds = makeDs();
    keepalive(ds, NOON);
    notePromptCacheKeepaliveResult(ds, true);
    screenUpdate(ds, 'working', NOON + 2 * SEC);
    screenUpdate(ds, 'working', NOON + 10 * MIN - 1);
    expect(ds.busySinceAt).toBeUndefined();
    screenUpdate(ds, 'working', NOON + 10 * MIN);
    expect(ds.busySinceAt).toBe(NOON + 10 * MIN);
    expect(patches).toEqual([{ busySinceAt: NOON + 10 * MIN }]);
    expect(deriveSessionTaskStatus(row(ds))).toEqual({ kind: 'working', since: NOON + 10 * MIN });
    screenUpdate(ds, 'analyzing', NOON + 11 * MIN);
    screenUpdate(ds, 'working', NOON + 12 * MIN);
    expect(ds.busySinceAt).toBe(NOON + 10 * MIN);
    expect(patches).toHaveLength(1);
  });

  it('worker 拒收保活时忙碌边沿已经先到：这段忙碌是真的工作，下一次上报就补记；先派发了真的一轮就从派发时刻记', () => {
    const ds = makeDs();
    keepalive(ds, NOON);
    screenUpdate(ds, 'working', NOON + 1 * SEC);
    notePromptCacheKeepaliveResult(ds, false);
    expect(ds.busySinceAt).toBeUndefined();
    screenUpdate(ds, 'working', NOON + 20 * SEC);
    expect(ds.busySinceAt).toBe(NOON + 20 * SEC);
    expect(patches).toEqual([{ busySinceAt: NOON + 20 * SEC }]);

    const dispatched = makeDs();
    keepalive(dispatched, NOON);
    screenUpdate(dispatched, 'working', NOON + 1 * SEC);
    notePromptCacheKeepaliveResult(dispatched, false);
    resetPromptCacheKeepalive(dispatched, NOON + 3 * SEC);
    expect(dispatched.busySinceAt).toBe(NOON + 3 * SEC);
  });

  it('保活打出去 10 分钟还没回到空闲就不再当保活，转忙照常记时刻', () => {
    const fresh = makeDs();
    keepalive(fresh, NOON);
    screenUpdate(fresh, 'working', NOON + 10 * MIN - 1);
    expect(fresh.busySinceAt).toBeUndefined();
    const stale = makeDs();
    keepalive(stale, NOON);
    screenUpdate(stale, 'working', NOON + 10 * MIN);
    expect(stale.busySinceAt).toBe(NOON + 10 * MIN);
  });
});
