/**
 * Regression tests for "改完模型后重启活着的 worker 仍用旧模型".
 *
 *  背景 — model 不进会话冻结集合，每次 spawn 按当前 bot 配置解析
 *  （resolveSessionLaunchModel）。但 `/restart`、dashboard 重启按钮、
 *  dashboard cwd-move、CLI 崩溃 auto-restart 这四条路**不 refork**：daemon 只发
 *  `{type:'restart'}`，worker 用 fork 时刻的 lastInitConfig 快照原地 respawn。
 *  不捎带最新模型的话，改完模型再重启，起来的还是旧模型——正是「改配置对存量
 *  会话生效」要修的那件事。
 *
 *  修复 — 复用 per-bot env 那条通道与三分态：daemon 侧 latestModelForRestart
 *  （字符串=用它 / null=当前不该传模型 / undefined=取不到，保持快照=旧行为），
 *  worker 在合并守卫之前覆盖 lastInitConfig.model。
 *
 *  另外两条同族状态转换也在这里锁：
 *  - Codex App 线程接管把 cliId 钉成 codex-app 时必须清掉内存态的
 *    spawnModelOverride（它优先级最高且无条件，否则会泄漏进接管后的启动）；
 *  - session.model 是「上次实际启动用的模型」记录，只在 bot 换过 CLI、
 *    session 被钉在旧 CLI 上时兜底。
 *
 * Run:  pnpm vitest run test/restart-live-worker-model.test.ts
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
  latestModelForRestart,
  requestSessionRestart,
  __testOnly_resetRestartCoordinator,
} from '../src/core/worker-pool.js';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const workerPoolSource = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');
const dashboardIpcSource = readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8');
const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');

let sessionCounter = 0;

function makeDs(session: Record<string, unknown> = {}, dsExtra: Record<string, unknown> = {}) {
  const send = vi.fn();
  const ds: any = {
    session: {
      sessionId: `model-restart-${++sessionCounter}`,
      backendType: 'pty',
      cliId: 'codex',
      ...session,
    },
    larkAppId: 'cli_app1',
    hasHistory: true,
    worker: { killed: false, send },
    ...dsExtra,
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

// ─── 1. latestModelForRestart 三分态 + 优先级 ───────────────────────────────

describe('latestModelForRestart (daemon-side model carrier)', () => {
  it('returns the LIVE bot model for a session on the same CLI', () => {
    getBotMock.mockReturnValue({ config: { cliId: 'codex', model: 'gpt-5.6' } });
    const { ds } = makeDs();
    expect(latestModelForRestart(ds)).toBe('gpt-5.6');
    expect(getBotMock).toHaveBeenCalledWith('cli_app1');
  });

  it('returns null when the bot configures no model (worker clears its snapshot)', () => {
    // Without the null, a restart after clearing the model would silently keep
    // relaunching the CLI with the old flag from the fork-time snapshot.
    getBotMock.mockReturnValue({ config: { cliId: 'codex' } });
    const { ds } = makeDs({ model: 'gpt-5.5' });
    expect(latestModelForRestart(ds)).toBeNull();
  });

  it('keeps the recorded model when the bot has since switched CLI', () => {
    getBotMock.mockReturnValue({ config: { cliId: 'claude-code', model: 'opus' } });
    const { ds } = makeDs({ model: 'gpt-5.5' });
    expect(latestModelForRestart(ds)).toBe('gpt-5.5');
  });

  it('lets an explicit per-trigger override win', () => {
    getBotMock.mockReturnValue({ config: { cliId: 'codex', model: 'gpt-5.5' } });
    const { ds } = makeDs({}, { spawnModelOverride: 'gpt-5.6-terra' });
    expect(latestModelForRestart(ds)).toBe('gpt-5.6-terra');
  });

  it('falls back to undefined when the bot is gone (keep old-snapshot behavior)', () => {
    getBotMock.mockImplementation(() => { throw new Error('Bot not registered'); });
    const { ds } = makeDs();
    expect(latestModelForRestart(ds)).toBeUndefined();
  });
});

// ─── 2. daemon behavioral：live-worker restart 消息带 model ──────────────────

describe('requestSessionRestart live-worker branch carries model (behavioral)', () => {
  it('sends {type:restart, attemptId, model} with the model resolved right now', () => {
    getBotMock.mockReturnValue({ config: { cliId: 'codex', model: 'gpt-5.6' } });
    const { ds, send } = makeDs({ model: 'gpt-5.5' });   // 快照里的旧模型
    const r = requestSessionRestart(ds, observer());

    expect(r!.joined).toBe(false);
    const msg = send.mock.calls[0][0];
    expect(msg.type).toBe('restart');
    expect(msg.attemptId).toBe(r!.attemptId);
    expect(msg.model).toBe('gpt-5.6');
  });

  it('sends model:null when the bot has no model configured', () => {
    getBotMock.mockReturnValue({ config: { cliId: 'codex' } });
    const { ds, send } = makeDs();
    requestSessionRestart(ds, observer());
    expect(send.mock.calls[0][0].model).toBeNull();
  });

  it('sends model:undefined when bot lookup fails (= legacy message, no model key)', () => {
    getBotMock.mockImplementation(() => { throw new Error('gone'); });
    const { ds, send } = makeDs();
    requestSessionRestart(ds, observer());
    expect(send.mock.calls[0][0].model).toBeUndefined();
  });
});

// ─── 3. 全部四个 restart IPC 生产者均捎带 model（wiring） ───────────────────

describe('every daemon-side restart IPC producer carries model (source wiring)', () => {
  it('worker-pool.ts: every {type:restart} send includes model', () => {
    const sends = workerPoolSource.match(/ds\.worker\.send\(\{ type: 'restart'[^}]*\}/g) ?? [];
    expect(sends.length).toBeGreaterThanOrEqual(2); // requestSessionRestart + auto-restart
    for (const s of sends) {
      expect(s, `missing model in: ${s}`).toContain('model: latestModelForRestart(ds)');
    }
  });

  it('dashboard-ipc-server.ts: every {type:restart} send includes model', () => {
    const sends = dashboardIpcSource.match(/ds\.worker\.send\(\{ type: 'restart'[^}]*\}/g) ?? [];
    expect(sends.length).toBe(2); // dashboard 重启按钮 + cwd-move
    for (const s of sends) {
      expect(s, `missing model in: ${s}`).toContain('model: latestModelForRestart(ds)');
    }
  });

  it('the restart message type declares the three-state model field', () => {
    const typesSource = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
    const restartAt = typesSource.indexOf("| { type: 'restart';");
    expect(restartAt).toBeGreaterThanOrEqual(0);
    const line = typesSource.slice(restartAt, typesSource.indexOf('}', restartAt));
    expect(line).toContain('model?: string | null');
  });
});

// ─── 4. worker wiring：respawn 前 merge model（合并守卫之前 + null 清除） ────

describe('worker restart case merges model into lastInitConfig (source pin)', () => {
  function restartCaseBranch(): string {
    const start = workerSource.indexOf("case 'restart': {");
    const end = workerSource.indexOf("case 'expire_durable_turn':", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return workerSource.slice(start, end);
  }

  it('full-replaces lastInitConfig.model with null→clear three-state semantics', () => {
    const branch = restartCaseBranch();
    expect(branch).toContain('if (msg.model !== undefined && lastInitConfig)');
    expect(branch).toContain('lastInitConfig.model = msg.model === null ? undefined : msg.model;');
  });

  it('the model merge sits BEFORE the in-flight merge guard (coalesced restarts still take it)', () => {
    const branch = restartCaseBranch();
    const modelMerge = branch.indexOf('if (msg.model !== undefined && lastInitConfig)');
    const guard = branch.indexOf('if (cliRestartInProgress || tmuxRestartTimer)');
    expect(modelMerge).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(modelMerge);
  });
});

// ─── 5. Codex App 线程接管必须清掉内存态的 per-trigger 覆盖（source pin） ────

describe('Codex App thread takeover clears the in-memory model override', () => {
  it('the takeover block that pins cliId=codex-app also clears spawnModelOverride', () => {
    const pin = daemonSource.indexOf("ds.session.cliId = 'codex-app';");
    expect(pin).toBeGreaterThanOrEqual(0);
    // 接管块紧随其后的几行：清 wrapper / 清 model 记录 / 清一次性覆盖 / 置 frozen。
    const block = daemonSource.slice(pin, pin + 400);
    expect(block).toContain('delete ds.session.model;');
    expect(block).toContain('ds.spawnModelOverride = undefined;');
  });
});
