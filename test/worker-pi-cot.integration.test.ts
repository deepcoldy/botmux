import { execFileSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

// Run the real worker and render its IPC through the real CoT pump. Only the
// provider executable and network transport are replaced; no paid model call.
interface CotRequest {
  method: string;
  url: string;
  data?: { events?: Array<{ event_type: string; content: string }> };
}
const request = vi.fn(async (req: CotRequest) =>
  req.method === 'POST'
    ? { code: 0, data: { cot_id: 'cot_pi', message_id: 'om_pi_bubble' } }
    : { code: 0, data: {} });
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: { cotEnabled: true } }),
  getBotClient: () => ({ request }),
}));
import { finalizeCotMessage, handleCotThinkingUpdate, handleCotThinkingSuperseded } from '../src/im/lark/cot-message.js';
import type { DaemonSession } from '../src/core/types.js';
import { PI_TURN_BOUNDARY_CUSTOM_TYPE } from '../src/adapters/cli/pi-turn-boundary-extension.js';

let child: ChildProcess | undefined;
let root: string | undefined;
let tmuxSession: string | undefined;
const tmuxAvailable = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise<void>(done => child!.once('exit', () => done()));
    child.kill('SIGKILL');
    await Promise.race([stopped, new Promise<void>(done => setTimeout(done, 2_000))]);
  }
  child = undefined;
  if (tmuxSession) {
    try { execFileSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'ignore' }); } catch { /* already stopped */ }
  }
  tmuxSession = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  request.mockClear();
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

describe('Pi worker activity bubble', () => {
  for (const { backendType, singleBatch } of [
    { backendType: 'pty', singleBatch: false },
    { backendType: 'tmux', singleBatch: false },
    { backendType: 'pty', singleBatch: true },
  ] as const) {
    it.skipIf(backendType === 'tmux' && !tmuxAvailable)(`streams tools before completion and settles the bubble (${backendType}, singleBatch=${singleBatch})`, async () => {
      root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-cot-'));
      const dataDir = join(root, 'data');
      mkdirSync(dataDir, { recursive: true });
      const cliSessionId = 'deadbeef-1234-4678-9abc-def012345679';
      const piSessionsDir = join(root, '.pi', 'agent', 'sessions', dataDir.replace(/\//g, '--'));
      mkdirSync(piSessionsDir, { recursive: true });
      const transcript = join(piSessionsDir, `20260929120000_${cliSessionId}.jsonl`);
      writeFileSync(transcript, '');
      const fakePi = join(root, 'fake-pi');
      const completeFlag = join(root, 'complete');
      writeFileSync(fakePi, `#!/usr/bin/env node
const fs = require('node:fs');
process.stdout.write('Working...\\n');
let completed = false;
setInterval(() => {
  if (!completed && fs.existsSync(${JSON.stringify(completeFlag)})) {
    completed = true;
    process.stdout.write('\\x1b[2J\\x1b[HDone\\n');
  }
}, 20);
`);
      chmodSync(fakePi, 0o755);
      const messages: WorkerToDaemon[] = [];
      const logs: string[] = [];
      const ds = {
        larkAppId: 'app_test', chatId: 'oc_test',
        session: { sessionId: 'sid-pi-cot', rootMessageId: 'om_root' },
      } as DaemonSession;
      child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
        cwd: resolve('.'),
        env: {
          ...process.env, HOME: root, SESSION_DATA_DIR: dataDir,
          BOTMUX_SESSION_ID: 'sid-pi-cot', LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      child.on('message', raw => {
        const msg = raw as WorkerToDaemon;
        messages.push(msg);
        if (msg.type === 'thinking_update') handleCotThinkingUpdate(ds, msg);
        if (msg.type === 'thinking_superseded') handleCotThinkingSuperseded(ds, msg);
        if (msg.type === 'turn_terminal') finalizeCotMessage(ds, msg.turnId, msg.status);
      });
      child.stdout?.on('data', chunk => logs.push(chunk.toString()));
      child.stderr?.on('data', chunk => logs.push(chunk.toString()));
      if (backendType === 'tmux') tmuxSession = `pi-cot-${process.pid}-${Date.now()}`;
      child.send({
        type: 'init', sessionId: 'sid-pi-cot', chatId: 'oc_test', rootMessageId: 'om_root',
        workingDir: dataDir, cliId: 'pi', cliPathOverride: fakePi, cliSessionId,
        backendType, ...(tmuxSession ? { tmuxSessionName: tmuxSession } : {}),
        prompt: 'inspect the entry point', larkAppId: 'app_test', larkAppSecret: 'test-only',
        turnId: 'om_pi_turn',
      } satisfies DaemonToWorker);
      await waitUntil(() => logs.some(line => line.includes('Codex bridge fresh-empty:')), logs);
      const append = (...rows: object[]) => appendFileSync(transcript, rows.map(message => JSON.stringify({
        type: 'message', timestamp: new Date().toISOString(), message,
      })).join('\n') + '\n');
      const start = [
        { role: 'user', content: [{ type: 'text', text: 'inspect the entry point' }] },
        { role: 'assistant', stopReason: 'toolUse', content: [
          { type: 'text', text: 'Reading src/main.ts' },
          { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/main.ts' } },
        ] },
      ];
      const finish = [
        { role: 'toolResult', toolCallId: 'read-1', content: [{ type: 'text', text: 'export const ready = true;' }] },
        { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Entry point inspected.' }] },
      ];
      if (singleBatch) {
        writeFileSync(completeFlag, 'done');
        append(...start, ...finish);
      } else {
        append(...start);
      }
      await waitUntil(() => messages.some(msg => msg.type === 'thinking_update'), logs);
      if (!singleBatch) expect(messages.some(msg => msg.type === 'turn_terminal')).toBe(false);
      const first = messages.find(msg => msg.type === 'thinking_update');
      expect(first?.turnId).toBe('om_pi_turn');
      expect(first?.entries.slice(0, 2)).toMatchObject([
          { kind: 'text', text: 'Reading src/main.ts' },
          { kind: 'tool_call', id: 'read-1', subject: 'src/main.ts' },
      ]);
      // Arrive within the throttle window: the final update must be flushed
      // before turn_terminal, otherwise RESULT is lost or a bubble stays open.
      if (!singleBatch) {
        writeFileSync(completeFlag, 'done');
        append(...finish);
      }
      await waitUntil(() => messages.some(msg => msg.type === 'turn_terminal'), logs);
      const updates = messages.filter(msg => msg.type === 'thinking_update');
      expect(updates.at(-1)?.entries.at(-1)).toEqual({
        kind: 'tool_result', id: 'read-1', result: 'export const ready = true;',
      });
      const terminalIndex = messages.findIndex(msg => msg.type === 'turn_terminal');
      expect(messages.indexOf(updates.at(-1)!)).toBeLessThan(terminalIndex);
      expect(messages.filter(msg => msg.type === 'final_output')).toMatchObject([
        { turnId: 'om_pi_turn', content: 'Entry point inspected.' },
      ]);
      const events = () => request.mock.calls.flatMap(([req]) => req.data?.events ?? []);
      await waitUntil(() => events().some(event => event.event_type === 'RUN_FINISHED'), logs);
      expect(request.mock.calls.filter(([req]) => req.method === 'POST')).toHaveLength(1);
      expect(events().filter(event => event.event_type === 'TOOL_CALL_START')).toHaveLength(1);
      expect(events().filter(event => event.event_type === 'TOOL_CALL_RESULT')).toHaveLength(1);
      expect(events().filter(event => event.event_type === 'RUN_FINISHED')).toHaveLength(1);
    }, 30_000);
  }

  for (const { backendType, stopReason, status } of [
    { backendType: 'pty', stopReason: 'stop', status: 'completed' },
    { backendType: 'tmux', stopReason: 'stop', status: 'completed' },
    { backendType: 'pty', stopReason: 'error', status: 'failed' },
    { backendType: 'pty', stopReason: 'aborted', status: 'ambiguous' },
  ] as const) {
    it.skipIf(backendType === 'tmux' && !tmuxAvailable)(`closes a steered-away bubble even when the successor has no CoT (${backendType}, ${stopReason})`, async () => {
      root = mkdtempSync(join(tmpdir(), 'botmux-worker-pi-cot-steer-'));
      const dataDir = join(root, 'data');
      const cliSessionId = 'deadbeef-1234-4678-9abc-def012345679';
      const piSessionsDir = join(root, '.pi', 'agent', 'sessions', dataDir.replace(/\//g, '--'));
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(piSessionsDir, { recursive: true });
      const transcript = join(piSessionsDir, `20260929_${cliSessionId}.jsonl`);
      writeFileSync(transcript, '');
      const fakePi = join(root, 'fake-pi');
      writeFileSync(fakePi, `#!/usr/bin/env node
process.stdout.write('Done\\n');
process.stdin.resume();
setInterval(() => {}, 1000);
`);
      chmodSync(fakePi, 0o755);
      const messages: WorkerToDaemon[] = [];
      const logs: string[] = [];
      const ds = {
        larkAppId: 'app_test', chatId: 'oc_test',
        session: { sessionId: 'sid-pi-steer', rootMessageId: 'om_root' },
      } as DaemonSession;
      child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
        cwd: resolve('.'),
        env: { ...process.env, HOME: root, SESSION_DATA_DIR: dataDir,
          BOTMUX_SESSION_ID: 'sid-pi-steer', LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      child.on('message', raw => {
        const msg = raw as WorkerToDaemon;
        messages.push(msg);
        if (msg.type === 'thinking_update') handleCotThinkingUpdate(ds, msg);
        if (msg.type === 'thinking_superseded') handleCotThinkingSuperseded(ds, msg);
        if (msg.type === 'turn_terminal') finalizeCotMessage(ds, msg.turnId, msg.status);
      });
      child.stdout?.on('data', chunk => logs.push(chunk.toString()));
      child.stderr?.on('data', chunk => logs.push(chunk.toString()));
      if (backendType === 'tmux') tmuxSession = `pi-steer-${process.pid}-${Date.now()}`;
      child.send({
        type: 'init', sessionId: 'sid-pi-steer', chatId: 'oc_test', rootMessageId: 'om_root',
        workingDir: dataDir, cliId: 'pi', cliPathOverride: fakePi, cliSessionId, backendType,
        ...(tmuxSession ? { tmuxSessionName: tmuxSession } : {}),
        prompt: 'warmup', larkAppId: 'app_test', larkAppSecret: 'test-only', turnId: 'om_warmup',
      } satisfies DaemonToWorker);
      await waitUntil(() => logs.some(line => line.includes('Codex bridge fresh-empty:')), logs);
      const append = (...rows: object[]) => appendFileSync(transcript, rows.map(message => JSON.stringify({
        type: 'message', timestamp: new Date().toISOString(), message,
      })).join('\n') + '\n');
      const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
      append(user('warmup'), { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'ready' }] });
      await waitUntil(() => messages.some(msg => msg.type === 'prompt_ready')
        && messages.some(msg => msg.type === 'turn_terminal' && msg.turnId === 'om_warmup'), logs);
      child.send({ type: 'message', content: 'first request', turnId: 'om_first' } satisfies DaemonToWorker);
      await waitUntil(() => logs.some(line => line.includes('Writing to PTY (flush): "first request')), logs);
      append(user('first request'), { role: 'assistant', stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'src/main.ts' } },
      ] });
      await waitUntil(() => messages.some(msg => msg.type === 'thinking_update' && msg.turnId === 'om_first'), logs);
      child.send({ type: 'message', content: 'steer request', turnId: 'om_steer' } satisfies DaemonToWorker);
      await waitUntil(() => logs.some(line => line.includes('Writing to PTY (flush): "steer request')), logs);
      append({ role: 'toolResult', toolCallId: 'read-1', content: [{ type: 'text', text: 'result' }] }, user('steer request'));

      // The old bubble must end at the confirmed steer, before B produces
      // anything at all. Closing the UI must not synthesize a task terminal.
      const events = () => request.mock.calls.flatMap(([req]) => req.data?.events ?? []);
      await waitUntil(() => events().some(event => event.event_type === 'RUN_FINISHED'), logs);
      const activity = messages.filter((msg): msg is Extract<WorkerToDaemon, { type: 'thinking_update' }> =>
        msg.type === 'thinking_update' && msg.turnId === 'om_first');
      const superseded = messages.filter(msg => msg.type === 'thinking_superseded');
      expect(superseded).toMatchObject([{ turnId: 'om_first', sessionId: 'sid-pi-steer' }]);
      expect(activity.at(-1)?.entries.at(-1)).toEqual({ kind: 'tool_result', id: 'read-1', result: 'result' });
      expect(messages.indexOf(activity.at(-1)!)).toBeLessThan(messages.indexOf(superseded[0]));
      expect(messages.filter(msg => msg.type === 'turn_terminal' && msg.turnId !== 'om_warmup')).toEqual([]);

      append({ role: 'assistant', stopReason,
        content: stopReason === 'stop' ? [{ type: 'text', text: 'final answer' }] : [],
        ...(stopReason === 'error' ? { errorMessage: 'service unavailable' } : {}),
      });
      if (stopReason === 'error') appendFileSync(transcript, JSON.stringify({
        type: 'custom', timestamp: new Date().toISOString(), customType: PI_TURN_BOUNDARY_CUSTOM_TYPE,
        data: { lastStopReason: 'error' },
      }) + '\n');
      await waitUntil(() => messages.some(msg => msg.type === 'turn_terminal' && msg.turnId === 'om_steer'), logs);
      // Let the old trailing throttle expire: no late update may reopen A.
      await new Promise(done => setTimeout(done, 1600));
      expect(messages.filter(msg => msg.type === 'turn_terminal' && msg.turnId === 'om_first')).toEqual([]);
      expect(messages.filter(msg => msg.type === 'turn_terminal' && msg.turnId === 'om_steer')).toMatchObject([{ status }]);
      expect(messages.filter(msg => msg.type === 'thinking_update' && msg.turnId === 'om_steer')).toEqual([]);
      expect(messages.filter(msg => msg.type === 'thinking_update' && msg.turnId === 'om_first')).toHaveLength(activity.length);
      const wireEvents = events();
      expect(wireEvents.filter(event => event.event_type === 'RUN_STARTED')).toHaveLength(1);
      expect(wireEvents.filter(event => event.event_type === 'RUN_FINISHED')).toHaveLength(1);
      expect(wireEvents.findIndex(event => event.event_type === 'TOOL_CALL_RESULT'))
        .toBeLessThan(wireEvents.findIndex(event => event.event_type === 'RUN_FINISHED'));
    }, 30_000);
  }
});
