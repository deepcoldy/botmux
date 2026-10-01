import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('remote runner worker wiring', () => {
  it('passes trusted turn input, persists provider state, and projects a terminal screen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-remote-runner-worker-'));
    tempDirs.push(root);
    const dump = join(root, 'turn.json');
    const provider = join(root, 'provider.mjs');
    writeFileSync(provider, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const protocol = 'botmux.remote-runner';
const version = 1;
const emit = event => process.stdout.write(JSON.stringify({ protocol, version, ...event }) + '\\n');
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const command = JSON.parse(line);
  if (command.type === 'hello') {
    emit({ type: 'hello', requestId: command.requestId, provider: 'test-provider', capabilities: ['start','resume','turn','cancel','detach','status','terminal_screen'] });
  } else if (command.type === 'start') {
    const state = { version: 1, provider: 'test-provider', generation: 1, remoteSessionId: 'remote-1' };
    emit({ type: 'ready', requestId: command.requestId, state });
  } else if (command.type === 'turn') {
    fs.writeFileSync(${JSON.stringify(dump)}, JSON.stringify({
      command,
      sessionScope: process.env.BOTMUX_SESSION_SCOPE,
      chatId: process.env.BOTMUX_CHAT_ID,
      rootMessageId: process.env.BOTMUX_ROOT_MESSAGE_ID,
    }));
    const state = { version: 1, provider: 'test-provider', generation: 1, remoteSessionId: 'remote-1', agentThreadId: 'thread-1' };
    emit({ type: 'status', requestId: command.requestId, status: 'busy', state });
    emit({ type: 'lineage_changed', state });
    emit({ type: 'terminal_screen', generation: 1, sequence: 0, cols: 120, rows: 40, snapshot: 'REMOTE_TMUX_SCREEN' });
    setTimeout(() => emit({ type: 'final', turnId: command.turnId, content: 'REMOTE_OK', state }), 700);
  } else if (command.type === 'detach') {
    emit({ type: 'status', requestId: command.requestId, status: 'detached' });
  } else if (command.type === 'cancel') {
    emit({ type: 'status', requestId: command.requestId, status: 'closed' });
  } else if (command.type === 'status') {
    emit({ type: 'status', requestId: command.requestId, status: 'ready' });
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
        type: 'screen_update',
        content: expect.stringContaining('REMOTE_TMUX_SCREEN'),
      }),
    ]));
    expect(messages.some(message => message.type === 'error')).toBe(false);
    expect(existsSync(dump)).toBe(true);
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
