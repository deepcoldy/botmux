import { type ChildProcess, type SpawnOptions } from 'node:child_process';
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
import { createBracketedPasteCollector } from './helpers/bracketed-paste-collector.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

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
  timeoutMs = 20_000,
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

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function readSubmissions(path: string): Array<{ text: string }> {
  return readJsonLines<{ text: string }>(path);
}

describe('TraeX subagent native continuation real Worker and PTY', () => {
  it('delivers ordinary follow-ups during native subagent continuation while still holding post-terminal composer gaps', async () => {
    const botmuxSessionId = randomUUID();
    const root = mkdtempSync(join(tmpdir(), 'botmux-traex-native-cont-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    const traeHome = join(root, '.trae');
    const cliDir = join(traeHome, 'cli');
    const rolloutDir = join(cliDir, 'sessions', '2026', '11', '28');
    const nativeSessionId = '00000000-0000-7000-8000-000000003943';
    const rolloutPath = join(rolloutDir, `rollout-2026-11-28T00-00-00-${nativeSessionId}.jsonl`);
    const historyPath = join(cliDir, 'history.jsonl');
    const submissionsPath = join(root, 'submissions.jsonl');
    const triggerPath = join(root, 'trigger');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(rolloutPath, line({
      timestamp: new Date().toISOString(),
      type: 'session_meta',
      payload: { id: nativeSessionId, cwd: dataDir },
    }));
    writeFileSync(historyPath, '');
    writeFileSync(submissionsPath, '');

    const fakeTraex = join(root, 'fake-traex');
    writeFileSync(fakeTraex, `#!/usr/bin/env node
const fs = require('node:fs');
const historyPath = ${JSON.stringify(historyPath)};
const submissionsPath = ${JSON.stringify(submissionsPath)};
const triggerPath = ${JSON.stringify(triggerPath)};
const rolloutPath = ${JSON.stringify(rolloutPath)};
const sessionId = ${JSON.stringify(nativeSessionId)};
const report = s => '\\x1b]7501;state=' + s + ':app=traecli\\x1b\\\\';
if (process.argv.includes('--version') || process.argv.includes('-V')) {
  process.stdout.write('traex 0.217.0\\n');
  process.exit(0);
}
if (process.argv[2] === 'debug') {
  process.stdout.write(JSON.stringify({ models: [] }));
  process.exit(0);
}
if (process.argv[2] === 'app-server') {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let end;
    while ((end = buf.indexOf('\\n')) >= 0) {
      const req = JSON.parse(buf.slice(0, end));
      buf = buf.slice(end + 1);
      if (req.method === 'initialize') process.stdout.write(JSON.stringify({ id: req.id, result: {} }) + '\\n');
      if (req.method === 'model/list') {
        process.stdout.write(JSON.stringify({ id: req.id, result: { data: [{ id: 'core' }, { id: 'backup' }], nextCursor: null } }) + '\\n');
      }
    }
  });
} else {
  const fd = fs.openSync(rolloutPath, 'a');
  process.stdin.setRawMode?.(true);
  process.stdin.setEncoding('utf8');
  process.stdout.write('\\x1b[?2004h');
  const drawComposer = (pct, withDone = false) => {
    process.stdout.write(
      (withDone ? report('done') : '') +
      '\\x1b[2J\\x1b[H' +
      '╭──────────────────────────────────────────╮\\n' +
      '│ model: core xhigh /model to change       │\\n' +
      '│ directory: ${dataDir.replaceAll('\\', '\\\\')} │\\n' +
      '╰──────────────────────────────────────────╯\\n' +
      '❯ Ask TraeCode CLI to do anything\\n' +
      '  core xhigh · Context ' + pct + '% left\\n'
    );
  };
  drawComposer(100);
  setTimeout(() => process.stdout.write(report('idle')), 150);
  let submitCount = 0;
  const collectPaste = (${createBracketedPasteCollector.toString()})(text => {
    submitCount += 1;
    fs.appendFileSync(submissionsPath, JSON.stringify({ text }) + '\\n');
    fs.appendFileSync(historyPath, JSON.stringify({ session_id: sessionId, ts: Date.now() / 1000, text }) + '\\n');
    process.stdout.write(report('working') + '\\x1b[2J\\x1b[H◆ Working… (1s • esc to interrupt)\\nContext 85% left\\n');
  });
  process.stdin.on('data', collectPaste);
  let lastTrigger = '';
  setInterval(() => {
    let val = '';
    try { val = fs.readFileSync(triggerPath, 'utf8').trim(); } catch {}
    if (!val || val === lastTrigger) return;
    lastTrigger = val;
    if (val === 'composer-1') drawComposer(90, true);
    else if (val === 'native-wake') {
      process.stdout.write(
        report('working') +
        '\\x1b[2J\\x1b[H◆ Working… (2s • esc to interrupt)\\n❯ Ask TraeCode CLI to do anything\\n  core xhigh · Context 80% left\\n'
      );
    } else if (val === 'composer-2') drawComposer(75, true);
    else if (val === 'composer-3') drawComposer(70, true);
  }, 25);
  process.on('exit', () => { try { fs.closeSync(fd); } catch {} });
}
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
      cliVersion: '0.217.0',
      cliPathOverride: fakeTraex,
      cliSessionId: nativeSessionId,
      resume: true,
      backendType: 'pty',
      prompt: '',
      model: 'auto',
      traexAutoModel: {
        enabled: true,
        trigger: 'capacity',
        models: ['core', 'backup'],
        reselectPerTurn: false,
        preflightLoadCheck: false,
        queueTimeoutMs: 5_000,
      },
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

    // Phase 1: Main turn T1 runs and completes, releasing activeTurnAuthority.
    child.send({
      type: 'message',
      content: 'spawn background subagent',
      turnId: 'om_main',
    } satisfies DaemonToWorker);
    await waitFor(
      child,
      () => readSubmissions(submissionsPath).length === 1,
      logs,
      'main turn submitted',
    );
    const t1 = '00000000-0000-7000-8000-000000000101';
    const submittedMain = readSubmissions(submissionsPath)[0]!.text;
    appendFileSync(
      rolloutPath,
      line({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: t1, root_turn_id: t1 } })
        + line({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'user_message', message: submittedMain, images: [], local_images: [], turn_id: t1 } })
        + line({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: t1, last_agent_message: 'subagent started' } }),
    );
    const readyBeforeT1End = messages.filter(m => m.type === 'prompt_ready').length;
    writeFileSync(triggerPath, 'composer-1');
    await waitFor(
      child,
      () => messages.some(m => m.type === 'turn_terminal' && m.turnId === 'om_main' && m.status === 'completed')
        && messages.filter(m => m.type === 'prompt_ready').length > readyBeforeT1End,
      logs,
      'main turn completed and composer ready',
    );

    // Phase 2: Subagent callback wakes TRAE natively (nested task_started with root_turn_id=t1, no user message, OSC working).
    const t2 = '00000000-0000-7000-8000-000000000102';
    const logsBeforeWake = logs.length;
    writeFileSync(triggerPath, 'native-wake');
    appendFileSync(
      rolloutPath,
      line({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: t2, root_turn_id: t1 } })
        + line({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'agent_message', turn_id: t2, message: 'processing subagent report', phase: 'commentary' } }),
    );
    await waitFor(
      child,
      () => logs.slice(logsBeforeWake).some(line =>
        line.includes('[program-status] status received (state=working); authority engaged')
        || line.includes('Explicit busy marker detected')),
      logs,
      'worker observes native continuation working transition',
    );

    // Phase 3: Ordinary user follow-up arrives WHILE native continuation t2 is still actively running.
    // Must be submitted immediately (not held until t2 ends!).
    child.send({
      type: 'message',
      content: 'follow-up during subagent continuation',
      turnId: 'om_followup',
    } satisfies DaemonToWorker);
    await waitFor(
      child,
      () => readSubmissions(submissionsPath).some(s => s.text.includes('follow-up during subagent continuation')),
      logs,
      'follow-up submitted immediately during active native continuation',
      8_000,
    );
    const followupText = readSubmissions(submissionsPath)[1]!.text;
    appendFileSync(
      rolloutPath,
      line({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'user_message', message: followupText, images: [], local_images: [], turn_id: t2 } })
        + line({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: t2, last_agent_message: 'answer covering follow-up' } }),
    );
    const readyBeforeT2End = messages.filter(m => m.type === 'prompt_ready').length;
    writeFileSync(triggerPath, 'composer-2');
    await waitFor(
      child,
      () => messages.some(m => m.type === 'final_output' && m.turnId === 'om_followup' && m.content === 'answer covering follow-up')
        && messages.some(m => m.type === 'turn_terminal' && m.turnId === 'om_followup' && m.status === 'completed')
        && messages.filter(m => m.type === 'prompt_ready').length > readyBeforeT2End,
      logs,
      'follow-up reply attributed and settled',
    );

    // Phase 4 (Regression guard): Turn 3 finishes via task_complete WITHOUT composer redraw and WITHOUT native continuation.
    // Turn 4 must stay held until composer redraws.
    child.send({
      type: 'message',
      content: 'turn three',
      turnId: 'om_three',
    } satisfies DaemonToWorker);
    await waitFor(
      child,
      () => readSubmissions(submissionsPath).length === 3,
      logs,
      'turn three submitted',
    );
    const t3 = '00000000-0000-7000-8000-000000000103';
    const turnThreeText = readSubmissions(submissionsPath)[2]!.text;
    appendFileSync(
      rolloutPath,
      line({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: t3, root_turn_id: t3 } })
        + line({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'user_message', message: turnThreeText, images: [], local_images: [], turn_id: t3 } })
        + line({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: t3, last_agent_message: 'turn three done' } }),
    );
    await waitFor(
      child,
      () => messages.some(m => m.type === 'turn_terminal' && m.turnId === 'om_three' && m.status === 'completed'),
      logs,
      'turn three terminal without composer redraw',
    );

    child.send({
      type: 'message',
      content: 'turn four waits for composer',
      turnId: 'om_four',
    } satisfies DaemonToWorker);
    await new Promise(resolveWait => setTimeout(resolveWait, 750));
    expect(readSubmissions(submissionsPath)).toHaveLength(3);

    writeFileSync(triggerPath, 'composer-3');
    await waitFor(
      child,
      () => readSubmissions(submissionsPath).some(s => s.text.includes('turn four waits for composer')),
      logs,
      'turn four delivered after composer redraw',
      8_000,
    );
    expect(readSubmissions(submissionsPath)).toHaveLength(4);
  }, 60_000);
});
