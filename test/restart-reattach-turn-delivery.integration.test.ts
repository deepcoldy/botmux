/**
 * A turn still running when the daemon restarts must get its reply once the new
 * daemon's worker re-attaches the CLI — and when its origin cannot be proven,
 * the group must be told instead of the reply vanishing.
 *
 * Production (2026-11-11, ccf2d73db): a Claude session in tmux was mid-turn when
 * the fleet restarted. The new worker re-attached the same live Claude, but the
 * runtime identity it published carried only the process (pid + start time):
 * Claude's native session id is otherwise only learned at the next write, and a
 * turn already running has none. The session contract therefore could not tell
 * the re-attached CLI from a different one and bound it as a new runtime, while
 * the turn's execution stayed on the runtime it was submitted under. When the
 * turn ended, the worker found the answer belonged to a runtime it had no
 * binding for and dropped it locally ("Dropped final output with unproven
 * execution origin"); the daemon never saw it, so the group got neither the
 * reply nor a notice.
 *
 * Real worker, real tmux backend on a private socket, a fake Claude that keeps
 * its pid-state record the way Claude Code does; the daemon side is the real
 * worker IPC handler with the real SQLite session contract. A daemon restart is
 * what the daemon does on shutdown (SIGTERM to the worker, the pane survives)
 * followed by a fresh daemon session object and contract controller, which
 * fork the next worker generation for the surviving pane.
 */
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

import { config } from '../src/config.js';
import * as bots from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import * as workerPool from '../src/core/worker-pool.js';
import { controllerForSession } from '../src/core/session-controller.js';
import { t } from '../src/i18n/index.js';
import { readJsonLines } from './helpers/read-json-lines.js';
import type { DaemonSession } from '../src/core/types.js';
import type { DaemonToWorker } from '../src/types.js';
import {
  claudeHarnessRunnable as runnable,
  cleanUpClaudeHarnesses,
  setupFakeClaude,
  type Generation,
  type Harness,
} from './helpers/claude-worker-harness.js';

const APP = 'app_test';
const TURN = 'om_restart_turn';
const TEXT = 'question across the restart';
const caller = { requestUserOpenId: 'ou_requester', requestLarkAppId: APP, senderType: 'user' as const };

let previousDataDir: string | undefined;
let closeContract: (() => void) | undefined;

afterEach(async () => {
  await cleanUpClaudeHarnesses();
  closeContract?.(); closeContract = undefined;
  workerPool.__testOnly_resetOrdinaryImDeliveries();
  if (previousDataDir !== undefined) config.session.dataDir = previousDataDir;
  previousDataDir = undefined;
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const events = (h: Harness) => readJsonLines(join(h.root, 'events.jsonl'));
/** The fake CLI has the message typed in. */
const submitted = (h: Harness) => events(h).some(e => e.kind === 'submit' && String(e.text).includes(TEXT));
/** The fake CLI finished the turn it ran for the message. */
const answered = (h: Harness) => events(h).some(e => e.kind === 'turn' && String(e.reply).startsWith(`reply: ${TEXT}`));

/** A live Claude session in tmux, and the daemon around it. `restartDaemon`
 *  replaces the daemon: the old one stops its worker the way its shutdown does
 *  for a persistent backend, and a new daemon session object and contract
 *  controller fork the next worker for the surviving pane. */
function liveSession(opts: { turnMs: number; pidStateGated?: boolean; recordReadable?: boolean }) {
  const h = setupFakeClaude({ turnMs: opts.turnMs, ...(opts.pidStateGated ? { pidStateGated: true } : {}) });
  if (opts.pidStateGated && opts.recordReadable !== false) writeFileSync(h.pidStateGate, '');
  const transcript = h.transcript(h.sessionId);
  const ago = (ms: number) => new Date(Date.now() - 3_600_000 + ms).toISOString();
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, [
    { type: 'user', uuid: randomUUID(), timestamp: ago(0), message: { role: 'user', content: 'earlier question' } },
    { type: 'assistant', uuid: randomUUID(), timestamp: ago(1_000), message: { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }], stop_reason: 'end_turn' } },
    { type: 'system', subtype: 'turn_duration', durationMs: 1_000, uuid: randomUUID(), timestamp: ago(1_100) },
  ].map(row => `${JSON.stringify({ sessionId: h.sessionId, ...row })}\n`).join(''));

  // The daemon starts its workers with SESSION_DATA_DIR = its own data dir.
  previousDataDir = config.session.dataDir;
  config.session.dataDir = join(h.root, 'data');
  vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);
  vi.spyOn(bots, 'getBot').mockReturnValue({
    config: { larkAppId: APP, larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'RestartBot',
  } as any);
  const sessionReply = vi.fn(async (..._args: unknown[]) => 'om_reply');
  workerPool.initWorkerPool({
    sessionReply, getSessionWorkingDir: () => h.workingDir, getActiveCount: () => 1, closeSession: vi.fn(),
  } as any);

  /** One daemon's view of the session, as restoreActiveSessions builds it. */
  const daemonSession = (generation: number) => ({
    session: { sessionId: h.sessionId, chatId: 'oc_test', chatType: 'group', status: 'active', cliId: 'claude-code',
      createdAt: new Date().toISOString(), workerGeneration: generation,
      replyTargets: { [TURN]: { rootMessageId: TURN, senderOpenId: caller.requestUserOpenId, updatedAt: new Date().toISOString() } } },
    larkAppId: APP, chatId: 'oc_test', chatType: 'group', scope: 'chat',
    workerGeneration: generation, workerPort: 0, workerToken: 'token',
    spawnedAt: Date.now(), cliVersion: '1', lastMessageAt: Date.now(), hasHistory: true,
  } as unknown as DaemonSession);

  /** forkWorker for one generation: contract bootstrap, init, IPC handlers.
   *  `confirmLate` holds the daemon's runtime confirmation back from the
   *  worker until it resolves — a daemon busy restoring the rest of the fleet. */
  const fork = (ds: DaemonSession, generation: number, confirmLate?: (g: Generation) => Promise<void>) => {
    const controller = controllerForSession(ds, true)!;
    closeContract ??= () => controller.store.close();
    const restartAttemptId = controller.prepareWorkerStart();
    const sessionContract = controller.bindWorker(generation);
    // As forkWorker always negotiates it: final outputs go through the
    // durable output handoff, the path production replies take.
    const init = {
      type: 'init' as const, sessionId: h.sessionId, resume: true, cliId: 'claude-code', backendType: 'tmux' as const,
      promptInjection: undefined, prompt: '', restartAttemptId, sessionContract,
      finalOutputHandoff: { version: 2 as const, token: randomUUID(), admitNew: false },
    };
    ds.initConfig = init as any;
    const g = h.startWorker(init as any);
    let channel: ChildProcess = g.child;
    if (confirmLate) {
      const held = confirmLate(g);
      const raw = g.child.send.bind(g.child) as (...args: unknown[]) => boolean;
      // The handler wraps `send` with its own scoping; keep that wrapper on
      // the channel and hold only what finally goes down the pipe.
      let send: unknown = (message: DaemonToWorker, ...rest: unknown[]) => {
        if (message.type !== 'runtime_contract_assigned') return raw(message, ...rest);
        void held.then(() => { if (g.child.connected) raw(message, ...rest); });
        return true;
      };
      channel = new Proxy(g.child, {
        get: (target, key) => {
          if (key === 'send') return send;
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
        set: (target, key, value) => {
          if (key === 'send') { send = value; return true; }
          return Reflect.set(target, key, value, target);
        },
      });
    }
    (ds as any).worker = channel;
    workerPool.__testOnly_setupWorkerHandlers(ds, channel as any, undefined, generation);
    return { g, controller };
  };

  const ds1 = daemonSession(1);
  const first = fork(ds1, 1);
  const replies = () => sessionReply.mock.calls.map(args => String(args[1]));
  const turnReplies = () => replies().filter(text => text.includes(`reply: ${TEXT}`));
  const notice = new Set((['zh', 'en'] as const).map(locale => t('worker.final_output_undelivered', undefined, locale)));
  const undeliveredNotices = () => replies().filter(text => notice.has(text));
  /** The reply says which turn it answers: the turn's input began with TEXT. */
  const namesItsTurn = (reply: string) => reply.includes(`「${TEXT}」`) || reply.includes(`(\"${TEXT}\")`);

  /** The daemon's shutdown for a persistent backend, then the new daemon's
   *  restore. `beforeReattach` runs while no worker is attached. */
  const restartDaemon = async (g: Generation, opts: {
    beforeReattach?: () => Promise<void>;
    confirmLate?: (g: Generation) => Promise<void>;
  } = {}) => {
    const exited = new Promise(done => g.child.once('exit', done));
    ds1.worker = null;
    g.child.kill('SIGTERM');
    await exited;
    await opts.beforeReattach?.();
    const ds2 = daemonSession(2);
    return { ...fork(ds2, 2, opts.confirmLate), ds: ds2 };
  };
  return { h, ds1, first, replies, turnReplies, undeliveredNotices, namesItsTurn, restartDaemon };
}

/** Start the message's turn on the first worker. When the CLI's record is
 *  readable the worker learns its native session id at the write, so the
 *  runtime the turn runs on knows its conversation; otherwise it does not. */
async function startTurn(s: ReturnType<typeof liveSession>, opts: { nativeKnown: boolean } = { nativeKnown: true }) {
  const { h, ds1, first } = s;
  const g = first.g;
  await g.waitFor(() => g.messages.some(m => m.type === 'prompt_ready'), 'the first worker to be ready', 60_000);
  expect(workerPool.sendWorkerInput(ds1, TEXT, TURN, { trustedCaller: caller })).toBe(true);
  await g.waitFor(() => submitted(h) && (!opts.nativeKnown || g.logs.join('').includes('Published CLI session id')),
    'the message written into the CLI', 60_000);
  const execution = () => first.controller.store.executions(first.controller.ref).find(value => value.ref.turnId === TURN);
  await vi.waitFor(() => {
    expect(execution()?.runtime).toBeDefined();
    expect(first.controller.store.runtime(first.controller.ref, execution()!.runtime!.runtimeId)?.identity?.nativeSessionId)
      .toBe(opts.nativeKnown ? h.sessionId : undefined);
  }, { timeout: 10_000 });
  return execution;
}

describe.skipIf(!runnable)('a turn running across a daemon restart', () => {
  it('gets its reply once the new worker re-attaches the CLI and the turn ends', async () => {
    const s = liveSession({ turnMs: 15_000 });
    const execution = await startTurn(s);
    const { g: next } = await s.restartDaemon(s.first.g);
    expect(answered(s.h)).toBe(false);

    await next.waitFor(() => s.turnReplies().length > 0, 'the reply to the turn that ran across the restart', 90_000);
    // A duplicate would follow within a bridge tick or two.
    await sleep(3_000);
    const log = next.logs.join('');
    expect(s.turnReplies(), log).toHaveLength(1);
    // Recovered from the journal: the note above it names the turn it answers.
    expect(s.namesItsTurn(s.turnReplies()[0]!), s.turnReplies()[0]).toBe(true);
    expect(s.undeliveredNotices()).toEqual([]);
    expect(log).not.toContain('Dropped final output with unproven execution origin');
    await vi.waitFor(() => expect(execution()?.phase).toBe('succeeded'), { timeout: 10_000 });
  }, 240_000);

  it('gets its reply once when the turn ended during the restart and the daemon confirms the runtime late', async () => {
    const s = liveSession({ turnMs: 8_000 });
    const execution = await startTurn(s);
    // The CLI finishes the turn during the restart, so the new worker finds the
    // answer in the transcript as soon as it re-attaches — before the new
    // daemon, busy restoring the fleet, has confirmed its runtime (2026-11-10).
    const { g: next } = await s.restartDaemon(s.first.g, {
      beforeReattach: () => vi.waitFor(() => expect(answered(s.h)).toBe(true), { timeout: 30_000, interval: 100 }),
      confirmLate: async g => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !g.messages.some(m => m.type === 'final_output')
          && !g.logs.join('').includes('Dropped final output')) await sleep(50);
      },
    });

    await next.waitFor(() => s.turnReplies().length > 0, 'the reply to the turn that ended during the restart', 90_000);
    await sleep(3_000);
    const log = next.logs.join('');
    expect(s.turnReplies(), log).toHaveLength(1);
    // Recovered from the journal: the note above it names the turn it answers.
    expect(s.namesItsTurn(s.turnReplies()[0]!), s.turnReplies()[0]).toBe(true);
    expect(s.undeliveredNotices()).toEqual([]);
    expect(log).not.toContain('Dropped final output with unproven execution origin');
    await vi.waitFor(() => expect(execution()?.phase).toBe('succeeded'), { timeout: 10_000 });
  }, 240_000);

  it('gets its reply once when the turn ran on a runtime bound before the CLI\'s conversation could be read', async () => {
    // The first worker cannot read the CLI's record (a worker from before this
    // record was read at binding, or one that bound before Claude wrote it), so
    // the turn runs on a runtime bound by process alone. By the restart the
    // record is readable: the new worker's complete identity must not cost the
    // re-attached worker its binding while that turn is still open.
    const s = liveSession({ turnMs: 15_000, pidStateGated: true, recordReadable: false });
    const execution = await startTurn(s, { nativeKnown: false });
    const { g: next } = await s.restartDaemon(s.first.g, {
      beforeReattach: async () => {
        writeFileSync(s.h.pidStateGate, '');
        await sleep(400);
      },
    });

    await next.waitFor(() => s.turnReplies().length > 0, 'the reply to the turn that ran on the bare runtime', 90_000);
    await sleep(3_000);
    const log = next.logs.join('');
    expect(s.turnReplies(), log).toHaveLength(1);
    // Recovered from the journal: the note above it names the turn it answers.
    expect(s.namesItsTurn(s.turnReplies()[0]!), s.turnReplies()[0]).toBe(true);
    expect(s.undeliveredNotices()).toEqual([]);
    await vi.waitFor(() => expect(execution()?.phase).toBe('succeeded'), { timeout: 10_000 });
  }, 240_000);

  it('tells the group once, instead of posting, when the re-attached CLI cannot be shown to be running that conversation', async () => {
    const s = liveSession({ turnMs: 15_000, pidStateGated: true });
    await startTurn(s);
    // The CLI's own record of its conversation is gone by the time the new
    // worker re-attaches: nothing proves the live process still runs it.
    const { g: next } = await s.restartDaemon(s.first.g, {
      beforeReattach: async () => {
        rmSync(s.h.pidStateGate, { force: true });
        await sleep(400);
        const sessions = join(s.h.claudeDir, 'sessions');
        for (const name of readdirSync(sessions)) rmSync(join(sessions, name), { force: true });
      },
    });

    await next.waitFor(() => answered(s.h), 'the turn to end in the CLI', 90_000);
    await next.waitFor(() => s.undeliveredNotices().length > 0, 'the notice that the reply could not be posted', 30_000);
    await sleep(3_000);
    expect(s.turnReplies(), next.logs.join('')).toEqual([]);
    expect(s.undeliveredNotices()).toHaveLength(1);
  }, 240_000);
});
