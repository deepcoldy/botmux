import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnNodeTsScript } from './helpers/ts-runner.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';

// Real worker, fake Claude Code, pty backend (never the host tmux server); the
// worker's IPC is then replayed into the real daemon worker handlers.
//
// Claude redraws its prompt while the records that close the turn — the final
// message's blocks, an API error that cut the stream, `turn_duration` — are
// still on their way to the transcript. The fake answers a prompt, draws `❯`,
// and the test appends the closing records only after the worker logged that
// idle edge.

const cotRequest = vi.fn(async (req: { method: string; url: string }) =>
  req.method === 'POST'
    ? { code: 0, data: { cot_id: 'cot_claude', message_id: 'om_cot_bubble' } }
    : { code: 0, data: {} });

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
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

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: class { constructor() {} },
  WSClient: class { start() {} },
  EventDispatcher: class { register() {} },
  LoggerLevel: { info: 2 },
}));

import { initWorkerPool, __testOnly_setupWorkerHandlers } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';
import { lookupCliDisplayName } from '../src/adapters/cli/display-names.js';
import { setDefaultLocale, t } from '../src/i18n/index.js';

setDefaultLocale('zh');

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
  cotRequest.mockClear();
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

/** The final message's only block, stamped `end_turn` with all-zero usage:
 *  what the production transcript held for the turn the stream died in. */
const cutThinking: Row = {
  type: 'assistant', uuid: 'a-think',
  message: { id: 'm1', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', usage: zeroUsage,
    content: [{ type: 'thinking', thinking: 'checking the rebased diff', signature: '' }] },
};
const serverError: Row = {
  type: 'assistant', uuid: 'a-err', isApiErrorMessage: true, error: 'server_error', truncatedAfterOutput: true,
  message: { id: 'e1', role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence', usage: zeroUsage,
    content: [{ type: 'text', text: 'API Error: Server error mid-response. The response above may be incomplete.' }] },
};
const turnDuration: Row = { type: 'system', subtype: 'turn_duration', uuid: 'd1', durationMs: 3_000 };
const answerThinking: Row = {
  type: 'assistant', uuid: 'a-think',
  message: { id: 'm1', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', usage: { ...zeroUsage, output_tokens: 40 },
    content: [{ type: 'thinking', thinking: 'checking the rebased diff', signature: 'sig' }] },
};
const answerText: Row = {
  type: 'assistant', uuid: 'a-text',
  message: { id: 'm1', role: 'assistant', model: 'claude-test', stop_reason: 'end_turn', usage: { ...zeroUsage, output_tokens: 40 },
    content: [{ type: 'text', text: 'The review is posted.' }] },
};

/** `beforePrompt`: what the fake writes before drawing `❯`.
 *  `firstTurn`: the transcript has no finished turn, so no `turn_duration`. */
function startWorker(opts: { beforePrompt: Row[]; firstTurn: boolean }) {
  root = mkdtempSync(join(tmpdir(), 'botmux-api-error-idle-'));
  const workDir = join(root, 'work');
  const dataDir = join(root, 'data');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const cliSessionId = 'deadbeef-1234-4678-9abc-def012345691';
  const projectDir = join(root, '.claude', 'projects', realpathSync(workDir).replace(/[^A-Za-z0-9-]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${cliSessionId}.jsonl`);
  const history: Row[] = opts.firstTurn
    ? [{ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: cliSessionId }]
    : [
        { type: 'user', uuid: 'p0', timestamp: minutesAgo(30), message: { role: 'user', content: 'hi' } },
        { type: 'assistant', uuid: 'a0', timestamp: minutesAgo(30), message: { id: 'm0', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] } },
        { type: 'system', subtype: 'turn_duration', uuid: 'd0', timestamp: minutesAgo(30) },
      ];
  writeFileSync(transcript, history.map(row => `${JSON.stringify(row)}\n`).join(''));
  const fakeClaude = join(root, 'fake-claude');
  // Dynamic import: runs as CommonJS or ESM, whatever package.json sits above.
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
  const sid = 'sid-api-error-idle';
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

/** Send one Lark turn, wait for the idle edge that follows it, then append the
 *  records Claude had not flushed yet. Returns the worker's IPC from then on. */
async function runTurn(w: ReturnType<typeof startWorker>, turnId: string, afterIdle: Row[]) {
  await waitUntil(() => w.messages.some(msg => msg.type === 'prompt_ready'), w.logs);
  const idleEdges = () => w.logs.join('').split('Prompt detected (idle)').length - 1;
  const edgesBefore = idleEdges();
  const fromIndex = w.messages.length;
  child!.send({ type: 'message', content: 'please re-review PR 2188', turnId } satisfies DaemonToWorker);
  await waitUntil(() => idleEdges() > edgesBefore, w.logs);
  appendFileSync(w.transcript, afterIdle
    .map(row => `${JSON.stringify({ timestamp: new Date().toISOString(), ...row })}\n`).join(''));
  const turnMessages = () => w.messages.slice(fromIndex);
  await waitUntil(() => turnMessages().some(msg => msg.type === 'turn_terminal' && msg.turnId === turnId), w.logs);
  // Anything still in flight for the same turn lands within a few polls.
  await new Promise(done => setTimeout(done, 1_500));
  return turnMessages();
}

/** What the daemon makes of the worker's outcome for this turn: the CoT bubble
 *  calls and the replies it posts. */
async function replayIntoDaemon(sid: string, turnId: string, messages: WorkerToDaemon[]) {
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
      sessionId: sid, rootMessageId: 'om_root', chatId: 'oc_test', title: 'fixture', status: 'active',
      createdAt: Date.now(), updatedAt: Date.now(), pid: null, chatType: 'group', cliId: 'claude-code',
    },
    worker, workerPort: 0, workerToken: 'tok', larkAppId: 'app_test', chatId: 'oc_test', chatType: 'group',
    spawnedAt: Date.now(), cliVersion: '1', lastMessageAt: Date.now(), hasHistory: false, currentTurnId: turnId,
  } as unknown as DaemonSession;
  __testOnly_setupWorkerHandlers(ds, worker);
  for (const msg of messages) {
    if (msg.type !== 'thinking_update' && msg.type !== 'final_output' && msg.type !== 'turn_terminal') continue;
    worker.emit('message', msg);
    await new Promise(done => setTimeout(done, 20));
  }
  await new Promise(done => setTimeout(done, 200));
  const cotCalls = cotRequest.mock.calls.map(([req]) => req as { method: string; url: string; params?: unknown; data?: any });
  const cotEvents = cotCalls.filter(req => req.method === 'PUT')
    .flatMap(req => (req.data?.events ?? []) as Array<{ event_type: string; content: string }>);
  return {
    cotCreated: cotCalls.some(req => req.method === 'POST'),
    cotRunFinished: cotEvents.filter(e => e.event_type === 'RUN_FINISHED').map(e => JSON.parse(e.content).status),
    cotErrorCompletes: cotCalls.filter(req => String(req.url).includes('/message_cot/complete/')).map(req => req.params),
    replies: sessionReply.mock.calls.map(call => String((call as unknown[])[1])),
  };
}

const failedTitle = t('card.turn_failed.title', { cliName: lookupCliDisplayName('claude-code') ?? 'Claude Code' });

const terminalsOf = (messages: WorkerToDaemon[], turnId: string) =>
  messages.filter((msg): msg is Extract<WorkerToDaemon, { type: 'turn_terminal' }> =>
    msg.type === 'turn_terminal' && msg.turnId === turnId);

describe('Claude turn cut by an API error that lands after the prompt (real worker, fake Claude Code)', () => {
  for (const scenario of [
    {
      name: 'prompt back before any closing record was written (production shape)',
      firstTurn: false, beforePrompt: [], afterIdle: [cutThinking, serverError, turnDuration],
    },
    {
      name: 'thinking-only end_turn read before the prompt, error and turn_duration after it',
      firstTurn: false, beforePrompt: [cutThinking], afterIdle: [serverError, turnDuration],
    },
    {
      name: 'same, on the first turn of a session that never wrote turn_duration before',
      firstTurn: true, beforePrompt: [cutThinking], afterIdle: [serverError, turnDuration],
    },
  ]) {
    it(`fails the turn, interrupts the CoT and posts the failure card — ${scenario.name}`, async () => {
      const w = startWorker(scenario);
      const turnId = 'om_api_error';
      const messages = await runTurn(w, turnId, scenario.afterIdle);

      expect(terminalsOf(messages, turnId)).toEqual([expect.objectContaining({
        status: 'failed', errorCode: 'provider_server_error', retryable: true,
      })]);
      expect(messages.filter(msg => msg.type === 'final_output')).toEqual([]);

      const daemon = await replayIntoDaemon(w.sid, turnId, messages);
      expect(daemon.cotCreated).toBe(true);
      expect(daemon.cotRunFinished).toEqual([]);
      expect(daemon.cotErrorCompletes).toEqual([{ message_id: 'om_cot_bubble', reason: 'error' }]);
      expect(daemon.replies.filter(body => body.includes(failedTitle))).toHaveLength(1);
    }, 90_000);
  }

  for (const scenario of [
    { name: 'closing records written before the prompt', beforePrompt: [answerThinking, answerText, turnDuration], afterIdle: [] },
    { name: 'prompt back before the closing records', beforePrompt: [], afterIdle: [answerThinking, answerText, turnDuration] },
  ]) {
    it(`completes a normally finished turn with its answer — ${scenario.name}`, async () => {
      const w = startWorker({ ...scenario, firstTurn: false });
      const turnId = 'om_answered';
      const messages = await runTurn(w, turnId, scenario.afterIdle);

      expect(terminalsOf(messages, turnId)).toEqual([expect.objectContaining({ status: 'completed' })]);
      expect(messages.filter(msg => msg.type === 'final_output')).toEqual([
        expect.objectContaining({ turnId, content: 'The review is posted.' }),
      ]);

      const daemon = await replayIntoDaemon(w.sid, turnId, messages);
      expect(daemon.cotRunFinished).toEqual(['done']);
      expect(daemon.cotErrorCompletes).toEqual([]);
      expect(daemon.replies.some(body => body.includes(failedTitle))).toBe(false);
    }, 90_000);
  }
});
