import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

it.skipIf(!probeTmuxFunctional().ok).each([false, true])('prepares the serial opening RPC before sending it without a duplicate (lost receipt: %s)', async lostReceipt => {
  const root = mkdtempSync(join(tmpdir(), 'bmx-serial-rpc-'));
  const sessionId = randomUUID();
  mkdirSync(join(homedir(), '.botmux'), { recursive: true, mode: 0o700 });
  chmodSync(join(homedir(), '.botmux'), 0o700);
  mkdirSync(join(root, 'data'));
  const turns = join(root, 'turns.jsonl');
  const paste = join(root, 'paste');
  const viewer = join(root, 'viewer');
  const cli = join(root, 'codex-test.mjs');
  const fixture = pathToFileURL(resolve('test/fixtures/fake-codex-rpc-server.mjs')).href;
  writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
if (process.argv.includes('app-server')) {
  await import(${JSON.stringify(fixture)});
} else {
  appendFileSync(${JSON.stringify(viewer)}, 'started');
  process.stdin.setRawMode(true);
  process.stdin.on('data', data => appendFileSync(${JSON.stringify(paste)}, data));
  process.stdout.write('› Ask Codex to do anything\\r\\n  custom-model · /tmp');
  setInterval(() => {}, 1000);
}
`);
  chmodSync(cli, 0o755);
  // Establish an isolated tmux socket: missing server is unknown, not a proven absent pane.
  execFileSync('tmux', ['new-session', '-d', '-s', 'test-control'], { env: privateTmuxEnv(root) });
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const child = spawnTsScript(resolve('src/worker.ts'), [], { cwd: resolve('.'),
    env: privateTmuxEnv(root, { SESSION_DATA_DIR: join(root, 'data'),
      BOTMUX_SESSION_ID: sessionId, BOTMUX_NO_CLAIM: '1', BOTMUX_XPI_ENABLED: 'false',
      FAKE_NO_TURN_TERMINAL: '1', FAKE_TURN_CONFIG_FILE: turns, FAKE_ROLLOUT_PATH: join(root, 'rollout.jsonl') }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.on('message', message => messages.push(message as WorkerToDaemon));
  child.stdout?.on('data', data => logs.push(String(data)));
  child.stderr?.on('data', data => logs.push(String(data)));
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
      if (child.exitCode != null || Date.now() > deadline) throw new Error(logs.join(''));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  try {
    child.send({ type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_test', workingDir: root,
      cliId: 'codex', cliPathOverride: cli, cliRuntime: { id: 'test', displayName: 'Test',
        executable: cli, source: 'configured', update: { provider: 'self' } },
      backendType: 'tmux', codexRpcInput: true, apiOnly: true, sandbox: false, promptInjection: 'none',
      larkAppId: 'app_test', larkAppSecret: 'test', prompt: 'serial first task', turnId: 'first',
      codexAppDispatchId: 'dispatch-first', queueAfterActiveTurn: true, atMostOnce: true,
    } satisfies DaemonToWorker);
    await wait(() => messages.some(message => message.type === 'codex_app_dispatch_transition'));
    const prepare = messages.find(message => message.type === 'codex_app_dispatch_transition')!;
    if (prepare.type !== 'codex_app_dispatch_transition') throw new Error('missing prepare');
    expect(prepare.entries).toMatchObject([{ turnId: 'first', dispatchId: 'dispatch-first',
      serialRecovery: { rpcThreadRuntime: { threadId: 'thread-fake-1', model: 'test-model', modelProvider: 'test-provider', reasoningEffort: 'high' } } }]);
    expect(existsSync(turns)).toBe(false);
    expect(existsSync(viewer)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(existsSync(turns)).toBe(false);
    expect(existsSync(viewer)).toBe(false);
    expect(messages.some(message => message.type === 'cli_session_id' && message.cliSessionId === 'thread-fake-1')).toBe(true);
    if (lostReceipt) {
      await new Promise(resolve => setTimeout(resolve, 31_000));
      expect(existsSync(turns)).toBe(false);
      expect(existsSync(viewer)).toBe(false);
      expect(messages.some(message => message.type === 'user_notify' && message.message.includes('保存回执'))).toBe(true);
      child.send({ type: 'reconcile_serial_dispatch', sessionId,
        pending: [{ dispatchId: 'dispatch-first', turnId: 'first' }], committed: [],
      } satisfies DaemonToWorker);
      await wait(() => messages.filter(message => message.type === 'codex_app_dispatch_transition').length === 2);
      const retry = messages.filter(message => message.type === 'codex_app_dispatch_transition').at(-1)!;
      if (retry.type !== 'codex_app_dispatch_transition') throw new Error('missing original receipt retry');
      expect(retry.requestId).toBe(prepare.requestId);
      expect(retry.entries).toEqual(prepare.entries);
    }
    child.send({ type: 'codex_app_dispatch_persisted', requestId: prepare.requestId, ok: true } satisfies DaemonToWorker);
    await wait(() => messages.some(message => message.type === 'native_turn_started' && message.turnId === 'first'));
    await wait(() => messages.some(message => message.type === 'ready'));
    // Cross the initial prompt-ready settle window to catch accidental double queuing.
    await new Promise(resolve => setTimeout(resolve, 2_000));
    const submitted = readFileSync(turns, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ clientUserMessageId: 'first', input: [{ text: 'serial first task' }] });
    expect(existsSync(paste) ? readFileSync(paste, 'utf8') : '').not.toContain('serial first task');
  } finally {
    if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
    if (child.exitCode == null && child.signalCode == null) {
      const exited = once(child, 'exit');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited; clearTimeout(timer);
    }
    execFileSync('tmux', ['kill-server'], { env: privateTmuxEnv(root) });
    rmSync(root, { recursive: true, force: true });
  }
}, 50_000);
