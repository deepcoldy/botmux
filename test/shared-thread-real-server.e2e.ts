import { it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { SharedThreadClient, openSharedThread } from '../src/core/shared-thread-opening.js';
import type { Session } from '../src/types.js';
import { spawnLoadedSourceWorker } from './helpers/source-worker-boot.js';
import { MockLlmServer } from './helpers/mock-llm-server/index.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const codexBin = process.env.BOTMUX_TEST_REAL_CODEX_BIN;

it.skipIf(!codexBin)('hands the persisted thread to the real remote worker and exposes its completed turn to another client', async () => {
  const home = mkdtempSync(join(tmpdir(), 'botmux-shared-worker-'));
  const socket = join(home, 'server.sock');
  const model = new MockLlmServer();
  const { baseUrl } = await model.start();
  writeFileSync(join(home, 'config.toml'), [
    'model = "gpt-4o"', 'model_provider = "fixture"',
    'approval_policy = "never"', 'sandbox_mode = "read-only"',
    '[model_providers.fixture]', 'name = "fixture"',
    `base_url = ${JSON.stringify(baseUrl)}`, 'wire_api = "responses"',
  ].join('\n'));
  const env = { ...process.env, HOME: home, CODEX_HOME: home,
    SESSION_DATA_DIR: join(home, 'data'), BOTMUX_SESSION_ID: 'shared-worker-test',
    LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test' };
  const server = spawn(codexBin!, ['app-server', '--listen', `unix://${socket}`], {
    cwd: home, env, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let worker: ChildProcess | undefined;
  let client: SharedThreadClient | undefined;
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  server.stderr!.on('data', data => logs.push(String(data)));
  async function waitFor(check: () => boolean, label: string, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (!check()) {
      if (Date.now() > deadline || server.exitCode !== null || worker?.exitCode != null) {
        throw new Error(`${label}\n${logs.join('')}\n${JSON.stringify(messages)}`);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try {
    await waitFor(() => existsSync(socket), 'server socket');
    client = new SharedThreadClient(`unix://${socket}`);
    await client.initialize();
    let session = { status: 'active', cliId: 'codex', sharedThreadOpening: {
      endpoint: `unix://${socket}`, cwd: home, title: 'Shared worker topic',
    } } as Session;
    const threadId = await openSharedThread(change => {
      const copy = structuredClone(session);
      const result = change(copy);
      session = copy;
      return result;
    }, client);
    const source = spawnLoadedSourceWorker({ cwd: process.cwd(), env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    worker = source.child;
    worker.stdout?.on('data', data => logs.push(String(data)));
    worker.stderr?.on('data', data => logs.push(String(data)));
    worker.on('message', message => messages.push(message as WorkerToDaemon));
    await source.loaded;
    worker.send({ type: 'init', sessionId: 'shared-worker-test', chatId: 'oc_test',
      rootMessageId: 'om_test', workingDir: home, cliId: 'codex', cliPathOverride: codexBin, backendType: 'pty',
      existingAppServerEndpoint: `unix://${socket}`, cliSessionId: threadId,
      resume: true, prompt: 'Reply with ACK-e2e-shared-worker', turnId: 'om_first',
      replyDelivery: 'transcript', promptInjection: 'none',
      larkAppId: 'app_test', larkAppSecret: 'test',
    } satisfies DaemonToWorker);
    await waitFor(() => messages.some(message => message.type === 'turn_input_committed'), 'input receipt', 30000);
    const deadline = Date.now() + 30000;
    let completed: any;
    do {
      const read = await client.request('thread/read', { threadId, includeTurns: true });
      completed = read.thread.turns?.find((turn: any) => turn.status === 'completed');
      if (!completed) await new Promise(resolve => setTimeout(resolve, 100));
    } while (!completed && Date.now() < deadline);
    expect(completed, logs.join('')).toBeDefined();
    client.close();
    client = new SharedThreadClient(`unix://${socket}`);
    await client.initialize();
    const read = await client.request('thread/read', { threadId, includeTurns: true });
    expect(read.thread.id).toBe(threadId);
    expect(JSON.stringify(read.thread.turns)).toContain('ACK-e2e-shared-worker');
  } finally {
    if (worker?.connected) worker.send({ type: 'close' } satisfies DaemonToWorker);
    if (worker && worker.exitCode === null) {
      await Promise.race([once(worker, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
      if (worker.exitCode === null) worker.kill('SIGKILL');
    }
    client?.close();
    if (server.exitCode === null) {
      const exited = once(server, 'close');
      server.kill();
      await exited;
    }
    await model.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 90000);

it.skipIf(!codexBin)('creates a persisted thread on a real server and a second client resumes the same ID', async () => {
  const home = mkdtempSync(join(tmpdir(), 'botmux-shared-real-'));
  const socket = join(home, 'server.sock');
  const child = spawn(codexBin!, ['app-server', '--listen', `unix://${socket}`], {
    cwd: home, env: { HOME: home, CODEX_HOME: home, PATH: process.env.PATH },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', data => { stderr += String(data); });
  let client: SharedThreadClient | undefined;
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(socket) && Date.now() < deadline && child.exitCode === null) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(existsSync(socket), stderr).toBe(true);
    client = new SharedThreadClient(`unix://${socket}`);
    await client.initialize();
    let session = { status: 'active', cliId: 'codex', sharedThreadOpening: {
      endpoint: `unix://${socket}`, cwd: home, title: 'Shared new topic',
    } } as Session;
    const id = await openSharedThread(change => {
      const copy = structuredClone(session);
      const result = change(copy);
      session = copy;
      return result;
    }, client);
    client.close();
    client = new SharedThreadClient(`unix://${socket}`);
    await client.initialize();
    const resumed = await client.request('thread/resume', { threadId: id });
    expect(resumed.thread.id).toBe(id);
    expect(resumed.thread.name).toBe('Shared new topic');
    expect(existsSync(resumed.thread.path)).toBe(true);
  } finally {
    client?.close();
    const exited = once(child, 'close');
    child.kill();
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
}, 20000);
