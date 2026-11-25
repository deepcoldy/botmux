/**
 * Production write-site wiring for the durable raw activation journal.
 *
 * retainQueuedActivationRawInput has its own helper tests, but the only
 * production caller sits deep inside forkWorkerPrepared. A helper-level test
 * stays green if that call is deleted, silently breaking daemon-restart
 * recovery of immediate raw openings. This drives the REAL forkWorker with the
 * child transport mocked and reads the persisted SQLite row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../src/utils/logger.js';
import { config } from '../src/config.js';
import * as pool from '../src/core/worker-pool.js';
import * as bots from '../src/bot-registry.js';
import * as selfSpawn from '../src/core/self-spawn.js';
import * as workerBudget from '../src/core/worker-budget.js';
import * as store from '../src/services/session-store.js';

const APP = 'cli_activation_raw_journal_test';
let originalDir: string;
let dataDir: string;
let bot: any;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-24T00:00:00Z'));
  originalDir = config.session.dataDir;
  dataDir = mkdtempSync(join(tmpdir(), 'activation-raw-journal-'));
  config.session.dataDir = dataDir;
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(() => undefined);
  }
  bot = {
    config: { larkAppId: APP, larkAppSecret: 'fixture-only', cliId: 'claude-code', apiOnly: true },
    botName: 'RawJournalBot', resolvedAllowedUsers: [],
  };
  vi.spyOn(bots, 'getBot').mockImplementation(() => bot);
  vi.spyOn(workerBudget, 'checkWorkerAdmission').mockImplementation(cfg =>
    workerBudget.evaluateWorkerAdmission({
      totalMemoryBytes: 16 * 1024 ** 3, availableMemoryBytes: 12 * 1024 ** 3, memoryFullAvg10: 0,
      totalMemorySource: 'host', availableMemorySource: 'host', memoryFullAvg10Source: 'host', warnings: [],
    }, cfg));
  store.init(APP);
  pool.__testOnly_resetOrdinaryImDeliveries();
  pool.initWorkerPool({
    sessionReply: vi.fn(async () => 'om_raw_journal_reply'),
    getSessionWorkingDir: () => config.session.dataDir,
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  });
});

afterEach(() => {
  pool.__testOnly_resetOrdinaryImDeliveries();
  store.init(APP);
  config.session.dataDir = originalDir;
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function seed(pendingRawInput: string | undefined): any {
  const session = store.createSession('oc_raw_journal', 'om_raw_journal_root', 'raw journal', 'group', 'thread');
  Object.assign(session, {
    cliId: 'claude-code',
    workingDir: config.session.dataDir,
    cliPathOverride: process.execPath,
    queuedActivationPending: true,
    queuedActivationToken: 'raw-journal-token',
    queuedActivationInput: { content: '' },
    queuedActivationTurnId: 'om_raw_journal_root',
    queuedActivationResume: false,
  });
  store.updateSession(session);
  const worker: any = new EventEmitter();
  Object.assign(worker, {
    killed: false, connected: true, pid: process.pid,
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: vi.fn(), send: vi.fn(() => true),
  });
  vi.spyOn(selfSpawn, 'spawnWorker').mockReturnValue(worker);
  const ds: any = {
    session, larkAppId: APP, chatId: session.chatId, chatType: 'group', scope: 'thread',
    worker: null, workerGeneration: 1, spawnedAt: Date.now(), lastMessageAt: Date.now(), hasHistory: true,
    ...(pendingRawInput !== undefined
      ? { pendingRawInput, pendingRawTurnId: 'om_raw_journal_root' }
      : {}),
  };
  return ds;
}

describe('forkWorker persists the tokened raw opening inside the activation journal', () => {
  it('writes the exact raw literal and turn id to the durable session row', () => {
    const raw = '/goal IMMEDIATE_RAW_JOURNAL_WRITE_SITE';
    const ds = seed(raw);
    expect(pool.forkWorker(ds, '', false, { turnId: 'om_raw_journal_root' })).toBe(true);
    const row = store.getSessionFresh(ds.session.sessionId)!;
    expect(row.queuedActivationRawInput).toBe(raw);
    expect(row.queuedActivationRawTurnId).toBe('om_raw_journal_root');
    expect(row.queuedActivationToken).toBe('raw-journal-token');
  });

  it('invent no raw journal entry when the fork carries no pending raw input', () => {
    const ds = seed(undefined);
    expect(pool.forkWorker(ds, '', false, { turnId: 'om_raw_journal_root' })).toBe(true);
    const row = store.getSessionFresh(ds.session.sessionId)!;
    expect(row.queuedActivationRawInput).toBeUndefined();
    expect(row.queuedActivationRawTurnId).toBeUndefined();
    expect(row.queuedActivationPending).toBe(true);
  });
});
