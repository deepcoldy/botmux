import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

  it('rejects a different principal at the worker backstop before type-ahead can steer it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-worker-principal-queue-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    mkdirSync(dataDir, { recursive: true });
    const inputLog = join(root, 'stdin.log');
    const fakePi = join(root, 'fake-pi');
    writeFileSync(fakePi, `#!/usr/bin/env node
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
        BOTMUX_SESSION_ID: 'sid-worker-principal-queue',
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
      sessionId: 'sid-worker-principal-queue',
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

  it('acknowledges an OpenCode argv activation token without a dispatch attempt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-opencode-argv-activation-'));
    tempDirs.add(root);
    const dataDir = join(root, 'session');
    const xdgDataDir = join(root, 'xdg');
    const dbDir = join(xdgDataDir, 'opencode');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(dbDir, { recursive: true });
    const prompt = '<session_id>sid-opencode-activation</session_id>\n<user_message>OPEN_CODE_TOKEN_ONLY</user_message>';
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
    writeFileSync(fakeOpenCode, `#!/usr/bin/env node
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
        BOTMUX_SESSION_ID: 'sid-opencode-activation',
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
      sessionId: 'sid-opencode-activation',
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
      sessionId: 'sid-opencode-activation',
      activationToken: 'opencode-token-only',
    });
  }, 12_000);

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
