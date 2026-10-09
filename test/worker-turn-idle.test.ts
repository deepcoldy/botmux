/**
 * Worker side of the structured turn-idle channel.
 *
 * A `turn_idle` IPC may only settle the turn THIS worker believes is in flight:
 * accepting a stale/foreign report would mark a busy CLI idle and flush queued
 * input into it. These cases drive a real worker (fake CLI, PTY backend) through
 * the whole path — IPC → fence → idleDetector.fireIdle() → prompt_ready — and
 * pin the rejections as observable behaviour, not as source text.
 */
import { type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const TURN_ID = 'turn-idle-under-test';
const STALE_TURN_ID = 'turn-idle-someone-else';

interface Harness {
  child: ChildProcess;
  logs: string[];
  messages: WorkerToDaemon[];
}

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function delay(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

async function waitFor(
  harness: Harness,
  predicate: () => boolean,
  description: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (harness.child.exitCode !== null || harness.child.signalCode !== null) {
      throw new Error(`worker exited before ${description}\n${harness.logs.join('')}`);
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${description}\n${harness.logs.join('')}`);
}

function readyCount(harness: Harness): number {
  return harness.messages.filter(message => message.type === 'prompt_ready').length;
}

function startWorker(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'botmux-turn-idle-'));
  tempDirs.add(root);
  // A CLI that boots, renders nothing and stays alive: dsh-tui's readyPattern
  // (`❯`) is therefore never seen, so the PTY-quiescence IdleDetector can never
  // fire on its own — every prompt_ready in this file must come from the
  // structured channel under test.
  const fakeCli = join(root, 'fake-dsh-tui');
  writeFileSync(fakeCli, '#!/bin/sh\nexec sleep 300\n');
  chmodSync(fakeCli, 0o755);

  const sessionId = `turnidle${Date.now().toString(36)}${process.pid.toString(36)}`;
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  const child = spawnTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      SESSION_DATA_DIR: root,
      BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: 'app_turn_idle',
      LARK_APP_SECRET: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.send({
    type: 'init',
    sessionId,
    chatId: 'oc_turn_idle',
    rootMessageId: 'om_turn_idle',
    workingDir: root,
    cliId: 'dsh-tui',
    cliPathOverride: fakeCli,
    backendType: 'pty',
    prompt: '',
    turnId: 'turn-idle-init',
    larkAppId: 'app_turn_idle',
    larkAppSecret: 'secret',
  } satisfies DaemonToWorker);
  return { child, logs, messages };
}

/** Boot the worker, release the ready gate, then write one real turn so the
 *  worker is genuinely waiting on `TURN_ID` (isPromptReady=false). */
async function startWorkerWaitingOnTurn(dispatchAttempt?: number): Promise<Harness> {
  const harness = startWorker();
  await waitFor(
    harness,
    () => harness.messages.some(message => message.type === 'ready'),
    'worker readiness',
  );
  harness.child.send({ type: 'session_ready', source: 'startup' } satisfies DaemonToWorker);
  // dsh-tui is not Claude-family, so the gate release marks the CLI ready and
  // publishes prompt_ready (after its PTY-quiescence settle). Drain that edge
  // BEFORE the probe turn, so the only prompt_ready this test can observe later
  // is the structured one.
  await waitFor(
    harness,
    () => readyCount(harness) > 0,
    'ready-gate release to publish its own prompt_ready',
  );
  harness.child.send({
    type: 'message',
    content: 'structured turn idle probe',
    turnId: TURN_ID,
    ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
  } satisfies DaemonToWorker);
  await waitFor(
    harness,
    () => harness.messages.some(
      message => message.type === 'managed_turn_origin'
        && message.turnId === TURN_ID
        && message.dispatchAttempt === dispatchAttempt,
    ),
    'the worker to publish the probe turn as its active turn',
  );
  return harness;
}

/** Assert the worker produces NO ready edge on its own in the current state, so
 *  a later prompt_ready can only have come from the structured report. The fake
 *  CLI renders nothing, so the quiescence detector has no way to fire. */
async function expectNoAutonomousReadyEdge(harness: Harness, before: number): Promise<void> {
  await delay(1200);
  expect(readyCount(harness)).toBe(before);
}

describe('worker turn-idle channel', () => {
  it('settles the matching turn (IPC → fireIdle → prompt_ready)', async () => {
    const harness = await startWorkerWaitingOnTurn();
    const before = readyCount(harness);
    await expectNoAutonomousReadyEdge(harness, before);

    harness.child.send({
      type: 'turn_idle',
      turnId: TURN_ID,
      seq: 1,
      pid: process.pid,
    } satisfies DaemonToWorker);

    await waitFor(
      harness,
      () => readyCount(harness) > before,
      'prompt_ready from the structured turn-idle report',
    );
  }, 60_000);

  it('rejects a report for a different turn instead of settling the active one', async () => {
    const harness = await startWorkerWaitingOnTurn();
    const before = readyCount(harness);

    harness.child.send({
      type: 'turn_idle',
      turnId: STALE_TURN_ID,
      seq: 1,
    } satisfies DaemonToWorker);
    await delay(1500);
    expect(readyCount(harness)).toBe(before);
    expect(harness.logs.join('')).toContain('Ignoring turn-idle report (turn-mismatch)');

    // The real turn still settles afterwards — a rejected report never strands it.
    harness.child.send({ type: 'turn_idle', turnId: TURN_ID, seq: 2 } satisfies DaemonToWorker);
    await waitFor(
      harness,
      () => readyCount(harness) > before,
      'prompt_ready for the real turn after the stale report was dropped',
    );
  }, 60_000);

  it('rejects a report without a turn identity', async () => {
    const harness = await startWorkerWaitingOnTurn();
    const before = readyCount(harness);

    harness.child.send({ type: 'turn_idle', seq: 1 } satisfies DaemonToWorker);
    await delay(1500);
    expect(readyCount(harness)).toBe(before);
    expect(harness.logs.join('')).toContain('Ignoring turn-idle report (missing-turn)');
  }, 60_000);

  it('rejects a report whose dispatch attempt differs from the active turn', async () => {
    const harness = await startWorkerWaitingOnTurn(7);
    const before = readyCount(harness);

    harness.child.send({
      type: 'turn_idle',
      turnId: TURN_ID,
      dispatchAttempt: 6,
      seq: 1,
    } satisfies DaemonToWorker);
    await delay(1500);
    expect(readyCount(harness)).toBe(before);
    expect(harness.logs.join('')).toContain('Ignoring turn-idle report (attempt-mismatch)');
  }, 60_000);
});
