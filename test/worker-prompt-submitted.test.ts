import { type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

interface Harness {
  child: ChildProcess;
  logs: string[];
  messages: WorkerToDaemon[];
  root: string;
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
  timeoutMs = 15_000,
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

function startWorker(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'botmux-prompt-submitted-'));
  tempDirs.add(root);

  // A CLI that emits prompt marker '❯ ' and stays alive
  const fakeCli = join(root, 'fake-dsh-tui');
  writeFileSync(fakeCli, '#!/bin/sh\nprintf "❯ "\nexec sleep 300\n');
  chmodSync(fakeCli, 0o755);

  const sessionId = `promptsub${Date.now().toString(36)}${process.pid.toString(36)}`;
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];

  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      SESSION_DATA_DIR: root,
      BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: 'app_prompt_sub',
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
    chatId: 'oc_prompt_sub',
    rootMessageId: 'om_prompt_sub',
    workingDir: root,
    cliId: 'dsh-tui',
    cliPathOverride: fakeCli,
    backendType: 'pty',
    prompt: '',
    turnId: 'turn-init',
    larkAppId: 'app_prompt_sub',
    larkAppSecret: 'secret',
  } satisfies DaemonToWorker);

  return { child, logs, messages, root };
}

describe('worker prompt_submitted handler', () => {
  it('flips ready worker to working with clearTurnId, and no-ops when not ready', async () => {
    const harness = startWorker();

    // 1. Wait until worker finishes initialization and announces ready
    await waitFor(
      harness,
      () => harness.messages.some(m => m.type === 'ready'),
      'worker readiness',
    );

    // Release startup ready gate
    harness.child.send({ type: 'session_ready', source: 'startup' } satisfies DaemonToWorker);

    // 2. Wait until worker becomes prompt_ready
    await waitFor(
      harness,
      () => harness.messages.some(m => m.type === 'prompt_ready'),
      'worker to emit prompt_ready',
    );

    const initialScreenUpdates = harness.messages.filter(m => m.type === 'screen_update');

    // 3. Send prompt_submitted while isPromptReady is true
    harness.child.send({ type: 'prompt_submitted' } satisfies DaemonToWorker);

    // 4. Worker should publish working state with clearTurnId (turnId: undefined)
    await waitFor(
      harness,
      () => harness.messages.slice(initialScreenUpdates.length).some(
        m => m.type === 'screen_update' && m.status === 'working' && m.turnId === undefined,
      ),
      'worker to publish working state with clearTurnId',
    );

    const screenUpdateCountAfterFirst = harness.messages.filter(m => m.type === 'screen_update').length;

    // 5. Send second prompt_submitted while worker is now in working state (not ready)
    harness.child.send({ type: 'prompt_submitted' } satisfies DaemonToWorker);
    await delay(300);

    // Should be no-op: no new screen_update emitted
    const screenUpdateCountAfterSecond = harness.messages.filter(m => m.type === 'screen_update').length;
    expect(screenUpdateCountAfterSecond).toBe(screenUpdateCountAfterFirst);
  });
});
