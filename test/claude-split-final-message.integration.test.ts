import type { ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { setDefaultLocale, t } from '../src/i18n/index.js';
import { lookupCliDisplayName } from '../src/adapters/cli/display-names.js';

// Real worker, fake Claude Code, pty backend (never the host tmux server).
// Claude Code writes one record per content block, each stamped with the
// message's stop reason. The fake answers a prompt with a thinking block
// (`end_turn`), pauses long enough for the worker to read that record on its
// own — what Claude Code's chunked flush did in production — and then writes
// the text block, the API error that cut the stream, and `turn_duration`.

// The worker runs with locale zh; the expectation comes from the same key.
setDefaultLocale('zh');

let child: ChildProcess | undefined;
let root: string | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise<void>(done => child!.once('exit', () => done()));
    child.kill('SIGKILL');
    await Promise.race([stopped, new Promise<void>(done => setTimeout(done, 2_000))]);
  }
  child = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function waitUntil(check: () => boolean, logs: string[], timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    if (child?.exitCode !== null || child?.signalCode !== null) throw new Error(`Worker exited\n${logs.join('')}`);
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error(`Timed out\n${logs.join('')}`);
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function startWorker() {
  root = mkdtempSync(join(tmpdir(), 'botmux-split-final-'));
  const workDir = join(root, 'work');
  const dataDir = join(root, 'data');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const cliSessionId = 'deadbeef-1234-4678-9abc-def012345690';
  const projectDir = join(root, '.claude', 'projects', realpathSync(workDir).replace(/[^A-Za-z0-9-]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${cliSessionId}.jsonl`);
  // An earlier finished turn: this CLI ends turns with turn_duration.
  writeFileSync(transcript, [
    { type: 'user', uuid: 'p0', timestamp: minutesAgo(30), message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a0', timestamp: minutesAgo(30), message: { id: 'm0', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] } },
    { type: 'system', subtype: 'turn_duration', uuid: 'd0', timestamp: minutesAgo(30) },
  ].map(row => `${JSON.stringify(row)}\n`).join(''));
  const fakeClaude = join(root, 'fake-claude');
  // Dynamic import: runs as CommonJS or ESM, whatever package.json sits above.
  writeFileSync(fakeClaude, `#!/usr/bin/env node
import('node:fs').then(fs => {
const T = ${JSON.stringify(transcript)};
const put = row => fs.appendFileSync(T, JSON.stringify({ timestamp: new Date().toISOString(), ...row }) + '\\n');
process.stdout.write('❯ ');
let typed = '';
process.stdin.on('data', chunk => {
  typed += chunk.toString();
  if (!/[\\r\\n]$/.test(typed)) return;
  if (typed.includes('\\x1b[200~') && !typed.includes('\\x1b[201~')) return;
  const prompt = typed.replace(/\\x1b\\[20[01]~/g, '').trim();
  typed = '';
  put({ type: 'user', uuid: 'u1', message: { role: 'user', content: prompt } });
  setTimeout(() => put({ type: 'assistant', uuid: 'a-think', message: { id: 'm1', role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: 'wrap up', signature: '' }] } }), 300);
  setTimeout(() => {
    put({ type: 'assistant', uuid: 'a-text', message: { id: 'm1', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Posting the review now:' }] } });
    put({ type: 'assistant', uuid: 'a-err', isApiErrorMessage: true, error: 'server_error', message: { id: 'e1', role: 'assistant',
      model: '<synthetic>', stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: 'API Error: Connection lost mid-response. The response above may be incomplete.' }] } });
    put({ type: 'system', subtype: 'turn_duration', uuid: 'd1', durationMs: 3000 });
    process.stdout.write('\\r\\n❯ ');
  }, 2800);
});
});
`);
  chmodSync(fakeClaude, 0o755);
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const sid = 'sid-split-final';
  child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env, HOME: root, SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: sid, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.send({
    type: 'init', sessionId: sid, chatId: 'oc_test', rootMessageId: 'om_root',
    workingDir: workDir, cliId: 'claude-code', cliPathOverride: fakeClaude, cliSessionId,
    backendType: 'pty', prompt: '', resume: true, larkAppId: 'app_test', larkAppSecret: 'test-only', locale: 'zh',
  } satisfies DaemonToWorker);
  return { transcript, messages, logs };
}

describe('Claude final message split across transcript reads (real worker, fake Claude Code)', () => {
  it('fails the Lark turn with the provider error instead of settling it on the thinking block', async () => {
    const w = startWorker();
    await waitUntil(() => w.messages.some(msg => msg.type === 'prompt_ready'), w.logs);
    child!.send({ type: 'message', content: 'please re-review PR 2107', turnId: 'om_split' } satisfies DaemonToWorker);
    await waitUntil(() => readFileSync(w.transcript, 'utf8').includes('"d1"'), w.logs);
    const terminals = () => w.messages.filter((msg): msg is Extract<WorkerToDaemon, { type: 'turn_terminal' }> =>
      msg.type === 'turn_terminal' && msg.turnId === 'om_split');
    await waitUntil(() => terminals().length > 0, w.logs);
    // Anything still in flight for the same turn lands within a few polls.
    await new Promise(done => setTimeout(done, 1_500));

    expect(terminals()).toHaveLength(1);
    expect(terminals()[0]).toMatchObject({ status: 'failed', errorCode: 'provider_server_error', retryable: true });
    expect(w.messages.filter(msg => msg.type === 'user_notify')).toEqual([]);
  }, 90_000);

  it('tells the group when output with no Lark turn behind it fails while the worker watches', async () => {
    const w = startWorker();
    await waitUntil(() => w.messages.some(msg => msg.type === 'prompt_ready'), w.logs);
    const now = () => new Date().toISOString();
    appendFileSync(w.transcript, [
      { type: 'assistant', uuid: 'h-text', timestamp: now(), message: { id: 'h1', role: 'assistant', stop_reason: 'tool_use',
        content: [{ type: 'text', text: 'continuing the earlier work' }] } },
      { type: 'assistant', uuid: 'h-err', timestamp: now(), isApiErrorMessage: true, error: 'server_error', message: { id: 'e2', role: 'assistant',
        model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: Connection lost mid-response.' }] } },
      { type: 'system', subtype: 'turn_duration', uuid: 'h-dur', timestamp: now() },
    ].map(row => `${JSON.stringify(row)}\n`).join(''));
    const notices = () => w.messages.filter((msg): msg is Extract<WorkerToDaemon, { type: 'user_notify' }> => msg.type === 'user_notify');
    await waitUntil(() => notices().length > 0, w.logs);
    await new Promise(done => setTimeout(done, 1_500));

    expect(notices()).toEqual([{
      type: 'user_notify',
      message: t('worker.local_turn_failed', { cliName: lookupCliDisplayName('claude-code') ?? 'CLI', errorCode: 'provider_server_error' }),
    }]);
    expect(w.messages.filter(msg => msg.type === 'turn_terminal' && msg.status !== 'completed')).toEqual([]);
  }, 90_000);
});
