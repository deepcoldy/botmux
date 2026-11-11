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

// Real worker, real tmux, fake Codex that draws the Codex 0.166 startup frames.
const tmuxAvailable = probeTmuxFunctional().ok;
const SID = '11111111-2222-4333-8444-555555555555';
const HEADER = '\x1b[2J\x1b[H\r\n  >_ OpenAI Codex (v0.166.0)\r\n     /tmp/work\r\n';
// The composer before its footer exists: `›` is on screen, the box refuses input.
const PROVISIONAL = `${HEADER}\r\n\r\n› Ask Codex to do anything\x1b[6;3H`;
const READY = `${HEADER}  permissions: YOLO mode\r\n\r\n\r\n› Ask Codex to do anything\r\n\r\n  custom-model · /tmp/work\x1b[7;3H`;
const DRAFT = `${HEADER}  permissions: YOLO mode\r\n\r\n\r\n› half-typed note\r\n\r\n  custom-model · /tmp/work\x1b[7;19H`;
// Only the footer, cursor-addressed: tmux shows the full box, the output pipe
// (attached after the first paint) never carries a prompt marker.
const FOOTER_ONLY = '\x1b[4;3Hpermissions: YOLO mode\x1b[8;3Hcustom-model · /tmp/work\x1b[6;3H';
// A draft typed into READY and erased again, cursor-addressed: no prompt marker.
const DRAFT_ONLY = '\x1b[7;3H\x1b[Khalf-typed note';
const DRAFT_ERASED = '\x1b[7;3H\x1b[KAsk Codex to do anything\x1b[7;3H';
const DRAFT_HOLD_MS = 4_000;

type Step = { atMs: number; frame: string };

interface Scenario {
  /** Frames by time since the fake CLI started. */
  steps: Step[];
  /** Frame drawn when a bare (non-paste) Enter arrives, then onCommandClear
   *  (default READY) after DRAFT_HOLD_MS. */
  onCommandEnter?: string;
  onCommandClear?: string;
  /** Frame drawn on each signal() call, in order (labelled `signal-N`). */
  onSignal?: string[];
  /** Delay tmux's output-pipe attach, as a loaded tmux server does. */
  pipeAttachDelayS?: number;
  init?: Partial<Extract<DaemonToWorker, { type: 'init' }>>;
}

async function withWorker(
  scenario: Scenario,
  body: (h: {
    messages: WorkerToDaemon[];
    input: () => string;
    send: (msg: DaemonToWorker) => void;
    waitFor: (condition: () => boolean, timeoutMs?: number) => Promise<void>;
    logs: () => string;
    /** Pastes the fake CLI had received when it drew step `index` (or the
     *  `draft` / `clear` frames of onCommandEnter, or `signal-N`), if drawn. */
    pastesWhenDrawn: (index: number | string) => number | undefined;
    signal: () => void;
  }) => Promise<void>,
): Promise<void> {
  const sessionId = randomUUID();
  const botmuxDir = join(homedir(), '.botmux');
  mkdirSync(botmuxDir, { recursive: true, mode: 0o700 });
  chmodSync(botmuxDir, 0o700);
  writeFileSync(join(homedir(), '.zshrc'), '# isolated worker test\n');
  const root = mkdtempSync('/tmp/bmx-codex-first-');
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
const rolloutFd = fs.openSync(path.join(codexDir, 'sessions', 'rollout-2026-09-14T00-00-00-' + sid + '.jsonl'), 'a');
const event = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\\n';
fs.writeSync(rolloutFd, event('session_meta', { id: sid, cwd: process.cwd() }));
fs.writeFileSync(${JSON.stringify(cliPidFile)}, String(process.pid));
let input = '', recorded = 0, commandHandled = false;
process.stdout.write('\\x1b[?2004h');
process.stdin.setRawMode(true);
process.stdin.on('data', b => {
  input += b.toString();
  fs.appendFileSync(${JSON.stringify(inputFile)}, b);
  const frames = [...input.matchAll(/\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~\\r/g)];
  for (const m of frames.slice(recorded)) {
    recorded++;
    fs.appendFileSync(path.join(codexDir, 'history.jsonl'), JSON.stringify({session_id:sid, text:m[1], ts:Date.now()/1000})+'\\n');
    // Each submit is one short turn that ends back at the empty input box.
    const turn = recorded;
    setTimeout(() => {
      fs.writeSync(rolloutFd, event('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: m[1] }] })
        + event('event_msg', { type: 'task_complete', turn_id: 'native-' + turn, last_agent_message: 'reply ' + turn }));
      process.stdout.write(${JSON.stringify(READY)});
    }, 300);
  }
  const onEnter = ${JSON.stringify(scenario.onCommandEnter ?? null)};
  if (onEnter && !commandHandled && !input.includes('\\x1b[200~') && input.includes('\\r')) {
    commandHandled = true;
    draw('draft', onEnter);
    setTimeout(() => draw('clear', ${JSON.stringify(scenario.onCommandClear ?? READY)}), ${DRAFT_HOLD_MS});
  }
});
const pastes = () => input.split('\\x1b[200~').length - 1;
function draw(label, frame) {
  fs.appendFileSync(${JSON.stringify(drawsFile)}, label + ' ' + pastes() + '\\n');
  process.stdout.write(frame);
}
${JSON.stringify(scenario.steps)}.forEach((step, i) => {
  if (step.atMs <= 0) draw(i, step.frame); else setTimeout(() => draw(i, step.frame), step.atMs);
});
const onSignal = ${JSON.stringify(scenario.onSignal ?? [])};
let signalled = 0;
setInterval(() => {
  const count = fs.existsSync(${JSON.stringify(signalFile)}) ? fs.readFileSync(${JSON.stringify(signalFile)}, 'utf8').length : 0;
  while (signalled < Math.min(count, onSignal.length)) { signalled++; draw('signal-' + signalled, onSignal[signalled - 1]); }
}, 50);
setInterval(() => {}, 1000);
`);
  chmodSync(fakeCli, 0o755);
  let path = process.env.PATH ?? '';
  if (scenario.pipeAttachDelayS) {
    const realTmux = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
    const shimDir = join(root, 'shim');
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, 'tmux'), `#!/bin/sh\ncase " $* " in *" pipe-pane "*) sleep ${scenario.pipeAttachDelayS} ;; esac\nexec ${realTmux} "$@"\n`, { mode: 0o755 });
    path = `${shimDir}:${path}`;
  }
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
      env: privateTmuxEnv(root, { PATH: path, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret' }),
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
      workingDir: dataDir, cliId: 'codex', cliPathOverride: fakeCli, backendType: 'tmux',
      prompt: 'first-prompt', turnId: 'om_first', larkAppId: 'app_test', larkAppSecret: 'secret',
      ...scenario.init,
    } satisfies DaemonToWorker);
    await body({
      messages,
      input: () => (existsSync(inputFile) ? readFileSync(inputFile, 'utf8') : ''),
      send: msg => child!.send(msg),
      waitFor,
      logs: () => logs.join(''),
      pastesWhenDrawn: index => {
        if (!existsSync(drawsFile)) return undefined;
        const line = readFileSync(drawsFile, 'utf8').split('\n').find(l => l.startsWith(`${index} `));
        return line === undefined ? undefined : Number(line.split(' ')[1]);
      },
      signal: () => appendFileSync(signalFile, 's'),
    });
  } finally {
    // Together with any tmux call it still has in flight: TMUX_TMPDIR goes below.
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
const committed = (messages: WorkerToDaemon[], turnId: string) =>
  messages.some(m => m.type === 'turn_input_committed' && m.turnId === turnId);
const activationAcked = (messages: WorkerToDaemon[], token: string) =>
  messages.some(m => m.type === 'queued_activation_submitted' && m.activationToken === token);

it.skipIf(!tmuxAvailable)('holds the first message through the provisional startup frame, delivers it once, then drains the follow-up', async () => {
  // Re-paint the provisional frame until the pipe has surely attached, then
  // keep it long enough for the prompt-idle edge (2s quiet) to fire on it.
  const steps = [0, 200, 500, 1000].map(atMs => ({ atMs, frame: PROVISIONAL }));
  steps.push({ atMs: 6_000, frame: READY });
  await withWorker({ steps, init: { queuedActivationToken: 'qa-token-1' } }, async h => {
    await h.waitFor(() => h.pastesWhenDrawn(steps.length - 1) !== undefined, 30_000);
    expect(h.pastesWhenDrawn(steps.length - 1), h.logs()).toBe(0);
    expect(h.logs()).toContain('input box is not ready yet');
    expect(h.messages.filter(m => m.type === 'user_notify'), h.logs()).toEqual([]);
    // The daemon buffers follow-ups until the opening's activation ACK.
    await h.waitFor(() => activationAcked(h.messages, 'qa-token-1'), 10_000);
    expect(pasted(h.input(), 'first-prompt')).toBe(1);
    h.send({ type: 'message', content: 'follow-up', turnId: 'om_second' });
    await h.waitFor(() => committed(h.messages, 'om_first') && committed(h.messages, 'om_second'));
    const text = h.input();
    expect(pasted(text, 'first-prompt')).toBe(1);
    expect(pasted(text, 'follow-up')).toBe(1);
    expect(text.indexOf('first-prompt')).toBeLessThan(text.indexOf('follow-up'));
    expect(h.messages.filter(m => m.type === 'user_notify'), h.logs()).toEqual([]);
  });
}, 60_000);

it.skipIf(!tmuxAvailable)('keeps an opening that meets a draft queued, then delivers it and the follow-up once the draft clears', async () => {
  // The startup command makes a draft appear after the first-write gate
  // released and before the opening's write, as a human typing then would.
  await withWorker({
    steps: [0, 200, 500].map(atMs => ({ atMs, frame: READY })),
    onCommandEnter: DRAFT,
    init: { queuedActivationToken: 'qa-token-2', startupCommands: ['/status'] },
  }, async h => {
    const notices = () => h.messages.flatMap(m => (m.type === 'user_notify' ? [m.message] : []));
    await h.waitFor(() => notices().some(n => n.includes('existing draft')), 20_000);
    expect(activationAcked(h.messages, 'qa-token-2')).toBe(false);
    h.send({ type: 'message', content: 'follow-up', turnId: 'om_second' });
    await h.waitFor(() => committed(h.messages, 'om_first') && committed(h.messages, 'om_second'), DRAFT_HOLD_MS + 12_000);
    expect(h.pastesWhenDrawn('clear'), h.logs()).toBe(0);
    expect(activationAcked(h.messages, 'qa-token-2')).toBe(true);
    const text = h.input();
    expect(pasted(text, 'first-prompt')).toBe(1);
    expect(pasted(text, 'follow-up')).toBe(1);
    expect(text.indexOf('first-prompt')).toBeLessThan(text.indexOf('follow-up'));
    expect(notices(), h.logs()).toHaveLength(1);
    expect(notices()[0]).not.toMatch(/not safely written|没有安全写入/);
  });
}, 60_000);

it.skipIf(!tmuxAvailable)('delivers at the soft timeout when the input box was drawn before the output pipe attached', async () => {
  await withWorker({ steps: [{ atMs: 0, frame: READY }], pipeAttachDelayS: 2 }, async h => {
    // Well before the hard cap: nothing on the output pipe ever matched the prompt.
    await h.waitFor(() => committed(h.messages, 'om_first'), 45_000);
    expect(pasted(h.input(), 'first-prompt')).toBe(1);
    expect(h.messages.filter(m => m.type === 'user_notify'), h.logs()).toEqual([]);
  });
}, 75_000);

it.skipIf(!tmuxAvailable)('keeps checking the backend screen after the soft timeout and delivers once the box is ready', async () => {
  await withWorker({
    steps: [{ atMs: 0, frame: PROVISIONAL }],
    onSignal: [FOOTER_ONLY],
    pipeAttachDelayS: 2,
  }, async h => {
    await h.waitFor(() => h.logs().includes('First prompt timeout'), 45_000);
    expect(h.input(), h.logs()).not.toContain('\x1b[200~');
    h.signal();
    // Well before the hard cap, and without any new prompt bytes on the pipe.
    await h.waitFor(() => committed(h.messages, 'om_first'), 10_000);
    expect(pasted(h.input(), 'first-prompt')).toBe(1);
    expect(h.messages.filter(m => m.type === 'user_notify'), h.logs()).toEqual([]);
  });
}, 75_000);

// The draft comes and goes by cursor-addressed edits, so after the hold no
// output carries a prompt marker and no prompt-ready edge follows.
for (const [holder, passGateFirst, holdLog] of [
  ['first-write gate', false, 'Holding first write'],
  ['opening check', true, 'Holding opening input'],
] as const) {
  it.skipIf(!tmuxAvailable)(`re-drives a durable opening held by the ${holder} once the draft clears without prompt output`, async () => {
    await withWorker({
      steps: [0, 200, 500].map(atMs => ({ atMs, frame: READY })),
      onCommandEnter: READY,
      onSignal: [DRAFT_ONLY, DRAFT_ERASED],
      init: { prompt: '', turnId: undefined },
    }, async h => {
      await h.waitFor(() => h.logs().includes('Prompt detected'), 20_000);
      if (passGateFirst) {
        // A passthrough command takes the first write, before any message is queued.
        h.send({ type: 'raw_input', content: '/status', turnId: 'om_status' });
        await h.waitFor(() => h.pastesWhenDrawn('clear') !== undefined, DRAFT_HOLD_MS + 10_000);
        await new Promise(r => setTimeout(r, 2_500));
      }
      h.signal();
      await h.waitFor(() => h.pastesWhenDrawn('signal-1') !== undefined);
      await new Promise(r => setTimeout(r, 300));
      h.send({ type: 'message', content: 'durable-opening', turnId: 'om_durable', dispatchAttempt: 1 });
      await h.waitFor(() => h.logs().includes(holdLog));
      h.signal();
      await h.waitFor(() => pasted(h.input(), 'durable-opening') > 0, 10_000);
      expect(h.pastesWhenDrawn('signal-2'), h.logs()).toBe(0);
      await new Promise(r => setTimeout(r, 1_000));
      expect(pasted(h.input(), 'durable-opening')).toBe(1);
    });
  }, 60_000);
}

it.skipIf(!tmuxAvailable)('releases the follow-ups behind a queued activation that the write itself refused', async () => {
  await withWorker({
    steps: [0, 200, 500].map(atMs => ({ atMs, frame: READY })),
    onSignal: [DRAFT],
  }, async h => {
    await h.waitFor(() => committed(h.messages, 'om_first'), 20_000);
    // A draft appears after the opening check settled, as a human typing does.
    await new Promise(r => setTimeout(r, 1_000));
    h.signal();
    await new Promise(r => setTimeout(r, 500));
    h.send({ type: 'message', content: 'activation', turnId: 'om_second', queuedActivationToken: 'qa-token-3' });
    await h.waitFor(() => activationAcked(h.messages, 'qa-token-3'), 15_000);
    expect(pasted(h.input(), 'activation')).toBe(0);
    expect(h.messages.some(m => m.type === 'user_notify' && m.message.includes('existing draft')), h.logs()).toBe(true);
  });
}, 60_000);
