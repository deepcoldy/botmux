import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

let child: ChildProcess | undefined;
let root: string | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise<void>(done => child!.once('exit', () => done()));
    if (child.connected) child.send({ type: 'close' } satisfies DaemonToWorker);
    await Promise.race([stopped, new Promise<void>(done => setTimeout(done, 2_000))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await stopped;
    }
  }
  child = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function waitUntil(check: () => boolean, logs: string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (check()) return;
    if (child?.exitCode !== null || child?.signalCode !== null) throw new Error(`Worker exited\n${logs.join('')}`);
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error(`Timed out\n${logs.join('')}`);
}

describe('Grok worker public activity', () => {
  it.each([false, true])('publishes narration and readable tool results before the terminal (singleBatch=%s)', async singleBatch => {
    root = mkdtempSync(join(tmpdir(), 'botmux-worker-grok-'));
    const dataDir = join(root, 'data');
    const grokHome = join(root, '.grok');
    const sessionId = randomUUID();
    const cliSessionId = randomUUID();
    const sessionDir = join(grokHome, 'sessions', encodeURIComponent(dataDir), cliSessionId);
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    const transcript = join(sessionDir, 'updates.jsonl');
    writeFileSync(transcript, '');
    const fakeGrok = join(root, 'fake-grok');
    // The real worker/adapter/bridge run against a synthetic ACP transcript;
    // only the provider executable is replaced, with no model/network call.
    writeFileSync(fakeGrok, `#!/usr/bin/env node
process.stdout.write('Working...\\n❯');
process.stdin.resume();
setInterval(() => {}, 1000);
`);
    chmodSync(fakeGrok, 0o755);
    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
      cwd: resolve('.'),
      env: { ...process.env, HOME: root, GROK_HOME: grokHome, SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: sessionId, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', raw => messages.push(raw as WorkerToDaemon));
    child.stdout?.on('data', chunk => logs.push(chunk.toString()));
    child.stderr?.on('data', chunk => logs.push(chunk.toString()));
    child.send({
      type: 'init', sessionId, chatId: 'oc_test', rootMessageId: 'om_root', workingDir: dataDir,
      cliId: 'grok', cliPathOverride: fakeGrok, cliSessionId, backendType: 'pty',
      prompt: 'inspect the entry point', larkAppId: 'app_test', larkAppSecret: 'test-only', turnId: 'om_grok_turn',
    } satisfies DaemonToWorker);
    await waitUntil(() => logs.some(line => line.includes('Codex bridge fresh-empty:')), logs);
    const append = (...updates: object[]) => appendFileSync(transcript, updates.map(update => JSON.stringify({
      method: 'session/update', params: { sessionId: cliSessionId, update }, timestamp: Date.now(),
    })).join('\n') + '\n');
    const start = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'inspect the entry point' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reading src/main.ts' } },
      { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read', rawInput: { target_file: 'src/main.ts' } },
    ];
    const finish = [
      { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed',
        rawOutput: { output: [{ type: 'text', text: 'export const ready = true;' }], exit_code: 0 },
        content: [{ type: 'content', content: { type: 'text', text: 'export const ready = true;' } }] },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE_THOUGHT' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Entry point inspected.' } },
      { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' },
    ];
    append(...start, ...(singleBatch ? finish : []));
    await waitUntil(() => messages.some(msg => msg.type === 'thinking_update'), logs);
    if (!singleBatch) expect(messages.some(msg => msg.type === 'turn_terminal')).toBe(false);
    const first = messages.find(msg => msg.type === 'thinking_update');
    expect(first?.turnId).toBe('om_grok_turn');
    expect(first?.entries.slice(0, 2)).toMatchObject([
      { kind: 'text', text: 'Reading src/main.ts' },
      { kind: 'tool_call', id: 'read-1', subject: 'src/main.ts' },
    ]);
    if (!singleBatch) append(...finish);
    await waitUntil(() => messages.some(msg => msg.type === 'turn_terminal'), logs);
    const updates = messages.filter(msg => msg.type === 'thinking_update');
    expect(updates.at(-1)?.entries.at(-1)).toEqual({
      kind: 'tool_result', id: 'read-1', result: 'export const ready = true;',
    });
    expect(messages.indexOf(updates.at(-1)!)).toBeLessThan(messages.findIndex(msg => msg.type === 'turn_terminal'));
    expect(messages.filter(msg => msg.type === 'turn_terminal')).toMatchObject([
      { turnId: 'om_grok_turn', status: 'completed' },
    ]);
    expect(messages.filter(msg => msg.type === 'final_output')).toMatchObject([
      { turnId: 'om_grok_turn', content: 'Entry point inspected.' },
    ]);
    expect(JSON.stringify(updates)).not.toContain('PRIVATE_THOUGHT');
  }, 30_000);
});
