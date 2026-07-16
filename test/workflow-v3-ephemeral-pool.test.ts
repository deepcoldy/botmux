import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEphemeralPool, buildGoalCommand, GOAL_COMMAND } from '../src/workflows/v3/ephemeral-pool.js';
import { GOAL_ENV, type RunNodeRequest } from '../src/workflows/v3/contract.js';
import type { WorkerHandle, WorkerProcessFactory, WorkerSpawnOptions } from '../src/workflows/shared/worker-process.js';
import { readV3AttemptWorkerFence } from '../src/workflows/v3/worker-fence.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wf-v3-pool-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('v3 ephemeral pool', () => {
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
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
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
      sessionInfo: { webPort: 3001, token: 'tok' },
    });
    expect(factory.lastOpts?.cwd).toBe('/work/repo');
    expect(factory.lastOpts?.env[GOAL_ENV.V3_MARKER]).toBe('1');
    expect(factory.lastOpts?.env[GOAL_ENV.OUTPUT_DIR]).toBe(req.outputDir);
    expect(worker.init?.cliId).toBe('claude-code');
    expect(worker.init?.larkAppSecret).toBe('secret');
    expect(worker.init?.prompt).toBe('');
    expect(worker.rawInputs).toEqual([buildGoalCommand(req)]);
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

    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    expect(readyInfos).toEqual([{
      sessionId: expect.any(String),
      webPort: 3001,
      token: 'tok',
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
    expect(worker.rawInputs[0]).not.toContain(GOAL_ENV.OUTPUT_DIR);
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
    expect(cmd).toContain(`$${GOAL_ENV.MANIFEST_PATH}`);
    expect(cmd).not.toContain(request().env[GOAL_ENV.GOAL_PATH]);
    expect(cmd).not.toContain('schemaVersion');
    expect(cmd).not.toContain('status:"ok"');
    expect(cmd).not.toContain('status:"fail"');
    expect(cmd).not.toContain('\n');
    expect(Buffer.byteLength(cmd, 'utf-8')).toBeLessThanOrEqual(180);
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
  init: any;
  readyEmitted = false;
  private initResolve?: () => void;
  private initPromise = new Promise<void>((resolve) => { this.initResolve = resolve; });

  constructor(opts: { autoReadyAfterInit?: boolean } = {}) {
    super();
    this.autoReadyAfterInit = opts.autoReadyAfterInit ?? false;
  }

  send(msg: unknown): void {
    if ((msg as any)?.type === 'init' && !this.init) {
      this.init = msg;
      this.initResolve?.();
      if (this.autoReadyAfterInit) {
        setImmediate(() => {
          this.readyEmitted = true;
          this.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
        });
      }
    }
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
    this.emit('message', msg);
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
