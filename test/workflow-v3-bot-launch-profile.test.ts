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
import { GOAL_ENV, type BotSnapshot, type RunNodeRequest } from '../src/workflows/v3/contract.js';
import { createEphemeralPool } from '../src/workflows/v3/ephemeral-pool.js';
import type { WorkerHandle } from '../src/workflows/shared/worker-process.js';

// An ordinary session freezes the bot's Claude profile dir (cliConfigDir) and
// TraeX backend variant at its first fork and hands both to the worker. A v3
// workflow node spawns its worker from the frozen BotSnapshot instead, so the
// snapshot must carry the same two fields through replay into worker init —
// otherwise the node silently launches on the CLI's default profile/variant.

let dir: string;
let previousDataDir: string;
let previousSessionDataDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-v3-launch-profile-'));
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
        this.emit('message', { type: 'runtime_binding_started', bindingId: binding.bindingId, sessionContract: this.contractScope.envelope({ bindingId: binding.bindingId, runtime: binding.runtime }) });
        this.emit('message', { type: 'runtime_binding', bindingId: binding.bindingId, identity: { backend: 'tmux', physicalId: 'fake-worker', proof: 'opaque' }, sessionContract: this.contractScope.envelope({ bindingId: binding.bindingId, runtime: binding.runtime }) });
      }
      this.initResolve?.();
    }
    if (msg?.type === 'runtime_contract_assigned') this.contractScope?.assign(msg.bindingId, msg.runtime);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void { this.kills.push(signal); }
  waitForInit(): Promise<void> { return this.initPromise; }

  emitExit(code: number | null): void {
    this.emit('exit', code);
    this.emit('close', code);
  }
}

function request(botSnapshot: BotSnapshot): RunNodeRequest {
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

/** BotConfig → frozen snapshot → bots.snapshot.json replay, as a resumed run sees it. */
function freezeAndReplay(bot: BotConfig): BotSnapshot {
  const frozen = serializeFrozenBotSnapshots(new Map([['', botToSnapshot(bot, dir)]]));
  return parseFrozenBotSnapshots(JSON.parse(JSON.stringify(frozen))).get('')!;
}

async function workerInitFor(bot: BotConfig, snapshot: BotSnapshot): Promise<any> {
  const worker = new ScriptedWorker();
  const pool = createEphemeralPool({
    factory: { spawn: () => worker }, workerPath: '/tmp/worker.js', quiesceMs: 1,
    resolveLarkAppSecret: () => 'secret', resolveBot: () => bot,
  });
  const running = pool.runNode(request(snapshot));
  await worker.waitForInit();
  worker.emitExit(1);
  await running;
  return worker.init;
}

const base = { larkAppId: 'cli_app', larkAppSecret: 'not-persisted', sandbox: 'off' } as const;

describe('v3 node launch profile', () => {
  it('carries a Claude bot\'s cliConfigDir from the frozen snapshot into worker init', async () => {
    const bot: BotConfig = { ...base, cliId: 'claude-code', cliConfigDir: '~/.botmux/bots/cli_app/claude-profile' };
    const replayed = freezeAndReplay(bot);
    expect(replayed.cliConfigDir).toBe('~/.botmux/bots/cli_app/claude-profile');
    const init = await workerInitFor(bot, replayed);
    expect(init).toMatchObject({ cliId: 'claude-code', cliConfigDir: '~/.botmux/bots/cli_app/claude-profile' });
  });

  it('carries a TraeX bot\'s modelBackendVariant from the frozen snapshot into worker init', async () => {
    const bot: BotConfig = { ...base, cliId: 'traex', modelBackendVariant: 'max' };
    const replayed = freezeAndReplay(bot);
    expect(replayed.modelBackendVariant).toBe('max');
    const init = await workerInitFor(bot, replayed);
    expect(init).toMatchObject({ cliId: 'traex', modelBackendVariant: 'max' });
  });

  it('freezes each field only for the CLIs whose launch honors it', () => {
    const codex = botToSnapshot({ ...base, cliId: 'codex', cliConfigDir: '/profiles/x', modelBackendVariant: 'max' }, dir);
    expect(codex.cliConfigDir).toBeUndefined();
    expect(codex.modelBackendVariant).toBeUndefined();
    const claude = botToSnapshot({ ...base, cliId: 'claude-code', modelBackendVariant: 'max' }, dir);
    expect(claude.modelBackendVariant).toBeUndefined();
  });

  it('keeps historical snapshots without either field launching on the CLI defaults', async () => {
    const bot: BotConfig = { ...base, cliId: 'claude-code' };
    const historical = parseFrozenBotSnapshots({ '': { larkAppId: 'cli_app', cliId: 'claude-code', workingDir: dir } }).get('')!;
    const init = await workerInitFor(bot, historical);
    expect(init.cliConfigDir).toBeUndefined();
    expect(init.modelBackendVariant).toBeUndefined();
  });

  it('rejects replayed artifacts that carry an unusable profile dir or variant', () => {
    const claude = { larkAppId: 'cli_app', cliId: 'claude-code', workingDir: dir };
    const traex = { larkAppId: 'cli_app', cliId: 'traex', workingDir: dir };
    expect(parseFrozenBotSnapshots({ '': { ...claude, cliConfigDir: '/profiles/x/' } }).get('')!.cliConfigDir).toBe('/profiles/x');
    expect(() => parseFrozenBotSnapshots({ '': { ...claude, cliConfigDir: 'relative/profile' } })).toThrow(/cliConfigDir must be an absolute path/);
    expect(() => parseFrozenBotSnapshots({ '': { ...traex, cliConfigDir: '/profiles/x' } })).toThrow(/cliConfigDir is not supported/);
    expect(() => parseFrozenBotSnapshots({ '': { ...traex, modelBackendVariant: 'turbo' } })).toThrow(/modelBackendVariant must be standard or max/);
    expect(() => parseFrozenBotSnapshots({ '': { ...claude, modelBackendVariant: 'max' } })).toThrow(/modelBackendVariant is not supported/);
  });
});
