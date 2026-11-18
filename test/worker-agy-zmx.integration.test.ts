import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZmxBackend } from '../src/adapters/backend/zmx-backend.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { resolveNodeExecutable, spawnNodeTsScript } from './helpers/ts-runner.js';

const roots = new Set<string>();
const children = new Set<ChildProcess>();
const zmxTargets: Array<{ session: string; env: NodeJS.ProcessEnv }> = [];

async function waitFor(check: () => boolean, logs: string[], timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for condition\n${logs.join('').slice(-8000)}`);
}

afterEach(async () => {
  await Promise.all([...children].map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(done => {
      const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2_500);
      child.once('exit', () => { clearTimeout(killTimer); done(); });
      if (child.connected) child.send({ type: 'close', requestId: 'cleanup' } satisfies DaemonToWorker, () => {});
      else child.kill('SIGTERM');
    });
  }));
  children.clear();
  for (const t of zmxTargets) {
    try { execFileSync('zmx', ['kill', t.session], { env: t.env, stdio: 'ignore', timeout: 3_000 }); } catch { /* gone */ }
  }
  zmxTargets.length = 0;
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots.clear();
});

function createFakeAgyZmxScript(opts: {
  root: string;
  geminiCliDir: string;
  cid: string;
  launchLog: string;
}): string {
  const node = resolveNodeExecutable();
  if (!node) throw new Error('Node executable is required for fake agy script');
  const scriptJs = join(opts.root, 'fake-agy-zmx.mjs');
  const binPath = join(opts.root, 'fake-agy');
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

  writeFileSync(scriptJs, `
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const logIdx = args.indexOf('--log-file');
const logFile = logIdx >= 0 ? args[logIdx + 1] : null;
const convIdx = args.indexOf('--conversation');
const resumedCid = convIdx >= 0 ? args[convIdx + 1] : null;
const cid = resumedCid || ${JSON.stringify(opts.cid)};
const geminiCliDir = ${JSON.stringify(opts.geminiCliDir)};

fs.appendFileSync(${JSON.stringify(opts.launchLog)}, JSON.stringify({ args, pid: process.pid }) + '\\n');

function varint(v) {
  const out = [];
  let n = v;
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n & 0x7f);
  return out;
}
function vfield(f, v) { return v === 0 ? [] : [...varint((f << 3) | 0), ...varint(v)]; }

function writeDbState({ maxStep, execReason, execLastStep, status, notFullyIdle }) {
  const convDir = path.join(geminiCliDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  const convDb = new DatabaseSync(path.join(convDir, cid + '.db'), { timeout: 5000 });
  convDb.exec('PRAGMA journal_mode = WAL;');
  convDb.exec('CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER);');
  convDb.exec('CREATE TABLE IF NOT EXISTS executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
  convDb.exec('BEGIN IMMEDIATE;');
  convDb.exec('DELETE FROM steps; DELETE FROM executor_metadata;');
  const ins = convDb.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)');
  for (let i = 0; i <= maxStep; i++) ins.run(i, i === 0 ? 14 : 15, 3);
  if (execReason != null) {
    const blob = Buffer.from([...vfield(1, execReason), ...vfield(2, 1), ...vfield(3, execLastStep)]);
    convDb.prepare('INSERT INTO executor_metadata (idx, data) VALUES (0, ?)').run(blob);
  }
  convDb.exec('COMMIT;');
  convDb.close();

  const sumDb = new DatabaseSync(path.join(geminiCliDir, 'conversation_summaries.db'), { timeout: 5000 });
  sumDb.exec('PRAGMA journal_mode = WAL;');
  sumDb.exec('CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT PRIMARY KEY, step_count INTEGER, status TEXT, not_fully_idle INTEGER, killed INTEGER, raw_summary BLOB);');
  const raw = Buffer.from([...vfield(21, notFullyIdle ? 1 : 0), ...vfield(28, execReason ?? 0)]);
  sumDb.prepare('INSERT OR REPLACE INTO conversation_summaries VALUES (?, ?, ?, ?, 0, ?)').run(
    cid, maxStep + 1, status, notFullyIdle ? 1 : 0, raw
  );
  sumDb.close();
}

function appendLog(line) {
  if (!logFile) return;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, 'I1117 12:00:00.000001 1 server.go:1] ' + line + '\\n');
}

function paintComposer() {
  process.stdout.write('\\x1b[2J\\x1b[HAntigravity TUI\\r\\n────────────────────────\\r\\n> Accept-edits mode: file edits auto-approved (shift+tab to cycle)\\r\\n────────────────────────\\r\\n? for shortcuts\\r\\n');
}

if (resumedCid) appendLog('Streaming conversation ' + cid);
process.stdin.setRawMode?.(true);
setTimeout(paintComposer, 120);

const logsDir = path.join(geminiCliDir, 'brain', cid, '.system_generated', 'logs');
const fullPath = path.join(logsDir, 'transcript_full.jsonl');
const compactPath = path.join(logsDir, 'transcript.jsonl');
const historyPath = path.join(geminiCliDir, 'history.jsonl');

function nextStepBase() {
  if (!fs.existsSync(fullPath)) return 0;
  const lines = fs.readFileSync(fullPath, 'utf8').trim().split('\\n').filter(Boolean);
  if (!lines.length) return 0;
  return Math.max(...lines.map(l => JSON.parse(l).step_index)) + 1;
}

function appendTranscript(records) {
  fs.mkdirSync(logsDir, { recursive: true });
  const text = records.map(r => JSON.stringify(r) + '\\n').join('');
  fs.appendFileSync(compactPath, text);
  fs.appendFileSync(fullPath, text);
}

let activeCancelableStep = null;
let buf = '';

function onSubmit(rawText) {
  const clean = rawText.replace(/\\x1b\\[200~/g, '').replace(/\\x1b\\[201~/g, '').trim();
  if (!clean) return;
  appendLog('Streaming conversation ' + cid);
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.appendFileSync(historyPath, JSON.stringify({ display: clean, timestamp: Date.now(), workspace: process.cwd(), conversationId: cid }) + '\\n');

  const s0 = nextStepBase();
  const userRec = {
    step_index: s0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: new Date().toISOString(),
    content: '<USER_REQUEST>\\n' + clean + '\\n</USER_REQUEST>',
  };

  if (clean.includes('HOOK_CONTINUATION_TURN')) {
    // Write USER_INPUT + interim candidate, AND paint '? for shortcuts' in zmx history
    // while SQLite proves the execution loop is STILL RUNNING!
    const interim = {
      step_index: s0 + 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: 'INTERIM_NARRATION_BEFORE_CONTINUATION',
    };
    appendTranscript([userRec, interim]);
    writeDbState({ maxStep: s0 + 1, execReason: null, execLastStep: 0, status: 'CASCADE_RUN_STATUS_RUNNING', notFullyIdle: true });
    paintComposer();

    setTimeout(() => {
      const sys = {
        step_index: s0 + 2,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: new Date().toISOString(),
        content: 'Stop hook requested continuation',
      };
      const realFinal = {
        step_index: s0 + 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date().toISOString(),
        content: 'REAL_ZMX_TURN1_FINAL',
      };
      appendTranscript([sys, realFinal]);
      writeDbState({ maxStep: s0 + 3, execReason: 4, execLastStep: s0 + 3, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false });
      paintComposer();
    }, 2_400);
    return;
  }

  if (clean.includes('CANCEL_ME_TURN')) {
    const interim = {
      step_index: s0 + 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: 'HALF_ANSWER_DO_NOT_EMIT',
    };
    const toolStep = {
      step_index: s0 + 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: '',
      tool_calls: [{ id: 'tc1', name: 'run_command' }],
    };
    // Hold only interim first so provisionalFinal is populated, or cancel mid-interim!
    appendTranscript([userRec, interim]);
    writeDbState({ maxStep: s0 + 1, execReason: null, execLastStep: 0, status: 'CASCADE_RUN_STATUS_RUNNING', notFullyIdle: true });
    activeCancelableStep = s0 + 2;
    process.stdout.write('\\x1b[2J\\x1b[HWorking... esc to cancel\\r\\n');
    void toolStep;
    return;
  }

  const replyToken = clean.includes('SECOND_TURN')
    ? 'REAL_ZMX_TURN2_FINAL'
    : clean.includes('AFTER_CANCEL')
      ? 'AFTER_CANCEL_REPLY'
      : 'COLD_RESUME_REPLY';
  appendTranscript([
    userRec,
    {
      step_index: s0 + 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: replyToken,
    },
  ]);
  writeDbState({ maxStep: s0 + 1, execReason: 4, execLastStep: s0 + 1, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false });
  paintComposer();
}

process.stdin.on('data', chunk => {
  const str = chunk.toString('utf8');
  if ((str.includes('\\x03') || str.includes('\\x1b')) && activeCancelableStep !== null) {
    const canceledAt = activeCancelableStep;
    activeCancelableStep = null;
    writeDbState({ maxStep: canceledAt, execReason: 2, execLastStep: canceledAt, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false });
    paintComposer();
    return;
  }
  buf += str;
  let idx;
  while ((idx = buf.indexOf('\\r')) >= 0) {
    if (idx > 0 && buf[idx - 1] === '\\x1b') {
      buf = buf.slice(0, idx - 1) + '\\n' + buf.slice(idx + 1);
      continue;
    }
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    onSubmit(line);
  }
});

setInterval(() => {}, 1_000);
`);
  writeFileSync(binPath, `#!/bin/sh\nexec ${quote(node)} ${quote(scriptJs)} "$@"\n`);
  chmodSync(binPath, 0o755);
  return binPath;
}

describe.skipIf(process.platform === 'win32' || !ZmxBackend.isAvailable())('worker Antigravity + ZMX zero-injection integration', () => {
  it('holds interim candidate despite ? for shortcuts in zmx history, confirms real final from SQLite state, and completes multi-turn flow', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bmx-agy-zmx-int-')));
    roots.add(root);
    const home = join(root, 'home');
    const dataDir = join(root, 'data');
    const zmxDir = join(root, 'zmx');
    const workDir = join(root, 'work');
    for (const d of [home, dataDir, zmxDir, workDir]) mkdirSync(d, { recursive: true });

    const cid = randomUUID();
    const geminiCliDir = join(home, '.gemini', 'antigravity-cli');
    const launchLog = join(root, 'launches.jsonl');
    const fakeAgy = createFakeAgyZmxScript({ root, geminiCliDir, cid, launchLog });

    const sessionId = randomUUID();
    const zmxSession = `bmx-${sessionId.slice(0, 8)}`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      SESSION_DATA_DIR: dataDir,
      ZMX_DIR: zmxDir,
      BOTMUX_SESSION_ID: sessionId,
      BOTMUX_NO_CLAIM: '1',
      LARK_APP_ID: 'app_zmx_test',
      LARK_APP_SECRET: 'secret',
    };
    zmxTargets.push({ session: zmxSession, env });

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const worker = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(worker);
    worker.on('message', m => messages.push(m as WorkerToDaemon));
    worker.stdout?.on('data', b => logs.push(b.toString()));
    worker.stderr?.on('data', b => logs.push(b.toString()));

    worker.send({
      type: 'init',
      sessionId,
      chatId: 'oc_zmx_test',
      rootMessageId: 'om_root',
      workingDir: workDir,
      cliId: 'antigravity',
      cliPathOverride: fakeAgy,
      cliVersion: '1.5.10',
      backendType: 'zmx',
      promptInjection: 'none',
      prompt: 'HOOK_CONTINUATION_TURN',
      turnId: 'om_turn_1',
      apiOnly: true,
      larkAppId: 'app_zmx_test',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    const finals = () => messages.filter((m): m is Extract<WorkerToDaemon, { type: 'final_output' }> => m.type === 'final_output');

    // Wait until interim candidate is on disk while SQLite is still RUNNING
    const fullTranscript = join(geminiCliDir, 'brain', cid, '.system_generated', 'logs', 'transcript_full.jsonl');
    await waitFor(() => existsSync(fullTranscript) && readFileSync(fullTranscript, 'utf8').includes('INTERIM_NARRATION_BEFORE_CONTINUATION'), logs);
    // Hold through >1.5s while zmx history already displays '? for shortcuts': interim must NOT flush!
    await new Promise(r => setTimeout(r, 1_500));
    expect(finals()).toHaveLength(0);

    // Continuation finishes and commits NO_TOOL_CALL to SQLite → real final delivered once, plus prompt_ready
    await waitFor(() => finals().some(f => f.turnId === 'om_turn_1'), logs);
    expect(finals().filter(f => f.turnId === 'om_turn_1')).toHaveLength(1);
    expect(finals()[0]!.content).toBe('REAL_ZMX_TURN1_FINAL');
    await waitFor(() => messages.some(m => m.type === 'prompt_ready'), logs);

    // Turn 2 on the same ZMX session
    worker.send({
      type: 'message',
      content: 'SECOND_TURN',
      turnId: 'om_turn_2',
    } satisfies DaemonToWorker);

    await waitFor(() => finals().some(f => f.turnId === 'om_turn_2'), logs);
    expect(finals().map(f => f.content)).toEqual(['REAL_ZMX_TURN1_FINAL', 'REAL_ZMX_TURN2_FINAL']);
  }, 45_000);

  it('recovers from /stop cancellation without emitting aborted interim text, supports warm ZMX reattach and cold --conversation resume, and rejects zmx + scratch', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bmx-agy-zmx-rec-')));
    roots.add(root);
    const home = join(root, 'home');
    const dataDir = join(root, 'data');
    const zmxDir = join(root, 'zmx');
    const workDir = join(root, 'work');
    for (const d of [home, dataDir, zmxDir, workDir]) mkdirSync(d, { recursive: true });

    const cid = randomUUID();
    const geminiCliDir = join(home, '.gemini', 'antigravity-cli');
    const launchLog = join(root, 'launches.jsonl');
    const fakeAgy = createFakeAgyZmxScript({ root, geminiCliDir, cid, launchLog });

    // 1. Verify zmx + scratch is explicitly rejected BEFORE launching fakeAgy
    {
      const badSid = randomUUID();
      const badMsgs: WorkerToDaemon[] = [];
      const badLogs: string[] = [];
      const badWorker = spawnNodeTsScript(resolve('src/worker.ts'), [], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          HOME: home,
          SESSION_DATA_DIR: dataDir,
          ZMX_DIR: zmxDir,
          BOTMUX_SESSION_ID: badSid,
          BOTMUX_NO_CLAIM: '1',
          LARK_APP_ID: 'app_zmx_test',
          LARK_APP_SECRET: 'secret',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.add(badWorker);
      badWorker.on('message', m => badMsgs.push(m as WorkerToDaemon));
      badWorker.stdout?.on('data', b => badLogs.push(b.toString()));
      badWorker.stderr?.on('data', b => badLogs.push(b.toString()));
      badWorker.send({
        type: 'init',
        sessionId: badSid,
        chatId: 'oc_bad',
        rootMessageId: 'om_bad',
        workingDir: workDir,
        cliId: 'antigravity',
        cliPathOverride: fakeAgy,
        backendType: 'zmx',
        sandbox: 'scratch',
        promptInjection: 'none',
        prompt: 'should-not-start',
        apiOnly: true,
        larkAppId: 'app_zmx_test',
        larkAppSecret: 'secret',
      } satisfies DaemonToWorker);
      await waitFor(() => badMsgs.some(m => m.type === 'error') || badWorker.exitCode !== null, badLogs, 10_000);
      expect(existsSync(launchLog)).toBe(false);
    }

    // 2. Cancel turn 1 on ZMX, verify interim half-answer is discarded and prompt_ready recovers
    const sessionId = randomUUID();
    const zmxSession = `bmx-${sessionId.slice(0, 8)}`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      SESSION_DATA_DIR: dataDir,
      ZMX_DIR: zmxDir,
      BOTMUX_SESSION_ID: sessionId,
      BOTMUX_NO_CLAIM: '1',
      LARK_APP_ID: 'app_zmx_test',
      LARK_APP_SECRET: 'secret',
    };
    zmxTargets.push({ session: zmxSession, env });

    const spawnWorkerInstance = (initPayload: Extract<DaemonToWorker, { type: 'init' }>) => {
      const msgs: WorkerToDaemon[] = [];
      const outLogs: string[] = [];
      const w = spawnNodeTsScript(resolve('src/worker.ts'), [], {
        cwd: resolve('.'),
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.add(w);
      w.on('message', m => msgs.push(m as WorkerToDaemon));
      w.stdout?.on('data', b => outLogs.push(b.toString()));
      w.stderr?.on('data', b => outLogs.push(b.toString()));
      w.send(initPayload);
      return { w, msgs, outLogs };
    };

    const gen1 = spawnWorkerInstance({
      type: 'init',
      sessionId,
      chatId: 'oc_zmx_rec',
      rootMessageId: 'om_root',
      workingDir: workDir,
      cliId: 'antigravity',
      cliPathOverride: fakeAgy,
      cliVersion: '1.5.10',
      backendType: 'zmx',
      promptInjection: 'none',
      prompt: 'CANCEL_ME_TURN',
      turnId: 'om_cancel_1',
      apiOnly: true,
      larkAppId: 'app_zmx_test',
      larkAppSecret: 'secret',
    });

    const fullTranscript = join(geminiCliDir, 'brain', cid, '.system_generated', 'logs', 'transcript_full.jsonl');
    await waitFor(() => existsSync(fullTranscript) && readFileSync(fullTranscript, 'utf8').includes('HALF_ANSWER_DO_NOT_EMIT'), gen1.outLogs);

    const promptReadyCountBeforeStop = gen1.msgs.filter(m => m.type === 'prompt_ready').length;
    gen1.w.send({
      type: 'interrupt_turn',
      requestId: 'req-stop-1',
      turnId: 'om_cancel_1',
    } satisfies DaemonToWorker);

    await waitFor(
      () => gen1.msgs.some(m => m.type === 'turn_interrupt_result' && m.requestId === 'req-stop-1' && m.delivered === true),
      gen1.outLogs,
    );
    await waitFor(() => gen1.msgs.filter(m => m.type === 'prompt_ready').length > promptReadyCountBeforeStop, gen1.outLogs);
    await waitFor(() => gen1.msgs.some(m => m.type === 'turn_terminal' && m.turnId === 'om_cancel_1' && m.status === 'ambiguous'), gen1.outLogs);
    expect(gen1.msgs.filter(m => m.type === 'final_output')).toHaveLength(0);

    // 3. Kill worker (simulating worker crash while ZMX session stays alive) → warm reattach
    const gen1Exited = new Promise<void>(r => gen1.w.once('exit', () => r()));
    gen1.w.kill('SIGTERM');
    await gen1Exited;
    children.delete(gen1.w);

    const gen2 = spawnWorkerInstance({
      type: 'init',
      sessionId,
      chatId: 'oc_zmx_rec',
      rootMessageId: 'om_root',
      workingDir: workDir,
      cliId: 'antigravity',
      cliPathOverride: fakeAgy,
      cliVersion: '1.5.10',
      cliSessionId: cid,
      resume: true,
      backendType: 'zmx',
      promptInjection: 'none',
      prompt: '',
      apiOnly: true,
      larkAppId: 'app_zmx_test',
      larkAppSecret: 'secret',
    });
    await waitFor(() => gen2.msgs.some(m => m.type === 'ready'), gen2.outLogs);
    expect(gen2.outLogs.join('')).toContain('Re-attached to existing zmx session');

    gen2.w.send({
      type: 'message',
      content: 'AFTER_CANCEL',
      turnId: 'om_after_cancel',
    } satisfies DaemonToWorker);

    await waitFor(
      () => gen2.msgs.some(m => m.type === 'final_output' && m.turnId === 'om_after_cancel'),
      gen2.outLogs,
    );
    const gen2Finals = gen2.msgs.filter((m): m is Extract<WorkerToDaemon, { type: 'final_output' }> => m.type === 'final_output');
    // Cancelled HALF_ANSWER_DO_NOT_EMIT must NEVER be replayed on the next turn!
    expect(gen2Finals.map(f => f.content)).toEqual(['AFTER_CANCEL_REPLY']);

    // 4. Close ZMX session completely → cold `--conversation <cid>` resume
    const gen2Closed = new Promise<void>(r => gen2.w.once('exit', () => r()));
    gen2.w.send({ type: 'close', requestId: 'close-for-cold-resume' } satisfies DaemonToWorker);
    await Promise.race([gen2Closed, new Promise(r => setTimeout(r, 3_000))]);
    if (gen2.w.exitCode === null) {
      gen2.w.kill('SIGKILL');
      await gen2Closed;
    }
    children.delete(gen2.w);
    try { execFileSync('zmx', ['kill', zmxSession], { env, stdio: 'ignore', timeout: 3_000 }); } catch { /* already closed */ }

    const gen3 = spawnWorkerInstance({
      type: 'init',
      sessionId,
      chatId: 'oc_zmx_rec',
      rootMessageId: 'om_root',
      workingDir: workDir,
      cliId: 'antigravity',
      cliPathOverride: fakeAgy,
      cliVersion: '1.5.10',
      cliSessionId: cid,
      resume: true,
      backendType: 'zmx',
      promptInjection: 'none',
      prompt: 'COLD_RESUME_TURN',
      turnId: 'om_cold_resume',
      apiOnly: true,
      larkAppId: 'app_zmx_test',
      larkAppSecret: 'secret',
    });
    await waitFor(
      () => gen3.msgs.some(m => m.type === 'final_output' && m.turnId === 'om_cold_resume'),
      gen3.outLogs,
    );
    const gen3Finals = gen3.msgs.filter((m): m is Extract<WorkerToDaemon, { type: 'final_output' }> => m.type === 'final_output');
    expect(gen3Finals.map(f => f.content)).toEqual(['COLD_RESUME_REPLY']);
    const launches = readFileSync(launchLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(launches.at(-1)?.args).toContain('--conversation');
    expect(launches.at(-1)?.args).toContain(cid);
  }, 60_000);

  it('prevents aborted interim leaks across queued follow-ups + /new rotations, waits for slow transcript flushes before prompt_ready, and tracks /new rotation CIDs on resumed ZMX sessions', async () => {
    // Use short /tmp path so macOS 104-byte Unix domain socket path limit is respected.
    const root = realpathSync(mkdtempSync('/tmp/bmx-zmx-adv-'));
    roots.add(root);
    const home = join(root, 'home');
    const dataDir = join(root, 'data');
    const zmxDir = join(root, 'zmx');
    const workDir = join(root, 'work');
    for (const d of [home, dataDir, zmxDir, workDir]) mkdirSync(d, { recursive: true });

    const cidA = randomUUID();
    const cidB = randomUUID();
    const cidC = randomUUID();
    const geminiCliDir = join(home, '.gemini', 'antigravity-cli');
    const node = resolveNodeExecutable()!;
    const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

    // Pre-seed cidA as an authentic resumed conversation; when `/new` runs, cidA
    // latches `not_fully_idle = 1` + a stale candidate so `probeBusyPatternIdle`
    // MUST follow cidB rather than deadlocking on cidA!
    const cidALogs = join(geminiCliDir, 'brain', cidA, '.system_generated', 'logs');
    mkdirSync(cidALogs, { recursive: true });
    writeFileSync(join(cidALogs, 'transcript_full.jsonl'), JSON.stringify({
      step_index: 0,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date(Date.now() - 60_000).toISOString(),
      content: 'old cidA reply',
    }) + '\n');
    const scriptJs = join(root, 'fake-agy-adv.mjs');
    const fakeAgy = join(root, 'fake-agy');

    writeFileSync(scriptJs, `
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const logIdx = args.indexOf('--log-file');
const logFile = logIdx >= 0 ? args[logIdx + 1] : null;
const convIdx = args.indexOf('--conversation');
let currentCid = convIdx >= 0 ? args[convIdx + 1] : ${JSON.stringify(cidA)};
const nextCids = [${JSON.stringify(cidB)}, ${JSON.stringify(cidC)}];
const geminiCliDir = ${JSON.stringify(geminiCliDir)};

function varint(v) {
  const out = [];
  let n = v;
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n & 0x7f);
  return out;
}
function vfield(f, v) { return v === 0 ? [] : [...varint((f << 3) | 0), ...varint(v)]; }

const execRowsByCid = new Map();
function writeDbState(cid, { maxStep, addExecRow, status, notFullyIdle, bgCount = 0 }) {
  const convDir = path.join(geminiCliDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  const convDb = new DatabaseSync(path.join(convDir, cid + '.db'), { timeout: 5000 });
  convDb.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER); CREATE TABLE IF NOT EXISTS executor_metadata (idx INTEGER PRIMARY KEY, data BLOB); BEGIN IMMEDIATE; DELETE FROM steps; DELETE FROM executor_metadata;');
  const ins = convDb.prepare('INSERT INTO steps VALUES (?, 15, 3)');
  for (let i = 0; i <= maxStep; i++) ins.run(i);
  const rows = execRowsByCid.get(cid) ?? [];
  if (addExecRow) rows.push(addExecRow);
  execRowsByCid.set(cid, rows);
  rows.forEach((r, idx) => {
    convDb.prepare('INSERT INTO executor_metadata VALUES (?, ?)').run(idx, Buffer.from([...vfield(1, r.reason), ...vfield(2, 1), ...vfield(3, r.lastStep)]));
  });
  convDb.exec('COMMIT;');
  convDb.close();

  const sumDb = new DatabaseSync(path.join(geminiCliDir, 'conversation_summaries.db'), { timeout: 5000 });
  sumDb.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT PRIMARY KEY, step_count INTEGER, status TEXT, not_fully_idle INTEGER, killed INTEGER, raw_summary BLOB);');
  const raw = Buffer.from([...vfield(21, notFullyIdle ? 1 : 0), ...vfield(29, bgCount)]);
  sumDb.prepare('INSERT OR REPLACE INTO conversation_summaries VALUES (?, ?, ?, ?, 0, ?)').run(
    cid, maxStep + 1, status, notFullyIdle ? 1 : 0, raw
  );
  sumDb.close();
}

// Seed cidA idle at boot so resume reaches prompt_ready cleanly
writeDbState(${JSON.stringify(cidA)}, { maxStep: 0, addExecRow: { reason: 4, lastStep: 0 }, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false, bgCount: 0 });

function appendLog(line) {
  if (!logFile) return;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, 'I1117 12:00:00.000001 1 server.go:1] ' + line + '\\n');
}
function paintComposer() {
  process.stdout.write('\\x1b[2J\\x1b[HAntigravity TUI\\r\\n────────────────────────\\r\\n> Accept-edits mode: file edits auto-approved (shift+tab to cycle)\\r\\n────────────────────────\\r\\n? for shortcuts\\r\\n');
}
function appendTranscript(cid, records) {
  const logsDir = path.join(geminiCliDir, 'brain', cid, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const text = records.map(r => JSON.stringify(r) + '\\n').join('');
  fs.appendFileSync(path.join(logsDir, 'transcript.jsonl'), text);
  fs.appendFileSync(path.join(logsDir, 'transcript_full.jsonl'), text);
}
function nextStep(cid) {
  const fullPath = path.join(geminiCliDir, 'brain', cid, '.system_generated', 'logs', 'transcript_full.jsonl');
  if (!fs.existsSync(fullPath)) return 0;
  const lines = fs.readFileSync(fullPath, 'utf8').trim().split('\\n').filter(Boolean);
  return lines.length ? Math.max(...lines.map(l => JSON.parse(l).step_index)) + 1 : 0;
}

appendLog('Streaming conversation ' + currentCid);
process.stdin.setRawMode?.(true);
setTimeout(paintComposer, 80);

let cancelable = null;
let slowFlushBusy = false;
let queuedTurn = null;
let buf = '';

function executeTurn(clean) {
  if (clean === '/new') {
    if (currentCid === ${JSON.stringify(cidA)}) {
      writeDbState(currentCid, { maxStep: 0, addExecRow: null, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: true, bgCount: 1 });
    }
    currentCid = nextCids.shift() || currentCid;
    appendLog('Streaming conversation ' + currentCid);
    paintComposer();
    return;
  }
  const cid = currentCid;
  appendLog('Streaming conversation ' + cid);
  const historyPath = path.join(geminiCliDir, 'history.jsonl');
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.appendFileSync(historyPath, JSON.stringify({ display: clean, timestamp: Date.now(), workspace: process.cwd(), conversationId: cid }) + '\\n');

  if (cancelable !== null || slowFlushBusy) {
    queuedTurn = clean;
    return;
  }

  const s0 = nextStep(cid);
  const userRec = { step_index: s0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: new Date().toISOString(), content: '<USER_REQUEST>\\n' + clean + '\\n</USER_REQUEST>' };
  if (clean.includes('CANCEL_WITH_INTERIM')) {
    const interim = { step_index: s0 + 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date().toISOString(), content: 'LEAKED_ABORTED_INTERIM_' + clean };
    appendTranscript(cid, [userRec, interim]);
    writeDbState(cid, { maxStep: s0 + 1, addExecRow: null, status: 'CASCADE_RUN_STATUS_RUNNING', notFullyIdle: true });
    cancelable = { cid, step: s0 + 2 };
    process.stdout.write('\\x1b[2J\\x1b[HWorking... esc to cancel\\r\\n');
    return;
  }
  if (clean.includes('SLOW_FLUSH_TURN')) {
    slowFlushBusy = true;
    appendTranscript(cid, [userRec]);
    writeDbState(cid, { maxStep: s0, addExecRow: null, status: 'CASCADE_RUN_STATUS_RUNNING', notFullyIdle: true });
    setTimeout(() => {
      writeDbState(cid, { maxStep: s0 + 1, addExecRow: { reason: 4, lastStep: s0 + 1 }, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false });
    }, 3300);
    setTimeout(() => {
      appendTranscript(cid, [{ step_index: s0 + 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date().toISOString(), content: 'LATE_FLUSHED_TURN1_FINAL' }]);
      slowFlushBusy = false;
      paintComposer();
      if (queuedTurn) {
        const q = queuedTurn;
        queuedTurn = null;
        setTimeout(() => executeTurn(q), 50);
      }
    }, 4100);
    return;
  }
  const finalRec = { step_index: s0 + 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: new Date().toISOString(), content: 'REAL_REPLY_FOR_' + clean };
  appendTranscript(cid, [userRec, finalRec]);
  writeDbState(cid, { maxStep: s0 + 1, addExecRow: { reason: 4, lastStep: s0 + 1 }, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false });
  paintComposer();
}

process.stdin.on('data', chunk => {
  const str = chunk.toString('utf8');
  if ((str.includes('\\x03') || str.includes('\\x1b')) && !str.includes('\\x1b[200~') && cancelable !== null) {
    const c = cancelable;
    cancelable = null;
    writeDbState(c.cid, { maxStep: c.step, addExecRow: { reason: 2, lastStep: c.step }, status: 'CASCADE_RUN_STATUS_IDLE', notFullyIdle: false });
    paintComposer();
    if (queuedTurn) {
      const q = queuedTurn;
      queuedTurn = null;
      setTimeout(() => executeTurn(q), 20);
    }
    return;
  }
  buf += str;
  let idx;
  while ((idx = buf.indexOf('\\r')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    const clean = line.replace(/\\x1b\\[200~/g, '').replace(/\\x1b\\[201~/g, '').trim();
    if (clean) executeTurn(clean);
  }
});
setInterval(() => {}, 1000);
`);
    writeFileSync(fakeAgy, `#!/bin/sh\nexec ${quote(node)} ${quote(scriptJs)} "$@"\n`, { mode: 0o755 });

    const sessionId = randomUUID();
    const zmxSession = `bmx-${sessionId.slice(0, 8)}`;
    const env = {
      ...process.env,
      HOME: home,
      SESSION_DATA_DIR: dataDir,
      ZMX_DIR: zmxDir,
      BOTMUX_SESSION_ID: sessionId,
      BOTMUX_NO_CLAIM: '1',
      LARK_APP_ID: 'app_zmx_adv',
      LARK_APP_SECRET: 'secret',
    };
    zmxTargets.push({ session: zmxSession, env });

    const msgs: WorkerToDaemon[] = [];
    const outLogs: string[] = [];
    const w = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(w);
    w.on('message', m => msgs.push(m as WorkerToDaemon));
    w.stdout?.on('data', b => outLogs.push(b.toString()));
    w.stderr?.on('data', b => outLogs.push(b.toString()));

    // 1. Start resumed on cidA (`not_fully_idle = true`), run `/new` → rotates to cidB and recovers prompt_ready!
    w.send({
      type: 'init',
      sessionId,
      chatId: 'oc_zmx_adv',
      rootMessageId: 'om_root',
      workingDir: workDir,
      cliId: 'antigravity',
      cliPathOverride: fakeAgy,
      cliVersion: '1.5.10',
      cliSessionId: cidA,
      resume: true,
      backendType: 'zmx',
      promptInjection: 'none',
      prompt: '',
      apiOnly: true,
      larkAppId: 'app_zmx_adv',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await waitFor(() => msgs.some(m => m.type === 'prompt_ready'), outLogs);
    const readyBeforeNew = msgs.filter(m => m.type === 'prompt_ready').length;
    w.send({ type: 'raw_input', content: '/new' } satisfies DaemonToWorker);
    await waitFor(() => msgs.filter(m => m.type === 'prompt_ready').length > readyBeforeNew, outLogs);

    // 2. In cidB: start CANCEL_WITH_INTERIM_1, type-ahead queue QUEUED_FOLLOWUP, then interrupt_turn!
    const cidBTranscript = join(geminiCliDir, 'brain', cidB, '.system_generated', 'logs', 'transcript_full.jsonl');
    w.send({ type: 'message', content: 'CANCEL_WITH_INTERIM_1', turnId: 'om_cancel_a' } satisfies DaemonToWorker);
    await waitFor(() => existsSync(cidBTranscript) && readFileSync(cidBTranscript, 'utf8').includes('LEAKED_ABORTED_INTERIM_CANCEL_WITH_INTERIM_1'), outLogs);
    w.send({ type: 'message', content: 'QUEUED_FOLLOWUP', turnId: 'om_followup_a' } satisfies DaemonToWorker);
    await waitFor(() => existsSync(join(geminiCliDir, 'history.jsonl')) && readFileSync(join(geminiCliDir, 'history.jsonl'), 'utf8').includes('QUEUED_FOLLOWUP'), outLogs);
    w.send({ type: 'interrupt_turn', requestId: 'req-adv-1', turnId: 'om_cancel_a' } satisfies DaemonToWorker);

    await waitFor(() => msgs.some(m => m.type === 'final_output' && m.turnId === 'om_followup_a'), outLogs);

    // 3. Cancel CANCEL_WITH_INTERIM_B and immediately rotate `/new` + AFTER_NEW_PROMPT → cidC!
    w.send({ type: 'message', content: 'CANCEL_WITH_INTERIM_B', turnId: 'om_cancel_b' } satisfies DaemonToWorker);
    await waitFor(() => readFileSync(cidBTranscript, 'utf8').includes('LEAKED_ABORTED_INTERIM_CANCEL_WITH_INTERIM_B'), outLogs);
    w.send({ type: 'interrupt_turn', requestId: 'req-adv-2', turnId: 'om_cancel_b' } satisfies DaemonToWorker);
    await waitFor(() => msgs.some(m => m.type === 'turn_interrupt_result' && m.requestId === 'req-adv-2'), outLogs);
    w.send({ type: 'raw_input', content: '/new', followUpContent: 'AFTER_NEW_PROMPT', followUpTurnId: 'om_after_new' } satisfies DaemonToWorker);

    await waitFor(() => msgs.some(m => m.type === 'final_output' && m.turnId === 'om_after_new'), outLogs);

    // 4. Slow transcript flush (`SLOW_FLUSH_TURN` commits SQLite at 3.3s, JSONL at 4.1s) + queued `QUEUED_AFTER_SLOW`:
    //    `om_slow_1` must keep `LATE_FLUSHED_TURN1_FINAL` and `om_queued_2` must get `REAL_REPLY_FOR_QUEUED_AFTER_SLOW`!
    w.send({ type: 'message', content: 'SLOW_FLUSH_TURN', turnId: 'om_slow_1' } satisfies DaemonToWorker);
    await waitFor(() => readFileSync(join(geminiCliDir, 'history.jsonl'), 'utf8').includes('SLOW_FLUSH_TURN'), outLogs);
    w.send({ type: 'message', content: 'QUEUED_AFTER_SLOW', turnId: 'om_queued_2' } satisfies DaemonToWorker);

    await waitFor(() => msgs.some(m => m.type === 'final_output' && m.turnId === 'om_queued_2'), outLogs, 25_000);

    const finals = msgs.filter((m): m is Extract<WorkerToDaemon, { type: 'final_output' }> => m.type === 'final_output');
    expect(finals.some(f => f.content.includes('LEAKED_ABORTED_INTERIM'))).toBe(false);
    expect(finals.map(f => ({ turnId: f.turnId, content: f.content }))).toEqual([
      { turnId: 'om_followup_a', content: 'REAL_REPLY_FOR_QUEUED_FOLLOWUP' },
      { turnId: 'om_after_new', content: 'REAL_REPLY_FOR_AFTER_NEW_PROMPT' },
      { turnId: 'om_slow_1', content: 'LATE_FLUSHED_TURN1_FINAL' },
      { turnId: 'om_queued_2', content: 'REAL_REPLY_FOR_QUEUED_AFTER_SLOW' },
    ]);
  }, 60_000);
});
