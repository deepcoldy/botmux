import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { preferredManagedTmuxSocket, tmuxSocketArgs } from '../src/adapters/backend/tmux-socket.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

// 0.211.1 uses cursor-positioned redraws: the rendered prompt starts a row,
// while stripped PTY bytes concatenate it with the preceding horizontal rule.
const COMPOSER = [
  '──────────────────────────────────────────────────────────',
  '❯ Use /skills to list available skills',
  '──────────────────────────────────────────────────────────',
  '  GPT-6-Astra xhigh · ~ · Context —',
  '  ☢ Full Access (shift+tab to cycle) · ? for shortcuts · ← for agents',
];
function redraw(rows: string[]): string {
  return '\x1b[2J\x1b[H' + rows.map((row, index) => `\x1b[${index + 1};1H${row}`).join('');
}

type Scenario = 'fresh' | 'resume' | 'loaded-banner' | 'blocked-screens' | 'hostile-first' | 'hostile-dialog';

const tmuxAvailable = probeTmuxFunctional().ok;
for (const backendType of process.env.BOTMUX_TEST_WORKER_BINARY ? ['tmux'] as const : ['pty', 'tmux'] as const) {
  for (const mode of ['fresh', 'resume', 'loaded-banner', 'blocked-screens', 'hostile-first', 'hostile-dialog'] as const) {
    it.skipIf(backendType === 'tmux' && !tmuxAvailable)(
      `TraeX ${backendType} ${mode}: admits a quiet cursor-painted composer and submits the first input once`,
      () => runScenario(backendType, mode),
      65_000,
    );
  }
}

async function runScenario(backendType: 'pty' | 'tmux', mode: Scenario): Promise<void> {
  const root = mkdtempSync('/tmp/bmx-traex-startup-');
  const sessionId = randomUUID();
  const nativeId = randomUUID();
  const dataDir = join(root, 'data');
  const traeHome = join(root, '.trae');
  const sessionsDir = join(traeHome, 'cli', 'sessions', '2026', '10', '23');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  const rollout = join(sessionsDir, `rollout-2026-10-23T00-00-00-${nativeId}.jsonl`);
  const history = join(traeHome, 'cli', 'history.jsonl');
  const frameFile = join(root, 'frame.json');
  const seenFile = join(root, 'seen');
  const inputFile = join(root, 'input');
  const confirmFile = join(root, 'confirm');
  const pidFile = join(root, 'pid');
  const fakeCli = join(root, 'traex');
  let nextFrame = 0;
  function paint(rows: string[]): number {
    const id = ++nextFrame;
    writeFileSync(`${frameFile}.tmp`, JSON.stringify({ id, bytes: redraw(rows) }));
    renameSync(`${frameFile}.tmp`, frameFile);
    return id;
  }
  const initial = mode === 'hostile-first'
    ? COMPOSER.map(row => row.replace('GPT-6-Astra xhigh', 'loading'))
    : mode === 'hostile-dialog'
      ? ['Sign in to TraeCode CLI', '❯ 1. Sign in with browser', ...COMPOSER.slice(2)]
      : mode === 'blocked-screens'
    ? ['│ model: loading /model to change │', '│ directory: /tmp │', ...COMPOSER]
    : mode === 'loaded-banner'
      ? ['│ model: GPT-6-Astra xhigh /model to change │', '│ directory: /tmp/loading │',
        ...COMPOSER.map(row => row.replace(' · ~ · ', ' · /tmp/loading · '))]
      : ['TraeCode CLI (v0.211.1)', '', ...COMPOSER];
  // #2247 later taught the byte-stream readyPattern the same cursor-painted
  // shape: the stripped redraw now matches through the preceding rule, so
  // recognition no longer depends on the viewport poller. The same rule arm
  // also matches the loading-cell hostile frame below, so first-prompt
  // admission additionally requires the adapter's rendered-viewport composer
  // predicate (a gate on the ready edge); the viewport poller re-drives that
  // edge once the initialized composer renders.
  const pattern = createTraexAdapter('/bin/true').readyPattern!;
  expect(pattern.test(redraw(COMPOSER).replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))).toBe(true);
  expect(pattern.test(COMPOSER.join('\n'))).toBe(true);
  paint(initial);
  writeFileSync(history, '');
  writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
const fd = fs.openSync(${JSON.stringify(rollout)}, 'a');
fs.writeSync(fd, JSON.stringify({type:'session_meta', payload:{id:${JSON.stringify(nativeId)}, cwd:process.cwd()}})+'\\n');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?2004h');
let lastFrame = 0, input = '', receipt = false, text = '';
function paint() {
  const frame = JSON.parse(fs.readFileSync(${JSON.stringify(frameFile)}, 'utf8'));
  if (frame.id === lastFrame) return;
  lastFrame = frame.id;
  process.stdout.write(frame.bytes);
  fs.writeFileSync(${JSON.stringify(seenFile)}, String(frame.id));
}
paint();
// tmux pipe-pane may subscribe after the first draw. Repaint during boot;
// after 900ms the fixture stays silent, so later redraws cannot rescue readySeen.
for (const delay of [200, 500, 900]) setTimeout(() => { lastFrame = 0; paint(); }, delay);
process.stdin.on('data', chunk => {
  fs.appendFileSync(${JSON.stringify(inputFile)}, chunk);
  input += chunk.toString();
  const match = input.match(/\\x1b\\[200~([\\s\\S]*?)\\x1b\\[201~/);
  if (match && /[\\r\\n]/.test(input.slice(match.index + match[0].length))) text = match[1];
});
setInterval(() => {
  paint();
  if (!receipt && text && fs.existsSync(${JSON.stringify(confirmFile)})) {
    receipt = true;
    fs.appendFileSync(${JSON.stringify(history)}, JSON.stringify({session_id:${JSON.stringify(nativeId)}, text, ts:Date.now()/1000})+'\\n');
    fs.writeSync(fd, JSON.stringify({type:'event_msg', payload:{type:'user_message', message:text, images:[], local_images:[]}})+'\\n');
  }
}, 25);
`);
  chmodSync(fakeCli, 0o755);
  const env = privateTmuxEnv(root, {
    HOME: root, TRAE_HOME: traeHome, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId,
    CLI_EXTRA_ARGS: '', LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test',
  });
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  let child: ChildProcess | undefined;
  async function waitFor(predicate: () => boolean, description: string, timeoutMs = 12_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= until || child?.exitCode != null) throw new Error(`${description}\n${logs.join('')}`);
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
  }
  try {
    const options = { cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] as any };
    child = process.env.BOTMUX_TEST_WORKER_BINARY
      ? spawn(process.env.BOTMUX_TEST_WORKER_BINARY, ['__worker'], options)
      : spawnNodeTsScript(resolve('src/worker.ts'), [], options);
    child.on('message', message => messages.push(message as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.send({
      type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_test',
      workingDir: dataDir, cliId: 'traex', cliPathOverride: fakeCli, backendType,
      ...(mode === 'resume' ? { resume: true, cliSessionId: nativeId } : {}),
      prompt: 'only-this-traex-startup-input', turnId: 'om_first',
      dispatchAttempt: 1, durablePrimaryInbox: true,
      larkAppId: 'app_test', larkAppSecret: 'test',
    } satisfies DaemonToWorker);
    await waitFor(() => existsSync(seenFile), 'first frame');
    if (mode === 'hostile-first' || mode === 'hostile-dialog') {
      // No loading banner precedes these frames: only the viewport predicate
      // can reject them after PTY silence and the spinner guard both expire.
      await new Promise(resolveWait => setTimeout(resolveWait, 6_200));
      expect(existsSync(inputFile), initial.join('\n') + '\n' + logs.join('')).toBe(false);
      expect(messages.some(message => message.type === 'prompt_ready')).toBe(false);
      paint(['TraeCode CLI (v0.211.1)', '', ...COMPOSER]);
    }
    if (mode === 'blocked-screens') {
      // Cross the quiet/spinner thresholds on each input owner. Even a visible
      // composer/footer cannot authorize a paste while another surface owns it.
      const blocked = [
        initial,
        COMPOSER.map(row => row.replace('GPT-6-Astra xhigh', 'loading')),
        ['Sign in to TraeCode CLI', '❯ 1. Sign in with browser', ...COMPOSER.slice(2)],
        [...COMPOSER.slice(0, 1), '❯ 1. Pick a model', ...COMPOSER.slice(2)],
        [...COMPOSER.slice(0, 1), '❯ my unsent draft', ...COMPOSER.slice(2)],
        [...COMPOSER.slice(0, 2), '  a wrapped draft continuation', ...COMPOSER.slice(2)],
        ['◆ Working… (3s • esc to interrupt)', ...COMPOSER],
        ['◆ Queued for capacity (30s • esc to interrupt)', ...COMPOSER],
      ];
      for (const frame of blocked) {
        const id = paint(frame);
        await waitFor(() => readFileSync(seenFile, 'utf8') === String(id), 'blocked frame painted');
        await new Promise(resolveWait => setTimeout(resolveWait, 3_200));
        expect(existsSync(inputFile), frame.join('\n') + '\n' + logs.join('')).toBe(false);
        expect(messages.some(message => message.type === 'prompt_ready')).toBe(false);
      }
      paint(['TraeCode CLI (v0.211.1)', '', ...COMPOSER]);
    }
    await waitFor(() => messages.some(message => message.type === 'prompt_ready'), 'first prompt ready before soft timeout');
    let input = '';
    await waitFor(() => {
      if (!existsSync(inputFile)) return false;
      input = readFileSync(inputFile, 'utf8');
      return input.includes('\x1b[201~') && input.includes('\r');
    }, 'first paste and Enter');
    expect(input.match(/only-this-traex-startup-input/g)).toHaveLength(1);
    expect(messages.some(message => message.type === 'turn_input_committed')).toBe(false);
    writeFileSync(confirmFile, 'confirm');
    await waitFor(() => messages.some(message => message.type === 'turn_input_committed' && message.turnId === 'om_first'), 'native submit receipt');
    expect(readFileSync(inputFile, 'utf8').match(/only-this-traex-startup-input/g)).toHaveLength(1);
    expect(logs.join('')).not.toContain('WARN First prompt hard timeout');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolveExit => child!.once('exit', () => resolveExit()));
      child.kill('SIGKILL');
      await Promise.race([exited, new Promise(resolveWait => setTimeout(resolveWait, 2_000))]);
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
