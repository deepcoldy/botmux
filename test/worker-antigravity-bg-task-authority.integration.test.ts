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
    const mixedFinishGate = join(root, 'finish-mixed-bg-task');
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
const mixedFinishGate = ${JSON.stringify(mixedFinishGate)};
const nativeId = ${JSON.stringify(nativeId)};
const taskId = nativeId + '/task-178';
const extraTurns = {
  MULTI_RECOVERY_TURN_MARKER: {
    body: '两个后台任务仍在运行，read_file 不应释放。',
    records: [
      { step_index: 20, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\\nMULTI_RECOVERY_TURN_MARKER\\n</USER_REQUEST>' },
      { step_index: 21, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: 'Tool is running as a background task with task id: ' + nativeId + '/task-foreground-1\\nTask Description: cmd-1\\n' },
      { step_index: 22, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: 'Tool is running as a background task with task id: ' + nativeId + '/task-foreground-2\\nTask Description: cmd-2\\n' },
      { step_index: 46, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { path: 'README.md' } }] },
      { step_index: 47, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '两个后台任务仍在运行，read_file 不应释放。' },
    ],
  },
  LATE_DAEMON_TURN_MARKER: {
    body: '乱序普通任务仍在运行，all-daemon 不应吞掉它。',
    records: [
      { step_index: 50, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\\nLATE_DAEMON_TURN_MARKER\\n</USER_REQUEST>' },
      { step_index: 51, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }] },
      { step_index: 53, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', IsDaemon: true } }] },
      { step_index: 52, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: 'Tool is running as a background task with task id: ' + nativeId + '/task-late-ordinary\\nTask Description: npm test\\n' },
      { step_index: 54, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: 'Tool is running as a background task with task id: ' + nativeId + '/task-late-daemon\\nTask Description: npm test\\n' },
      { step_index: 55, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '乱序普通任务仍在运行，all-daemon 不应吞掉它。' },
    ],
  },
  ANON_DAEMON_TURN_MARKER: {
    body: 'daemon 通知已到达，匿名普通任务仍在运行。',
    records: [
      { step_index: 70, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\\nANON_DAEMON_TURN_MARKER\\n</USER_REQUEST>' },
      { step_index: 71, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: 'Tool is running as a background task\\nTask Description: anonymous-command\\n' },
      { step_index: 72, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'schedule', args: { CronExpression: '*/5 * * * *', IsDaemon: true, Prompt: '巡检' } }] },
      { step_index: 73, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: 'Tool is running as a background task with task id: ' + nativeId + '/task-anon-daemon\\nTask Description: Cron: */5 * * * *\\n' },
      { step_index: 74, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '等待匿名普通任务。' },
      { step_index: 75, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '<SYSTEM_MESSAGE>\\n[Message] sender=' + nativeId + '/task-anon-daemon content=Task id "' + nativeId + '/task-anon-daemon" finished with result: code 0\\n</SYSTEM_MESSAGE>' },
      { step_index: 76, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'daemon 通知已到达，匿名普通任务仍在运行。' },
    ],
  },
};
const handledExtraTurns = new Set();
process.stdin.setRawMode?.(true);
const drawIdle = (body) => process.stdout.write('\\x1b[2J\\x1b[H' + body + '\\r\\n────────\\r\\n>\\r\\n────────\\r\\n? for shortcuts\\r\\n');
setTimeout(() => drawIdle('Antigravity ready'), 100);
let handled = false;
let mixedHandled = false;
let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk.toString();
  if (!handled && buf.includes('BG_TASK_TURN_MARKER')) {
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
  }
  if (!mixedHandled && buf.includes('MIXED_DAEMON_TURN_MARKER')) {
    mixedHandled = true;
    fs.appendFileSync(historyPath, JSON.stringify({
      display: 'MIXED_DAEMON_TURN_MARKER', workspace: ${JSON.stringify(dataDir)}, timestamp: Date.now(),
    }) + '\\n');
    // A compact/truncated description must not make the ordinary sibling look
    // like the daemon. Both RUNNING records are deliberately ambiguous.
    fs.appendFileSync(transcriptPath, [
      JSON.stringify({ step_index: 10, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\\nMIXED_DAEMON_TURN_MARKER\\n</USER_REQUEST>' }),
      JSON.stringify({ step_index: 11, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [
        { name: 'run_command', args: { CommandLine: 'npm test', IsDaemon: true } },
        { name: 'run_command', args: { CommandLine: 'npm test -- --watch' } },
      ] }),
      JSON.stringify({ step_index: 12, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: 'Created At: 2026-11-24T03:16:07Z\\nTool is running as a background task with task id: ' + nativeId + '/task-daemon\\nTask Description: npm test\\n' }),
      JSON.stringify({ step_index: 13, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: 'Created At: 2026-11-24T03:16:08Z\\nTool is running as a background task with task id: ' + nativeId + '/task-ordinary\\nTask Description: npm test -- --watch\\n' }),
      JSON.stringify({ step_index: 14, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '等待普通后台任务完成。' }),
    ].join('\\n') + '\\n');
    drawIdle('等待普通后台任务完成。');
    const pollMixedFinish = () => {
      if (!fs.existsSync(mixedFinishGate)) { setTimeout(pollMixedFinish, 30); return; }
      const ordinaryTaskId = nativeId + '/task-ordinary';
      fs.appendFileSync(transcriptPath, [
        JSON.stringify({ step_index: 15, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '<SYSTEM_MESSAGE>\\n[Message] timestamp=2026-11-24T03:16:50Z sender=' + ordinaryTaskId + ' priority=MESSAGE_PRIORITY_HIGH content=Task id "' + ordinaryTaskId + '" finished with result: code 0\\n</SYSTEM_MESSAGE>' }),
        JSON.stringify({ step_index: 16, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '普通任务已完成，常驻任务继续运行。' }),
      ].join('\\n') + '\\n');
      drawIdle('普通任务已完成，常驻任务继续运行。');
    };
    pollMixedFinish();
  }
  for (const [marker, scenario] of Object.entries(extraTurns)) {
    if (handledExtraTurns.has(marker) || !buf.includes(marker)) continue;
    handledExtraTurns.add(marker);
    fs.appendFileSync(historyPath, JSON.stringify({
      display: marker, workspace: ${JSON.stringify(dataDir)}, timestamp: Date.now(),
    }) + '\\n');
    fs.appendFileSync(transcriptPath, scenario.records.map(record => JSON.stringify(record)).join('\\n') + '\\n');
    drawIdle(scenario.body);
  }
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

    // A second live turn exercises the mixed-batch collision in the same real
    // worker. The ordinary sibling remains RUNNING: no authority release,
    // origin revocation, or idle projection is allowed before its completion.
    const mixedTurnId = 'om_bg_turn_mixed_daemon';
    const mixedMessageStartIndex = messages.length;
    const mixedLogStart = logs.join('').length;
    child.send({
      type: 'message',
      content: 'MIXED_DAEMON_TURN_MARKER',
      turnId: mixedTurnId,
      caller: {
        requestUserOpenId: 'ou_tester',
        requestLarkAppId: 'app_test',
        senderType: 'user',
      },
    } satisfies DaemonToWorker);

    await waitFor(
      () => logs.join('').slice(mixedLogStart).includes('Idle prompt while Antigravity background task(s)/subagent(s) pending')
        && messages.slice(mixedMessageStartIndex).some(m => m.type === 'managed_turn_origin' && m.turnId === mixedTurnId),
      logs,
    );
    const mixedLogs = logs.join('').slice(mixedLogStart);
    expect(mixedLogs).not.toContain(`Released active turn authority ${mixedTurnId.slice(0, 12)}`);
    const mixedMessages = messages.slice(mixedMessageStartIndex);
    const mixedOriginIdx = mixedMessages.findIndex(m => m.type === 'managed_turn_origin' && m.turnId === mixedTurnId);
    expect(mixedOriginIdx).toBeGreaterThanOrEqual(0);
    expect(mixedMessages.filter(m => m.type === 'managed_turn_origin_revoked' && m.turnId === mixedTurnId)).toEqual([]);
    expect(mixedMessages.slice(mixedOriginIdx + 1).filter(m => m.type === 'screen_update' && m.status === 'idle')).toEqual([]);

    // Once the ordinary sibling completes, the standing daemon must not keep
    // the finished turn latched: authority and origin are released and the
    // final planner response projects idle.
    writeFileSync(mixedFinishGate, 'done');
    await waitFor(
      () => logs.join('').slice(mixedLogStart).includes(`Released active turn authority ${mixedTurnId.slice(0, 12)} (prompt_ready)`),
      logs,
    );
    await waitFor(
      () => messages.slice(mixedMessageStartIndex).some(m => m.type === 'managed_turn_origin_revoked' && m.turnId === mixedTurnId)
        && messages.slice(mixedMessageStartIndex).some(m => m.type === 'screen_update' && m.status === 'idle'),
      logs,
    );

    const assertTurnHeld = async (turnId: string, marker: string) => {
      const messageStart = messages.length;
      const logStart = logs.join('').length;
      child.send({
        type: 'message',
        content: marker,
        turnId,
        caller: {
          requestUserOpenId: 'ou_tester',
          requestLarkAppId: 'app_test',
          senderType: 'user',
        },
      } satisfies DaemonToWorker);
      await waitFor(
        () => logs.join('').slice(logStart).includes('Idle prompt while Antigravity background task(s)/subagent(s) pending')
          && messages.slice(messageStart).some(m => m.type === 'managed_turn_origin' && m.turnId === turnId),
        logs,
      );
      expect(logs.join('').slice(logStart)).not.toContain(`Released active turn authority ${turnId.slice(0, 12)}`);
      const current = messages.slice(messageStart);
      const originIndex = current.findIndex(m => m.type === 'managed_turn_origin' && m.turnId === turnId);
      expect(originIndex).toBeGreaterThanOrEqual(0);
      expect(current.filter(m => m.type === 'managed_turn_origin_revoked' && m.turnId === turnId)).toEqual([]);
      expect(current.slice(originIndex + 1).filter(m => m.type === 'screen_update' && m.status === 'idle')).toEqual([]);
    };

    await assertTurnHeld('om_bg_turn_multi_recovery', 'MULTI_RECOVERY_TURN_MARKER');
    await assertTurnHeld('om_bg_turn_late_daemon', 'LATE_DAEMON_TURN_MARKER');
    await assertTurnHeld('om_bg_turn_anon_daemon', 'ANON_DAEMON_TURN_MARKER');
  }, 90_000);
});
