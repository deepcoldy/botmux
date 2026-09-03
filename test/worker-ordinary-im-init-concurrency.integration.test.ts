import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();

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

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe('ordinary IM during real worker init', () => {
  it('queues a concurrent follow-up instead of rejecting it before cliAdapter is ready', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-init-concurrency-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });
    const fakePi = join(root, 'fake-pi');
    writeFileSync(fakePi, `#!/usr/bin/env node
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
        BOTMUX_SESSION_ID: 'sid-worker-init-concurrency',
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
      sessionId: 'sid-worker-init-concurrency',
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

  it('holds a non-argv follow-up until the initial prompt owns the queue head', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-init-order-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });
    const inputLog = join(root, 'stdin.log');
    const fakeCodex = join(root, 'fake-codex');
    writeFileSync(fakeCodex, `#!/usr/bin/env node
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
        BOTMUX_SESSION_ID: 'sid-worker-init-order',
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
      sessionId: 'sid-worker-init-order',
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

  it('renames a TraeX native session only after the first Lark prompt is submitted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-traex-native-title-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    const traeHome = join(root, 'trae-home');
    const inputLog = join(root, 'stdin.log');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(traeHome, 'cli'), { recursive: true });
    const firstPrompt = '<botmux_routing>hidden</botmux_routing>\n<user_message>@TestBot 排查标题问题</user_message>';
    const fakeTraex = join(root, 'fake-traex');
    writeFileSync(fakeTraex, `#!/usr/bin/env node
const fs = require('node:fs');
const inputLog = ${JSON.stringify(inputLog)};
const historyPath = ${JSON.stringify(join(traeHome, 'cli', 'history.jsonl'))};
const firstPrompt = ${JSON.stringify(firstPrompt)};
let submittedFirstPrompt = false;
process.on('uncaughtException', error => {
  fs.appendFileSync(inputLog, 'ERR:' + (error && error.stack || error) + '\\n');
  process.exit(42);
});
function submitHistory(text) {
  fs.appendFileSync(inputLog, text + '\\n---SUBMIT---\\n');
  fs.appendFileSync(historyPath, JSON.stringify({ session_id: 'traex-native-title', ts: Date.now(), text }) + '\\n');
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
        BOTMUX_SESSION_ID: 'sid-traex-native-title',
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
      sessionId: 'sid-traex-native-title',
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
        && input.includes('/rename [BotMux·Lark] 排查标题问题')
        && messages.some(message => message.type === 'queued_activation_submitted');
    }, logs, 14_000);

    const input = readFileSync(inputLog, 'utf8');
    expect(input).toContain('<botmux_routing>hidden</botmux_routing>');
    expect(input.indexOf('<user_message>@TestBot 排查标题问题</user_message>'))
      .toBeLessThan(input.indexOf('/rename [BotMux·Lark] 排查标题问题'));
    expect(messages).toContainEqual({
      type: 'queued_activation_submitted',
      sessionId: 'sid-traex-native-title',
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
    writeFileSync(fakeTraex, `#!/usr/bin/env node
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
        BOTMUX_SESSION_ID: 'sid-traex-native-title-fail',
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
      sessionId: 'sid-traex-native-title-fail',
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
