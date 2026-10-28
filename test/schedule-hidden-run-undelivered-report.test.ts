/**
 * #1607: when a hidden schedule run's CLI never took its prompt, the worker
 * reports a failed terminal with a dedicated code and then releases its idle.
 * The daemon still reclaims the hidden session, but it must say so: the run's
 * execution-log record becomes an error and the task's chat gets one line.
 * A run that simply finished without `botmux send` stays a quiet close.
 *
 * Drives the daemon's real settlement scheduler (debounce, close, report);
 * only the Lark client and the session row store are stand-ins.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // Bot homes (the execution log lives there) sit beside the data dir, so
  // both go under one private root.
  const root = `${process.env.TMPDIR ?? '/tmp'}/botmux-undelivered-run-${process.pid}`;
  const dataDir = `${root}/data`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  const sessions = new Map<string, any>();
  return {
    root,
    dataDir,
    sessions,
    sendMessage: vi.fn(async () => 'om_notice'),
    replyMessage: vi.fn(async () => 'om_reply'),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return { ...actual, sendMessage: mocks.sendMessage, replyMessage: mocks.replyMessage };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return {
    ...actual,
    updateSession: vi.fn((session: any) => { mocks.sessions.set(session.sessionId, session); }),
    getSession: vi.fn((id: string) => mocks.sessions.get(id)),
    getOwnedSession: vi.fn((id: string) => mocks.sessions.get(id)),
    listSessions: vi.fn(() => [...mocks.sessions.values()]),
    listSessionsStrict: vi.fn(() => [...mocks.sessions.values()]),
    closeSession: vi.fn((id: string) => {
      const session = mocks.sessions.get(id);
      if (session) session.status = 'closed';
    }),
  };
});

import { mkdirSync, rmSync } from 'node:fs';
import { registerBot } from '../src/bot-registry.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import { SCHEDULE_PROMPT_UNDELIVERED_ERROR_CODE } from '../src/core/deferred-schedule-settlement.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_scheduleDeferredScheduleSettlement as scheduleSettlement,
} from '../src/daemon.js';
import { appendScheduleRunLog, queryScheduleRunLogs } from '../src/services/schedule-run-log-store.js';

const APP = 'undelivered_run_app';
const CHAT = 'oc_undelivered_chat';
const TASK = 'task-undelivered';

mkdirSync(mocks.dataDir, { recursive: true });
afterAll(() => rmSync(mocks.root, { recursive: true, force: true }));

let seq = 0;

function hiddenRun(): DaemonSession {
  const n = ++seq;
  const turnId = `schedule:${TASK}:turn-${n}`;
  const anchor = `schedule-run:${TASK}:turn-${n}`;
  const session = {
    sessionId: `sess-undelivered-${n}`,
    chatId: CHAT,
    rootMessageId: anchor,
    title: 'hidden',
    status: 'active',
    createdAt: new Date().toISOString(),
    larkAppId: APP,
    scope: 'chat',
    chatType: 'group',
    cliId: 'opencode',
    deferredScheduleRun: { taskId: TASK, turnId, routingAnchor: anchor, createdAt: new Date().toISOString(), runId: `run-${n}` },
  };
  mocks.sessions.set(session.sessionId, session);
  const ds = {
    session, worker: null, workerPort: null, workerToken: null, larkAppId: APP, chatId: CHAT,
    chatType: 'group', scope: 'chat', spawnedAt: Date.now(), cliVersion: '1', lastMessageAt: Date.now(),
    hasHistory: false, lastScreenStatus: 'idle',
  } as unknown as DaemonSession;
  activeSessions.set(sessionKey(anchor, APP), ds);
  appendScheduleRunLog({
    id: `run-${n}`, taskId: TASK, trigger: 'scheduler', outcome: 'model_dispatched', precondition: 'passed',
    startedAt: new Date(Date.now() - 2_000).toISOString(), finishedAt: new Date().toISOString(),
    durationMs: 2_000, additionalPrompt: false,
  }, APP);
  return ds;
}

const runLog = (runId: string) => queryScheduleRunLogs(TASK, { limit: 100 }, APP).logs.find(log => log.id === runId);

beforeEach(() => {
  vi.clearAllMocks();
  registerBot({ larkAppId: APP, larkAppSecret: 's', cliId: 'opencode', allowedUsers: [] });
});

describe('hidden schedule run whose prompt never reached the CLI', () => {
  it('closes the run, marks its execution-log record and tells the chat', async () => {
    const ds = hiddenRun();
    const run = ds.session.deferredScheduleRun!;

    scheduleSettlement(ds, { turnId: run.turnId, source: 'terminal', errorCode: SCHEDULE_PROMPT_UNDELIVERED_ERROR_CODE });
    // The worker releases its idle right after the failed terminal.
    scheduleSettlement(ds, { turnId: run.turnId, source: 'idle' });

    await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(ds.session.status).toBe('closed');
    const [appId, chatId, text] = mocks.sendMessage.mock.calls[0] as unknown as [string, string, string];
    expect([appId, chatId]).toEqual([APP, CHAT]);
    expect(text).toContain(TASK);
    expect(runLog(run.runId!)).toMatchObject({ outcome: 'error', errorCode: SCHEDULE_PROMPT_UNDELIVERED_ERROR_CODE });
  });

  it('a run that finished without botmux send still closes quietly', async () => {
    const ds = hiddenRun();
    const run = ds.session.deferredScheduleRun!;

    scheduleSettlement(ds, { turnId: run.turnId, source: 'idle' });

    await vi.waitFor(() => expect(ds.session.status).toBe('closed'), { timeout: 5_000 });
    await new Promise(done => setTimeout(done, 100));
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(runLog(run.runId!)).toMatchObject({ outcome: 'model_dispatched' });
  });
});
