import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { BoundedLogFile } from '../src/utils/bounded-log-file.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { existsSync, mkdtempSync, truncateSync, statSync, rmSync, writeFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEphemeralPool, buildGoalCommand, GOAL_COMMAND, spawnWorkerFactory, v3WorkerBackendType } from '../src/workflows/v3/ephemeral-pool.js';
import { config } from '../src/config.js';
import { GOAL_COMMAND_OBJECTIVE, GOAL_ENV, isBotmuxGoalObjective, V3_NATIVE_GOAL_COMMAND_CLIS, type RunNodeRequest } from '../src/workflows/v3/contract.js';
import { syntheticSessionUuid, type WorkerHandle, type WorkerProcessFactory, type WorkerSpawnOptions } from '../src/workflows/shared/worker-process.js';
import { readV3AttemptWorkerFence } from '../src/workflows/v3/worker-fence.js';
import { botToSnapshot, parseFrozenBotSnapshots } from '../src/workflows/v3/bot-resolve.js';
import { getBot, registerBot, __testOnly_resetBotRegistry, type BotConfig } from '../src/bot-registry.js';
import { invalidateGlobalConfigCache } from '../src/global-config.js';

// The default factory delegates to self-spawn's spawnWorker, which is the only
// path that gets the compiled-binary case right. Mock node:child_process so we
// can observe WHICH primitive it reaches (fork vs spawn) without launching a
// real process; the scripted-worker tests below inject their own factory and
// never touch these mocks.
const childProcessMock = vi.hoisted(() => {
  const makeFakeChild = () => {
    const child: any = new EventEmitter();
    child.pid = 4321;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.send = vi.fn();
    child.kill = vi.fn();
    return child;
  };
  return {
    fork: vi.fn(() => makeFakeChild()),
    spawn: vi.fn(() => makeFakeChild()),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, fork: childProcessMock.fork, spawn: childProcessMock.spawn };
});


let dir: string;
const originalDataDir = config.session.dataDir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wf-v3-pool-'));
  config.session.dataDir = join(dir, 'data');
  vi.stubEnv('SESSION_DATA_DIR', config.session.dataDir);
});

afterEach(() => {
  config.session.dataDir = originalDataDir;
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

// A v3 attempt runs on a SYNTHETIC session id with no persistent row, so
// sessionStore.closeSession() never runs for it: the pool must reclaim the
// attempt's skill manifest + runtime-skills snapshot once the worker process
// has really exited — on every outcome — and never earlier.
describe('v3 ephemeral pool reclaims the attempt\'s skill snapshot on worker exit', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = join(dir, 'data');
    vi.stubEnv('SESSION_DATA_DIR', dataDir);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  const plant = (req: RunNodeRequest) => {
    const sid = syntheticSessionUuid(`v3-${req.runId}-${req.attemptId}`);
    const snapshotFile = join(dataDir, 'runtime-skills', sid, 'snapshot', 'deploy', 'SKILL.md');
    const manifest = join(dataDir, 'skill-manifests', `${sid}.json`);
    mkdirSync(dirname(snapshotFile), { recursive: true });
    writeFileSync(snapshotFile, '# Deploy');
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, '{}');
    return {
      present: () => existsSync(snapshotFile) && existsSync(manifest),
      gone: () => !existsSync(join(dataDir, 'runtime-skills', sid)) && !existsSync(manifest),
    };
  };
  const pool = (worker: WorkerHandle) => createEphemeralPool({
    factory: { spawn: () => worker }, workerPath: '/tmp/worker.js', quiesceMs: 1,
    cancelGraceMs: 10_000, resolveLarkAppSecret: () => 'secret',
  });

  it('ok: kept while the outcome is claimed, removed once the worker exits', async () => {
    const req = request();
    const files = plant(req);
    const worker = new ScriptedWorker();
    const running = pool(worker).runNode(req);
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });
    worker.emitMessage({ type: 'final_output', content: 'done', lastUuid: 'u', turnId: 't' });
    await waitFor(() => worker.kills.includes('SIGTERM'));
    expect(files.present()).toBe(true); // claimed, but the worker has not exited yet
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({ status: 'ok' });
    expect(files.gone()).toBe(true);
  });

  it('fail: removed on worker exit', async () => {
    const req = request();
    const files = plant(req);
    const worker = new ScriptedWorker();
    const running = pool(worker).runNode(req);
    await worker.waitForInit();
    worker.emitMessage({ type: 'claude_exit', code: 1, signal: null });
    await waitFor(() => worker.kills.includes('SIGTERM'));
    expect(files.present()).toBe(true);
    worker.emitExit(1);
    await expect(running).resolves.toMatchObject({ status: 'fail' });
    expect(files.gone()).toBe(true);
  });

  it('cancelled: kept through the cancel request, removed once the worker exits', async () => {
    const req = request();
    const files = plant(req);
    const worker = new ScriptedWorker();
    const ac = new AbortController();
    const running = pool(worker).runNode({ ...req, cancelSignal: ac.signal });
    await worker.waitForInit();
    ac.abort('user-requested');
    await new Promise((resolve) => setImmediate(resolve));
    expect(worker.kills).toContain('SIGINT');
    expect(files.present()).toBe(true);
    worker.emitExit(130);
    await expect(running).resolves.toMatchObject({ status: 'cancelled' });
    expect(files.gone()).toBe(true);
  });

  it('bind failure: removed after the drained outer close', async () => {
    const req = request();
    const files = plant(req);
    const worker = new UnbindableWorker();
    const running = pool(worker).runNode(req);
    await waitFor(() => worker.closeRequested);
    expect(files.present()).toBe(true);
    worker.emit('close', 1);
    await expect(running).rejects.toThrow(/process identity/);
    expect(files.gone()).toBe(true);
  });

  it('only touches its own synthetic session (a sibling attempt\'s snapshot stays)', async () => {
    const req = request();
    const other = plant({ ...req, attemptId: 'research/attempts/002' });
    const files = plant(req);
    const worker = new ScriptedWorker();
    const running = pool(worker).runNode(req);
    await worker.waitForInit();
    worker.emitMessage({ type: 'claude_exit', code: 0, signal: null });
    await waitFor(() => worker.kills.includes('SIGTERM'));
    worker.emitExit(0);
    await running;
    expect(files.gone()).toBe(true);
    expect(other.present()).toBe(true);
  });
});

describe('v3WorkerBackendType', () => {
  it('follows a tmux daemon and keeps PTY for every other backend, never a remote one', () => {
    expect(v3WorkerBackendType('tmux')).toBe('tmux');
    for (const backend of ['pty', 'herdr', 'zellij', 'zmx', 'riff', 'mojo'] as const) {
      expect(v3WorkerBackendType(backend), backend).toBe('pty');
    }
  });
});

describe('v3 ephemeral pool', () => {
  it.each(['stdout', 'stderr'] as const)('fails on a full %s log even after a claimed success', async (stream) => {
    const worker = Object.assign(new ScriptedWorker(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const req = request();
    const path = join(req.attemptDir, stream + '.log');
    mkdirSync(req.attemptDir, { recursive: true });
    writeFileSync(path, '');
    truncateSync(path, 64_000_000);
    const running = createEphemeralPool({ factory: factoryFor(worker), resolveLarkAppSecret: () => 'secret' }).runNode(req);
    await worker.waitForInit();
    worker.emitMessage({ type: 'claude_exit', code: 0, signal: null });
    worker[stream].write('more');
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({ status: 'fail', error: { code: 'WORKFLOW_LOG_LIMIT' } });
    expect(statSync(path).size).toBe(64_000_000);
  });

  it('counts pending stdout and stderr writes together when they share a log file', async () => {
    const worker = Object.assign(new ScriptedWorker(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const req = request();
    const path = join(req.attemptDir, 'combined.log');
    mkdirSync(req.attemptDir, { recursive: true });
    writeFileSync(path, '');
    truncateSync(path, 64_000_000 - 2);
    const pool = createEphemeralPool({ factory: factoryFor(worker), resolveLarkAppSecret: () => 'secret' });
    const running = pool.runNode({ ...req, stdoutPath: path, stderrPath: path });
    await worker.waitForInit();
    worker.stdout.write('ab');
    const closeAfterStdout = worker.closeRequests;
    worker.stderr.write('cd');
    const closeAfterStderr = worker.closeRequests;
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({ status: 'fail', error: { code: 'WORKFLOW_LOG_LIMIT' } });
    expect(closeAfterStdout).toBe(0);
    expect(closeAfterStderr).toBe(1);
    expect(statSync(path).size).toBe(64_000_000);
  });

  it('rejects a custom diagnostic path that aliases the worker-owned replay before spawning', async () => {
    const req = request();
    mkdirSync(req.attemptDir, { recursive: true });
    const stdoutPath = join(req.attemptDir, 'custom.log');
    symlinkSync('pty.log', stdoutPath);
    const factory = factoryFor(new ScriptedWorker());
    const pool = createEphemeralPool({ factory, resolveLarkAppSecret: () => 'secret' });
    await expect(pool.runNode({ ...req, stdoutPath })).rejects.toThrow(/pty.log/);
    expect(factory.lastOpts).toBeUndefined();
    expect(readV3AttemptWorkerFence(req.attemptDir, req)?.phase).toBe('closed_no_spawn');
  });

  it('requests worker close on oversized final output and preserves a user cancellation during shutdown', async () => {
    const worker = new ScriptedWorker();
    const ac = new AbortController();
    const running = createEphemeralPool({ factory: factoryFor(worker), resolveLarkAppSecret: () => 'secret' })
      .runNode({ ...request(), cancelSignal: ac.signal });
    await worker.waitForInit();
    worker.emitMessage({ type: 'final_output', content: 'x'.repeat(16_000_000), lastUuid: 'u', turnId: 't' });
    const closeRequests = worker.closeRequests;
    ac.abort('operator');
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({ status: 'cancelled', cancelReason: 'operator' });
    expect(closeRequests).toBe(1);
  });

  it('propagates a terminal replay limit received during worker shutdown', async () => {
    const worker = new ScriptedWorker();
    const req = request();
    const running = createEphemeralPool({ factory: factoryFor(worker), resolveLarkAppSecret: () => 'secret' }).runNode(req);
    await worker.waitForInit();
    worker.emitMessage({ type: 'claude_exit', code: 0, signal: null });
    const path = join(req.attemptDir, 'pty.log');
    writeFileSync(path, '');
    truncateSync(path, 64_000_000);
    const stamp = loadWorkerFunction('sessionEventMetadata', { workerSessionEventScope: worker.contractScope });
    const append = loadWorkerFunction('appendWorkflowPtyLog', {
      isWorkflowWorker: () => true, process: { env: { BOTMUX_WORKFLOW_PTY_LOG_PATH: path } },
      workflowPtyLogStream: undefined, workflowPtyLogOpenFailed: false, BoundedLogFile, mkdirSync, dirname,
      send: (event: unknown) => worker.emit('message', stamp(event)),
    });
    // PTY callbacks carry their runtime binding even while the worker is closing.
    const scope = worker.contractScope!;
    scope.run(scope.currentBinding()!, () => append('more'));
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({ status: 'fail', error: { code: 'WORKFLOW_LOG_LIMIT', message: 'pty.log exceeded the disk limit' } });
    expect(statSync(path).size).toBe(64_000_000);
  });

  it('does not inherit machine protected env names even when the workflow bot enables no matching plugin', async () => {
    vi.stubEnv('FIXTURE_SECRET', 'machine-secret');
    vi.stubEnv('FIXTURE_TOKEN', 'machine-token');
    vi.stubEnv('INVALID_RECORD_SECRET', 'invalid-record-machine-secret');
    vi.stubEnv('BOTMUX_GLOBAL_CONFIG_FILE', join(dir, 'current-global.json'));
    vi.stubEnv('BOTMUX_PROTECTED_SECRET_FD', '3');
    try {
      writeFileSync(join(dir, 'current-global.json'), JSON.stringify({ protectedMcpCapabilities: {
        'fixture.secret.v1': {
          enabled: true,
          allowedPluginIds: ['fixture-plugin'],
          secret: { source: 'file', path: '.secrets/mcp-secret' },
          containmentProfile: 'local-stdio-secret-v1',
          isolation: {
            protectedHomePaths: ['.fixture-credential'],
            redactEnv: ['FIXTURE_SECRET', 'FIXTURE_TOKEN'],
          },
        },
        legacy: { secret: { source: 'env', name: 'INVALID_RECORD_SECRET' } },
      } }));
      invalidateGlobalConfigCache();
      const worker = new ScriptedWorker();
      const factory = factoryFor(worker);
      const pool = createEphemeralPool({
        factory,
        workerPath: '/tmp/worker.js',
        quiesceMs: 1,
        resolveLarkAppSecret: () => 'secret',
        resolveBot: () => ({
          env: {
            FIXTURE_SECRET: 'bot-reintroduced-secret',
            FIXTURE_TOKEN: 'bot-reintroduced-token',
            INVALID_RECORD_SECRET: 'bot-reintroduced-invalid-record-secret',
          },
        }),
      });
      const running = pool.runNode(request());
      await worker.waitForInit();
      try {
        expect(factory.lastOpts!.env.FIXTURE_SECRET).toBeUndefined();
        expect(factory.lastOpts!.env.FIXTURE_TOKEN).toBeUndefined();
        expect(factory.lastOpts!.env.INVALID_RECORD_SECRET).toBeUndefined();
        expect(factory.lastOpts!.env.BOTMUX_PROTECTED_SECRET_FD).toBeUndefined();
        expect(worker.init.env.FIXTURE_SECRET).toBeUndefined();
        expect(worker.init.env.FIXTURE_TOKEN).toBeUndefined();
        expect(worker.init.env.INVALID_RECORD_SECRET).toBeUndefined();
        expect(worker.init.protectedMcpPolicy).toEqual({
          capabilities: [],
          protectedHomePaths: ['.secrets/mcp-secret'],
          redactEnv: ['BOTMUX_PROTECTED_SECRET_FD', 'FIXTURE_SECRET', 'FIXTURE_TOKEN', 'INVALID_RECORD_SECRET'],
        });
      } finally {
        worker.emitExit(0);
        await running;
      }
    } finally {
      vi.unstubAllEnvs();
      invalidateGlobalConfigCache();
    }
  });

  it('freezes only strict names, filters worker inheritance and resolves this bot env without persisting credentials', async () => {
    vi.stubEnv('UNLISTED_CLOUD_CREDENTIAL', 'host-sentinel');
    vi.stubEnv('HTTPS_PROXY', 'proxy-sentinel');
    try {
      const bot: BotConfig = { larkAppId: 'cli_app', larkAppSecret: 'secret', cliId: 'codex',
        envPolicy: { mode: 'strict', inherit: ['HTTPS_PROXY'] }, env: { MODEL_AUTH: 'bot-sentinel' } };
      const frozen = botToSnapshot(bot, dir);
      const serialized = JSON.stringify({ '': frozen });
      expect(serialized.includes('bot-sentinel')).toBe(false);
      const restored = parseFrozenBotSnapshots(JSON.parse(serialized)).get('')!;
      bot.envPolicy = { mode: 'inherit' };
      const worker = new ScriptedWorker(); const factory = factoryFor(worker);
      const resolveBot = vi.fn(appId => appId === bot.larkAppId ? bot : undefined);
      const pool = createEphemeralPool({ factory, workerPath: '/tmp/worker.js', quiesceMs: 1,
        resolveLarkAppSecret: () => 'secret', resolveBot });
      const running = pool.runNode({ ...request(), botSnapshot: restored });
      await worker.waitForInit();
      expect(worker.init.envPolicy).toEqual({ mode: 'strict', inherit: ['HTTPS_PROXY'] });
      expect(worker.init.env.MODEL_AUTH === 'bot-sentinel').toBe(true);
      expect(factory.lastOpts!.env.UNLISTED_CLOUD_CREDENTIAL).toBeUndefined();
      expect(factory.lastOpts!.env.HTTPS_PROXY === 'proxy-sentinel').toBe(true);
      expect(resolveBot).toHaveBeenCalledWith('cli_app');
      worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
      worker.emitMessage({ type: 'prompt_ready' });
      worker.emitMessage({ type: 'final_output', content: 'done', lastUuid: 'u', turnId: 't' });
      await waitFor(() => worker.kills.includes('SIGTERM')); worker.emitExit(0);
      await expect(running).resolves.toMatchObject({ status: 'ok' });
    } finally { vi.unstubAllEnvs(); }
  });

  describe('live bot env resolution', () => {
    beforeEach(() => { __testOnly_resetBotRegistry(); });
    afterEach(() => { __testOnly_resetBotRegistry(); });

    const configureBots = (bots: BotConfig[]) => {
      const botsPath = join(dir, 'bots.json');
      writeFileSync(botsPath, JSON.stringify(bots));
      vi.stubEnv('BOTS_CONFIG', botsPath);
    };

    it('resolves an unregistered node bot from bots.json', async () => {
      const hostBot: BotConfig = { larkAppId: 'cli_host', larkAppSecret: 'test-only', cliId: 'claude-code',
        apiOnly: true, env: { MODEL_AUTH: 'host-sentinel' } };
      registerBot(hostBot);
      configureBots([hostBot, { larkAppId: 'cli_app', larkAppSecret: 'test-only', cliId: 'claude-code',
        env: { MODEL_AUTH: 'node-sentinel' }, envUnset: ['WORKFLOW_DROP_ME'] }]);
      expect(() => getBot('cli_app')).toThrow();
      const worker = new ScriptedWorker();
      const running = createEphemeralPool({ factory: factoryFor(worker), workerPath: '/tmp/worker.js',
        resolveLarkAppSecret: () => 'secret' }).runNode(request());
      try {
        await worker.waitForInit();
        expect(worker.init.env?.MODEL_AUTH).toBe('node-sentinel');
        expect(worker.init.envUnset).toContain('WORKFLOW_DROP_ME');
      } finally {
        worker.emitExit(0);
        await running;
      }
    });

    it('keeps the hosted bot config ahead of bots.json', async () => {
      const bot: BotConfig = { larkAppId: 'cli_app', larkAppSecret: 'test-only', cliId: 'claude-code',
        apiOnly: true, env: { MODEL_AUTH: 'registered-sentinel' } };
      registerBot(bot);
      configureBots([{ ...bot, env: { MODEL_AUTH: 'file-sentinel' } }]);
      const worker = new ScriptedWorker();
      const running = createEphemeralPool({ factory: factoryFor(worker), workerPath: '/tmp/worker.js',
        resolveLarkAppSecret: () => 'secret' }).runNode(request());
      try {
        await worker.waitForInit();
        expect(worker.init.env?.MODEL_AUTH).toBe('registered-sentinel');
      } finally {
        worker.emitExit(0);
        await running;
      }
    });

    it('refuses an unregistered assistant-mode node bot before spawning', async () => {
      configureBots([{ larkAppId: 'cli_app', larkAppSecret: 'test-only', cliId: 'claude-code', assistantMode: true }]);
      const spawn = vi.fn((): WorkerHandle => { throw new Error('unexpected spawn'); });
      await expect(createEphemeralPool({ factory: { spawn }, workerPath: '/tmp/worker.js',
        resolveLarkAppSecret: () => 'secret' }).runNode(request())).rejects.toThrow();
      expect(spawn).not.toHaveBeenCalled();
    });

    it.each(['missing', 'throwing'] as const)('does not override an explicit %s resolver with bots.json', async (behavior) => {
      configureBots([{ larkAppId: 'cli_app', larkAppSecret: 'test-only', cliId: 'claude-code',
        env: { MODEL_AUTH: 'file-sentinel' } }]);
      const worker = new ScriptedWorker();
      const resolveBot = vi.fn(() => {
        if (behavior === 'throwing') throw new Error('resolver unavailable');
        return undefined;
      });
      const running = createEphemeralPool({ factory: factoryFor(worker), workerPath: '/tmp/worker.js',
        resolveLarkAppSecret: () => 'secret', resolveBot }).runNode(request());
      try {
        await worker.waitForInit();
        expect(resolveBot).toHaveBeenCalledWith('cli_app');
        expect(worker.init.env?.MODEL_AUTH).toBeUndefined();
      } finally {
        worker.emitExit(0);
        await running;
      }
    });

    it('does not substitute another configured bot when the node bot is absent', async () => {
      configureBots([{ larkAppId: 'cli_other', larkAppSecret: 'test-only', cliId: 'claude-code',
        env: { MODEL_AUTH: 'other-sentinel' } }]);
      const worker = new ScriptedWorker();
      const running = createEphemeralPool({ factory: factoryFor(worker), workerPath: '/tmp/worker.js',
        resolveLarkAppSecret: () => 'secret' }).runNode(request());
      try {
        await worker.waitForInit();
        expect(worker.init.env?.MODEL_AUTH).toBeUndefined();
      } finally {
        worker.emitExit(0);
        await running;
      }
    });
  });

  it('persists the explicit default instance and replays it into the existing PTY worker after config changes', async () => {
    const home = join(dir, 'codex-a');
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'fake-token' } }), { mode: 0o600 });
    const bot: BotConfig = { larkAppId: 'cli_app', larkAppSecret: 'not-persisted', cliId: 'codex', backendType: 'tmux',
      codexInstancePool: { enabled: true, scope: 'ordinary-feishu', strategy: 'random', defaultInstanceId: 'a',
        instances: [{ id: 'a', codexHome: home, enabled: false }] } };
    const frozen = botToSnapshot(bot, '/work/repo');
    const path = join(dir, 'bots.snapshot.json');
    writeFileSync(path, JSON.stringify({ '': frozen }));
    bot.codexInstancePool!.instances[0]!.codexHome = '/changed-after-freeze';
    const restored = parseFrozenBotSnapshots(JSON.parse(readFileSync(path, 'utf8'))).get('')!;
    expect(restored.cliInstanceBinding).toMatchObject({ source: 'default', instanceId: 'a', codexHome: realpathSync(home) });
    expect(restored.cliRuntime).toEqual(frozen.cliRuntime);
    expect(readFileSync(path, 'utf8')).not.toContain('not-persisted');
    const worker = new ScriptedWorker();
    const factory = factoryFor(worker);
    const req = { ...request(), botSnapshot: restored };
    const pool = createEphemeralPool({ factory, workerPath: '/tmp/worker.js', quiesceMs: 1, resolveLarkAppSecret: () => 'secret' });
    const running = pool.runNode(req);
    await worker.waitForInit();
    expect(worker.init).toMatchObject({ backendType: v3WorkerBackendType(), cliId: 'codex', cliInstanceBinding: restored.cliInstanceBinding, cliRuntime: restored.cliRuntime });
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });
    worker.emitMessage({ type: 'final_output', content: 'done', lastUuid: 'u', turnId: 't' });
    await waitFor(() => worker.kills.includes('SIGTERM'));
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({ status: 'ok' });
  });

  it('honors the host-neutral attempt lease before resolving credentials or spawning', async () => {
    const worker = new ScriptedWorker();
    const factory = factoryFor(worker);
    const controller = new AbortController();
    controller.abort('lease-cancelled');
    const req = request();
    req.attemptLease = { attemptId: req.attemptId, signal: controller.signal };
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      resolveLarkAppSecret: () => {
        throw new Error('must not resolve credentials for an aborted lease');
      },
    });

    await expect(pool.runNode(req)).resolves.toMatchObject({
      status: 'cancelled',
      cancelReason: 'lease-cancelled',
    });
    expect(factory.lastOpts).toBeUndefined();
  });

  it('rejects an attempt lease whose durable id disagrees with the request', async () => {
    const req = request();
    req.attemptLease = {
      attemptId: 'different/attempts/001',
      signal: new AbortController().signal,
    };
    const pool = createEphemeralPool({
      factory: factoryFor(new ScriptedWorker()),
      workerPath: '/tmp/worker.js',
      resolveLarkAppSecret: () => 'secret',
    });

    await expect(pool.runNode(req)).rejects.toThrow(/attempt lease .* does not match request/);
  });

  it('spawns a goal-mode worker with frozen bot snapshot and resolves after final_output', async () => {
    const worker = new ScriptedWorker();
    const factory = factoryFor(worker);
    const req = request();
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      quiesceMs: 1,
      resolveLarkAppSecret: (appId) => appId === 'cli_app' ? 'secret' : undefined,
    });

    const promise = pool.runNode(req);
    await waitFor(() => factory.lastOpts !== undefined);
    expect(readV3AttemptWorkerFence(req.attemptDir, req)).toMatchObject({ phase: 'active' });
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok', viewToken: 'view-tok' });
    expect(worker.rawInputs).toEqual([]);
    worker.emitMessage({ type: 'prompt_ready' });
    expect(worker.rawInputs).toEqual([buildGoalCommand(req)]);
    worker.emitMessage({
      type: 'final_output',
      content: 'done',
      lastUuid: 'u',
      turnId: 't',
    });
    await waitFor(() => worker.kills.includes('SIGTERM'));
    worker.emitExit(0);

    const result = await promise;
    expect(readV3AttemptWorkerFence(req.attemptDir, req)).toMatchObject({ phase: 'closed' });

    expect(result).toMatchObject({
      status: 'ok',
      manifestPath: join(req.attemptDir, 'manifest.json'),
      sessionInfo: { webPort: 3001, token: 'tok', viewToken: 'view-tok' },
    });
    expect(factory.lastOpts?.cwd).toBe('/work/repo');
    expect(factory.lastOpts?.env[GOAL_ENV.V3_MARKER]).toBe('1');
    expect(factory.lastOpts?.env[GOAL_ENV.OUTPUT_DIR]).toBe(req.outputDir);
    expect(worker.init?.cliId).toBe('claude-code');
    expect(worker.init?.larkAppSecret).toBe('secret');
    expect(worker.init?.prompt).toBe('');
    // Worker init follows the daemon's resolved backend (tmux by default),
    // never the old hardcoded 'pty' which is unusable in the compiled binary.
    expect(worker.init?.backendType).toBe(v3WorkerBackendType(config.daemon.backendType));
    expect(worker.rawInputs).toEqual([buildGoalCommand(req)]);
  });

  it('passes the frozen wrapperCli to worker init', async () => {
    const worker = new ScriptedWorker();
    const factory = factoryFor(worker);
    const req = request();
    req.botSnapshot.cliId = 'codex';
    req.botSnapshot.wrapperCli = 'wrapper codex';
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      quiesceMs: 1,
      resolveLarkAppSecret: () => 'secret',
    });

    const promise = pool.runNode(req);
    await worker.waitForInit();
    expect(worker.init?.wrapperCli).toBe('wrapper codex');
    worker.emitExit(0);
    await promise;
  });

  it('passes a goal-scoped Codex runtime to worker init and attests the observed runtime', async () => {
    const worker = new ScriptedWorker();
    const factory = factoryFor(worker);
    const req = request();
    req.botSnapshot.cliId = 'codex';
    req.botSnapshot.model = 'gpt-6.1-sol';
    req.botSnapshot.reasoningEffort = 'xhigh';
    req.botSnapshot.cliInstanceBinding = {
      version: 1,
      source: 'goal',
      instanceId: null,
      cliId: 'codex',
      codexHome: '/private/codex-verifier',
      authMode: 'shared',
    };
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      quiesceMs: 1,
      resolveLarkAppSecret: () => 'secret',
    });

    const promise = pool.runNode(req);
    await worker.waitForInit();
    expect(worker.init).toMatchObject({
      cliId: 'codex',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'xhigh',
      cliInstanceBinding: { source: 'goal', codexHome: '/private/codex-verifier' },
    });
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });
    worker.emitMessage({ type: 'active_runtime', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' });
    worker.emitMessage({ type: 'final_output', content: 'done', lastUuid: 'u', turnId: 't' });
    await waitFor(() => worker.kills.includes('SIGTERM'));
    worker.emitExit(0);

    await expect(promise).resolves.toMatchObject({
      status: 'ok',
      runtime: {
        cliId: 'codex',
        source: 'worker-active-runtime',
        model: 'gpt-6.1-sol',
        reasoningEffort: 'xhigh',
        codexHome: '/private/codex-verifier',
      },
    });
  });

  it('fails a goal-scoped Codex run when the worker reports a different runtime', async () => {
    const worker = new ScriptedWorker();
    const req = request();
    req.botSnapshot.cliId = 'codex';
    req.botSnapshot.model = 'gpt-6.1-sol';
    req.botSnapshot.reasoningEffort = 'high';
    req.botSnapshot.cliInstanceBinding = {
      version: 1,
      source: 'goal',
      instanceId: null,
      cliId: 'codex',
      codexHome: '/private/codex-repairer',
      authMode: 'shared',
    };
    const pool = createEphemeralPool({
      factory: factoryFor(worker),
      workerPath: '/tmp/worker.js',
      quiesceMs: 1,
      resolveLarkAppSecret: () => 'secret',
    });

    const promise = pool.runNode(req);
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });
    worker.emitMessage({ type: 'active_runtime', model: 'gpt-5.6-sol', reasoningEffort: 'high' });
    worker.emitMessage({ type: 'final_output', content: 'done', lastUuid: 'u', turnId: 't' });
    await waitFor(() => worker.kills.includes('SIGTERM'));
    worker.emitExit(0);

    await expect(promise).resolves.toMatchObject({
      status: 'fail',
      error: { code: 'GOAL_RUNTIME_MISMATCH', message: expect.stringContaining('gpt-5.6-sol/high') },
      runtime: { model: 'gpt-5.6-sol', reasoningEffort: 'high' },
    });
  });

  function goalBoundRun(worker: ScriptedWorker) {
    const req = request();
    req.botSnapshot.cliId = 'codex';
    req.botSnapshot.model = 'gpt-6.1-sol';
    req.botSnapshot.reasoningEffort = 'xhigh';
    req.botSnapshot.cliInstanceBinding = {
      version: 1,
      source: 'goal',
      instanceId: null,
      cliId: 'codex',
      codexHome: '/private/codex-goal',
      authMode: 'shared',
    };
    const pool = createEphemeralPool({
      factory: factoryFor(worker),
      workerPath: '/tmp/worker.js',
      quiesceMs: 1,
      resolveLarkAppSecret: () => 'secret',
    });
    return pool.runNode(req);
  }

  it('fails an otherwise successful goal-scoped Codex run that never attested its runtime', async () => {
    const worker = new ScriptedWorker();
    const promise = goalBoundRun(worker);
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });
    worker.emitMessage({ type: 'final_output', content: 'done', lastUuid: 'u', turnId: 't' });
    await waitFor(() => worker.kills.includes('SIGTERM'));
    worker.emitExit(0);

    const result = await promise;
    expect(result).toMatchObject({ status: 'fail', error: { code: 'GOAL_RUNTIME_UNVERIFIED' } });
    expect(result.runtime).toBeUndefined();
  });

  it('fails a goal-scoped Codex run whose observed reasoning effort differs', async () => {
    const worker = new ScriptedWorker();
    const promise = goalBoundRun(worker);
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });
    worker.emitMessage({ type: 'active_runtime', model: 'gpt-6.1-sol', reasoningEffort: 'medium' });
    worker.emitMessage({ type: 'final_output', content: 'done', lastUuid: 'u', turnId: 't' });
    await waitFor(() => worker.kills.includes('SIGTERM'));
    worker.emitExit(0);

    await expect(promise).resolves.toMatchObject({
      status: 'fail',
      error: { code: 'GOAL_RUNTIME_MISMATCH', message: expect.stringContaining('gpt-6.1-sol/medium') },
    });
  });

  it('keeps a goal-scoped worker failure instead of reporting it as an unverified runtime', async () => {
    const worker = new ScriptedWorker();
    const promise = goalBoundRun(worker);
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'error', message: 'Codex instance routing does not support sandbox/readIsolation' });
    await waitFor(() => worker.kills.includes('SIGTERM'));
    worker.emitExit(1);

    const result = await promise;
    expect(result.status).toBe('fail');
    expect(result.error).toBeUndefined();
  });

  it('does not carry the PM2 graceful-exit sentinel into the ephemeral worker env', async () => {
    // The v3 ephemeral worker forks straight from the daemon (not via
    // workerForkEnv), so the daemon's PM2 graceful-exit sentinel would ride
    // process.env into it unless stripped. Harmless today (the worker doesn't
    // read the graceful helper) but the "only daemon/dashboard carry it"
    // invariant must hold — pin it so a refactor can't silently reintroduce it.
    const { PM2_GRACEFUL_EXIT_CODE_ENV } = await import('../src/pm2-graceful-exit.js');
    const prev = process.env[PM2_GRACEFUL_EXIT_CODE_ENV];
    process.env[PM2_GRACEFUL_EXIT_CODE_ENV] = '90';
    try {
      const worker = new ScriptedWorker();
      const factory = factoryFor(worker);
      const pool = createEphemeralPool({
        factory,
        workerPath: '/tmp/worker.js',
        quiesceMs: 1,
        resolveLarkAppSecret: () => 'secret',
      });
      const promise = pool.runNode(request());
      await waitFor(() => factory.lastOpts !== undefined);
      expect(factory.lastOpts?.env[PM2_GRACEFUL_EXIT_CODE_ENV]).toBeUndefined();
      // Teardown so the run promise resolves and doesn't leak a timer.
      await worker.waitForInit();
      worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
      worker.emitMessage({ type: 'prompt_ready' });
      worker.emitMessage({ type: 'final_output', content: 'done', lastUuid: 'u', turnId: 't' });
      await waitFor(() => worker.kills.includes('SIGTERM'));
      worker.emitExit(0);
      await promise;
    } finally {
      if (prev === undefined) delete process.env[PM2_GRACEFUL_EXIT_CODE_ENV];
      else process.env[PM2_GRACEFUL_EXIT_CODE_ENV] = prev;
    }
  });

  it('threads the run chat binding into worker init so CLI children get real BOTMUX_* identity env', async () => {
    const worker = new ScriptedWorker();
    const factory = factoryFor(worker);
    const req: RunNodeRequest = {
      ...request(),
      chatBinding: {
        larkAppId: 'cli_app',
        chatId: 'oc_real_chat',
        chatType: 'group',
        rootMessageId: 'om_real_root',
        ownerOpenId: 'ou_real_owner',
      },
    };
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      quiesceMs: 1,
      resolveLarkAppSecret: () => 'secret',
    });

    const promise = pool.runNode(req);
    await waitFor(() => factory.lastOpts !== undefined);
    await worker.waitForInit();

    expect(worker.init).toMatchObject({
      chatId: 'oc_real_chat',
      chatType: 'group',
      rootMessageId: 'om_real_root',
      ownerOpenId: 'ou_real_owner',
    });

    worker.emitExit(0);
    await promise;
  });

  it('keeps synthetic chat ids and no owner for standalone runs without a chat binding', async () => {
    const worker = new ScriptedWorker();
    const factory = factoryFor(worker);
    const req = request();
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      quiesceMs: 1,
      resolveLarkAppSecret: () => 'secret',
    });

    const promise = pool.runNode(req);
    await waitFor(() => factory.lastOpts !== undefined);
    await worker.waitForInit();

    expect(worker.init?.chatId).toBe(`v3-chat-${req.runId}`);
    expect(worker.init?.rootMessageId).toBe(`v3-root-${req.attemptId}`);
    expect('chatType' in worker.init).toBe(false);
    expect('ownerOpenId' in worker.init).toBe(false);

    worker.emitExit(0);
    await promise;
  });

  it('passes frozen sandbox policy to the goal-mode worker init', async () => {
    const worker = new ScriptedWorker();
    const factory = factoryFor(worker);
    const base = request();
    const req = {
      ...base,
      botSnapshot: {
        ...base.botSnapshot,
        sandbox: true,
        sandboxHidePaths: ['~/.ssh'],
        sandboxReadonlyPaths: ['/srv/readonly'],
        sandboxNetwork: false,
      },
    };
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      quiesceMs: 1,
      resolveLarkAppSecret: () => 'secret',
    });

    const promise = pool.runNode(req);
    await waitFor(() => factory.lastOpts !== undefined);
    await worker.waitForInit();

    expect(worker.init).toMatchObject({
      sandbox: true,
      sandboxHidePaths: ['~/.ssh'],
      sandboxReadonlyPaths: ['/srv/readonly'],
      sandboxNetwork: false,
    });

    worker.emitExit(0);
    await promise;
  });

  it('notifies session readiness as soon as the worker web terminal is ready', async () => {
    const worker = new ScriptedWorker();
    const factory = factoryFor(worker);
    const readyInfos: unknown[] = [];
    const req = {
      ...request(),
      onSessionReady: (info: unknown) => {
        readyInfos.push(info);
      },
    };
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      resolveLarkAppSecret: () => 'secret',
    });

    const promise = pool.runNode(req);
    await waitFor(() => factory.lastOpts !== undefined);
    await worker.waitForInit();
    expect(readyInfos).toEqual([]);

    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok', viewToken: 'view-tok' });
    expect(readyInfos).toEqual([{
      sessionId: expect.any(String),
      webPort: 3001,
      token: 'tok',
      viewToken: 'view-tok',
      ptyLogPath: join(req.attemptDir, 'pty.log'),
    }]);
    expect(factory.lastOpts?.env.BOTMUX_WORKFLOW_PTY_LOG_PATH).toBe(join(req.attemptDir, 'pty.log'));

    worker.emitExit(0);
    await promise;
  });

  it('returns fail without spawning when lark secret is unavailable', async () => {
    const worker = new ScriptedWorker();
    const factory = factoryFor(worker);
    const req = request();
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      resolveLarkAppSecret: () => undefined,
    });

    await expect(pool.runNode(req)).resolves.toEqual({
      status: 'fail',
      manifestPath: join(req.attemptDir, 'manifest.json'),
      failureDetail: 'no Lark app secret available for cli_app',
    });
    expect(readV3AttemptWorkerFence(req.attemptDir, req)).toMatchObject({
      phase: 'closed_no_spawn',
      reason: 'secret_missing',
    });
    expect(factory.lastOpts).toBeUndefined();
  });

  it('maps cancelSignal to SIGINT and resolves cancelled after worker exit', async () => {
    const worker = new ScriptedWorker();
    const factory = factoryFor(worker);
    const ac = new AbortController();
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      cancelGraceMs: 10_000,
      resolveLarkAppSecret: () => 'secret',
    });

    const promise = pool.runNode({ ...request(), cancelSignal: ac.signal });
    await waitFor(() => factory.lastOpts !== undefined);
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });

    ac.abort('user-requested');
    await new Promise((resolve) => setImmediate(resolve));
    expect(worker.kills).toContain('SIGINT');
    worker.emitExit(130);

    await expect(promise).resolves.toMatchObject({
      status: 'cancelled',
      cancelReason: 'user-requested',
    });
  });

  it('returns cancelled without resolving secrets or spawning when already aborted', async () => {
    const worker = new ScriptedWorker();
    const factory = factoryFor(worker);
    const ac = new AbortController();
    ac.abort({ kind: 'run', cancelRequestId: 'cancel-pre-aborted' });
    let secretResolutions = 0;
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      resolveLarkAppSecret: () => {
        secretResolutions++;
        return 'secret';
      },
    });

    await expect(pool.runNode({ ...request(), cancelSignal: ac.signal })).resolves.toMatchObject({
      status: 'cancelled',
      cancelReason: { kind: 'run', cancelRequestId: 'cancel-pre-aborted' },
    });
    expect(readV3AttemptWorkerFence(request().attemptDir, request())).toMatchObject({
      phase: 'closed_no_spawn',
      reason: 'pre_aborted',
    });
    expect(secretResolutions).toBe(0);
    expect(factory.lastOpts).toBeUndefined();
  });

  it('records spawn_threw without creating a child', async () => {
    const req = request();
    const pool = createEphemeralPool({
      factory: {
        spawn: () => { throw new Error('fork unavailable'); },
      },
      workerPath: '/tmp/worker.js',
      resolveLarkAppSecret: () => 'secret',
    });

    await expect(pool.runNode(req)).rejects.toThrow('fork unavailable');
    expect(readV3AttemptWorkerFence(req.attemptDir, req)).toMatchObject({
      phase: 'closed_no_spawn',
      reason: 'spawn_threw',
    });
  });

  it('drains spawn error/bind failure to outer close without an unhandled error event', async () => {
    const req = request();
    const worker = new UnbindableWorker();
    const pool = createEphemeralPool({
      factory: { spawn: () => worker },
      workerPath: '/tmp/worker.js',
      cancelGraceMs: 10_000,
      resolveLarkAppSecret: () => 'secret',
    });

    let settled = false;
    const promise = pool.runNode(req);
    promise.then(() => { settled = true; }, () => { settled = true; });
    await waitFor(() => worker.closeRequested);
    expect(settled).toBe(false);
    expect(() => worker.emit('error', new Error('spawn EAGAIN'))).not.toThrow();
    expect(settled).toBe(false);
    worker.emit('close', 1);
    await expect(promise).rejects.toThrow(/process identity/);
    expect(readV3AttemptWorkerFence(req.attemptDir, req)).toBeNull();
  });

  it('does not treat claude_exit as the cancellation fence before the outer worker exits', async () => {
    const worker = new ScriptedWorker();
    const factory = factoryFor(worker);
    const ac = new AbortController();
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      cancelGraceMs: 10_000,
      resolveLarkAppSecret: () => 'secret',
    });

    const promise = pool.runNode({ ...request(), cancelSignal: ac.signal });
    await waitFor(() => factory.lastOpts !== undefined);
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });

    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    ac.abort('cancel-fence');
    await new Promise((resolve) => setImmediate(resolve));
    worker.emitMessage({ type: 'claude_exit', code: 130, signal: 'SIGINT' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    worker.emitExit(130);
    await expect(promise).resolves.toMatchObject({
      status: 'cancelled',
      cancelReason: 'cancel-fence',
    });
  });

  it('uses raw slash-command passthrough for native /goal', async () => {
    const worker = new ScriptedWorker();
    const factory = factoryFor(worker);
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      resolveLarkAppSecret: () => 'secret',
    });

    const promise = pool.runNode(request());
    await waitFor(() => factory.lastOpts !== undefined);
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });

    expect(worker.rawInputs).toEqual([]);
    worker.emitMessage({ type: 'prompt_ready' });
    expect(worker.rawInputs).toEqual([buildGoalCommand(request())]);
    expect(worker.rawInputs[0]).toContain('/goal');
    expect(worker.rawInputs[0]).toContain(`$${GOAL_ENV.GOAL_PATH}`);
    expect(worker.rawInputs[0]).toContain(`$${GOAL_ENV.MANIFEST_PATH}`);
    expect(worker.rawInputs[0]).not.toContain(GOAL_ENV.INPUTS_PATH);
    expect(worker.rawInputs[0]).toContain(`$${GOAL_ENV.OUTPUT_DIR}`);
    worker.emitExit(0);
    await promise;
  });

  it.each(['traex', 'relay'] as const)('forwards %s through the same goal env + raw /goal path', async (cliId) => {
    const worker = new ScriptedWorker();
    const factory = factoryFor(worker);
    const base = request();
    const req: RunNodeRequest = {
      ...base,
      botSnapshot: { ...base.botSnapshot, cliId },
    };
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      resolveLarkAppSecret: () => 'secret',
    });

    const promise = pool.runNode(req);
    await waitFor(() => factory.lastOpts !== undefined);
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });

    expect(worker.init?.cliId).toBe(cliId);
    expect(worker.init?.disableCliBypass).toBe(false);
    expect(factory.lastOpts?.env[GOAL_ENV.V3_MARKER]).toBe('1');
    expect(factory.lastOpts?.env[GOAL_ENV.MANIFEST_PATH]).toBe(req.env[GOAL_ENV.MANIFEST_PATH]);
    expect(worker.rawInputs).toEqual([buildGoalCommand(req)]);
    expect(worker.rawInputs[0]).toMatch(/^\/goal /);

    worker.emitExit(0);
    await promise;
  });

  it('eagerly sends init so real workers can emit ready from their init handler', async () => {
    const worker = new ScriptedWorker({ autoReadyAfterInit: true });
    const factory = factoryFor(worker);
    const req = request();
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      resolveLarkAppSecret: () => 'secret',
    });

    const promise = pool.runNode(req);
    await waitFor(() => factory.lastOpts !== undefined);
    await worker.waitForInit();
    await waitFor(() => worker.readyEmitted);
    expect(worker.rawInputs).toEqual([]);

    worker.emitMessage({ type: 'prompt_ready' });
    expect(worker.rawInputs).toEqual([buildGoalCommand(req)]);

    worker.emitExit(0);
    await promise;
  });

  it('waits for the first prompt_ready before sending /goal and does not resend on later idle events', async () => {
    const worker = new ScriptedWorker();
    const factory = factoryFor(worker);
    const req = request();
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      resolveLarkAppSecret: () => 'secret',
    });

    const promise = pool.runNode(req);
    await waitFor(() => factory.lastOpts !== undefined);
    worker.emitMessage({ type: 'prompt_ready' });
    expect(worker.rawInputs).toEqual([]);

    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    await worker.waitForInit();
    expect(worker.rawInputs).toEqual([]);

    worker.emitMessage({ type: 'prompt_ready' });
    worker.emitMessage({ type: 'prompt_ready' });
    expect(worker.rawInputs).toEqual([buildGoalCommand(req)]);

    worker.emitExit(0);
    await promise;
  });

  it('buildGoalCommand uses a short native /goal line that points to file-backed instructions', () => {
    const cmd = buildGoalCommand(request());
    expect(cmd.startsWith(`${GOAL_COMMAND} `)).toBe(true);
    expect(cmd).toContain(`$${GOAL_ENV.GOAL_PATH}`);
    expect(cmd).toContain(`$${GOAL_ENV.OUTPUT_DIR}`);
    expect(cmd).toContain(`$${GOAL_ENV.MANIFEST_PATH}`);
    expect(cmd).toContain('manifest paths are relative to output dir');
    expect(cmd).not.toContain(request().env[GOAL_ENV.GOAL_PATH]);
    expect(cmd).not.toContain('schemaVersion');
    expect(cmd).not.toContain('status:"ok"');
    expect(cmd).not.toContain('status:"fail"');
    expect(cmd).not.toContain('\n');
    expect(Buffer.byteLength(cmd, 'utf-8')).toBeLessThanOrEqual(180);
  });

  it('recognises its own /goal line, with or without the command, for session discovery', () => {
    const cmd = buildGoalCommand(request());
    expect(cmd).toBe(`${GOAL_COMMAND} ${GOAL_COMMAND_OBJECTIVE}`);
    expect(isBotmuxGoalObjective(cmd)).toBe(true);
    // TraeX 0.210 goal mode stores only the objective (threads.preview).
    expect(isBotmuxGoalObjective(GOAL_COMMAND_OBJECTIVE)).toBe(true);
    expect(isBotmuxGoalObjective(`  ${GOAL_COMMAND_OBJECTIVE.replace(/ /g, '\n')}  `)).toBe(true);
    expect(isBotmuxGoalObjective(`${GOAL_COMMAND} ship the release notes`)).toBe(false);
    expect(isBotmuxGoalObjective(`Please explain: ${GOAL_COMMAND_OBJECTIVE}`)).toBe(false);
  });

  describe('goal 输入按 CLI 形态区分 /goal 前缀', () => {
    // request() hardcodes one attempt dir; a second runNode in the same test
    // must not re-arm the worker fence there, so give each variant its own.
    const withCli = (
      cliId: RunNodeRequest['botSnapshot']['cliId'],
      suffix = '',
    ): RunNodeRequest => {
      const req = request();
      const oldAttemptDir = req.attemptDir;
      const attemptDir = join(dir, `research${suffix}`, 'attempts', '001');
      const retarget = (path: string): string => path.replace(oldAttemptDir, attemptDir);
      return {
        ...req,
        runId: `run-v3${suffix}`,
        attemptId: `research${suffix}/attempts/001`,
        botSnapshot: { ...req.botSnapshot, cliId },
        attemptDir,
        inputsPath: retarget(req.inputsPath),
        outputDir: retarget(req.outputDir),
        env: Object.fromEntries(
          Object.entries(req.env).map(([key, value]) => [
            key,
            key === GOAL_ENV.V3_MARKER ? value : retarget(value),
          ]),
        ),
      };
    };

    it.each(V3_NATIVE_GOAL_COMMAND_CLIS)('%s 保留原生 /goal 前缀', (cliId) => {
      expect(buildGoalCommand(withCli(cliId))).toBe(`${GOAL_COMMAND} ${GOAL_COMMAND_OBJECTIVE}`);
    });

    it('minimax（ACP runner）收到裸 objective，不含 /goal，且仍是单行', () => {
      const cmd = buildGoalCommand(withCli('minimax'));
      expect(cmd).toBe(GOAL_COMMAND_OBJECTIVE);
      expect(cmd.startsWith(GOAL_COMMAND)).toBe(false);
      expect(cmd).not.toContain('\n');
      expect(isBotmuxGoalObjective(cmd)).toBe(true);
    });

    it('minimax 节点实际投递的 raw_input 就是裸 objective', async () => {
      const worker = new ScriptedWorker();
      const factory = factoryFor(worker);
      const pool = createEphemeralPool({
        factory,
        workerPath: '/tmp/worker.js',
        resolveLarkAppSecret: () => 'secret',
      });
      const promise = pool.runNode(withCli('minimax', '-mmx-input'));
      await worker.waitForInit();
      worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
      worker.emitMessage({ type: 'prompt_ready' });
      expect(worker.rawInputs).toEqual([GOAL_COMMAND_OBJECTIVE]);
      worker.emitExit(0);
      await promise;
    });

    it('minimax init 把内层 turn 超时设到节点硬截止之后，其它 CLI 不带该字段', async () => {
      const minimax = new ScriptedWorker();
      const poolMinimax = createEphemeralPool({
        factory: factoryFor(minimax),
        workerPath: '/tmp/worker.js',
        resolveLarkAppSecret: () => 'secret',
      });
      const mmxRun = poolMinimax.runNode(withCli('minimax', '-mmx-timeout'));
      await minimax.waitForInit();
      expect(typeof minimax.init.turnTimeoutMs).toBe('number');
      expect(minimax.init.turnTimeoutMs).toBeGreaterThan(60_000);
      minimax.emitExit(0);
      await mmxRun;

      const claude = new ScriptedWorker();
      const poolClaude = createEphemeralPool({
        factory: factoryFor(claude),
        workerPath: '/tmp/worker.js',
        resolveLarkAppSecret: () => 'secret',
      });
      const claudeRun = poolClaude.runNode(withCli('claude-code', '-claude-timeout'));
      await claude.waitForInit();
      expect(claude.init.turnTimeoutMs).toBeUndefined();
      claude.emitExit(0);
      await claudeRun;
    });
  });

  it('claims success when the manifest appears but waits for the outer worker exit fence', async () => {
    const worker = new ScriptedWorker({ autoReadyAfterInit: true });
    const factory = factoryFor(worker);
    const req = request();
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      manifestPollMs: 5,
      manifestSettleMs: 15,
      resolveLarkAppSecret: () => 'secret',
    });

    const promise = pool.runNode(req);
    await waitFor(() => factory.lastOpts !== undefined);
    await worker.waitForInit();
    await waitFor(() => worker.readyEmitted);
    worker.emitMessage({ type: 'prompt_ready' });

    writeFileSync(req.env[GOAL_ENV.MANIFEST_PATH]!, '{"schemaVersion":1}');
    await sleep(10);
    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await sleep(30);
    expect(settled).toBe(false);
    await waitFor(() => worker.kills.includes('SIGTERM'));
    worker.emitExit(0);
    await expect(promise).resolves.toMatchObject({
      status: 'ok',
      manifestPath: req.env[GOAL_ENV.MANIFEST_PATH],
    });
  });

  it('waits for a stable manifest before resolving', async () => {
    const worker = new ScriptedWorker({ autoReadyAfterInit: true });
    const factory = factoryFor(worker);
    const req = request();
    const pool = createEphemeralPool({
      factory,
      workerPath: '/tmp/worker.js',
      manifestPollMs: 5,
      manifestSettleMs: 25,
      resolveLarkAppSecret: () => 'secret',
    });

    const promise = pool.runNode(req);
    await waitFor(() => factory.lastOpts !== undefined);
    await worker.waitForInit();
    await waitFor(() => worker.readyEmitted);
    worker.emitMessage({ type: 'prompt_ready' });

    const manifestPath = req.env[GOAL_ENV.MANIFEST_PATH]!;
    writeFileSync(manifestPath, '{"schemaVersion":1');
    await sleep(10);
    writeFileSync(manifestPath, '{"schemaVersion":1}');
    await sleep(15);

    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await sleep(30);
    expect(settled).toBe(false);
    await waitFor(() => worker.kills.includes('SIGTERM'));
    worker.emitExit(0);
    await expect(promise).resolves.toMatchObject({ status: 'ok' });
  });
});

describe('v3 default worker factory (spawnWorkerFactory) across runtime shapes', () => {
  // isStandaloneBinary() detects a compiled Bun binary by process.argv[1]
  // starting with /$bunfs/. Swap it around each case so we exercise both the
  // Node fork path and the standalone __worker path against the same factory.
  const realArgv1 = process.argv[1];

  beforeEach(() => {
    childProcessMock.fork.mockClear();
    childProcessMock.spawn.mockClear();
  });

  afterEach(() => {
    process.argv[1] = realArgv1;
  });

  it('Node runtime: forks <distDir>/worker.js and never re-execs the binary', () => {
    process.argv[1] = '/Users/dev/botmux/dist/cli.js';
    const distDir = join('/opt', 'botmux', 'dist');

    const handle = spawnWorkerFactory.spawn({
      workerPath: distDir,
      cwd: '/work/repo',
      env: { FOO: 'bar' } as NodeJS.ProcessEnv,
    });

    expect(childProcessMock.fork).toHaveBeenCalledTimes(1);
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
    const [modulePath, args, opts] = childProcessMock.fork.mock.calls[0]!;
    expect(modulePath).toBe(join(distDir, 'worker.js'));
    expect(args).toEqual([]);
    expect(opts).toMatchObject({ cwd: '/work/repo' });
    // The IPC channel the pool talks over must be present.
    expect((opts as { stdio?: unknown[] }).stdio).toContain('ipc');
    // The handle proxies the child so the pool's send/kill/pid all work.
    expect(handle.pid).toBe(4321);
  });

  it('standalone binary: re-execs process.execPath with the hidden __worker subcommand (no /src/worker.ts fork)', () => {
    // A compiled binary reports its entry under the embedded /$bunfs/ root.
    process.argv[1] = '/$bunfs/root/cli.js';

    const handle = spawnWorkerFactory.spawn({
      // In the binary there is no worker.js on disk; workerPath is ignored.
      workerPath: '/$bunfs/root/../..',
      cwd: '/work/repo',
      env: { FOO: 'bar' } as NodeJS.ProcessEnv,
    });

    expect(childProcessMock.spawn).toHaveBeenCalledTimes(1);
    expect(childProcessMock.fork).not.toHaveBeenCalled();
    const [command, args, opts] = childProcessMock.spawn.mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(args).toEqual(['__worker']);
    // This is the whole point: it must NOT try to fork a src/worker.ts path,
    // which the worker-fence allowlist rejects (exit 2).
    expect((args as string[]).join(' ')).not.toContain('worker.ts');
    expect((args as string[]).join(' ')).not.toContain('worker.js');
    expect(opts).toMatchObject({ cwd: '/work/repo' });
    expect((opts as { stdio?: unknown[] }).stdio).toContain('ipc');
    expect(handle.pid).toBe(4321);
  });

  it('createEphemeralPool defaults to spawnWorkerFactory (fork under Node) when no factory is injected', async () => {
    process.argv[1] = '/Users/dev/botmux/dist/cli.js';
    const pool = createEphemeralPool({ resolveLarkAppSecret: () => 'secret' });

    const req = request();
    // Fire the run; the default factory will fork our fake child. We only need
    // to prove fork() was reached (not the bogus src/worker.ts path), then let
    // the fake child close so the promise settles.
    const promise = pool.runNode(req);
    await waitFor(() => childProcessMock.fork.mock.calls.length > 0);
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
    const forkedModule = childProcessMock.fork.mock.calls[0]![0] as string;
    // Under vitest the module runs from the source tree, so import.meta.url
    // resolves distDir to <checkout>/src; in a real dist build it is dist/. The
    // invariant that matters either way: it forks worker.js (not the bogus
    // src/worker.ts the old fallback produced, which the fence rejected).
    expect(forkedModule.endsWith('worker.js')).toBe(true);
    expect(forkedModule).not.toContain('worker.ts');

    // Settle: emit close on the fake child so no timer leaks.
    const child = childProcessMock.fork.mock.results[0]!.value as EventEmitter;
    child.emit('close', 0);
    await promise.catch(() => { /* fence teardown on a fake pid may reject; irrelevant here */ });
  });
});

describe('workflow node startup: folder trust and startup blockers', () => {
  afterEach(() => { __testOnly_resetBotRegistry(); });

  it.each(['configured', 'override', 'sandbox', 'different profile'] as const)(
    'prepares the frozen Claude profile only for its configured project: %s', async (scenario) => {
      const req = request();
      const cwd = join(dir, 'repo');
      const alias = join(dir, 'repo-link');
      const profile = join(dir, 'claude-profile');
      mkdirSync(cwd);
      mkdirSync(profile);
      symlinkSync(cwd, alias);
      req.botSnapshot.workingDir = alias;
      req.botSnapshot.cliConfigDir = profile;
      if (scenario === 'sandbox') req.botSnapshot.sandbox = true;
      registerBot({
        larkAppId: req.botSnapshot.larkAppId, larkAppSecret: 'test-only', cliId: 'claude-code', apiOnly: true,
        defaultWorkingDir: scenario === 'override' ? dir : cwd,
        cliConfigDir: scenario === 'different profile' ? dir : profile,
      });
      const stateFile = join(profile, '.claude.json');
      writeFileSync(stateFile, JSON.stringify({ account: 'preserved', projects: { other: { keep: true } } }));
      const worker = new ScriptedWorker();
      let stateAtSpawn: any;
      const running = createEphemeralPool({
        factory: { spawn: () => { stateAtSpawn = JSON.parse(readFileSync(stateFile, 'utf8')); return worker; } },
        workerPath: '/tmp/worker.js',
        resolveLarkAppSecret: () => 'secret',
      }).runNode(req);
      await worker.waitForInit();
      worker.emitExit(1);
      await running;
      // Claude keys trust by realpath(cwd); other keys in its hot state file survive.
      expect(stateAtSpawn).toEqual({ account: 'preserved', projects: {
        other: { keep: true }, ...(scenario === 'configured' ? { [realpathSync(cwd)]: { hasTrustDialogAccepted: true } } : {}),
      } });
    },
  );

  it.each(['folder_trust', 'login', 'api_key', 'update', 'terms', 'permission_mode'] as const)(
    'fails a node blocked on %s at once as retryable, waiting for the real worker close', async (kind) => {
      const req = { ...request(), timeoutMs: 1_800_000 };
      const worker = new ScriptedWorker();
      const running = createEphemeralPool({
        factory: factoryFor(worker), workerPath: '/tmp/worker.js', resolveLarkAppSecret: () => 'secret',
      }).runNode(req);
      await worker.waitForInit();
      worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
      let settled = false;
      void running.then(() => { settled = true; });
      worker.emitMessage({ type: 'user_notify', kind: 'cli_startup_blocked', message: 'startup requires intervention',
        startupBlocker: { kind, rule: `known-${kind}` } });
      // A readiness edge after the claimed failure must never submit the goal.
      worker.emitMessage({ type: 'prompt_ready' });
      await new Promise<void>(resolve => setImmediate(resolve));
      const closeRequests = worker.closeRequests;
      const settledBeforeClose = settled;
      worker.emit('exit', 0);
      await new Promise<void>(resolve => setImmediate(resolve));
      const settledOnExit = settled;
      worker.emit('close', 0);
      const result = await running;
      expect(closeRequests).toBe(1);
      expect(worker.rawInputs).toEqual([]);
      expect(settledBeforeClose).toBe(false);
      expect(settledOnExit).toBe(false);
      expect(result).toMatchObject({ status: 'fail',
        error: { code: `CLI_STARTUP_${kind.toUpperCase()}`, retryable: true, message: expect.stringContaining(kind) } });
    },
  );

  it('names the folder and the bot\'s CLI profile the person has to fix', async () => {
    const req = request();
    req.botSnapshot.cliConfigDir = join(dir, 'claude-profile');
    const worker = new ScriptedWorker();
    const running = createEphemeralPool({
      factory: factoryFor(worker), workerPath: '/tmp/worker.js', resolveLarkAppSecret: () => 'secret',
    }).runNode(req);
    await worker.waitForInit();
    worker.emitMessage({ type: 'user_notify', kind: 'cli_startup_blocked', message: 'trust?',
      startupBlocker: { kind: 'folder_trust', rule: 'claude-folder-trust', folder: '/work/repo' } });
    await waitFor(() => worker.closeRequests === 1);
    worker.emitExit(0);
    const result = await running;
    expect(result.error?.message).toContain('/work/repo');
    expect(result.error?.message).toContain(join(dir, 'claude-profile'));
  });

  it('keeps ordinary notices informational', async () => {
    const req = request();
    req.botSnapshot.cliId = 'codex';
    const worker = new ScriptedWorker();
    const running = createEphemeralPool({
      factory: factoryFor(worker), workerPath: '/tmp/worker.js', resolveLarkAppSecret: () => 'secret',
    }).runNode(req);
    await worker.waitForInit();
    worker.emitMessage({ type: 'user_notify', message: 'ordinary status', kind: 'input_not_submitted' });
    worker.emitMessage({ type: 'user_notify', message: 'no kind at all' });
    expect(worker.closeRequests).toBe(0);
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });
    expect(worker.rawInputs).toHaveLength(1);
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({ status: 'ok' });
  });

  it('lets cancellation win over a claimed startup failure', async () => {
    const worker = new ScriptedWorker();
    const ac = new AbortController();
    const running = createEphemeralPool({
      factory: factoryFor(worker), workerPath: '/tmp/worker.js', resolveLarkAppSecret: () => 'secret',
    }).runNode({ ...request(), cancelSignal: ac.signal });
    await worker.waitForInit();
    worker.emitMessage({ type: 'user_notify', kind: 'cli_startup_blocked', message: 'login required',
      startupBlocker: { kind: 'login', rule: 'known-login' } });
    ac.abort('manual-cancel');
    worker.emitMessage({ type: 'prompt_ready' });
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({ status: 'cancelled', cancelReason: 'manual-cancel' });
    expect(worker.rawInputs).toEqual([]);
  });

  it('does not reclassify a running goal from a late startup notice', async () => {
    const worker = new ScriptedWorker();
    const running = createEphemeralPool({
      factory: factoryFor(worker), workerPath: '/tmp/worker.js', resolveLarkAppSecret: () => 'secret',
    }).runNode(request());
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });
    worker.emitMessage({ type: 'user_notify', kind: 'cli_startup_blocked', message: 'stale startup notice',
      startupBlocker: { kind: 'login', rule: 'known-login' } });
    const closeRequests = worker.closeRequests;
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({ status: 'ok' });
    expect(closeRequests).toBe(0);
    expect(worker.rawInputs).toHaveLength(1);
  });

  it('keeps a goal-scoped Codex runtime mismatch authoritative over a startup failure', async () => {
    const worker = new ScriptedWorker();
    const req = request();
    req.botSnapshot.cliId = 'codex';
    req.botSnapshot.model = 'gpt-6.1-sol';
    req.botSnapshot.reasoningEffort = 'high';
    req.botSnapshot.cliInstanceBinding = {
      version: 1, source: 'goal', instanceId: null, cliId: 'codex', codexHome: '/private/codex-repairer', authMode: 'shared',
    };
    const running = createEphemeralPool({
      factory: factoryFor(worker), workerPath: '/tmp/worker.js', quiesceMs: 1, resolveLarkAppSecret: () => 'secret',
    }).runNode(req);
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'active_runtime', model: 'gpt-5.6-sol', reasoningEffort: 'high' });
    worker.emitMessage({ type: 'user_notify', kind: 'cli_startup_blocked', message: 'login required',
      startupBlocker: { kind: 'login', rule: 'codex-sign-in' } });
    await waitFor(() => worker.kills.includes('SIGTERM'));
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({ status: 'fail', error: { code: 'GOAL_RUNTIME_MISMATCH' } });
  });
});

describe('workflow node failure detail', () => {
  const pool = (worker: ScriptedWorker) => createEphemeralPool({
    factory: factoryFor(worker), workerPath: '/tmp/worker.js', quiesceMs: 1, resolveLarkAppSecret: () => 'secret',
  });

  it('fails at once on a worker error and keeps its message as the root cause', async () => {
    const worker = new ScriptedWorker();
    const running = pool(worker).runNode({ ...request(), timeoutMs: 1_800_000 });
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });
    worker.emitMessage({ type: 'error', message: 'Goal cleared after an unrecoverable error (model unavailable)' });
    await waitFor(() => worker.closeRequests === 1);
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({
      status: 'fail', failureDetail: 'Goal cleared after an unrecoverable error (model unavailable)',
    });
  });

  it('names a non-zero CLI exit', async () => {
    const worker = new ScriptedWorker();
    const running = pool(worker).runNode(request());
    await worker.waitForInit();
    worker.emitMessage({ type: 'claude_exit', code: 2, signal: null });
    await waitFor(() => worker.closeRequests === 1);
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({ status: 'fail', failureDetail: 'CLI exited code=2 signal=null' });
  });

  it('names the exit code of a worker that died without a claimed outcome', async () => {
    const worker = new ScriptedWorker();
    const running = pool(worker).runNode(request());
    await worker.waitForInit();
    worker.emitExit(9);
    await expect(running).resolves.toMatchObject({ status: 'fail', failureDetail: 'worker exited code=9' });
  });

  it('names the node deadline when it expires', async () => {
    const worker = new ScriptedWorker();
    const running = pool(worker).runNode({ ...request(), timeoutMs: 20 });
    await worker.waitForInit();
    await waitFor(() => worker.closeRequests === 1);
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({ status: 'fail', failureDetail: 'node timed out after 0s' });
  });

  it('fails at once when Claude clears its goal before any manifest exists', async () => {
    const worker = new ScriptedWorker();
    const running = pool(worker).runNode({ ...request(), timeoutMs: 1_800_000 });
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });
    worker.emitMessage({ type: 'error', message: 'Goal cleared after an unrecoverable error (authentication failed)', goalAborted: true });
    await waitFor(() => worker.closeRequests === 1);
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({
      status: 'fail', failureDetail: 'Goal cleared after an unrecoverable error (authentication failed)',
    });
  });

  it('settles on a manifest the goal already wrote when Claude clears the goal afterwards', async () => {
    const worker = new ScriptedWorker();
    const req = { ...request(), timeoutMs: 1_800_000 };
    const running = createEphemeralPool({
      factory: factoryFor(worker), workerPath: '/tmp/worker.js', manifestPollMs: 5, manifestSettleMs: 40,
      resolveLarkAppSecret: () => 'secret',
    }).runNode(req);
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });
    mkdirSync(dirname(req.env[GOAL_ENV.MANIFEST_PATH]!), { recursive: true });
    writeFileSync(req.env[GOAL_ENV.MANIFEST_PATH]!, '{"schemaVersion":1,"status":"ok"}');
    // Inside the manifest settle window: the closing turn's API call failed.
    worker.emitMessage({ type: 'error', message: 'Goal cleared after an unrecoverable error (context limit reached)', goalAborted: true });
    expect(worker.closeRequests).toBe(0);
    await waitFor(() => worker.closeRequests === 1);
    worker.emitExit(0);
    // Settled on the manifest; the cause stays with it in case the runtime
    // finds that manifest invalid.
    await expect(running).resolves.toMatchObject({
      status: 'ok', failureDetail: 'Goal cleared after an unrecoverable error (context limit reached)',
    });
  });

  it('fails at once with the abort cause when the deferred-to manifest disappears', async () => {
    const worker = new ScriptedWorker();
    const req = { ...request(), timeoutMs: 1_800_000 };
    const running = createEphemeralPool({
      factory: factoryFor(worker), workerPath: '/tmp/worker.js', manifestPollMs: 5, manifestSettleMs: 10_000,
      resolveLarkAppSecret: () => 'secret',
    }).runNode(req);
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });
    const manifestPath = req.env[GOAL_ENV.MANIFEST_PATH]!;
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, '{"schemaVersion":1');
    worker.emitMessage({ type: 'error', message: 'Goal cleared after an unrecoverable error (authentication failed)', goalAborted: true });
    rmSync(manifestPath);
    await waitFor(() => worker.closeRequests === 1);
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({
      status: 'fail', failureDetail: 'Goal cleared after an unrecoverable error (authentication failed)',
    });
  });

  it('keeps the abort cause when the node deadline ends a deferred settle', async () => {
    const worker = new ScriptedWorker();
    const req = { ...request(), timeoutMs: 150 };
    const running = createEphemeralPool({
      factory: factoryFor(worker), workerPath: '/tmp/worker.js', manifestPollMs: 5, manifestSettleMs: 60_000,
      resolveLarkAppSecret: () => 'secret',
    }).runNode(req);
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });
    const manifestPath = req.env[GOAL_ENV.MANIFEST_PATH]!;
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, '{"schemaVersion":1}');
    worker.emitMessage({ type: 'error', message: 'Goal cleared after an unrecoverable error (billing)', goalAborted: true });
    await waitFor(() => worker.closeRequests === 1);
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({
      status: 'fail', failureDetail: 'Goal cleared after an unrecoverable error (billing); node timed out after 0s',
    });
  });

  it('keeps the abort cause when the CLI exits non-zero during a deferred settle', async () => {
    const worker = new ScriptedWorker();
    const req = { ...request(), timeoutMs: 1_800_000 };
    const running = createEphemeralPool({
      factory: factoryFor(worker), workerPath: '/tmp/worker.js', manifestPollMs: 5, manifestSettleMs: 60_000,
      resolveLarkAppSecret: () => 'secret',
    }).runNode(req);
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });
    const manifestPath = req.env[GOAL_ENV.MANIFEST_PATH]!;
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, '{"schemaVersion":1}');
    worker.emitMessage({ type: 'error', message: 'Goal cleared after an unrecoverable error (billing)', goalAborted: true });
    worker.emitMessage({ type: 'claude_exit', code: 1, signal: null });
    await waitFor(() => worker.closeRequests === 1);
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({
      status: 'fail', failureDetail: 'Goal cleared after an unrecoverable error (billing); CLI exited code=1 signal=null',
    });
  });

  it('names the pool\'s own reason when it closed the worker itself', async () => {
    const worker = new ScriptedWorker();
    const send = worker.send.bind(worker);
    worker.send = (msg: unknown) => {
      if ((msg as any)?.type === 'raw_input') throw new Error('ipc closed');
      send(msg);
    };
    const running = pool(worker).runNode(request());
    await worker.waitForInit();
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });
    await waitFor(() => worker.closeRequests === 1);
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({ status: 'fail', failureDetail: 'node ended by the pool (goal-send-failed)' });
  });

  it('carries no failure detail on success', async () => {
    const worker = new ScriptedWorker();
    const running = pool(worker).runNode(request());
    await worker.waitForInit();
    worker.emitExit(0);
    const result = await running;
    expect(result.status).toBe('ok');
    expect(result.failureDetail).toBeUndefined();
  });
});

function request(): RunNodeRequest {
  const attemptDir = join(dir, 'research', 'attempts', '001');
  return {
    runId: 'run-v3',
    attemptId: 'research/attempts/001',
    node: {
      id: 'research',
      type: 'goal',
      goal: 'write report',
      bot: 'cli_app',
      depends: [],
      inputs: [],
      humanGate: null,
    },
    botSnapshot: {
      larkAppId: 'cli_app',
      cliId: 'claude-code',
      workingDir: '/work/repo',
    },
    runDir: dir,
    attemptDir,
    inputsPath: join(attemptDir, 'inputs.json'),
    outputDir: join(attemptDir, 'work'),
    env: {
      [GOAL_ENV.GOAL_PATH]: join(attemptDir, 'goal.txt'),
      [GOAL_ENV.INPUTS_PATH]: join(attemptDir, 'inputs.json'),
      [GOAL_ENV.OUTPUT_DIR]: join(attemptDir, 'work'),
      [GOAL_ENV.MANIFEST_PATH]: join(attemptDir, 'manifest.json'),
      [GOAL_ENV.ATTEMPT_DIR]: attemptDir,
      [GOAL_ENV.V3_MARKER]: '1',
    },
    timeoutMs: 60_000,
  };
}

function factoryFor(worker: ScriptedWorker): WorkerProcessFactory & { lastOpts?: WorkerSpawnOptions } {
  const f = {
    lastOpts: undefined as WorkerSpawnOptions | undefined,
    spawn(opts: WorkerSpawnOptions): WorkerHandle {
      f.lastOpts = opts;
      return worker;
    },
  };
  return f;
}

class ScriptedWorker extends EventEmitter implements WorkerHandle {
  readonly pid = process.pid;
  readonly kills: string[] = [];
  readonly rawInputs: string[] = [];
  readonly autoReadyAfterInit: boolean;
  closeRequests = 0;
  init: any;
  contractScope?: WorkerSessionEventScope;
  readyEmitted = false;
  private initResolve?: () => void;
  private initPromise = new Promise<void>((resolve) => { this.initResolve = resolve; });

  constructor(opts: { autoReadyAfterInit?: boolean } = {}) {
    super();
    this.autoReadyAfterInit = opts.autoReadyAfterInit ?? false;
  }

  send(msg: unknown): void {
    if ((msg as any)?.type === 'close') this.closeRequests++;
    if ((msg as any)?.type === 'init' && !this.init) {
      this.init = msg;
      const contract = (msg as any).sessionContract;
      if (contract) {
        this.contractScope = new WorkerSessionEventScope(contract.session, contract.worker);
        const binding = this.contractScope.beginRuntime();
        this.contractScope.enterRuntime(binding);
        this.emitMessage({ type: 'runtime_binding_started', bindingId: binding.bindingId });
        this.emitMessage({ type: 'runtime_binding', bindingId: binding.bindingId, identity: { backend: 'tmux', physicalId: 'fake-worker', proof: 'opaque' } });
      }
      this.initResolve?.();
      if (this.autoReadyAfterInit) {
        setImmediate(() => {
          this.readyEmitted = true;
          this.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
        });
      }
    }
    if ((msg as any)?.type === 'runtime_contract_assigned') this.contractScope?.assign((msg as any).bindingId, (msg as any).runtime);
    if ((msg as any)?.type === 'raw_input') {
      this.rawInputs.push((msg as any).content);
    }
  }

  kill(signal?: NodeJS.Signals): void {
    this.kills.push(signal ?? 'SIGTERM');
  }

  waitForInit(): Promise<void> {
    return this.initPromise;
  }

  emitMessage(msg: unknown): void {
    const binding = this.contractScope?.currentBinding();
    this.emit('message', binding && this.contractScope ? { ...(msg as any), sessionContract: this.contractScope.envelope({ bindingId: binding.bindingId, runtime: binding.runtime }) } : msg);
  }

  emitExit(code: number | null): void {
    this.emit('exit', code);
    this.emit('close', code);
  }
}

class UnbindableWorker extends EventEmitter implements WorkerHandle {
  // Valid integer shape, but deliberately not a live process identity.
  readonly pid = 0x7fff_fffe;
  closeRequested = false;

  send(msg: unknown): void {
    if ((msg as { type?: string })?.type === 'close') this.closeRequested = true;
  }

  kill(): void { /* test controls outer close explicitly */ }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition did not become true');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
