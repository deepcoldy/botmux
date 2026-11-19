import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { killProcessTree } from './helpers/process-tree.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import { preferredManagedTmuxSocket, tmuxSocketArgs } from '../src/adapters/backend/tmux-socket.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

// Real worker, fake codex drawing the 0.166+ startup frames of #3289 and
// reporting OSC 7501 the way codex-cli 0.164–0.167 does (recorded):
//   startup  idle on the provisional composer (no footer yet: the box
//            refuses input) → working → idle once initialized;
//   turn     idle on the first keystroke → working → [blocked on an
//            approval → working] → done.
const tmuxAvailable = probeTmuxFunctional().ok;
const SID = '22222222-3333-4444-8555-666666666666';
const HEADER = '\x1b[2J\x1b[H\r\n  >_ OpenAI Codex (v0.167.0)\r\n     /tmp/work\r\n';
const PROVISIONAL = `${HEADER}\r\n\r\n› Ask Codex to do anything\x1b[6;3H`;
const READY = `${HEADER}  permissions: YOLO mode\r\n\r\n\r\n› Ask Codex to do anything\r\n\r\n  custom-model · /tmp/work\x1b[7;3H`;
// The approval page keeps a composer-looking `›` row and goes quiet: the
// screen heuristics read it as idle after 2s.
const APPROVAL = `${HEADER}\r\n  Would you like to run the following command?\r\n  $ touch marker\r\n› 1. Yes, proceed (y)\r\n  2. No, and tell Codex what to do differently (esc)\r\n  Press enter to confirm or esc to cancel`;
const report = (state: string, extra = '') => `\x1b]7501;state=${state}:app=codex${extra}\x1b\\`;

interface Run {
  messages: WorkerToDaemon[];
  input: () => string;
  send: (msg: DaemonToWorker) => void;
  waitFor: (condition: () => boolean, label: string, timeoutMs?: number) => Promise<void>;
  logs: () => string;
  signal: () => void;
  /** Pastes the fake had received when it drew `label` (step index or a turn event). */
  pastesAt: (label: string) => number | undefined;
}

async function withWorker(
  backendType: 'pty' | 'tmux',
  cliVersion: string,
  approval: boolean,
  body: (h: Run) => Promise<void>,
): Promise<void> {
  const sessionId = randomUUID();
  const botmuxDir = join(homedir(), '.botmux');
  mkdirSync(botmuxDir, { recursive: true, mode: 0o700 });
  chmodSync(botmuxDir, 0o700);
  writeFileSync(join(homedir(), '.zshrc'), '# isolated worker test\n');
  const root = mkdtempSync('/tmp/bmx-codex-osc7501-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const inputFile = join(root, 'input');
  const cliPidFile = join(root, 'cli-pid');
  const drawsFile = join(root, 'draws');
  const signalFile = join(root, 'signal');
  const fakeCli = join(root, 'fake-codex');
  writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const codexDir = path.join(require('node:os').homedir(), '.codex');
fs.mkdirSync(path.join(codexDir, 'sessions'), {recursive:true});
const sid = ${JSON.stringify(SID)};
const rolloutFd = fs.openSync(path.join(codexDir, 'sessions', 'rollout-2026-11-12T00-00-00-' + sid + '.jsonl'), 'a');
const event = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\\n';
fs.writeSync(rolloutFd, event('session_meta', { id: sid, cwd: process.cwd() }));
fs.writeFileSync(${JSON.stringify(cliPidFile)}, String(process.pid));
const R = ${JSON.stringify({ PROVISIONAL, READY, APPROVAL, idle: report('idle'), working: report('working'), done: report('done'), blocked: report('blocked', ':kind=permission') })};
const approval = ${JSON.stringify(approval)};
let input = '', recorded = 0;
const pastes = () => input.split('\\x1b[200~').length - 1;
function draw(label, bytes) {
  fs.appendFileSync(${JSON.stringify(drawsFile)}, label + ' ' + pastes() + '\\n');
  process.stdout.write(bytes);
}
process.stdout.write('\\x1b[?2004h');
process.stdin.setRawMode(true);
// Provisional composer + its idle report, repainted while the output pipe
// may still be attaching; it stays up well past screen quiescence.
for (const at of [0, 200, 500, 1000, 1500]) setTimeout(() => draw('provisional-' + at, R.PROVISIONAL + (at === 0 ? R.idle + R.working + R.idle : '')), at);
// Initialization finishes at 6s unless input already started a turn.
setTimeout(() => { if (recorded === 0) draw('ready', R.READY + R.idle); }, 6000);
process.stdin.on('data', b => {
  input += b.toString();
  fs.appendFileSync(${JSON.stringify(inputFile)}, b);
  const frames = [...input.matchAll(/\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~\\r/g)];
  for (const m of frames.slice(recorded)) {
    recorded++;
    const turn = recorded;
    fs.appendFileSync(path.join(codexDir, 'history.jsonl'), JSON.stringify({session_id:sid, text:m[1], ts:Date.now()/1000})+'\\n');
    draw('turn-' + turn + '-start', R.idle + R.working + '\\r\\n• Working (0s • esc to interrupt)');
    const finish = () => {
      fs.writeSync(rolloutFd, event('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: m[1] }] })
        + event('event_msg', { type: 'task_complete', turn_id: 'native-' + turn, last_agent_message: 'reply ' + turn }));
      draw('turn-' + turn + '-done', R.done + R.READY);
    };
    if (approval && turn === 1) {
      setTimeout(() => draw('turn-1-blocked', R.blocked + R.APPROVAL), 300);
    } else {
      setTimeout(finish, 400);
    }
    if (approval && turn === 1) globalThis.finishFirst = finish;
  }
});
setInterval(() => {
  if (globalThis.finishFirst && fs.existsSync(${JSON.stringify(signalFile)})) {
    const finish = globalThis.finishFirst;
    globalThis.finishFirst = undefined;
    draw('turn-1-approved', R.working + R.READY);
    setTimeout(finish, 300);
  }
}, 50);
`);
  chmodSync(fakeCli, 0o755);
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  let child: ChildProcess | undefined;
  const waitFor = async (condition: () => boolean, label: string, timeoutMs = 12_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() >= deadline || child?.exitCode != null) throw new Error(`${label}\n${logs.join('').slice(-8000)}`);
      await new Promise(r => setTimeout(r, 25));
    }
  };
  try {
    const spawnOptions: SpawnOptions = {
      cwd: resolve('.'),
      env: privateTmuxEnv(root, { SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret' }),
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
      workingDir: dataDir, cliId: 'codex', cliPathOverride: fakeCli, backendType, cliVersion,
      prompt: 'first-prompt', turnId: 'om_first', larkAppId: 'app_test', larkAppSecret: 'secret',
    } satisfies DaemonToWorker);
    await body({
      messages,
      input: () => (existsSync(inputFile) ? readFileSync(inputFile, 'utf8') : ''),
      send: msg => child!.send(msg),
      waitFor,
      logs: () => logs.join(''),
      signal: () => appendFileSync(signalFile, 's'),
      pastesAt: label => {
        if (!existsSync(drawsFile)) return undefined;
        const line = readFileSync(drawsFile, 'utf8').split('\n').find(l => l.startsWith(`${label} `));
        return line === undefined ? undefined : Number(line.split(' ')[1]);
      },
    });
  } finally {
    if (child) await killProcessTree(child);
    if (existsSync(cliPidFile)) {
      try { process.kill(Number(readFileSync(cliPidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
    }
    for (const socket of new Set([undefined, preferredManagedTmuxSocket(privateTmuxEnv(root))])) {
      try { execFileSync('tmux', [...tmuxSocketArgs(socket), 'kill-server'], { env: privateTmuxEnv(root), stdio: 'ignore' }); } catch { /* exited */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const pasted = (text: string, content: string) => text.split(`\x1b[200~${content}\x1b[201~`).length - 1;
const readyCount = (messages: WorkerToDaemon[]) => messages.filter(m => m.type === 'prompt_ready').length;

for (const backendType of process.env.BOTMUX_TEST_WORKER_BINARY ? ['tmux'] as const : ['pty', 'tmux'] as const) {
  it.skipIf(backendType === 'tmux' && !tmuxAvailable)(`codex ${backendType}: the provisional-composer idle report does not release the first message (#3289)`, async () => {
    await withWorker(backendType, '0.167.0', false, async h => {
      await h.waitFor(() => h.pastesAt('turn-1-start') !== undefined, 'first message written', 30_000);
      // codex reported idle → working → idle with the first, provisional
      // frame. Taking that as readiness wrote the first message at once; the
      // screen gates still decide, so nothing went in before the screen
      // could (2s quiescence) — and on tmux, where the worker reads the input
      // box itself, not before the initialized composer (#3289).
      expect(h.pastesAt('provisional-1500'), h.logs()).toBe(0);
      if (backendType === 'tmux') expect(h.pastesAt('ready'), h.logs()).toBe(0);
      // PTY has no backend input-box read; its first write keeps the screen
      // path's 2s quiescence on the composer marker, as before this change.
      await h.waitFor(() => h.pastesAt('turn-1-done') !== undefined, 'first turn ran');
      expect(pasted(h.input(), 'first-prompt')).toBe(1);
      await h.waitFor(() => h.logs().includes('[program-status] status received'), 'reports parsed after the first write');
      h.send({ type: 'message', content: 'second', turnId: 'om_second' });
      await h.waitFor(() => h.pastesAt('turn-2-done') !== undefined, 'second turn ran');
      expect(pasted(h.input(), 'second')).toBe(1);
    });
  }, 60_000);

  it.skipIf(backendType === 'tmux' && !tmuxAvailable)(`codex ${backendType}: a quiet approval page stays working until codex reports done`, async () => {
    await withWorker(backendType, '0.167.0', true, async h => {
      await h.waitFor(() => h.pastesAt('turn-1-blocked') !== undefined, 'approval page drawn', 30_000);
      const readyBefore = readyCount(h.messages);
      // Past screen quiescence (2s) and the spinner guard (3s): the old screen
      // path published prompt-ready here and would type into the approval.
      await new Promise(r => setTimeout(r, 6_000));
      expect(readyCount(h.messages), h.logs()).toBe(readyBefore);
      h.send({ type: 'message', content: 'queued-during-approval', turnId: 'om_second' });
      await new Promise(r => setTimeout(r, 1_500));
      expect(pasted(h.input(), 'queued-during-approval'), h.logs()).toBe(0);
      h.signal();
      await h.waitFor(() => h.pastesAt('turn-1-done') !== undefined, 'approval answered, turn done');
      await h.waitFor(() => pasted(h.input(), 'queued-during-approval') === 1, 'queued message delivered after done');
      expect(h.pastesAt('turn-1-done')).toBe(1);
    });
  }, 60_000);

  it.skipIf(backendType === 'tmux' && !tmuxAvailable)(`codex ${backendType}: below 0.163.0 the reports are ignored (screen path, as before)`, async () => {
    await withWorker(backendType, '0.162.0', true, async h => {
      await h.waitFor(() => h.pastesAt('turn-1-blocked') !== undefined, 'approval page drawn', 30_000);
      await h.waitFor(() => h.logs().includes('reports not parsed'), 'gate logged');
      expect(h.logs()).not.toContain('[program-status] status received');
      h.signal();
      await h.waitFor(() => h.pastesAt('turn-1-done') !== undefined, 'turn done');
    });
  }, 60_000);
}
