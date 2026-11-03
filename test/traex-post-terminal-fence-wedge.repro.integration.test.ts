import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readJsonLines } from './helpers/read-json-lines.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

/**
 * Field wedge (TraeX, high-traffic "ambient" groups): TraeX redrew its
 * composer and the screen went quiet BEFORE task_complete reached the rollout.
 * The structured lifecycle gate keeps a started turn unpublished (a quiet
 * mid-turn composer is rejected), so when task_complete later reaches the
 * rollout the post-terminal composer fence is armed with isPromptReady=false.
 * The transcript's fireIdle() then has to re-run the fence verification against
 * a screen that stays completely static — without it no idle edge would ever
 * restore prompt-ready, and every later durable (dispatchAttempt) message would
 * stay queued until a human typed into the web terminal.
 */

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();

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

describe('TraeX post-terminal composer fence wedge', () => {
  it('delivers the next durable message when task_complete lands after the composer went quiet', async () => {
    const botmuxSessionId = randomUUID();
    const root = mkdtempSync(join(tmpdir(), 'botmux-traex-fence-wedge-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    const traeHome = join(root, '.trae');
    const cliDir = join(traeHome, 'cli');
    const rolloutDir = join(cliDir, 'sessions', '2026', '10', '13');
    const nativeSessionId = '00000000-0000-7000-8000-000000000444';
    const rolloutPath = join(rolloutDir, `rollout-2026-10-13T00-00-00-${nativeSessionId}.jsonl`);
    const historyPath = join(cliDir, 'history.jsonl');
    const submissionsPath = join(root, 'submissions.jsonl');
    const releasePath = join(root, 'release-composer');
    const localBusyPath = join(root, 'local-busy');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(rolloutPath, '');
    writeFileSync(historyPath, '');
    writeFileSync(submissionsPath, '');

    // Fake TraeX: every submit is receipted in history.jsonl and renders a
    // busy screen; the composer is redrawn exactly once per release-file
    // generation and then the screen stays completely static.
    const fakeTraex = join(root, 'fake-traex');
    writeFileSync(fakeTraex, `#!/usr/bin/env node
const fs = require('node:fs');
const historyPath = ${JSON.stringify(historyPath)};
const submissionsPath = ${JSON.stringify(submissionsPath)};
const releasePath = ${JSON.stringify(releasePath)};
const localBusyPath = ${JSON.stringify(localBusyPath)};
const sessionId = ${JSON.stringify(nativeSessionId)};
process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\\x1b[?2004h');
function drawComposer(pct) {
  process.stdout.write(
    '\\x1b[2J\\x1b[H' +
    '╭──────────────────────────────────────────╮\\n' +
    '│ model: GPT-6-Astra xhigh /model to change │\\n' +
    '│ directory: ${dataDir.replaceAll('\\', '\\\\')} │\\n' +
    '╰──────────────────────────────────────────╯\\n' +
    '❯ Ask TraeCode CLI to do anything\\n' +
    '  GPT-6-Astra xhigh · Context ' + pct + '% left\\n'
  );
}
drawComposer(100);
let input = '';
let pasted = '';
let submitCount = 0;
let released = 0;
for (const delay of [500, 1000]) {
  setTimeout(() => { if (submitCount === 0) drawComposer(100); }, delay);
}
process.stdin.on('data', chunk => {
  input += chunk;
  while (true) {
    const start = input.indexOf('\\x1b[200~');
    if (start < 0) break;
    const end = input.indexOf('\\x1b[201~', start + 6);
    if (end < 0) break;
    pasted = input.slice(start + 6, end);
    input = input.slice(end + 6);
  }
  while (input.includes('\\r') || input.includes('\\n')) {
    const cr = input.indexOf('\\r');
    const lf = input.indexOf('\\n');
    const at = cr < 0 ? lf : lf < 0 ? cr : Math.min(cr, lf);
    input = input.slice(at + 1);
    if (!pasted) continue;
    const text = pasted;
    pasted = '';
    submitCount += 1;
    fs.appendFileSync(submissionsPath, JSON.stringify({ pid: process.pid, text }) + '\\n');
    fs.appendFileSync(historyPath, JSON.stringify({ session_id: sessionId, ts: Date.now() / 1000, text }) + '\\n');
    process.stdout.write('\\x1b[2J\\x1b[H⠋ Working…\\nContext 65% left\\n');
  }
});
let localBusy = false;
setInterval(() => {
  if (!localBusy && fs.existsSync(localBusyPath)) {
    localBusy = true;
    process.stdout.write('\\x1b[2J\\x1b[H⠋ Working…\\nContext 58% left\\n');
  }
  let wanted = 0;
  try { wanted = Number(fs.readFileSync(releasePath, 'utf8')) || 0; } catch {}
  if (wanted <= released) return;
  released = wanted;
  drawComposer(60);
}, 25);
`);
    chmodSync(fakeTraex, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
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
    const child = spawnNodeTsScript(resolve('src/worker.ts'), [], spawnOptions);
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
      cliSessionId: nativeSessionId,
      resume: true,
      backendType: 'pty',
      prompt: '',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await waitFor(
      child,
      () => messages.some(m => m.type === 'prompt_ready'),
      logs,
      'initial prompt readiness',
      30_000,
    );

    // Durable IM turn (dispatchAttempt) — exactly what the daemon sends.
    child.send({ type: 'message', content: 'first prompt', turnId: 'om_first', dispatchAttempt: 1 } satisfies DaemonToWorker);
    await waitFor(
      child,
      () => readSubmissions(submissionsPath).some(item => item.text.startsWith('first prompt')),
      logs,
      'first PTY submission',
    );
    const firstSubmission = readSubmissions(submissionsPath)[0]!;
    const nativeTurnId = '00000000-0000-7000-8000-000000000445';
    appendFileSync(rolloutPath, rolloutUser(firstSubmission.text, nativeTurnId));

    // TraeX redraws its composer and goes quiet BEFORE the rollout terminal.
    // With the structured lifecycle gate, a quiet composer mid-turn must NOT
    // publish prompt-ready: the started turn is still unfinished, so the idle
    // heuristic is rejected until task_complete lands.
    const readyBeforeComposer = messages.filter(m => m.type === 'prompt_ready').length;
    const logsBeforeComposer = logs.length;
    writeFileSync(releasePath, '1');
    await waitFor(
      child,
      () => logs.slice(logsBeforeComposer).some(line =>
        line.includes('Ignoring prompt-ready heuristic while a structured turn is unfinished')),
      logs,
      'lifecycle gate rejects the quiet composer before the terminal',
    );
    expect(messages.filter(m => m.type === 'prompt_ready').length).toBe(readyBeforeComposer);

    // The structured terminal arrives afterwards; the screen never changes
    // again. The transcript's fireIdle() runs the post-terminal fence recheck
    // on the static screen, which restores prompt-ready before any later input.
    appendFileSync(rolloutPath, rolloutTerminal(nativeTurnId));
    await waitFor(
      child,
      () => messages.some(m => m.type === 'turn_terminal' && m.turnId === 'om_first'),
      logs,
      'structured terminal for the first turn',
    );
    await waitFor(
      child,
      () => messages.filter(m => m.type === 'prompt_ready').length > readyBeforeComposer,
      logs,
      'prompt-ready restored after the terminal despite a static screen',
    );

    child.send({ type: 'message', content: 'second prompt', turnId: 'om_second', dispatchAttempt: 1 } satisfies DaemonToWorker);
    await waitFor(
      child,
      () => readSubmissions(submissionsPath).some(item => item.text.includes('second prompt')),
      logs,
      'second durable message delivered onto the static, already-ready composer',
      8_000,
    );
    expect(readSubmissions(submissionsPath)).toHaveLength(2);

    // After recovery the idle detector's busy edge must still be armed: a
    // turn started locally in the web terminal (no botmux submit) has to flip
    // readiness back to working, or durable input could be admitted into it.
    const secondSubmission = readSubmissions(submissionsPath)[1]!;
    const secondNativeTurnId = '00000000-0000-7000-8000-000000000446';
    appendFileSync(rolloutPath, rolloutUser(secondSubmission.text, secondNativeTurnId));
    const readyBeforeSecond = messages.filter(m => m.type === 'prompt_ready').length;
    writeFileSync(releasePath, '2');
    appendFileSync(rolloutPath, rolloutTerminal(secondNativeTurnId));
    await waitFor(
      child,
      () => messages.some(m => m.type === 'turn_terminal' && m.turnId === 'om_second'),
      logs,
      'structured terminal for the second turn',
    );
    await waitFor(
      child,
      () => messages.filter(m => m.type === 'prompt_ready').length > readyBeforeSecond,
      logs,
      'readiness after the second turn',
    );
    writeFileSync(localBusyPath, '1');
    await waitFor(
      child,
      () => logs.join('').includes('Explicit busy marker detected'),
      logs,
      'idle→busy edge for a locally started turn',
      8_000,
    );
  }, 60_000);
});
