import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const backendType = process.env.BOTMUX_TEST_WORKER_BINARY ? 'tmux' : 'pty';
for (const xpiEnabled of ['false', 'true']) {
it.skipIf(backendType === 'tmux' && !probeTmuxFunctional().ok)(
  `queues collaborative inputs until real Codex completion with XPI=${xpiEnabled}`,
  async () => {
  // Linux systemd scopes are host-wide, even with an isolated HOME/TMPDIR.
  const sessionId = randomUUID();
  // The unit runner owns this disposable home. Linux devboxes can have umask
  // 0002; the second worker must not inherit a group-writable credential dir.
  const botmuxDir = join(homedir(), '.botmux');
  mkdirSync(botmuxDir, { recursive: true, mode: 0o700 });
  chmodSync(botmuxDir, 0o700);
  const root = mkdtempSync(join(backendType === 'tmux' ? '/tmp' : tmpdir(), 'bmx-startup-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const loadingFile = join(root, 'loading');
  const releaseFile = join(root, 'release');
  const inputFile = join(root, 'input');
  const finishFile = join(root, 'finish');
  const cliPidFile = join(root, 'cli-pid');
  const fakeCli = join(root, 'fake-codex');
  writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const codexDir = path.join(require('node:os').homedir(), '.codex');
fs.mkdirSync(path.join(codexDir, 'sessions'), {recursive:true});
const sid = '11111111-2222-4333-8444-555555555555';
const rolloutFd = fs.openSync(path.join(codexDir, 'sessions', 'rollout-2026-09-14T00-00-00-' + sid + '.jsonl'), 'a');
let input = '', count = 0, finished = 0;
const event = (type, payload) => fs.writeSync(rolloutFd, JSON.stringify({timestamp:new Date().toISOString(),type,payload})+'\\n');
event('session_meta', {id:sid, cwd:process.cwd()});
fs.writeFileSync(${JSON.stringify(cliPidFile)}, String(process.pid));
process.stdin.setRawMode(true);
process.stdin.on('data', b => { input += b.toString(); fs.appendFileSync(${JSON.stringify(inputFile)}, b); });
setInterval(() => {
  const match = input.match(/\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~\\r/);
  if (match) {
    input = input.slice(input.indexOf(match[0])+match[0].length);
    count++;
    fs.appendFileSync(path.join(codexDir, 'history.jsonl'), JSON.stringify({session_id:sid, text:match[1], ts:Date.now()/1000})+'\\n');
    event('response_item', {type:'message', role:'user', content:[{type:'input_text', text:match[1]}]});
    process.stdout.write('\\x1b[2J\\x1b[H• Working (esc to interrupt)\\r\\n');
  }
  const finish = fs.existsSync(${JSON.stringify(finishFile)}) ? Number(fs.readFileSync(${JSON.stringify(finishFile)}, 'utf8')) : 0;
  if (count > finished && finish === count) {
    finished = count;
    event('event_msg', {type:'task_complete', turn_id:'native-'+count, last_agent_message:'Task complete '+count});
    process.stdout.write('\\x1b[2J\\x1b[H› Ask Codex to do anything\\r\\n\\r\\n custom-model · /tmp');
  }
}, 25);
process.stdout.write('\\x1b[?2004h│ model: loading /model to change │\\n│ directory: loading │\\n› Ask Codex to do anything\\n  ? for shortcuts');
fs.writeFileSync(${JSON.stringify(loadingFile)}, 'ready');
const poll = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(releaseFile)})) return;
  clearInterval(poll);
  process.stdout.write('\\x1b[2J\\x1b[H│ model: custom-model /model to change │\\r\\n│ directory: /tmp │\\r\\n› Ask Codex to do anything\\r\\n\\r\\n custom-model · /tmp');
}, 50);
setInterval(() => {}, 1000);
`);
  chmodSync(fakeCli, 0o755);
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  let child: ChildProcess | undefined;
  const waitFor = async (condition: () => boolean, timeoutMs = 12_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() >= deadline || child?.exitCode != null) throw new Error(logs.join(''));
      await new Promise(r => setTimeout(r, 25));
    }
  };
  try {
    const spawnOptions: SpawnOptions = {
      cwd: resolve('.'),
      env: { ...process.env, BOTMUX_XPI_ENABLED: xpiEnabled, TMUX_TMPDIR: root, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    };
    child = process.env.BOTMUX_TEST_WORKER_BINARY
      ? spawn(process.env.BOTMUX_TEST_WORKER_BINARY, ['__worker'], spawnOptions)
      : spawnNodeTsScript(resolve('src/worker.ts'), [], spawnOptions);
    child.on('message', m => messages.push(m as WorkerToDaemon));
    child.stdout?.on('data', b => logs.push(b.toString()));
    child.stderr?.on('data', b => logs.push(b.toString()));
    const owner = { requestUserOpenId: 'ou_a', requestLarkAppId: 'app_test', senderType: 'user' as const };
    const other = { ...owner, requestUserOpenId: 'ou_b' };
    child.send({
      type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir: dataDir, cliId: 'codex', cliPathOverride: fakeCli, backendType,
      prompt: 'first-task', turnId: 'om_first', trustedCaller: owner,
      larkAppId: 'app_test', larkAppSecret: 'secret',
    } satisfies DaemonToWorker);
    await waitFor(() => existsSync(loadingFile));
    writeFileSync(releaseFile, 'loaded');
    // Observe CLI input directly: enqueue ACKs do not prove the task was submitted.
    await waitFor(() => existsSync(inputFile) && readFileSync(inputFile, 'utf8').includes('first-task'));
    // Opting into XPI still rejects unmarked cross-principal steering.
    if (xpiEnabled === 'true') {
      child.send({ type: 'message', content: 'must-not-run', turnId: 'om_reject', trustedCaller: other } satisfies DaemonToWorker);
      await waitFor(() => messages.some(m => m.type === 'turn_input_rejected' && m.turnId === 'om_reject'));
    }
    for (const [turnId, content] of [['om_second', 'second-task'], ['om_third', 'third-task']]) {
      child.send({ type: 'message', turnId, content, trustedCaller: other, queueAfterActiveTurn: true } satisfies DaemonToWorker);
    }
    await waitFor(() => messages.some(m => m.type === 'turn_input_received' && m.turnId === 'om_third'));
    // Cross the prompt-idle threshold: an unfinished transcript still owns the CLI.
    await new Promise(r => setTimeout(r, 3_200));
    expect(readFileSync(inputFile, 'utf8')).not.toContain('second-task');
    expect(messages.some(m => m.type === 'turn_input_rejected' && m.turnId === 'om_second')).toBe(false);
    writeFileSync(finishFile, '1');
    await waitFor(() => existsSync(inputFile) && readFileSync(inputFile, 'utf8').includes('second-task'));
    await new Promise(r => setTimeout(r, 3_200));
    expect(readFileSync(inputFile, 'utf8')).not.toContain('third-task');
    writeFileSync(finishFile, '2');
    await waitFor(() => existsSync(inputFile) && readFileSync(inputFile, 'utf8').includes('third-task'));
    const submitted = readFileSync(inputFile, 'utf8');
    expect(submitted.match(/(?:first|second|third)-task/g)).toEqual(['first-task', 'second-task', 'third-task']);
    expect(submitted).not.toContain('must-not-run');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(r => child!.once('exit', () => r()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise(r => setTimeout(r, 2_000))]);
    }
    if (existsSync(cliPidFile)) {
      try { process.kill(Number(readFileSync(cliPidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
    }
    if (backendType === 'tmux') {
      try { execFileSync('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: root }, stdio: 'ignore' }); } catch { /* exited */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
}
