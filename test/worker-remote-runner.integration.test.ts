import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { spawnTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, describeFailure: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 50));
  }
  throw new Error(describeFailure());
}

async function readTerminalSeed(
  port: number,
  viewToken: string,
  resize?: { cols: number; rows: number },
): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const frames: string[] = [];
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/?viewToken=${encodeURIComponent(viewToken)}`,
    );
    const timer = setTimeout(() => {
      socket.close();
      rejectPromise(new Error(`remote runner terminal seed timed out: ${frames.join('')}`));
    }, 5_000);
    socket.on('open', () => {
      if (resize) socket.send(JSON.stringify({ type: 'resize', ...resize }));
    });
    socket.on('message', data => {
      frames.push(String(data));
      if (frames.join('').includes('REMOTE_TMUX_SCREEN_NEW')) {
        clearTimeout(timer);
        socket.close();
        resolvePromise(frames.join(''));
      }
    });
    socket.on('error', error => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

describe('remote runner worker wiring', () => {
  it('reattaches an active provider turn and emits its original terminal without replaying input', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-remote-runner-takeover-'));
    tempDirs.push(root);
    const commandsPath = join(root, 'commands.jsonl');
    const releaseRecoveredFinalPath = join(root, 'release-recovered-final');
    const provider = join(root, 'provider.mjs');
    writeFileSync(provider, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const protocol = 'botmux.remote-runner';
const version = 1;
const emit = event => process.stdout.write(JSON.stringify({ protocol, version, ...event }) + '\\n');
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(commandsPath)}, JSON.stringify(command) + '\\n');
  if (command.type === 'hello') {
    emit({
      type: 'hello', requestId: command.requestId, provider: 'takeover-provider',
      capabilities: ['start','resume','turn','cancel','detach','reattach','status','turn_recovery'],
    });
  } else if (command.type === 'resume') {
    const state = command.state;
    const ready = {
      protocol, version, type: 'ready', requestId: command.requestId, state,
      recoveredTurn: {
        turnId: 'om_turn_survived', generation: state.generation, startedAtMs: 1000,
        dispatchAttempt: 8,
        trustedCaller: {
          requestUserOpenId: 'ou_remote_user', requestLarkAppId: 'app_remote_takeover', senderType: 'user',
        },
      },
    };
    const progress = { protocol, version, type: 'progress', turnId: 'om_turn_survived', content: 'still running' };
    process.stdout.write(JSON.stringify(ready) + '\\n' + JSON.stringify(progress) + '\\n');
    const releaseTimer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(releaseRecoveredFinalPath)})) return;
      clearInterval(releaseTimer);
      emit({ type: 'final', turnId: 'om_turn_survived', content: 'TAKEOVER_OK', state });
    }, 10);
  } else if (command.type === 'turn') {
    emit({ type: 'status', requestId: command.requestId, status: 'busy' });
    emit({ type: 'final', turnId: command.turnId, content: 'FOLLOWUP_OK', state: command.state });
  } else if (command.type === 'cancel') {
    emit({ type: 'status', requestId: command.requestId, status: 'closed' });
  }
});
`);
    chmodSync(provider, 0o755);
    const dataDir = join(root, 'data');
    const botsPath = join(root, 'bots.json');
    writeFileSync(botsPath, JSON.stringify([{
      larkAppId: 'app_remote_takeover',
      larkAppSecret: 'secret',
      cliId: 'remote-runner',
      backendType: 'remote-runner',
      cliPathOverride: provider,
      remoteRunner: {
        expectedProvider: 'takeover-provider',
        requiredCapabilities: ['start','resume','turn','cancel','detach','reattach','status','turn_recovery'],
      },
    }]));
    const persistedState = {
      version: 1 as const,
      provider: 'takeover-provider',
      generation: 7,
      remoteSessionId: 'compute-7',
      agentThreadId: 'thread-stable',
    };

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: botsPath,
        BOTMUX_SESSION_ID: 'sid-remote-takeover',
        LARK_APP_ID: 'app_remote_takeover',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    child.stdout?.on('data', chunk => logs.push(String(chunk)));
    child.stderr?.on('data', chunk => logs.push(String(chunk)));
    child.on('message', raw => messages.push(raw as WorkerToDaemon));

    child.send({
      type: 'init',
      sessionId: 'sid-remote-takeover',
      chatId: 'oc_remote_takeover',
      rootMessageId: 'om_remote_takeover',
      workingDir: root,
      cliId: 'remote-runner',
      cliPathOverride: provider,
      backendType: 'remote-runner',
      backendConfig: {
        expectedProvider: 'takeover-provider',
        requiredCapabilities: ['start','resume','turn','cancel','detach','reattach','status','turn_recovery'],
      },
      remoteBackendState: persistedState,
      prompt: '',
      larkAppId: 'app_remote_takeover',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    // A takeover-triggering follow-up can reach the just-forked worker while
    // its async init is still resuming the provider-owned turn. It must remain
    // queued across the worker-ready edge until that recovered turn settles.
    child.send({
      type: 'message',
      content: 'follow up during takeover',
      turnId: 'om_turn_followup',
      dispatchAttempt: 9,
      durablePrimaryInbox: true,
      trustedCaller: {
        requestUserOpenId: 'ou_remote_user',
        requestLarkAppId: 'app_remote_takeover',
        senderType: 'user',
      },
    } satisfies DaemonToWorker);
    await waitFor(
      () => messages.some(message => message.type === 'ready')
        && messages.some(message => message.type === 'capture_identity'
          && message.turnId === 'om_turn_survived'),
      () => `remote runner takeover did not become ready\n${logs.join('')}\n${JSON.stringify(messages)}`,
    );
    // The worker's ordinary 15s first-prompt fallback used to re-arm readiness
    // and flush this queued successor into the still-active recovered turn.
    // Hold beyond that edge and prove the provider received no new turn.
    await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 16_000));
    expect(readFileSync(commandsPath, 'utf8')).not.toContain('"type":"turn"');
    expect(messages.some(message => message.type === 'prompt_ready')).toBe(false);
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'turn_input_committed',
      turnId: 'om_turn_survived',
      dispatchAttempt: 8,
      durablePrimaryInbox: true,
    }));

    writeFileSync(releaseRecoveredFinalPath, 'release\n');
    await waitFor(
      () => messages.some(message => message.type === 'turn_terminal'
        && message.turnId === 'om_turn_survived'
        && message.status === 'completed'),
      () => `remote runner takeover did not complete\n${logs.join('')}\n${JSON.stringify(messages)}`,
    );
    await waitFor(
      () => messages.some(message => message.type === 'turn_terminal'
        && message.turnId === 'om_turn_followup'
        && message.dispatchAttempt === 9
        && message.status === 'completed'),
      () => `follow-up after recovered turn did not complete\n${logs.join('')}\n${JSON.stringify(messages)}`,
    );
    const commands = readFileSync(commandsPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(commands.filter(command => command.type === 'turn')).toEqual([
      expect.objectContaining({
        turnId: 'om_turn_followup',
        dispatchAttempt: 9,
        content: 'follow up during takeover',
      }),
    ]);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'turn_input_committed',
        turnId: 'om_turn_followup',
        dispatchAttempt: 9,
        durablePrimaryInbox: true,
      }),
      expect.objectContaining({
        type: 'final_output',
        turnId: 'om_turn_survived',
        content: 'TAKEOVER_OK',
      }),
      expect.objectContaining({
        type: 'turn_terminal',
        turnId: 'om_turn_survived',
        status: 'completed',
      }),
    ]));
    expect(messages.some(message => message.type === 'error')).toBe(false);
  });

  it('passes persisted provider state and defers a durable refork ACK until provider submission', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-remote-runner-resume-'));
    tempDirs.push(root);
    const commandsPath = join(root, 'commands.jsonl');
    const releaseSubmitPath = join(root, 'release-submit');
    const provider = join(root, 'provider.mjs');
    writeFileSync(provider, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const protocol = 'botmux.remote-runner';
const version = 1;
const emit = event => process.stdout.write(JSON.stringify({ protocol, version, ...event }) + '\\n');
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(commandsPath)}, JSON.stringify(command) + '\\n');
  if (command.type === 'hello') {
    emit({
      type: 'hello', requestId: command.requestId, provider: 'resume-provider',
      capabilities: ['start','resume','turn','cancel','detach','reattach','status','provider_future_feature'],
    });
  } else if (command.type === 'resume') {
    emit({ type: 'ready', requestId: command.requestId, state: command.state });
  } else if (command.type === 'turn') {
    const submitTimer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(releaseSubmitPath)})) return;
      clearInterval(submitTimer);
      emit({ type: 'status', requestId: command.requestId, status: 'busy' });
      emit({ type: 'final', turnId: command.turnId, content: 'RESUMED_OK' });
    }, 10);
  } else if (command.type === 'cancel') {
    emit({ type: 'status', requestId: command.requestId, status: 'closed' });
  }
});
`);
    chmodSync(provider, 0o755);
    const dataDir = join(root, 'data');
    const botsPath = join(root, 'bots.json');
    writeFileSync(botsPath, JSON.stringify([{
      larkAppId: 'app_remote_resume',
      larkAppSecret: 'secret',
      cliId: 'remote-runner',
      backendType: 'remote-runner',
      cliPathOverride: provider,
      remoteRunner: { expectedProvider: 'resume-provider' },
    }]));
    const persistedState = {
      version: 1 as const,
      provider: 'resume-provider',
      generation: 7,
      remoteSessionId: 'compute-7',
      agentThreadId: 'thread-stable',
      providerState: { runtimeSubpath: 'sessions/seven' },
    };

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: botsPath,
        BOTMUX_SESSION_ID: 'sid-remote-resume',
        LARK_APP_ID: 'app_remote_resume',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    child.stdout?.on('data', chunk => logs.push(String(chunk)));
    child.stderr?.on('data', chunk => logs.push(String(chunk)));
    child.on('message', raw => messages.push(raw as WorkerToDaemon));

    child.send({
      type: 'init',
      sessionId: 'sid-remote-resume',
      chatId: 'oc_remote_resume',
      rootMessageId: 'om_remote_resume',
      workingDir: root,
      cliId: 'remote-runner',
      cliPathOverride: provider,
      backendType: 'remote-runner',
      backendConfig: { expectedProvider: 'resume-provider' },
      remoteBackendState: persistedState,
      prompt: 'resume this turn',
      turnId: 'om_turn_after_worker_restart',
      dispatchAttempt: 7,
      durablePrimaryInbox: true,
      larkAppId: 'app_remote_resume',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await waitFor(
      () => existsSync(commandsPath)
        && readFileSync(commandsPath, 'utf8').includes('"type":"turn"'),
      () => `remote runner did not receive the reforked turn\n${logs.join('')}\n${JSON.stringify(messages)}`,
    );
    expect(messages.some(message => message.type === 'turn_input_committed'
      && message.turnId === 'om_turn_after_worker_restart')).toBe(false);
    writeFileSync(releaseSubmitPath, 'release\n');

    await waitFor(
      () => messages.some(message => message.type === 'turn_terminal'
        && message.turnId === 'om_turn_after_worker_restart'
        && message.status === 'completed'),
      () => `remote runner resume turn did not complete\n${logs.join('')}\n${JSON.stringify(messages)}`,
    );
    const commands = readFileSync(commandsPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(commands.some(command => command.type === 'start')).toBe(false);
    expect(commands.find(command => command.type === 'resume')).toMatchObject({
      sessionId: 'sid-remote-resume',
      state: persistedState,
    });
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'final_output',
      turnId: 'om_turn_after_worker_restart',
      content: 'RESUMED_OK',
    }));
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'turn_input_committed',
      turnId: 'om_turn_after_worker_restart',
      dispatchAttempt: 7,
      durablePrimaryInbox: true,
    }));
  });

  it('completes a visually empty remote final without emitting final_output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-remote-runner-invisible-final-'));
    tempDirs.push(root);
    const provider = join(root, 'provider.mjs');
    writeFileSync(provider, `#!/usr/bin/env node
import readline from 'node:readline';
const protocol = 'botmux.remote-runner';
const version = 1;
const state = { version: 1, provider: 'invisible-provider', generation: 1, remoteSessionId: 'remote-invisible-1' };
const emit = event => process.stdout.write(JSON.stringify({ protocol, version, ...event }) + '\\n');
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    emit({ type: 'hello', requestId: command.requestId, provider: 'invisible-provider', capabilities: ['start','resume','turn','cancel','detach','reattach','status'] });
  } else if (command.type === 'start') {
    emit({ type: 'ready', requestId: command.requestId, state });
  } else if (command.type === 'turn') {
    emit({ type: 'status', requestId: command.requestId, status: 'busy', state });
    setTimeout(() => emit({ type: 'final', turnId: command.turnId, content: '\\u200B', state }), 20);
  } else if (command.type === 'cancel') {
    emit({ type: 'status', requestId: command.requestId, status: 'closed' });
  } else if (command.type === 'detach') {
    emit({ type: 'status', requestId: command.requestId, status: 'detached', state });
  } else if (command.type === 'reattach' || command.type === 'status') {
    emit({ type: 'status', requestId: command.requestId, status: 'ready', state });
  }
});
`);
    chmodSync(provider, 0o755);
    const dataDir = join(root, 'data');
    const botsPath = join(root, 'bots.json');
    writeFileSync(botsPath, JSON.stringify([{
      larkAppId: 'app_invisible_final',
      larkAppSecret: 'secret',
      cliId: 'remote-runner',
      backendType: 'remote-runner',
      cliPathOverride: provider,
      remoteRunner: { expectedProvider: 'invisible-provider' },
    }]));

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: botsPath,
        BOTMUX_SESSION_ID: 'sid-invisible-final',
        LARK_APP_ID: 'app_invisible_final',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    child.stdout?.on('data', chunk => logs.push(String(chunk)));
    child.stderr?.on('data', chunk => logs.push(String(chunk)));
    child.on('message', raw => messages.push(raw as WorkerToDaemon));

    child.send({
      type: 'init',
      sessionId: 'sid-invisible-final',
      chatId: 'oc_invisible_final',
      rootMessageId: 'om_invisible_final',
      workingDir: root,
      cliId: 'remote-runner',
      cliPathOverride: provider,
      backendType: 'remote-runner',
      backendConfig: { expectedProvider: 'invisible-provider' },
      prompt: 'return an invisible final',
      turnId: 'turn-invisible-final',
      trustedCaller: {
        requestUserOpenId: 'ou_remote_user',
        requestLarkAppId: 'app_invisible_final',
        senderType: 'user',
      },
      larkAppId: 'app_invisible_final',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await waitFor(
      () => messages.some(message => message.type === 'turn_terminal'
        && message.turnId === 'turn-invisible-final'
        && message.status === 'completed'),
      () => `invisible final did not complete\n${logs.join('')}\n${JSON.stringify(messages)}`,
    );
    expect(messages.some(message => message.type === 'final_output'
      && message.turnId === 'turn-invisible-final')).toBe(false);
    expect(messages.some(message => message.type === 'error')).toBe(false);
  });

  it('does not re-post a remote final that the same turn attempt already delivered via botmux send', async () => {
    // Remote Runner has no transcript mark window, so only the exact
    // (turnId, dispatchAttempt) identity of a delivered final marker can stop
    // the fallback from double-posting the answer.
    const root = mkdtempSync(join(tmpdir(), 'botmux-remote-runner-sent-final-'));
    tempDirs.push(root);
    const dataDir = join(root, 'data');
    const markerPath = join(dataDir, 'turn-sends', 'sid-sent-final.jsonl');
    const provider = join(root, 'provider.mjs');
    writeFileSync(provider, `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import readline from 'node:readline';
const state = { version: 1, provider: 'sent-provider', generation: 1, remoteSessionId: 'remote-sent-1' };
const emit = event => process.stdout.write(JSON.stringify({ protocol: 'botmux.remote-runner', version: 1, ...event }) + '\\n');
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    emit({ type: 'hello', requestId: command.requestId, provider: 'sent-provider', capabilities: ['start','resume','turn','cancel','detach','reattach','status'] });
  } else if (command.type === 'start') {
    emit({ type: 'ready', requestId: command.requestId, state });
  } else if (command.type === 'turn') {
    emit({ type: 'status', requestId: command.requestId, status: 'busy', state });
    // The model already answered through botmux send for this exact attempt.
    mkdirSync(dirname(${JSON.stringify(markerPath)}), { recursive: true });
    appendFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ sentAtMs: Date.now(), responseKind: 'final', turnId: command.turnId, dispatchAttempt: 3 }) + '\\n');
    setTimeout(() => emit({ type: 'final', turnId: command.turnId, content: 'ALREADY_SENT_ANSWER', state }), 20);
  } else if (command.type === 'cancel' || command.type === 'detach') {
    emit({ type: 'status', requestId: command.requestId, status: command.type === 'cancel' ? 'closed' : 'detached', state });
  } else if (command.type === 'reattach' || command.type === 'status') {
    emit({ type: 'status', requestId: command.requestId, status: 'ready', state });
  }
});
`);
    chmodSync(provider, 0o755);
    const botsPath = join(root, 'bots.json');
    writeFileSync(botsPath, JSON.stringify([{
      larkAppId: 'app_sent_final', larkAppSecret: 'secret', cliId: 'remote-runner',
      backendType: 'remote-runner', cliPathOverride: provider,
      remoteRunner: { expectedProvider: 'sent-provider' },
    }]));

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: botsPath,
        BOTMUX_SESSION_ID: 'sid-sent-final', LARK_APP_ID: 'app_sent_final', LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    child.stdout?.on('data', chunk => logs.push(String(chunk)));
    child.stderr?.on('data', chunk => logs.push(String(chunk)));
    child.on('message', raw => messages.push(raw as WorkerToDaemon));
    child.send({
      type: 'init', sessionId: 'sid-sent-final', chatId: 'oc_sent_final', rootMessageId: 'om_sent_final',
      workingDir: root, cliId: 'remote-runner', cliPathOverride: provider, backendType: 'remote-runner',
      backendConfig: { expectedProvider: 'sent-provider' }, prompt: 'answer via botmux send',
      turnId: 'turn-sent-final', dispatchAttempt: 3,
      trustedCaller: { requestUserOpenId: 'ou_remote_user', requestLarkAppId: 'app_sent_final', senderType: 'user' },
      larkAppId: 'app_sent_final', larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await waitFor(
      () => messages.some(message => message.type === 'turn_terminal'
        && message.turnId === 'turn-sent-final' && message.status === 'completed'),
      () => `sent final did not complete\n${logs.join('')}\n${JSON.stringify(messages)}`,
    );
    expect(existsSync(markerPath)).toBe(true);
    expect(messages.some(message => message.type === 'final_output')).toBe(false);
  });

  it('rejects a provider-selected schedule controller on a human-authored turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-remote-runner-human-controller-'));
    tempDirs.push(root);
    const resultPath = join(root, 'session-tool-result.json');
    const provider = join(root, 'provider.mjs');
    writeFileSync(provider, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const protocol = 'botmux.remote-runner';
const version = 1;
const state = { version: 1, provider: 'human-controller-provider', generation: 1, remoteSessionId: 'remote-human-controller-1' };
const emit = event => process.stdout.write(JSON.stringify({ protocol, version, ...event }) + '\\n');
let activeTurnId;
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    emit({
      type: 'hello', requestId: command.requestId, provider: 'human-controller-provider',
      capabilities: ['start','resume','turn','cancel','detach','reattach','status','session_tool','session_tool_schedule','session_tool_schedule_actor'],
    });
  } else if (command.type === 'start') {
    emit({ type: 'ready', requestId: command.requestId, state });
  } else if (command.type === 'turn') {
    activeTurnId = command.turnId;
    emit({ type: 'status', requestId: command.requestId, status: 'busy', state });
    emit({
      type: 'session_tool', operationId: 'session-tool-human-controller',
      turnId: command.turnId, generation: 1, controllerOpenId: 'ou_developer',
      request: { tool: 'schedule.add', schedule: '10m', prompt: 'must be rejected' },
    });
  } else if (command.type === 'session_tool_result') {
    fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(command.result));
    emit({ type: 'final', turnId: activeTurnId, content: 'controller rejection observed', state });
  } else if (command.type === 'cancel') {
    emit({ type: 'status', requestId: command.requestId, status: 'closed' });
  } else if (command.type === 'detach') {
    emit({ type: 'status', requestId: command.requestId, status: 'detached', state });
  } else if (command.type === 'reattach' || command.type === 'status') {
    emit({ type: 'status', requestId: command.requestId, status: 'ready', state });
  }
});
`);
    chmodSync(provider, 0o755);
    const dataDir = join(root, 'data');
    const botsPath = join(root, 'bots.json');
    writeFileSync(botsPath, JSON.stringify([{
      larkAppId: 'app_human_controller',
      larkAppSecret: 'secret',
      cliId: 'remote-runner',
      backendType: 'remote-runner',
      cliPathOverride: provider,
      remoteRunner: {
        expectedProvider: 'human-controller-provider',
        requiredCapabilities: [
          'start','resume','turn','cancel','detach','reattach','status',
          'session_tool','session_tool_schedule','session_tool_schedule_actor',
        ],
      },
    }]));

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: botsPath,
        BOTMUX_SESSION_ID: 'sid-human-controller',
        LARK_APP_ID: 'app_human_controller',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    child.stdout?.on('data', chunk => logs.push(String(chunk)));
    child.stderr?.on('data', chunk => logs.push(String(chunk)));
    child.on('message', raw => messages.push(raw as WorkerToDaemon));

    child.send({
      type: 'init',
      sessionId: 'sid-human-controller',
      chatId: 'oc_human_controller',
      rootMessageId: 'om_human_controller',
      workingDir: root,
      cliId: 'remote-runner',
      cliPathOverride: provider,
      backendType: 'remote-runner',
      backendConfig: {
        expectedProvider: 'human-controller-provider',
        requiredCapabilities: [
          'start','resume','turn','cancel','detach','reattach','status',
          'session_tool','session_tool_schedule','session_tool_schedule_actor',
        ],
      },
      prompt: 'human turn must reject provider controller',
      turnId: 'turn-human-controller',
      trustedCaller: {
        requestUserOpenId: 'ou_human',
        requestLarkAppId: 'app_human_controller',
        senderType: 'user',
      },
      larkAppId: 'app_human_controller',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await waitFor(
      () => existsSync(resultPath) && messages.some(message => message.type === 'turn_terminal'
        && message.turnId === 'turn-human-controller'
        && message.status === 'completed'),
      () => `human controller rejection did not settle\n${logs.join('')}\n${JSON.stringify(messages)}`,
    );
    expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({
      outcome: 'rejected',
      code: 'session_tool_controller_forbidden',
    });
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'final_output',
      turnId: 'turn-human-controller',
      content: 'controller rejection observed',
    }));
    expect(messages.some(message => message.type === 'error')).toBe(false);
  });

  it('passes trusted turn input, persists provider state, and projects a terminal screen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-remote-runner-worker-'));
    tempDirs.push(root);
    const dump = join(root, 'turn.json');
    const startDump = join(root, 'start.json');
    const resizeDump = join(root, 'resize.log');
    const provider = join(root, 'provider.mjs');
    writeFileSync(provider, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const protocol = 'botmux.remote-runner';
const version = 1;
const state = { version: 1, provider: 'test-provider', generation: 1, remoteSessionId: 'remote-1' };
const emit = event => process.stdout.write(JSON.stringify({ protocol, version, ...event }) + '\\n');
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    emit({ type: 'hello', requestId: command.requestId, provider: 'test-provider', capabilities: ['start','resume','turn','cancel','detach','status','terminal_screen','terminal_resize'] });
  } else if (command.type === 'start') {
    fs.writeFileSync(${JSON.stringify(startDump)}, JSON.stringify(command));
    emit({ type: 'ready', requestId: command.requestId, state });
  } else if (command.type === 'turn') {
    fs.writeFileSync(${JSON.stringify(dump)}, JSON.stringify({
      command,
      sessionScope: process.env.BOTMUX_SESSION_SCOPE,
      chatId: process.env.BOTMUX_CHAT_ID,
      rootMessageId: process.env.BOTMUX_ROOT_MESSAGE_ID,
    }));
    state.agentThreadId = 'thread-1';
    emit({ type: 'status', requestId: command.requestId, status: 'busy', state });
    emit({ type: 'lineage_changed', state });
    emit({ type: 'terminal_screen', generation: 1, sequence: 0, cols: 120, rows: 40, snapshot: 'REMOTE_TMUX_SCREEN_OLD' });
    setTimeout(() => emit({ type: 'terminal_screen', generation: 1, sequence: 1, cols: 120, rows: 40, snapshot: 'REMOTE_TMUX_SCREEN_NEW' }), 100);
    // The worker publishes screen cards on a 2s cadence. Keep the synthetic
    // turn alive beyond one full cadence so both Vitest and Bun observe the
    // screen_update before the structured final retires the turn.
    setTimeout(() => emit({
      type: 'final', turnId: command.turnId, content: 'REMOTE_OK', state,
      usage: {
        generation: 1,
        snapshot: {
          context: { usedTokens: 240, windowTokens: 1000, percentUsed: 24 },
          tokens: { in: 200, out: 40 },
          turnTokens: { in: 25, out: 10 },
          model: 'remote-model',
          reasoningEffort: 'high',
        },
      },
    }), 2500);
  } else if (command.type === 'detach') {
    emit({ type: 'status', requestId: command.requestId, status: 'detached' });
  } else if (command.type === 'cancel') {
    emit({ type: 'status', requestId: command.requestId, status: 'closed' });
  } else if (command.type === 'status') {
    emit({ type: 'status', requestId: command.requestId, status: 'ready' });
  } else if (command.type === 'terminal_resize') {
    fs.appendFileSync(${JSON.stringify(resizeDump)}, command.cols + 'x' + command.rows + '\\n');
    emit({ type: 'status', requestId: command.requestId, status: 'ready', state });
  }
});
`);
    chmodSync(provider, 0o755);
    const dataDir = join(root, 'data');
    const botsPath = join(root, 'bots.json');
    writeFileSync(botsPath, JSON.stringify([{
      larkAppId: 'app_remote_runner',
      larkAppSecret: 'secret',
      cliId: 'remote-runner',
      backendType: 'remote-runner',
      cliPathOverride: provider,
      remoteRunner: { expectedProvider: 'test-provider' },
    }]));

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: botsPath,
        BOTMUX_SESSION_ID: 'sid-remote-runner',
        LARK_APP_ID: 'app_remote_runner',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    child.stdout?.on('data', chunk => logs.push(String(chunk)));
    child.stderr?.on('data', chunk => logs.push(String(chunk)));
    child.on('message', raw => messages.push(raw as WorkerToDaemon));

    child.send({
      type: 'init',
      sessionId: 'sid-remote-runner',
      chatId: 'oc_remote_runner',
      rootMessageId: 'om_remote_runner',
      workingDir: root,
      cliId: 'remote-runner',
      cliPathOverride: provider,
      backendType: 'remote-runner',
      backendConfig: { expectedProvider: 'test-provider', requiredCapabilities: ['start','resume','turn','cancel','detach','status','terminal_screen'] },
      model: 'GPT-5.6-Sol',
      modelBackendVariant: 'max',
      reasoningEffort: 'xhigh',
      prompt: 'remote hello',
      turnId: 'turn-remote-1',
      trustedCaller: {
        requestUserOpenId: 'ou_remote_user',
        requestLarkAppId: 'app_remote_runner',
        senderType: 'user',
      },
      larkAppId: 'app_remote_runner',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await waitFor(
      () => messages.some(message => message.type === 'turn_terminal'
        && message.turnId === 'turn-remote-1'
        && message.status === 'completed'),
      () => `remote runner turn did not complete\n${logs.join('')}\n${JSON.stringify(messages)}`,
    );
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'remote_backend_state',
        state: expect.objectContaining({
          provider: 'test-provider',
          remoteSessionId: 'remote-1',
          agentThreadId: 'thread-1',
        }),
      }),
      expect.objectContaining({
        type: 'final_output',
        turnId: 'turn-remote-1',
        content: 'REMOTE_OK',
      }),
      expect.objectContaining({
        type: 'remote_usage',
        usage: expect.objectContaining({
          generation: 1,
          snapshot: expect.objectContaining({
            context: { usedTokens: 240, windowTokens: 1000, percentUsed: 24 },
            tokens: { in: 200, out: 40 },
            model: 'remote-model',
          }),
        }),
      }),
      expect.objectContaining({
        type: 'screen_update',
        content: expect.stringContaining('REMOTE_TMUX_SCREEN'),
      }),
    ]));
    expect(messages.some(message => message.type === 'error')).toBe(false);
    const ready = messages.find(message => message.type === 'ready');
    expect(ready?.type).toBe('ready');
    if (!ready || ready.type !== 'ready' || !ready.port || !ready.viewToken) {
      throw new Error(`remote runner worker did not publish a Web Terminal: ${JSON.stringify(messages)}`);
    }
    const seed = await readTerminalSeed(ready.port, ready.viewToken, { cols: 60, rows: 49 });
    expect(seed).toContain('\x1b]1989;120;40\x07');
    expect(seed).toContain('REMOTE_TMUX_SCREEN_NEW');
    expect(seed).not.toContain('REMOTE_TMUX_SCREEN_OLD');
    await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 150));
    expect(existsSync(resizeDump)).toBe(false);

    expect(existsSync(dump)).toBe(true);
    expect(JSON.parse(readFileSync(startDump, 'utf8'))).toMatchObject({
      type: 'start',
      model: 'GPT-5.6-Sol',
      modelBackendVariant: 'max',
      reasoningEffort: 'xhigh',
    });
    expect(JSON.parse(readFileSync(dump, 'utf8'))).toMatchObject({
      command: {
        type: 'turn',
        turnId: 'turn-remote-1',
        content: 'remote hello',
        trustedCaller: {
          requestUserOpenId: 'ou_remote_user',
          requestLarkAppId: 'app_remote_runner',
          senderType: 'user',
        },
      },
      sessionScope: 'thread',
      chatId: 'oc_remote_runner',
      rootMessageId: 'om_remote_runner',
    });

    child.send({ type: 'close', requestId: 'close-remote-1' } satisfies DaemonToWorker);
    await waitFor(
      () => messages.some(message => message.type === 'close_result'
        && message.requestId === 'close-remote-1'
        && message.ok),
      () => `remote runner close was not prepared\n${logs.join('')}\n${JSON.stringify(messages)}`,
    );
    child.send({ type: 'close_commit', requestId: 'close-remote-1' } satisfies DaemonToWorker);
    await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
      () => `remote runner worker did not exit after close commit\n${logs.join('')}`,
    );
  });
});
