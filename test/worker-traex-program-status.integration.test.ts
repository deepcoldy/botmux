import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { preferredManagedTmuxSocket, tmuxSocketArgs } from '../src/adapters/backend/tmux-socket.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import { traexRestoredComposerReady } from '../src/adapters/cli/traex-footer.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

// Real worker + fake traecli. The fake draws the 0.214.1 cold-start frame
// with a footer row the composer predicate does not know (a future layout,
// like the shortcut-only row of #3307 and the truncated row of #3338 were),
// and reports OSC 7501 the way the recorded 0.214.1 does: `idle` once the
// composer takes input, then `working` → `done` for each submitted turn.
// Before OSC 7501 was parsed for traex this frame held the first prompt until
// the 90s hard timeout; a CLI version below 0.214.1 still does.
const RULE = '─'.repeat(58);
const UNKNOWN_FOOTER = '  ⓘ Plan mode · new footer layout';
const FRAME = ['  █ ◆ ◆ █  TRAE CLI (v0.214.1)', '  /tmp/repo', '  permissions: YOLO mode', RULE, '❯ Ask TRAE CLI to do anything', RULE, UNKNOWN_FOOTER];
const redraw = (rows: string[]) => '\x1b[2J\x1b[H' + rows.map((row, index) => `\x1b[${index + 1};1H${row}`).join('');
const report = (state: string) => `\x1b]7501;state=${state}:app=traecli\x1b\\`;

// Recorded traecli 0.214.1 resuming a session another process holds: the
// idle report and the session-lock page arrive in one output burst.
type Item = [number, 'out' | 'write' | 'key', string];
const { recordings } = JSON.parse(readFileSync(new URL('./fixtures/program-status/codex-traex-osc7501.json', import.meta.url), 'utf8')) as {
  recordings: Array<{ cli: string; version: string; scenario: string; items: Item[] }>;
};
const LOCK_OUTPUT = recordings.find(r => r.cli === 'traex' && r.version === '0.214.1' && r.scenario === 'resume-session-lock')!
  .items.filter(([, kind]) => kind === 'out').map(([t, , data]) => [t, data] as const);

const tmuxAvailable = probeTmuxFunctional().ok;
const cases = [
  // 0.214.1 reports: the first prompt goes in on screen quiescence.
  { cliVersion: '0.214.1\ninstallation: internal', reports: true, released: true },
  // A release before the gate: same frame, reports ignored → held as before.
  { cliVersion: '0.213.1', reports: true, released: false },
  // Reports missing despite a new version (e.g. a wrapper that eats them).
  { cliVersion: '0.214.1', reports: false, released: false },
] as const;

for (const backendType of process.env.BOTMUX_TEST_WORKER_BINARY ? ['tmux'] as const : ['pty', 'tmux'] as const) {
  for (const c of cases) {
    it.skipIf(backendType === 'tmux' && !tmuxAvailable)(
      `TraeX ${backendType} cliVersion=${JSON.stringify(c.cliVersion.split('\n')[0])} reports=${c.reports}: unknown footer ${c.released ? 'released by the startup idle report' : 'stays held'}`,
      () => runScenario(backendType, c),
      45_000,
    );
  }
  // The idle report says no turn is running, not that the composer is on
  // screen. On the lock page the session must stay not-ready: a prompt_ready
  // there makes the daemon resolve the lock card raised for the held message
  // and drop its Retry key, leaving the message queued with nothing to press.
  it.skipIf(backendType === 'tmux' && !tmuxAvailable)(
    `TraeX ${backendType} 0.214.1: the idle reported with the session-lock page does not make the session ready`,
    () => runLockPage(backendType),
    45_000,
  );
}

interface FakePaths { inputFile: string; history: string; doneFile: string; nativeId: string; rolloutFd: string }
interface Harness {
  messages: WorkerToDaemon[];
  logs: string[];
  pasted: () => string;
  doneFile: string;
  send: (message: DaemonToWorker) => void;
  waitFor: (predicate: () => boolean, description: string, timeoutMs?: number) => Promise<void>;
}

/** A real worker on a fake traecli. `body` is the fake's script after a
 *  common prologue that opens the rollout (as `fd`), writes its session_meta,
 *  puts stdin in raw mode and appends every byte the worker types to
 *  `inputFile`. */
async function withTraexWorker(
  backendType: 'pty' | 'tmux',
  cliVersion: string,
  body: (paths: FakePaths) => string,
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync('/tmp/bmx-traex-osc7501-');
  const sessionId = randomUUID();
  const nativeId = randomUUID();
  const dataDir = join(root, 'data');
  const traeHome = join(root, '.trae');
  const sessionsDir = join(traeHome, 'cli', 'sessions', '2026', '11', '12');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  const rollout = join(sessionsDir, `rollout-2026-11-12T00-00-00-${nativeId}.jsonl`);
  const history = join(traeHome, 'cli', 'history.jsonl');
  const inputFile = join(root, 'input');
  const pidFile = join(root, 'pid');
  const fakeCli = join(root, 'traex');
  const doneFile = join(root, 'done');
  writeFileSync(history, '');
  writeFileSync(fakeCli, [
    '#!/usr/bin/env node',
    `const fs = require('node:fs');`,
    `const fd = fs.openSync(${JSON.stringify(rollout)}, 'a');`,
    `fs.writeSync(fd, JSON.stringify({type:'session_meta', payload:{id:${JSON.stringify(nativeId)}, cwd:process.cwd()}})+'\\n');`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    'process.stdin.setRawMode(true);',
    `process.stdin.on('data', chunk => fs.appendFileSync(${JSON.stringify(inputFile)}, chunk));`,
    body({ inputFile, history, doneFile, nativeId, rolloutFd: 'fd' }),
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  chmodSync(fakeCli, 0o755);
  const env = privateTmuxEnv(root, {
    HOME: root, TRAE_HOME: traeHome, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId,
    CLI_EXTRA_ARGS: '', LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test',
  });
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  let child: ChildProcess | undefined;
  const pasted = () => (existsSync(inputFile) ? readFileSync(inputFile, 'utf8') : '');
  const waitFor = async (predicate: () => boolean, description: string, timeoutMs = 15_000) => {
    const until = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= until || child?.exitCode != null) throw new Error(`${description}\n${logs.join('')}`);
      await new Promise(r => setTimeout(r, 25));
    }
  };
  try {
    const options = { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] as any };
    child = process.env.BOTMUX_TEST_WORKER_BINARY
      ? spawn(process.env.BOTMUX_TEST_WORKER_BINARY, ['__worker'], options)
      : spawnNodeTsScript(resolve('src/worker.ts'), [], options);
    child.on('message', message => messages.push(message as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    const send = (message: DaemonToWorker) => { child!.send(message); };
    send({
      type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_test',
      workingDir: dataDir, cliId: 'traex', cliPathOverride: fakeCli, backendType,
      cliVersion,
      prompt: 'first-traex-input', turnId: 'om_first',
      larkAppId: 'app_test', larkAppSecret: 'test',
    });
    await run({ messages, logs, pasted, doneFile, send, waitFor });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(r => child!.once('exit', () => r()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise(r => setTimeout(r, 2_000))]);
    }
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* exited */ }
    }
    if (backendType === 'tmux') {
      try {
        execFileSync('tmux', [...tmuxSocketArgs(preferredManagedTmuxSocket(env)), 'kill-server'], { env, stdio: 'ignore' });
      } catch { /* exited */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

async function runScenario(backendType: 'pty' | 'tmux', c: typeof cases[number]): Promise<void> {
  // The predicate really does not know this footer (else the test proves nothing).
  expect(traexRestoredComposerReady(FRAME.join('\n'))).toBe(false);
  const fake = ({ inputFile, history, doneFile, nativeId, rolloutFd }: FakePaths) => `
const reports = ${JSON.stringify(c.reports)};
const report = s => reports ? ${JSON.stringify(report('STATE'))}.replace('STATE', s) : '';
const frame = ${JSON.stringify(redraw(FRAME))};
process.stdout.write('\\x1b[?2004h' + frame);
// Repaint while tmux pipe-pane may still be attaching, then report idle and
// go silent, as the recorded 0.214.1 does once its composer takes input.
for (const d of [200, 500]) setTimeout(() => process.stdout.write(frame), d);
setTimeout(() => process.stdout.write(report('idle')), 800);
let turns = 0;
process.stdin.on('data', () => {
  const input = fs.readFileSync(${JSON.stringify(inputFile)}, 'utf8');
  // Every paste followed by its Enter is one submitted turn.
  const submitted = [...input.matchAll(/\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~[^\\x1b]*\\r/g)];
  while (submitted.length > turns) {
    const text = submitted[turns][1];
    turns++;
    fs.appendFileSync(${JSON.stringify(history)}, JSON.stringify({session_id:${JSON.stringify(nativeId)}, text, ts:Date.now()/1000})+'\\n');
    process.stdout.write(report('idle') + report('working') + ${JSON.stringify('\r\n◆ Working… (0s • esc to interrupt)')});
    const turn = turns;
    setTimeout(() => {
      fs.writeSync(${rolloutFd}, JSON.stringify({type:'event_msg', payload:{type:'user_message', message:text, images:[], local_images:[]}})+'\\n');
      fs.writeSync(${rolloutFd}, JSON.stringify({type:'response_item', payload:{type:'message', role:'assistant', phase:'final_answer', content:[{type:'output_text', text:'reply ' + turn}]}})+'\\n');
      fs.writeSync(${rolloutFd}, JSON.stringify({type:'event_msg', payload:{type:'task_complete', turn_id:'t' + turn, last_agent_message:'reply ' + turn}})+'\\n');
      fs.appendFileSync(${JSON.stringify(doneFile)}, 'd');
      process.stdout.write(report('done') + frame);
    }, 600);
  }
});
`;
  await withTraexWorker(backendType, c.cliVersion, fake, async ({ messages, logs, pasted, doneFile, send, waitFor }) => {
    if (!c.released) {
      // Past screen quiescence (2s) and the 3s spinner guard, well short of
      // the 90s hard cap: the old behaviour keeps the input queued.
      await new Promise(r => setTimeout(r, 9_000));
      expect(pasted(), logs.join('')).not.toContain('first-traex-input');
      expect(messages.some(m => m.type === 'prompt_ready')).toBe(false);
      if (c.reports) expect(logs.join('')).toContain('reports not parsed');
      return;
    }
    // Well before the 15s soft timeout, let alone the 90s hard cap.
    await waitFor(() => /first-traex-input\x1b\[201~[^\x1b]*\r/.test(pasted()), 'first input written on the startup idle report', 10_000);
    expect(logs.join('')).not.toContain('First prompt hard timeout');
    await waitFor(() => existsSync(doneFile), 'first turn done');
    // A second turn rides on its own working → done.
    send({ type: 'message', content: 'second-traex-input', turnId: 'om_second' });
    await waitFor(() => /second-traex-input\x1b\[201~[^\x1b]*\r/.test(pasted()), `second paste + Enter\n${JSON.stringify(pasted())}`);
    await waitFor(() => existsSync(doneFile) && readFileSync(doneFile, 'utf8').length === 2, 'second turn done');
    expect(pasted().match(/first-traex-input/g)).toHaveLength(1);
    expect(pasted().match(/second-traex-input/g), JSON.stringify(pasted())).toHaveLength(1);
  });
}

async function runLockPage(backendType: 'pty' | 'tmux'): Promise<void> {
  // The recorded burst really carries the idle report ahead of the page.
  const burst = LOCK_OUTPUT.find(([, data]) => data.includes('This conversation is open in another app'))![1];
  expect(burst.indexOf('\x1b]7501;state=idle')).toBeGreaterThanOrEqual(0);
  expect(burst.indexOf('\x1b]7501;state=idle')).toBeLessThan(burst.indexOf('This conversation is open in another app'));
  // Replay the recorded output on its own clock; the page then stays put.
  const fake = () => `
for (const [t, data] of ${JSON.stringify(LOCK_OUTPUT)}) setTimeout(() => process.stdout.write(data), t);
`;
  await withTraexWorker(backendType, '0.214.1', fake, async ({ messages, logs, pasted, waitFor }) => {
    // The held message raises the lock card...
    await waitFor(
      () => messages.some(m => m.type === 'stuck_warning' && m.reason === 'input_held' && m.matchedPattern === 'session lock'),
      'lock card for the held first message',
    );
    // ...and nothing retires it: past screen quiescence, the spinner guard and
    // the viewport poller's rechecks, the session is still not ready.
    await new Promise(r => setTimeout(r, 7_000));
    expect(messages.filter(m => m.type === 'prompt_ready'), logs.join('')).toEqual([]);
    expect(pasted()).not.toContain('first-traex-input');
  });
}
