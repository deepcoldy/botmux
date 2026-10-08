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
  it('passes persisted provider state to resume after a worker restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-remote-runner-resume-'));
    tempDirs.push(root);
    const commandsPath = join(root, 'commands.jsonl');
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
    emit({ type: 'status', requestId: command.requestId, status: 'busy' });
    emit({ type: 'final', turnId: command.turnId, content: 'RESUMED_OK' });
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
      turnId: 'turn-after-worker-restart',
      larkAppId: 'app_remote_resume',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await waitFor(
      () => messages.some(message => message.type === 'turn_terminal'
        && message.turnId === 'turn-after-worker-restart'
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
      turnId: 'turn-after-worker-restart',
      content: 'RESUMED_OK',
    }));
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
