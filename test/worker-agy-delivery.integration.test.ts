import { type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

const children = new Set<ChildProcess>();
const roots = new Set<string>();

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

async function waitFor(check: () => boolean, logs: string[], timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Worker condition timed out\n${logs.join('')}`);
}

function startWorker(mode: 'delayed' | 'interrupted' | 'manual', cliId: 'antigravity' | 'traex' = 'antigravity') {
  const root = mkdtempSync(join(tmpdir(), 'botmux-agy-delivery-'));
  roots.add(root);
  const dataDir = join(root, 'session');
  const cliHome = join(root, '.gemini', 'antigravity-cli');
  const nativeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const transcriptDir = join(cliHome, 'brain', nativeId, '.system_generated', 'logs');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(transcriptDir, { recursive: true });
  const inputLog = join(root, 'input.log');
  const history = cliId === 'antigravity'
    ? join(cliHome, 'history.jsonl') : join(root, '.trae', 'cli', 'history.jsonl');
  mkdirSync(join(history, '..'), { recursive: true });
  if (mode === 'interrupted') {
    writeFileSync(join(transcriptDir, 'transcript.jsonl'), JSON.stringify({
      type: 'GENERIC', status: 'DONE', content: 'tool completed',
    }) + '\n');
  }
  const ready = cliId === 'antigravity' ? '? for shortcuts' : '›';
  const screen = mode === 'interrupted'
    ? '  ⎿  Interrupted · What should Antigravity CLI do instead?\n────────\n>\n────────\n? for shortcuts\n'
    : ready + '\n';
  const fakeCli = join(root, 'fake-cli');
  writeFileSync(fakeCli, `#!${tsRunnerPrefix().command}
const fs = require('node:fs');
const inputLog = ${JSON.stringify(inputLog)};
const history = ${JSON.stringify(history)};
const ready = ${JSON.stringify(ready)};
const screen = ${JSON.stringify(screen)};
const delayed = ${mode === 'delayed'};
const manual = ${mode === 'manual'};
process.stdin.setRawMode?.(true);
setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[H' + screen), 150);
process.stdin.on('data', chunk => {
  const text = chunk.toString();
  fs.appendFileSync(inputLog, text);
  for (const marker of ['ACTIVATION_UNIQUE_MARKER', 'FOLLOWUP_UNIQUE_MARKER']) {
    if (!text.includes(marker)) continue;
    if (!manual) setTimeout(() => {
      const row = ${JSON.stringify(cliId)} === 'antigravity'
        ? { display: marker, workspace: ${JSON.stringify(dataDir)}, timestamp: Date.now() }
        : { text: marker, session_id: ${JSON.stringify(nativeId)}, ts: Date.now() };
      fs.appendFileSync(history, JSON.stringify(row) + '\\n');
    }, delayed ? 9_000 : 0);
    // Force several idle edges before the delayed receipt appears. Re-enqueueing
    // the activation on a false submit result used to paste the whole input again.
    for (const ms of [1_000, 4_000, 7_000]) {
      setTimeout(() => process.stdout.write('\\x1b[2J\\x1b[H' + ready + '\\n'), ms);
    }
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
      TRAE_HOME: join(root, '.trae'),
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: 'sid-agy-delivery',
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
    type: 'init', sessionId: 'sid-agy-delivery', chatId: 'oc_test', rootMessageId: 'om_root',
    workingDir: dataDir, cliId, cliPathOverride: fakeCli, backendType: 'pty',
    cliSessionId: nativeId,
    prompt: mode !== 'interrupted' ? 'ACTIVATION_UNIQUE_MARKER' : '',
    ...(mode !== 'interrupted' ? { queuedActivationToken: 'activation-token', turnId: 'om_initial' } : {}),
    larkAppId: 'app_test', larkAppSecret: 'secret',
  } satisfies DaemonToWorker);
  return {
    child, messages, logs,
    recordReceipt: () => writeFileSync(history, JSON.stringify({
      display: 'ACTIVATION_UNIQUE_MARKER', workspace: dataDir, timestamp: Date.now(),
    }) + '\n'),
    input: () => existsSync(inputLog) ? readFileSync(inputLog, 'utf8') : '',
  };
}

describe('worker delayed activation and interrupted Antigravity delivery', () => {
  it.each(['antigravity', 'traex'] as const)('%s writes a slow activation once and acknowledges its deferred receipt', async cliId => {
    const worker = startWorker('delayed', cliId);
    await waitFor(() => worker.input().includes('ACTIVATION_UNIQUE_MARKER'), worker.logs);
    await new Promise(resolve => setTimeout(resolve, 10_000));
    expect(worker.input().match(/ACTIVATION_UNIQUE_MARKER/g)).toHaveLength(1);
    await waitFor(() => worker.messages.some(m => m.type === 'queued_activation_submitted'), worker.logs, 20_000);
    expect(worker.messages.filter(m => m.type === 'queued_activation_submitted')).toEqual([{
      type: 'queued_activation_submitted', sessionId: 'sid-agy-delivery', activationToken: 'activation-token',
    }]);
    expect(worker.input().match(/ACTIVATION_UNIQUE_MARKER/g)).toHaveLength(1);
    expect(worker.messages.some(m => m.type === 'user_notify')).toBe(false);
  }, 45_000);

  it('delivers a follow-up from the interrupted empty composer despite a stale tool-result transcript', async () => {
    const worker = startWorker('interrupted');
    await waitFor(() => worker.messages.some(m => m.type === 'ready'), worker.logs);
    worker.child.send({ type: 'message', content: 'FOLLOWUP_UNIQUE_MARKER', turnId: 'om_followup' } satisfies DaemonToWorker);
    await waitFor(() => worker.input().includes('FOLLOWUP_UNIQUE_MARKER'), worker.logs);
    expect(worker.input().match(/FOLLOWUP_UNIQUE_MARKER/g)).toHaveLength(1);
  }, 20_000);

  it('acknowledges a manual terminal submission after the warning chain has ended without writing again', async () => {
    const worker = startWorker('manual');
    await waitFor(() => worker.messages.some(m => m.type === 'user_notify'), worker.logs, 65_000);
    const warning = worker.messages.find(m => m.type === 'user_notify');
    expect(warning?.type === 'user_notify' ? warning.message : '').toMatch(/首条消息|Opening message/);
    expect(warning?.type === 'user_notify' ? warning.message : '').toMatch(/关闭该会话|close this session/);
    const originalInput = worker.input();
    worker.recordReceipt();
    await waitFor(() => worker.messages.some(m => m.type === 'queued_activation_submitted'), worker.logs, 25_000);
    expect(worker.messages.filter(m => m.type === 'queued_activation_submitted')).toEqual([{
      type: 'queued_activation_submitted', sessionId: 'sid-agy-delivery', activationToken: 'activation-token',
    }]);
    expect(worker.messages.filter(m => m.type === 'user_notify')).toHaveLength(1);
    expect(originalInput.match(/ACTIVATION_UNIQUE_MARKER/g)).toHaveLength(1);
    expect(worker.input()).toBe(originalInput);
  }, 100_000);
});
