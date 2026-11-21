/**
 * Worker-level proof for the "已读不回" field report: a mojo turn whose remote
 * session is stuck busy must reach the daemon as an explicit failed turn with a
 * visible reason — not as `completed` with no reply, which is what the daemon
 * renders as an empty, successful-looking reply card.
 *
 * Real worker process + the 1.0.13 stand-in from test/helpers/fake-mojo-remote.ts
 * (session RUNNING, current turn COMPLETED, every new prompt only queued).
 */
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import {
  liveSession,
  stuckSession,
  writeFakeMojoRemote,
  type FakeMojoRemote,
  type FakeMojoSession,
  type FakeMojoState,
} from './helpers/fake-mojo-remote.js';

const SID = 'c0ffee00-5e55-4a1d-9b0e-0000000b0581';
const STUCK_TURN = '7e1d0c3a-2f6b-4c55-8e21-d0e5c0de7a11';
const TURN_ID = 'om_mojo_busy_dispatch';

type Terminal = Extract<WorkerToDaemon, { type: 'turn_terminal' }>;
type Final = Extract<WorkerToDaemon, { type: 'final_output' }>;

async function waitFor(predicate: () => boolean, timeoutMs: number, describeFailure: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>(r => setTimeout(r, 100));
  }
  throw new Error(describeFailure());
}

interface WorkerRun {
  fake: FakeMojoRemote;
  child: ChildProcess;
  messages: WorkerToDaemon[];
  logs: () => string;
  dispose(): void;
}

/** Real worker on a mojo bot whose remote is the 1.0.13 stand-in; the first
 *  message resumes SID. */
function bootWorker(
  sessions: Record<string, FakeMojoSession>,
  first: { prompt: string; turnId: string },
  backendConfig?: Record<string, unknown>,
  answer?: string,
): WorkerRun {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-mojo-busy-')));
  const fake = writeFakeMojoRemote(root, sessions, { queueWaitMs: 200, ...(answer !== undefined ? { answer } : {}) });
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  const appId = 'app_mojo_busy';
  const botsPath = join(root, 'bots.json');
  writeFileSync(botsPath, JSON.stringify([{
    larkAppId: appId, larkAppSecret: 'secret', cliId: 'mojo', backendType: 'mojo',
  }]));
  const child = spawnTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      SESSION_DATA_DIR: root,
      BOTS_CONFIG: botsPath,
      BOTMUX_SESSION_ID: 'sid-mojo-busy',
      LARK_APP_ID: appId,
      LARK_APP_SECRET: 'secret',
      PATH: `${root}:${process.env.PATH ?? ''}`,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.on('data', c => logs.push(c.toString()));
  child.stderr?.on('data', c => logs.push(c.toString()));
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.send({
    type: 'init',
    sessionId: 'sid-mojo-busy',
    chatId: 'oc_mojo_busy',
    rootMessageId: 'om_mojo_busy_root',
    workingDir: root,
    cliId: 'mojo',
    backendType: 'mojo',
    ...(backendConfig ? { backendConfig } : {}),
    prompt: first.prompt,
    turnId: first.turnId,
    riffParentTaskId: SID,
    larkAppId: appId,
    larkAppSecret: 'secret',
  } as DaemonToWorker);
  return {
    fake, child, messages,
    logs: () => logs.join(''),
    dispose() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const terminalsOf = (messages: WorkerToDaemon[], turnId: string) =>
  messages.filter((m): m is Terminal => m.type === 'turn_terminal' && m.turnId === turnId);
const finalsOf = (messages: WorkerToDaemon[], turnId: string) =>
  messages.filter((m): m is Final => m.type === 'final_output' && m.turnId === turnId);

async function runStuckTurn(): Promise<{ messages: WorkerToDaemon[]; logs: string; remote: FakeMojoState }> {
  const run = bootWorker({ [SID]: stuckSession(STUCK_TURN) }, { prompt: '派单：请处理 issue 42', turnId: TURN_ID });
  try {
    await waitFor(
      () => terminalsOf(run.messages, TURN_ID).length > 0,
      30_000,
      () => `no turn_terminal for ${TURN_ID}\n${run.logs()}`,
    );
    // Let any trailing IPC for the same boundary arrive.
    await new Promise<void>(r => setTimeout(r, 300));
    return { messages: run.messages, logs: run.logs(), remote: run.fake.read() };
  } finally {
    run.dispose();
  }
}

describe('mojo worker: remote session stuck busy', () => {
  it('reports a failed, retryable turn with the reason instead of an empty completed card', async () => {
    const { messages, logs, remote } = await runStuckTurn();
    const terminals = messages.filter((m): m is Terminal => m.type === 'turn_terminal' && m.turnId === TURN_ID);
    const finals = messages.filter((m): m is Final => m.type === 'final_output' && m.turnId === TURN_ID);

    expect(remote.startedTurns, 'the fake remote must not have started a turn').toEqual([]);
    expect(remote.sessions[SID].pendingPrompts).toHaveLength(1);
    expect(terminals.map(t => t.status), logs).toEqual(['failed']);
    expect(terminals[0]).toMatchObject({ errorCode: 'mojo_session_busy', retryable: true });
    expect(finals, logs).toHaveLength(1);
    expect(finals[0].turnFailed).toBe(true);
    expect(finals[0].content.trim()).not.toBe('');
  }, 60_000);
});

describe('mojo worker: a passthrough written while a message waits on a busy remote', () => {
  const T1 = 'om_mojo_busy_first';
  const T2 = 'om_mojo_busy_passthrough';
  // NOTE: a mojo passthrough also gets an immediate `ambiguous /
  // raw_input_write_failed` terminal (its separate submit-key write is refused
  // as empty input). That is pre-existing and unrelated to attribution, so
  // these cases assert on where each outcome lands, not on that terminal.
  const failedOrAnswer = (messages: WorkerToDaemon[], turnId: string) =>
    finalsOf(messages, turnId).map(f => [f.turnFailed === true ? 'failed' : 'answer', f.content]);

  it('fails the waiting message on its own thread and answers the passthrough on its own', async () => {
    const run = bootWorker({ [SID]: liveSession(1) }, { prompt: '第一条', turnId: T1 }, { busyWaitSec: 3 }, '答复：{prompt}');
    run.fake.control({ sessions: { [SID]: 'live' } });
    try {
      await waitFor(() => run.fake.printInvocations().length >= 1, 30_000, () => `never launched\n${run.logs()}`);
      run.child.send({ type: 'raw_input', content: '/model', turnId: T2 } as DaemonToWorker);
      await waitFor(() => terminalsOf(run.messages, T1).length > 0, 30_000, () => `T1 never ended\n${run.logs()}`);
      run.fake.control({ sessions: { [SID]: 'free' } });
      await waitFor(() => finalsOf(run.messages, T2).length > 0, 30_000, () => `T2 never answered\n${run.logs()}`);
      await new Promise<void>(r => setTimeout(r, 300));

      expect(terminalsOf(run.messages, T1).map(t => [t.status, t.errorCode])).toEqual([['failed', 'mojo_session_busy']]);
      expect(failedOrAnswer(run.messages, T1)).toEqual([['failed', expect.any(String)]]);
      expect(finalsOf(run.messages, T1)[0].content.trim()).not.toBe('');
      expect(failedOrAnswer(run.messages, T2)).toEqual([['answer', expect.stringContaining('/model')]]);
      expect(terminalsOf(run.messages, T2).map(t => t.status)).not.toContain('failed');
    } finally {
      run.dispose();
    }
  }, 90_000);

  it('delivers the late answer of the waiting message to its own thread', async () => {
    const run = bootWorker({ [SID]: liveSession(1) }, { prompt: '第一条', turnId: T1 }, { busyWaitSec: 60 }, '答复：{prompt}');
    run.fake.control({ sessions: { [SID]: 'live' } });
    try {
      await waitFor(() => run.fake.printInvocations().length >= 1, 30_000, () => `never launched\n${run.logs()}`);
      run.child.send({ type: 'raw_input', content: '/model', turnId: T2 } as DaemonToWorker);
      await new Promise<void>(r => setTimeout(r, 1_500));
      run.fake.control({ sessions: { [SID]: 'free' } });
      await waitFor(() => finalsOf(run.messages, T2).length > 0, 40_000, () => `T2 never answered\n${run.logs()}`);
      await new Promise<void>(r => setTimeout(r, 300));

      expect(terminalsOf(run.messages, T1).map(t => t.status)).toEqual(['completed']);
      expect(failedOrAnswer(run.messages, T1)).toEqual([['answer', expect.stringContaining('第一条')]]);
      expect(failedOrAnswer(run.messages, T2)).toEqual([['answer', expect.stringContaining('/model')]]);
      // The retired first turn ending is not the end of the turn the worker
      // waits on: no prompt_ready until the passthrough itself has answered,
      // or the next message is flushed (and given turn authority) a turn early.
      const t1End = run.messages.findIndex(m => m.type === 'turn_terminal' && m.turnId === T1);
      const t2Answer = run.messages.findIndex(m => m.type === 'final_output' && m.turnId === T2);
      expect(run.messages.slice(t1End, t2Answer).filter(m => m.type === 'prompt_ready')).toEqual([]);
    } finally {
      run.dispose();
    }
  }, 90_000);
});

describe('mojo worker: messages queued while one waits on a busy remote', () => {
  it('answers each queued message on its own turn once the remote frees up', async () => {
    const T1 = 'om_mojo_busy_q1';
    const T3 = 'om_mojo_busy_q3';
    const T4 = 'om_mojo_busy_q4';
    const run = bootWorker({ [SID]: liveSession(1) }, { prompt: '队列一', turnId: T1 }, { busyWaitSec: 60 }, '答复：{prompt}');
    run.fake.control({ sessions: { [SID]: 'live' } });
    try {
      await waitFor(() => run.fake.printInvocations().length >= 1, 30_000, () => `never launched\n${run.logs()}`);
      run.child.send({ type: 'message', content: '队列三', turnId: T3 } as DaemonToWorker);
      run.child.send({ type: 'message', content: '队列四', turnId: T4 } as DaemonToWorker);
      await new Promise<void>(r => setTimeout(r, 300));
      run.fake.control({ sessions: { [SID]: 'free' } });
      await waitFor(() => terminalsOf(run.messages, T4).length > 0, 40_000, () => `T4 never ended\n${run.logs()}`);
      await new Promise<void>(r => setTimeout(r, 300));

      for (const [turnId, text] of [[T1, '队列一'], [T3, '队列三'], [T4, '队列四']] as const) {
        expect(terminalsOf(run.messages, turnId).map(t => t.status), turnId).toEqual(['completed']);
        expect(finalsOf(run.messages, turnId).map(f => f.content), turnId).toEqual([expect.stringContaining(text)]);
      }
    } finally {
      run.dispose();
    }
  }, 90_000);
});
