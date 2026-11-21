import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { killProcessTree } from './helpers/process-tree.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import { drainGrokUpdates } from '../src/services/grok-transcript.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

let child: ChildProcess | undefined;
let root: string | undefined;

afterEach(async () => {
  if (child) await killProcessTree(child);
  child = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function waitUntil(check: () => boolean, logs: string[], timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    if (child?.exitCode !== null || child?.signalCode !== null) {
      throw new Error(`Worker exited\n${logs.join('')}`);
    }
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error(`Timed out\n${logs.join('')}`);
}

function grokUpdate(sessionId: string, update: object, timestamp: number): string {
  return JSON.stringify({
    method: 'session/update',
    params: { sessionId, update },
    timestamp,
  });
}

describe('structured bridge cold-resume ownership', () => {
  it('drops only the journal-restored turn when Grok accepts a new argv prompt during recovery', async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-cold-resume-grok-'));
    const sessionDataDir = join(root, 'session');
    const workDir = join(root, 'work');
    const grokHome = join(root, '.grok');
    const botmuxSessionId = randomUUID();
    const nativeSessionId = randomUUID();
    const oldPrompt = 'interrupted prompt from the previous process';
    const newPrompt = 'new cold-resume prompt';
    const oldAt = Date.now() - 5_000;
    const nativeDir = join(grokHome, 'sessions', encodeURIComponent(workDir), nativeSessionId);
    const updatesPath = join(nativeDir, 'updates.jsonl');
    mkdirSync(sessionDataDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(nativeDir, 'summary.json'), `${JSON.stringify({ session_id: nativeSessionId })}\n`);
    writeFileSync(updatesPath, `${grokUpdate(nativeSessionId, {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: oldPrompt },
    }, oldAt)}\n`);
    const marksDir = join(sessionDataDir, 'turn-marks');
    mkdirSync(marksDir, { recursive: true });
    writeFileSync(join(marksDir, `${botmuxSessionId}.json.structured`), `${JSON.stringify({
      version: 1,
      pending: [{
        turnId: 'om_old',
        markTimeMs: oldAt,
        fingerprint: oldPrompt,
        jsonlPath: updatesPath,
        offsetAtMark: 0,
      }],
    })}\n`);

    const fakeGrok = join(root, 'fake-grok');
    const capturedPromptPath = join(root, 'captured-prompt.txt');
    writeFileSync(fakeGrok, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(capturedPromptPath)}, process.argv.at(-1) || '');
setTimeout(() => process.stdout.write('❯ ready\\n'), 300);
process.stdin.resume();
setInterval(() => {}, 1_000);
`);
    chmodSync(fakeGrok, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        GROK_HOME: grokHome,
        SESSION_DATA_DIR: sessionDataDir,
        BOTMUX_SESSION_ID: botmuxSessionId,
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'test-only',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', raw => messages.push(raw as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.send({
      type: 'init',
      sessionId: botmuxSessionId,
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: workDir,
      cliId: 'grok',
      cliPathOverride: fakeGrok,
      cliSessionId: nativeSessionId,
      resume: true,
      backendType: 'pty',
      prompt: newPrompt,
      larkAppId: 'app_test',
      larkAppSecret: 'test-only',
      turnId: 'om_new',
    } satisfies DaemonToWorker);

    await waitUntil(() => logs.join('').includes('Cleared 1 stale structured turn(s)'), logs);
    expect(logs.join('')).not.toContain('Cleared 2 stale structured turn(s)');
    await new Promise(done => setTimeout(done, 500));
    const attachedUpdatesPath = logs.join('').match(
      /Structured bridge baseline-existing recovered: (.+?) \(history=/,
    )?.[1];
    expect(attachedUpdatesPath).toBeTruthy();
    const priorOffset = statSync(attachedUpdatesPath!).size;
    const nativePrompt = readFileSync(capturedPromptPath, 'utf8');
    expect(nativePrompt).toContain(newPrompt);
    const newAt = Date.now();
    appendFileSync(attachedUpdatesPath!, [
      grokUpdate(nativeSessionId, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: nativePrompt },
      }, newAt),
      grokUpdate(nativeSessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'new answer' },
      }, newAt + 1),
      grokUpdate(nativeSessionId, {
        sessionUpdate: 'turn_completed',
        stop_reason: 'end_turn',
      }, newAt + 2),
    ].join('\n') + '\n');
    expect(drainGrokUpdates(attachedUpdatesPath!, priorOffset).events.map(event => event.kind))
      .toEqual(['user', 'assistant_final']);
    await waitUntil(() => messages.some(message => message.type === 'turn_terminal'
      && message.turnId === 'om_new'), logs);
    expect(messages.filter(message => message.type === 'turn_terminal'
      && message.turnId === 'om_new')).toMatchObject([
      { status: 'completed' },
    ]);
    expect(messages.filter(message => message.type === 'final_output'
      && message.turnId === 'om_new')).toMatchObject([
      { content: 'new answer' },
    ]);
  }, 30_000);

  it('releases the restored stale turn when its boundary is outside the 16MB restart-scan tail', async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-cold-resume-grok-tail-'));
    const sessionDataDir = join(root, 'session');
    const workDir = join(root, 'work');
    const grokHome = join(root, '.grok');
    const botmuxSessionId = randomUUID();
    const nativeSessionId = randomUUID();
    const oldPrompt = 'interrupted prompt beyond the scan tail';
    const newPrompt = 'new cold-resume prompt';
    const followUp = 'follow-up after cold recovery';
    const oldAt = Date.now() - 5_000;
    const nativeDir = join(grokHome, 'sessions', encodeURIComponent(workDir), nativeSessionId);
    const updatesPath = join(nativeDir, 'updates.jsonl');
    mkdirSync(sessionDataDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(nativeDir, 'summary.json'), `${JSON.stringify({ session_id: nativeSessionId })}\n`);
    // ~19MB of records the Grok drainer maps to NO events: the dead turn's
    // user record stays outside scanRestartInterruption's 16MB tail window,
    // while journal recovery (offsetAtMark=0) still restores it as started.
    const pad = 'x'.repeat(900);
    const records = [grokUpdate(nativeSessionId, {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: oldPrompt },
    }, oldAt)];
    for (let index = 0; index < 19_000; index++) {
      records.push(grokUpdate(nativeSessionId, {
        sessionUpdate: 'probe_filler_ignored', index, pad,
      }, oldAt + 1 + index));
    }
    writeFileSync(updatesPath, records.join('\n') + '\n');
    expect(statSync(updatesPath).size).toBeGreaterThan(17 * 1024 * 1024);
    const marksDir = join(sessionDataDir, 'turn-marks');
    mkdirSync(marksDir, { recursive: true });
    writeFileSync(join(marksDir, `${botmuxSessionId}.json.structured`), `${JSON.stringify({
      version: 1,
      pending: [{
        turnId: 'om_old',
        markTimeMs: oldAt,
        fingerprint: oldPrompt,
        jsonlPath: updatesPath,
        offsetAtMark: 0,
      }],
    })}\n`);

    const fakeGrok = join(root, 'fake-grok');
    const capturedInputPath = join(root, 'captured-input.txt');
    writeFileSync(fakeGrok, `#!/usr/bin/env node
const { writeFileSync, appendFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(capturedInputPath)}, '');
process.stdin.on('data', chunk => appendFileSync(${JSON.stringify(capturedInputPath)}, chunk.toString()));
setTimeout(() => process.stdout.write('❯ ready\\n'), 300);
[700, 1100, 1500].forEach(ms => setTimeout(() => process.stdout.write('❯ ready\\n'), ms));
process.stdin.resume();
setInterval(() => {}, 1_000);
`);
    chmodSync(fakeGrok, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        GROK_HOME: grokHome,
        SESSION_DATA_DIR: sessionDataDir,
        BOTMUX_SESSION_ID: botmuxSessionId,
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'test-only',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', raw => messages.push(raw as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.send({
      type: 'init',
      sessionId: botmuxSessionId,
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: workDir,
      cliId: 'grok',
      cliPathOverride: fakeGrok,
      cliSessionId: nativeSessionId,
      resume: true,
      backendType: 'pty',
      prompt: newPrompt,
      larkAppId: 'app_test',
      larkAppSecret: 'test-only',
      turnId: 'om_new',
    } satisfies DaemonToWorker);

    // The tail scan cannot see the dead turn boundary; journal evidence must
    // synthesise the interruption so the first prompt releases the stale turn.
    await waitUntil(() => messages.some(message => message.type === 'prompt_ready'), logs, 20_000);
    const text = logs.join('');
    expect(text).toContain('Cleared 1 stale structured turn(s)');
    expect(text).not.toContain('Cleared 2 stale structured turn(s)');
    expect(messages.some(message => message.type === 'user_notify')).toBe(true);

    child.send({ type: 'message', content: followUp, turnId: 'om_followup' } satisfies DaemonToWorker);
    await waitUntil(() => {
      try { return readFileSync(capturedInputPath, 'utf8').includes(followUp); }
      catch { return false; }
    }, logs, 20_000);
  }, 45_000);
});
