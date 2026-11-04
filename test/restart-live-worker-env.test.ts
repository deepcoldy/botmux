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
 *  （latestSessionEnvForRestart，三分态：对象=最新 / null=已清空 / undefined=
 *  取不到保持旧行为）；worker 在 respawn 前全量覆盖 lastInitConfig.env，
 *  spawnCli 的 botInjectedEnv(cfg.env, cfg.envPolicy) 每次 spawn 都重跑即生效。
 *
 *  覆盖：
 *  1. latestSessionEnvForRestart 纯函数三分态（最新 / 清空 / 取不到兜底）。
 *  2. daemon behavioral：requestSessionRestart live-worker 分支把 env 放进
 *     发给 worker 的 restart 消息体（含 attemptId）。
 *  3. requestSessionRestart 是唯一的 restart IPC 发送方（dashboard 重启按钮 /
 *     cwd-move / 崩溃 auto-restart 都经它走），单发送方约束见
 *     restart-live-worker-lark-tool-binding.test.ts 的 restart IPC choke point。
 *     worker 侧「合并守卫之前覆盖 lastInitConfig.env」在 worker.ts 闭包里，暂无单测 seam。
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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  latestSessionEnvForRestart,
  requestSessionRestart,
  __testOnly_resetRestartCoordinator,
} from '../src/core/worker-pool.js';

let sessionCounter = 0;

// The mojo case below persists a quarantine record; keep it out of the real data
// dir (config.session.dataDir is driven by SESSION_DATA_DIR).
let quarantineDir: string;
let previousDataDir: string | undefined;
beforeEach(() => {
  quarantineDir = mkdtempSync(join(tmpdir(), 'restart-env-quarantine-'));
  previousDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = quarantineDir;
});
afterEach(() => {
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  rmSync(quarantineDir, { recursive: true, force: true });
});

function makeDs(envWorker?: { killed?: boolean }, backendType = 'pty') {
  const send = vi.fn();
  const ds: any = {
    session: {
      sessionId: `env-restart-${++sessionCounter}`,
      // Load-bearing for the launcher-env ledger, which is mojo-only: a local
      // backend must never be recorded as a mojo quarantine (cross-backend
      // contamination). Default stays pty so existing cases assert that.
      backendType,
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

// ─── 1. latestSessionEnvForRestart 纯函数三分态 ──────────────────────────────

describe('latestSessionEnvForRestart (daemon-side env snapshot carrier)', () => {
  it('returns the LIVE bots.json env object when configured', () => {
    getBotMock.mockReturnValue({ config: { env: { ANTHROPIC_BASE_URL: 'https://glm' } } });
    const { ds } = makeDs();
    expect(latestSessionEnvForRestart(ds)?.env).toEqual({ ANTHROPIC_BASE_URL: 'https://glm' });
    expect(getBotMock).toHaveBeenCalledWith('cli_app1');
  });

  it('records unprovable keys onto the generation ledger as a side effect (mojo only)', () => {
    // Same choke point for all four restart senders, so recording here cannot be
    // bypassed by a new caller. Without this the device-isolation proof forgets
    // the env a live /restart actually handed to the running child: clean start →
    // add LD_PRELOAD + restart → clear config without restarting leaves BOTH the
    // spawn snapshot and the live config clean while the child stays hooked.
    getBotMock.mockReturnValue({ config: { env: { LD_PRELOAD: '/tmp/hook.so' } } });
    const { ds } = makeDs(undefined, 'mojo');
    latestSessionEnvForRestart(ds)?.env;
    expect(ds.mojoAppliedUnprovableEnvKeys).toEqual(['LD_PRELOAD']);

    // Clearing the config afterwards must NOT erase it: the restart carrying the
    // clean env can still fail or be coalesced, leaving the hooked child alive.
    getBotMock.mockReturnValue({ config: { env: {} } });
    expect(latestSessionEnvForRestart(ds)?.env).toBeNull();
    expect(ds.mojoAppliedUnprovableEnvKeys).toEqual(['LD_PRELOAD']);
  });

  it('does NOT record for a non-mojo backend', () => {
    // The ledger answers "could a hooked MOJO client still run"; recording a
    // tmux/codex session there is cross-backend contamination and would make it
    // permanently unprovable.
    getBotMock.mockReturnValue({ config: { env: { LD_PRELOAD: '/tmp/hook.so' } } });
    const { ds } = makeDs();   // pty
    latestSessionEnvForRestart(ds)?.env;
    expect(ds.mojoAppliedUnprovableEnvKeys).toBeUndefined();
  });

  it('leaves the ledger untouched for a harmless or credential-only env', () => {
    getBotMock.mockReturnValue({ config: { env: { X_JWT_TOKEN: 'a.b.c' } } });
    const { ds } = makeDs();
    latestSessionEnvForRestart(ds)?.env;
    expect(ds.mojoAppliedUnprovableEnvKeys).toBeUndefined();
  });

  it('returns null when the config has no env (worker must clear its snapshot)', () => {
    getBotMock.mockReturnValue({ config: {} });
    const { ds } = makeDs();
    expect(latestSessionEnvForRestart(ds)?.env).toBeNull();
  });

  it('returns null for an EMPTY env object too (dashboard cleared every key)', () => {
    getBotMock.mockReturnValue({ config: { env: {} } });
    const { ds } = makeDs();
    // 空 env 组合后没有任何要注入的键 → null，worker 清空快照。
    expect(latestSessionEnvForRestart(ds)?.env).toBeNull();
  });

  it('falls back to undefined when the bot is gone (keep old-snapshot behavior)', () => {
    getBotMock.mockImplementation(() => { throw new Error('Bot not registered'); });
    const { ds } = makeDs();
    expect(latestSessionEnvForRestart(ds)?.env).toBeUndefined();
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

  it('carries the session-env removals and the fingerprint the respawned CLI is stamped with', () => {
    getBotMock.mockReturnValue({ config: { env: { HTTPS_PROXY: 'http://p' }, envUnset: ['BYTECLOUD_AUTH_AS'] } });
    const { ds, send } = makeDs();
    requestSessionRestart(ds, observer());
    const msg = send.mock.calls[0][0];
    expect(msg.envUnset).toEqual(['BYTECLOUD_AUTH_AS']);
    expect(typeof msg.envFingerprint).toBe('string');
    // a later config change produces a different stamp for the next restart
    getBotMock.mockReturnValue({ config: { env: { HTTPS_PROXY: 'http://p' } } });
    __testOnly_resetRestartCoordinator();
    requestSessionRestart(ds, observer());
    const next = send.mock.calls[1][0];
    expect(next.envUnset).toBeNull();
    expect(next.envFingerprint).not.toBe(msg.envFingerprint);
  });

  it('locks identity-wrapper names only for sessions the worker really wraps', () => {
    // Lark tool binding is on by default, but not for an HTTP virtual chat or an
    // external Codex App Server — there the worker leaves ZDOTDIR alone.
    getBotMock.mockReturnValue({ config: { env: { ZDOTDIR: '/mine', OTHER: 'x' } } });
    const { ds } = makeDs();
    ds.chatId = 'oc_real_chat';
    expect(latestSessionEnvForRestart(ds)?.env).toEqual({ OTHER: 'x' });
    ds.chatId = 'http_async_probe';
    expect(latestSessionEnvForRestart(ds)?.env).toEqual({ ZDOTDIR: '/mine', OTHER: 'x' });
    ds.chatId = 'oc_real_chat';
    ds.session.existingAppServerEndpoint = 'ws://127.0.0.1:1';
    expect(latestSessionEnvForRestart(ds)?.env).toEqual({ ZDOTDIR: '/mine', OTHER: 'x' });
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
