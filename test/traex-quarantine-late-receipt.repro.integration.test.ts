import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readJsonLines } from './helpers/read-json-lines.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { killWorkerTmuxSession } from './helpers/worker-tmux-session.js';
import { createBracketedPasteCollector } from './helpers/bracketed-paste-collector.js';

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();
const tmuxSessions = new Set<string>();

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  child.kill('SIGKILL');
  await Promise.race([
    exited,
    new Promise<void>(resolveExit => setTimeout(resolveExit, 2_000)),
  ]);
}

afterEach(async () => {
  await Promise.all([...children].map(stopChild));
  children.clear();
  for (const name of tmuxSessions) {
    killWorkerTmuxSession(`=${name}`);
  }
  tmuxSessions.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

async function waitFor(
  child: ChildProcess,
  predicate: () => boolean,
  logs: string[],
  description: string,
  timeoutMs = 12_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`worker exited before ${description}\n${logs.join('')}`);
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`timed out waiting for ${description}\n${logs.join('')}`);
}

function rolloutLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function rolloutUser(text: string, turnId: string): string {
  return rolloutLine({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: text,
      images: [],
      local_images: [],
      text_elements: [],
      turn_id: turnId,
    },
  });
}

function rolloutTerminal(turnId: string): string {
  return rolloutLine({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: turnId,
      last_agent_message: 'first turn completed',
      completed_at: Math.floor(Date.now() / 1_000),
      duration_ms: 1_000,
    },
  });
}

function readSubmissions(path: string): Array<{ pid: number; text: string }> {
  return readJsonLines<{ pid: number; text: string }>(path);
}

describe('TraeX quarantine after bounded warning', () => {
  async function runRepro(opts: { freshFallback?: boolean } = {}): Promise<void> {
    const botmuxSessionId = randomUUID();
    const root = mkdtempSync(join(tmpdir(), 'botmux-traex-desync-repro-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    const traeHome = join(root, '.trae');
    const cliDir = join(traeHome, 'cli');
    const rolloutDir = join(cliDir, 'sessions', '2026', '10', '03');
    const nativeSessionId = '00000000-0000-7000-8000-000000000333';
    const retiredResumeId = '00000000-0000-7000-8000-000000000444';
    const rolloutPath = join(
      rolloutDir,
      `rollout-2026-10-03T00-00-00-${nativeSessionId}.jsonl`,
    );
    const historyPath = join(cliDir, 'history.jsonl');
    const submissionsPath = join(root, 'submissions.jsonl');
    const releasePath = join(root, 'release-composer');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(rolloutDir, { recursive: true });
    // The fresh-fallback variant proves the resume target missing BEFORE spawn;
    // the fake then opens a different fresh rollout when the CLI starts.
    if (!opts.freshFallback) writeFileSync(rolloutPath, '');
    writeFileSync(historyPath, '');
    writeFileSync(submissionsPath, '');


    const fakeTraex = join(root, 'fake-traex');
    writeFileSync(fakeTraex, `#!/usr/bin/env node
const fs = require('node:fs');
// Tier-2 fresh demotion needs two failed resume launches before the surviving
// fresh process opens its new rollout. The test drives the matching restarts.
if (${opts.freshFallback === true} && process.argv.includes('resume')) process.exit(1);
// A live fd is the adapter's proof that this process owns the history SID.
const rolloutFd = fs.openSync(${JSON.stringify(rolloutPath)}, 'a');
const historyPath = ${JSON.stringify(historyPath)};
const submissionsPath = ${JSON.stringify(submissionsPath)};
const releasePath = ${JSON.stringify(releasePath)};
const sessionId = ${JSON.stringify(nativeSessionId)};
process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\\x1b[?2004h');
function composer() {
 process.stdout.write('\\x1b[2J\\x1b[H❯ Ask TraeCode CLI to do anything\\nGPT-6-Astra xhigh · Context 90% left\\n');
}
composer();
let count = 0;
const collectPaste = (${createBracketedPasteCollector.toString()})(text => {
 count++;
 fs.appendFileSync(submissionsPath, JSON.stringify({pid:process.pid,text})+'\\n');
 if (count === 1) {
  process.stdout.write('\\x1b[2J\\x1b[H❯ [Pasted text #1 +3 lines]\\nGPT-6-Astra xhigh · Context 90% left\\n');
 } else {
  fs.appendFileSync(historyPath, JSON.stringify({session_id:sessionId,ts:Date.now()/1000,text})+'\\n');
  process.stdout.write('\\x1b[2J\\x1b[H⠋ Working (esc to interrupt)\\n');
 }
});
process.stdin.on('data', collectPaste);
let released = false;
setInterval(() => {
 if (!released && fs.existsSync(releasePath)) { released = true; composer(); }
}, 25);
`);
    chmodSync(fakeTraex, 0o755);
    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const workerBinary = process.env.BOTMUX_TEST_WORKER_BINARY;
    if (workerBinary) tmuxSessions.add(`bmx-${botmuxSessionId.slice(0, 8)}`);
    const spawnOptions: SpawnOptions = {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        TRAE_HOME: traeHome,
        BOTMUX_TIME_SCALE: '0.01',
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: botmuxSessionId,
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    };
    const child = workerBinary
      ? spawn(workerBinary, ['__worker'], spawnOptions)
      : spawnNodeTsScript(resolve('src/worker.ts'), [], spawnOptions);
    children.add(child);
    child.on('message', raw => messages.push(raw as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    child.send({
      type: 'init',
      sessionId: botmuxSessionId,
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'traex',

      cliPathOverride: fakeTraex,
      cliSessionId: opts.freshFallback ? retiredResumeId : nativeSessionId,
      resume: true,
      backendType: workerBinary ? 'tmux' : 'pty',
      prompt: '',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    if (opts.freshFallback) {
      for (let exitCount = 1; exitCount <= 2; exitCount++) {
        await waitFor(child,
          () => messages.filter(message => message.type === 'claude_exit').length >= exitCount,
          logs, `resume launch failure ${exitCount}`, 15_000);
        child.send({ type: 'restart', reason: 'cli_crash' } satisfies DaemonToWorker);
      }
    }

    await waitFor(
      child,
      () => messages.some(message => message.type === 'prompt_ready'),
      logs,
      'initial prompt readiness',
      30_000,
    );
    if (opts.freshFallback) {
      expect(logs.join('')).toContain('Resume fallback: dropping --resume');
    }

    child.send({
      type: 'message',
      content: 'first prompt',
      turnId: 'om_first',
      // Ordinary TRAE drafts now retain attribution in master (#3506).
      // The durable delivery path still retires its bounded warning/mark and
      // needs this PR's separately owned late receipt observer.
      dispatchAttempt: 1,
    } satisfies DaemonToWorker);
    await waitFor(
      child,
      () => readSubmissions(submissionsPath).some(item => item.text.startsWith('first prompt')),
      logs,
      'first PTY submission',
    );


    const firstSubmission = readSubmissions(submissionsPath)[0]!;
    // Under load the verification lease can expire before the warning timer.
    // Both routes retire attribution without proving receipt; recovery must
    // survive either ordering (the exact warning route is also fake-clock tested).
    await waitFor(child, () => {
      const output = logs.join('');
      return output.includes('Structured bridge mark dropped after submit failure')
        || output.includes('expired 1 structured head(s) without transcript start (om_first)');
    }, logs, 'bounded cleanup retires the unconfirmed attribution mark', 60_000);
    await new Promise<void>((resolveSend, rejectSend) => {
      child.send({
        type: 'message', content: 'successor after late completion',
        turnId: 'om_successor', dispatchAttempt: 1,
      } satisfies DaemonToWorker, error => error ? rejectSend(error) : resolveSend());
    });
    // A durable terminal can leave the worker logically busy: the successor
    // then queues without calling flushPending and its old "Holding 1" log.
    // Prove the hold below from actual CLI submissions, not that log branch.
    // A sibling's same-text receipt is NOT proof, even with a terminal and idle.
    appendFileSync(historyPath, rolloutLine({session_id: '00000000-0000-7000-8000-000000000999', text: firstSubmission.text, ts: Date.now()/1000}));
    appendFileSync(rolloutPath, rolloutTerminal('unrelated-native-turn'));
    writeFileSync(releasePath, 'idle');
    await new Promise(resolve => setTimeout(resolve, 21_000));
    expect(readSubmissions(submissionsPath)).toHaveLength(1);
    // The user eventually submits the parked draft. Its receipt and terminal
    // arrive AFTER the bounded warning; the viewport is now permanently quiet.
    appendFileSync(historyPath, rolloutLine({session_id: nativeSessionId, text: firstSubmission.text, ts: Date.now()/1000}));
    appendFileSync(rolloutPath, rolloutUser(firstSubmission.text, 'late-owned-turn') + rolloutTerminal('late-owned-turn'));
    await waitFor(child, () => readSubmissions(submissionsPath).length === 2, logs,
      'owned late receipt unlocks queued successor on static composer', 30_000);
    expect(readSubmissions(submissionsPath)).toEqual([
      firstSubmission, { pid: firstSubmission.pid, text: 'successor after late completion' },
    ]);
    expect(logs.join('')).toContain('owned late submit receipt');
  }

  it('recovers only the owned late receipt without replaying the ambiguous input', () => runRepro(), 120_000);

  it('uses the fresh native identity after a restart-loop demotion', () => runRepro({ freshFallback: true }), 120_000);
});
