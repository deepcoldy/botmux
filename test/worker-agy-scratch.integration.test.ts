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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeScratchCapability } from '../src/adapters/backend/scratch-capability.js';
import { preferredManagedTmuxSocket } from '../src/adapters/backend/tmux-socket.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { killProcessTree } from './helpers/process-tree.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { resolveNodeExecutable, spawnNodeTsScript } from './helpers/ts-runner.js';

const scratchCap = probeScratchCapability();
const scratchAvailable = scratchCap.summary !== 'none';
const tmuxAvailable = probeTmuxFunctional().ok;

const roots = new Set<string>();
const children = new Set<ChildProcess>();
const tmuxCleanupDirs = new Set<string>();

async function waitFor(check: () => boolean, logs: string[], timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`Worker scratch condition timed out\n${logs.join('').slice(-8000)}`);
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) {
        await new Promise<void>(done => {
          const timer = setTimeout(() => done(), 2_000);
          child.once('exit', () => { clearTimeout(timer); done(); });
          child.send({ type: 'close', requestId: 'cleanup' } satisfies DaemonToWorker, () => {});
        });
      }
      if (child.exitCode === null && child.signalCode === null) {
        await killProcessTree(child);
      }
    }
  }
  children.clear();
  for (const tmuxDir of tmuxCleanupDirs) {
    for (const name of new Set(['default', preferredManagedTmuxSocket() ?? 'default'])) {
      const privateSocket = join(tmuxDir, `tmux-${process.getuid?.() ?? 0}`, name);
      try { execFileSync('tmux', ['-S', privateSocket, 'kill-server'], { env: privateTmuxEnv(tmuxDir), stdio: 'ignore' }); } catch { /* gone */ }
    }
  }
  tmuxCleanupDirs.clear();
  for (const dir of roots) {
    try { execFileSync('/bin/chmod', ['-R', 'u+w', dir], { stdio: 'ignore' }); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
  roots.clear();
});

function createSandboxedFakeAgy(workRoot: string, defaultCid: string): string {
  const node = resolveNodeExecutable();
  if (!node) throw new Error('Node executable is required');
  // Place fake CLI inside a world-readable bin dir outside sealed botmux dirs so sandbox-exec / bwrap can execute it
  const binDir = join(workRoot, 'bin');
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, 'fake-agy.mjs');
  const launcherPath = join(binDir, 'fake-agy');
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

  writeFileSync(scriptPath, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const logIdx = args.indexOf('--log-file');
const logFile = logIdx >= 0 ? args[logIdx + 1] : null;
const convIdx = args.indexOf('--conversation');
const resumedCid = convIdx >= 0 ? args[convIdx + 1] : null;
const cid = resumedCid || process.env.FAKE_AGY_CID || ${JSON.stringify(defaultCid)};

// Crucial: write ONLY through os.homedir() and --log-file (inside the sandboxed HOME/clone),
// never through any hardcoded host path!
const geminiCliDir = path.join(os.homedir(), '.gemini', 'antigravity-cli');

function varint(v) {
  const out = [];
  let n = v;
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n & 0x7f);
  return out;
}
function vfield(f, v) { return v === 0 ? [] : [...varint((f << 3) | 0), ...varint(v)]; }
function sfield(f, s) { const b = Buffer.from(s, 'utf8'); return [...varint((f << 3) | 2), ...varint(b.length), ...b]; }

function writeDb(maxStep) {
  const convDir = path.join(geminiCliDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  const convDb = new DatabaseSync(path.join(convDir, cid + '.db'), { timeout: 5000 });
  convDb.exec('PRAGMA journal_mode = WAL;');
  convDb.exec('CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER);');
  convDb.exec('CREATE TABLE IF NOT EXISTS executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
  convDb.exec('CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
  convDb.exec('BEGIN IMMEDIATE; DELETE FROM steps; DELETE FROM executor_metadata; DELETE FROM gen_metadata;');
  const ins = convDb.prepare('INSERT INTO steps (idx, step_type, status) VALUES (?, ?, ?)');
  for (let i = 0; i <= maxStep; i++) ins.run(i, i === 0 ? 14 : 15, 3);
  const execBlob = Buffer.from([...vfield(1, 4), ...vfield(2, 1), ...vfield(3, maxStep)]);
  convDb.prepare('INSERT INTO executor_metadata (idx, data) VALUES (0, ?)').run(execBlob);
  const f4 = Buffer.from([...vfield(2, 200), ...vfield(3, 80)]);
  const f1 = Buffer.from([...sfield(19, 'gemini-3.8-flash-low'), ...sfield(21, 'Gemini 3.8 Flash (Low)'), ...varint((4 << 3) | 2), ...varint(f4.length), ...f4]);
  const genBlob = Buffer.from([...varint((1 << 3) | 2), ...varint(f1.length), ...f1]);
  convDb.prepare('INSERT INTO gen_metadata (idx, data) VALUES (0, ?)').run(genBlob);
  convDb.exec('COMMIT;');
  convDb.close();

  const sumDb = new DatabaseSync(path.join(geminiCliDir, 'conversation_summaries.db'), { timeout: 5000 });
  sumDb.exec('PRAGMA journal_mode = WAL;');
  sumDb.exec('CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT PRIMARY KEY, step_count INTEGER, status TEXT, not_fully_idle INTEGER, killed INTEGER, raw_summary BLOB);');
  sumDb.prepare('INSERT OR REPLACE INTO conversation_summaries VALUES (?, ?, ?, 0, 0, ?)').run(cid, maxStep + 1, 'CASCADE_RUN_STATUS_IDLE', Buffer.alloc(0));
  sumDb.close();
}

function appendLog(line) {
  if (!logFile) return;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, 'I1117 12:00:00.000001 1 server.go:1] ' + line + '\\n');
}

function paintComposer() {
  process.stdout.write('\\x1b[2J\\x1b[HAntigravity Scratch TUI\\r\\n────────────────────────\\r\\n> Accept-edits mode: file edits auto-approved (shift+tab to cycle)\\r\\n────────────────────────\\r\\n? for shortcuts\\r\\n');
}

if (resumedCid) appendLog('Streaming conversation ' + cid);
process.stdin.setRawMode?.(true);
setTimeout(paintComposer, 150);

let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\\r')) >= 0) {
    if (idx > 0 && buf[idx - 1] === '\\x1b') {
      buf = buf.slice(0, idx - 1) + '\\n' + buf.slice(idx + 1);
      continue;
    }
    const raw = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    const clean = raw.replace(/\\x1b\\[200~/g, '').replace(/\\x1b\\[201~/g, '').trim();
    if (!clean) continue;

    appendLog('Streaming conversation ' + cid);
    const historyPath = path.join(geminiCliDir, 'history.jsonl');
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.appendFileSync(historyPath, JSON.stringify({ display: clean, timestamp: Date.now(), workspace: process.cwd(), conversationId: cid }) + '\\n');

    process.stdout.write('\\x1b[2J\\x1b[HWorking... esc to cancel\\r\\n');
    // Also write a workspace marker inside cwd to prove COW workspace isolation!
    fs.writeFileSync(path.join(process.cwd(), 'scratch-wrote-' + cid + '.txt'), clean);

    const logsDir = path.join(geminiCliDir, 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const fullPath = path.join(logsDir, 'transcript_full.jsonl');
    const compactPath = path.join(logsDir, 'transcript.jsonl');
    const base = fs.existsSync(fullPath)
      ? Math.max(...fs.readFileSync(fullPath, 'utf8').trim().split('\\n').filter(Boolean).map(l => JSON.parse(l).step_index)) + 1
      : 0;
    const rows = [
      {
        step_index: base,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date().toISOString(),
        content: '<USER_REQUEST>\\n' + clean + '\\n</USER_REQUEST>',
      },
      {
        step_index: base + 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: new Date().toISOString(),
        thinking: 'Scratch CoT reasoning for ' + clean,
        content: 'SCRATCH_FINAL[' + cid.slice(0, 8) + ']:' + clean,
      },
    ].map(r => JSON.stringify(r) + '\\n').join('');

    setTimeout(() => {
      fs.appendFileSync(compactPath, rows);
      fs.appendFileSync(fullPath, rows);
      writeDb(base + 1);
      setTimeout(paintComposer, 200);
    }, 250);
  }
});

setInterval(() => {}, 1_000);
`);
  writeFileSync(launcherPath, `#!/bin/sh\nexec ${quote(node)} ${quote(scriptPath)} "$@"\n`);
  chmodSync(launcherPath, 0o755);
  return launcherPath;
}

describe.skipIf(!scratchAvailable)('worker Antigravity + scratch zero-injection integration', () => {
  it('delivers multi-turn replies + CoT on PTY scratch with symlinked HOME without touching host ~/.gemini (even when absent)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bmx-agy-scr-pty-')));
    roots.add(root);
    const realHome = join(root, 'data00', 'home', 'devuser');
    const symlinkParent = join(root, 'home');
    mkdirSync(realHome, { recursive: true });
    mkdirSync(symlinkParent, { recursive: true });
    const symlinkHome = join(symlinkParent, 'devuser');
    symlinkSync(realHome, symlinkHome);

    // Deliberately leave realHome/.gemini NONEXISTENT to verify neither worker nor CLI creates it on host!
    const dataDir = join(root, 'botmux-data');
    const workDir = join(root, 'project');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'README.md'), 'host-project-untouched\n');

    const cid = randomUUID();
    const fakeAgy = createSandboxedFakeAgy(root, cid);
    const sessionId = `scrpty-${randomUUID().slice(0, 8)}`;

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const worker = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...privateTmuxEnv(root),
        HOME: symlinkHome,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: sessionId,
        BOTMUX_NO_CLAIM: '1',
        LARK_APP_ID: 'app_scr_pty',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(worker);
    worker.on('message', m => messages.push(m as WorkerToDaemon));
    worker.stdout?.on('data', b => logs.push(b.toString()));
    worker.stderr?.on('data', b => logs.push(b.toString()));

    worker.send({
      type: 'init',
      sessionId,
      chatId: 'oc_scr_pty',
      rootMessageId: 'om_root',
      workingDir: workDir,
      cliId: 'antigravity',
      cliPathOverride: fakeAgy,
      cliVersion: '1.5.10',
      backendType: 'pty',
      sandbox: 'scratch',
      scratchStorage: 'disk',
      promptInjection: 'none',
      prompt: 'TURN_ONE_PTY',
      turnId: 'om_pty_1',
      apiOnly: true,
      larkAppId: 'app_scr_pty',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    const finals = () => messages.filter((m): m is Extract<WorkerToDaemon, { type: 'final_output' }> => m.type === 'final_output');

    await waitFor(() => finals().some(f => f.turnId === 'om_pty_1'), logs);
    expect(finals()[0]!.content).toBe(`SCRATCH_FINAL[${cid.slice(0, 8)}]:TURN_ONE_PTY`);
    await waitFor(() => messages.some(m => m.type === 'cli_session_id' && m.cliSessionId === cid), logs);

    // Send turn 2
    worker.send({
      type: 'message',
      content: 'TURN_TWO_PTY',
      turnId: 'om_pty_2',
    } satisfies DaemonToWorker);
    await waitFor(() => finals().some(f => f.turnId === 'om_pty_2'), logs);
    expect(finals().map(f => f.content)).toEqual([
      `SCRATCH_FINAL[${cid.slice(0, 8)}]:TURN_ONE_PTY`,
      `SCRATCH_FINAL[${cid.slice(0, 8)}]:TURN_TWO_PTY`,
    ]);

    // Host ~/.gemini was NEVER created and host workDir has NO scratch-wrote-* file!
    expect(existsSync(join(realHome, '.gemini'))).toBe(false);
    expect(existsSync(join(workDir, `scratch-wrote-${cid}.txt`))).toBe(false);
  }, 45_000);

  it.skipIf(!tmuxAvailable)('isolates concurrent tmux + scratch sessions in the same workingDir, supports warm reattach + cold suspend/resume, and leaves pre-existing host ~/.gemini untouched', async () => {
    // Keep path short so macOS 104-byte sockaddr_un limit accommodates tmux's probe socket.
    const root = realpathSync(mkdtempSync('/tmp/bmx-scrt-'));
    roots.add(root);
    tmuxCleanupDirs.add(root);
    const hostHome = join(root, 'host-home');
    const dataDir = join(root, 'botmux-data');
    const workDir = join(root, 'shared-project');
    mkdirSync(join(hostHome, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    // Pre-seed host ~/.gemini with sentinel history and conversation DB
    const hostHistoryPath = join(hostHome, '.gemini', 'antigravity-cli', 'history.jsonl');
    const hostSentinelHistory = '{"display":"HOST_DO_NOT_TOUCH","timestamp":100,"workspace":"' + workDir + '","conversationId":"99999999-9999-9999-9999-999999999999"}\n';
    writeFileSync(hostHistoryPath, hostSentinelHistory);

    const cidA = randomUUID();
    const cidB = randomUUID();
    const fakeAgy = createSandboxedFakeAgy(root, cidA);
    const sidA = `scrtmuxa-${randomUUID().slice(0, 8)}`;
    const sidB = `scrtmuxb-${randomUUID().slice(0, 8)}`;

    const spawnScratchTmuxWorker = (opts: {
      sessionId: string;
      fakeCid: string;
      prompt: string;
      turnId?: string;
      resume?: boolean;
      cliSessionId?: string;
    }) => {
      const msgs: WorkerToDaemon[] = [];
      const outLogs: string[] = [];
      const w = spawnNodeTsScript(resolve('src/worker.ts'), [], {
        cwd: resolve('.'),
        env: {
          ...privateTmuxEnv(root),
          HOME: hostHome,
          SESSION_DATA_DIR: dataDir,
          BOTMUX_SESSION_ID: opts.sessionId,
          BOTMUX_NO_CLAIM: '1',
          FAKE_AGY_CID: opts.fakeCid,
          LARK_APP_ID: 'app_scr_tmux',
          LARK_APP_SECRET: 'secret',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      children.add(w);
      w.on('message', m => msgs.push(m as WorkerToDaemon));
      w.stdout?.on('data', b => outLogs.push(b.toString()));
      w.stderr?.on('data', b => outLogs.push(b.toString()));
      w.send({
        type: 'init',
        sessionId: opts.sessionId,
        daemonBootId: 'boot-scr-tmux-test',
        chatId: `oc_${opts.sessionId}`,
        rootMessageId: `om_root_${opts.sessionId}`,
        workingDir: workDir,
        cliId: 'antigravity',
        cliPathOverride: fakeAgy,
        cliVersion: '1.5.10',
        backendType: 'tmux',
        sandbox: 'scratch',
        scratchStorage: 'disk',
        promptInjection: 'none',
        prompt: opts.prompt,
        env: { FAKE_AGY_CID: opts.fakeCid },
        ...(opts.turnId ? { turnId: opts.turnId } : {}),
        ...(opts.resume ? { resume: true } : {}),
        ...(opts.cliSessionId ? { cliSessionId: opts.cliSessionId } : {}),
        apiOnly: true,
        larkAppId: 'app_scr_tmux',
        larkAppSecret: 'secret',
      } satisfies DaemonToWorker);
      return { w, msgs, outLogs };
    };

    // Pre-start the private tmux server (`exit-empty off`) so simultaneous cold
    // worker startups do not race on initial Unix socket bind under heavy parallel load.
    execFileSync(
      'tmux',
      ['-L', preferredManagedTmuxSocket(), 'start-server', ';', 'set-option', '-s', 'exit-empty', 'off'],
      { env: privateTmuxEnv(root), stdio: 'ignore' },
    );

    // 1. Launch Session A and Session B concurrently in the SAME workingDir
    const sessA1 = spawnScratchTmuxWorker({ sessionId: sidA, fakeCid: cidA, prompt: 'HELLO_FROM_A', turnId: 'om_a1' });
    const sessB1 = spawnScratchTmuxWorker({ sessionId: sidB, fakeCid: cidB, prompt: 'HELLO_FROM_B', turnId: 'om_b1' });

    await Promise.all([
      waitFor(() => sessA1.msgs.some(m => m.type === 'final_output' && m.turnId === 'om_a1'), sessA1.outLogs),
      waitFor(() => sessB1.msgs.some(m => m.type === 'final_output' && m.turnId === 'om_b1'), sessB1.outLogs),
    ]);

    const finalA1 = sessA1.msgs.find((m): m is Extract<WorkerToDaemon, { type: 'final_output' }> => m.type === 'final_output')!;
    const finalB1 = sessB1.msgs.find((m): m is Extract<WorkerToDaemon, { type: 'final_output' }> => m.type === 'final_output')!;
    expect(finalA1.content).toBe(`SCRATCH_FINAL[${cidA.slice(0, 8)}]:HELLO_FROM_A`);
    expect(finalB1.content).toBe(`SCRATCH_FINAL[${cidB.slice(0, 8)}]:HELLO_FROM_B`);

    // 2. Kill Worker A abruptly (tmux pane + scratch tree survive) → warm reattach
    const a1Exited = new Promise<void>(r => sessA1.w.once('exit', () => r()));
    sessA1.w.kill('SIGTERM');
    await a1Exited;
    children.delete(sessA1.w);

    const sessA2 = spawnScratchTmuxWorker({
      sessionId: sidA,
      fakeCid: cidA,
      prompt: '',
      resume: true,
      cliSessionId: cidA,
    });
    await waitFor(() => sessA2.msgs.some(m => m.type === 'ready'), sessA2.outLogs);
    sessA2.w.send({ type: 'message', content: 'WARM_REATTACH_A', turnId: 'om_a2' } satisfies DaemonToWorker);
    await waitFor(() => sessA2.msgs.some(m => m.type === 'final_output' && m.turnId === 'om_a2'), sessA2.outLogs);
    const finalA2 = sessA2.msgs.find((m): m is Extract<WorkerToDaemon, { type: 'final_output' }> => m.type === 'final_output' && m.turnId === 'om_a2')!;
    expect(finalA2.content).toBe(`SCRATCH_FINAL[${cidA.slice(0, 8)}]:WARM_REATTACH_A`);

    // 3. Suspend Session A (kills tmux pane while keeping scratch tree) → cold resume with --conversation cidA
    const a2Suspended = new Promise<void>(r => sessA2.w.once('exit', () => r()));
    sessA2.w.send({ type: 'suspend' } satisfies DaemonToWorker);
    await a2Suspended;
    children.delete(sessA2.w);

    const sessA3 = spawnScratchTmuxWorker({
      sessionId: sidA,
      fakeCid: cidA,
      prompt: 'COLD_RESUME_A',
      turnId: 'om_a3',
      resume: true,
      cliSessionId: cidA,
    });
    await waitFor(() => sessA3.msgs.some(m => m.type === 'final_output' && m.turnId === 'om_a3'), sessA3.outLogs);
    const finalA3 = sessA3.msgs.find((m): m is Extract<WorkerToDaemon, { type: 'final_output' }> => m.type === 'final_output' && m.turnId === 'om_a3')!;
    expect(finalA3.content).toBe(`SCRATCH_FINAL[${cidA.slice(0, 8)}]:COLD_RESUME_A`);

    // 4. Verify host ~/.gemini and host workDir remained 100% byte-identical!
    expect(readFileSync(hostHistoryPath, 'utf8')).toBe(hostSentinelHistory);
    expect(existsSync(join(hostHome, '.gemini', 'antigravity-cli', 'conversations', `${cidA}.db`))).toBe(false);
    expect(existsSync(join(hostHome, '.gemini', 'antigravity-cli', 'conversations', `${cidB}.db`))).toBe(false);
    expect(existsSync(join(workDir, `scratch-wrote-${cidA}.txt`))).toBe(false);
    expect(existsSync(join(workDir, `scratch-wrote-${cidB}.txt`))).toBe(false);
  }, 60_000);

  it('rewrites --log-file and trustedWorkspaces into the isolated view when wrapperCli wraps Antigravity under scratch', async () => {
    const root = realpathSync(mkdtempSync('/tmp/bmx-scrw-'));
    roots.add(root);
    const hostHome = join(root, 'host-home');
    const dataDir = join(root, 'botmux-data');
    const workDir = join(root, 'project');
    const wrapDir = join(root, 'wrapbin');
    for (const d of [hostHome, dataDir, workDir, wrapDir]) mkdirSync(d, { recursive: true });

    const cid = randomUUID();
    const fakeAgy = createSandboxedFakeAgy(root, cid);
    const wrapperBin = join(wrapDir, 'my-wrapper');
    writeFileSync(wrapperBin, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });

    const sessionId = `scrwrap-${randomUUID().slice(0, 8)}`;
    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const worker = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...privateTmuxEnv(root),
        HOME: hostHome,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: sessionId,
        BOTMUX_NO_CLAIM: '1',
        LARK_APP_ID: 'app_scr_wrap',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(worker);
    worker.on('message', m => messages.push(m as WorkerToDaemon));
    worker.stdout?.on('data', b => logs.push(b.toString()));
    worker.stderr?.on('data', b => logs.push(b.toString()));

    worker.send({
      type: 'init',
      sessionId,
      chatId: 'oc_scr_wrap',
      rootMessageId: 'om_root_wrap',
      workingDir: workDir,
      cliId: 'antigravity',
      cliPathOverride: fakeAgy,
      wrapperCli: `${wrapperBin} ${fakeAgy}`,
      cliVersion: '1.5.10',
      backendType: 'pty',
      sandbox: 'scratch',
      scratchStorage: 'disk',
      promptInjection: 'none',
      prompt: 'WRAPPER_SCRATCH_TURN',
      turnId: 'om_wrap_1',
      apiOnly: true,
      larkAppId: 'app_scr_wrap',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await waitFor(
      () => messages.some(m => m.type === 'final_output' && m.turnId === 'om_wrap_1'),
      logs,
    );
    const finalMsg = messages.find((m): m is Extract<WorkerToDaemon, { type: 'final_output' }> => m.type === 'final_output')!;
    expect(finalMsg.content).toBe(`SCRATCH_FINAL[${cid.slice(0, 8)}]:WRAPPER_SCRATCH_TURN`);
    expect(existsSync(join(hostHome, '.gemini'))).toBe(false);
  }, 45_000);
});
