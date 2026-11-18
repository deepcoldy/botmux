import { type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { fingerprintPromptText, prefixOf } from '../src/services/prompt-context-store.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { loadWorkerMessageHandler } from './helpers/worker-function-harness.js';

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
  it('flips a ready worker to working without the previous turn id', async () => {
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

    const submissionMessageIndex = harness.messages.length;

    // 3. Send prompt_submitted while isPromptReady is true
    harness.child.send({ type: 'prompt_submitted' } satisfies DaemonToWorker);

    // 4. Worker should publish working state with clearTurnId (turnId: undefined)
    await waitFor(
      harness,
      () => harness.messages.slice(submissionMessageIndex).some(
        m => m.type === 'screen_update' && m.status === 'working' && m.turnId === undefined,
      ),
      'worker to publish working state with clearTurnId',
    );
  });

  it.each([true, false])('publishes working only for a ready edge (initially ready: %s)', async initiallyReady => {
    // The live worker's periodic screen sampler can publish independently of
    // this handler. Exercise the actual IPC case without that timer so a
    // repeated submission cannot hide among unrelated screen updates.
    const reset = vi.fn();
    const publishScreenStatus = vi.fn();
    const scope = {
      isPromptReady: initiallyReady,
      promptReadinessRevision: 0,
      idleDetector: { reset },
      publishScreenStatus,
      log: vi.fn(),
      writtenInputs: { takeSubmitted: vi.fn() },
      send: vi.fn(),
    };
    const handle = loadWorkerMessageHandler('prompt_submitted', scope);
    const submission = { type: 'prompt_submitted' } satisfies DaemonToWorker;

    await handle(submission);
    expect(scope.isPromptReady).toBe(false);
    if (initiallyReady) {
      expect(reset).toHaveBeenCalledTimes(1);
      expect(publishScreenStatus).toHaveBeenCalledExactlyOnceWith('working', { force: true, clearTurnId: true });
    } else {
      expect(reset).not.toHaveBeenCalled();
      expect(publishScreenStatus).not.toHaveBeenCalled();
    }

    reset.mockClear();
    publishScreenStatus.mockClear();
    await handle(submission);
    expect(scope.isPromptReady).toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(publishScreenStatus).not.toHaveBeenCalled();
  });

  it('reports the written turn a submitted prompt was, and nothing for another prompt', async () => {
    const harness = startWorker();
    await waitFor(harness, () => harness.messages.some(m => m.type === 'ready'), 'worker readiness');
    harness.child.send({ type: 'session_ready', source: 'startup' } satisfies DaemonToWorker);
    await waitFor(harness, () => harness.messages.some(m => m.type === 'prompt_ready'), 'worker to emit prompt_ready');

    const turnId = 'workflow-event:run-1:3';
    const content = 'checkpoint after node a: review its result';
    harness.child.send({ type: 'message', content, turnId } satisfies DaemonToWorker);
    await waitFor(
      harness,
      () => harness.messages.some(m => m.type === 'turn_execution_started' && m.turnId === turnId),
      'the turn to be written',
    );
    const submittedFor = () => harness.messages.filter(m => m.type === 'prompt_submitted_input');

    const other = 'what is the status?';
    harness.child.send({ type: 'prompt_submitted', fingerprint: fingerprintPromptText(other), prefix: prefixOf(other) } satisfies DaemonToWorker);
    await delay(300);
    expect(submittedFor()).toEqual([]);

    harness.child.send({ type: 'prompt_submitted', fingerprint: fingerprintPromptText(content), prefix: prefixOf(content) } satisfies DaemonToWorker);
    await waitFor(harness, () => submittedFor().length > 0, 'the submitted turn to be reported');
    harness.child.send({ type: 'prompt_submitted', fingerprint: fingerprintPromptText(content), prefix: prefixOf(content) } satisfies DaemonToWorker);
    await delay(300);
    expect(submittedFor()).toEqual([{ type: 'prompt_submitted_input', turnId }]);
  });
});
