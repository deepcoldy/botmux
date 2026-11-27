import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { spawnNodeTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';
import { killProcessTree } from './helpers/process-tree.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import { preferredManagedTmuxSocket, tmuxSocketArgs } from '../src/adapters/backend/tmux-socket.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const tmuxAvailable = probeTmuxFunctional().ok;
const CONVERSATION_ID = '44444444-5555-6666-7777-888888888888';

const READY_SCREEN = '\x1b[2J\x1b[H\r\nAntigravity ready\r\n────────\r\n>\r\n────────\r\n? for shortcuts\r\n';
// Deliberately omit `esc to cancel` so screen-only heuristics would misread
// this static approval screen as idle after 2s without OSC 7501.
const APPROVAL_SCREEN = '\x1b[2J\x1b[H\r\nTool confirmation required\r\n────────\r\n  1. Allow once\r\n  2. Deny\r\n────────\r\n? for shortcuts\r\n';
const osc = (fields: string) => `\x1b]7501;${fields}\x07`;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

interface RunHandle {
  messages: WorkerToDaemon[];
  send: (msg: DaemonToWorker) => void;
  waitFor: (condition: () => boolean, label: string, timeoutMs?: number) => Promise<void>;
  logs: () => string;
  signal: () => void;
  capturedEnv: () => Record<string, string | null>;
  pastesAt: (label: string) => number | undefined;
  pastesTotal: () => number;
}

interface WorkerFixtureOptions {
  backendType: 'pty' | 'tmux';
  cliVersion: string;
  mode: 'approval' | 'cold-start-delayed-transcript' | 'simple';
  delayedTranscriptMs?: number;
  promptInjection?: 'default' | 'none';
  botEnv?: Record<string, string>;
  hostEnv?: Record<string, string>;
}

async function withAntigravityWorker(
  opts: WorkerFixtureOptions,
  body: (h: RunHandle) => Promise<void>,
): Promise<void> {
  const sessionId = `agy-osc-${randomUUID()}`;
  // Short /tmp path keeps tmux's Unix domain socket path under UNIX_PATH_MAX (108 bytes).
  const root = mkdtempSync('/tmp/bmx-agy-osc7501-');
  const dataDir = join(root, 'data');
  const botmuxDir = join(root, '.botmux');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(botmuxDir, { recursive: true, mode: 0o700 });
  chmodSync(botmuxDir, 0o700);
  writeFileSync(join(root, '.zshrc'), '# isolated worker test\n');

  const cliHome = join(root, '.gemini', 'antigravity-cli');
  const transcriptDir = join(cliHome, 'brain', CONVERSATION_ID, '.system_generated', 'logs');
  const transcriptPath = join(transcriptDir, 'transcript.jsonl');
  const historyPath = join(cliHome, 'history.jsonl');
  mkdirSync(cliHome, { recursive: true });

  const cliPidFile = join(root, 'cli.pid');
  const envFile = join(root, 'captured-env.json');
  const drawsFile = join(root, 'draws.log');
  const signalFile = join(root, 'approve.signal');
  const inputFile = join(root, 'input.raw');

  const fakeCli = join(root, 'fake-agy');
  const oscConfig = {
    idle: osc('state=idle:app=antigravity'),
    working: osc('state=working:app=antigravity'),
    blockedPerm: osc(`state=blocked:kind=permission:app=antigravity:msg=${b64('Approve Bash')}`),
    done: osc(`state=done:app=antigravity:msg=${b64('Task complete')}`),
  };

  writeFileSync(fakeCli, `#!${tsRunnerPrefix().command}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log(${JSON.stringify(opts.cliVersion)}); process.exit(0); }
fs.writeFileSync(${JSON.stringify(cliPidFile)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({
  AGY_CLI_OSC7501: process.env.AGY_CLI_OSC7501 ?? null,
  AGY_CLI_OSC7501_MESSAGES: process.env.AGY_CLI_OSC7501_MESSAGES ?? null,
}));
const args = process.argv.slice(2);
const logIdx = args.indexOf('--log-file');
const logFile = logIdx >= 0 ? args[logIdx + 1] : null;
const emitOsc = (process.env.AGY_CLI_OSC7501 || '').trim().toLowerCase() === 'on';
const OSC = ${JSON.stringify(oscConfig)};
const READY = ${JSON.stringify(READY_SCREEN)};
const APPROVAL = ${JSON.stringify(APPROVAL_SCREEN)};
const mode = ${JSON.stringify(opts.mode)};
const delayedTranscriptMs = ${JSON.stringify(opts.delayedTranscriptMs ?? 0)};
const historyPath = ${JSON.stringify(historyPath)};
const transcriptDir = ${JSON.stringify(transcriptDir)};
const transcriptPath = ${JSON.stringify(transcriptPath)};
const signalFile = ${JSON.stringify(signalFile)};
const cid = ${JSON.stringify(CONVERSATION_ID)};
let input = '';
let handled = 0;
let stepIdx = 0;
const pastes = () => input.split('\\x1b[200~').length - 1;
function draw(label, bytes) {
  fs.appendFileSync(${JSON.stringify(drawsFile)}, label + ' ' + pastes() + '\\n');
  process.stdout.write(bytes);
}
function writeStreamLog() {
  if (!logFile) return;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, 'I1127 12:00:00.000001 100 server.go:1] Streaming conversation ' + cid + '\\n');
}
function appendTranscript(record) {
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.appendFileSync(transcriptPath, JSON.stringify({ step_index: ++stepIdx, ...record }) + '\\n');
}
process.stdin.setRawMode?.(true);
setTimeout(() => draw('startup-ready', (emitOsc ? OSC.idle : '') + READY), 100);
process.stdin.on('data', chunk => {
  const text = chunk.toString();
  input += text;
  fs.appendFileSync(${JSON.stringify(inputFile)}, text);
  const frames = [...input.matchAll(/\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~\\r/g)];
  for (const m of frames.slice(handled)) {
    handled++;
    const turn = handled;
    const payload = m[1];
    fs.appendFileSync(historyPath, JSON.stringify({ display: payload, timestamp: Date.now(), workspace: process.cwd() }) + '\\n');
    if (mode === 'approval' && turn === 1) {
      writeStreamLog();
      draw('turn-1-working', emitOsc ? OSC.working : '\\r\\nesc to cancel\\r\\n');
      setTimeout(() => draw('turn-1-blocked', (emitOsc ? OSC.blockedPerm : '') + APPROVAL), 200);
      globalThis.finishFirst = () => {
        draw('turn-1-approved', emitOsc ? OSC.working : '\\r\\nesc to cancel\\r\\n');
        setTimeout(() => {
          appendTranscript({ source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\\n' + payload + '\\n</USER_REQUEST>' });
          appendTranscript({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'approved reply ' + turn });
          draw('turn-1-done', (emitOsc ? OSC.done : '') + READY);
        }, 250);
      };
    } else if (mode === 'cold-start-delayed-transcript' && turn === 1) {
      // Emit OSC working immediately, but delay creating brain transcript + USER_INPUT
      // past the 20s STRUCTURED_SUBMIT_START_GRACE_MS window (real cold-start lag).
      draw('turn-1-working', (emitOsc ? OSC.working : '') + '\\r\\nesc to cancel\\r\\n');
      setTimeout(() => {
        writeStreamLog();
        appendTranscript({ source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\\n' + payload + '\\n</USER_REQUEST>' });
        setTimeout(() => {
          appendTranscript({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'cold start ok' });
          draw('turn-1-done', (emitOsc ? OSC.done : '') + READY);
        }, 300);
      }, delayedTranscriptMs);
    } else {
      writeStreamLog();
      draw('turn-' + turn + '-working', (emitOsc ? OSC.working : '') + '\\r\\nesc to cancel\\r\\n');
      setTimeout(() => {
        appendTranscript({ source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\\n' + payload + '\\n</USER_REQUEST>' });
        appendTranscript({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'reply ' + turn });
        draw('turn-' + turn + '-done', (emitOsc ? OSC.done : '') + READY);
      }, 300);
    }
  }
});
setInterval(() => {
  if (globalThis.finishFirst && fs.existsSync(signalFile)) {
    const fn = globalThis.finishFirst;
    globalThis.finishFirst = undefined;
    fn();
  }
}, 50);
`);
  chmodSync(fakeCli, 0o755);

  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  let child: ChildProcess | undefined;
  const workerEnv = privateTmuxEnv(root, {
    HOME: root,
    SESSION_DATA_DIR: dataDir,
    BOTMUX_SESSION_ID: sessionId,
    LARK_APP_ID: 'app_test',
    LARK_APP_SECRET: 'secret',
    ...opts.hostEnv,
  });
  if (!opts.hostEnv?.AGY_CLI_OSC7501) delete workerEnv.AGY_CLI_OSC7501;
  if (!opts.hostEnv?.AGY_CLI_OSC7501_MESSAGES) delete workerEnv.AGY_CLI_OSC7501_MESSAGES;

  const waitFor = async (condition: () => boolean, label: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() >= deadline || child?.exitCode != null) {
        throw new Error(`${label}\n${logs.join('').slice(-8000)}`);
      }
      await new Promise(r => setTimeout(r, 40));
    }
  };

  try {
    const spawnOptions: SpawnOptions = {
      cwd: resolve('.'),
      env: workerEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    };
    child = process.env.BOTMUX_TEST_WORKER_BINARY
      ? spawn(process.env.BOTMUX_TEST_WORKER_BINARY, ['__worker'], spawnOptions)
      : spawnNodeTsScript(resolve('src/worker.ts'), [], spawnOptions);
    child.on('message', m => messages.push(m as WorkerToDaemon));
    child.stdout?.on('data', b => logs.push(b.toString()));
    child.stderr?.on('data', b => logs.push(b.toString()));

    child.send({
      type: 'init',
      sessionId,
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'antigravity',
      cliPathOverride: fakeCli,
      backendType: opts.backendType,
      cliVersion: opts.cliVersion,
      prompt: 'first-prompt',
      turnId: 'om_first',
      promptInjection: opts.promptInjection ?? 'default',
      env: opts.botEnv,
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await body({
      messages,
      send: msg => child!.send(msg),
      waitFor,
      logs: () => logs.join(''),
      signal: () => appendFileSync(signalFile, 'ok'),
      capturedEnv: () => (existsSync(envFile) ? JSON.parse(readFileSync(envFile, 'utf8')) : {}),
      pastesAt: label => {
        if (!existsSync(drawsFile)) return undefined;
        const line = readFileSync(drawsFile, 'utf8').split('\n').find(l => l.startsWith(`${label} `));
        return line === undefined ? undefined : Number(line.split(' ')[1]);
      },
      pastesTotal: () => (existsSync(inputFile) ? readFileSync(inputFile, 'utf8').split('\x1b[200~').length - 1 : 0),
    });
  } finally {
    if (child) await killProcessTree(child);
    if (existsSync(cliPidFile)) {
      try { process.kill(Number(readFileSync(cliPidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
    }
    if (opts.backendType === 'tmux') {
      for (const socket of new Set([undefined, preferredManagedTmuxSocket(workerEnv)])) {
        try { execFileSync('tmux', [...tmuxSocketArgs(socket), 'kill-server'], { env: workerEnv, stdio: 'ignore' }); } catch { /* exited */ }
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

describe('Antigravity OSC 7501 worker integration', () => {
  for (const backendType of process.env.BOTMUX_TEST_WORKER_BINARY ? ['tmux'] as const : ['pty', 'tmux'] as const) {
    it.skipIf(backendType === 'tmux' && !tmuxAvailable)(
      `antigravity ${backendType}: injects OSC 7501 env on >=1.5.10, holds blocked permission dialog off queued input, and completes on done`,
      async () => {
        await withAntigravityWorker({ backendType, cliVersion: '1.5.18', mode: 'approval' }, async h => {
          await h.waitFor(() => h.pastesAt('turn-1-blocked') !== undefined, 'approval screen reached', 20_000);
          expect(h.capturedEnv()).toEqual({
            AGY_CLI_OSC7501: 'on',
            AGY_CLI_OSC7501_MESSAGES: 'brief',
          });
          await h.waitFor(() => h.logs().includes('[program-status] status received'), 'OSC 7501 authority engaged');

          const readyBefore = h.messages.filter(m => m.type === 'prompt_ready').length;
          // Queue follow-up while blocked on permission dialog: must stay held
          // off the dialog even past the 2s screen quiescence window.
          h.send({ type: 'message', content: 'second-prompt', turnId: 'om_second' });
          await new Promise(r => setTimeout(r, 4_500));
          expect(h.messages.filter(m => m.type === 'prompt_ready').length).toBe(readyBefore);
          expect(h.pastesTotal()).toBe(1);

          // Approve -> working -> done -> second prompt delivered and completes
          h.signal();
          await h.waitFor(() => h.pastesAt('turn-1-done') !== undefined, 'first turn completed', 15_000);
          await h.waitFor(() => h.pastesAt('turn-2-done') !== undefined, 'queued second turn delivered and completed', 15_000);
          expect(h.pastesTotal()).toBe(2);
        });
      },
      45_000,
    );
  }

  it('antigravity pty: OSC 7501 working refreshes pre-start lease across >20s cold-start transcript delay and delivers first-turn final_output', async () => {
    await withAntigravityWorker({
      backendType: 'pty',
      cliVersion: '1.5.18',
      mode: 'cold-start-delayed-transcript',
      delayedTranscriptMs: 22_500,
      promptInjection: 'none',
    }, async h => {
      await h.waitFor(() => h.pastesAt('turn-1-working') !== undefined, 'first turn submitted and reported working', 15_000);
      await h.waitFor(() => h.logs().includes('[program-status] status received'), 'OSC 7501 authority engaged');

      // Wait for the delayed (>20s) transcript creation, USER_INPUT, PLANNER_RESPONSE, and OSC done
      await h.waitFor(
        () => h.messages.some(m => m.type === 'final_output' && m.turnId === 'om_first' && m.content.includes('cold start ok')),
        'first-turn final_output delivered after >20s cold start',
        35_000,
      );
      // Must NOT have pruned or warned about uncollected / structured_start_timeout at 20s
      expect(h.messages.filter(m => m.type === 'turn_terminal' && m.status === 'ambiguous')).toEqual([]);
      expect(h.messages.filter(m => m.type === 'user_notify' && m.turnId === 'om_first')).toEqual([]);
    });
  }, 55_000);

  it('antigravity pty: falls back cleanly below 1.5.10 and when AGY_CLI_OSC7501=off is configured', async () => {
    // Below minimum version (1.5.9): neither env var injected, screen fallback completes turn
    await withAntigravityWorker({ backendType: 'pty', cliVersion: '1.5.9', mode: 'simple' }, async h => {
      await h.waitFor(() => h.pastesAt('turn-1-done') !== undefined, 'turn completed on 1.5.9', 15_000);
      expect(h.capturedEnv()).toEqual({
        AGY_CLI_OSC7501: null,
        AGY_CLI_OSC7501_MESSAGES: null,
      });
      expect(h.logs()).toContain('[program-status] antigravity reports not parsed');
      expect(h.logs()).not.toContain('[program-status] status received');
    });

    // Explicit AGY_CLI_OSC7501=off in bot env on 1.5.18: respects user env and disables parser
    await withAntigravityWorker({
      backendType: 'pty',
      cliVersion: '1.5.18',
      mode: 'simple',
      botEnv: { AGY_CLI_OSC7501: 'off' },
    }, async h => {
      await h.waitFor(() => h.pastesAt('turn-1-done') !== undefined, 'turn completed with AGY_CLI_OSC7501=off', 15_000);
      expect(h.capturedEnv()).toEqual({
        AGY_CLI_OSC7501: 'off',
        AGY_CLI_OSC7501_MESSAGES: null,
      });
      expect(h.logs()).toContain('disabled by env');
      expect(h.logs()).not.toContain('[program-status] status received');
    });
  }, 45_000);
});
