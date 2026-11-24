/**
 * An Antigravity turn still running when the daemon restarts must get its reply
 * once the new daemon's worker re-attaches the CLI that keeps running it.
 *
 * Production (2026-11-19 21:34Z, v3.59.22): a fleet restart re-attached a live
 * agy in the middle of a long turn. The new worker's first runtime binding
 * carried only the process (pid + start time); agy's conversation id, which the
 * old worker's runtime had, arrived a moment later and enriched the new runtime
 * in place. The session contract therefore never tied the new runtime to the
 * old one, and the turn's execution stayed on the old worker's: when the turn
 * ended eight hours later its final reply was refused as
 * `execution_scope_unproven`, and the group got only the notice that the reply
 * could not be posted.
 *
 * Real worker, real tmux backend on a private socket, and a fake agy that keeps
 * its state the way agy does (a per-process `--log-file` naming the streaming
 * conversation, a presence lock held open for it, brain transcripts, the submit
 * history); the daemon side is the real worker IPC handler with the real SQLite
 * session contract. A daemon restart is SIGTERM to the worker (the pane and agy
 * survive), then a fresh daemon session object forks the next generation.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

import { preferredManagedTmuxSocket } from '../src/adapters/backend/tmux-socket.js';
import * as bots from '../src/bot-registry.js';
import { config } from '../src/config.js';
import { controllerForSession } from '../src/core/session-controller.js';
import type { DaemonSession } from '../src/core/types.js';
import * as workerPool from '../src/core/worker-pool.js';
import { t } from '../src/i18n/index.js';
import * as sessionStore from '../src/services/session-store.js';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';
import { killProcessTree } from './helpers/process-tree.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

const runnable = process.platform === 'linux' && probeTmuxFunctional().ok;

const APP = 'cli_reattach_agy';
const TURN = 'om_agy_restart_turn';
const TEXT = 'agy question across the restart';
const caller = { requestUserOpenId: 'ou_requester', requestLarkAppId: APP, senderType: 'user' as const };

const cleanups: Array<() => Promise<void> | void> = [];
let previousDataDir: string | undefined;
let closeContract: (() => void) | undefined;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup(); } catch { /* best effort */ } }
  closeContract?.(); closeContract = undefined;
  workerPool.__testOnly_resetOrdinaryImDeliveries();
  if (previousDataDir !== undefined) config.session.dataDir = previousDataDir;
  previousDataDir = undefined;
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

/** agy as botmux drives it: a TUI in a tmux pane that answers each typed
 *  prompt in its conversation's brain transcript, and only finishes the turn
 *  once the test lets it. */
const FAKE_AGY = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cfg = JSON.parse(fs.readFileSync(__CONFIG__, 'utf8'));
if (process.argv.includes('--version')) { console.log('1.4.7'); process.exit(0); }
const args = process.argv.slice(2);
const after = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const logFile = after('--log-file');
const ev = o => fs.appendFileSync(cfg.events, JSON.stringify({ t: Date.now(), pid: process.pid, ...o }) + '\\n');
ev({ kind: 'start', args });
const home = path.join(cfg.home, '.gemini', 'antigravity-cli');
const logs = path.join(home, 'brain', cfg.conversationId, '.system_generated', 'logs');
for (const dir of [logs, path.join(home, 'conversations'), path.join(home, 'presence')]) fs.mkdirSync(dir, { recursive: true });
let presence;
let conversation;
// agy creates its conversation with the first prompt: it streams it to the
// native log and holds the conversation open from then on.
const openConversation = () => {
  if (presence !== undefined) return;
  conversation = fs.openSync(path.join(home, 'conversations', cfg.conversationId + '.db'), 'a');
  presence = fs.openSync(path.join(home, 'presence', cfg.conversationId + '.lock'), 'a');
  if (logFile) fs.appendFileSync(logFile, 'I1120 Streaming conversation ' + cfg.conversationId + '\\n');
};
// agy keeps redrawing its working line (spinner and elapsed time) while a turn runs.
let spinner;
let spin = 0;
const ready = () => {
  clearInterval(spinner); spinner = undefined;
  if (cfg.plainBusy) process.stdout.write('\\x1b[2J\\x1b[H────────\\r\\n>\\r\\n────────\\r\\n? for shortcuts\\r\\n');
  else process.stdout.write('\\x1b[2J\\x1b[H? for shortcuts\\r\\n');
};
const busy = () => {
  if (cfg.plainBusy) {
    process.stdout.write('\\x1b[2J\\x1b[H────────\\r\\n>\\r\\n────────\\r\\n? for shortcuts\\r\\n');
    return;
  }
  const draw = () => process.stdout.write('\\x1b[2J\\x1b[H  ' + '|/-\\\\'[spin++ % 4] + ' Working… (' + spin + 's)  esc to cancel\\r\\n');
  draw();
  if (!spinner) spinner = setInterval(draw, 250);
};
const record = o => {
  const line = JSON.stringify({ created_at: new Date().toISOString(), ...o }) + '\\n';
  fs.appendFileSync(path.join(logs, 'transcript.jsonl'), line);
  fs.appendFileSync(path.join(logs, 'transcript_full.jsonl'), line);
};
process.stdin.setRawMode && process.stdin.setRawMode(true);
setTimeout(ready, 150);
let buf = '';
let step = 0;
process.stdin.on('data', chunk => {
  buf += chunk.toString();
  let at;
  while ((at = buf.indexOf('\\r')) >= 0) {
    const payload = buf.slice(0, at).replace(/\\x1b\\[20[01]~/g, '').trim();
    buf = buf.slice(at + 1);
    if (payload) submit(payload);
  }
});
function submit(payload) {
  openConversation();
  fs.appendFileSync(path.join(home, 'history.jsonl'), JSON.stringify({
    display: payload, workspace: cfg.workingDir, timestamp: Date.now(), conversationId: cfg.conversationId,
  }) + '\\n');
  busy();
  record({ step_index: step++, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE',
    content: '<USER_REQUEST>\\n' + payload + '\\n</USER_REQUEST>' });
  if (cfg.plainBusy) record({ step_index: step++, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
    tool_calls: [{ name: 'run_command', args: { CommandLine: 'sleep 3600' } }] });
  ev({ kind: 'submit', text: payload });
  const finish = setInterval(() => {
    if (!fs.existsSync(cfg.finishGate)) return;
    clearInterval(finish);
    const reply = 'reply: ' + payload;
    record({ step_index: step++, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: reply, model: 'gemini-test' });
    ev({ kind: 'turn', reply });
    setTimeout(ready, 300);
  }, 50);
}
setInterval(() => { void presence; void conversation; }, 1000);
`;

function liveAntigravitySession(opts: { plainBusy?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bmx-agy-reattach-'));
  const workingDir = join(root, 'work');
  const dataDir = join(root, 'data');
  for (const dir of [workingDir, dataDir]) mkdirSync(dir, { recursive: true });
  const sessionId = randomUUID();
  const conversationId = randomUUID();
  const events = join(root, 'events.jsonl');
  const finishGate = join(root, 'finish-gate');
  const configFile = join(root, 'fake-agy.json');
  writeFileSync(configFile, JSON.stringify({ home: root, workingDir, conversationId, events, finishGate, plainBusy: opts.plainBusy === true }));
  // An extensionless script follows the nearest package.json; never inherit a
  // stray `"type": "module"` from a parent directory.
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
  const fakeAgy = join(root, 'agy');
  writeFileSync(fakeAgy, FAKE_AGY.replace('__CONFIG__', JSON.stringify(configFile)));
  chmodSync(fakeAgy, 0o755);
  const readEvents = (): Array<Record<string, unknown>> => existsSync(events)
    ? readFileSync(events, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
    : [];
  cleanups.push(() => {
    for (const pid of new Set(readEvents().map(e => e.pid as number))) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ }
    }
    // Never a bare kill-server: managed sessions live on the dedicated socket under this root.
    for (const name of new Set(['default', preferredManagedTmuxSocket() ?? 'default'])) {
      const socket = join(root, `tmux-${process.getuid?.() ?? 0}`, name);
      try { execFileSync('tmux', ['-S', socket, 'kill-server'], { env: privateTmuxEnv(root), stdio: 'ignore' }); } catch { /* gone */ }
    }
    rmSync(root, { recursive: true, force: true });
  });

  previousDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);
  vi.spyOn(bots, 'getBot').mockReturnValue({
    config: { larkAppId: APP, larkAppSecret: 'secret', cliId: 'antigravity', promptInjection: 'none' },
    resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'AgyRestartBot',
  } as any);
  const sessionReply = vi.fn(async (..._args: unknown[]) => 'om_reply');
  workerPool.initWorkerPool({
    sessionReply, getSessionWorkingDir: () => workingDir, getActiveCount: () => 1, closeSession: vi.fn(),
  } as any);

  const daemonSession = (generation: number) => ({
    session: { sessionId, chatId: 'oc_test', chatType: 'group', status: 'active', cliId: 'antigravity', promptInjection: 'none',
      createdAt: new Date().toISOString(), workerGeneration: generation,
      replyTargets: { [TURN]: { rootMessageId: TURN, senderOpenId: caller.requestUserOpenId, updatedAt: new Date().toISOString() } } },
    larkAppId: APP, chatId: 'oc_test', chatType: 'group', scope: 'chat',
    workerGeneration: generation, workerPort: 0, workerToken: 'token',
    spawnedAt: Date.now(), cliVersion: '1', lastMessageAt: Date.now(), hasHistory: true,
  } as unknown as DaemonSession);

  type Generation = { child: ChildProcess; messages: WorkerToDaemon[]; logs: string[];
    waitFor: (cond: () => boolean, what: string, timeoutMs?: number) => Promise<void> };
  const startWorker = (init: DaemonToWorker): Generation => {
    const messages: WorkerToDaemon[] = [];
    const logs: string[] = [];
    const spawnOptions: SpawnOptions = {
      cwd: resolve('.'),
      env: privateTmuxEnv(root, {
        HOME: root, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sessionId,
        LARK_APP_ID: APP, LARK_APP_SECRET: 'secret', AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
      }),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    };
    const child = process.env.BOTMUX_TEST_WORKER_BINARY
      ? spawn(process.env.BOTMUX_TEST_WORKER_BINARY, ['__worker'], spawnOptions)
      : spawnNodeTsScript(resolve('src/worker.ts'), [], spawnOptions);
    child.on('message', m => { messages.push(m as WorkerToDaemon); });
    child.stdout?.on('data', b => logs.push(b.toString()));
    child.stderr?.on('data', b => logs.push(b.toString()));
    cleanups.push(() => killProcessTree(child, 3_000));
    child.send(init);
    return {
      child, messages, logs,
      waitFor: async (cond, what, timeoutMs = 60_000) => {
        const deadline = Date.now() + timeoutMs;
        while (!cond()) {
          if (Date.now() >= deadline || child.exitCode !== null) {
            throw new Error(`timed out waiting for ${what}\n${logs.join('').slice(-12_000)}`);
          }
          await sleep(50);
        }
      },
    };
  };

  const fork = (ds: DaemonSession, generation: number) => {
    const controller = controllerForSession(ds, true)!;
    closeContract ??= () => controller.store.close();
    const restartAttemptId = controller.prepareWorkerStart();
    const sessionContract = controller.bindWorker(generation);
    const init = {
      type: 'init' as const, sessionId, chatId: 'oc_test', rootMessageId: 'om_root', workingDir,
      cliId: 'antigravity' as const, cliPathOverride: fakeAgy, backendType: 'tmux' as const,
      // The new daemon restores the session with the conversation the old one persisted.
      resume: generation > 1, ...(generation > 1 ? { cliSessionId: conversationId } : {}),
      // As on the affected bot: replies come from agy's transcript, not `botmux send`.
      prompt: '', promptInjection: 'none' as const, larkAppId: APP, larkAppSecret: 'secret', locale: 'zh' as const,
      restartAttemptId, sessionContract,
      finalOutputHandoff: { version: 2 as const, token: randomUUID(), admitNew: false },
    };
    ds.initConfig = init as any;
    const g = startWorker(init as DaemonToWorker);
    (ds as any).worker = g.child;
    workerPool.__testOnly_setupWorkerHandlers(ds, g.child as any, undefined, generation);
    return { g, controller };
  };

  const ds1 = daemonSession(1);
  const first = fork(ds1, 1);
  const replies = () => sessionReply.mock.calls.map(args => String(args[1]));
  const turnReplies = () => replies().filter(text => text.includes(`reply: ${TEXT}`));
  const notice = (['zh', 'en'] as const).map(locale => t('worker.final_output_undelivered', undefined, locale).split('{recovery}')[0]!);
  const undeliveredNotices = () => replies().filter(text => notice.some(head => text.startsWith(head)));
  const submitted = (text = TEXT) => readEvents().some(e => e.kind === 'submit' && String(e.text).includes(text));
  const submitCount = (text = TEXT) => readEvents().filter(e => e.kind === 'submit' && String(e.text).includes(text)).length;
  const answered = () => readEvents().some(e => e.kind === 'turn' && String(e.reply).includes(TEXT));
  const execution = () => first.controller.store.executions(first.controller.ref).find(value => value.ref.turnId === TURN);
  const agyPids = () => new Set(readEvents().filter(e => e.kind === 'start').map(e => e.pid as number));

  const startTurn = async () => {
    const g = first.g;
    await g.waitFor(() => g.messages.some(m => m.type === 'prompt_ready'), 'the first worker to be ready');
    expect(workerPool.sendWorkerInput(ds1, TEXT, TURN, { trustedCaller: caller })).toBe(true);
    await g.waitFor(submitted, 'the message typed into agy');
    // The first worker learned the conversation it runs in: its runtime names it.
    await vi.waitFor(() => {
      expect(execution()?.runtime).toBeDefined();
      expect(first.controller.store.runtime(first.controller.ref, execution()!.runtime!.runtimeId)?.identity?.nativeSessionId)
        .toBe(conversationId);
    }, { timeout: 20_000 });
    // The turn runs a while before the restart. A transcript the re-attached
    // worker sees born seconds before itself reads as a conversation agy just
    // started, not one to recover.
    await sleep(6_000);
  };

  /** The old daemon's shutdown (SIGTERM; the pane and agy survive), then the
   *  new daemon's restore. `beforeReattach` runs while no worker is attached. */
  const restartDaemon = async (opts: { beforeReattach?: () => Promise<void> } = {}) => {
    const exited = new Promise(done => first.g.child.once('exit', done));
    ds1.worker = null;
    first.g.child.kill('SIGTERM');
    await exited;
    await opts.beforeReattach?.();
    const ds2 = daemonSession(2);
    return { ...fork(ds2, 2), ds: ds2 };
  };
  const finish = () => writeFileSync(finishGate, 'go');
  return { root, dataDir, conversationId, first, execution, startTurn, restartDaemon, finish, answered,
    turnReplies, undeliveredNotices, agyPids, submitted, submitCount };
}

describe.skipIf(!runnable)('an Antigravity turn running across a daemon restart', () => {
  it('gets its reply once the new worker re-attaches agy and the turn ends', async () => {
    const s = liveAntigravitySession();
    await s.startTurn();
    const { g: next, controller } = await s.restartDaemon();
    await next.waitFor(() => next.messages.some(m => m.type === 'ready'), 'the new worker to re-attach');
    // The re-attached agy's runtime knows its conversation, as it did in
    // production long before the turn ended.
    await vi.waitFor(() => {
      expect(controller.store.runtime(controller.ref)?.identity?.nativeSessionId).toBe(s.conversationId);
    }, { timeout: 20_000 });
    expect(s.answered()).toBe(false);

    s.finish();
    await next.waitFor(() => s.turnReplies().length > 0 || s.undeliveredNotices().length > 0,
      'the reply to the turn that ran across the restart', 90_000);
    // A duplicate would follow within a bridge tick or two.
    await sleep(3_000);
    const log = next.logs.join('');
    expect(s.undeliveredNotices(), log).toEqual([]);
    expect(s.turnReplies(), log).toHaveLength(1);
    expect(s.agyPids().size).toBe(1);
    // The turn settled on the runtime the re-attached agy reports under.
    await vi.waitFor(() => expect(s.execution()).toMatchObject({ phase: 'succeeded', runtime: controller.currentRuntime() }),
      { timeout: 10_000 });
  }, 240_000);

  it('gets its reply once when the turn ended while no worker was attached', async () => {
    const s = liveAntigravitySession();
    await s.startTurn();
    // agy finishes the turn during the restart: the new worker finds the answer
    // in the transcript as soon as it re-attaches.
    const { g: next } = await s.restartDaemon({
      beforeReattach: async () => {
        s.finish();
        await vi.waitFor(() => expect(s.answered()).toBe(true), { timeout: 30_000, interval: 100 });
      },
    });
    await next.waitFor(() => s.turnReplies().length > 0 || s.undeliveredNotices().length > 0,
      'the reply to the turn that ended during the restart', 90_000);
    await sleep(3_000);
    const log = next.logs.join('');
    expect(s.undeliveredNotices(), log).toEqual([]);
    expect(s.turnReplies(), log).toHaveLength(1);
    expect(s.agyPids().size).toBe(1);
    await vi.waitFor(() => expect(s.execution()?.phase).toBe('succeeded'), { timeout: 10_000 });
    // Nothing was held back on the bot's machine either.
    expect(existsSync(join(s.dataDir, 'undelivered-replies')) && readdirSync(join(s.dataDir, 'undelivered-replies')).length > 0).toBe(false);
  }, 240_000);

  it('keeps reattach input held, then releases it through a fresh /restart cold resume', async () => {
    const s = liveAntigravitySession({ plainBusy: true });
    await s.startTurn();
    const { g: next, ds, controller } = await s.restartDaemon();
    await next.waitFor(() => next.messages.some(m => m.type === 'ready'), 'the worker to reattach a plain busy composer');
    const followUp = 'queued follow-up released by cold restart';
    expect(workerPool.sendWorkerInput(ds, followUp, 'om_agy_cold_restart_escape', { trustedCaller: caller })).toBe(true);
    await sleep(7_500);
    // The surviving CLI has only a type-ahead composer and an unfinished tool:
    // strict reattach must not trust that composer as turn-terminal evidence.
    expect(s.submitted(followUp)).toBe(false);
    expect(next.messages.some(m => m.type === 'prompt_ready')).toBe(false);

    const { operation } = controller.beginControl('restart');
    controller.controlStarted(operation.operationId);
    const attemptId = operation.operationId;
    next.child.send({ type: 'restart', attemptId } satisfies DaemonToWorker);
    await next.waitFor(() => s.submitted(followUp), 'the queued follow-up after the fresh cold resume', 30_000);
    expect(s.submitCount(followUp)).toBe(1);
    await next.waitFor(() => next.messages.some(m => m.type === 'restart_result'
      && m.attemptId === attemptId && m.status === 'succeeded'), 'the cold restart receipt', 15_000);
  }, 240_000);
});
