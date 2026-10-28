import { type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import {
  PI_INPUT_QUEUED_CUSTOM_TYPE,
  PI_TURN_BOUNDARY_CUSTOM_TYPE,
} from '../src/adapters/cli/pi-turn-boundary-extension.js';
import { STRUCTURED_SUBMIT_START_GRACE_MS } from '../src/services/codex-bridge-queue.js';

// Real worker, fake `pi`, hand-written session JSONL, in the shape of the live
// incident: Pi looked idle, so the worker submitted the next turn, but Pi was
// still busy and held the input in its own queue. Pi persisted the user record
// only 83s later, long after the 20s pre-start lease, and the worker had
// already told the thread the reply could not be collected.

let child: ChildProcess | undefined;
let root: string | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise<void>(done => child!.once('exit', () => done()));
    child.kill('SIGKILL');
    await Promise.race([stopped, new Promise<void>(done => setTimeout(done, 2_000))]);
  }
  child = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function waitUntil(check: () => boolean, logs: string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (check()) return;
    if (child?.exitCode !== null || child?.signalCode !== null) throw new Error(`Worker exited\n${logs.join('')}`);
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error(`Timed out\n${logs.join('')}`);
}

describe('Pi worker: a turn Pi accepted while busy and persists late', () => {
  it('keeps the turn past the pre-start lease and collects its reply', async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-queued-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const cliSessionId = 'feedbeef-1234-4678-9abc-def01234567a';
    const piSessionsDir = join(root, '.pi', 'agent', 'sessions', dataDir.replace(/\//g, '--'));
    mkdirSync(piSessionsDir, { recursive: true });
    const transcript = join(piSessionsDir, `20261027221300_${cliSessionId}.jsonl`);
    writeFileSync(transcript, '');
    const fakePi = join(root, 'fake-pi');
    // Busy line until the first turn settles, then an idle composer. Once the
    // second turn's text arrives, do what Pi does when it is in fact still
    // busy: record the acceptance at once and keep the user record back.
    writeFileSync(fakePi, `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const transcript = ${JSON.stringify(transcript)};
process.stdout.write('Working...\\n');
const settle = setInterval(() => {
  let rows = '';
  try { rows = readFileSync(transcript, 'utf8'); } catch {}
  if (!/"lastStopReason":"/.test(rows)) return;
  clearInterval(settle);
  process.stdout.write('\\u001b[2J\\u001b[H> ');
}, 50);
let input = '';
let queued = false;
process.stdin.on('data', chunk => {
  input += chunk.toString();
  if (queued || !input.includes('second task') || !/[\\r\\n]/.test(input)) return;
  queued = true;
  appendFileSync(transcript, JSON.stringify({ type: 'custom', timestamp: new Date().toISOString(),
    customType: ${JSON.stringify(PI_INPUT_QUEUED_CUSTOM_TYPE)}, data: { behavior: 'steer' } }) + '\\n');
});
setInterval(() => {}, 1000);
`);
    chmodSync(fakePi, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env, HOME: root, SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sid-pi-queued', LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', raw => { messages.push(raw as WorkerToDaemon); });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.send({
      type: 'init', sessionId: 'sid-pi-queued', chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir: dataDir, cliId: 'pi', cliPathOverride: fakePi, cliSessionId,
      backendType: 'pty', prompt: 'first task', larkAppId: 'app_test', larkAppSecret: 'test-only',
      turnId: 'om_first',
    } satisfies DaemonToWorker);
    await waitUntil(() => logs.some(line => line.includes('Codex bridge fresh-empty:')), logs);

    const at = () => new Date().toISOString();
    const append = (rows: object[]) => appendFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    append([
      { type: 'custom', timestamp: at(), customType: PI_TURN_BOUNDARY_CUSTOM_TYPE, data: { lastStopReason: null } },
      { type: 'message', timestamp: at(), message: { role: 'user', content: [{ type: 'text', text: 'first task' }] } },
      { type: 'message', timestamp: at(), message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'first answer' }] } },
      { type: 'custom', timestamp: at(), customType: PI_TURN_BOUNDARY_CUSTOM_TYPE, data: { lastStopReason: 'stop' } },
    ]);
    await waitUntil(() => messages.some(msg => msg.type === 'final_output' && msg.turnId === 'om_first'), logs);

    child.send({ type: 'message', turnId: 'om_second', content: 'second task' } satisfies DaemonToWorker);
    await waitUntil(() => logs.some(line => line.includes('Writing to PTY') && line.includes('second task')), logs);
    // Past the lease the old code gave the turn up at.
    await new Promise(done => setTimeout(done, STRUCTURED_SUBMIT_START_GRACE_MS + 3_000));
    expect(logs.join('')).not.toContain('could not collect turn om_second');
    expect(messages.filter(msg => msg.type === 'user_notify')).toEqual([]);

    append([
      { type: 'message', timestamp: at(), message: { role: 'user', content: [{ type: 'text', text: 'second task' }] } },
      { type: 'message', timestamp: at(), message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'second answer' }] } },
      { type: 'custom', timestamp: at(), customType: PI_TURN_BOUNDARY_CUSTOM_TYPE, data: { lastStopReason: 'stop' } },
    ]);
    await waitUntil(() => messages.some(msg => msg.type === 'final_output' && msg.turnId === 'om_second'), logs);
    expect(messages.find(msg => msg.type === 'final_output' && msg.turnId === 'om_second'))
      .toMatchObject({ content: 'second answer' });
  }, 60_000);
});
