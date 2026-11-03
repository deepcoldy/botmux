import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { spawnNodeTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const fixtures: ReturnType<typeof setup>[] = [];
const parentId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const childId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, logs: string[], timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(`Antigravity fork timed out\n${logs.join('').slice(-8000)}`);
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'botmux-agy-fork-'));
  const state = join(root, '.gemini', 'antigravity-cli');
  const data = join(root, 'data');
  const inputLog = join(root, 'inputs.jsonl');
  const byteLog = join(root, 'input-bytes.jsonl');
  const launchLog = join(root, 'launches.jsonl');
  const release = join(root, 'release-fork');
  const cliPids = join(root, 'pids');
  const sessionId = randomUUID();
  const children: ChildProcess[] = [];
  mkdirSync(data, { recursive: true });
  mkdirSync(join(state, 'conversations'), { recursive: true });
  const parentFile = join(state, 'conversations', `${parentId}.db`);
  writeFileSync(parentFile, 'PARENT_IMMUTABLE_STATE');
  const parentLogs = join(state, 'brain', parentId, '.system_generated', 'logs');
  mkdirSync(parentLogs, { recursive: true });
  writeFileSync(join(parentLogs, 'transcript_full.jsonl'), [
    { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', created_at: new Date().toISOString(), content: '<USER_REQUEST>\nPARENT_FIRST\n</USER_REQUEST>' },
    { step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', created_at: new Date().toISOString(), content: 'PARENT_OLD_REPLY' },
  ].map(row => JSON.stringify(row) + '\n').join(''));
  const script = join(root, 'fake-agy');
  writeFileSync(script, `#!${tsRunnerPrefix().command}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const logFile = args[args.indexOf('--log-file') + 1];
let current = args[args.indexOf('--conversation') + 1];
const parent = ${JSON.stringify(parentId)}, child = ${JSON.stringify(childId)};
const state = ${JSON.stringify(state)};
const append = (p, o) => fs.appendFileSync(p, JSON.stringify(o) + '\\n');
append(${JSON.stringify(launchLog)}, { id: current });
fs.appendFileSync(${JSON.stringify(cliPids)}, process.pid + '\\n');
const handles = [fs.openSync(path.join(state, 'conversations', current + '.db'), 'a')];
const native = text => fs.appendFileSync(logFile, 'I1103 12:00:00.000001 100 server.go:1] ' + text + '\\n');
native('Streaming conversation ' + current);
const screen = () => process.stdout.write('\\x1b[2J\\x1b[HNative agy fixture\\r\\n────────\\r\\n>\\r\\n────────\\r\\n? for shortcuts\\r\\n');
process.stdin.setRawMode(true);
setTimeout(screen, 150);
let buf = '', turn = 0;
const previousLog = path.join(state, 'brain', current, '.system_generated', 'logs', 'transcript_full.jsonl');
let nextStep = fs.existsSync(previousLog)
  ? Math.max(...fs.readFileSync(previousLog, 'utf8').trim().split('\\n').filter(Boolean).map(line => JSON.parse(line).step_index)) + 1 : 2;
process.stdin.on('data', chunk => {
  append(${JSON.stringify(byteLog)}, chunk.toString('base64'));
  buf += chunk.toString();
  let at;
  while ((at = buf.indexOf('\\r')) >= 0) {
    if (at > 0 && buf[at - 1] === '\\x1b') {
      buf = buf.slice(0, at - 1) + '\\n' + buf.slice(at + 1);
      continue;
    }
    const text = buf.slice(0, at); buf = buf.slice(at + 1);
    if (!text) continue;
    append(${JSON.stringify(inputLog)}, { id: current, text });
    if (text === '/fork') {
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(release)})) return;
        clearInterval(timer);
        native('Forked conversation ' + current + ' -> ' + child);
        current = child;
        handles.push(fs.openSync(path.join(state, 'conversations', child + '.db'), 'a'));
        native('Streaming conversation ' + child);
        screen();
      }, 25);
      continue;
    }
    fs.appendFileSync(path.join(state, 'history.jsonl'), JSON.stringify({ display: text, timestamp: Date.now(), workspace: ${JSON.stringify(data)}, conversationId: current }) + '\\n');
    process.stdout.write('\\x1b[2J\\x1b[HWorking... esc to cancel\\r\\n');
    const logs = path.join(state, 'brain', current, '.system_generated', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const n = turn++;
    const rows = [
      { step_index: nextStep++, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', created_at: new Date().toISOString(), content: '<USER_REQUEST>\\n' + text + '\\n</USER_REQUEST>' },
      { step_index: nextStep++, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', created_at: new Date().toISOString(), content: 'CHILD_REPLY_' + (n + 1) }
    ].map(r => JSON.stringify(r) + '\\n').join('');
    setTimeout(() => {
      fs.appendFileSync(path.join(logs, 'transcript.jsonl'), rows);
      fs.appendFileSync(path.join(logs, 'transcript_full.jsonl'), rows);
      setTimeout(screen, 300);
    }, 1200);
  }
});
setInterval(() => { void handles; }, 1000);
`);
  chmodSync(script, 0o755);

  function start(opts: { fork?: boolean; prompt?: string; id?: string } = {}) {
    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const worker = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: { ...process.env, HOME: root, SESSION_DATA_DIR: data, BOTMUX_SESSION_ID: sessionId,
        BOTMUX_TIME_SCALE: '0.05', LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(worker);
    worker.on('message', raw => messages.push(raw as WorkerToDaemon));
    worker.stdout?.on('data', chunk => logs.push(chunk.toString()));
    worker.stderr?.on('data', chunk => logs.push(chunk.toString()));
    worker.send({ type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_child', workingDir: data,
      cliId: 'antigravity', cliPathOverride: script, backendType: 'pty', promptInjection: 'none',
      resume: true, cliSessionId: opts.id ?? parentId, forkSession: opts.fork ?? true,
      prompt: opts.prompt ?? 'CHILD_FIRST', turnId: opts.fork === false ? 'om_after_restart' : 'om_first',
      larkAppId: 'app_test', larkAppSecret: 'secret',
    } satisfies DaemonToWorker);
    const ids = () => messages.filter(m => m.type === 'cli_session_id').map(m => m.cliSessionId);
    const finals = () => messages.filter(m => m.type === 'final_output');
    return { worker, logs, messages, ids, finals };
  }
  const inputs = (): Array<{ id: string; text: string }> => existsSync(inputLog)
    ? readFileSync(inputLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  async function stop(worker: ChildProcess) {
    if (worker.exitCode !== null || worker.signalCode !== null) return;
    worker.send({ type: 'close' } satisfies DaemonToWorker, () => {});
    const timer = setTimeout(() => worker.kill('SIGKILL'), 4_000);
    await new Promise<void>(done => worker.once('exit', () => done()));
    clearTimeout(timer);
  }
  return { root, state, release, parentFile, launchLog, cliPids, byteLog, children, start, stop, inputs };
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const child of f.children) await f.stop(child);
    if (existsSync(f.cliPids)) for (const line of readFileSync(f.cliPids, 'utf8').trim().split('\n')) {
      const pid = Number(line);
      if (Number.isSafeInteger(pid) && pid > 0) try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    rmSync(f.root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== 'linux')('worker Antigravity native fork', () => {
  it('withholds parent identity, readiness and input until an independent child is confirmed', async () => {
    const f = setup(); fixtures.push(f);
    const g = f.start();
    await waitFor(() => f.inputs().some(r => r.text === '/fork'), g.logs);
    await waitFor(() => g.messages.some(m => m.type === 'ready'), g.logs);
    const ready = g.messages.find(m => m.type === 'ready')!;
    if (ready.type !== 'ready') throw new Error('Missing worker web capability');
    const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/?token=${ready.token}`);
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const beforeBytes = readFileSync(f.byteLog, 'utf8');
    try {
      ws.send(JSON.stringify({ type: 'input', data: 'WEB_BEFORE_FORK\r' }));
      g.worker.send({ type: 'tui_text_input', keys: [], text: 'TUI_BEFORE_FORK' } satisfies DaemonToWorker);
      g.worker.send({ type: 'tui_keys', keys: ['Enter'], isFinal: true } satisfies DaemonToWorker);
      g.worker.send({ type: 'term_action', key: 'enter' } satisfies DaemonToWorker);
      g.worker.send({ type: 'message', content: 'CHILD_QUEUED_DURING_FORK', turnId: 'om_queued' } satisfies DaemonToWorker);
      await sleep(700);
      expect(readFileSync(f.byteLog, 'utf8')).toBe(beforeBytes);
    } finally { ws.close(); }
    await sleep(700);
    expect(f.inputs()).toEqual([{ id: parentId, text: '/fork' }]);
    expect(g.ids()).toEqual([]);
    expect(g.messages.filter(m => m.type === 'prompt_ready')).toEqual([]);
    writeFileSync(f.release, 'ok');
    await waitFor(() => g.finals().length === 2, g.logs);
    expect(g.ids()).not.toContain(parentId);
    expect(g.ids()).toContain(childId);
    expect(g.finals()[0].content).toBe('CHILD_REPLY_1');
    expect(g.finals()[1].turnId).toBe('om_queued');
    expect(g.finals()[1].content).toBe('CHILD_REPLY_2');
    expect(f.inputs().filter(r => r.text !== '/fork').map(r => r.id)).toEqual([childId, childId]);
    expect(readFileSync(f.parentFile, 'utf8')).toBe('PARENT_IMMUTABLE_STATE');

    g.worker.send({ type: 'message', content: 'CHILD_SECOND', turnId: 'om_second' } satisfies DaemonToWorker);
    await waitFor(() => g.finals().length === 3, g.logs);
    expect(g.finals()[2].content).toBe('CHILD_REPLY_3');
    expect(g.ids()).not.toContain(parentId);
    expect(f.inputs().filter(r => r.text !== '/fork').every(r => r.id === childId)).toBe(true);
    await waitFor(() => g.messages.filter(m => m.type === 'prompt_ready').length >= 3, g.logs);

    await f.stop(g.worker);
    const resumed = f.start({ fork: false, id: childId, prompt: 'AFTER_RESTART' });
    await waitFor(() => resumed.finals().some(m => m.turnId === 'om_after_restart'), resumed.logs);
    expect(f.inputs().filter(r => r.text === '/fork')).toHaveLength(1);
    expect(f.inputs().at(-1)?.id).toBe(childId);
    expect(f.inputs().at(-1)?.text).toContain('AFTER_RESTART');
  }, 120_000);

  it('closing during the pending native fork never releases a user message to the parent', async () => {
    const f = setup(); fixtures.push(f);
    const g = f.start();
    await waitFor(() => f.inputs().some(r => r.text === '/fork'), g.logs);
    await f.stop(g.worker);
    expect(f.inputs()).toEqual([{ id: parentId, text: '/fork' }]);
    expect(g.ids()).toEqual([]);
    expect(readFileSync(f.parentFile, 'utf8')).toBe('PARENT_IMMUTABLE_STATE');
  }, 60_000);

  it('refuses an exact-turn interrupt while the native fork is unconfirmed', async () => {
    // The dashboard's interrupt route reaches the same control-key path as the
    // card stop; it must report undelivered and keep Ctrl+C away from the
    // resumed source pane until the child identity is confirmed.
    const f = setup(); fixtures.push(f);
    const g = f.start();
    await waitFor(() => f.inputs().some(r => r.text === '/fork'), g.logs);
    await waitFor(() => g.messages.some(m => m.type === 'ready'), g.logs);
    await sleep(300);
    const byteBefore = readFileSync(f.byteLog, 'utf8');
    const result = await new Promise<WorkerToDaemon>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no turn_interrupt_result')), 5_000);
      const onMsg = (raw: WorkerToDaemon) => {
        if (raw?.type === 'turn_interrupt_result' && raw.requestId === 'fork-gate-1') {
          clearTimeout(timer);
          g.worker.off('message', onMsg);
          resolve(raw);
        }
      };
      g.worker.on('message', onMsg);
      g.worker.send({ type: 'interrupt_turn', requestId: 'fork-gate-1', turnId: 'om_first' } satisfies DaemonToWorker);
    });
    expect(result.type).toBe('turn_interrupt_result');
    if (result.type !== 'turn_interrupt_result') throw new Error('narrowed');
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('fork_pending');
    await sleep(300);
    expect(readFileSync(f.byteLog, 'utf8')).toBe(byteBefore);
    await f.stop(g.worker);
  }, 60_000);

  it('an in-worker restart after confirmation relaunches into the child', async () => {
    // Cold worker restart is covered above with a brand-new init message. An
    // IN-WORKER /restart instead respawns from lastInitConfig: the fork
    // completion must have updated the resume identity there, or the child
    // shell would silently resume the parent conversation.
    const f = setup(); fixtures.push(f);
    const g = f.start();
    await waitFor(() => f.inputs().some(r => r.text === '/fork'), g.logs);
    writeFileSync(f.release, 'ok');
    await waitFor(() => g.ids().includes(childId), g.logs);
    g.worker.send({ type: 'restart', attemptId: 'fork-restart-1' } satisfies DaemonToWorker);
    const launches = (): string[] =>
      readFileSync(f.launchLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).id);
    await waitFor(() => launches().length >= 2, g.logs, 60_000);
    expect(launches()[0]).toBe(parentId);
    expect(launches()[1]).toBe(childId);
    g.worker.send({ type: 'message', content: 'POST_RESTART', turnId: 'om_post_restart' } satisfies DaemonToWorker);
    await waitFor(() => f.inputs().some(r => r.text === 'POST_RESTART'), g.logs, 60_000);
    await waitFor(() => f.inputs().find(r => r.text === 'POST_RESTART')?.id === childId, g.logs, 60_000);
    expect(g.ids().filter(id => id === parentId)).toEqual([]);
    await f.stop(g.worker);
  }, 90_000);
});
