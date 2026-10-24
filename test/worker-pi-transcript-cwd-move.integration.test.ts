import { type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { piSessionDirName } from '../src/services/pi-transcript.js';

// Real worker, fake `pi` that files its session the way Pi does: `--session-id`
// is looked up ONLY in the current cwd's session directory, and when it is not
// there Pi starts a new file with that id a moment after launch. This is the
// 2026-10-21 incident: the review worktree was deleted, the session
// cold-resumed in another directory, and the conclusion Pi wrote never reached
// the group because the bridge was still reading the old worktree's file.

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

async function waitUntil(check: () => boolean, logs: string[], timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    if (child?.exitCode !== null || child?.signalCode !== null) throw new Error(`Worker exited\n${logs.join('')}`);
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error(`Timed out\n${logs.join('')}`);
}

/** Fake Pi. No `require`: /tmp may carry a `"type":"module"` package.json, and
 *  this extension-less script must run as CJS or ESM alike. `answer` empty means
 *  Pi never gets to the prompt (nothing is written for it). */
function fakePiSource(answer: string): string {
  return `#!/usr/bin/env node
(async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const args = process.argv.slice(2);
  const sid = args[args.indexOf('--session-id') + 1];
  const cwd = process.cwd();
  const dir = path.join(os.homedir(), '.pi', 'agent', 'sessions',
    '--' + cwd.replace(/^[/\\\\]/, '').replace(/[/\\\\:]/g, '-') + '--');
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir).find(name => name.endsWith('_' + sid + '.jsonl'));
  const file = existing
    ? path.join(dir, existing)
    : path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '_' + sid + '.jsonl');
  const at = () => new Date().toISOString();
  const write = rows => fs.appendFileSync(file, rows.map(row => JSON.stringify(row)).join('\\n') + '\\n');
  const sleep = ms => new Promise(done => setTimeout(done, ms));
  process.stdin.resume();
  setInterval(() => {}, 1000);
  await sleep(400);
  if (!existing) write([{ type: 'session', version: 3, id: sid, timestamp: at(), cwd }]);
  write([
    { type: 'custom', customType: 'botmux-turn-settled', data: { lastStopReason: null }, timestamp: at() },
    { type: 'message', timestamp: at(), message: { role: 'system', content: '', sections: { preamble: 'pi' } } },
  ]);
  ${answer ? '' : 'return;'}
  let prompt = args[args.length - 1];
  if (prompt.startsWith('@/')) {
    const source = prompt.slice(1);
    prompt = '<file name="' + source + '">\\n' + fs.readFileSync(source, 'utf8') + '\\n</file>';
  }
  write([{ type: 'message', timestamp: at(), message: { role: 'user', content: [{ type: 'text', text: prompt }] } }]);
  await sleep(300);
  write([
    { type: 'message', timestamp: at(), message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'git log -1' } }] } },
    { type: 'message', timestamp: at(), message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: '64b84e46' }] } },
    { type: 'message', timestamp: at(), message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: ${JSON.stringify(answer)} }] } },
    { type: 'custom', customType: 'botmux-turn-settled', data: { lastStopReason: 'stop' }, timestamp: at() },
  ]);
})();
`;
}

function startResumedWorker(answer: string) {
  root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-cwd-move-'));
  const dataDir = join(root, 'data');
  const newCwd = join(root, 'home');
  const oldCwd = join(root, 'deleted-review-worktree');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(newCwd, { recursive: true });
  // Botmux hands Pi its own session id, so the two are the same UUID.
  const cliSessionId = '532763c5-4edc-4a44-9f10-3885639207f1';
  // The session's earlier life, filed under the worktree that no longer exists.
  const oldDir = join(root, '.pi', 'agent', 'sessions', piSessionDirName(oldCwd));
  mkdirSync(oldDir, { recursive: true });
  const oldTranscript = join(oldDir, `2026-10-12T01-33-02-359Z_${cliSessionId}.jsonl`);
  writeFileSync(oldTranscript, [
    { type: 'session', version: 3, id: cliSessionId, timestamp: '2026-10-12T01:33:02.359Z', cwd: oldCwd },
    { type: 'message', timestamp: '2026-10-12T01:33:05.000Z', message: { role: 'user', content: [{ type: 'text', text: 'first review' }] } },
    { type: 'message', timestamp: '2026-10-12T01:40:00.000Z', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'old conclusion' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const oldBytes = readFileSync(oldTranscript, 'utf8');

  const fakePi = join(root, 'fake-pi');
  writeFileSync(fakePi, fakePiSource(answer));
  chmodSync(fakePi, 0o755);

  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env, HOME: root, SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: cliSessionId, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('message', raw => { messages.push(raw as WorkerToDaemon); });
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.send({
    type: 'init', sessionId: cliSessionId, chatId: 'oc_test', rootMessageId: 'om_root',
    workingDir: newCwd, cliId: 'pi', cliPathOverride: fakePi, cliSessionId, resume: true,
    backendType: 'pty', prompt: '@Pure(pi) #1809 接着做完复审，给结论', larkAppId: 'app_test', larkAppSecret: 'test-only',
    turnId: 'om_pi_turn', promptInjection: 'none',
  } satisfies DaemonToWorker);
  return { messages, logs, oldTranscript, oldBytes, newCwd };
}

describe('Pi worker: a session resumed in a different cwd', () => {
  it('reads the transcript Pi starts in the new cwd and forwards the conclusion', async () => {
    const answer = '已跑完，结论先给：head 64b84e46 可以直接合。';
    const { messages, logs, oldTranscript, oldBytes, newCwd } = startResumedWorker(answer);

    await waitUntil(() => messages.some(msg => msg.type === 'final_output'), logs);
    const finals = messages.filter((msg): msg is Extract<WorkerToDaemon, { type: 'final_output' }> => msg.type === 'final_output');
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ turnId: 'om_pi_turn', content: answer });
    expect(messages.some(msg => msg.type === 'user_notify')).toBe(false);
    // The bridge followed Pi's new file, not the old one Pi never touched.
    const attached = logs.join('').match(/Codex bridge fresh-empty: (\S+)/)?.[1];
    expect(attached).toContain(`/${piSessionDirName(newCwd)}/`);
    expect(readFileSync(oldTranscript, 'utf8')).toBe(oldBytes);
  }, 30_000);

  it('tells the thread when the turn never shows up in the transcript', async () => {
    const { messages, logs } = startResumedWorker('');

    await waitUntil(() => messages.some(msg => msg.type === 'user_notify'), logs, 40_000);
    const notice = messages.find((msg): msg is Extract<WorkerToDaemon, { type: 'user_notify' }> => msg.type === 'user_notify')!;
    expect(notice.turnId).toBe('om_pi_turn');
    expect(notice.message).toMatch(/采集不到本轮回复|cannot collect the reply/);
    expect(messages.some(msg => msg.type === 'final_output')).toBe(false);
  }, 60_000);
});
