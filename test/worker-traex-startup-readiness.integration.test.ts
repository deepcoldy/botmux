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
import { traexRestoredComposerReady } from '../src/adapters/cli/traex-footer.js';
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

// per-bot-home: TRAE_HOME comes only from the bot's env (the worker's own env
// has none), so the submit receipt is only visible if the worker follows it.
type Scenario = 'fresh' | 'resume' | 'loaded-banner' | 'blocked-screens' | 'hostile-first' | 'hostile-dialog' | 'per-bot-home' | 'repository-notice' | 'resumed-repository-notice' | 'resumed-repository-notice-held-idle' | 'native-viewport' | 'native-viewport-loading' | 'native-viewport-race' | 'native-viewport-retry' | 'session-lock' | 'shortcut-only-footer';

const tmuxAvailable = probeTmuxFunctional().ok;
for (const backendType of process.env.BOTMUX_TEST_WORKER_BINARY ? ['tmux'] as const : ['pty', 'tmux'] as const) {
  for (const mode of ['fresh', 'resume', 'loaded-banner', 'blocked-screens', 'hostile-first', 'hostile-dialog', 'per-bot-home', 'repository-notice', 'resumed-repository-notice', 'resumed-repository-notice-held-idle', 'native-viewport', 'native-viewport-loading', 'native-viewport-race', 'native-viewport-retry', 'session-lock', 'shortcut-only-footer'] as const) {
    if (mode.startsWith('native-viewport') && backendType !== 'tmux') continue;
    it.skipIf(backendType === 'tmux' && !tmuxAvailable)(
      `TraeX ${backendType} ${mode}: admits a quiet cursor-painted composer and submits the first input once`,
      () => runScenario(backendType, mode),
      mode === 'session-lock' ? 120_000 : 65_000,
    );
  }
}

async function runScenario(backendType: 'pty' | 'tmux', mode: Scenario): Promise<void> {
  const root = mkdtempSync('/tmp/bmx-traex-startup-');
  const sessionId = randomUUID();
  const nativeId = randomUUID();
  const dataDir = join(root, 'data');
  const traeHome = mode === 'per-bot-home' ? join(root, 'bot-trae') : join(root, '.trae');
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
  const captureStarted = join(root, 'capture-started');
  const captureReleased = join(root, 'capture-released');
  const idleHeld = join(root, 'idle-held');
  const fakeCli = join(root, 'traex');
  const nativeViewport = mode.startsWith('native-viewport');
  const heldIdle = mode === 'resumed-repository-notice-held-idle';
  let nextFrame = 0;
  function paint(rows: string[]): number {
    const id = ++nextFrame;
    writeFileSync(`${frameFile}.tmp`, JSON.stringify({ id, bytes: redraw(rows) }));
    renameSync(`${frameFile}.tmp`, frameFile);
    return id;
  }
  const initial = mode === 'session-lock'
    ? readFileSync(resolve('test/fixtures/stuck-pages/traex-0.213.1-session-lock.txt'), 'utf8').trimEnd().split('\n')
    : nativeViewport
    ? COMPOSER.map(row => mode === 'native-viewport-loading' ? row.replace('GPT-6-Astra xhigh', 'loading') : row)
    : mode.startsWith('resumed-repository-notice')
    ? ['■ Conversation interrupted - use /feedback if something went wrong', '',
        ...COMPOSER.slice(0, 3).map(row => row.replace('Use /skills to list available skills', 'Write tests for @filename')),
        '  无法访问 Git 仓库 `git@example.invalid`，请确认该仓库权限或地址。']
    : mode === 'repository-notice'
    ? ['  █ ◆ ◆ █  TRAE CLI (v0.212.1)', '  ~/projects', '  permissions: YOLO mode',
        ...COMPOSER.slice(0, 3).map(row => row.replace('Use /skills to list available skills', 'Ask TRAE CLI to do anything')),
        '  无法访问 Git 仓库 `git@example.invalid`，请确认该仓库权限或地址。']
    : mode === 'hostile-first'
    ? COMPOSER.map(row => row.replace('GPT-6-Astra xhigh', 'loading'))
    : mode === 'hostile-dialog'
      ? ['Sign in to TraeCode CLI', '❯ 1. Sign in with browser', ...COMPOSER.slice(2)]
      : mode === 'blocked-screens'
    ? ['│ model: loading /model to change │', '│ directory: /tmp │', ...COMPOSER]
    : mode === 'loaded-banner'
      ? ['│ model: GPT-6-Astra xhigh /model to change │', '│ directory: /tmp/loading │',
        ...COMPOSER.map(row => row.replace(' · ~ · ', ' · /tmp/loading · '))]
      : mode === 'shortcut-only-footer'
        // TraeX 0.214.1 cold start: empty composer plus a bare shortcut hint,
        // with no model/context footer until the model list fetch resolves.
        ? ['  █ ◆ ◆ █  TRAE CLI (v0.214.1)', '  /tmp/repo', '  permissions: YOLO mode',
          ...COMPOSER.slice(0, 3).map(row => row.replace('Use /skills to list available skills', 'Ask TRAE CLI to do anything')),
          '  ? for shortcuts']
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
  // The real pane gets a complete frame. The worker bootstrap below loses
  // those bytes, as a pipe-pane subscription can when the first draw precedes
  // attachment. Only the later, partial composer repaint reaches its renderer.
  process.stdout.write(${JSON.stringify(nativeViewport)}
    ? '\\x1b]0;fixture-full-frame\\x07' + frame.bytes
      + '\\x1b]0;fixture-partial-frame\\x07' + ${JSON.stringify(redraw(COMPOSER.slice(0, 3)).replace('\x1b[2J\x1b[H', ''))}
    : frame.bytes);
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
    HOME: root, ...(mode === 'per-bot-home' ? {} : { TRAE_HOME: traeHome }), SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId,
    CLI_EXTRA_ARGS: '', LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test',
  });
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  let workerScript = resolve('src/worker.ts');
  if (nativeViewport || heldIdle) {
    workerScript = join(root, 'worker-native-viewport.ts');
    writeFileSync(workerScript, `
(async () => {
const { TmuxPipeBackend } = await import(${JSON.stringify(resolve('src/adapters/backend/tmux-pipe-backend.ts'))});
const originalOnData = TmuxPipeBackend.prototype.onData;
TmuxPipeBackend.prototype.onData = function (callback) {
  let pending = '', dropping = false;
  originalOnData.call(this, data => {
    pending += data;
    while (pending) {
      const marker = dropping ? '\\x1b]0;fixture-partial-frame\\x07' : '\\x1b]0;fixture-full-frame\\x07';
      const index = pending.indexOf(marker);
      if (index >= 0) {
        if (!dropping && index) callback(pending.slice(0, index));
        pending = pending.slice(index + marker.length);
        dropping = !dropping;
        continue;
      }
      let keep = 0;
      for (let size = 1; size < marker.length; size++) {
        if (pending.endsWith(marker.slice(0, size))) keep = size;
      }
      if (!dropping) callback(pending.slice(0, pending.length - keep));
      pending = keep ? pending.slice(-keep) : '';
      break;
    }
  });
};
const fs = await import('node:fs');
if (${JSON.stringify(heldIdle)}) {
  const { IdleDetector } = await import(${JSON.stringify(resolve('src/utils/idle-detector.ts'))});
  const originalOnIdle = IdleDetector.prototype.onIdle;
  IdleDetector.prototype.onIdle = function (callback) {
    let held = false;
    originalOnIdle.call(this, source => {
      if (!held) {
        held = true;
        fs.writeFileSync(${JSON.stringify(idleHeld)}, 'first idle not admitted');
        return;
      }
      callback(source);
    });
  };
}
const originalCapture = TmuxPipeBackend.prototype.captureViewportAsync;
let capturedOnce = false;
TmuxPipeBackend.prototype.captureViewportAsync = async function () {
  if (${JSON.stringify(mode === 'native-viewport-retry')} && !capturedOnce) {
    capturedOnce = true;
    throw new Error('temporary capture failure');
  }
  const screen = await originalCapture.call(this);
  if (${JSON.stringify(mode === 'native-viewport-race')} && !capturedOnce) {
    capturedOnce = true;
    fs.writeFileSync(${JSON.stringify(captureStarted)}, 'captured');
    while (!fs.existsSync(${JSON.stringify(captureReleased)})) {
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
  }
  return screen;
};
await import(${JSON.stringify(resolve('src/worker.ts'))});
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
  }
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
      : spawnNodeTsScript(workerScript, [], options);
    child.on('message', message => messages.push(message as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.send({
      type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_test',
      workingDir: dataDir, cliId: 'traex', cliPathOverride: fakeCli, backendType,
      ...(mode === 'resume' || mode === 'session-lock' || mode.startsWith('resumed-repository-notice') || nativeViewport ? { resume: true, cliSessionId: nativeId } : {}),
      ...(mode === 'per-bot-home' ? { env: { TRAE_HOME: traeHome } } : {}),
      prompt: 'only-this-traex-startup-input', turnId: 'om_first',
      dispatchAttempt: 1, durablePrimaryInbox: true,
      larkAppId: 'app_test', larkAppSecret: 'test',
    } satisfies DaemonToWorker);
    await waitFor(() => existsSync(seenFile), 'first frame', mode === 'session-lock' ? 60_000 : 12_000);
    if (mode === 'session-lock') {
      await waitFor(() => messages.some(message => message.type === 'stuck_warning'
        && message.reason === 'input_held' && message.matchedPattern === 'session lock'),
      'session-lock hold card', 25_000);
      expect(existsSync(inputFile), logs.join('')).toBe(false);
      expect(messages.some(message => message.type === 'turn_input_committed')).toBe(false);
      paint(['TraeCode CLI (v0.213.1)', '', ...COMPOSER]);
    }
    if (heldIdle) await waitFor(() => existsSync(idleHeld), 'first idle edge held');
    if (nativeViewport) {
      const pane = execFileSync('tmux', [...tmuxSocketArgs(preferredManagedTmuxSocket(env)),
        'capture-pane', '-p', '-t', `bmx-${sessionId.substring(0, 8)}`], { env, encoding: 'utf8' });
      expect(traexRestoredComposerReady(pane)).toBe(mode !== 'native-viewport-loading');
      if (mode === 'native-viewport-race') {
        await waitFor(() => existsSync(captureStarted), 'native ready capture started');
        const id = paint(COMPOSER.map(row => row.replace('GPT-6-Astra xhigh', 'loading')));
        await waitFor(() => readFileSync(seenFile, 'utf8') === String(id), 'loading repaint after captured ready viewport');
        await new Promise(resolveWait => setTimeout(resolveWait, 200));
        writeFileSync(captureReleased, 'release stale ready capture');
        await new Promise(resolveWait => setTimeout(resolveWait, 3_200));
        expect(existsSync(inputFile), logs.join('')).toBe(false);
        expect(messages.some(message => message.type === 'prompt_ready')).toBe(false);
        paint(COMPOSER);
      }
      if (mode === 'native-viewport-loading') {
        await new Promise(resolveWait => setTimeout(resolveWait, 6_200));
        expect(existsSync(inputFile), logs.join('')).toBe(false);
        expect(messages.some(message => message.type === 'prompt_ready')).toBe(false);
        paint(COMPOSER);
      }
    }
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
