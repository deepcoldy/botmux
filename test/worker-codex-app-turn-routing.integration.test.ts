import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();
const tmuxSessions = new Set<string>();

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolvePromise => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
    if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
    else child.kill('SIGTERM');
  });
}

async function hardKillWorkerOnly(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolvePromise => {
    child.once('exit', () => resolvePromise());
    child.kill('SIGKILL');
  });
}

function waitForChildExit(
  child: ChildProcess,
  logs: string[],
  timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      rejectPromise(new Error(`worker did not exit after CLI crash\n${logs.join('')}`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    };
    child.once('exit', onExit);
  });
}

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  children.clear();
  for (const name of tmuxSessions) {
    try { execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' }); } catch { /* gone */ }
  }
  tmuxSessions.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function replacementSessionId(label: string): string {
  return `${randomBytes(4).toString('hex')}-${label}-${process.pid}-${Date.now()}`;
}

function spawnWorker(
  root: string,
  sessionId: string,
  fakeCodex: string,
  requestLog: string,
  behavior: string,
  logs: string[],
  messages: WorkerToDaemon[],
  onMessage?: (message: WorkerToDaemon, child: ChildProcess) => void,
): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      NODE_ENV: 'test',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=tsx'].filter(Boolean).join(' '),
      // tmux launch scripts intentionally sanitize NODE_OPTIONS, so use the
      // built JS runner rather than relying on the parent's tsx loader.
      BOTMUX_TEST_CODEX_APP_RUNNER_PATH: resolve('dist/codex-app-runner.js'),
      SESSION_DATA_DIR: root,
      BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: 'app_worker_replacement',
      LARK_APP_SECRET: 'secret',
      FAKE_CODEX_LOG: requestLog,
      FAKE_CODEX_VERSION: '0.136.0',
      FAKE_CODEX_BEHAVIOR: behavior,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.on('message', raw => {
    const message = raw as WorkerToDaemon;
    messages.push(message);
    if (message.type === 'error') logs.push(`[worker-ipc-error] ${message.message}\n`);
    if (message.type === 'final_output') {
      logs.push(`[worker-ipc-final] turn=${message.turnId} dispatch=${message.codexAppSettlement?.dispatchId ?? '-'} content=${JSON.stringify(message.content)}\n`);
    }
    onMessage?.(message, child);
  });
  return child;
}

function replacementInit(
  sessionId: string,
  fakeCodex: string,
  prompt: string,
  extra: Partial<Extract<DaemonToWorker, { type: 'init' }>> = {},
): Extract<DaemonToWorker, { type: 'init' }> {
  return {
    type: 'init',
    sessionId,
    chatId: 'oc_worker_replacement',
    rootMessageId: 'om_worker_replacement_root',
    workingDir: resolve('.'),
    cliId: 'codex-app',
    cliPathOverride: fakeCodex,
    backendType: 'tmux',
    prompt,
    larkAppId: 'app_worker_replacement',
    larkAppSecret: 'secret',
    ...extra,
  };
}

function waitFor(
  child: ChildProcess,
  logs: string[],
  predicate: () => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const poll = setInterval(() => {
      if (!predicate()) return;
      cleanup();
      resolvePromise();
    }, 20);
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`worker routing timeout\n${logs.join('')}`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      rejectPromise(new Error(`worker exited early (${code ?? signal})\n${logs.join('')}`));
    };
    const cleanup = () => {
      clearInterval(poll);
      clearTimeout(timer);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

function readRequests(path: string): Array<Record<string, any>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

describe('Codex App worker queued-turn attribution', () => {
  it('routes and ACKs turn N before N+1 after both inputs were written in one flush', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-codex-routing-'));
    tempDirs.add(root);
    const fakeCodex = join(root, 'fake-codex');
    const requestLog = join(root, 'requests.jsonl');
    copyFileSync(resolve('test/fixtures/fake-codex-app-server.mjs'), fakeCodex);
    chmodSync(fakeCodex, 0o755);

    const sessionId = `codex-routing-${process.pid}-${Date.now()}`;
    const logs: string[] = [];
    const messages: WorkerToDaemon[] = [];
    const nodeOptions = [process.env.NODE_OPTIONS, '--import=tsx'].filter(Boolean).join(' ');
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/worker.ts')], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        NODE_ENV: 'test',
        NODE_OPTIONS: nodeOptions,
        BOTMUX_TEST_CODEX_APP_RUNNER_PATH: resolve('src/codex-app-runner.ts'),
        SESSION_DATA_DIR: root,
        BOTMUX_SESSION_ID: sessionId,
        LARK_APP_ID: 'app_worker_routing',
        LARK_APP_SECRET: 'secret',
        FAKE_CODEX_LOG: requestLog,
        FAKE_CODEX_VERSION: '0.136.0',
        // Hold turn 1 open so flushPending deterministically writes turn 2 and
        // overwrites its legacy singleton globals before final 1 arrives.
        FAKE_CODEX_BEHAVIOR: 'delayed-first',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    let followUpSent = false;
    child.on('message', raw => {
      const message = raw as WorkerToDaemon;
      messages.push(message);
      if (message.type === 'error') logs.push(`[worker-ipc-error] ${message.message}\n`);
      // `ready` means the adapter/backend are installed, while Codex App's
      // authenticated runner still has to initialize and render its first ›.
      // Queue turn 2 in that deterministic gap.
      if (message.type === 'ready' && !followUpSent) {
        followUpSent = true;
        child.send(followUp);
      }
    });

    const init: DaemonToWorker = {
      type: 'init',
      sessionId,
      chatId: 'oc_worker_routing',
      rootMessageId: 'om_worker_routing_root',
      // Keep Node package resolution anchored at the checkout so the nested
      // source runner can load the tsx hook supplied through NODE_OPTIONS.
      workingDir: resolve('.'),
      cliId: 'codex-app',
      cliPathOverride: fakeCodex,
      backendType: 'pty',
      prompt: '<user_message>turn one legacy</user_message>',
      promptCodexAppInput: {
        text: 'turn one',
        clientUserMessageId: 'om_worker_turn_1',
      },
      larkAppId: 'app_worker_routing',
      larkAppSecret: 'secret',
      turnId: 'om_worker_turn_1',
    };
    const followUp: DaemonToWorker = {
      type: 'message',
      content: '<user_message>turn two legacy</user_message>',
      codexAppInput: {
        text: 'turn two',
        clientUserMessageId: 'om_worker_turn_2',
      },
      turnId: 'om_worker_turn_2',
    };

    try {
      child.send(init);
      await waitFor(child, logs, () => (
        messages.filter(message => message.type === 'final_output').length >= 2
        && messages.filter(message => message.type === 'turn_terminal').length >= 2
      ));

      const finals = messages.filter(
        (message): message is Extract<WorkerToDaemon, { type: 'final_output' }> => message.type === 'final_output',
      );
      expect(finals.map(final => ({
        turnId: final.turnId,
        content: final.content,
        dispatchAttempt: final.dispatchAttempt,
      }))).toEqual([
        { turnId: 'om_worker_turn_1', content: 'fake answer 1', dispatchAttempt: undefined },
        { turnId: 'om_worker_turn_2', content: 'fake answer 2', dispatchAttempt: undefined },
      ]);
      const terminals = messages.filter(
        (message): message is Extract<WorkerToDaemon, { type: 'turn_terminal' }> => message.type === 'turn_terminal',
      );
      expect(terminals.map(terminal => ({
        turnId: terminal.turnId,
        status: terminal.status,
      }))).toEqual([
        { turnId: 'om_worker_turn_1', status: 'completed' },
        { turnId: 'om_worker_turn_2', status: 'completed' },
      ]);

      const turnStarts = readRequests(requestLog).filter(request => request.method === 'turn/start');
      expect(turnStarts.map(request => request.params.clientUserMessageId)).toEqual([
        'om_worker_turn_1',
        'om_worker_turn_2',
      ]);
      const joinedLogs = logs.join('');
      const secondWrite = joinedLogs.indexOf('turn two legacy');
      const firstFinalMap = joinedLogs.indexOf('mapped to botmux turn om_worker_tu');
      expect(secondWrite).toBeGreaterThan(-1);
      expect(firstFinalMap).toBeGreaterThan(secondWrite);
      expect(joinedLogs).not.toContain('rejected final marker');
    } finally {
      await stopChild(child);
    }
  }, 25_000);
});

describe('Codex App worker replacement durable handoff', () => {
  it('turns a real tmux runner exit with prepared durable ownership into a Node worker exit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-codex-cli-exit-'));
    tempDirs.add(root);
    const fakeCodex = join(root, 'fake-codex');
    const requestLog = join(root, 'requests.jsonl');
    copyFileSync(resolve('test/fixtures/fake-codex-app-server.mjs'), fakeCodex);
    chmodSync(fakeCodex, 0o755);

    const sessionId = replacementSessionId('cli-exit');
    const tmuxSession = `bmx-${sessionId.slice(0, 8)}`;
    tmuxSessions.add(tmuxSession);
    const entry = {
      dispatchId: 'dispatch-cli-exit-1',
      turnId: 'turn-cli-exit-1',
      dispatchAttempt: 17,
      content: '<user_message>crash runner after prepared</user_message>',
      codexAppInput: { text: 'crash runner after prepared', clientUserMessageId: 'turn-cli-exit-1' },
    };

    const logs: string[] = [];
    const messages: WorkerToDaemon[] = [];
    const prematureAdmissionSignals: WorkerToDaemon[] = [];
    const worker = spawnWorker(
      root, sessionId, fakeCodex, requestLog, 'success', logs, messages,
      (message, child) => {
        if (message.type === 'codex_app_dispatch_transition') {
          child.send({
            type: 'codex_app_dispatch_persisted',
            requestId: message.requestId,
            ok: true,
          } satisfies DaemonToWorker);
        }
        // Withhold settlement durability so the exact dispatch remains
        // prepared when the runner process exits.
        if (message.type === 'claude_exit'
            || (message.type === 'turn_terminal' && message.status === 'ambiguous')) {
          // Either edge would let a durable receiver consider N complete and
          // admit N+1 before the worker-exit recovery fence is armed.
          prematureAdmissionSignals.push(message);
        }
      },
    );
    worker.send(replacementInit(sessionId, fakeCodex, entry.content, {
      env: { FAKE_CODEX_LOG: requestLog, FAKE_CODEX_BEHAVIOR: 'success' },
      turnId: entry.turnId,
      dispatchAttempt: entry.dispatchAttempt,
      codexAppDispatchId: entry.dispatchId,
      promptCodexAppInput: entry.codexAppInput,
    }));

    await waitFor(worker, logs, () => messages.some(message =>
      message.type === 'final_output'
      && message.codexAppSettlement?.dispatchId === entry.dispatchId));

    const workerExit = waitForChildExit(worker, logs);
    // Kill the actual runner pane while leaving the Node worker alive. This
    // exercises backend.onExit's direct prepared-generation fail-close path,
    // unlike SIGKILLing the worker process as the replacement tests below do.
    execFileSync('tmux', ['send-keys', '-t', tmuxSession, 'C-c'], { stdio: 'ignore' });
    const exited = await workerExit;

    expect(prematureAdmissionSignals).toEqual([]);
    expect(exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('prepared dispatch'),
      turnId: entry.turnId,
      dispatchAttempt: entry.dispatchAttempt,
    }));
    expect(logs.join('')).toContain('worker replacement requires exact recovery');
    expect(readRequests(requestLog).filter(request => request.method === 'turn/start'))
      .toHaveLength(1);
  }, 35_000);

  it('reattaches a surviving tmux runner and settles its unacked final with an empty replacement prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-codex-replace-'));
    tempDirs.add(root);
    const fakeCodex = join(root, 'fake-codex');
    const requestLog = join(root, 'requests.jsonl');
    copyFileSync(resolve('test/fixtures/fake-codex-app-server.mjs'), fakeCodex);
    chmodSync(fakeCodex, 0o755);

    const sessionId = replacementSessionId('replay');
    tmuxSessions.add(`bmx-${sessionId.slice(0, 8)}`);
    const entry = {
      dispatchId: 'dispatch-replay-1',
      turnId: 'turn-replay-1',
      state: 'prepared' as const,
      content: '<user_message>survive worker kill</user_message>',
      codexAppInput: { text: 'survive worker kill', clientUserMessageId: 'turn-replay-1' },
    };

    const logs1: string[] = [];
    const messages1: WorkerToDaemon[] = [];
    const worker1 = spawnWorker(
      root, sessionId, fakeCodex, requestLog, 'success', logs1, messages1,
      (message, child) => {
        if (message.type === 'codex_app_dispatch_transition') {
          child.send({
            type: 'codex_app_dispatch_persisted',
            requestId: message.requestId,
            ok: true,
          } satisfies DaemonToWorker);
        }
        // Intentionally withhold the final settlement ACK. The runner keeps
        // final-end unacked while this worker is SIGKILLed.
      },
    );
    worker1.send(replacementInit(sessionId, fakeCodex, entry.content, {
      env: { FAKE_CODEX_LOG: requestLog, FAKE_CODEX_BEHAVIOR: 'success' },
      turnId: entry.turnId,
      codexAppDispatchId: entry.dispatchId,
      promptCodexAppInput: entry.codexAppInput,
    }));

    await waitFor(worker1, logs1, () => messages1.some(message =>
      message.type === 'final_output'
      && message.codexAppSettlement?.dispatchId === entry.dispatchId));
    await hardKillWorkerOnly(worker1);

    const logs2: string[] = [];
    const messages2: WorkerToDaemon[] = [];
    const worker2 = spawnWorker(
      root, sessionId, fakeCodex, requestLog, 'success', logs2, messages2,
      (message, child) => {
        if (message.type === 'codex_app_dispatch_transition') {
          child.send({
            type: 'codex_app_dispatch_persisted',
            requestId: message.requestId,
            ok: true,
          } satisfies DaemonToWorker);
        }
        if (message.type === 'final_output' && message.codexAppSettlement) {
          child.send({
            type: 'codex_app_dispatch_persisted',
            requestId: message.codexAppSettlement.requestId,
            ok: true,
          } satisfies DaemonToWorker);
        }
      },
    );
    worker2.send(replacementInit(sessionId, fakeCodex, '', {
      env: { FAKE_CODEX_LOG: requestLog, FAKE_CODEX_BEHAVIOR: 'success' },
      resume: true,
      cliSessionId: 'thread-fake',
      codexAppRecoveredDispatches: [entry],
    }));

    await waitFor(worker2, logs2, () => messages2.some(message =>
      message.type === 'turn_terminal'
      && message.turnId === entry.turnId
      && message.status === 'completed'));

    const replayed = messages2.find((message): message is Extract<WorkerToDaemon, { type: 'final_output' }> =>
      message.type === 'final_output' && message.codexAppSettlement?.dispatchId === entry.dispatchId);
    expect(replayed).toMatchObject({
      sessionId,
      turnId: entry.turnId,
      content: 'fake answer 1',
    });
    expect(logs2.join('')).toContain('warm reattach');
    expect(readRequests(requestLog).filter(request => request.method === 'turn/start')).toHaveLength(1);
  }, 35_000);

  it('holds N+1 behind replayed empty N until daemon durability ACKs final-end', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-codex-empty-replace-'));
    tempDirs.add(root);
    const fakeCodex = join(root, 'fake-codex');
    const requestLog = join(root, 'requests.jsonl');
    copyFileSync(resolve('test/fixtures/fake-codex-app-server.mjs'), fakeCodex);
    chmodSync(fakeCodex, 0o755);

    const sessionId = replacementSessionId('empty');
    tmuxSessions.add(`bmx-${sessionId.slice(0, 8)}`);
    const first = {
      dispatchId: 'dispatch-empty-1',
      turnId: 'turn-empty-1',
      state: 'prepared' as const,
      content: '<user_message>empty first</user_message>',
      codexAppInput: { text: 'empty first', clientUserMessageId: 'turn-empty-1' },
    };
    const second = {
      dispatchId: 'dispatch-empty-2',
      turnId: 'turn-empty-2',
      content: '<user_message>second after empty</user_message>',
      codexAppInput: { text: 'second after empty', clientUserMessageId: 'turn-empty-2' },
    };

    const logs1: string[] = [];
    const messages1: WorkerToDaemon[] = [];
    const worker1 = spawnWorker(
      root, sessionId, fakeCodex, requestLog, 'empty-first', logs1, messages1,
      (message, child) => {
        if (message.type === 'codex_app_dispatch_transition') {
          child.send({
            type: 'codex_app_dispatch_persisted',
            requestId: message.requestId,
            ok: true,
          } satisfies DaemonToWorker);
        }
      },
    );
    worker1.send(replacementInit(sessionId, fakeCodex, first.content, {
      env: { FAKE_CODEX_LOG: requestLog, FAKE_CODEX_BEHAVIOR: 'empty-first' },
      turnId: first.turnId,
      codexAppDispatchId: first.dispatchId,
      promptCodexAppInput: first.codexAppInput,
    }));
    await waitFor(worker1, logs1, () => messages1.some(message =>
      message.type === 'final_output'
      && message.codexAppSettlement?.dispatchId === first.dispatchId
      && message.content === ''));
    await hardKillWorkerOnly(worker1);

    const logs2: string[] = [];
    const messages2: WorkerToDaemon[] = [];
    let secondSent = false;
    let firstAcked = false;
    let secondSubmittedBeforeFirstAck = false;
    const order: string[] = [];
    const worker2 = spawnWorker(
      root, sessionId, fakeCodex, requestLog, 'empty-first', logs2, messages2,
      (message, child) => {
        if (message.type === 'ready' && !secondSent) {
          secondSent = true;
          child.send({
            type: 'message',
            content: second.content,
            codexAppInput: second.codexAppInput,
            turnId: second.turnId,
            codexAppDispatchId: second.dispatchId,
          } satisfies DaemonToWorker);
        }
        if (message.type === 'codex_app_dispatch_transition') {
          if (message.entries[0]?.dispatchId === second.dispatchId) {
            secondSubmittedBeforeFirstAck = !firstAcked;
            order.push('submit-second');
          }
          child.send({
            type: 'codex_app_dispatch_persisted',
            requestId: message.requestId,
            ok: true,
          } satisfies DaemonToWorker);
        }
        if (message.type === 'final_output' && message.codexAppSettlement) {
          if (message.codexAppSettlement.dispatchId === first.dispatchId) {
            order.push('final-first');
            setTimeout(() => {
              firstAcked = true;
              order.push('ack-first');
              if (child.connected) child.send({
                type: 'codex_app_dispatch_persisted',
                requestId: message.codexAppSettlement!.requestId,
                ok: true,
              } satisfies DaemonToWorker);
            }, 250);
          } else if (message.codexAppSettlement.dispatchId === second.dispatchId) {
            order.push('final-second');
            child.send({
              type: 'codex_app_dispatch_persisted',
              requestId: message.codexAppSettlement.requestId,
              ok: true,
            } satisfies DaemonToWorker);
          }
        }
      },
    );
    worker2.send(replacementInit(sessionId, fakeCodex, '', {
      env: { FAKE_CODEX_LOG: requestLog, FAKE_CODEX_BEHAVIOR: 'empty-first' },
      resume: true,
      cliSessionId: 'thread-fake',
      codexAppRecoveredDispatches: [first],
    }));

    await waitFor(worker2, logs2, () => messages2.filter(message =>
      message.type === 'turn_terminal'
      && (message.turnId === first.turnId || message.turnId === second.turnId)
      && message.status === 'completed').length === 2, 30_000);

    const finals = messages2.filter(
      (message): message is Extract<WorkerToDaemon, { type: 'final_output' }> =>
        message.type === 'final_output' && !!message.codexAppSettlement,
    );
    expect(finals.map(final => ({ turnId: final.turnId, content: final.content }))).toEqual([
      { turnId: first.turnId, content: '' },
      { turnId: second.turnId, content: 'fake answer 2' },
    ]);
    expect(secondSubmittedBeforeFirstAck).toBe(false);
    expect(order).toEqual(['final-first', 'ack-first', 'submit-second', 'final-second']);
    expect(readRequests(requestLog).filter(request => request.method === 'turn/start'))
      .toHaveLength(2);
  }, 40_000);
});
