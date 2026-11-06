import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';
import { buildAntigravityTwoLogs, cutLikeCompactLog, jsonl } from './helpers/antigravity-two-logs.js';
import { ANTIGRAVITY_TRUNCATED_REPLY_NOTICE } from '../src/services/antigravity-transcript.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

// A real worker in zero-prompt mode against a fake `agy` that writes both brain
// logs the way agy 1.4.7 does (compact line first, full line right after).
// Cleanup only touches what this file spawned: the worker child handles and the
// fake CLI pids it records itself; session ids are random per test.

const children = new Set<ChildProcess>();
const cliPidFiles = new Set<string>();
const roots = new Set<string>();

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(check: () => boolean, logs: string[], timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`Worker condition timed out\n${logs.join('').slice(-6000)}`);
}

async function stopChildren(): Promise<void> {
  await Promise.all([...children].map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((done, fail) => {
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 3_000);
      const deadline = setTimeout(() => {
        child.off('exit', onExit);
        fail(new Error(`Worker ${child.pid} did not exit during fixture cleanup`));
      }, 8_000);
      const onExit = () => { clearTimeout(forceKill); clearTimeout(deadline); done(); };
      child.once('exit', onExit);
      if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker, () => {});
      else child.kill('SIGTERM');
    });
  }));
  children.clear();
  const pids = [...cliPidFiles].filter(existsSync).map(file => Number(readFileSync(file, 'utf8')));
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid fixture CLI PID: ${pid}`);
    if (processAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
  await waitFor(() => pids.every(pid => !processAlive(pid)), ['Waiting for fixture CLI processes to exit'], 5_000);
  cliPidFiles.clear();
}

afterEach(async () => {
  await stopChildren();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

/** A second, different long reply for the follow-up turn (steps 26–27). */
function followupReply(): string {
  const lines = ['# 合成的第二条长回复', ''];
  for (let i = 1; i <= 40; i++) lines.push(`第二条回复的第 ${i} 段合成正文，内容和第一条完全不同，用来确认第二轮也取到全文。`);
  lines.splice(22, 0, 'SECOND-MIDDLE-ONLY 第二条回复中段才有的一行');
  return lines.join('\n');
}

function startWorker(opts: { fullDelayMs: number }) {
  const sessionId = `agy-full-${randomUUID()}`;
  const root = mkdtempSync(join(tmpdir(), 'botmux-agy-full-'));
  roots.add(root);
  const dataDir = join(root, 'session');
  const cliHome = join(root, '.gemini', 'antigravity-cli');
  const nativeId = randomUUID();
  const logsDir = join(cliHome, 'brain', nativeId, '.system_generated', 'logs');
  const conversationDb = join(cliHome, 'conversations', `${nativeId}.db`);
  for (const dir of [dataDir, logsDir, join(cliHome, 'conversations')]) mkdirSync(dir, { recursive: true });
  const history = join(cliHome, 'history.jsonl');
  const cliPidFile = join(root, 'fake-cli.pid');
  cliPidFiles.add(cliPidFile);

  // Records after each turn's USER_INPUT, prepared up front; the fake CLI
  // writes the USER_INPUT itself from what botmux typed.
  const logs = buildAntigravityTwoLogs();
  const second = followupReply();
  const secondFull = {
    step_index: 27, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
    created_at: '2026-10-24T14:10:00Z', content: second,
  };
  const secondCompact = { ...secondFull, content: cutLikeCompactLog(second), truncated_fields: ['content'] };
  const prep = join(root, 'prep');
  mkdirSync(prep);
  writeFileSync(join(prep, 'turn1.compact.jsonl'), jsonl(logs.compactRecords.slice(1)));
  writeFileSync(join(prep, 'turn1.full.jsonl'), jsonl(logs.fullRecords.slice(1)));
  writeFileSync(join(prep, 'turn2.compact.jsonl'), jsonl([secondCompact]));
  writeFileSync(join(prep, 'turn2.full.jsonl'), jsonl([secondFull]));

  const ready = '? for shortcuts';
  const fakeCli = join(root, 'fake-cli');
  writeFileSync(fakeCli, `#!${tsRunnerPrefix().command}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(cliPidFile + '.tmp')}, String(process.pid));
fs.renameSync(${JSON.stringify(cliPidFile + '.tmp')}, ${JSON.stringify(cliPidFile)});
// agy holds its conversation db open; botmux discovers the id from /proc/<pid>/fd.
const convFd = fs.openSync(${JSON.stringify(conversationDb)}, 'a');
const compact = ${JSON.stringify(join(logsDir, 'transcript.jsonl'))};
const full = ${JSON.stringify(join(logsDir, 'transcript_full.jsonl'))};
const prep = ${JSON.stringify(prep)};
const history = ${JSON.stringify(history)};
const workspace = ${JSON.stringify(dataDir)};
const ready = ${JSON.stringify(ready)};
const fullDelayMs = ${opts.fullDelayMs};
process.stdin.setRawMode?.(true);
setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[H' + ready + '\\n'), 150);
let buf = '';
let turn = 0;
process.stdin.on('data', chunk => {
  buf += chunk.toString();
  let at;
  while ((at = buf.indexOf('\\r')) >= 0) {
    const payload = buf.slice(0, at);
    buf = buf.slice(at + 1);
    if (payload.trim()) submit(++turn, payload);
  }
});
function submit(n, payload) {
  fs.appendFileSync(history, JSON.stringify({ display: payload, workspace, timestamp: Date.now() }) + '\\n');
  process.stdout.write('\\x1b[2J\\x1b[H  Working…  esc to cancel\\n');
  const user = JSON.stringify({
    step_index: n === 1 ? 0 : 26, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE',
    created_at: new Date().toISOString(),
    content: '<USER_REQUEST>\\n' + payload + '\\n</USER_REQUEST>\\n<ADDITIONAL_METADATA>\\nsynthetic\\n</ADDITIONAL_METADATA>',
  }) + '\\n';
  setTimeout(() => {
    fs.appendFileSync(compact, user + fs.readFileSync(prep + '/turn' + n + '.compact.jsonl', 'utf8'));
    setTimeout(() => {
      fs.appendFileSync(full, user + fs.readFileSync(prep + '/turn' + n + '.full.jsonl', 'utf8'));
      setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[H' + ready + '\\n'), 300);
    }, n === 1 ? fullDelayMs : 3);
  }, 300);
}
setInterval(() => { void convFd; }, 1_000);
`);
  chmodSync(fakeCli, 0o755);

  const messages: WorkerToDaemon[] = [];
  const output: string[] = [];
  const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: sessionId,
      BOTMUX_TIME_SCALE: '0.05',
      LARK_APP_ID: 'app_test',
      LARK_APP_SECRET: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.stdout?.on('data', chunk => output.push(chunk.toString()));
  child.stderr?.on('data', chunk => output.push(chunk.toString()));
  child.send({
    type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
    workingDir: dataDir, cliId: 'antigravity', cliPathOverride: fakeCli, backendType: 'pty',
    promptInjection: 'none',
    prompt: 'ACTIVATION_UNIQUE_MARKER 请对比两种工具调用方式', turnId: 'om_initial',
    larkAppId: 'app_test', larkAppSecret: 'secret',
  } satisfies DaemonToWorker);

  const finals = () => messages.filter((m): m is Extract<WorkerToDaemon, { type: 'final_output' }> => m.type === 'final_output');
  return { child, messages, output, finals, logs, second };
}

describe('worker harvests Antigravity replies from transcript_full.jsonl', () => {
  it('delivers the complete long reply when agy writes both logs', async () => {
    const worker = startWorker({ fullDelayMs: 3 });
    await waitFor(() => worker.finals().length > 0, worker.output, 45_000);
    const [final] = worker.finals();
    expect(final.turnId).toBe('om_initial');
    expect(final.content).toContain(worker.logs.middleSentinel);
    expect(final.content).not.toContain('<truncated ');
    expect(final.content).not.toContain(ANTIGRAVITY_TRUNCATED_REPLY_NOTICE);
  }, 60_000);

  it('a compact bind made before the full log existed says the first reply was cut, then moves to the full log', async () => {
    // The full log appears seconds after the compact one: the bridge can only
    // bind the compact log for the first turn.
    const worker = startWorker({ fullDelayMs: 3_000 });
    await waitFor(() => worker.finals().length > 0, worker.output, 45_000);
    const [first] = worker.finals();
    expect(first.content).toContain('<truncated ');
    expect(first.content).toContain(ANTIGRAVITY_TRUNCATED_REPLY_NOTICE);
    expect(first.content).not.toContain(worker.logs.middleSentinel);

    await waitFor(() => worker.messages.some(m => m.type === 'prompt_ready' || m.type === 'ready'), worker.output, 20_000);
    worker.child.send({ type: 'message', content: 'FOLLOWUP_UNIQUE_MARKER 再给一条长回复', turnId: 'om_followup' } satisfies DaemonToWorker);
    await waitFor(() => worker.finals().length > 1, worker.output, 45_000);
    const second = worker.finals()[1];
    expect(second.turnId).toBe('om_followup');
    expect(second.content).toContain('SECOND-MIDDLE-ONLY');
    expect(second.content).not.toContain(ANTIGRAVITY_TRUNCATED_REPLY_NOTICE);
    expect(worker.output.join('')).toContain('Antigravity bridge moved to the full transcript');
  }, 120_000);
});
