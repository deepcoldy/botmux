/**
 * The live-worker cap must not suspend a session whose answer to the turn that
 * just ended is still on its way to the group.
 *
 * Production (2026-11-11, v3.59.1): a bot over its live-worker cap of 30. A
 * Claude session finished a turn with a plain answer (no `botmux send`), which
 * goes out through the transcript fallback. The worker handed the answer to
 * the daemon and reported the turn's end; 114 ms later the CLI's idle edge ran
 * the cap sweep, which picked this session: idle screen, no background task,
 * no input waiting for the CLI. The suspend took the worker away while the
 * daemon was still writing the answer to Lark; the write found the worker gone
 * and gave up without a word, so the group never got the reply.
 *
 * Real worker, real tmux backend on a private socket, a fake CLI (Claude Code
 * and Codex); the daemon side is the real worker IPC handler, the real session
 * contract and the real cap sweep, run on every idle edge the way the daemon
 * wires it. The bot holds one session over its cap; the other live session is
 * busy, so the session under test is the only reclaim candidate. The answer's
 * Lark write stays in flight until the daemon has seen the session go idle (in
 * production Claude's idle signal came 100 ms after the answer, inside the
 * ~1.5 s a write takes) and re-checks ownership right before it lands, as the
 * real client does.
 */
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
import { sweepIdleWorkersAfterTurnDrain } from '../src/core/idle-worker-sweeper.js';
import { __testOnly_resetBotTurnMutationGates } from '../src/core/bot-turn-mutation-gate.js';
import type { DaemonSession } from '../src/core/types.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import {
  claudeHarnessRunnable as runnable,
  cleanUpClaudeHarnesses,
  setupFakeClaude,
} from './helpers/claude-worker-harness.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { killProcessTree } from './helpers/process-tree.js';
import { killWorkerTmuxSession } from './helpers/worker-tmux-session.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

const APP = 'app_test';
const TURN = 'om_cap_turn';
const TEXT = 'cap question';
const caller = { requestUserOpenId: 'ou_requester', requestLarkAppId: APP, senderType: 'user' as const };

let previousDataDir: string | undefined;
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  while (cleanups.length) {
    try { await cleanups.pop()!(); } catch { /* best effort */ }
  }
  await cleanUpClaudeHarnesses();
  workerPool.__testOnly_resetOrdinaryImDeliveries();
  workerPool.__testOnly_setSuspendBackingVerifier();
  __testOnly_resetBotTurnMutationGates();
  if (previousDataDir !== undefined) config.session.dataDir = previousDataDir;
  previousDataDir = undefined;
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

interface StartedWorker { child: ChildProcess; logs: string[]; messages: WorkerToDaemon[] }

/**
 * The daemon side for one session answering TURN on a bot one session over
 * its cap of one. `start` launches the worker with the init the daemon built.
 */
function overCapDaemon(opts: {
  sessionId: string;
  cliId: 'claude-code' | 'codex';
  dataDir: string;
  workingDir: string;
  start: (init: Record<string, unknown>) => StartedWorker;
  /** Run the cap sweep on idle edges (default); off to watch another path. */
  capSweep?: boolean;
}) {
  previousDataDir = config.session.dataDir;
  config.session.dataDir = opts.dataDir;
  mkdirSync(opts.dataDir, { recursive: true });
  vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);
  vi.spyOn(bots, 'getBot').mockReturnValue({
    config: { larkAppId: APP, larkAppSecret: 'secret', cliId: opts.cliId },
    resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'CapBot',
  } as any);
  // The daemon proves the tmux backing gone before a suspend; the worker's
  // pane lives on this test's private socket, which the daemon side does not
  // probe. The worker's own suspend cleanup still runs.
  workerPool.__testOnly_setSuspendBackingVerifier(() => true);

  const ds = {
    session: {
      sessionId: opts.sessionId, chatId: 'oc_test', chatType: 'group', status: 'active', cliId: opts.cliId,
      createdAt: new Date().toISOString(), workerGeneration: 1,
      replyTargets: { [TURN]: { rootMessageId: TURN, senderOpenId: caller.requestUserOpenId, updatedAt: new Date().toISOString() } },
    },
    larkAppId: APP, chatId: 'oc_test', chatType: 'group', scope: 'chat',
    workerGeneration: 1, workerPort: 0, workerToken: 'token',
    spawnedAt: Date.now(), cliVersion: '1', lastMessageAt: Date.now(),
  } as unknown as DaemonSession;
  // Another live session of the bot, mid-turn: never a candidate itself.
  const busy = {
    session: { sessionId: 'busy-session', status: 'active' },
    larkAppId: APP, initConfig: { backendType: 'tmux' },
    worker: { killed: false }, lastScreenStatus: 'working', lastMessageAt: 0,
  } as unknown as DaemonSession;
  const activeSessions = new Map<string, DaemonSession>([['busy', busy], ['under-test', ds]]);

  /** Answers that reached Lark, and whether the worker was still live then. */
  const delivered: Array<{ content: string; workerLive: boolean }> = [];
  const sessionReply = vi.fn(async (...args: unknown[]) => {
    const replyOpts = args[5] as { beforeWrite?: () => unknown } | undefined;
    const deadline = Date.now() + 30_000;
    while (ds.lastScreenStatus !== 'idle' && Date.now() < deadline) await sleep(20);
    // The idle edge's cap sweep runs well within this.
    await sleep(500);
    await replyOpts?.beforeWrite?.();
    delivered.push({ content: String(args[1]), workerLive: !!ds.worker });
    return `om_reply_${delivered.length}`;
  });
  workerPool.initWorkerPool({
    sessionReply, getSessionWorkingDir: () => opts.workingDir, getActiveCount: () => activeSessions.size,
    closeSession: vi.fn(),
    enforceLiveSessionCap: () => {
      if (opts.capSweep !== false) void sweepIdleWorkersAfterTurnDrain(APP, activeSessions, { maxLiveWorkers: 1 });
    },
  } as any);

  const controller = controllerForSession(ds, true)!;
  cleanups.push(() => controller.store.close());
  const init = {
    type: 'init' as const, sessionId: opts.sessionId, cliId: opts.cliId, backendType: 'tmux' as const,
    promptInjection: undefined, prompt: TEXT, turnId: TURN, trustedCaller: caller,
    restartAttemptId: controller.prepareWorkerStart(), sessionContract: controller.bindWorker(1),
    sessionCommand: { version: 2 as const, execution: controller.admitInput(TURN) },
  };
  ds.initConfig = init as any;
  const worker = opts.start(init);
  (ds as any).worker = worker.child;
  workerPool.__testOnly_setupWorkerHandlers(ds, worker.child as any, undefined, 1);

  const answers = () => delivered.filter(entry => entry.content.includes(`reply: ${TEXT}`));
  return { ds, worker, answers };
}

async function waitFor(worker: StartedWorker, cond: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() >= deadline || worker.child.exitCode !== null) {
      throw new Error(`timed out waiting for ${what}\n${worker.logs.join('')}`);
    }
    await sleep(50);
  }
}

/** The answer went out while the worker was live, and then (the bot still
 *  over its cap) the session was suspended. */
async function expectAnsweredThenSuspended(
  ds: DaemonSession,
  worker: StartedWorker,
  answers: () => Array<{ workerLive: boolean }>,
): Promise<void> {
  await waitFor(worker, () => worker.messages.some(m => m.type === 'final_output'), 'the answer handed to the daemon', 90_000);
  await vi.waitFor(() => expect(ds.worker).toBeNull(), { timeout: 30_000, interval: 50 });
  // A write abandoned by the suspend would have landed by now.
  await sleep(3_000);
  const log = worker.logs.join('');
  expect(answers(), log).toHaveLength(1);
  expect(answers()[0]!.workerLive, log).toBe(true);
  expect(ds.session.suspendedColdResume).toBe(true);
}

describe.skipIf(!runnable)('the live-worker cap and an answer still being delivered', () => {
  it('waits for a Claude transcript answer to reach Lark before suspending the session', async () => {
    const h = setupFakeClaude({ turnMs: 800 });
    const { ds, worker, answers } = overCapDaemon({
      sessionId: h.sessionId, cliId: 'claude-code', dataDir: join(h.root, 'data'), workingDir: h.workingDir,
      start: init => h.startWorker(init as any),
    });
    await expectAnsweredThenSuspended(ds, worker, answers);
  }, 150_000);

  it('waits for a Codex rollout answer to reach Lark before suspending the session', async () => {
    // Short: the tmux socket lives under it.
    const root = mkdtempSync('/tmp/bmx-cap-codex-');
    const work = join(root, 'work');
    const dataDir = join(root, 'data');
    mkdirSync(work, { recursive: true });
    // An extensionless script follows the nearest package.json.
    writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
    const bin = join(root, 'codex');
    copyFileSync(resolve('test/fixtures/fake-codex-rollout.cjs'), bin);
    chmodSync(bin, 0o755);
    const sessionId = randomUUID();
    const env = privateTmuxEnv(root, {
      HOME: root, SHELL: '/bin/sh', SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: APP, LARK_APP_SECRET: 'secret',
    });
    let child: ChildProcess | undefined;
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    cleanups.push(() => killWorkerTmuxSession(`bmx-${sessionId.slice(0, 8)}`, env));
    cleanups.push(() => child && killProcessTree(child, 3_000));
    const { ds, worker, answers } = overCapDaemon({
      sessionId, cliId: 'codex', dataDir, workingDir: work,
      start: init => {
        const messages: WorkerToDaemon[] = [];
        const logs: string[] = [];
        child = spawnNodeTsScript(resolve('src/worker.ts'), [], {
          cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        child.on('message', m => messages.push(m as WorkerToDaemon));
        child.stdout?.on('data', b => logs.push(b.toString()));
        child.stderr?.on('data', b => logs.push(b.toString()));
        child.send({
          chatId: 'oc_test', rootMessageId: 'om_root', workingDir: work, cliPathOverride: bin,
          larkAppId: APP, larkAppSecret: 'secret', locale: 'zh', ...init,
        } as unknown as DaemonToWorker);
        return { child, logs, messages };
      },
    });
    await expectAnsweredThenSuspended(ds, worker, answers);
  }, 150_000);

  it('carries out a suspend queued while the turn ran only after its answer reached Lark', async () => {
    // Production (2026-11-11, session fc17c9ee): `botmux suspend` queued while
    // the session worked; at the turn's end the queued suspend ran on the idle
    // edge, 100 ms after the worker handed the answer over, and the answer
    // never reached the group.
    const h = setupFakeClaude({ turnMs: 800 });
    const { ds, worker, answers } = overCapDaemon({
      sessionId: h.sessionId, cliId: 'claude-code', dataDir: join(h.root, 'data'), workingDir: h.workingDir,
      start: init => h.startWorker(init as any), capSweep: false,
    });
    await waitFor(worker, () => ds.lastScreenStatus === 'working', 'the turn running', 90_000);
    // What the suspend route does for a session mid-turn.
    ds.pendingSuspendReason = 'manual_suspend';
    ds.pendingSuspendGeneration = ds.workerGeneration;
    await expectAnsweredThenSuspended(ds, worker, answers);
    expect(ds.pendingSuspendReason).toBeUndefined();
  }, 150_000);
});
