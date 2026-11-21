import { createHash } from 'node:crypto';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BotConfig } from '../src/bot-registry.js';
import { parseFrozenBotSnapshots } from '../src/workflows/v3/bot-resolve.js';
import {
  cmdGoal,
  GOAL_RUN_EXIT,
  GOAL_RUN_RESULT_SCHEMA,
  type GoalCliDependencies,
  type GoalRunResultV1,
} from '../src/workflows/v3/goal-cli.js';
import { readJournal } from '../src/workflows/v3/journal.js';
import {
  readAndValidateManifest,
  ManifestValidationError,
} from '../src/workflows/v3/manifest.js';
import { materialize } from '../src/workflows/v3/state.js';
import { GOAL_ENV, type Manifest, type RunNode, type ValidateManifest } from '../src/workflows/v3/contract.js';
import { spawnTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';

const TEST_BOT: BotConfig = {
  larkAppId: 'cli_goal_test',
  larkAppSecret: 'test-secret',
  name: 'goal-test',
  cliId: 'codex',
  workingDir: '/tmp',
};

const validateManifest: ValidateManifest = async (manifestPath, outputDir) => {
  try {
    return { ok: true, manifest: await readAndValidateManifest(manifestPath, outputDir) };
  } catch (error) {
    return {
      ok: false,
      problems: error instanceof ManifestValidationError ? error.problems : [String(error)],
    };
  }
};

class Sink {
  text = '';
  write(chunk: string | Uint8Array): boolean {
    this.text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }
}

function product(outputDir: string, content = 'goal product'): Manifest['files'][number] {
  const path = 'result.md';
  writeFileSync(join(outputDir, path), content);
  return {
    name: 'result',
    path,
    kind: 'markdown',
    bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    mime: 'text/markdown',
  };
}

function writeManifest(req: Parameters<RunNode>[0], manifest: Manifest): string {
  const path = req.env[GOAL_ENV.MANIFEST_PATH]!;
  writeFileSync(path, `${JSON.stringify(manifest)}\n`);
  return path;
}

function successfulRunNode(onCall?: (attemptId: string) => void): RunNode {
  return async (req) => {
    onCall?.(req.attemptId);
    const file = product(req.outputDir);
    const manifestPath = writeManifest(req, {
      schemaVersion: 1,
      status: 'ok',
      summary: 'goal complete',
      files: [file],
    });
    return { status: 'ok', manifestPath };
  };
}

function harness(baseDir: string, runNode: RunNode) {
  const stdout = new Sink();
  const stderr = new Sink();
  const signals = new EventEmitter();
  const deps: Partial<GoalCliDependencies> = {
    loadBots: () => [TEST_BOT],
    makeRunNode: () => runNode,
    validateManifest,
    readValidatedManifest: readAndValidateManifest,
    signalEmitter: signals as unknown as GoalCliDependencies['signalEmitter'],
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    newRunId: () => 'generated-goal-run',
    env: { BOTMUX_WORKFLOW_ENABLED: 'true' },
    stdout: stdout as unknown as GoalCliDependencies['stdout'],
    stderr: stderr as unknown as GoalCliDependencies['stderr'],
  };
  const args = (runId: string, goal = 'write a report', extra: string[] = []) => [
    goal,
    '--run-id', runId,
    '--base-dir', baseDir,
    '--json',
    ...extra,
  ];
  return { stdout, stderr, signals, deps, args };
}

function onlyJson(sink: Sink): GoalRunResultV1 {
  const parsed = JSON.parse(sink.text) as GoalRunResultV1;
  expect(sink.text).toBe(`${JSON.stringify(parsed)}\n`);
  return parsed;
}

describe('botmux goal run — machine terminal contract', () => {
  const roots: string[] = [];
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    children.length = 0;
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function root(): string {
    const value = mkdtempSync(join(tmpdir(), 'botmux-goal-cli-'));
    roots.push(value);
    return value;
  }

  function goalHome(base: string): string {
    const home = join(base, 'codex-goal-home');
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-6.1-sol"\n', { mode: 0o600 });
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'NOT-A-REAL-TOKEN' } }), { mode: 0o600 });
    return realpathSync(home);
  }

  it('writes exactly one versioned JSON document after durable success and exposes only validated artifacts', async () => {
    const base = root();
    const h = harness(base, successfulRunNode());

    const exitCode = await cmdGoal('run', h.args('json-success'), h.deps);
    const result = onlyJson(h.stdout);

    expect(exitCode).toBe(GOAL_RUN_EXIT.succeeded);
    expect(result).toMatchObject({
      schemaVersion: GOAL_RUN_RESULT_SCHEMA,
      runId: 'json-success',
      state: 'succeeded',
      exitCode: GOAL_RUN_EXIT.succeeded,
      summary: 'goal complete',
      runDirectory: { stability: 'informative-only' },
    });
    expect(result.artifacts).toEqual([
      expect.objectContaining({ path: 'result.md', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ]);
    expect('usage' in result).toBe(false);
    expect(h.stderr.text).toBe('');

    const events = readJournal(join(base, 'json-success', 'journal.ndjson'));
    expect(materialize(events).runStatus).toBe('succeeded');
    expect(events.at(-1)?.type).toBe('runSucceeded');
  });

  it('keeps real process stdout to one JSON document and routes no runtime log into it', () => {
    const base = root();
    // execFileSync 形态，wrapper 表达不了，用 runner 前缀拼 argv。
    const { command, prefixArgs } = tsRunnerPrefix();
    const stdout = execFileSync(
      command,
      [...prefixArgs, 'test/fixtures/run-goal-cli-success.ts', base, 'wire-json'],
      { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const parsed = JSON.parse(stdout) as GoalRunResultV1;
    expect(stdout).toBe(`${JSON.stringify(parsed)}\n`);
    expect(parsed).toMatchObject({ state: 'succeeded', exitCode: 0 });
  });

  it('returns a machine-readable startup error with the reserved error exit code', async () => {
    const base = root();
    const h = harness(base, successfulRunNode());
    const exitCode = await cmdGoal('run', ['--json', '--base-dir', base], h.deps);
    expect(exitCode).toBe(GOAL_RUN_EXIT.error);
    expect(onlyJson(h.stdout)).toMatchObject({
      state: 'error',
      exitCode: GOAL_RUN_EXIT.error,
      error: { code: 'USAGE' },
    });
  });

  it('freezes a relative --working-dir as an absolute request and bot snapshot', async () => {
    const base = root();
    const h = harness(base, successfulRunNode());
    expect(await cmdGoal('run', h.args('absolute-cwd', 'work', ['--working-dir', '.']), h.deps)).toBe(0);

    const request = JSON.parse(readFileSync(join(base, 'absolute-cwd', 'goal.request.json'), 'utf8')) as {
      workingDir: string;
    };
    const snapshots = JSON.parse(readFileSync(join(base, 'absolute-cwd', 'bots.snapshot.json'), 'utf8')) as Record<
      string,
      { workingDir: string }
    >;
    expect(request.workingDir).toBe(process.cwd());
    expect(Object.values(snapshots)[0]?.workingDir).toBe(process.cwd());
  });

  it('freezes an explicit Codex home/model/effort and returns worker-observed runtime evidence', async () => {
    const base = root();
    const home = goalHome(base);
    const runNode: RunNode = async (req) => {
      expect(req.botSnapshot).toMatchObject({
        cliId: 'codex',
        model: 'gpt-6.1-sol',
        reasoningEffort: 'xhigh',
        cliInstanceBinding: { source: 'goal', codexHome: home, authMode: 'shared' },
      });
      const file = product(req.outputDir);
      return {
        status: 'ok',
        manifestPath: writeManifest(req, { schemaVersion: 1, status: 'ok', summary: 'verified runtime', files: [file] }),
        runtime: {
          cliId: 'codex',
          source: 'worker-active-runtime',
          model: 'gpt-6.1-sol',
          reasoningEffort: 'xhigh',
          codexHome: home,
        },
      };
    };
    const h = harness(base, runNode);
    const extra = ['--codex-home', home, '--model', 'gpt-6.1-sol', '--reasoning-effort', 'xhigh'];

    expect(await cmdGoal('run', h.args('explicit-runtime', 'repair issue', extra), h.deps)).toBe(0);
    expect(onlyJson(h.stdout)).toMatchObject({
      state: 'succeeded',
      runtime: { cliId: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', codexHome: home },
    });
    expect(JSON.parse(readFileSync(join(base, 'explicit-runtime', 'goal.request.json'), 'utf8'))).toMatchObject({
      codexHome: home,
      model: 'gpt-6.1-sol',
      reasoningEffort: 'xhigh',
    });
  });

  it('rejects a partial explicit Codex runtime before worker spawn', async () => {
    const base = root();
    const home = goalHome(base);
    const runNode = vi.fn(successfulRunNode());
    const h = harness(base, runNode);

    expect(await cmdGoal('run', h.args('partial-runtime', 'repair issue', [
      '--codex-home', home,
      '--model', 'gpt-6.1-sol',
    ]), h.deps)).toBe(GOAL_RUN_EXIT.error);
    expect(onlyJson(h.stdout)).toMatchObject({
      state: 'error',
      error: { code: 'RUN_AUTHORIZATION_FAILED', message: expect.stringContaining('must be supplied together') },
    });
    expect(runNode).not.toHaveBeenCalled();
  });

  it.each<{ name: string; model?: string; effort?: string; bot?: Partial<BotConfig>; env?: Record<string, string>; message: RegExp }>([
    { name: 'an effort the model does not support', model: 'gpt-5.5', effort: 'ultra', message: /does not support reasoning effort/ },
    { name: 'a wrapped Codex bot', bot: { wrapperCli: 'codex-wrapper' }, message: /requires an unwrapped codex bot/ },
    { name: 'a non-Codex bot', bot: { cliId: 'claude-code' }, message: /requires an unwrapped codex bot/ },
    { name: 'a sandboxed bot', bot: { sandbox: true }, message: /does not support sandboxed bots/ },
    { name: 'a sandbox forced by BOTMUX_SANDBOX', env: { BOTMUX_SANDBOX: '1' }, message: /does not support sandboxed bots/ },
  ])('rejects an explicit Codex runtime for $name before worker spawn', async ({ model = 'gpt-6.1-sol', effort = 'xhigh', bot = {}, env = {}, message }) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    try {
      const base = root();
      const home = goalHome(base);
      const runNode = vi.fn(successfulRunNode());
      const h = harness(base, runNode);
      h.deps.loadBots = () => [{ ...TEST_BOT, ...bot }];

      expect(await cmdGoal('run', h.args('rejected-runtime', 'repair issue', [
        '--codex-home', home,
        '--model', model,
        '--reasoning-effort', effort,
      ]), h.deps)).toBe(GOAL_RUN_EXIT.error);
      expect(onlyJson(h.stdout)).toMatchObject({
        state: 'error',
        error: { code: 'RUN_AUTHORIZATION_FAILED', message: expect.stringMatching(message) },
      });
      expect(runNode).not.toHaveBeenCalled();
      expect(existsSync(join(base, 'rejected-runtime', 'run.json'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects a Codex home reached through a symlinked parent before worker spawn', async () => {
    const base = realpathSync(root());
    mkdirSync(join(base, 'real'));
    const canonical = goalHome(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'alias'));
    const runNode = vi.fn(successfulRunNode());
    const h = harness(base, runNode);

    expect(await cmdGoal('run', h.args('alias-runtime', 'repair issue', [
      '--codex-home', join(base, 'alias', 'codex-goal-home'),
      '--model', 'gpt-6.1-sol',
      '--reasoning-effort', 'xhigh',
    ]), h.deps)).toBe(GOAL_RUN_EXIT.error);
    expect(onlyJson(h.stdout)).toMatchObject({
      state: 'error',
      error: { code: 'RUN_AUTHORIZATION_FAILED', message: expect.stringContaining('canonical path') },
    });
    expect(canonical).toBe(join(base, 'real', 'codex-goal-home'));
    expect(runNode).not.toHaveBeenCalled();
  });

  it('persists the goal binding for re-drive and refuses a tampered frozen snapshot', async () => {
    const base = root();
    const home = goalHome(base);
    const h = harness(base, successfulRunNode());
    expect(await cmdGoal('run', h.args('frozen-runtime', 'repair issue', [
      '--codex-home', home,
      '--model', 'gpt-6.1-sol',
      '--reasoning-effort', 'xhigh',
    ]), h.deps)).toBe(0);

    const frozen = JSON.parse(readFileSync(join(base, 'frozen-runtime', 'bots.snapshot.json'), 'utf8')) as Record<string, Record<string, unknown>>;
    const restored = [...parseFrozenBotSnapshots(frozen).values()];
    expect(restored.length).toBeGreaterThan(0);
    for (const snapshot of restored) {
      expect(snapshot).toMatchObject({
        model: 'gpt-6.1-sol',
        reasoningEffort: 'xhigh',
        cliInstanceBinding: { source: 'goal', instanceId: null, authMode: 'shared', codexHome: home },
      });
    }

    const tampered = (edit: (snapshot: Record<string, unknown>) => void): Record<string, Record<string, unknown>> => {
      const copy = structuredClone(frozen);
      for (const snapshot of Object.values(copy)) edit(snapshot);
      return copy;
    };
    const binding = (snapshot: Record<string, unknown>) => snapshot.cliInstanceBinding as Record<string, unknown>;
    expect(() => parseFrozenBotSnapshots(tampered((s) => { binding(s).authMode = 'isolated'; })))
      .toThrow('invalid frozen workflow Codex instance binding');
    expect(() => parseFrozenBotSnapshots(tampered((s) => { binding(s).instanceId = 'a'; })))
      .toThrow('invalid frozen workflow Codex instance binding');
    expect(() => parseFrozenBotSnapshots(tampered((s) => { s.reasoningEffort = 'turbo'; })))
      .toThrow('reasoningEffort is invalid');
    for (const edit of [
      (s: Record<string, unknown>) => { delete s.model; },
      (s: Record<string, unknown>) => { delete s.reasoningEffort; },
      (s: Record<string, unknown>) => { s.wrapperCli = 'codex-wrapper'; },
    ]) {
      expect(() => parseFrozenBotSnapshots(tampered(edit)))
        .toThrow('goal-scoped Codex binding requires an unwrapped frozen model and reasoning effort');
    }
  });

  it('reports a goal runtime failure with its precise code instead of a generic worker error', async () => {
    const base = root();
    const home = goalHome(base);
    const runNode: RunNode = async (req) => {
      const file = product(req.outputDir);
      return {
        status: 'fail',
        manifestPath: writeManifest(req, { schemaVersion: 1, status: 'ok', summary: 'wrong runtime', files: [file] }),
        runtime: {
          cliId: 'codex',
          source: 'worker-active-runtime',
          model: 'gpt-5.6-sol',
          reasoningEffort: 'xhigh',
          codexHome: home,
        },
        error: { code: 'GOAL_RUNTIME_MISMATCH', message: 'goal-scoped Codex runtime mismatch' },
      };
    };
    const h = harness(base, runNode);

    expect(await cmdGoal('run', h.args('mismatched-runtime', 'repair issue', [
      '--codex-home', home,
      '--model', 'gpt-6.1-sol',
      '--reasoning-effort', 'xhigh',
    ]), h.deps)).toBe(GOAL_RUN_EXIT.failed);
    expect(onlyJson(h.stdout)).toMatchObject({
      state: 'failed',
      error: { code: 'GOAL_RUNTIME_MISMATCH', message: 'goal-scoped Codex runtime mismatch' },
      runtime: { model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
    });
  });

  it('replays a terminal run byte-for-byte with zero new spawn', async () => {
    const base = root();
    const runNode = vi.fn(successfulRunNode());
    const first = harness(base, runNode);
    const second = harness(base, runNode);

    expect(await cmdGoal('run', first.args('replay-same'), first.deps)).toBe(0);
    expect(await cmdGoal('run', second.args('replay-same'), second.deps)).toBe(0);

    expect(runNode).toHaveBeenCalledTimes(1);
    expect(second.stdout.text).toBe(first.stdout.text);
  });

  it('replays a terminal result without consulting mutable bots.json', async () => {
    const base = root();
    const runNode = vi.fn(successfulRunNode());
    const first = harness(base, runNode);
    const replay = harness(base, runNode);
    replay.deps.loadBots = () => { throw new Error('bots.json is unavailable'); };
    replay.deps.makeRunNode = () => { throw new Error('must not initialize a runner'); };

    expect(await cmdGoal('run', first.args('offline-replay'), first.deps)).toBe(0);
    expect(await cmdGoal('run', replay.args('offline-replay'), replay.deps)).toBe(0);

    expect(runNode).toHaveBeenCalledTimes(1);
    expect(replay.stdout.text).toBe(first.stdout.text);
  });

  it('rejects a live same-run driver and concurrent callers spawn exactly once', async () => {
    const base = root();
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runNode = vi.fn<RunNode>(async (req) => {
      started();
      await gate;
      const file = product(req.outputDir);
      return {
        status: 'ok',
        manifestPath: writeManifest(req, {
          schemaVersion: 1, status: 'ok', summary: 'winner', files: [file],
        }),
      };
    });
    const first = harness(base, runNode);
    const second = harness(base, runNode);

    const winning = cmdGoal('run', first.args('concurrent-run'), first.deps);
    await startedPromise;
    const conflictCode = await cmdGoal('run', second.args('concurrent-run'), second.deps);
    const conflict = onlyJson(second.stdout);
    release();
    const winnerCode = await winning;

    expect(conflictCode).toBe(GOAL_RUN_EXIT.conflict);
    expect(conflict).toMatchObject({ state: 'conflict', error: { code: 'RUN_ACTIVE' } });
    expect(winnerCode).toBe(GOAL_RUN_EXIT.succeeded);
    expect(runNode).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('same runId with a different goal fails closed before spawn', async () => {
    const base = root();
    const runNode = vi.fn(successfulRunNode());
    const first = harness(base, runNode);
    const second = harness(base, runNode);

    await cmdGoal('run', first.args('request-conflict', 'first goal'), first.deps);
    const exitCode = await cmdGoal('run', second.args('request-conflict', 'different goal'), second.deps);

    expect(exitCode).toBe(GOAL_RUN_EXIT.conflict);
    expect(onlyJson(second.stdout)).toMatchObject({
      state: 'conflict',
      error: { code: 'RUN_ID_CONFLICT' },
    });
    expect(runNode).toHaveBeenCalledTimes(1);
  });

  it.each([
    { state: 'failed' as const, retryable: false, exitCode: GOAL_RUN_EXIT.failed },
    { state: 'blocked' as const, retryable: true, exitCode: GOAL_RUN_EXIT.blocked },
  ])('maps a self-reported $state to its distinct exit code', async ({ state, retryable, exitCode }) => {
    const base = root();
    const runNode: RunNode = async (req) => ({
      // An intact worker may deliberately report a fail manifest; retryable
      // selects blocked vs failed. A crashed process stays infrastructure-failed.
      status: 'ok',
      manifestPath: writeManifest(req, {
        schemaVersion: 1,
        status: 'fail',
        summary: `${state} summary`,
        error: { code: `E_${state.toUpperCase()}`, message: `${state} detail`, retryable },
        files: [],
      }),
    });
    const h = harness(base, runNode);

    expect(await cmdGoal('run', h.args(`exit-${state}`), h.deps)).toBe(exitCode);
    expect(onlyJson(h.stdout)).toMatchObject({
      state,
      exitCode,
      summary: `${state} summary`,
      error: { code: `E_${state.toUpperCase()}` },
    });
  });

  it.each([
    { label: 'SIGINT', extra: [] as string[], signal: 'SIGINT' as const },
    { label: 'SIGTERM', extra: [] as string[], signal: 'SIGTERM' as const },
    { label: 'timeout', extra: ['--timeout', '0.5'], signal: undefined },
  ])('$label waits for durable cancelled before acknowledging', async ({ extra, signal }) => {
    const base = root();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const runNode: RunNode = async (req) => {
      started();
      await new Promise<void>((resolve) => {
        if (req.cancelSignal?.aborted) resolve();
        else req.cancelSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        status: 'cancelled',
        cancelReason: req.cancelSignal?.reason,
        manifestPath: req.env[GOAL_ENV.MANIFEST_PATH]!,
      };
    };
    const h = harness(base, runNode);
    const pending = cmdGoal('run', h.args(`cancel-${signal?.toLowerCase() ?? 'timeout'}`, 'wait', extra), h.deps);
    await startedPromise;
    if (signal) h.signals.emit(signal);

    const exitCode = await pending;
    const result = onlyJson(h.stdout);
    expect(exitCode).toBe(GOAL_RUN_EXIT.cancelled);
    expect(result.state).toBe('cancelled');
    const events = readJournal(join(base, result.runId!, 'journal.ndjson'));
    expect(materialize(events).runStatus).toBe('cancelled');
    expect(events.at(-1)?.type).toBe('runCancelled');
  });

  it.runIf(process.platform === 'linux')('kill -9 leaves a retryable journal; same runId re-drives as attempt 002', async () => {
    const base = root();
    const readyPath = join(base, 'ready');
    const child = spawnTsScript(
      'test/fixtures/run-goal-cli-crash.ts',
      [base, 'kill9-recover', readyPath],
      { cwd: process.cwd(), stdio: 'ignore' },
    );
    children.push(child);
    // Two preconditions before the kill, both polled (no fixed-timing guess):
    //  1. `ready` — the fixture reached runNode (dispatch happened).
    //  2. attempt 001's `nodeDispatched` is DURABLE on disk — runNode writes
    //     `ready` synchronously, but the journal append can still be in flight;
    //     killing before 001 is flushed would leave nothing to re-drive and the
    //     recovery assertion (['001','002']) would flake. Wait for the journal
    //     to actually carry 001 so the SIGKILL lands on a persisted in-flight run.
    const journalPath = join(base, 'kill9-recover', 'journal.ndjson');
    const has001 = (): boolean => {
      if (!existsSync(journalPath)) return false;
      try {
        return readJournal(journalPath).some(
          (event) => event.type === 'nodeDispatched'
            && event.attemptId === 'goal#001/attempts/001',
        );
      } catch { return false; }
    };
    for (let index = 0; index < 500 && !(existsSync(readyPath) && has001()); index++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(readyPath)).toBe(true);
    expect(has001()).toBe(true);
    child.kill('SIGKILL');
    await once(child, 'exit');

    const attempts: string[] = [];
    const h = harness(base, successfulRunNode((attempt) => attempts.push(attempt)));
    const exitCode = await cmdGoal('run', h.args('kill9-recover'), h.deps);

    expect(exitCode).toBe(0);
    expect(attempts).toEqual(['goal#001/attempts/002']);
    const events = readJournal(join(base, 'kill9-recover', 'journal.ndjson'));
    expect(events.filter((event) => event.type === 'nodeDispatched').map((event) => event.attemptId))
      .toEqual(['goal#001/attempts/001', 'goal#001/attempts/002']);
  }, 15_000);
});

describe('botmux goal run — workflow kill-switch gate', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });
  function root(): string {
    const value = mkdtempSync(join(tmpdir(), 'botmux-goal-gate-'));
    roots.push(value);
    return value;
  }

  it('refuses to launch (exit 14, WORKFLOW_DISABLED) and never invokes the ephemeral runNode when disabled', async () => {
    const base = root();
    let runNodeCalls = 0;
    const runNode: RunNode = (async () => { runNodeCalls++; throw new Error('runNode must not be reached when workflow disabled'); }) as unknown as RunNode;
    const h = harness(base, runNode);
    const exitCode = await cmdGoal('run', h.args('gated-run'), {
      ...h.deps,
      env: { BOTMUX_WORKFLOW_ENABLED: 'false' },
    });
    expect(exitCode).toBe(GOAL_RUN_EXIT.error); // 14
    expect(runNodeCalls).toBe(0); // gate is BEFORE any run launch
    const result = onlyJson(h.stdout);
    expect(result.state).toBe('error');
    expect(result.error?.code).toBe('WORKFLOW_DISABLED');
  });

  it('passes the gate and launches when explicitly enabled via env', async () => {
    const base = root();
    let runNodeCalls = 0;
    const h = harness(base, successfulRunNode(() => { runNodeCalls++; }));
    const exitCode = await cmdGoal('run', h.args('enabled-run'), {
      ...h.deps,
      env: { BOTMUX_WORKFLOW_ENABLED: 'true' },
    });
    expect(exitCode).toBe(GOAL_RUN_EXIT.succeeded);
    expect(runNodeCalls).toBe(1); // reached the real run
  });
});
