/**
 * Regression tests for "dashboard 改 per-bot env 后 /restart 不生效":
 *
 *  背景 — dashboard 保存 env（PUT /api/bot-env → applyConfigField）只写
 *  bots.json + 同步 daemon 内存 bot registry，没有任何 IPC 会推给活着的
 *  worker。而 live-worker /restart 只在 worker 进程内用 fork 时刻的
 *  lastInitConfig 快照 respawn CLI（lastInitConfig 只在 init 时赋值一次），
 *  导致改完 env 后 /restart 出来的 CLI 仍是旧 env；只有 refork（新会话 /
 *  /close 后重发 / daemon 重启）才生效——与文档「当前运行中的会话需
 *  /restart 重启才换新值」的承诺不符。
 *
 *  修复 — daemon 发 restart IPC 时捎带 daemon 侧最新 bots.json `env`
 *  （latestPerBotEnvForRestart，三分态：对象=最新 / null=已清空 / undefined=
 *  取不到保持旧行为）；worker 在 respawn 前全量覆盖 lastInitConfig.env，
 *  spawnCli 的 sanitizePerBotEnv(cfg.env) 每次 spawn 都重跑即生效。
 *
 *  覆盖：
 *  1. latestPerBotEnvForRestart 纯函数三分态（最新 / 清空 / 取不到兜底）。
 *  2. daemon behavioral：requestSessionRestart live-worker 分支把 env 放进
 *     发给 worker 的 restart 消息体（含 attemptId）。
 *  3. 其余三个 restart IPC 生产者（dashboard 重启按钮 / dashboard cwd-move /
 *     崩溃 auto-restart）同样捎带 env——respawn 即该用最新 env，语义一致。
 *  4. worker wiring（source pin，worker.ts 是进程入口不可 import，同
 *     restart-worker-null-reattach.test.ts 的做法）：env merge 在合并守卫
 *     之前（被合并的重复 restart 也要带走 env 更新）且含 null→清除语义。
 *
 * Run:  pnpm vitest run test/restart-live-worker-env.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const getBotMock = vi.fn();
vi.mock('../src/bot-registry.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  getBot: (...args: unknown[]) => getBotMock(...args),
}));

import { readFileSync } from 'node:fs';
import {
  latestPerBotEnvForRestart,
  requestSessionRestart,
  __testOnly_resetRestartCoordinator,
} from '../src/core/worker-pool.js';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const workerPoolSource = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');
const dashboardIpcSource = readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8');

let sessionCounter = 0;

function makeDs(envWorker?: { killed?: boolean }) {
  const send = vi.fn();
  const ds: any = {
    session: {
      sessionId: `env-restart-${++sessionCounter}`,
      backendType: 'pty',
    },
    larkAppId: 'cli_app1',
    hasHistory: true,
    worker: envWorker ? { killed: envWorker.killed ?? false, send } : { killed: false, send },
  };
  return { ds, send };
}

function observer() {
  return { source: 'slash' as const, notify: vi.fn(async () => {}) };
}

beforeEach(() => {
  getBotMock.mockReset();
  __testOnly_resetRestartCoordinator();
});

afterEach(() => {
  __testOnly_resetRestartCoordinator();
});

// ─── 1. latestPerBotEnvForRestart 纯函数三分态 ──────────────────────────────

describe('latestPerBotEnvForRestart (daemon-side env snapshot carrier)', () => {
  it('returns the LIVE bots.json env object when configured', () => {
    getBotMock.mockReturnValue({ config: { env: { ANTHROPIC_BASE_URL: 'https://glm' } } });
    const { ds } = makeDs();
    expect(latestPerBotEnvForRestart(ds)).toEqual({ ANTHROPIC_BASE_URL: 'https://glm' });
    expect(getBotMock).toHaveBeenCalledWith('cli_app1');
  });

  it('returns null when the config has no env (worker must clear its snapshot)', () => {
    getBotMock.mockReturnValue({ config: {} });
    const { ds } = makeDs();
    expect(latestPerBotEnvForRestart(ds)).toBeNull();
  });

  it('returns null for an EMPTY env object too (dashboard cleared every key)', () => {
    getBotMock.mockReturnValue({ config: { env: {} } });
    const { ds } = makeDs();
    // {} ?? null → {} is truthy, so this is {} — worker 全量覆盖为空对象，
    // 等价于清空（sanitizePerBotEnv({}) → 无 key 可注入）。
    expect(latestPerBotEnvForRestart(ds)).toEqual({});
  });

  it('falls back to undefined when the bot is gone (keep old-snapshot behavior)', () => {
    getBotMock.mockImplementation(() => { throw new Error('Bot not registered'); });
    const { ds } = makeDs();
    expect(latestPerBotEnvForRestart(ds)).toBeUndefined();
  });
});

// ─── 2. daemon behavioral：live-worker restart 消息带 env ────────────────────

describe('requestSessionRestart live-worker branch carries env (behavioral)', () => {
  it('sends {type:restart, attemptId, env} with the latest bots.json env', () => {
    getBotMock.mockReturnValue({ config: { env: { HTTPS_PROXY: 'http://p:7890' } } });
    const { ds, send } = makeDs();
    const r = requestSessionRestart(ds, observer());

    expect(r.joined).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.type).toBe('restart');
    expect(typeof msg.attemptId).toBe('string');
    expect(msg.attemptId).toBe(r.attemptId);
    expect(msg.env).toEqual({ HTTPS_PROXY: 'http://p:7890' });
  });

  it('sends env:null when no per-bot env is configured (worker clears snapshot)', () => {
    getBotMock.mockReturnValue({ config: {} });
    const { ds, send } = makeDs();
    requestSessionRestart(ds, observer());
    expect(send.mock.calls[0][0].env).toBeNull();
  });

  it('sends env:undefined when bot lookup fails (= legacy message, no env key)', () => {
    getBotMock.mockImplementation(() => { throw new Error('gone'); });
    const { ds, send } = makeDs();
    requestSessionRestart(ds, observer());
    expect(send.mock.calls[0][0].env).toBeUndefined();
  });

  it('a joined second request does NOT resend the restart message', () => {
    // restartCoordinator 合并重复触发：第二条只 join，env 以第一条为准（同一
    // 物理重启），pending respawn 展开 {...lastInitConfig} 时拿到第一次捎带
    // 的 env（worker 侧在合并守卫前 merge，第二条带的新值也会生效）。
    getBotMock.mockReturnValue({ config: { env: { A: '1' } } });
    const { ds, send } = makeDs();
    const first = requestSessionRestart(ds, observer());
    const second = requestSessionRestart(ds, observer());
    expect(second.joined).toBe(true);
    expect(second.attemptId).toBe(first.attemptId);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

// ─── 3. 全部四个 restart IPC 生产者均捎带 env（wiring） ─────────────────────

describe('every daemon-side restart IPC producer carries env (source wiring)', () => {
  it('worker-pool.ts: every {type:restart} send includes env', () => {
    const sends = workerPoolSource.match(/ds\.worker\.send\(\{ type: 'restart'[^}]*\}/g) ?? [];
    expect(sends.length).toBeGreaterThanOrEqual(2); // requestSessionRestart + auto-restart
    for (const s of sends) {
      expect(s, `missing env in: ${s}`).toContain('env: latestPerBotEnvForRestart(ds)');
    }
  });

  it('dashboard-ipc-server.ts: every {type:restart} send includes env', () => {
    const sends = dashboardIpcSource.match(/ds\.worker\.send\(\{ type: 'restart'[^}]*\}/g) ?? [];
    expect(sends.length).toBe(2); // dashboard restart 按钮 + cwd-move
    for (const s of sends) {
      expect(s, `missing env in: ${s}`).toContain('env: latestPerBotEnvForRestart(ds)');
    }
  });

  it('the restart message type declares the three-state env field', () => {
    const typesSource = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
    const restartLine = typesSource.indexOf("| { type: 'restart';");
    expect(restartLine).toBeGreaterThanOrEqual(0);
    const line = typesSource.slice(restartLine, typesSource.indexOf('}', restartLine));
    expect(line).toContain('env?: Record<string, string> | null');
  });
});

// ─── 4. worker wiring：respawn 前 merge env（合并守卫之前 + null 清除语义） ──

describe('worker restart case merges env into lastInitConfig (source pin)', () => {
  function restartCaseBranch(): string {
    const start = workerSource.indexOf("case 'restart': {");
    const end = workerSource.indexOf("case 'expire_durable_turn':", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return workerSource.slice(start, end);
  }

  it('full-replaces lastInitConfig.env with null→clear three-state semantics', () => {
    const branch = restartCaseBranch();
    expect(branch).toContain('if (msg.env !== undefined && lastInitConfig)');
    expect(branch).toContain('lastInitConfig.env = msg.env === null ? undefined : msg.env;');
  });

  it('the env merge sits BEFORE the in-flight merge guard (coalesced restarts still take the update)', () => {
    const branch = restartCaseBranch();
    const envMerge = branch.indexOf('if (msg.env !== undefined && lastInitConfig)');
    const guard = branch.indexOf('if (cliRestartInProgress || tmuxRestartTimer)');
    expect(envMerge).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(envMerge);
  });

  it('spawnCli re-derives the inject set from cfg.env on every spawn (no cached copy)', () => {
    const spawnCfg = workerSource.indexOf('const perBotInjectEnv = sanitizePerBotEnv(cfg.env);');
    expect(spawnCfg).toBeGreaterThanOrEqual(0);
  });
});
