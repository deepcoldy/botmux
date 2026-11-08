import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readJsonLines } from './helpers/read-json-lines.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

/**
 * The worker driven by REAL TraeX 0.209 terminal bytes and rollout records,
 * replayed from test/fixtures/traex-tape/two-turns.json (recorded with
 * scripts/record-traex-tape.ts). CI cannot install the internally
 * distributed binary, so this is the closest it gets to the real TUI: the
 * ⋄◇✦◈❖✧ spinner, the always-visible `❯` composer, and the banner logo that
 * blinks forever (the PTY is never byte-silent while idle).
 *
 * Real timing on purpose (no BOTMUX_TIME_SCALE): TraeX receipts a submit in
 * history.jsonl ~200ms after Enter, longer than a scaled confirmation window.
 */

const TAPE = resolve('test/fixtures/traex-tape/two-turns.json');
const PLAYER = resolve('test/helpers/traex-tape-player.mjs');

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(r => child.once('exit', () => r()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise<void>(r => setTimeout(r, 2_000))]);
    }
  }
  children.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

async function waitFor(
  child: ChildProcess,
  predicate: () => boolean,
  logs: string[],
  description: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`worker exited before ${description}\n${logs.join('')}`);
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${description}\n${logs.join('')}`);
}

function readSubmissions(path: string): string[] {
  return readJsonLines<{ text: string }>(path).map(row => row.text);
}

function startReplayWorker(terminalDelayMs: number) {
  const tape = JSON.parse(readFileSync(TAPE, 'utf8')) as { nativeSessionId: string };
  const botmuxSessionId = randomUUID();
  const root = mkdtempSync(join(tmpdir(), 'botmux-traex-tape-'));
  tempDirs.add(root);
  const dataDir = join(root, 'session');
  const traeHome = join(root, '.trae');
  const rolloutDir = join(traeHome, 'cli', 'sessions', '2026', '10', '13');
  const rolloutPath = join(rolloutDir, `rollout-2026-10-13T00-00-00-${tape.nativeSessionId}.jsonl`);
  const historyPath = join(traeHome, 'cli', 'history.jsonl');
  const submissionsPath = join(root, 'submissions.jsonl');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(rolloutDir, { recursive: true });
  writeFileSync(rolloutPath, '');
  writeFileSync(historyPath, '');
  writeFileSync(submissionsPath, '');

  // The worker execs cliPathOverride directly; bake the tape wiring in.
  const fakeTraex = join(root, 'traex');
  const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  writeFileSync(fakeTraex, [
    '#!/bin/sh',
    `export TRAEX_TAPE=${q(TAPE)}`,
    `export TRAEX_TAPE_ROLLOUT=${q(rolloutPath)}`,
    `export TRAEX_TAPE_HISTORY=${q(historyPath)}`,
    `export TRAEX_TAPE_SUBMISSIONS=${q(submissionsPath)}`,
    `export TRAEX_TAPE_TERMINAL_DELAY_MS=${terminalDelayMs}`,
    `exec node ${q(PLAYER)} "$@"`,
    '',
  ].join('\n'));
  chmodSync(fakeTraex, 0o755);

  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const workerBinary = process.env.BOTMUX_TEST_WORKER_BINARY;
  const spawnOptions: SpawnOptions = {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      TRAE_HOME: traeHome,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: botmuxSessionId,
      LARK_APP_ID: 'app_test',
      LARK_APP_SECRET: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  };
  const child = workerBinary
    ? spawn(workerBinary, ['__worker'], spawnOptions)
    : spawnNodeTsScript(resolve('src/worker.ts'), [], spawnOptions);
  children.add(child);
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.send({
    type: 'init',
    sessionId: botmuxSessionId,
    chatId: 'oc_test',
    rootMessageId: 'om_root',
    workingDir: dataDir,
    cliId: 'traex',
    cliPathOverride: fakeTraex,
    cliSessionId: tape.nativeSessionId,
    resume: true,
    backendType: 'pty',
    prompt: '',
    larkAppId: 'app_test',
    larkAppSecret: 'secret',
  } satisfies DaemonToWorker);
  return { child, messages, logs, submissionsPath };
}

describe('TraeX real-tape replay', () => {
  it.each([
    ['recorded timing', 0],
    // Field ordering: the composer redraws and goes quiet, the rollout
    // terminal lands seconds later (slow fs.watch / poll under load).
    ['terminal after the composer went quiet', 4_000],
  ] as const)('delivers consecutive durable IM turns with %s', async (_label, terminalDelayMs) => {
    const { child, messages, logs, submissionsPath } = startReplayWorker(terminalDelayMs);
    await waitFor(child, () => messages.some(m => m.type === 'prompt_ready'), logs, 'initial prompt readiness');

    const terminalFor = (turnId: string) => messages.some(m => m.type === 'turn_terminal' && m.turnId === turnId);

    child.send({ type: 'message', content: 'tape turn one', turnId: 'om_one', dispatchAttempt: 1 } satisfies DaemonToWorker);
    await waitFor(child, () => readSubmissions(submissionsPath).some(t => t.startsWith('tape turn one')), logs, 'first submit');
    await waitFor(child, () => terminalFor('om_one'), logs, 'first turn terminal');

    child.send({ type: 'message', content: 'tape turn two', turnId: 'om_two', dispatchAttempt: 1 } satisfies DaemonToWorker);
    await waitFor(child, () => readSubmissions(submissionsPath).some(t => t.includes('tape turn two')), logs, 'second submit');
    await waitFor(child, () => terminalFor('om_two'), logs, 'second turn terminal');

    expect(readSubmissions(submissionsPath)).toHaveLength(2);
    expect(logs.join('')).not.toContain('Quarantined input delivery');
  }, 90_000);
});
