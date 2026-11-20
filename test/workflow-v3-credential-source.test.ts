// Must stay first: this suite uses the real config/data-dir modules.
import './helpers/require-fenced-data-dir.js';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import type { BotConfig } from '../src/bot-registry.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import {
  botToSnapshot,
  parseFrozenBotSnapshots,
  serializeFrozenBotSnapshots,
} from '../src/workflows/v3/bot-resolve.js';
import { GOAL_ENV, type RunNodeRequest } from '../src/workflows/v3/contract.js';
import { createEphemeralPool } from '../src/workflows/v3/ephemeral-pool.js';
import type { WorkerHandle } from '../src/workflows/shared/worker-process.js';

let dir: string;
let previousDataDir: string;
let previousSessionDataDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-v3-credential-source-'));
  previousDataDir = config.session.dataDir;
  previousSessionDataDir = process.env.SESSION_DATA_DIR;
  config.session.dataDir = join(dir, 'data');
  process.env.SESSION_DATA_DIR = config.session.dataDir;
});

afterEach(() => {
  config.session.dataDir = previousDataDir;
  if (previousSessionDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousSessionDataDir;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

class ScriptedWorker extends EventEmitter implements WorkerHandle {
  readonly pid = process.pid;
  readonly kills: string[] = [];
  init: any;
  private contractScope?: WorkerSessionEventScope;
  private initResolve?: () => void;
  private initPromise = new Promise<void>((resolve) => { this.initResolve = resolve; });

  send(msg: any): void {
    if (msg?.type === 'init' && !this.init) {
      this.init = msg;
      const contract = msg.sessionContract;
      if (contract) {
        this.contractScope = new WorkerSessionEventScope(contract.session, contract.worker);
        const binding = this.contractScope.beginRuntime();
        this.contractScope.enterRuntime(binding);
        this.emitMessage({ type: 'runtime_binding_started', bindingId: binding.bindingId });
        this.emitMessage({ type: 'runtime_binding', bindingId: binding.bindingId, identity: { backend: 'tmux', physicalId: 'fake-worker', proof: 'opaque' } });
      }
      this.initResolve?.();
    }
    if (msg?.type === 'runtime_contract_assigned') this.contractScope?.assign(msg.bindingId, msg.runtime);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void { this.kills.push(signal); }
  waitForInit(): Promise<void> { return this.initPromise; }

  emitMessage(msg: any): void {
    const binding = this.contractScope?.currentBinding();
    this.emit('message', binding && this.contractScope
      ? { ...msg, sessionContract: this.contractScope.envelope({ bindingId: binding.bindingId, runtime: binding.runtime }) }
      : msg);
  }

  emitExit(code: number | null): void {
    this.emit('exit', code);
    this.emit('close', code);
  }
}

function request(botSnapshot: RunNodeRequest['botSnapshot']): RunNodeRequest {
  const attemptDir = join(dir, 'research', 'attempts', '001');
  return {
    runId: 'run-v3',
    attemptId: 'research/attempts/001',
    node: { id: 'research', type: 'goal', goal: 'write report', bot: 'cli_app', depends: [], inputs: [], humanGate: null },
    botSnapshot,
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition did not become true');
}

describe('v3 Claude credential source', () => {
  it('freezes and forwards the source through replay to the worker', async () => {
    const sourceDir = join(dir, 'account-b');
    const bot: BotConfig = {
      larkAppId: 'cli_app', larkAppSecret: 'not-persisted', cliId: 'claude-code',
      credentialsSourceDir: sourceDir, sandbox: 'off',
    };
    const frozen = botToSnapshot(bot, '/work/repo');
    expect(frozen.credentialsSourceDir).toBe(sourceDir);
    const restored = parseFrozenBotSnapshots(
      serializeFrozenBotSnapshots(new Map([['', frozen]])),
    ).get('')!;
    expect(restored.credentialsSourceDir).toBe(sourceDir);

    const worker = new ScriptedWorker();
    const pool = createEphemeralPool({
      factory: { spawn: () => worker }, workerPath: '/tmp/worker.js', quiesceMs: 1,
      resolveLarkAppSecret: () => 'secret', resolveBot: () => bot,
    });
    const running = pool.runNode(request(restored));
    await worker.waitForInit();
    expect(worker.init).toMatchObject({ cliId: 'claude-code', credentialsSourceDir: sourceDir });
    worker.emitMessage({ type: 'ready', port: 3001, token: 'tok' });
    worker.emitMessage({ type: 'prompt_ready' });
    worker.emitMessage({ type: 'final_output', content: 'done', lastUuid: 'u', turnId: 't' });
    await waitFor(() => worker.kills.includes('SIGTERM'));
    worker.emitExit(0);
    await expect(running).resolves.toMatchObject({ status: 'ok' });
  });

  it('normalizes a frozen source and rejects relative replay paths', () => {
    const base = { larkAppId: 'cli_app', cliId: 'claude-code', workingDir: '/work/repo' } as const;
    const restored = parseFrozenBotSnapshots({ '': {
      ...base, credentialsSourceDir: '/work/accounts/../accounts/b',
    } }).get('')!;
    expect(restored.credentialsSourceDir).toBe('/work/accounts/b');
    expect(() => parseFrozenBotSnapshots({ '': {
      ...base, credentialsSourceDir: 'accounts/b',
    } })).toThrow(/absolute path/);
  });
});
