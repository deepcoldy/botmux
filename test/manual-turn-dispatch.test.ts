import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: { larkAppId: 'review_probe', cliId: 'codex' }, botName: 'probe', resolvedAllowedUsers: [] }),
  getAllBots: () => [], getOwnerOpenId: () => undefined, getLoadedConfigPath: () => undefined,
}));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import * as budget from '../src/core/worker-budget.js';
import * as pool from '../src/core/worker-pool.js';
import * as store from '../src/services/session-store.js';
import { forkManualTurn } from '../src/core/manual-turn-dispatch.js';
import { beginReplyTargetTurn, inheritTurnReplyRouting, resolveSessionReplyTarget, setFinalOutputOriginRecorder } from '../src/core/reply-target.js';
import { acquireDeviceIsolationFreeze, releaseDeviceIsolationFreeze, resetDeviceIsolationActivationForTest } from '../src/core/device-isolation-activation.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { fillRetryRouting } from './helpers/retry-routing.js';
let directory: string;
let oldDataDir: string;
let ds: any;
const snap = () => structuredClone({ replyTargets: ds.session.replyTargets, turnReplyContexts: ds.session.turnReplyContexts, replyTargetsPrunedThrough: ds.session.replyTargetsPrunedThrough });
const reject = (id: string) => { const undo = inheritTurnReplyRouting(ds, 'failed', id); const ok = forkManualTurn(ds, { content: 'original task' }, id, pool.forkWorker); if (!ok) { undo(); store.updateSession(ds.session); } return ok; };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T00:00:00Z'));
  directory = mkdtempSync(join(tmpdir(), 'botmux-manual-admission-'));
  oldDataDir = config.session.dataDir; config.session.dataDir = directory;
  store.init('review_probe');
  const session = store.createSession('oc_probe', 'oc_probe', 'review', 'group', 'chat');
  session.cliId = 'codex'; session.larkAppId = 'review_probe';
  ds = { session, scope: 'chat', larkAppId: 'review_probe', chatId: 'oc_probe', chatType: 'group', worker: null, hasHistory: true };
  pool.initWorkerPool({ sessionReply: vi.fn(async () => 'mock_reply'), getSessionWorkingDir: () => directory, getActiveCount: () => 1, closeSession: vi.fn() });
  pool.setActiveSessionsRegistry(undefined); setFinalOutputOriginRecorder(undefined);
  fillRetryRouting(ds, 'capacity-fixture');
  beginReplyTargetTurn(ds, 'om_failed_topic', 'failed');
  store.updateSession(ds.session);
});
afterEach(() => {
  resetDeviceIsolationActivationForTest(); vi.useRealTimers(); vi.restoreAllMocks();
  pool.setActiveSessionsRegistry(undefined);
  store.init('review_probe'); config.session.dataDir = oldDataDir;
  rmSync(directory, { recursive: true, force: true });
});
describe('manual admission with real worker gates and SQLite', () => {
 it('repeated freeze rejection then human input then lease release cannot replay the rejected retry', async () => {
   const before = snap();
   const lease = acquireDeviceIsolationFreeze({ nonce: 'independent', inventoryGeneration: 'probe', leaseMs: 1000 });
   expect(lease.ok).toBe(true); if (!lease.ok) return;
   for (let i=0;i<3;i++) { expect(reject(`retry_${i}`)).toBe(false); expect(snap()).toEqual(before); }
   beginReplyTargetTurn(ds, 'om_human_topic', 'human'); store.updateSession(ds.session);
   const afterHuman = snap(); ds.session.status = 'closed'; store.updateSession(ds.session);
   releaseDeviceIsolationFreeze({ nonce: 'independent', leaseId: lease.lease.leaseId });
   await vi.advanceTimersByTimeAsync(10000);
   expect(ds.worker).toBe(null); expect(snap()).toEqual(afterHuman);
   store.init('review_probe'); expect(store.getSession(ds.session.sessionId)?.replyTargets).toEqual(afterHuman.replyTargets);
 });
 it.each([0.5, 0.95])('real memory rejection at %s capacity leaves no delayed admission', async ratio => {
   const pressure = { totalMemoryBytes: 32 * 1024 ** 3, availableMemoryBytes: ratio * 10 * 1024 ** 3, totalMemorySource: 'host', availableMemorySource: 'host', memoryFullAvg10: 0, memoryFullAvg10Source: 'host', warnings: [] } as any;
   const decision = budget.evaluateWorkerAdmission(pressure, { minAvailableMemoryBytes: 10 * 1024 ** 3 });
   const checks = vi.spyOn(budget, 'checkWorkerAdmission').mockReturnValue(decision);
   const before = snap();
   for (let i=0;i<3;i++) { expect(reject(`retry_${i}`)).toBe(false); expect(snap()).toEqual(before); }
   expect(checks).toHaveBeenCalledTimes(3);
   checks.mockReturnValue(budget.evaluateWorkerAdmission({ ...pressure, availableMemoryBytes: 20 * 1024 ** 3 }, { minAvailableMemoryBytes: 10 * 1024 ** 3 }));
   beginReplyTargetTurn(ds, 'om_human_topic', 'human'); store.updateSession(ds.session);
   const afterHuman = snap(); await vi.advanceTimersByTimeAsync(120000);
   expect(checks).toHaveBeenCalledTimes(3); expect(snap()).toEqual(afterHuman); expect(ds.worker).toBe(null);
 });
 it('routing rollback restores evicted SQLite history after a persisted speculative write and synchronous failure', () => {
   const before = snap();
   const undo = inheritTurnReplyRouting(ds, 'failed', 'retry_partial');
   expect(snap()).not.toEqual(before);
   store.updateSession(ds.session); // actual SQLite reread replaces nested object identity
   try { throw new Error('worker spawn failed after metadata persist'); } catch { undo(); store.updateSession(ds.session); }
   expect(snap()).toEqual(before);
   store.init('review_probe'); const reloaded = store.getSession(ds.session.sessionId)!;
   expect(reloaded.replyTargets).toEqual(before.replyTargets);
   expect(reloaded.turnReplyContexts).toEqual(before.turnReplyContexts);
   expect(reloaded.replyTargetsPrunedThrough).toEqual(before.replyTargetsPrunedThrough);
   expect(resolveSessionReplyTarget({ ...ds, session: reloaded }, 'failed')).toEqual({ mode: 'thread', rootMessageId: 'om_failed_topic' });
 });
});
