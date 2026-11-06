import { type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();
const cliPidDirs = new Set<string>();
// A normal close also stops the OS session scope. Concurrent test invocations
// must never share its identity.
const runId = randomUUID();

function writeFakeCli(file: string, script: string): string {
  const pidDir = `${file}.pids`;
  mkdirSync(pidDir);
  cliPidDirs.add(pidDir);
  // Record every invocation: Codex can start both a TUI and an app-server.
  const headerEnd = script.indexOf('\n') + 1;
  writeFileSync(file, script.slice(0, headerEnd)
    + `require('node:fs').writeFileSync(${JSON.stringify(pidDir)} + '/' + process.pid, '');\n`
    + script.slice(headerEnd));
  return pidDir;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitFor(
  predicate: () => boolean,
  logs: string[],
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error(`worker condition timed out\n${logs.join('')}`);
}

async function stopChildren(): Promise<void> {
  await Promise.all([...children].map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((done, reject) => {
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 3_000);
      const deadline = setTimeout(() => {
        child.off('exit', onExit);
        reject(new Error(`Worker ${child.pid} did not exit during fixture cleanup`));
      }, 8_000);
      const onExit = () => {
        clearTimeout(forceKill);
        clearTimeout(deadline);
        done();
      };
      child.once('exit', onExit);
      // Let the worker stop its watchers and PTY. Ignore only a concurrent IPC
      // disconnect; the exit deadline still detects a failed shutdown.
      if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker, () => {});
      else child.kill('SIGTERM');
    });
  }));
  children.clear();

  // PTYs have their own process group: killing the worker (or its group) does
  // not prove that its fake CLI stopped writing. Record all invocations and
  // reap only those fixture PIDs, including after an already-dead worker.
  const pids = [...cliPidDirs].filter(existsSync).flatMap(dir => readdirSync(dir).map(Number));
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Invalid fixture CLI PID: ${pid}`);
    if (processAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
  await waitFor(() => pids.every(pid => !processAlive(pid)), ['Waiting for fixture CLI processes to exit'], 5_000);
  cliPidDirs.clear();
}

afterEach(async () => {
  await stopChildren();
  for (const dir of tempDirs) {
    // Re-walk the tree after a transient race. Retrying just the final rmdir
    // cannot remove directory entries created after the original readdir.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== 'ENOTEMPTY' && code !== 'EBUSY')) throw error;
        await new Promise(done => setTimeout(done, 100));
      }
    }
  }
  tempDirs.clear();
});

describe('worker init fixture cleanup', () => {
  it.each([false, true])('stops the PTY writer before removing its home (worker already killed: %s)', async alreadyKilled => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-cleanup-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir);
    const request = join(root, 'write-request');
    const receipt = join(root, 'write-receipt');
    const fakeCli = join(root, 'fake-pi');
    const pidDir = writeFakeCli(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
// Keep the independent PTY process alive after its worker exits. A file
// handshake proves it can still create directory entries; no timing guess.
process.on('SIGHUP', () => {});
process.on('SIGTERM', () => {});
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(request)})) {
    fs.renameSync(${JSON.stringify(request)}, ${JSON.stringify(receipt)});
  }
}, 10);
`);
    chmodSync(fakeCli, 0o755);
    const sessionId = `worker-cleanup-${randomUUID()}`;
    const logs: string[] = [];
    const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env, HOME: root, SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: sessionId, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.send({
      type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root',
      workingDir: dataDir, cliId: 'pi', cliPathOverride: fakeCli, backendType: 'pty',
      prompt: '', larkAppId: 'app_test', larkAppSecret: 'secret',
    } satisfies DaemonToWorker);
    const writeReceipt = async (value: string) => {
      writeFileSync(request, value);
      await waitFor(() => existsSync(receipt) && readFileSync(receipt, 'utf8') === value, logs);
    };
    await writeReceipt('started');
    const cliPid = Number(readdirSync(pidDir)[0]);
    expect(Number.isSafeInteger(cliPid) && cliPid > 1).toBe(true);
    try {
      if (alreadyKilled) {
        const exited = new Promise<void>(done => child.once('exit', () => done()));
        child.kill('SIGKILL');
        await exited;
        await writeReceipt('writer survived worker exit');
      }
      expect(processAlive(cliPid)).toBe(true);
      await stopChildren();
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(processAlive(cliPid)).toBe(false);
      expect(existsSync(root)).toBe(true);
    } finally {
      // Keep a broken/mutated stopChildren implementation from leaking the
      // deliberately stubborn writer while demonstrating the regression.
      if (processAlive(cliPid)) process.kill(cliPid, 'SIGKILL');
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await waitFor(() => !processAlive(cliPid)
        && (child.exitCode !== null || child.signalCode !== null), logs);
    }
  }, 20_000);
});

describe('ordinary IM during real worker init', () => {
  it('queues a concurrent follow-up instead of rejecting it before cliAdapter is ready', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-init-concurrency-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });
    const fakePi = join(root, 'fake-pi');
    writeFakeCli(fakePi, `#!/usr/bin/env node
setTimeout(() => process.stdout.write('Ready\\n'), 500);
setInterval(() => {}, 1_000);
`);
    chmodSync(fakePi, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: `sid-worker-init-concurrency-${runId}`,
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.on('message', raw => {
      messages.push(raw as WorkerToDaemon);
      logs.push(`[ipc] ${JSON.stringify(raw)}\n`);
    });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    child.send({
      type: 'init',
      sessionId: `sid-worker-init-concurrency-${runId}`,
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'pi',
      cliPathOverride: fakePi,
      backendType: 'pty',
      prompt: 'initial turn',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      turnId: 'om_initial',
    } satisfies DaemonToWorker);
    child.send({
      type: 'message',
      content: 'follow-up during init',
      turnId: 'om_followup',
    } satisfies DaemonToWorker);

    await waitFor(() => messages.some(message =>
      message.type === 'turn_input_committed' && message.turnId === 'om_followup'), logs);
    await waitFor(() => messages.some(message =>
      message.type === 'turn_input_committed' && message.turnId === 'om_initial'), logs);

    expect(messages).toEqual(expect.arrayContaining([
      { type: 'turn_input_received', turnId: 'om_initial' },
      { type: 'turn_input_received', turnId: 'om_followup' },
      { type: 'turn_input_committed', turnId: 'om_initial' },
      { type: 'turn_input_committed', turnId: 'om_followup' },
    ]));
    expect(messages).not.toContainEqual(expect.objectContaining({
      type: 'turn_input_rejected',
      turnId: 'om_followup',
    }));
  }, 15_000);

  // 跨身份隔离（XPI）现在由实验开关控制且默认关闭，所以这条用例必须显式打开它
  // ——它锁的正是「开关打开时」的拒绝行为。关闭态的镜像用例紧随其后。
  it('rejects a different principal at the worker backstop before type-ahead can steer it (XPI on)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-principal-queue-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });
    const inputLog = join(root, 'stdin.log');
    const fakePi = join(root, 'fake-pi');
    writeFakeCli(fakePi, `#!/usr/bin/env node
const fs = require('node:fs');
const inputLog = process.env.FAKE_INPUT_LOG;
let firstSeen = false;
let firstDone = false;
let secondSeen = false;
setTimeout(() => process.stdout.write('Ready\\n'), 100);
process.stdin.on('data', chunk => {
  const text = chunk.toString();
  fs.appendFileSync(inputLog, text);
  if (!firstSeen && text.includes('PRINCIPAL_A_MARKER')) {
    firstSeen = true;
    fs.appendFileSync(inputLog, '\\nA_SEEN\\n');
    process.stdout.write('Working...\\n');
    setTimeout(() => {
      firstDone = true;
      fs.appendFileSync(inputLog, '\\nA_DONE\\n');
      process.stdout.write('\\x1b[2J\\x1b[HReady\\n');
    }, 500);
  }
  if (!secondSeen && text.includes('PRINCIPAL_B_MARKER')) {
    secondSeen = true;
    fs.appendFileSync(inputLog, firstDone ? '\\nB_AFTER_A\\n' : '\\nB_BEFORE_A\\n');
  }
});
setInterval(() => {}, 1_000);
`);
    chmodSync(fakePi, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: `sid-worker-principal-queue-${runId}`,
        BOTMUX_XPI_ENABLED: 'true',
        BOTMUX_TIME_SCALE: '0.05',
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'secret',
        FAKE_INPUT_LOG: inputLog,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.on('message', raw => {
      messages.push(raw as WorkerToDaemon);
      logs.push(`[ipc] ${JSON.stringify(raw)}\n`);
    });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    child.send({
      type: 'init',
      sessionId: `sid-worker-principal-queue-${runId}`,
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'pi',
      cliPathOverride: fakePi,
      backendType: 'pty',
      prompt: '',
      env: { FAKE_INPUT_LOG: inputLog },
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await waitFor(() => messages.some(message => message.type === 'ready'), logs);

    child.send({
      type: 'message',
      content: 'PRINCIPAL_A_MARKER',
      turnId: 'om_principal_a',
      trustedCaller: {
        requestUserOpenId: 'ou_a',
        requestUserUnionId: 'on_a',
        requestLarkAppId: 'app_test',
        senderType: 'user',
      },
    } satisfies DaemonToWorker);
    await waitFor(() => existsSync(inputLog)
      && readFileSync(inputLog, 'utf8').includes('A_SEEN'), logs);

    child.send({
      type: 'message',
      content: 'PRINCIPAL_B_MARKER',
      turnId: 'om_principal_b',
      trustedCaller: {
        requestUserOpenId: 'ou_b',
        requestUserUnionId: 'on_b',
        requestLarkAppId: 'app_test',
        senderType: 'user',
      },
      rerouteEnvelope: {
        turnId: 'om_principal_b',
        text: 'PRINCIPAL_B_MARKER',
        userPrompt: 'PRINCIPAL_B_MARKER',
        createdAt: new Date().toISOString(),
      },
    } satisfies DaemonToWorker);

    child.send({
      type: 'message',
      content: 'PRINCIPAL_BOT_MARKER',
      turnId: 'om_principal_bot',
      trustedCaller: {
        requestUserOpenId: 'ou_bot_b',
        requestUserUnionId: 'on_bot_b',
        requestLarkAppId: 'app_test',
        senderType: 'bot',
      },
      rerouteEnvelope: {
        turnId: 'om_principal_bot',
        text: 'PRINCIPAL_BOT_MARKER',
        userPrompt: 'PRINCIPAL_BOT_MARKER',
        createdAt: new Date().toISOString(),
      },
    } satisfies DaemonToWorker);

    await waitFor(() => messages.some(message =>
      message.type === 'turn_input_rejected' && message.turnId === 'om_principal_b'), logs);
    await waitFor(() => messages.some(message =>
      message.type === 'turn_input_rejected' && message.turnId === 'om_principal_bot'), logs);
    await waitFor(() => existsSync(inputLog)
      && readFileSync(inputLog, 'utf8').includes('A_DONE'), logs);
    const input = readFileSync(inputLog, 'utf8');
    expect(input).not.toContain('B_BEFORE_A');
    expect(input).not.toContain('PRINCIPAL_B_MARKER');
    expect(input).not.toContain('PRINCIPAL_BOT_MARKER');
    const rejected = messages.filter(message => message.type === 'turn_input_rejected');
    expect(rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({
      type: 'turn_input_rejected',
      turnId: 'om_principal_b',
      reason: 'cross_principal_requires_owner_confirmation',
      rejectedBeforeAdmission: true,
      activeTurnId: 'om_principal_a',
    }),
      expect.objectContaining({
        type: 'turn_input_rejected',
        turnId: 'om_principal_bot',
        reason: 'cross_principal_requires_owner_confirmation',
        rejectedBeforeAdmission: true,
        activeTurnId: 'om_principal_a',
      }),
    ]));
    expect(rejected.filter(message => message.turnId === 'om_principal_b')).toHaveLength(1);
    expect(rejected.filter(message => message.turnId === 'om_principal_bot')).toHaveLength(1);

    await waitFor(() => messages.some(message =>
      message.type === 'managed_turn_origin_revoked' && message.turnId === 'om_principal_a'), logs);
    child.send({
      type: 'message',
      content: 'PRINCIPAL_B_MARKER_AFTER_A',
      turnId: 'om_principal_b_after_a',
      trustedCaller: {
        requestUserOpenId: 'ou_b',
        requestUserUnionId: 'on_b',
        requestLarkAppId: 'app_test',
        senderType: 'user',
      },
    } satisfies DaemonToWorker);
    await waitFor(() => readFileSync(inputLog, 'utf8').includes('B_AFTER_A'), logs);
    await waitFor(() => messages.some(message =>
      message.type === 'turn_input_committed' && message.turnId === 'om_principal_b_after_a'), logs);
  }, 20_000);

  // 关闭态镜像：这是「整体关掉」真正要保证的行为——第二个身份的消息不再被拦成
  // turn_input_rejected，而是像该特性上线（#1348）之前那样直接送达 CLI。
  // 断言的是送达本身（stdin 里出现 marker + turn_input_committed），不是「没有拒绝」；
  // 纯否定断言在 worker 起不来时也会通过，那种绿是空的。
  it('delivers a different principal instead of rejecting it when the XPI switch is off', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-principal-xpi-off-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });
    const inputLog = join(root, 'stdin.log');
    const fakePi = join(root, 'fake-pi');
    writeFakeCli(fakePi, `#!/usr/bin/env node
const fs = require('node:fs');
const inputLog = process.env.FAKE_INPUT_LOG;
let firstSeen = false;
setTimeout(() => process.stdout.write('Ready\\n'), 100);
process.stdin.on('data', chunk => {
  const text = chunk.toString();
  fs.appendFileSync(inputLog, text);
  if (!firstSeen && text.includes('PRINCIPAL_A_MARKER')) {
    firstSeen = true;
    fs.appendFileSync(inputLog, '\\nA_SEEN\\n');
    process.stdout.write('Working...\\n');
    setTimeout(() => {
      fs.appendFileSync(inputLog, '\\nA_DONE\\n');
      process.stdout.write('\\x1b[2J\\x1b[HReady\\n');
    }, 500);
  }
});
setInterval(() => {}, 1_000);
`);
    chmodSync(fakePi, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: `sid-worker-principal-xpi-off-${runId}`,
        // The switch under test. Set explicitly so the case does not depend on
        // the ambient default staying off.
        BOTMUX_XPI_ENABLED: 'false',
        BOTMUX_TIME_SCALE: '0.05',
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'secret',
        FAKE_INPUT_LOG: inputLog,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.on('message', raw => {
      messages.push(raw as WorkerToDaemon);
      logs.push(`[ipc] ${JSON.stringify(raw)}\n`);
    });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    child.send({
      type: 'init',
      sessionId: `sid-worker-principal-xpi-off-${runId}`,
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'pi',
      cliPathOverride: fakePi,
      backendType: 'pty',
      prompt: '',
      env: { FAKE_INPUT_LOG: inputLog },
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
    } satisfies DaemonToWorker);

    await waitFor(() => messages.some(message => message.type === 'ready'), logs);

    // Principal A takes the active turn first.
    child.send({
      type: 'message',
      content: 'PRINCIPAL_A_MARKER',
      turnId: 'om_principal_a',
      trustedCaller: {
        requestUserOpenId: 'ou_a',
        requestUserUnionId: 'on_a',
        requestLarkAppId: 'app_test',
        senderType: 'user',
      },
    } satisfies DaemonToWorker);
    await waitFor(() => existsSync(inputLog)
      && readFileSync(inputLog, 'utf8').includes('A_SEEN'), logs);

    // A DIFFERENT principal interrupts while A still owns the active turn.
    child.send({
      type: 'message',
      content: 'PRINCIPAL_B_MARKER',
      turnId: 'om_principal_b',
      trustedCaller: {
        requestUserOpenId: 'ou_b',
        requestUserUnionId: 'on_b',
        requestLarkAppId: 'app_test',
        senderType: 'user',
      },
      rerouteEnvelope: {
        turnId: 'om_principal_b',
        text: 'PRINCIPAL_B_MARKER',
        userPrompt: 'PRINCIPAL_B_MARKER',
        createdAt: new Date().toISOString(),
      },
    } satisfies DaemonToWorker);

    // Positive assertion: it reaches the CLI and commits.
    await waitFor(() => existsSync(inputLog)
      && readFileSync(inputLog, 'utf8').includes('PRINCIPAL_B_MARKER'), logs);
    await waitFor(() => messages.some(message =>
      message.type === 'turn_input_committed' && message.turnId === 'om_principal_b'), logs);

    // And nothing was rejected on cross-principal grounds.
    expect(messages.filter(message =>
      message.type === 'turn_input_rejected'
      && (message as { reason?: string }).reason === 'cross_principal_requires_owner_confirmation',
    )).toEqual([]);
  }, 20_000);

  it('holds a non-argv follow-up until the initial prompt owns the queue head', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-init-order-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });
    const inputLog = join(root, 'stdin.log');
    const fakeCodex = join(root, 'fake-codex');
    writeFakeCli(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('app-server')) {
  setInterval(() => {}, 1_000);
} else {
  let initialTurnCompleted = false;
  let observedInput = '';
  setTimeout(() => process.stdout.write('›\\n'), 200);
  process.stdin.on('data', chunk => {
    fs.appendFileSync(process.env.FAKE_INPUT_LOG, chunk);
    observedInput += chunk.toString();
    if (!initialTurnCompleted && observedInput.includes('INITIAL_ORDER_MARKER')) {
      initialTurnCompleted = true;
      setTimeout(() => process.stdout.write('›\\n'), 50);
    }
  });
  setInterval(() => {}, 1_000);
}
`);
    chmodSync(fakeCodex, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: `sid-worker-init-order-${runId}`,
        // Keep the real 7s title-metadata await that opens the race window,
        // but collapse Codex's unrelated history.jsonl submit polling so this
        // ordering probe stays deterministic under full-suite contention.
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

    child.send({
      type: 'init',
      sessionId: `sid-worker-init-order-${runId}`,
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'codex',
      cliPathOverride: fakeCodex,
      backendType: 'pty',
      prompt: 'INITIAL_ORDER_MARKER',
      resume: true,
      cliSessionId: 'thread-existing',
      nativeSessionTitle: 'Existing title',
      env: { FAKE_INPUT_LOG: inputLog },
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      turnId: 'om_initial_order',
    } satisfies DaemonToWorker);
    child.send({
      type: 'message',
      content: 'FOLLOWUP_ORDER_MARKER',
      turnId: 'om_followup_order',
    } satisfies DaemonToWorker);

    await waitFor(() => {
      if (!existsSync(inputLog)) return false;
      const input = readFileSync(inputLog, 'utf8');
      return input.includes('INITIAL_ORDER_MARKER') && input.includes('FOLLOWUP_ORDER_MARKER');
    }, logs, 14_000);

    const input = readFileSync(inputLog, 'utf8');
    expect(input.indexOf('INITIAL_ORDER_MARKER')).toBeLessThan(input.indexOf('FOLLOWUP_ORDER_MARKER'));
    expect(messages).not.toContainEqual(expect.objectContaining({
      type: 'turn_input_rejected',
      turnId: 'om_followup_order',
    }));
  }, 20_000);

  it('acknowledges an OpenCode argv activation token without a dispatch attempt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-opencode-argv-activation-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    const xdgDataDir = join(root, 'xdg');
    const dbDir = join(xdgDataDir, 'opencode');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(dbDir, { recursive: true });
    const prompt = `<session_id>sid-opencode-activation-${runId}</session_id>\n<user_message>OPEN_CODE_TOKEN_ONLY</user_message>`;
    const db = new DatabaseSync(join(dbDir, 'opencode.db'));
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)')
      .run('ses_activation', null, dataDir, '', 1, 1, null);
    const initialBaseline = Date.now();
    db.prepare('INSERT INTO message VALUES (?,?,?,?)')
      .run('msg_before', 'ses_activation', initialBaseline, JSON.stringify({ role: 'user' }));
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?)')
      .run('part_before', 'msg_before', 'ses_activation', initialBaseline, JSON.stringify({ type: 'text', text: 'before' }));
    db.close();

    const fakeOpenCode = join(root, 'fake-opencode');
    writeFakeCli(fakeOpenCode, `#!/usr/bin/env node
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const args = process.argv.slice(2);
const prompt = args[args.indexOf('--prompt') + 1];
const db = new DatabaseSync(process.env.OPENCODE_DB_PATH);
const now = Date.now();
db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('msg_user', 'ses_activation', now, JSON.stringify({ role: 'user' }));
db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('part_user', 'msg_user', 'ses_activation', now, JSON.stringify({ type: 'text', text: prompt }));
setInterval(() => {}, 1_000);
`);
    chmodSync(fakeOpenCode, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        XDG_DATA_HOME: xdgDataDir,
        OPENCODE_DB_PATH: join(dbDir, 'opencode.db'),
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: `sid-opencode-activation-${runId}`,
        // This starts a real Node process: shrinking the 2.4s confirmation
        // window to 120ms races its SQLite write, then the 20s deferred
        // recheck falls outside this test's 8s acknowledgement deadline.
        BOTMUX_TIME_SCALE: '1',
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.on('message', raw => {
      messages.push(raw as WorkerToDaemon);
      logs.push(`[ipc] ${JSON.stringify(raw)}\n`);
    });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    child.send({
      type: 'init',
      sessionId: `sid-opencode-activation-${runId}`,
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'opencode',
      cliPathOverride: fakeOpenCode,
      backendType: 'pty',
      prompt,
      queuedActivationToken: 'opencode-token-only',
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      turnId: 'om_opencode_initial',
    } satisfies DaemonToWorker);

    await waitFor(() => messages.some(message =>
      message.type === 'queued_activation_submitted'
      && message.activationToken === 'opencode-token-only'), logs, 8_000);

    expect(messages).toContainEqual({
      type: 'queued_activation_submitted',
      sessionId: `sid-opencode-activation-${runId}`,
      activationToken: 'opencode-token-only',
    });
  }, 12_000);

  it('renames a TraeX native session only after the submitted first turn completes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-traex-native-title-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    const traeHome = join(root, 'trae-home');
    const inputLog = join(root, 'stdin.log');
    const nativeSessionId = '00000000-0000-7000-8000-000000000187';
    const rolloutDir = join(traeHome, 'cli', 'sessions', '2026', '10', '13');
    const rolloutPath = join(rolloutDir, `rollout-2026-10-13T00-00-00-${nativeSessionId}.jsonl`);
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(rolloutPath, '');
    const firstPrompt = '<botmux_routing>hidden</botmux_routing>\n<user_message>@TestBot 排查标题问题</user_message>';
    const fakeTraex = join(root, 'fake-traex');
    writeFakeCli(fakeTraex, `#!/usr/bin/env node
const fs = require('node:fs');
const inputLog = ${JSON.stringify(inputLog)};
const historyPath = ${JSON.stringify(join(traeHome, 'cli', 'history.jsonl'))};
const sessionId = ${JSON.stringify(nativeSessionId)};
const rolloutFd = fs.openSync(${JSON.stringify(rolloutPath)}, 'a');
const firstPrompt = ${JSON.stringify(firstPrompt)};
let submittedFirstPrompt = false;
process.on('uncaughtException', error => {
  fs.appendFileSync(inputLog, 'ERR:' + (error && error.stack || error) + '\\n');
  process.exit(42);
});
function submitHistory(text) {
  fs.appendFileSync(inputLog, text + '\\n---SUBMIT---\\n');
  fs.appendFileSync(historyPath, JSON.stringify({ session_id: sessionId, ts: Date.now(), text }) + '\\n');
  fs.writeSync(rolloutFd, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg',
    payload: { type: 'user_message', message: text, turn_id: 'native_initial' } }) + '\\n');
  setTimeout(() => process.stdout.write('›\\n'), 50);
}
setTimeout(() => process.stdout.write('›\\n'), 200);
process.stdin.on('data', chunk => {
  const text = chunk.toString();
  fs.appendFileSync(inputLog, text);
  if (!submittedFirstPrompt && text.includes('<user_message>@TestBot 排查标题问题</user_message>')) {
    submittedFirstPrompt = true;
    submitHistory(firstPrompt);
  }
  if (text.includes('/rename [BotMux·Lark] 排查标题问题')) {
    setTimeout(() => process.stdout.write('›\\n'), 50);
  }
});
setInterval(() => {}, 1_000);
`);
    chmodSync(fakeTraex, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        TRAE_HOME: traeHome,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: `sid-traex-native-title-${runId}`,
        BOTMUX_TIME_SCALE: '0.05',
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.on('message', raw => {
      messages.push(raw as WorkerToDaemon);
      logs.push(`[ipc] ${JSON.stringify(raw)}\n`);
    });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    child.send({
      type: 'init',
      sessionId: `sid-traex-native-title-${runId}`,
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'traex',
      cliPathOverride: fakeTraex,
      backendType: 'pty',
      prompt: firstPrompt,
      nativeSessionTitle: '[BotMux·Lark] 排查标题问题',
      nativeSessionTitlePrompt: '排查标题问题',
      queuedActivationToken: 'activation-title-token',
      env: { FAKE_INPUT_LOG: inputLog, TRAE_HOME: traeHome },
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      turnId: 'om_initial',
    } satisfies DaemonToWorker);

    await waitFor(() => {
      if (!existsSync(inputLog)) return false;
      const input = readFileSync(inputLog, 'utf8');
      return input.includes('<user_message>@TestBot 排查标题问题</user_message>')
        && messages.some(message => message.type === 'queued_activation_submitted')
        && logs.some(line => line.includes('Ignoring prompt-ready heuristic while a structured turn is unfinished'));
    }, logs, 14_000);

    // 提交记录和空闲画面都不是回合结束；改名必须等待真实终止事件。
    expect(readFileSync(inputLog, 'utf8')).not.toContain('/rename [BotMux·Lark] 排查标题问题');
    appendFileSync(rolloutPath, JSON.stringify({
      timestamp: new Date().toISOString(), type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'native_initial', last_agent_message: 'done' },
    }) + '\n');
    await waitFor(() => readFileSync(inputLog, 'utf8').includes('/rename [BotMux·Lark] 排查标题问题'), logs);

    const input = readFileSync(inputLog, 'utf8');
    expect(input).toContain('<botmux_routing>hidden</botmux_routing>');
    expect(input.indexOf('<user_message>@TestBot 排查标题问题</user_message>'))
      .toBeLessThan(input.indexOf('/rename [BotMux·Lark] 排查标题问题'));
    expect(messages).toContainEqual({
      type: 'queued_activation_submitted',
      sessionId: `sid-traex-native-title-${runId}`,
      activationToken: 'activation-title-token',
    });
    expect(messages).toContainEqual({ type: 'turn_input_committed', turnId: 'om_initial' });
    expect(messages).not.toContainEqual(expect.objectContaining({
      type: 'turn_input_rejected',
      turnId: 'om_initial',
    }));
  }, 20_000);

  it('does not rename a TraeX native session when the tagged prompt is not submitted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-traex-native-title-fail-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    const traeHome = join(root, 'trae-home');
    const inputLog = join(root, 'stdin.log');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(traeHome, 'cli'), { recursive: true });
    const firstPrompt = '<botmux_routing>hidden</botmux_routing>\n<user_message>@TestBot 排查失败提交</user_message>';
    const fakeTraex = join(root, 'fake-traex-fail');
    writeFakeCli(fakeTraex, `#!/usr/bin/env node
const fs = require('node:fs');
const inputLog = ${JSON.stringify(inputLog)};
setTimeout(() => process.stdout.write('›\\n'), 200);
process.stdin.on('data', chunk => {
  const text = chunk.toString();
  fs.appendFileSync(inputLog, text);
  if (text.includes('<user_message>@TestBot 排查失败提交</user_message>')) {
    setTimeout(() => process.stdout.write('›\\n'), 50);
    setTimeout(() => process.stdout.write('›\\n'), 1000);
  }
  if (text.includes('/rename [BotMux·Lark] 排查失败提交')) {
    setTimeout(() => process.stdout.write('›\\n'), 50);
  }
});
setInterval(() => {}, 1_000);
`);
    chmodSync(fakeTraex, 0o755);

    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: root,
        TRAE_HOME: traeHome,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: `sid-traex-native-title-fail-${runId}`,
        BOTMUX_TIME_SCALE: '0.05',
        LARK_APP_ID: 'app_test',
        LARK_APP_SECRET: 'secret',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.on('message', raw => {
      messages.push(raw as WorkerToDaemon);
      logs.push(`[ipc] ${JSON.stringify(raw)}\n`);
    });
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));

    child.send({
      type: 'init',
      sessionId: `sid-traex-native-title-fail-${runId}`,
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      workingDir: dataDir,
      cliId: 'traex',
      cliPathOverride: fakeTraex,
      backendType: 'pty',
      prompt: firstPrompt,
      nativeSessionTitle: '[BotMux·Lark] 排查失败提交',
      nativeSessionTitlePrompt: '排查失败提交',
      env: { FAKE_INPUT_LOG: inputLog, TRAE_HOME: traeHome },
      larkAppId: 'app_test',
      larkAppSecret: 'secret',
      turnId: 'om_initial_fail',
    } satisfies DaemonToWorker);

    await waitFor(() => {
      if (!existsSync(inputLog)) return false;
      return readFileSync(inputLog, 'utf8').includes('<user_message>@TestBot 排查失败提交</user_message>');
    }, logs, 10_000);

    child.send({
      type: 'message',
      content: '<user_message>后续消息不应抢走标题</user_message>',
      turnId: 'om_followup_after_failed_submit',
    } satisfies DaemonToWorker);

    await new Promise(resolve => setTimeout(resolve, 5_000));

    const input = readFileSync(inputLog, 'utf8');
    expect(input).toContain('<user_message>@TestBot 排查失败提交</user_message>');
    expect(input).not.toContain('/rename [BotMux·Lark] 排查失败提交');
    expect(messages).toContainEqual({ type: 'turn_input_committed', turnId: 'om_initial_fail' });
    expect(messages).not.toContainEqual(expect.objectContaining({
      type: 'turn_input_rejected',
      turnId: 'om_initial_fail',
    }));
  }, 20_000);
});
