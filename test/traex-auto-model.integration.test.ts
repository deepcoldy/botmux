import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { resolveCodexRpcInput } from '../src/services/codex-rpc-input-policy.js';
import { killWorkerTmuxSession } from './helpers/worker-tmux-session.js';
import { readJsonLines } from './helpers/read-json-lines.js';
import { messages as zhMessages } from '../src/i18n/zh.js';

// Structural match for the capacity-switch notice, not a hard-coded copy line:
// take the longest placeholder-free literal of the SAME zh template the worker
// renders (the test worker runs with the default zh locale). A copy edit in
// zh.ts then moves this fragment, the assertion and the worker-side delay hook
// together, so the hook can never silently stop matching.
const modelOrderNoticeFragment = zhMessages['worker.traex_auto_model.available_model']
  .split(/\{[^}]*\}/).map(part => part.trim()).filter(part => part.length >= 4)
  .sort((a, b) => b.length - a.length)[0];
// Fail at module load with an actionable message if the template is ever edited
// down to placeholders only: otherwise the value would silently be undefined,
// the worker delay hook would never match, and the regression would only show
// up as a confusing notice-count timeout deep inside the test.
if (!modelOrderNoticeFragment) {
  throw new Error('worker.traex_auto_model.available_model has no >=4-char literal fragment to match');
}

const children: ChildProcess[] = [];
const roots: string[] = [];
const panes: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolveExit => child.once('exit', resolveExit));
      child.kill('SIGKILL');
      await Promise.race([stopped, new Promise(resolveWait => setTimeout(resolveWait, 2_000))]);
    }
  }
  for (const pane of panes.splice(0)) {
    killWorkerTmuxSession(`=${pane}`);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rows(path: string): any[] {
  return readJsonLines(path);
}

async function fixture(enabled: boolean, loadData: false | 'busy' | 'ordered' = false, reselectPerTurn = false,
  rpcPolicy?: { override?: boolean; global: boolean }, restoreWithoutBanner = false, startupExtraArgs?: string,
  freshStart = false, activityMode?: 'working' | 'queue-after-second', terminalDelayMs = 0,
  delaySecondModelOrderNoticeMs = 0) {
  const root = mkdtempSync(join(tmpdir(), 'botmux-auto-model-'));
  roots.push(root);
  const dataDir = join(root, 'session');
  const traeHome = join(root, '.trae');
  const cliDir = join(traeHome, 'cli');
  const nativeId = '00000000-0000-7000-8000-000000000555';
  const rollouts = join(cliDir, 'sessions', '2026', '10', '21');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(rollouts, { recursive: true });
  const rolloutPath = join(rollouts, `rollout-2026-10-21T00-00-00-${nativeId}.jsonl`);
  const historyPath = join(cliDir, 'history.jsonl');
  const submissions = join(root, 'submissions.jsonl');
  const launches = join(root, 'launches.jsonl');
  const rpcRequests = join(root, 'catalog-requests.jsonl');
  const release = join(root, 'release');
  writeFileSync(rolloutPath, '');
  writeFileSync(historyPath, '');
  const fake = join(root, 'fake-traex');
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'app-server') {
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\\n')) >= 0) {
      const request = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
      fs.appendFileSync(${JSON.stringify(rpcRequests)}, JSON.stringify({ method: request.method }) + '\\n');
      if (request.method === 'initialize') process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
      if (request.method === 'model/list') process.stdout.write(JSON.stringify({ id: request.id, result: {
        data: ${JSON.stringify(loadData ? [
          { id: 'core', businessMetadata: { load: { load_percent: 180 } } },
          { id: 'backup', businessMetadata: { load: { load_percent: loadData === 'ordered' ? 100 : 160 } } },
          { id: 'last', businessMetadata: { load: { load_percent: loadData === 'ordered' ? 50 : 120 } } },
          { id: 'outside', businessMetadata: { load: { load_percent: 0 } } },
        ] : [])}, nextCursor: null } }) + '\\n');
    }
  });
} else {
const model = process.argv[process.argv.indexOf('--model') + 1];
const nativeId = ${JSON.stringify(nativeId)};
const release = ${JSON.stringify(release)};
const rollout = ${JSON.stringify(rolloutPath)};
// Fresh-session discovery follows the native CLI's open rollout descriptor.
const rolloutFd = fs.openSync(rollout, 'a');
if (!process.argv.includes('resume')) fs.writeSync(rolloutFd, JSON.stringify({
  type: 'session_meta', payload: { id: nativeId, cwd: process.cwd() },
}) + '\\n');
fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({ model, args: process.argv.slice(2) }) + '\\n');
process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\\x1b[?2004h');
let input = '', pasted = '', submitted = false, completed = false, submissionCount = 0;
let turnId;
const startedAt = Date.now();
function line(payload) { fs.writeSync(rolloutFd, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload }) + '\\n'); }
function idle() {
  if (${JSON.stringify(restoreWithoutBanner)} && model !== 'core') {
    if (Date.now() - startedAt < 400) {
      process.stdout.write('\\x1b[2J\\x1b[H│ model: loading /model to change │\\n│ directory: ${dataDir} │\\n❯ Explain this codebase\\n');
    } else {
      process.stdout.write('\\x1b[2J\\x1b[H■ Conversation interrupted - use /feedback if something went wrong\\n⚠ This session was recorded with model core but is resuming with backup. Consider switching back as it may affect TRAE CLI performance.\\n──────── Configure botmux environment ─\\n❯ Explain this codebase\\n───────────────────────────────────────\\n  ' + model + ' xhigh · ~ · Context 89% left\\n  ☢ Full Access · ? for shortcuts\\n');
    }
    return;
  }
  process.stdout.write('\\x1b[2J\\x1b[H╭──────────────────────────────────────────╮\\n│ model: ' + model + ' /model to change │\\n│ directory: ${dataDir} │\\n╰──────────────────────────────────────────╯\\n❯ Ask TraeCode CLI to do anything\\nContext 99% left\\n');
}
function queued() {
  const rank = model === 'core' ? 1590 : model === 'backup' ? 1000 : 10;
  process.stdout.write('\\x1b[2J\\x1b[H◆ Queued for capacity (20s • esc to interrupt)\\n  └ Too many requests right now. You\\'re in the queue at position ' + rank + '.\\nContext 99% left\\n');
}
idle();
for (const delay of [200, 500, 1000]) setTimeout(() => { if (!submitted) idle(); }, delay);
process.stdin.on('data', chunk => {
  input += chunk;
  const start = input.indexOf('\\x1b[200~');
  const end = input.indexOf('\\x1b[201~', start + 6);
  if (start >= 0 && end >= 0) { pasted = input.slice(start + 6, end); input = input.slice(end + 6); }
  if (pasted && /[\\r\\n]/.test(input)) {
    const text = pasted; pasted = ''; input = ''; submitted = true; completed = false;
    turnId = require('node:crypto').randomUUID();
    fs.appendFileSync(${JSON.stringify(submissions)}, JSON.stringify({ model, text }) + '\\n');
    fs.appendFileSync(${JSON.stringify(historyPath)}, JSON.stringify({ session_id: nativeId, ts: Date.now() / 1000, text }) + '\\n');
    line({ type: 'task_started', turn_id: turnId });
    line({ type: 'user_message', message: text, images: [], local_images: [], text_elements: [], turn_id: turnId });
    submissionCount++;
    if (${JSON.stringify(activityMode !== undefined)} && (${JSON.stringify(activityMode === 'working')} || submissionCount === 1)) {
      process.stdout.write('\\x1b[2J\\x1b[H◆ Working… (2s • esc to interrupt)\\nContext 99% left\\n');
    } else queued();
  }
});
setInterval(() => {
  if (submitted && !completed && fs.existsSync(release)) {
    completed = true;
    const complete = () => line({ type: 'task_complete', turn_id: turnId, last_agent_message: 'done', duration_ms: 1000 });
    // terminalDelayMs paints the composer BEFORE the authoritative terminal:
    // the exact window where a capacity-held follow-up must not be type-ahead
    // written into the still-running degraded pane.
    if (${terminalDelayMs} > 0) { idle(); setTimeout(complete, ${terminalDelayMs}); }
    else { complete(); idle(); }
  }
}, 100);
}
`);
  chmodSync(fake, 0o755);
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const sessionId = randomUUID();
  const binary = process.env.BOTMUX_TEST_WORKER_BINARY;
  const backendType = binary || process.env.BOTMUX_TEST_WORKER_BACKEND === 'tmux' ? 'tmux' : 'pty';
  if (backendType === 'tmux') panes.push(`bmx-${sessionId.slice(0, 8)}`);
  const options = {
    cwd: resolve('.'),
    env: { ...process.env, HOME: root, TRAE_HOME: traeHome, BOTMUX_TIME_SCALE: '0.01',
      CLI_EXTRA_ARGS: startupExtraArgs ?? '', SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'] as any,
  };
  let entry = resolve('src/worker.ts');
  if (!binary && (activityMode || delaySecondModelOrderNoticeMs > 0)) {
    // Test-only worker bootstrap, generated into the fixture's cleaned root.
    // - activityMode: heartbeats + capture timing for admission measurements;
    // - delaySecondModelOrderNoticeMs: delay the worker-side send of the 2nd
    //   capacity-switch notice, reproducing IPC/backpressure delivery lag. The
    //   notice rides the worker IPC channel while the relaunched CLI's
    //   submission rides the PTY channel; the notice leads the 3rd submission
    //   by only a few seconds locally, so 4s reliably inverts their arrival.
    const tmuxImport = JSON.stringify(pathToFileURL(resolve('src/adapters/backend/tmux-pipe-backend.ts')).href);
    const workerImport = JSON.stringify(pathToFileURL(resolve('src/worker.ts')).href);
    const heartbeatProbe = activityMode ? `
let previous = performance.now();
setInterval(() => {
  const now = performance.now();
  if (process.connected) process.send?.({ type: 'admission_heartbeat', atMs: Date.now(), gapMs: now - previous });
  previous = now;
}, 5).unref();
const { TmuxPipeBackend } = await import(${tmuxImport});
const capture = TmuxPipeBackend.prototype.captureViewportAsync;
TmuxPipeBackend.prototype.captureViewportAsync = async function () {
  const started = performance.now();
  try { return await capture.call(this); }
  finally { if (process.connected) process.send?.({ type: 'admission_capture', elapsedMs: performance.now() - started }); }
};
` : '';
    const delayedNoticeSend = delaySecondModelOrderNoticeMs > 0 ? `
const __modelOrderNoticeFragment = ${JSON.stringify(modelOrderNoticeFragment)};
let __modelOrderNotices = 0;
const __realSend = process.send?.bind(process);
if (__realSend) process.send = function (msg: any, callback?: any): boolean {
  if (msg && msg.type === 'user_notify' && typeof msg.message === 'string'
    && msg.message.includes(__modelOrderNoticeFragment)) {
    __modelOrderNotices++;
    if (__modelOrderNotices === 2) {
      setTimeout(() => __realSend(msg, callback), ${delaySecondModelOrderNoticeMs});
      return true;
    }
  }
  return __realSend(msg, callback) as boolean;
} as typeof process.send;
` : '';
    entry = join(root, activityMode ? 'observed-worker.mts' : 'delayed-notice-worker.mts');
    writeFileSync(entry, `${delayedNoticeSend}${heartbeatProbe}await import(${workerImport});
`);
  }
  const child = binary ? spawn(binary, ['__worker'], options) : spawnNodeTsScript(entry, [], options);
  children.push(child);
  const measurements: any[] = [];
  child.on('message', (raw: any) => {
    if (raw.type === 'admission_heartbeat' || raw.type === 'admission_capture') measurements.push(raw);
    else messages.push(raw as WorkerToDaemon);
  });
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  async function wait(predicate: () => boolean, description: string, timeout = 35_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (predicate()) return;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`worker exited: ${description}\n${logs.join('')}`);
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    throw new Error(`timeout: ${description}\n${logs.join('')}`);
  }
  const init = { type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
    workingDir: dataDir, cliId: 'traex', cliPathOverride: fake, cliSessionId: freshStart ? undefined : nativeId,
    resume: !freshStart, model: 'core', backendType, prompt: '',
    ...(rpcPolicy ? { codexRpcInput: resolveCodexRpcInput('traex', rpcPolicy.override, rpcPolicy.global) } : {}),
    ...(enabled ? { traexAutoModel: { enabled: true, models: ['core', 'backup', 'last'], queueTimeoutMs: 5_000, switchCooldownMs: 5_000,
      reselectPerTurn,
      ...(loadData ? { modelSettings: {
        core: { reasoningEffort: 'high', modelBackendVariant: 'standard' },
        backup: { reasoningEffort: 'xhigh', modelBackendVariant: 'standard' },
        last: { reasoningEffort: 'xhigh', modelBackendVariant: 'max' },
      } } : {}),
    } } : {}),
    larkAppId: 'app_test', larkAppSecret: 'secret' } satisfies DaemonToWorker;
  child.send(init);
  if (startupExtraArgs) await wait(() => messages.some(message => message.type === 'error' && message.message.includes('cannot be overridden')), 'rejected external model argv');
  else await wait(() => messages.some(message => message.type === 'prompt_ready'), 'startup prompt');
  return { child, messages, wait, submissions, launches, release, nativeId, logs, rpcRequests, init, measurements };
}

describe('TraeX auto-model real Worker and PTY', () => {
  it('submits healthy running follow-ups in order on the current model', async () => {
    const f = await fixture(true, false, false, undefined, false, undefined, false, 'working');
    f.child.send({ type: 'message', content: 'original working ask', turnId: 'om_working' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'original working submit');
    const started = performance.now();
    const heartbeatStartMs = Date.now();
    f.measurements.length = 0;
    f.child.send({ type: 'message', content: 'healthy correction one', turnId: 'om_one' } satisfies DaemonToWorker);
    f.child.send({ type: 'message', content: 'healthy correction two', turnId: 'om_two' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 3, 'both running corrections');
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(1_500);
    expect(rows(f.submissions).map(row => row.text.split(/[\r\n]/)[0])).toEqual([
      'original working ask', 'healthy correction one', 'healthy correction two',
    ]);
    expect(rows(f.submissions).slice(1).every(row => !row.text.includes('botmux_skills_refresh'))).toBe(true);
    expect(rows(f.launches).map(row => row.model)).toEqual(['core']);
    const heartbeats = f.measurements.filter(row => row.type === 'admission_heartbeat' && row.atMs >= heartbeatStartMs);
    const captures = f.measurements.filter(row => row.type === 'admission_capture').map(row => row.elapsedMs);
    if (!process.env.BOTMUX_TEST_WORKER_BINARY) expect(heartbeats.length).toBeGreaterThan(0);
    console.log(JSON.stringify({ measurement: 'real-worker-running-additions',
      backend: process.env.BOTMUX_TEST_WORKER_BACKEND ?? 'pty', count: 2, elapsedMs,
      heartbeatTicks: heartbeats.length, maxHeartbeatGapMs: Math.max(0, ...heartbeats.map(row => row.gapMs)),
      captureCount: captures.length, captureMs: captures }));
  }, 45_000);

  it('keeps a successive input queued after the preceding write changes Working to capacity', async () => {
    const f = await fixture(true, false, false, undefined, false, undefined, false, 'queue-after-second');
    f.child.send({ type: 'message', content: 'original working ask', turnId: 'om_working' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'original working submit');
    f.child.send({ type: 'message', content: 'correction changes capacity', turnId: 'om_capacity' } satisfies DaemonToWorker);
    f.child.send({ type: 'message', content: 'held successor', turnId: 'om_held' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 2, 'correction submitted');
    await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
    expect(rows(f.submissions).map(row => row.text.split(/[\r\n]/)[0])).toEqual([
      'original working ask', 'correction changes capacity',
    ]);
    expect(rows(f.launches).map(row => row.model)).toEqual(['core']);
    writeFileSync(f.release, 'finish');
    await f.wait(() => rows(f.submissions).length === 3, 'held input after composer');
    expect(rows(f.submissions).filter(row => row.text.startsWith('held successor'))).toHaveLength(1);
  }, 45_000);

  it('preserves a fresh topic selection, final wait and catalog across an in-worker restart', async () => {
    const f = await fixture(true, 'busy', false, undefined, false, undefined, true);
    expect(f.init.resume).toBe(false);
    f.child.send({ type: 'message', content: 'fresh original ask', turnId: 'om_fresh' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 2, 'fresh-topic capacity switch');
    const currentRuntime = () => f.messages.filter(message => message.type === 'active_runtime')
      .map(message => message.traexAutoModelRuntime).filter(Boolean).at(-1);
    await f.wait(() => currentRuntime()?.waitingOnFinalModel === true, 'final-model hold published');
    const before = currentRuntime()!;
    expect(before).toMatchObject({ model: 'last', nativeSessionId: f.nativeId });
    expect(before.skillCatalogFingerprint).toEqual(expect.any(String));
    expect(rows(f.launches)[0].args[0]).not.toBe('resume');

    const readyCount = f.messages.filter(message => message.type === 'prompt_ready').length;
    f.child.send({ type: 'restart', reason: 'operator', model: 'core', codexRpcInput: false,
      traexAutoModel: f.init.traexAutoModel } satisfies DaemonToWorker);
    await f.wait(() => rows(f.launches).length === 3
      && f.messages.filter(message => message.type === 'prompt_ready').length > readyCount, 'same-worker restarted CLI ready');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'last', 'last']);
    expect(rows(f.launches)[2].args).toEqual(rows(f.launches)[1].args);

    const queryCount = rows(f.rpcRequests).length;
    await new Promise(resolveWait => setTimeout(resolveWait, 6_000));
    expect(rows(f.launches)).toHaveLength(3);
    expect(rows(f.rpcRequests)).toHaveLength(queryCount);
    expect(currentRuntime()).toMatchObject({ model: 'last', waitingOnFinalModel: true,
      skillCatalogFingerprint: before.skillCatalogFingerprint });
    // Restart may submit an attributed interruption note before the next user
    // input. Let that native turn finish; a final capacity wait must not admit
    // the next user turn just because the replacement reached its prompt.
    writeFileSync(f.release, 'finish resumed turn');
    f.child.send({ type: 'message', content: 'next ask after restart', turnId: 'om_after_restart' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).some(row => row.text.startsWith('next ask after restart')), 'input after restart');
    expect(rows(f.launches)).toHaveLength(3);
    expect(rows(f.submissions).filter(row => row.text.startsWith('fresh original ask'))).toHaveLength(1);
    expect(rows(f.submissions).slice(1).filter(row => row.text.includes('botmux_skills_refresh'))).toEqual([]);
  }, 80_000);

  it('refuses environment argv before launching an out-of-pool model', async () => {
    const f = await fixture(true, false, false, undefined, false, '--model outside');
    expect(rows(f.launches)).toEqual([]);
    expect(rows(f.rpcRequests)).toEqual([]);
    expect(f.messages.some(message => message.type === 'prompt_ready')).toBe(false);
  });

  it('continues the original turn and queued follow-up when resume restores a composer without a loaded banner', async () => {
    const f = await fixture(true, false, false, undefined, true);
    f.child.send({ type: 'message', content: 'original image ask', turnId: 'om_image' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'original image submit');
    await f.wait(() => /authoritative viewport still shows busy marker|structured turn is unfinished/.test(f.logs.join('')), 'confirmed active queue');
    f.child.send({ type: 'message', content: 'follow-up image', turnId: 'om_followup' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 2, 'restored composer continuation', 30_000);
    expect(f.logs.join('')).toContain('restored composer observed on screen');
    expect(f.logs.join('')).not.toContain('WARN First prompt hard timeout');
    expect(rows(f.submissions).filter(row => row.text.startsWith('original image ask'))).toHaveLength(1);
    expect(rows(f.submissions).filter(row => row.text.startsWith('follow-up image'))).toHaveLength(0);
    expect(rows(f.launches).every(row => row.args.at(-1) === f.nativeId)).toBe(true);
    // Let the fake CLI's history receipt finish before completing its turn;
    // this scenario exercises startup recovery, not terminal-before-receipt.
    await new Promise(resolveWait => setTimeout(resolveWait, 3_000));
    writeFileSync(f.release, 'finish');
    await f.wait(() => rows(f.submissions).length === 3, 'queued follow-up submit', 15_000);
    expect(rows(f.submissions).filter(row => row.text.startsWith('follow-up image'))).toHaveLength(1);
    expect(f.messages.some(message => message.type === 'user_notify' && message.message.includes('90 秒'))).toBe(false);
  }, 70_000);

  it('automatically uses terminal input for legacy Auto even when the daemon sends inherited RPC', async () => {
    const f = await fixture(true, false, false, { global: true });
    expect(f.messages.some(message => message.type === 'user_notify' && message.message.includes('RPC'))).toBe(false);
    expect(rows(f.rpcRequests)).toHaveLength(0);
    f.child.send({ type: 'message', content: 'original ask', turnId: 'om_legacy' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 2, 'legacy Auto continuation');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup']);
    expect(rows(f.launches).every(row => row.args[0] === 'resume' && row.args.at(-1) === f.nativeId)).toBe(true);
    expect(rows(f.submissions).filter(row => row.text.startsWith('original ask'))).toHaveLength(1);
  }, 45_000);

  it('resumes exact native history through exhaustion, then runs the next input on the preferred model', async () => {
    // Composer repaint precedes the authoritative terminal by 5.5s. A
    // follow-up stamped while capacity owns the pane must survive that gap
    // and still be submitted as its own turn after the preferred reset.
    const f = await fixture(true, false, true, undefined, false, undefined, false, undefined, 5_500);
    f.child.send({ type: 'message', content: 'original ask', turnId: 'om_first' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'original submit');
    // Arrives during the queue: stays a distinct turn through both restarts.
    // A receipt on disk precedes the PTY redraw; require a visible queue frame.
    await f.wait(() => f.messages.some(message => message.type === 'screen_update'
      && message.content.includes('position 1590')), 'first model capacity viewport');
    f.child.send({ type: 'message', content: 'next ask', turnId: 'om_next' } satisfies DaemonToWorker);
    await f.wait(() => f.messages.some(message => message.type === 'user_notify' && message.message.includes('均持续排队')), 'exhaustion', 55_000);
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.submissions).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.submissions).filter(row => row.text.startsWith('original ask'))).toHaveLength(1);
    expect(rows(f.submissions).filter(row => row.text.startsWith('next ask'))).toHaveLength(0);
    for (const launch of rows(f.launches)) {
      expect(launch.args[0]).toBe('resume');
      expect(launch.args.at(-1)).toBe(f.nativeId);
    }
    const notices = f.messages.filter(message => message.type === 'user_notify' && message.message.includes('均持续排队')).length;
    await new Promise(resolveWait => setTimeout(resolveWait, 6_000));
    expect(rows(f.launches)).toHaveLength(3);
    expect(f.messages.filter(message => message.type === 'user_notify' && message.message.includes('均持续排队'))).toHaveLength(notices);
    writeFileSync(f.release, 'go');
    // The preferred-model relaunch (4th launch row) and the re-submission are
    // written by different steps; waiting on the submission alone races the
    // launch record under load (the row can land seconds later). Wait for
    // both durabilities, with model attribution inside the predicate: an input
    // consumed by the pre-switch 'last' process can never satisfy this, so a
    // real misroute fails by timeout instead of flaking on the launch assert.
    await f.wait(() => {
      const nextSubmissions = rows(f.submissions).filter(row => row.text.startsWith('next ask'));
      return rows(f.launches).length === 4
        && nextSubmissions.length === 1
        && nextSubmissions[0]!.model === 'core';
    }, 'next ask relaunched on the preferred model after reset');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last', 'core']);
    expect(rows(f.submissions).filter(row => row.text.startsWith('next ask'))).toEqual([expect.objectContaining({ model: 'core' })]);
  }, 100_000);

  it('keeps a follow-up arriving after exhaustion (but before the terminal) out of the degraded pane', async () => {
    // Both queue-walk-off branches clear queueSinceMs at the moment of
    // exhaustion, while the pane is STILL parked on the last fallback model
    // and the predecessor turn owns it. A follow-up arriving here must be
    // tagged from the latched exhausted state plus the live queued pane — not
    // type-ahead written into "last". Composer still precedes the terminal.
    const f = await fixture(true, false, true, undefined, false, undefined, false, undefined, 5_500);
    f.child.send({ type: 'message', content: 'original ask', turnId: 'om_first' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'original submit');
    await f.wait(() => f.messages.some(message => message.type === 'screen_update'
      && message.content.includes('position 1590')), 'first model capacity viewport');
    await f.wait(() => f.messages.some(message => message.type === 'user_notify' && message.message.includes('均持续排队')), 'exhaustion', 55_000);
    // Only now does the follow-up arrive: exhausted latch is set, queueSinceMs
    // is cleared, but the live pane still shows the queue at the last model.
    f.child.send({ type: 'message', content: 'next ask', turnId: 'om_next' } satisfies DaemonToWorker);
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.submissions).filter(row => row.text.startsWith('next ask'))).toHaveLength(0);
    const notices = f.messages.filter(message => message.type === 'user_notify' && message.message.includes('均持续排队')).length;
    await new Promise(resolveWait => setTimeout(resolveWait, 6_000));
    expect(rows(f.launches)).toHaveLength(3);
    expect(f.messages.filter(message => message.type === 'user_notify' && message.message.includes('均持续排队'))).toHaveLength(notices);
    writeFileSync(f.release, 'go');
    await f.wait(() => {
      const nextSubmissions = rows(f.submissions).filter(row => row.text.startsWith('next ask'));
      return rows(f.launches).length === 4
        && nextSubmissions.length === 1
        && nextSubmissions[0]!.model === 'core';
    }, 'next ask relaunched on the preferred model, never written to the fallback pane');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last', 'core']);
    expect(rows(f.submissions).filter(row => row.text.startsWith('next ask'))).toEqual([expect.objectContaining({ model: 'core' })]);
  }, 100_000);

  it('when all loads are high, holds the lowest allowlisted model and publishes its card identity', async () => {
    const f = await fixture(true, 'busy', false, { global: true, override: false });
    f.child.send({ type: 'message', content: 'original ask', turnId: 'om_first' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 2, 'lowest-load continuation');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'last']);
    expect(rows(f.launches)[0].args).toContain('model_reasoning_effort="high"');
    expect(rows(f.launches)[0].args).toContain('model_backend_variant="standard"');
    expect(rows(f.launches)[1].args).toContain('model_reasoning_effort="xhigh"');
    expect(rows(f.launches)[1].args).toContain('model_backend_variant="max"');
    expect(rows(f.submissions).map(row => row.model)).toEqual(['core', 'last']);
    await f.wait(() => f.messages.some(message => message.type === 'active_runtime' && message.model === 'last'), 'card model identity');
    expect(f.messages).toContainEqual(expect.objectContaining({ type: 'active_runtime', model: 'last',
      reasoningEffort: 'xhigh', modelBackendVariant: 'max' }));
    expect(f.messages.filter(message => message.type === 'user_notify' && message.message.includes('120%'))).toHaveLength(1);
    await new Promise(resolveWait => setTimeout(resolveWait, 8_000));
    expect(rows(f.launches)).toHaveLength(2);
    expect(rows(f.submissions).filter(row => row.text.startsWith('original ask'))).toHaveLength(1);
    expect(rows(f.rpcRequests).map(row => row.method)).toEqual(['initialize', 'initialized', 'model/list']);
    writeFileSync(f.release, 'go');
    f.child.send({ type: 'message', content: 'next ask', turnId: 'om_next' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).some(row => row.text === 'next ask'), 'sticky input without repeated skill catalog');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'last']);
    expect(f.messages).toContainEqual(expect.objectContaining({ type: 'active_runtime',
      traexAutoModelRuntime: expect.objectContaining({ model: 'last', waitingOnFinalModel: true }) }));
  }, 55_000);

  it('prefers the earlier available model, proceeds if it queues, then retains it for the next turn', async () => {
    // Last positional arg: hold the 2nd capacity-switch notice in the worker
    // for 4s (deterministic stand-in for CI IPC scheduling lag — see fixture).
    const f = await fixture(true, 'ordered', false, undefined, undefined, undefined, undefined, undefined, undefined, 4_000);
    f.child.send({ type: 'message', content: 'original ask', turnId: 'om_first' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 2, 'earlier available backup');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup']);
    expect(rows(f.launches)[1].args).toContain('model_reasoning_effort="xhigh"');
    expect(rows(f.launches)[1].args).toContain('model_backend_variant="standard"');
    expect(f.messages).toContainEqual(expect.objectContaining({ type: 'active_runtime',
      model: 'backup', reasoningEffort: 'xhigh', modelBackendVariant: 'standard' }));
    await f.wait(() => f.messages.some(message => message.type === 'screen_update'
      && message.content.includes('position 1000')), 'backup capacity viewport');
    f.child.send({ type: 'message', content: 'next ask', turnId: 'om_next' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 3, 'later model after backup queues');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.launches)[2].args).toContain('model_backend_variant="max"');
    expect(rows(f.submissions).filter(row => row.text.startsWith('next ask'))).toHaveLength(0);
    expect(rows(f.submissions).filter(row => row.text.startsWith('original ask'))).toHaveLength(1);
    // The switch notice travels on the worker IPC channel, the submission on
    // the PTY channel: submissions===3 does not imply both notices arrived.
    // Wait on the SAME channel we assert (loaded CI runners otherwise see 1);
    // this test injects a worker-side delay on the 2nd notice via
    // delaySecondModelOrderNoticeMs to make that ordering deterministic.
    await f.wait(
      () => f.messages.filter(message => message.type === 'user_notify'
        && message.message.includes(modelOrderNoticeFragment)).length === 2,
      'both capacity-switch notices (core→backup, backup→last)',
    );
    expect(f.messages.filter(message => message.type === 'user_notify' && message.message.includes(modelOrderNoticeFragment))).toHaveLength(2);
    for (const launch of rows(f.launches)) {
      expect(launch.args[0]).toBe('resume');
      expect(launch.args.at(-1)).toBe(f.nativeId);
    }
    await f.wait(() => f.messages.some(message => message.type === 'user_notify' && message.message.includes('保持等待')), 'final wait');
    await new Promise(resolveWait => setTimeout(resolveWait, 6_000));
    expect(rows(f.launches)).toHaveLength(3);
    expect(new Set(rows(f.rpcRequests).map(row => row.method))).toEqual(new Set(['initialize', 'initialized', 'model/list']));
    expect(rows(f.rpcRequests).filter(row => row.method === 'model/list')).toHaveLength(3);
    writeFileSync(f.release, 'go');
    await f.wait(() => rows(f.submissions).some(row => row.text.startsWith('next ask')), 'next turn on retained model');
    expect(rows(f.launches).map(row => row.model)).toEqual(['core', 'backup', 'last']);
    expect(rows(f.submissions).filter(row => row.text.startsWith('next ask'))).toEqual([{ model: 'last', text: 'next ask' }]);
    expect(rows(f.submissions).slice(1).every(row => !row.text.includes('botmux_skills_refresh'))).toBe(true);
  }, 100_000);

  it('leaves capacity queues alone when the feature is disabled', async () => {
    const f = await fixture(false);
    f.child.send({ type: 'message', content: 'original ask', turnId: 'om_first' } satisfies DaemonToWorker);
    await f.wait(() => rows(f.submissions).length === 1, 'submit');
    await new Promise(resolveWait => setTimeout(resolveWait, 8_000));
    expect(rows(f.launches)).toHaveLength(1);
    expect(f.messages.filter(message => message.type === 'user_notify' && /白名单|allowlist/.test(message.message))).toHaveLength(0);
  }, 50_000);
});
