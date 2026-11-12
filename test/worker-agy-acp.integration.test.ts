/** Full worker/runner regression without a real daemon, model account or shared terminal server. */
import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const workers: ChildProcess[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const child of workers.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker, () => {});
      else child.kill('SIGTERM');
    });
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Launch an actual isolated worker against a protocol peer and collect its public IPC events. */
function start(content: string, mode = '', backendType: 'pty' | 'tmux' = 'pty') {
  const sessionId = randomUUID();
  const root = mkdtempSync(join(tmpdir(), 'botmux-worker-agy-acp-')); roots.push(root);
  const dataDir = join(root, 'data'); mkdirSync(dataDir);
  const executable = join(root, 'agy');
  const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
  writeFileSync(executable, `#!/bin/sh\nexec ${[tsRunnerPrefix().command, resolve('test/fixtures/fake-antigravity-acp.mjs')].map(quote).join(' ')} "$@"\n`, { mode: 0o700 });
  const log = join(root, 'calls.jsonl'); writeFileSync(log, '');
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, HOME: root, SESSION_DATA_DIR: dataDir, NODE_ENV: 'test',
      BOTMUX_TEST_ANTIGRAVITY_RUNNER_PATH: resolve('dist/antigravity-runner.js'),
      AGY_TEST_LOG: log, AGY_TEST_MODE: mode, BOTMUX_TIME_SCALE: '0.05',
      LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret' },
  });
  workers.push(child);
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.send({ type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
    workingDir: root, cliId: 'antigravity', cliPathOverride: executable, backendType,
    prompt: content, turnId: 'om_initial', env: { AGY_BOTMUX_TRANSPORT: 'acp' },
    larkAppId: 'app_test', larkAppSecret: 'secret',
  } satisfies DaemonToWorker);
  return { child, root, messages, logs, sessionId, backendType,
    calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) as Array<Record<string, unknown>> };
}

/** Await the exact IPC or native receipt under test, with worker diagnostics on timeout. */
async function waitFor(worker: ReturnType<typeof start>, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) {
      console.error(worker.logs.join(''));
      if (worker.backendType === 'tmux') {
        try { console.error(execFileSync('tmux', ['-L', 'botmux', 'capture-pane', '-p', '-t', `=bmx-${worker.sessionId.slice(0, 8)}:`], {
          encoding: 'utf8', timeout: 2_000, env: process.env,
        })); } catch { /* The private fixture pane may already have exited. */ }
      }
      throw new Error('Worker ACP condition timed out');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe('worker Antigravity ACP delivery', () => {
  it.each(['pty', 'tmux'] as const)('%s delivers full multi-line input once and attributes each final to its own turn', async backendType => {
    const content = '<user_message>\n' + '中文 😀 transmission\n'.repeat(1_000) + '</user_message>';
    const worker = start(content, '', backendType);
    await waitFor(worker, () => worker.messages.some(message => message.type === 'final_output' && message.turnId === 'om_initial'));
    expect(worker.calls().filter(call => call.method === 'session/prompt')).toHaveLength(1);
    expect(worker.calls().find(call => call.method === 'session/prompt')?.params).toMatchObject({ prompt: [{ type: 'text', text: content }] });
    expect(worker.messages.some(message => message.type === 'final_output' && message.content === '中文 complete answer')).toBe(true);
    worker.child.send({ type: 'message', content: 'second prompt', turnId: 'om_followup' } satisfies DaemonToWorker);
    await waitFor(worker, () => worker.messages.some(message => message.type === 'final_output' && message.turnId === 'om_followup'));
    expect(worker.calls().filter(call => call.method === 'session/new')).toHaveLength(1);
    expect(worker.calls().filter(call => call.method === 'session/load')).toHaveLength(1);
    expect(worker.calls().filter(call => call.method === 'session/prompt')).toHaveLength(2);
    expect(worker.messages.some(message => message.type === 'user_notify')).toBe(false);
  }, 45_000);

  it('publishes a failed terminal when the ACP process exits without a response', async () => {
    const worker = start('do not retry this message', 'exit');
    await waitFor(worker, () => worker.messages.some(message => message.type === 'turn_terminal' && message.turnId === 'om_initial'));
    expect(worker.messages.filter(message => message.type === 'turn_terminal' && message.turnId === 'om_initial')).toMatchObject([
      { status: 'failed', errorCode: 'execution_failed' },
    ]);
    expect(worker.calls().filter(call => call.method === 'session/prompt')).toHaveLength(1);
  }, 30_000);
});
