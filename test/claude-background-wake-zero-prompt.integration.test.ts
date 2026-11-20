/**
 * A zero-prompt (`promptInjection: none`) session's answer to a turn Claude
 * started on its own — a background task's wake-up — must reach the group.
 *
 * Production (2026-11-17 → 11-19): a Claude bot running with `promptInjection:
 * none` answered "review started", launched the review in the background and
 * ended its turn; that reply was forwarded. When the background task finished,
 * Claude woke up, wrote the verdict and went idle — and nothing reached the
 * group, on every bot in that mode, since the session contract went live
 * (2026-11-09). The worker reported the wake as a terminal-local turn
 * (`terminal_turn_started`, then its `final_output`); the contract admitted the
 * turn's execution but refused its start, so the daemon never recorded where
 * that turn replies and dropped its answer without a word. Two of the three
 * sessions had also been through a daemon restart between launching the task
 * and the wake-up.
 *
 * Real worker, real tmux backend on a private socket, a fake Claude whose
 * background wake-up is a turn of its own; the daemon side is the real worker
 * IPC handler with the real SQLite session contract. A daemon restart is the
 * shutdown's SIGTERM to the worker (the pane survives), then a new daemon
 * session object and contract controller forking the next worker generation.
 * `/clear` re-binds the runtime in process, the way every production start does
 * once the relay resolves the real CLI behind its launcher.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/im/lark/client.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/im/lark/client.js')>()),
  updateMessage: vi.fn(async () => {}),
  addReaction: vi.fn(async () => 'reaction_id'),
  removeReaction: vi.fn(async () => {}),
  sendUserMessage: vi.fn(async () => {}),
  deleteMessage: vi.fn(async () => {}),
}));

import { join } from 'node:path';
import { config } from '../src/config.js';
import * as bots from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import * as workerPool from '../src/core/worker-pool.js';
import { controllerForSession } from '../src/core/session-controller.js';
import type { DaemonSession } from '../src/core/types.js';
import {
  claudeHarnessRunnable as runnable,
  cleanUpClaudeHarnesses,
  setupFakeClaude,
  type Generation,
} from './helpers/claude-worker-harness.js';

const APP = 'app_test';
const TURN = 'om_review_request';
const TEXT = 'review the new head';
const VERDICT = 'final verdict: ready to merge';
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

/** A zero-prompt Claude session in a group, and the daemon around it. */
function zeroPromptSession() {
  const h = setupFakeClaude({ turnMs: 800, atomicPidState: true });
  previousDataDir = config.session.dataDir;
  config.session.dataDir = join(h.root, 'data');
  vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);
  vi.spyOn(bots, 'getBot').mockReturnValue({
    config: { larkAppId: APP, larkAppSecret: 'secret', cliId: 'claude-code', promptInjection: 'none' },
    resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'ZeroPromptBot',
  } as any);
  const sessionReply = vi.fn(async (...args: unknown[]) => {
    const replyOpts = args[5] as { beforeWrite?: () => unknown } | undefined;
    await replyOpts?.beforeWrite?.();
    return `om_reply_${sessionReply.mock.calls.length}`;
  });
  workerPool.initWorkerPool({
    sessionReply, getSessionWorkingDir: () => h.workingDir, getActiveCount: () => 1, closeSession: vi.fn(),
  } as any);

  /** One daemon's view of the session; a restored one carries the record the
   *  previous daemon kept for it. */
  const daemonSession = (generation: number, record?: DaemonSession['session']) => ({
    session: {
      sessionId: h.sessionId, chatId: 'oc_test', chatType: 'group', status: 'active', cliId: 'claude-code',
      createdAt: new Date().toISOString(), promptInjection: 'none',
      replyTargets: { [TURN]: { rootMessageId: TURN, senderOpenId: caller.requestUserOpenId, updatedAt: new Date().toISOString() } },
      quoteTargetId: TURN, quoteTargetSenderOpenId: caller.requestUserOpenId,
      ...(record ? structuredClone(record) : {}),
      workerGeneration: generation,
    },
    larkAppId: APP, chatId: 'oc_test', chatType: 'group', scope: 'chat',
    workerGeneration: generation, workerPort: 0, workerToken: 'token',
    spawnedAt: Date.now(), cliVersion: '1', lastMessageAt: Date.now(), hasHistory: generation > 1,
  } as unknown as DaemonSession);

  /** forkWorker for one generation: contract bootstrap, init, IPC handlers. */
  const fork = (ds: DaemonSession, generation: number) => {
    const controller = controllerForSession(ds, true)!;
    closeContract ??= () => controller.store.close();
    const init = {
      type: 'init' as const, sessionId: h.sessionId, cliId: 'claude-code', backendType: 'tmux' as const,
      promptInjection: 'none' as const, replyDelivery: 'transcript' as const,
      ...(generation > 1 ? { resume: true } : {}), prompt: '',
      restartAttemptId: controller.prepareWorkerStart(), sessionContract: controller.bindWorker(generation),
    };
    ds.initConfig = init as any;
    const g = h.startWorker(init as any);
    (ds as any).worker = g.child;
    workerPool.__testOnly_setupWorkerHandlers(ds, g.child as any, undefined, generation);
    return g;
  };

  const ds1 = daemonSession(1);
  const first = fork(ds1, 1);
  const replies = () => sessionReply.mock.calls.map(args => String(args[1]));
  const repliesWith = (text: string) => replies().filter(reply => reply.includes(text));

  /** The message that starts the review: answered, then the CLI is idle. */
  const ask = async (g: Generation) => {
    await g.waitFor(() => g.messages.some(m => m.type === 'prompt_ready'), 'the worker to be ready', 60_000);
    expect(workerPool.sendWorkerInput(ds1, TEXT, TURN, { trustedCaller: caller })).toBe(true);
    await g.waitFor(() => repliesWith(`reply: ${TEXT}`).length > 0, 'the answer to the message', 60_000);
    await g.waitFor(() => {
      const at = h.doneAt('turn', `reply: ${TEXT}`);
      return at !== undefined && g.readyAt.some(ready => ready > at);
    }, 'the CLI back at its prompt');
  };

  /** The daemon's shutdown for a persistent backend, then the new daemon's restore. */
  const restartDaemon = async (g: Generation) => {
    const exited = new Promise(done => g.child.once('exit', done));
    ds1.worker = null;
    g.child.kill('SIGTERM');
    await exited;
    const ds2 = daemonSession(2, ds1.session);
    const next = fork(ds2, 2);
    await next.waitFor(() => next.messages.some(m => m.type === 'prompt_ready'), 'the re-attached CLI to be ready', 60_000);
    return next;
  };

  /** `/clear` typed through the group: the CLI moves to another conversation
   *  in process, so the session contract re-binds its runtime. */
  const clear = async (g: Generation) => {
    expect(workerPool.sendWorkerSessionInput(ds1, { type: 'raw_input', content: '/clear', turnId: 'om_clear' })).toBe(true);
    await g.waitFor(() => g.messages.some(m => m.type === 'cli_session_id' && m.cliSessionId === h.clearSid),
      'the worker to follow the CLI onto its new conversation', 60_000);
    // One bridge tick for the transcript watcher to move with it.
    await sleep(1_500);
  };

  /** The background task finishes: Claude wakes up and writes its verdict. */
  const wake = async (g: Generation) => {
    h.notify(VERDICT);
    await g.waitFor(() => repliesWith(VERDICT).length > 0, 'the verdict written after the wake-up to reach the group', 60_000);
    // A duplicate would follow within a bridge tick or two.
    await sleep(3_000);
  };
  return { first, ask, clear, restartDaemon, wake, repliesWith };
}

describe.skipIf(!runnable)('a zero-prompt Claude session woken by its background task', () => {
  it('posts the answer Claude writes after the wake-up', async () => {
    const s = zeroPromptSession();
    await s.ask(s.first);
    await s.wake(s.first);
    expect(s.repliesWith(VERDICT), s.first.logs.join('')).toHaveLength(1);
  }, 150_000);

  it('posts it after /clear moved the CLI to another conversation before the wake-up', async () => {
    const s = zeroPromptSession();
    await s.ask(s.first);
    await s.clear(s.first);
    await s.wake(s.first);
    expect(s.repliesWith(VERDICT), s.first.logs.join('')).toHaveLength(1);
  }, 150_000);

  it('posts it after a daemon restart re-attached the CLI before the wake-up', async () => {
    const s = zeroPromptSession();
    await s.ask(s.first);
    const next = await s.restartDaemon(s.first);
    await s.wake(next);
    expect(s.repliesWith(VERDICT), next.logs.join('')).toHaveLength(1);
  }, 240_000);
});
