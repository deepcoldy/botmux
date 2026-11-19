import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

// Real worker, fake Claude Code, pty backend (never the host tmux server).
//
// The killed-mid-turn shape: the fake accepts a prompt, writes only the user
// transcript record, then redraws the idle prompt without EVER writing an
// assistant terminal (no stop_reason record, no API-error record, no
// turn_duration). The frozen screen still matches the worker's idle detector,
// so the bridge pops the turn at a screen-idle boundary. The worker must label
// that terminal outputDisposition:'boundary_unobserved' — a bare `completed`
// here would leave a headless async trigger polling `running` forever.

const cotRequest = vi.fn(async (req: { method: string; url: string }) =>
  req.method === 'POST'
    ? { code: 0, data: { cot_id: 'cot_claude', message_id: 'om_cot_bubble' } }
    : { code: 0, data: {} });

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(),
  getChatInfo: vi.fn(),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {
    constructor(id: string) { super(`withdrawn: ${id}`); this.name = 'MessageWithdrawnError'; }
  },
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({
    config: { larkAppId: 'app_test', larkAppSecret: 'secret', cliId: 'claude-code', cotEnabled: true },
    resolvedAllowedUsers: [],
    botOpenId: 'ou_bot',
    botName: 'TestBot',
  })),
  getAllBots: vi.fn(() => []),
  getOwnerOpenId: vi.fn(() => undefined),
  getBotClient: vi.fn(() => ({ request: cotRequest })),
  getBotBrand: vi.fn(() => undefined),
  resolveBrandLabel: vi.fn(() => undefined),
  resolveUsageDisplay: vi.fn(() => 'footer'),
}));

vi.mock('../src/services/session-store.js', () => ({
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
  closeSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  updateSessionPid: vi.fn(),
}));

// The async-trigger sink persists a failed terminal; keep it off the disk.
const recordTerminalFailureStrict = vi.fn(() => 'written_failed');
vi.mock('../src/services/async-trigger-store.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/async-trigger-store.js')>()),
  recordTerminalFailureStrict: (...args: unknown[]) => recordTerminalFailureStrict(...(args as [])),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

let child: ChildProcess | undefined;
let root: string | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise<void>(done => child!.once('exit', () => done()));
    child.kill('SIGKILL');
    await Promise.race([stopped, new Promise<void>(done => setTimeout(done, 2_000))]);
  }
  child = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
  recordTerminalFailureStrict.mockClear();
});

async function waitUntil(check: () => boolean, logs: string[], timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    if (child?.exitCode !== null || child?.signalCode !== null) throw new Error(`Worker exited\n${logs.join('')}`);
    await new Promise(done => setTimeout(done, 25));
  }
  throw new Error(`Timed out\n${logs.join('')}`);
}

type Row = Record<string, unknown>;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const zeroUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const answerText: Row = {
  type: 'assistant', uuid: 'a-text',
  message: { id: 'm1', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', usage: { ...zeroUsage, output_tokens: 40 },
    content: [{ type: 'text', text: 'The review is posted.' }] },
};
const partialAnswerNoStopReason: Row = {
  type: 'assistant', uuid: 'a-partial',
  message: { id: 'm-partial', role: 'assistant', model: 'claude-test', stop_reason: null, usage: { ...zeroUsage, output_tokens: 18 },
    content: [{ type: 'text', text: 'Partial answer before exit.' }] },
};
const turnDuration: Row = { type: 'system', subtype: 'turn_duration', uuid: 'd1', durationMs: 3_000 };

/**
 * Start a real worker backed by a fake Claude Code.
 * `beforePrompt` rows are written by the fake ~300ms after it accepts a line,
 * i.e. BEFORE it redraws the idle prompt:
 *  - [] reproduces the killed-mid-turn shape (only the user row, no terminal);
 *  - [answer, duration] is the positive control: a normally finished turn whose
 *    terminal must carry NO boundary label.
 */
function startWorker(opts: { beforePrompt: Row[] }) {
  root = mkdtempSync(join(tmpdir(), 'botmux-unobserved-boundary-'));
  const workDir = join(root, 'work');
  const dataDir = join(root, 'data');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const cliSessionId = 'deadbeef-1234-4678-9abc-def012345692';
  const projectDir = join(root, '.claude', 'projects', realpathSync(workDir).replace(/[^A-Za-z0-9-]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${cliSessionId}.jsonl`);
  const history: Row[] = [
    { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: cliSessionId },
    { type: 'user', uuid: 'p0', timestamp: minutesAgo(30), message: { role: 'user', content: 'hi' } },
    { type: 'assistant', uuid: 'a0', timestamp: minutesAgo(30), message: { id: 'm0', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] } },
    { type: 'system', subtype: 'turn_duration', uuid: 'd0', timestamp: minutesAgo(30) },
  ];
  writeFileSync(transcript, history.map(row => `${JSON.stringify(row)}\n`).join(''));
  const fakeClaude = join(root, 'fake-claude');
  writeFileSync(fakeClaude, `#!/usr/bin/env node
import('node:fs').then(fs => {
const T = ${JSON.stringify(transcript)};
const BEFORE_PROMPT = ${JSON.stringify(opts.beforePrompt)};
const put = row => fs.appendFileSync(T, JSON.stringify({ timestamp: new Date().toISOString(), ...row }) + '\\n');
process.stdout.write('❯ ');
let typed = '';
process.stdin.on('data', chunk => {
  typed += chunk.toString();
  if (!/[\\r\\n]$/.test(typed)) return;
  if (typed.includes('\\x1b[200~') && !typed.includes('\\x1b[201~')) return;
  const prompt = typed.replace(/\\x1b\\[20[01]~/g, '').trim();
  typed = '';
  put({ type: 'user', uuid: 'u1', message: { role: 'user', content: prompt } });
  setTimeout(() => { for (const row of BEFORE_PROMPT) put(row); }, 300);
  setTimeout(() => process.stdout.write('\\r\\n❯ '), 1500);
});
});
`);
  chmodSync(fakeClaude, 0o755);
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  // Fixed sid prefix plus UUID: the launch/stop unit name must not collide with
  // another concurrent run of this file on the same host.
  const sid = `sid-unobserved-boundary-${randomUUID()}`;
  child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env, HOME: root, SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: sid, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.send({
    type: 'init', sessionId: sid, chatId: 'oc_test', rootMessageId: 'om_root',
    workingDir: workDir, cliId: 'claude-code', cliPathOverride: fakeClaude, cliSessionId,
    backendType: 'pty', prompt: '', resume: true, larkAppId: 'app_test', larkAppSecret: 'test-only', locale: 'zh',
  } satisfies DaemonToWorker);
  return { sid, transcript, messages, logs };
}

/** Send one Lark turn, wait for the idle edge that follows it, then return the
 *  worker's IPC from that send onward. */
async function runTurn(w: ReturnType<typeof startWorker>, turnId: string): Promise<WorkerToDaemon[]> {
  await waitUntil(() => w.messages.some(msg => msg.type === 'prompt_ready'), w.logs);
  const idleEdges = () => w.logs.join('').split('Prompt detected (idle)').length - 1;
  const edgesBefore = idleEdges();
  const fromIndex = w.messages.length;
  child!.send({ type: 'message', content: 'please re-review PR 3575', turnId } satisfies DaemonToWorker);
  await waitUntil(() => idleEdges() > edgesBefore, w.logs);
  const turnMessages = () => w.messages.slice(fromIndex);
  await waitUntil(
    () => turnMessages().some(msg => msg.type === 'turn_terminal' && msg.turnId === turnId),
    w.logs,
  );
  // Anything still in flight for the same turn lands within a few polls.
  await new Promise(done => setTimeout(done, 1_500));
  return turnMessages();
}

const terminalsOf = (messages: WorkerToDaemon[], turnId: string) =>
  messages.filter((msg): msg is Extract<WorkerToDaemon, { type: 'turn_terminal' }> =>
    msg.type === 'turn_terminal' && msg.turnId === turnId);

/**
 * Worker for the marker-less JSONL compatibility boundary:
 *  - the only dispatched turn is DURABLE (dispatchAttempt:1) and its user
 *    record gets no transcript terminal at all. The queue's
 *    requireExplicitTerminalForDurable gate holds it across the first idle
 *    edge instead of popping it unobserved.
 *  - after redrawing the idle prompt the fake appends a FREE-STANDING next
 *    user record (no matching worker mark). The bridge queue's handleTurnStart
 *    closes the previous turn the way older Claude JSONL variants do:
 *    terminalObserved=true with NO terminalOutcome. The durable turn then pops
 *    without the boundary_unobserved label — that next-turn-start record is
 *    positive proof the turn ended.
 * A free-standing record is required: the worker's type-ahead gate refuses to
 * flush a second PTY line while the durable turn has no terminal, so the
 * boundary cannot be driven via a second worker message.
 */
function startNextTurnBoundaryWorker() {
  root = mkdtempSync(join(tmpdir(), 'botmux-unobserved-next-turn-'));
  const workDir = join(root, 'work');
  const dataDir = join(root, 'data');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const cliSessionId = 'deadbeef-1234-4678-9abc-def012345693';
  const projectDir = join(root, '.claude', 'projects', realpathSync(workDir).replace(/[^A-Za-z0-9-]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${cliSessionId}.jsonl`);
  writeFileSync(transcript, [
    { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: cliSessionId },
  ].map(row => `${JSON.stringify(row)}\n`).join(''));
  const fakeClaude = join(root, 'fake-claude');
  writeFileSync(fakeClaude, `#!/usr/bin/env node
import('node:fs').then(fs => {
const T = ${JSON.stringify(transcript)};
const put = row => fs.appendFileSync(T, JSON.stringify({ timestamp: new Date().toISOString(), ...row }) + '\\n');
process.stdout.write('❯ ');
let typed = '';
process.stdin.on('data', chunk => {
  typed += chunk.toString();
  if (!/[\\r\\n]$/.test(typed)) return;
  if (typed.includes('\\x1b[200~') && !typed.includes('\\x1b[201~')) return;
  const prompt = typed.replace(/\\x1b\\[20[01]~/g, '').trim();
  typed = '';
  put({ type: 'user', uuid: 'u1', message: { role: 'user', content: prompt } });
  // Redraw idle with no terminal record for u1's turn.
  setTimeout(() => process.stdout.write('\\r\\n❯ '), 1500);
  // Then a free-standing next user record closes the durable turn via the
  // marker-less compatibility boundary (terminalObserved, no outcome).
  setTimeout(() => put({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'marker-less next turn' } }), 2200);
});
});
`);
  chmodSync(fakeClaude, 0o755);
  const messages: WorkerToDaemon[] = [];
  const logs: string[] = [];
  const sid = `sid-unobserved-next-turn-${randomUUID()}`;
  child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env, HOME: root, SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: sid, LARK_APP_ID: 'app_test', LARK_APP_SECRET: 'test-only',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.send({
    type: 'init', sessionId: sid, chatId: 'oc_test', rootMessageId: 'om_root',
    workingDir: workDir, cliId: 'claude-code', cliPathOverride: fakeClaude, cliSessionId,
    backendType: 'pty', prompt: '', resume: true, larkAppId: 'app_test', larkAppSecret: 'test-only', locale: 'zh',
  } satisfies DaemonToWorker);
  return { sid, transcript, messages, logs };
}

describe('claude bridge terminal at a screen-idle boundary without transcript terminal (real worker)', () => {
  it('labels the no-terminal pop boundary_unobserved and emits no final_output', async () => {
    const w = startWorker({ beforePrompt: [] });
    const turnId = 'om_unobserved';
    const messages = await runTurn(w, turnId);

    const terminals = terminalsOf(messages, turnId);
    expect(terminals).toEqual([expect.objectContaining({
      status: 'completed',
      outputDisposition: 'boundary_unobserved',
    })]);
    expect(messages.filter(msg => msg.type === 'final_output' && msg.turnId === turnId)).toEqual([]);

    // End-to-end: the daemon settles a still-pending async trigger fail-closed
    // with the precise terminal code and persists it across restarts.
    const sessionReply = vi.fn(async () => 'om_reply');
    initWorkerPool({
      sessionReply,
      getSessionWorkingDir: () => '/tmp',
      getActiveCount: () => 1,
      closeSession: vi.fn(),
    } as any);
    const worker = new EventEmitter() as any;
    Object.assign(worker, { killed: false, send: vi.fn(), kill: vi.fn(), pid: 99999, stdout: new EventEmitter(), stderr: new EventEmitter() });
    const ds = {
      session: {
        sessionId: w.sid, rootMessageId: 'om_root', chatId: 'oc_test', title: 'fixture', status: 'active',
        createdAt: Date.now(), updatedAt: Date.now(), pid: null, chatType: 'group', cliId: 'claude-code',
      },
      worker, workerPort: 0, workerToken: 'tok', larkAppId: 'app_test', chatId: 'oc_test', chatType: 'group',
      spawnedAt: Date.now(), cliVersion: '1', lastMessageAt: Date.now(), hasHistory: false, currentTurnId: turnId,
      asyncTriggerResults: new Map([[turnId, { status: 'pending', createdAt: Date.now() }]]),
      latestAsyncTriggerId: turnId,
    } as unknown as DaemonSession;
    __testOnly_setupWorkerHandlers(ds, worker);
    for (const msg of messages) {
      if (msg.type !== 'thinking_update' && msg.type !== 'final_output' && msg.type !== 'turn_terminal') continue;
      worker.emit('message', msg);
      await new Promise(done => setTimeout(done, 20));
    }
    await new Promise(done => setTimeout(done, 200));
    expect(ds.asyncTriggerResults!.get(turnId)).toMatchObject({
      status: 'failed',
      errorCode: 'trigger_failed',
      terminalErrorCode: 'turn_ended_unobserved',
    });
    expect(recordTerminalFailureStrict).toHaveBeenCalledWith(
      w.sid, turnId, expect.any(Number), 'app_test', 'turn_ended_unobserved',
    );
  }, 90_000);

  it('keeps the disposition absent on a normally finished turn (positive control)', async () => {
    const w = startWorker({ beforePrompt: [answerText, turnDuration] });
    const turnId = 'om_observed';
    const messages = await runTurn(w, turnId);

    const [terminal] = terminalsOf(messages, turnId);
    expect(terminal).toMatchObject({ status: 'completed' });
    expect(terminal!.outputDisposition).toBeUndefined();
    expect(messages.filter(msg => msg.type === 'final_output' && msg.turnId === turnId)).toEqual([
      expect.objectContaining({ turnId, content: 'The review is posted.' }),
    ]);
  }, 90_000);

  it('does not label a turn closed by the next-turn user record (marker-less JSONL boundary)', async () => {
    const w = startNextTurnBoundaryWorker();
    await waitUntil(() => w.messages.some(msg => msg.type === 'prompt_ready'), w.logs);

    // Durable turn: no transcript terminal is ever written for it; the fake's
    // free-standing next user record closes it via the marker-less
    // compatibility boundary (terminalObserved=true, no terminalOutcome).
    child!.send({
      type: 'message', content: 'durable task without terminal', turnId: 'om_durable_1', dispatchAttempt: 1,
    } satisfies DaemonToWorker);
    await waitUntil(
      () => terminalsOf(w.messages, 'om_durable_1').length > 0,
      w.logs,
    );
    await new Promise(done => setTimeout(done, 1_500));

    const [turn1Terminal] = terminalsOf(w.messages, 'om_durable_1');
    expect(turn1Terminal).toMatchObject({ status: 'completed', dispatchAttempt: 1 });
    // The next-turn-start record is positive terminal evidence: no unobserved
    // label, even though terminalOutcome was never populated.
    expect(turn1Terminal!.outputDisposition).toBeUndefined();
  }, 90_000);

  it('keeps the disposition absent when partial final_output was emitted without a transcript terminal', async () => {
    const w = startWorker({ beforePrompt: [partialAnswerNoStopReason] });
    const turnId = 'om_partial_no_terminal';
    const messages = await runTurn(w, turnId);

    expect(messages.filter(msg => msg.type === 'final_output' && msg.turnId === turnId)).toEqual([
      expect.objectContaining({ turnId, content: 'Partial answer before exit.' }),
    ]);
    const [terminal] = terminalsOf(messages, turnId);
    expect(terminal).toMatchObject({ status: 'completed' });
    // Output was observed and delivered as final_output, so the no-output
    // `boundary_unobserved` label must stay absent even with terminalObserved=false.
    expect(terminal!.outputDisposition).toBeUndefined();
  }, 90_000);
});
