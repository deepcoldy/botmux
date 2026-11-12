/**
 * A worker whose live runtime the daemon retired must not stay behind as a
 * worker that only queues input.
 *
 * Production (2026-11-11, v3.59.1): a message woke a suspended Claude session;
 * the ready gate fell back on its 45 s timeout, the startup command ran, the
 * message was written, and only then did the resumed Claude show its native
 * session id. That identity update still carried the finished resume
 * operation, so the session contract retired the live runtime and the worker
 * closed its transcript bridge and CLI backend (#214, fixed in c11042068).
 * The worker then stayed alive with no backend: four hours later Claude's
 * PreCompact hook reached it, and the next message was only ever logged as
 * "Queued message while CLI backend is restarting". The status card kept
 * showing a running turn, suspend only queued, Stop sent ^C into nothing.
 *
 * The first case replays that day: wake, compaction-start signal, next message.
 * The others take a retirement #214 does not cover — the identity update
 * landing while an exact-turn interrupt (a cancel operation) is in flight — and
 * check the ways out: the retired worker ends its generation and the message it
 * was holding is handed to a successor and answered without waiting for
 * another message; a close arriving before that still tears the CLI down.
 *
 * Real worker, real tmux backend on a private socket, a fake Claude; the daemon
 * side is the real worker IPC handler with the real SQLite session contract.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/im/lark/client.js')>()),
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
}));

import { sessionReadyHookCommand } from '../src/adapters/hook-command.js';
import { config } from '../src/config.js';
import * as bots from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import * as workerPool from '../src/core/worker-pool.js';
import { controllerForSession } from '../src/core/session-controller.js';
import { WORKER_EXIT_RUNTIME_RETIRED } from '../src/core/retired-runtime-exit.js';
import { preferredManagedTmuxSocket } from '../src/adapters/backend/tmux-socket.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { readJsonLines } from './helpers/read-json-lines.js';
import type { DaemonSession } from '../src/core/types.js';
import {
  claudeHarnessRunnable as runnable,
  cleanUpClaudeHarnesses,
  setupFakeClaude,
  type Generation,
  type Harness,
} from './helpers/claude-worker-harness.js';

const APP = 'app_test';
const WAKE_TURN = 'om_wake_turn';
const WAKE_TEXT = 'wake question';
const NEXT_TURN = 'om_next_turn';
const NEXT_TEXT = 'next question';
const caller = { requestUserOpenId: 'ou_requester', requestLarkAppId: APP, senderType: 'user' as const };

let previousDataDir: string | undefined;
let closeContract: (() => void) | undefined;

afterEach(async () => {
  await cleanUpClaudeHarnesses();
  closeContract?.(); closeContract = undefined;
  workerPool.__testOnly_resetOrdinaryImDeliveries();
  workerPool.__testOnly_setRetiredRuntimeSuccessorStarter();
  if (previousDataDir !== undefined) config.session.dataDir = previousDataDir;
  previousDataDir = undefined;
  vi.restoreAllMocks();
});

/** The fake CLI's own record of what was typed into it. */
const submitted = (h: Harness, text: string) => readJsonLines(join(h.root, 'events.jsonl'))
  .some(event => event.kind === 'submit' && typeof event.text === 'string' && event.text.includes(text));

/** The fake CLI finished the turn it ran for `text` (its reply echoes the
 *  whole submission, which carries more than the message itself). */
const answered = (h: Harness, text: string) => readJsonLines(join(h.root, 'events.jsonl'))
  .some(event => event.kind === 'turn' && typeof event.reply === 'string' && event.reply.startsWith(`reply: ${text}`));

/** A suspended Claude session, and the worker the daemon forks for the message
 *  that wakes it: the CLI resumes under the session's resume operation, the
 *  ready gate arms on botmux's SessionStart hook (which the fake never runs)
 *  and releases on its timeout, /effort runs, then the message is written. */
function wakeSuspendedSession() {
  // Claude's own pid-state record becomes readable only once the worker has
  // bound the CLI's runtime, so the native session id first arrives with the
  // write — the identity update this file is about. (A record readable at the
  // first binding puts the id there and there is no later update to retire on.)
  const h = setupFakeClaude({ turnMs: 800, pidStateGated: true });
  const transcript = h.transcript(h.sessionId);
  const ago = (ms: number) => new Date(Date.now() - 3_600_000 + ms).toISOString();
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, [
    { type: 'user', uuid: randomUUID(), timestamp: ago(0), message: { role: 'user', content: 'earlier question' } },
    { type: 'assistant', uuid: randomUUID(), timestamp: ago(1_000), message: { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }], stop_reason: 'end_turn' } },
    { type: 'system', subtype: 'turn_duration', durationMs: 1_000, uuid: randomUUID(), timestamp: ago(1_100) },
  ].map(row => `${JSON.stringify({ sessionId: h.sessionId, ...row })}\n`).join(''));
  writeFileSync(join(h.claudeDir, 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: sessionReadyHookCommand() }] }] },
  }));

  // The daemon starts its workers with SESSION_DATA_DIR = its own data dir.
  previousDataDir = config.session.dataDir;
  config.session.dataDir = join(h.root, 'data');
  vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);
  vi.spyOn(bots, 'getBot').mockReturnValue({
    config: { larkAppId: APP, larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'WakeBot',
  } as any);
  const sessionReply = vi.fn(async (..._args: unknown[]) => 'om_reply');
  workerPool.initWorkerPool({
    sessionReply, getSessionWorkingDir: () => h.workingDir, getActiveCount: () => 1, closeSession: vi.fn(),
  } as any);
  const target = (turnId: string) => ({ rootMessageId: turnId, senderOpenId: caller.requestUserOpenId, updatedAt: new Date().toISOString() });
  const ds = {
    session: { sessionId: h.sessionId, chatId: 'oc_test', chatType: 'group', status: 'active', cliId: 'claude-code',
      createdAt: new Date().toISOString(), workerGeneration: 1,
      replyTargets: { [WAKE_TURN]: target(WAKE_TURN), [NEXT_TURN]: target(NEXT_TURN) } },
    larkAppId: APP, chatId: 'oc_test', chatType: 'group', scope: 'chat',
    workerGeneration: 1, workerPort: 0, workerToken: 'token',
    spawnedAt: Date.now(), cliVersion: '1', lastMessageAt: Date.now(), hasHistory: true,
  } as unknown as DaemonSession;

  const controller = controllerForSession(ds, true)!;
  closeContract = () => controller.store.close();
  const suspend = controller.beginControl('suspend').operation.operationId;
  controller.controlStarted(suspend); controller.controlResult(suspend, 'confirmed');

  /** forkWorker for one generation: contract bootstrap, init, IPC handlers. */
  const fork = (generation: number, init: Record<string, unknown>): Generation => {
    const restartAttemptId = controller.prepareWorkerStart();
    const sessionContract = controller.bindWorker(generation);
    const message = {
      type: 'init' as const, sessionId: h.sessionId, resume: true, cliId: 'claude-code', backendType: 'tmux' as const,
      promptInjection: undefined, startupCommands: ['/effort xhigh'], restartAttemptId, sessionContract, ...init,
    };
    ds.initConfig = message as any;
    (ds as any).workerGeneration = generation;
    ds.session.workerGeneration = generation;
    const g = h.startWorker(message as any);
    (ds as any).worker = g.child;
    workerPool.__testOnly_setupWorkerHandlers(ds, g.child as any, undefined, generation);
    return g;
  };
  const g = fork(1, {
    prompt: WAKE_TEXT, turnId: WAKE_TURN, trustedCaller: caller,
    sessionCommand: { version: 2 as const, execution: controller.admitInput(WAKE_TURN) },
  });
  void (async () => {
    while (!controller.store.runtime(controller.ref)?.identity && g.child.exitCode === null) await new Promise(done => setTimeout(done, 50));
    writeFileSync(h.pidStateGate, '');
  })();
  const replies = () => sessionReply.mock.calls.map(args => String(args[1]));
  /** The next message, through the daemon's ordinary IM delivery. */
  const sendNext = () => workerPool.sendWorkerInput(ds, NEXT_TEXT, NEXT_TURN, { trustedCaller: caller });
  return { h, ds, controller, g, fork, replies, sendNext };
}

describe.skipIf(!runnable)('a worker whose runtime the daemon retired', () => {
  it('still delivers the next message after a wake whose ready gate fell back and a compaction started', async () => {
    const { h, g, replies, sendNext } = wakeSuspendedSession();
    // The wake turn ran and the CLI reported its native session id after the
    // write — the identity update that retired the runtime before #214.
    await g.waitFor(() => answered(h, WAKE_TEXT) && g.logs.join('').includes('Published CLI session id'),
      'the waking turn to finish', 120_000);
    // Let the identity update reach the contract and the answer come back.
    await new Promise(done => setTimeout(done, 2_000));

    // Claude's PreCompact hook, the way the daemon forwards it.
    const requestId = randomUUID();
    g.child.send({ type: 'claude_compaction_start', startedAtMs: Date.now(), requestId });
    await g.waitFor(() => g.messages.some(m => m.type === 'session_ready_ack' && m.requestId === requestId),
      'the worker to acknowledge the compaction signal');

    expect(sendNext()).toBe(true);
    await g.waitFor(() => submitted(h, NEXT_TEXT), 'the next message typed into the CLI', 30_000);
    await g.waitFor(() => replies().some(text => text.includes(`reply: ${NEXT_TEXT}`)), 'the reply to the next message');
    const log = g.logs.join('');
    expect(log).toContain('Claude PreCompact maintenance signal received');
    expect(log).not.toContain('Queued message while CLI backend is restarting');
    expect(log).not.toContain('mayExecute=false');
  }, 180_000);

  /** Wake with an exact-turn interrupt of the waking turn in flight
   *  (interruptExactWorkerTurn has opened its cancel operation) when the
   *  message is written and the CLI then shows its native session id: that
   *  identity update carries the resume operation, which is no longer the
   *  active one, and the contract retires the live runtime. */
  async function retireDuringInterrupt() {
    const session = wakeSuspendedSession();
    const { controller, g } = session;
    await g.waitFor(() => g.logs.join('').includes('Startup command confirmed'), 'the startup command before the write', 120_000);
    const execution = controller.store.executions(controller.ref)
      .find(value => value.ref.turnId === WAKE_TURN && !value.terminal)!;
    const cancel = controller.beginControl('cancel', undefined, execution.ref).operation.operationId;
    controller.controlStarted(cancel);
    await g.waitFor(() => g.logs.join('').includes('mayExecute=false'), 'the daemon retiring the runtime', 30_000);
    expect(g.logs.join('').indexOf('Published CLI session id')).toBeGreaterThan(g.logs.join('').indexOf('Writing to PTY'));
    controller.controlResult(cancel, 'uncertain');
    return session;
  }

  const exitOf = (g: Generation, timeoutMs: number) => new Promise<number | null>((done, fail) => {
    if (g.child.exitCode !== null) { done(g.child.exitCode); return; }
    const timer = setTimeout(() => fail(new Error(`the retired worker is still running\n${g.logs.join('')}`)), timeoutMs);
    g.child.once('exit', code => { clearTimeout(timer); done(code); });
  });

  it('ends its generation and has the message it was holding answered by a successor', async () => {
    const { h, ds, g, fork, replies, sendNext } = await retireDuringInterrupt();
    // The daemon starts a successor for handed-over input the way it re-forks
    // a worker-less session.
    let successor: Generation | undefined;
    workerPool.__testOnly_setRetiredRuntimeSuccessorStarter(() => { successor = fork(2, { prompt: '' }); return true; });

    // A message reaching the retired worker before it is gone.
    expect(sendNext()).toBe(true);
    await g.waitFor(() => g.logs.join('').includes('Queued message while CLI backend is restarting'), 'the message queued');

    // The way out: the worker ends its generation on its own, handing the
    // message over (as on a suspend, so nothing tells the group it was lost).
    expect(await exitOf(g, 20_000)).toBe(WORKER_EXIT_RUNTIME_RETIRED);
    expect(submitted(h, NEXT_TEXT)).toBe(false);
    expect(replies().filter(text => text.includes(NEXT_TURN))).toEqual([]);

    // No further message arrives: the daemon starts the successor itself, which
    // takes the handed-over message back and the CLI answers it.
    await vi.waitFor(() => expect(successor).toBeDefined(), { timeout: 5_000 });
    expect(ds.worker).toBe(successor!.child);
    await successor!.waitFor(() => submitted(h, NEXT_TEXT), 'the handed-over message typed into the CLI', 120_000);
    await successor!.waitFor(() => replies().some(text => text.includes(`reply: ${NEXT_TEXT}`)), 'the reply to the handed-over message');
    expect(successor!.logs.join('')).toContain('input(s) the previous worker never wrote to the CLI');
    expect(existsSync(join(h.root, 'data', 'turn-marks', `${h.sessionId}.unsent.json`))).toBe(false);
  }, 300_000);

  it('still has a close that arrives before it ends tear down the CLI', async () => {
    const { h, ds, g } = await retireDuringInterrupt();
    const pane = `bmx-${h.sessionId.slice(0, 8)}`;
    const socket = join(h.root, `tmux-${process.getuid?.() ?? 0}`, preferredManagedTmuxSocket() ?? 'default');
    const paneAlive = () => {
      try { execFileSync('tmux', ['-S', socket, 'has-session', '-t', pane], { env: privateTmuxEnv(h.root), stdio: 'ignore' }); return true; } catch { return false; }
    };
    const cliPids = readJsonLines(join(h.root, 'events.jsonl')).filter(event => event.kind === 'start').map(event => event.pid as number);
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(paneAlive()).toBe(true);

    // /close lands inside the retired worker's grace window.
    workerPool.killWorker(ds);
    expect(await exitOf(g, 20_000)).toBe(0);
    await vi.waitFor(() => {
      expect(paneAlive()).toBe(false);
      expect(cliPids.filter(alive)).toEqual([]);
    }, { timeout: 10_000 });
  }, 300_000);
});
