import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const tmuxAvailable = probeTmuxFunctional().ok;
for (const mode of ['banner', 'resume', 'slow-resume', 'tmux-resume', 'coloured-resume']) {
  const backendType = process.env.BOTMUX_TEST_WORKER_BINARY || mode === 'tmux-resume' || mode === 'coloured-resume' ? 'tmux' : 'pty';
  it.skipIf(backendType === 'tmux' && !tmuxAvailable)(
    `holds input during loading, submits once after ${mode}, and commits only after confirmation`,
    () => runStartupScenario(mode, backendType),
    115_000,
  );
}

async function runStartupScenario(mode: string, backendType: 'tmux' | 'pty'): Promise<void> {
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
  const confirmFile = join(root, 'confirm');
  const cliPidFile = join(root, 'cli-pid');
  const fakeCli = join(root, 'fake-codex');
  writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const codexDir = path.join(require('node:os').homedir(), '.codex');
fs.mkdirSync(path.join(codexDir, 'sessions'), {recursive:true});
const sid = '11111111-2222-4333-8444-555555555555';
const rolloutFd = fs.openSync(path.join(codexDir, 'sessions', 'rollout-2026-09-14T00-00-00-' + sid + '.jsonl'), 'a');
let input = '', recorded = false;
fs.writeFileSync(${JSON.stringify(cliPidFile)}, String(process.pid));
process.stdin.setRawMode(true);
process.stdin.on('data', b => { input += b.toString(); fs.appendFileSync(${JSON.stringify(inputFile)}, b); });
setInterval(() => {
  const match = input.match(/\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~/);
  if (!recorded && match && input.includes('\\r') && fs.existsSync(${JSON.stringify(confirmFile)})) {
    recorded = true;
    fs.appendFileSync(path.join(codexDir, 'history.jsonl'), JSON.stringify({session_id:sid, text:match[1], ts:Date.now()/1000})+'\\n');
  }
}, 25);
const banner = '\\x1b[?2004h│ model: loading /model to change │\\n│ directory: loading │\\n› Ask Codex to do anything\\n  ? for shortcuts';
process.stdout.write(banner);
// Redraw after tmux subscribes to pipe-pane so the worker observes startup loading.
for (const delay of [200, 400, 700, 1000]) {
  setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[H' + banner), delay);
}
fs.writeFileSync(${JSON.stringify(loadingFile)}, 'ready');
const poll = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(releaseFile)})) return;
  clearInterval(poll);
  process.stdout.write(${JSON.stringify(mode !== 'banner'
    ? '\x1b[2J\x1b[H Earlier messages are available — press ctrl + t to view the full transcript\r\n' + (mode === 'coloured-resume'
      ? '\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\r\n\x1b[0m\x1b[39m\x1b[49m\r\n  \x1b[36mcustom-model\x1b[0m · \x1b[32m/tmp\x1b[0m'
      : '› Ask Codex to do anything\r\n\r\n  custom-model · /tmp')
    : '\x1b[2J\x1b[H│ model: custom-model /model to change │\r\n│ directory: /tmp │\r\n› Ask Codex to do anything\r\n  custom-model · /tmp')});
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
      env: { ...process.env, TMUX_TMPDIR: root, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    };
    child = process.env.BOTMUX_TEST_WORKER_BINARY
      ? spawn(process.env.BOTMUX_TEST_WORKER_BINARY, ['__worker'], spawnOptions)
      : spawnNodeTsScript(resolve('src/worker.ts'), [], spawnOptions);
    child.on('message', m => messages.push(m as WorkerToDaemon));
    child.stdout?.on('data', b => logs.push(b.toString()));
    child.stderr?.on('data', b => logs.push(b.toString()));
    child.send({
      type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir: dataDir, cliId: 'codex', cliPathOverride: fakeCli,
      backendType,
      prompt: 'only-this-startup-prompt', turnId: 'om_test', larkAppId: 'app_test', larkAppSecret: 'secret',
    } satisfies DaemonToWorker);
    await waitFor(() => existsSync(loadingFile));
    // Cross the real 2s screen-idle threshold while startup remains blocked.
    await new Promise(r => setTimeout(r, 3_200));
    expect(existsSync(inputFile), logs.join('')).toBe(false);
    expect(messages.some(m => m.type === 'prompt_ready')).toBe(false);
    expect(messages.some(m => m.type === 'turn_input_committed')).toBe(false);
    if (mode === 'slow-resume') {
      await waitFor(() => messages.some(m => m.type === 'user_notify' && m.message.includes('90 秒')), 95_000);
      expect(existsSync(inputFile), logs.join('')).toBe(false);
      expect(messages.some(m => m.type === 'turn_input_committed')).toBe(false);
    }
    writeFileSync(releaseFile, 'loaded');
    if (backendType === 'tmux') {
      let viewport = '';
      await waitFor(() => {
        viewport = execFileSync('tmux', ['capture-pane', '-e', '-p'], {
          env: { ...process.env, TMUX_TMPDIR: root }, encoding: 'utf8',
        });
        return viewport.includes('custom-model');
      });
      if (mode === 'coloured-resume') expect(viewport).toMatch(/\x1b\[[0-9;]*m›/);
    }
    await waitFor(() => existsSync(inputFile));
    const text = readFileSync(inputFile, 'utf8');
    expect(text.match(/only-this-startup-prompt/g)).toHaveLength(1);
    expect(text).toContain('\x1b[200~');
    expect(messages.some(m => m.type === 'turn_input_committed')).toBe(false);
    writeFileSync(confirmFile, 'confirm');
    await waitFor(() => messages.some(m => m.type === 'turn_input_committed' && m.turnId === 'om_test'));
    expect(readFileSync(inputFile, 'utf8').match(/only-this-startup-prompt/g)).toHaveLength(1);
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
}
