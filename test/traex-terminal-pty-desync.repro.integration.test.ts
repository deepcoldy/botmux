import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
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
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

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
    try { execFileSync('tmux', ['kill-session', '-t', `=${name}`], { stdio: 'ignore' }); } catch { /* already gone */ }
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
  try {
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { pid: number; text: string });
  } catch {
    return [];
  }
}

describe('TraeX transcript-terminal / PTY-readiness desync reproduction', () => {
  it('accepts healthy type-ahead but holds successors after terminal desync and unconfirmed submits', async () => {
    const botmuxSessionId = randomUUID();
    const root = mkdtempSync(join(tmpdir(), 'botmux-traex-desync-repro-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    const traeHome = join(root, '.trae');
    const cliDir = join(traeHome, 'cli');
    const rolloutDir = join(cliDir, 'sessions', '2026', '10', '03');
    const nativeSessionId = '00000000-0000-7000-8000-000000000333';
    const rolloutPath = join(
      rolloutDir,
      `rollout-2026-10-03T00-00-00-${nativeSessionId}.jsonl`,
    );
    const historyPath = join(cliDir, 'history.jsonl');
    const submissionsPath = join(root, 'submissions.jsonl');
    const releasePath = join(root, 'release-composer');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(rolloutPath, '');
    writeFileSync(historyPath, '');
    writeFileSync(submissionsPath, '');

    const fakeTraex = join(root, 'fake-traex');
    writeFileSync(fakeTraex, `#!/usr/bin/env node
const fs = require('node:fs');
const historyPath = ${JSON.stringify(historyPath)};
const submissionsPath = ${JSON.stringify(submissionsPath)};
const releasePath = ${JSON.stringify(releasePath)};
const sessionId = ${JSON.stringify(nativeSessionId)};
process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\\x1b[?2004h');
function drawStartup() {
process.stdout.write(
  '\\x1b[2J\\x1b[H' +
  '╭──────────────────────────────────────────╮\\n' +
  '│ model: GPT-6-Astra xhigh /model to change │\\n' +
  '│ directory: ${dataDir.replaceAll('\\', '\\\\')} │\\n' +
  '╰──────────────────────────────────────────╯\\n' +
  '❯ Ask TraeCode CLI to do anything\\n' +
  '  GPT-6-Astra xhigh · Context 100% left\\n'
);
}
drawStartup();
let input = '';
let pasted = '';
let submitCount = 0;
let composerReleased = false;
// A tmux pipe attaches after spawn; real TUIs redraw during initialization.
// Keep a startup redraw available to that listener on cold restart as well.
for (const delay of [500, 1000]) {
  setTimeout(() => { if (submitCount === 0) drawStartup(); }, delay);
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
    if (submitCount <= 4) {
      fs.appendFileSync(
        historyPath,
        JSON.stringify({ session_id: sessionId, ts: Date.now() / 1000, text }) + '\\n'
      );
      process.stdout.write(
        '\\x1b[2J\\x1b[H⠋ Any second now…\\nQueued for next turn\\nContext 65% left\\n'
      );
    } else if (composerReleased) {
      process.stdout.write(
        '\\x1b[2J\\x1b[H❯ Ask TraeCode CLI to do anything\\n' +
        'GPT-6-Astra xhigh · Context 64% left\\n'
      );
    } else {
      process.stdout.write(
        '\\x1b[2J\\x1b[H⠋ Any second now…\\nQueued for next turn\\nContext 64% left\\n'
      );
    }
  }
});
setInterval(() => {
  if (composerReleased || !fs.existsSync(releasePath)) return;
  composerReleased = true;
  process.stdout.write(
    '\\x1b[2J\\x1b[H❯ Ask TraeCode CLI to do anything\\n' +
    'GPT-6-Astra xhigh · Context 65% left\\n'
  );
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
      cliSessionId: nativeSessionId,
      resume: true,
      backendType: workerBinary ? 'tmux' : 'pty',
      prompt: '',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await waitFor(
      child,
      () => messages.some(message => message.type === 'prompt_ready'),
      logs,
      'initial prompt readiness',
    );
    const initialReadyCount = messages.filter(message => message.type === 'prompt_ready').length;

    child.send({
      type: 'message',
      content: 'first prompt',
      turnId: 'om_first',
    } satisfies DaemonToWorker);
    await waitFor(
      child,
      () => readSubmissions(submissionsPath).some(item => item.text.startsWith('first prompt')),
      logs,
      'first PTY submission',
    );

    const firstSubmission = readSubmissions(submissionsPath)[0]!;
    const nativeTurnId = '00000000-0000-7000-8000-000000000334';
    appendFileSync(rolloutPath, rolloutUser(firstSubmission.text, nativeTurnId));

    // Both corrections arrive without a terminal or composer redraw. The
    // second may enter while writeInput is awaiting the first one's receipt;
    // a confirmed healthy batch must drain it instead of waiting for idle.
    child.send({
      type: 'message',
      content: 'healthy correction one',
      turnId: 'om_correction_one',
    } satisfies DaemonToWorker);
    child.send({
      type: 'message',
      content: 'healthy correction two',
      turnId: 'om_correction_two',
    } satisfies DaemonToWorker);
    await waitFor(
      child,
      () => readSubmissions(submissionsPath).length === 3,
      logs,
      'healthy corrections delivered before the active turn completes',
    );
    expect(messages.some(message =>
      message.type === 'turn_terminal' && message.turnId === 'om_first')).toBe(false);

    const correctionOneNativeId = '00000000-0000-7000-8000-000000000336';
    const correctionTwoNativeId = '00000000-0000-7000-8000-000000000337';
    appendFileSync(
      rolloutPath,
      rolloutTerminal(nativeTurnId)
        + rolloutUser('healthy correction one', correctionOneNativeId)
        + rolloutTerminal(correctionOneNativeId)
        + rolloutUser('healthy correction two', correctionTwoNativeId),
    );

    await waitFor(
      child,
      () => messages.some(message =>
        message.type === 'turn_terminal' && message.turnId === 'om_correction_one'),
      logs,
      'predecessor terminal while the native successor remains running',
    );
    child.send({
      type: 'message',
      content: 'correction after native successor starts',
      turnId: 'om_correction_three',
    } satisfies DaemonToWorker);
    await waitFor(
      child,
      () => readSubmissions(submissionsPath).length === 4,
      logs,
      'type-ahead into an already-started native successor',
    );

    appendFileSync(rolloutPath, rolloutTerminal(correctionTwoNativeId));
    await waitFor(
      child,
      () => messages.some(message =>
        message.type === 'turn_terminal' && message.turnId === 'om_correction_two'),
      logs,
      'structured terminal receipt',
    );

    child.send({
      type: 'message',
      content: 'successor must stay in BotMux',
      turnId: 'om_successor',
    } satisfies DaemonToWorker);
    await new Promise(resolveWait => setTimeout(resolveWait, 750));

    const submissions = readSubmissions(submissionsPath);
    expect(
      submissions,
      `successor leaked into the same PTY generation\n${logs.join('')}`,
    ).toHaveLength(4);
    expect(submissions[0]?.text).toMatch(/^first prompt/);

    expect(
      messages.filter(message => message.type === 'prompt_ready'),
      `structured terminal bypassed PTY readiness\n${logs.join('')}`,
    ).toHaveLength(initialReadyCount);

    writeFileSync(releasePath, 'ready');
    await waitFor(
      child,
      () => readSubmissions(submissionsPath)
        .some(item => item.text === 'successor must stay in BotMux'),
      logs,
      'successor submission after composer redraw',
    );

    const releasedSubmissions = readSubmissions(submissionsPath);
    expect(releasedSubmissions).toHaveLength(5);
    expect(releasedSubmissions[4]).toEqual({
      pid: releasedSubmissions[0]!.pid,
      text: 'successor must stay in BotMux',
    });

    child.send({
      type: 'message',
      content: 'third message waits behind quarantine',
      turnId: 'om_third',
    } satisfies DaemonToWorker);
    await waitFor(
      child,
      () => logs.join('').includes('Ignoring prompt-ready while input delivery is quarantined'),
      logs,
      'quarantined prompt-ready rejection',
      6_000,
    );

    expect(
      readSubmissions(submissionsPath),
      `unconfirmed submit did not quarantine its backend generation\n${logs.join('')}`,
    ).toHaveLength(5);
    expect(logs.join('')).toContain('Quarantined input delivery for backend generation');

    const successorSubmission = readSubmissions(submissionsPath)[4]!;
    const successorNativeTurnId = '00000000-0000-7000-8000-000000000335';
    const correctionThreeNativeId = '00000000-0000-7000-8000-000000000338';
    appendFileSync(
      rolloutPath,
      rolloutUser('correction after native successor starts', correctionThreeNativeId)
        + rolloutTerminal(correctionThreeNativeId)
        + rolloutUser(successorSubmission.text, successorNativeTurnId)
        + rolloutTerminal(successorNativeTurnId),
    );
    await waitFor(
      child,
      () => messages.some(message =>
        message.type === 'turn_terminal' && message.turnId === 'om_successor'),
      logs,
      'exact structured terminal for the quarantined submit',
    );
    await waitFor(
      child,
      () => readSubmissions(submissionsPath)
        .some(item => item.text === 'third message waits behind quarantine'),
      logs,
      'successor release after exact structured terminal',
    );

    const recoveredSubmissions = readSubmissions(submissionsPath);
    expect(recoveredSubmissions).toHaveLength(6);
    expect(recoveredSubmissions.filter(
      item => item.text === 'successor must stay in BotMux',
    )).toHaveLength(1);
    expect(recoveredSubmissions[5]).toEqual({
      pid: recoveredSubmissions[0]!.pid,
      text: 'third message waits behind quarantine',
    });
    await waitFor(
      child,
      () => logs.join('').includes('after unconfirmed submit turn=om_third'),
      logs,
      'third submit is quarantined before the restart',
    );
    const readyBeforeRestart = messages.filter(message => message.type === 'prompt_ready').length;
    child.send({ type: 'restart' } satisfies DaemonToWorker);
    await waitFor(
      child,
      () => messages.filter(message => message.type === 'prompt_ready').length > readyBeforeRestart,
      logs,
      'replacement generation readiness',
    );
    expect(readSubmissions(submissionsPath)).toHaveLength(6);
    expect(readSubmissions(submissionsPath).filter(
      item => item.text === 'third message waits behind quarantine',
    )).toHaveLength(1);
  }, 30_000);
});
