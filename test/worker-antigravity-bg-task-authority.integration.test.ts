import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const children = new Set<ChildProcess>();
const cliPidFiles = new Set<string>();
const roots = new Set<string>();

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(check: () => boolean, logs: string[], timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolveSleep => setTimeout(resolveSleep, 25));
  }
  throw new Error(`Worker condition timed out\n${logs.join('')}`);
}

async function stopChildren(): Promise<void> {
  await Promise.all([...children].map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolveExit, rejectExit) => {
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 3_000);
      const deadline = setTimeout(() => {
        child.off('exit', onExit);
        rejectExit(new Error(`Worker ${child.pid} did not exit during fixture cleanup`));
      }, 8_000);
      const onExit = () => {
        clearTimeout(forceKill);
        clearTimeout(deadline);
        resolveExit();
      };
      child.once('exit', onExit);
      if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker, () => {});
      else child.kill('SIGTERM');
    });
  }));
  children.clear();
  const pids = [...cliPidFiles].filter(existsSync).map(file => Number(readFileSync(file, 'utf8')));
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (processAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ }
    }
  }
  await waitFor(() => pids.every(pid => !processAlive(pid)), ['Waiting for fake agy exit'], 5_000);
  cliPidFiles.clear();
}

afterEach(async () => {
  await stopChildren();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe('Antigravity worker background task turn authority (default send mode)', () => {
  it('keeps active turn authority across post-submit idle probe while a background run_command is running and releases it after completion', async () => {
    const sessionId = `agy-bg-auth-${randomUUID()}`;
    const root = mkdtempSync(join(tmpdir(), 'botmux-agy-bg-auth-'));
    roots.add(root);
    const dataDir = join(root, 'session');
    const cliHome = join(root, '.gemini', 'antigravity-cli');
    const nativeId = '33333333-4444-5555-6666-777777777777';
    const transcriptDir = join(cliHome, 'brain', nativeId, '.system_generated', 'logs');
    const transcriptPath = join(transcriptDir, 'transcript.jsonl');
    const historyPath = join(cliHome, 'history.jsonl');
    const cliPidFile = join(root, 'fake-cli.pid');
    const finishGate = join(root, 'finish-bg-task');
    cliPidFiles.add(cliPidFile);
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(transcriptDir, { recursive: true });

    const fakeCli = join(root, 'fake-agy');
    writeFileSync(fakeCli, `#!${tsRunnerPrefix().command}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('1.5.15'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(cliPidFile + '.tmp')}, String(process.pid));
fs.renameSync(${JSON.stringify(cliPidFile + '.tmp')}, ${JSON.stringify(cliPidFile)});
const args = process.argv.slice(2);
const logIdx = args.indexOf('--log-file');
if (logIdx >= 0) {
  const logFile = args[logIdx + 1];
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, 'I1124 03:14:51.000001 100 server.go:1] Streaming conversation ${nativeId}\\n');
}
const historyPath = ${JSON.stringify(historyPath)};
const transcriptPath = ${JSON.stringify(transcriptPath)};
const finishGate = ${JSON.stringify(finishGate)};
const nativeId = ${JSON.stringify(nativeId)};
const taskId = nativeId + '/task-178';
process.stdin.setRawMode?.(true);
const drawIdle = (body) => process.stdout.write('\\x1b[2J\\x1b[H' + body + '\\r\\n────────\\r\\n>\\r\\n────────\\r\\n? for shortcuts\\r\\n');
setTimeout(() => drawIdle('Antigravity ready'), 100);
let handled = false;
let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk.toString();
  if (handled || !buf.includes('BG_TASK_TURN_MARKER')) return;
  handled = true;
  fs.appendFileSync(historyPath, JSON.stringify({
    display: 'BG_TASK_TURN_MARKER', workspace: ${JSON.stringify(dataDir)}, timestamp: Date.now(),
  }) + '\\n');
  // Simulate a run_command moving to background + model emitting waiting narration,
  // then TUI returning to an idle composer without "esc to cancel".
  fs.writeFileSync(transcriptPath, [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\\nBG_TASK_TURN_MARKER\\n</USER_REQUEST>' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"bytedcli env service upgrade-tce"' } }] }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: 'Created At: 2026-11-24T03:15:07Z\\nTool is running as a background task with task id: ' + taskId + '\\nTask Description: bytedcli env service upgrade-tce\\n' }),
    JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '等待 BOE 与 PPE 升级工单下发返回结果。' }),
  ].join('\\n') + '\\n');
  drawIdle('等待 BOE 与 PPE 升级工单下发返回结果。');
  const pollFinish = () => {
    if (!fs.existsSync(finishGate)) { setTimeout(pollFinish, 30); return; }
    fs.appendFileSync(transcriptPath, [
      JSON.stringify({ step_index: 4, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '<SYSTEM_MESSAGE>\\n[Message] timestamp=2026-11-24T03:15:50Z sender=' + taskId + ' priority=MESSAGE_PRIORITY_HIGH content=Task id "' + taskId + '" finished with result: code 0\\n</SYSTEM_MESSAGE>' }),
      JSON.stringify({ step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'BOE 与 PPE 升级均已成功。' }),
    ].join('\\n') + '\\n');
    drawIdle('BOE 与 PPE 升级均已成功。');
  };
  pollFinish();
});
setInterval(() => {}, 1_000);
`);
    chmodSync(fakeCli, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
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
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    // Default replyDelivery=send mode (promptInjection omitted -> 'default', adoptMode omitted -> false):
    // structured bridge is INACTIVE for Antigravity in this mode.
    child.send({
      type: 'init',
      sessionId,
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'antigravity',
      cliPathOverride: fakeCli,
      backendType: 'pty',
      sandbox: false,
      prompt: '',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await waitFor(
      () => messages.some(m => m.type === 'prompt_ready')
        && messages.some(m => m.type === 'screen_update' && m.status === 'idle'),
      logs,
    );

    const turnId = 'om_bg_turn_1';
    const messageStartIndex = messages.length;
    child.send({
      type: 'message',
      content: 'BG_TASK_TURN_MARKER',
      turnId,
      caller: {
        requestUserOpenId: 'ou_tester',
        requestLarkAppId: 'app_test',
        senderType: 'user',
      },
    } satisfies DaemonToWorker);

    // Wait for the post-submit idle probe / ready check to observe the pending background task
    // and explicitly keep the session working rather than releasing turn authority.
    await waitFor(
      () => logs.join('').includes('Idle prompt while Antigravity background task(s)/subagent(s) pending'),
      logs,
    );

    const logTextWhileRunning = logs.join('');
    expect(logTextWhileRunning).not.toContain(`Released active turn authority ${turnId.slice(0, 12)}`);
    const postTurnMessages = messages.slice(messageStartIndex);
    const firstOriginIdx = postTurnMessages.findIndex(m => m.type === 'managed_turn_origin' && m.turnId === turnId);
    expect(firstOriginIdx, `Expected managed_turn_origin for ${turnId}`).toBeGreaterThanOrEqual(0);
    const originMessagesWhileRunning = postTurnMessages.filter(m => m.type === 'managed_turn_origin');
    expect(originMessagesWhileRunning[originMessagesWhileRunning.length - 1]).toMatchObject({
      type: 'managed_turn_origin',
      turnId,
    });
    const idleUpdatesAfterTurnStarted = postTurnMessages
      .slice(firstOriginIdx + 1)
      .filter(m => m.type === 'screen_update' && m.status === 'idle');
    expect(idleUpdatesAfterTurnStarted, `Unexpected idle screen_updates after turn started:\n${JSON.stringify(postTurnMessages, null, 2)}\nLogs:\n${logTextWhileRunning}`).toEqual([]);

    // Now complete the background task and emit the final planner response.
    writeFileSync(finishGate, 'done');

    await waitFor(
      () => logs.join('').includes(`Released active turn authority ${turnId.slice(0, 12)} (prompt_ready)`),
      logs,
    );
    await waitFor(
      () => messages.slice(messageStartIndex).some(m => m.type === 'screen_update' && m.status === 'idle'),
      logs,
    );
  }, 45_000);
});
