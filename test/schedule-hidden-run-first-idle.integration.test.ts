/**
 * #1607: a silent scheduled task runs in a hidden session that is closed on
 * its turn's first idle. OpenCode takes the prompt from `--prompt` once its
 * TUI has loaded, and the TUI can draw once and then stay quiet for longer
 * than the worker's first-prompt quiescence window while it loads. The worker
 * used to report that quiet as the turn's idle, the daemon closed the hidden
 * session, and the CLI was killed before it ever submitted the prompt.
 *
 * A real worker drives a stand-in OpenCode that draws a frame, stays quiet,
 * then records the prompt in OpenCode's store (the session database the
 * adapter reads) and runs a short turn. Only the executable is replaced.
 */
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

let child: ChildProcess | undefined;
let root: string | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise<void>(done => child!.once('exit', () => done()));
    if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
    await Promise.race([stopped, new Promise<void>(done => setTimeout(done, 3_000))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await stopped;
    }
  }
  child = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

// Longer than OpenCode's first-prompt quiescence window (4s), which is what
// turned the quiet load into an idle.
const BOOT_QUIET_MS = 6_500;

const FAKE_OPENCODE = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const cfg = JSON.parse(readFileSync(__CONFIG__, 'utf8'));
const args = process.argv.slice(2);
const at = args.indexOf('--prompt');
const prompt = at >= 0 ? args[at + 1] : undefined;
const event = kind => appendFileSync(cfg.events, JSON.stringify({ kind, t: Date.now() }) + '\\n');
process.stdin.resume();
process.stdout.write('opencode loading\\r\\n');
setTimeout(() => {
  if (prompt) {
    const db = new DatabaseSync(cfg.db);
    const now = Date.now();
    db.prepare('INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)')
      .run('ses_fake', cfg.workingDir, 'fake', now, now);
    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
      .run('msg_fake', 'ses_fake', now, JSON.stringify({ role: 'user' }));
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
      .run('prt_fake', 'msg_fake', 'ses_fake', now, JSON.stringify({ type: 'text', text: prompt }));
    db.close();
    event('prompt_recorded');
  }
  let step = 0;
  const turn = setInterval(() => {
    process.stdout.write('thinking ' + step + '\\r\\n');
    if (++step === 5) {
      clearInterval(turn);
      process.stdout.write('done\\r\\n');
      event('turn_done');
    }
  }, 200);
}, cfg.bootQuietMs);
`;

function createOpenCodeStore(dbPath: string): void {
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL DEFAULT 0,
      time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
  `);
  db.close();
}

async function waitUntil(check: () => boolean, logs: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    if (child?.exitCode !== null || child?.signalCode !== null) throw new Error(`Worker exited\n${logs.join('')}`);
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(`Timed out\n${logs.join('')}`);
}

describe('hidden schedule run on OpenCode', () => {
  it('reports no idle for the scheduled turn until OpenCode has taken the prompt', async () => {
    root = mkdtempSync(join(tmpdir(), 'bmx-1607-'));
    const dataDir = join(root, 'data');
    const workingDir = join(root, 'work');
    const xdgData = join(root, 'xdg-data');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workingDir, { recursive: true });
    // OpenCode is installed: its store exists before this run starts.
    const dbPath = join(xdgData, 'opencode', 'opencode.db');
    createOpenCodeStore(dbPath);
    const events = join(root, 'events.jsonl');
    const configPath = join(root, 'fake-opencode.json');
    writeFileSync(configPath, JSON.stringify({ db: dbPath, events, workingDir, bootQuietMs: BOOT_QUIET_MS }));
    const fakeOpenCode = join(root, 'fake-opencode.mjs');
    writeFileSync(fakeOpenCode, FAKE_OPENCODE.replace('__CONFIG__', JSON.stringify(configPath)));
    chmodSync(fakeOpenCode, 0o755);

    const sessionId = randomUUID();
    const turnId = `schedule:task-1607:${randomUUID()}`;
    const messages: Array<{ at: number; msg: WorkerToDaemon }> = [];
    const logs: string[] = [];
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env, HOME: root, XDG_DATA_HOME: xdgData, XDG_CONFIG_HOME: join(root, 'xdg-config'),
        SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', raw => messages.push({ at: Date.now(), msg: raw as WorkerToDaemon }));
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    const routingAnchor = `schedule-run:task-1607:${turnId.slice(turnId.lastIndexOf(':') + 1)}`;
    child.send({
      type: 'init', sessionId, chatId: 'oc_test', rootMessageId: routingAnchor, workingDir,
      cliId: 'opencode', cliPathOverride: fakeOpenCode, backendType: 'pty',
      prompt: 'scheduled check: report only if something is wrong', turnId,
      larkAppId: 'app_test', larkAppSecret: 'test-only', locale: 'zh',
      deferredScheduleRun: { taskId: 'task-1607', turnId, routingAnchor, createdAt: new Date().toISOString() },
    } satisfies DaemonToWorker);

    const recorded = () => (existsSync(events) ? readFileSync(events, 'utf8') : '')
      .split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; t: number });
    const scheduledIdles = () => messages.filter(({ msg }) => msg.type === 'screen_update'
      && msg.status === 'idle' && msg.turnId === turnId);

    await waitUntil(() => recorded().some(e => e.kind === 'turn_done') && scheduledIdles().length > 0, logs, 40_000);

    const promptRecordedAt = recorded().find(e => e.kind === 'prompt_recorded')!.t;
    // The hidden run is reclaimed on this idle: it must not come before the
    // CLI took the prompt, or the prompt is lost with the session.
    expect(scheduledIdles()[0]!.at).toBeGreaterThan(promptRecordedAt);
    expect(messages.some(({ msg }) => msg.type === 'turn_terminal' && msg.status === 'failed')).toBe(false);
  }, 60_000);
});
