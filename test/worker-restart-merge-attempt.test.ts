/**
 * Worker-side half of #1863: who owns the receipt of a merged restart.
 *
 * The worker folds a `restart` that lands while another respawn is already in
 * flight into that respawn (merge guard). When the folded restart carries an
 * attemptId and no attempt owns the in-flight respawn's receipt yet — a
 * worker-initiated restart, or the previous attempt was already reported
 * `failed` because its replacement exited and the daemon minted a fresh
 * attempt for that claude_exit — the folded attempt must adopt it. Otherwise
 * the daemon's attempt never gets a `restart_result`, its workerReady fence
 * never lifts, and fork / relay stay `worker_busy`.
 *
 * An attempt that already owns the receipt must never be displaced.
 *
 * The adopted attempt can arrive AFTER the in-flight replacement already
 * reached its prompt (e.g. a /restart minted once the previous attempt
 * settled, while a Codex continuation still awaits its title-baseline probe).
 * markPromptReady() dedupes repeated ready, so the continuation end must settle
 * it — and republish `prompt_ready`, since the daemon cleared cliReady when it
 * requested that attempt.
 *
 * Drives the real worker (src/worker.ts) over IPC with a fake CLI, mirroring
 * worker-restart-policy-capability.test.ts.
 */
import { execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { isBunRuntime, spawnTsScript } from './helpers/ts-runner.js';

type RestartResult = Extract<WorkerToDaemon, { type: 'restart_result' }>;

interface Harness {
  child: ChildProcess;
  logs: string[];
  messages: WorkerToDaemon[];
  launchCount: string;
  /** One line per CLI launch (traex: cwd; codex: `cwd|env mark|argv`). */
  launches: string;
  root: string;
  /** Launches recorded when each message (same index) arrived. */
  launchesAtMessage: number[];
  /** Worker log chunks received when each message (same index) arrived. */
  logsAtMessage: number[];
}

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();
let sequence = 0;
// Same constraint as worker-restart-policy-capability.test.ts: the direct PTY
// backend is unavailable when the worker itself runs under Bun.
const directPtyUnavailableInBun = isBunRuntime();

async function waitFor(harness: Harness, predicate: () => boolean, description: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (harness.child.exitCode !== null || harness.child.signalCode !== null) {
      throw new Error(`worker exited before ${description}\n${harness.logs.join('')}`);
    }
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${description}\n${harness.logs.join('')}`);
}

function launchCountEquals(harness: Harness, expected: string): boolean {
  try {
    return readFileSync(harness.launchCount, 'utf8') === expected;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function restartResults(harness: Harness): RestartResult[] {
  return harness.messages.filter((m): m is RestartResult => m.type === 'restart_result');
}

function countLaunches(file: string): number {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/** Codex launches: the cwd, the injected env mark and the argv of each one. */
function codexLaunches(harness: Harness): Array<{ dir: string; mark: string; args: string }> {
  return launchedDirs(harness).map(line => {
    const [dir, mark, ...args] = line.split('|');
    return { dir, mark, args: args.join('|') };
  });
}

/** Worker log text received before this worker message arrived. */
function logsBefore(harness: Harness, predicate: (m: WorkerToDaemon) => boolean): string {
  const index = harness.messages.findIndex(predicate);
  expect(index).toBeGreaterThanOrEqual(0);
  return harness.logs.slice(0, harness.logsAtMessage[index]).join('');
}

const TITLE_PROBE_GAVE_UP = 'Could not capture Codex resume title baseline';

/** How many CLI launches had happened when this worker message arrived. */
function launchesWhen(harness: Harness, predicate: (m: WorkerToDaemon) => boolean): number {
  const index = harness.messages.findIndex(predicate);
  expect(index).toBeGreaterThanOrEqual(0);
  return harness.launchesAtMessage[index];
}

function launchedDirs(harness: Harness): string[] {
  try {
    return readFileSync(harness.launches, 'utf8').split('\n').filter(Boolean);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function startWorker(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'botmux-restart-merge-'));
  tempDirs.add(root);
  const launchCount = join(root, 'launch-count');
  const launches = join(root, 'launches');
  const fakeCli = join(root, 'trae');
  // Every launch keeps redrawing a prompt for a while, then idles.
  writeFileSync(fakeCli, `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "fake trae 1.0.0"
  exit 0
fi
count=0
if [ -f '${launchCount}' ]; then count=$(cat '${launchCount}'); fi
count=$((count + 1))
printf '%s' "$count" > '${launchCount}'
pwd -P >> '${launches}'
for _ in $(seq 1 20); do
  printf '\\n› \\n'
  sleep 0.05
done
exec sleep 60
`);
  chmodSync(fakeCli, 0o755);

  const sessionId = `rmg${process.pid.toString(36)}${(++sequence).toString(36)}${Date.now().toString(36)}`;
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  const launchesAtMessage: number[] = [];
  const logsAtMessage: number[] = [];
  const child = spawnTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      SESSION_DATA_DIR: root,
      BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: 'app_restart_merge',
      LARK_APP_SECRET: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.on('message', raw => {
    messages.push(raw as WorkerToDaemon);
    launchesAtMessage.push(countLaunches(launches));
    logsAtMessage.push(logs.length);
  });
  child.send({
    type: 'init',
    sessionId,
    chatId: 'oc_restart_merge',
    rootMessageId: 'om_restart_merge',
    workingDir: root,
    cliId: 'traex',
    cliPathOverride: fakeCli,
    backendType: 'pty',
    prompt: '',
    larkAppId: 'app_restart_merge',
    larkAppSecret: 'secret',
    launchShell: '/bin/sh',
  } satisfies DaemonToWorker);
  return { child, logs, messages, launchCount, launches, root, launchesAtMessage, logsAtMessage };
}

async function waitForFirstLaunch(harness: Harness): Promise<void> {
  await waitFor(
    harness,
    () => harness.messages.some(m => m.type === 'ready') && launchCountEquals(harness, '1'),
    'initial worker readiness and first CLI launch',
  );
}

/** Let the replacement CLI's ready gate settle (as the daemon does on resume). */
async function settleReplacement(harness: Harness): Promise<void> {
  await waitFor(harness, () => launchCountEquals(harness, '2'), 'replacement CLI launch');
  harness.child.send({ type: 'session_ready', source: 'resume' } satisfies DaemonToWorker);
}

/**
 * Wait for `predicate`, releasing each new CLI generation's ready gate as it
 * launches (the daemon sends session_ready on resume).
 */
async function waitAcrossLaunches(harness: Harness, predicate: () => boolean, description: string): Promise<void> {
  let released = launchedDirs(harness).length;
  await waitFor(harness, () => {
    const launched = launchedDirs(harness).length;
    if (launched > released) {
      released = launched;
      harness.child.send({ type: 'session_ready', source: 'resume' } satisfies DaemonToWorker);
    }
    return predicate();
  }, description, 40_000);
}

/**
 * A fake `codex` whose app-server never answers, so the restart continuation's
 * prepareCodexNativeTitleGeneration() (resume + nativeSessionTitle) sits on its
 * 7s metadata probe — long after the replacement TUI has reached its prompt.
 * In that window the replacement's ready edge has already settled the attempt
 * that existed then, while the restart is still in flight.
 */
function startCodexWorker(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'botmux-restart-merge-codex-'));
  tempDirs.add(root);
  const launchCount = join(root, 'launch-count');
  const launches = join(root, 'launches');
  const fakeCli = join(root, 'codex');
  writeFileSync(fakeCli, `#!/usr/bin/env bash
case "$1" in
  --version) echo "codex-cli 0.0.0-test"; exit 0 ;;
  app-server) exec sleep 60 ;;
esac
count=0
if [ -f '${launchCount}' ]; then count=$(cat '${launchCount}'); fi
count=$((count + 1))
printf '%s' "$count" > '${launchCount}'
printf '%s|%s|%s\n' "$(pwd -P)" "\${BMX_RESTART_TEST_MARK:-}" "$*" >> '${launches}'
for _ in $(seq 1 40); do
  printf '\n› \n'
  sleep 0.05
done
exec sleep 60
`);
  chmodSync(fakeCli, 0o755);

  const sessionId = `rmc${process.pid.toString(36)}${(++sequence).toString(36)}${Date.now().toString(36)}`;
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  const launchesAtMessage: number[] = [];
  const logsAtMessage: number[] = [];
  const child = spawnTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: join(root, '.codex'),
      SESSION_DATA_DIR: root,
      BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: 'app_restart_merge',
      LARK_APP_SECRET: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.on('message', raw => {
    messages.push(raw as WorkerToDaemon);
    launchesAtMessage.push(countLaunches(launches));
    logsAtMessage.push(logs.length);
  });
  child.send({
    type: 'init',
    sessionId,
    chatId: 'oc_restart_merge',
    rootMessageId: 'om_restart_merge',
    workingDir: root,
    cliId: 'codex',
    cliPathOverride: fakeCli,
    backendType: 'pty',
    prompt: '',
    // Restart respawns `resume: true` with this id; with a native title that
    // routes the continuation through prepareCodexNativeTitleGeneration().
    cliSessionId: 'thread-restart-merge-p1',
    nativeSessionTitle: 'Restart merge P1',
    larkAppId: 'app_restart_merge',
    larkAppSecret: 'secret',
    launchShell: '/bin/sh',
  } satisfies DaemonToWorker);
  return { child, logs, messages, launchCount, launches, root, launchesAtMessage, logsAtMessage };
}

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe('worker restart merge guard — receipt ownership (#1863)', () => {
  it.skipIf(directPtyUnavailableInBun)(
    'a correlated restart folded into an uncorrelated in-flight respawn adopts its success receipt',
    async () => {
      const harness = startWorker();
      await waitForFirstLaunch(harness);

      // An uncorrelated respawn is already in flight (worker-initiated restart /
      // an attempt already reported failed) when the daemon's attempt lands.
      harness.child.send({ type: 'restart' } satisfies DaemonToWorker);
      harness.child.send({ type: 'restart', attemptId: 'folded-attempt' } satisfies DaemonToWorker);

      await settleReplacement(harness);
      await waitFor(
        harness,
        () => restartResults(harness).some(r => r.attemptId === 'folded-attempt' && r.status === 'succeeded'),
        'folded attempt success receipt',
        30_000,
      );
      // Folded, not stacked: exactly one replacement launch.
      expect(readFileSync(harness.launchCount, 'utf8')).toBe('2');
      expect(harness.logs.join('')).toContain('Restart request merged into in-flight restart');
    },
    45_000,
  );

  it.skipIf(directPtyUnavailableInBun)(
    'never displaces an attempt that already owns the in-flight receipt',
    async () => {
      const harness = startWorker();
      await waitForFirstLaunch(harness);

      harness.child.send({ type: 'restart', attemptId: 'owner-attempt' } satisfies DaemonToWorker);
      harness.child.send({ type: 'restart', attemptId: 'late-attempt' } satisfies DaemonToWorker);

      await settleReplacement(harness);
      await waitFor(
        harness,
        () => restartResults(harness).some(r => r.attemptId === 'owner-attempt' && r.status === 'succeeded'),
        'owner attempt success receipt',
        30_000,
      );
      await new Promise(r => setTimeout(r, 500));
      expect(restartResults(harness).filter(r => r.attemptId === 'late-attempt')).toEqual([]);
      // Folded, not stacked.
      expect(readFileSync(harness.launchCount, 'utf8')).toBe('2');
    },
    45_000,
  );

  it.skipIf(directPtyUnavailableInBun)(
    'Codex: an attempt adopted after the replacement already reached its prompt is settled when the continuation ends',
    async () => {
      const harness = startCodexWorker();
      await waitForFirstLaunch(harness);

      harness.child.send({ type: 'restart', attemptId: 'settled-at-ready-edge' } satisfies DaemonToWorker);
      await waitAcrossLaunches(
        harness,
        () => restartResults(harness).some(r => r.attemptId === 'settled-at-ready-edge' && r.status === 'succeeded'),
        'replacement ready edge settling the first attempt',
      );
      // Still inside the continuation: the title-baseline probe has not given up.
      expect(harness.logs.join('')).not.toContain('Could not capture Codex resume title baseline');

      // The daemon has settled the first attempt; a new /restart mints a fresh
      // one that the merge guard adopts — after the replacement's ready edge.
      const readyBefore = harness.messages.filter(m => m.type === 'prompt_ready').length;
      harness.child.send({ type: 'restart', attemptId: 'adopted-after-ready' } satisfies DaemonToWorker);
      await waitFor(
        harness,
        () => restartResults(harness).some(r => r.attemptId === 'adopted-after-ready' && r.status === 'succeeded'),
        'success receipt for the attempt adopted after the ready edge',
        30_000,
      );
      // prompt_ready is republished before the receipt, restoring the daemon's
      // cliReady that requesting this attempt cleared.
      const receiptAt = harness.messages.findIndex(m => m.type === 'restart_result' && m.attemptId === 'adopted-after-ready');
      const republished = harness.messages.slice(0, receiptAt).filter(m => m.type === 'prompt_ready').length;
      expect(republished).toBeGreaterThan(readyBefore);
      expect(harness.messages[receiptAt - 1]?.type).toBe('prompt_ready');
      const log = harness.logs.join('');
      expect(log).toContain('Restart request merged into in-flight restart');
      expect(log).toContain('Could not capture Codex resume title baseline');
      // Settled from the existing replacement — no extra respawn.
      expect(readFileSync(harness.launchCount, 'utf8')).toBe('2');
    },
    60_000,
  );

  it.skipIf(directPtyUnavailableInBun)(
    'Codex: a role switch folded in after a worker-internal restart captured its cwd is settled only by the converged new-cwd replacement',
    async () => {
      const harness = startCodexWorker();
      const target = mkdtempSync(join(tmpdir(), 'botmux-restart-merge-role-'));
      tempDirs.add(target);
      const targetReal = realpathSync(target);
      await waitForFirstLaunch(harness);

      // Worker-internal restart (e.g. durable lease expiry): no attempt id and
      // invisible to the daemon's restart_in_progress check.
      harness.child.send({ type: 'restart' } satisfies DaemonToWorker);
      await waitAcrossLaunches(harness, () => codexLaunches(harness).length >= 2, 'replacement launch in the old cwd');
      expect(codexLaunches(harness)[1].dir).toBe(realpathSync(harness.root));
      // The window's restartCfg (old cwd) is captured; its continuation still
      // awaits the title probe. The role switch lands now.
      expect(harness.logs.join('')).not.toContain('Could not capture Codex resume title baseline');
      harness.child.send({ type: 'restart', attemptId: 'role-switch', updateWorkingDir: target } satisfies DaemonToWorker);

      await waitAcrossLaunches(
        harness,
        () => restartResults(harness).some(r => r.attemptId === 'role-switch' && r.status === 'succeeded'),
        'role-switch receipt from the converged replacement',
      );
      const launches = codexLaunches(harness);
      expect(launches).toHaveLength(3);
      expect(launches[2].dir).toBe(targetReal);
      // Not settled by the stale old-cwd replacement (its prompt and the
      // continuation end both passed) — only once the new-cwd one existed.
      expect(launchesWhen(harness, m => m.type === 'restart_result' && m.attemptId === 'role-switch')).toBe(3);
      // Settled by the converged replacement's own ready edge (the attempt
      // owns the convergence window), not left for its continuation end.
      const before = logsBefore(harness, m => m.type === 'restart_result' && m.attemptId === 'role-switch');
      expect(before.split(TITLE_PROBE_GAVE_UP).length - 1).toBe(1);
      expect(restartResults(harness).filter(r => r.attemptId === 'role-switch')).toHaveLength(1);
      expect(harness.logs.join('')).toContain('asks for different launch settings');
    },
    90_000,
  );

  it.skipIf(directPtyUnavailableInBun)(
    'Codex: new env / model requested after the previous attempt settled converge before the new attempt settles',
    async () => {
      const harness = startCodexWorker();
      await waitForFirstLaunch(harness);

      harness.child.send({ type: 'restart', attemptId: 'first-restart' } satisfies DaemonToWorker);
      await waitAcrossLaunches(
        harness,
        () => restartResults(harness).some(r => r.attemptId === 'first-restart' && r.status === 'succeeded'),
        'first restart settled at the replacement ready edge',
      );
      expect(harness.logs.join('')).not.toContain('Could not capture Codex resume title baseline');

      // Operator saved new env / model and restarted from the dashboard: the
      // coordinator is idle, so it passed the 409 check and minted a new attempt.
      harness.child.send({
        type: 'restart',
        attemptId: 'config-edit',
        env: { BMX_RESTART_TEST_MARK: 'edited' },
        model: 'model-edited',
      } satisfies DaemonToWorker);

      await waitAcrossLaunches(
        harness,
        () => restartResults(harness).some(r => r.attemptId === 'config-edit' && r.status === 'succeeded'),
        'config-edit receipt from the converged replacement',
      );
      const launches = codexLaunches(harness);
      expect(launches).toHaveLength(3);
      expect(launches[1].mark).toBe('');
      expect(launches[1].args).not.toContain('model-edited');
      expect(launches[2].mark).toBe('edited');
      expect(launches[2].args).toContain('--model model-edited');
      expect(launchesWhen(harness, m => m.type === 'restart_result' && m.attemptId === 'config-edit')).toBe(3);
      const before = logsBefore(harness, m => m.type === 'restart_result' && m.attemptId === 'config-edit');
      expect(before.split(TITLE_PROBE_GAVE_UP).length - 1).toBe(1);
    },
    90_000,
  );
});
