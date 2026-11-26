import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as store from '../src/services/session-store.js';
import * as pool from '../src/core/worker-pool.js';
import * as permissions from '../src/im/lark/event-dispatcher.js';
import * as manager from '../src/core/session-manager.js';
import { startIpcServer, setIpcAuthSecret, setLarkAppId, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { registerBot } from '../src/bot-registry.js';
import { recordFailedTurnTerminal, recordLimitedFailedTurn } from '../src/core/failed-turn-recovery.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';

let directory: string;
let oldDataDir: string;
let ds: any;
let ipc: IpcServerHandle;
const secret = 'sqlite-recovery-isolated-secret';
const caller = { requestUserOpenId: 'ou_user_a', requestLarkAppId: 'cli_fixture', senderType: 'user' as const };
const at = '2026-10-16T00:00:00.000Z';
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'botmux-recovery-sqlite-'));
  oldDataDir = config.session.dataDir; config.session.dataDir = directory;
  store.init('cli_fixture');
  const row = store.createSession('oc_fixture', 'om_root', 'fixture', 'group', 'thread');
  Object.assign(row, { cliId: 'codex', ownerOpenId: 'ou_owner_b', lastFailedTurn: {
    turnId: 'om_failed', failedAt: at, userPrompt: 'original task', cliInput: 'wrapped task', status: 'failed', retryCount: 0, trustedCaller: caller,
  }, replyTargets: { om_failed: { senderOpenId: 'ou_user_a', participants: [{ openId: 'ou_user_a', isBot: false }], updatedAt: at } } });
  store.updateSession(row);
  ds = { session: row, larkAppId: 'cli_fixture', chatId: 'oc_fixture', chatType: 'group', scope: 'thread',
    workingDir: directory, lastMessageAt: Date.parse(at) - 1000, lastScreenStatus: 'idle',
    currentReplyTarget: { turnId: 'om_failed' }, worker: { killed: false }, hasHistory: true };
  pool.setActiveSessionsRegistry(new Map([['om_root:cli_fixture', ds]]));
  vi.spyOn(permissions, 'canTalk').mockReturnValue(true);
  vi.spyOn(pool, 'prepareFailedTurnRecoveryIdentity').mockResolvedValue(undefined);
  vi.spyOn(pool, 'sendWorkerInput').mockReturnValue(true);
  vi.spyOn(pool, 'forkWorker').mockImplementation((_ds, _input, _options, callbacks) => { callbacks?.onAdmission?.('accepted'); return true; });
  vi.spyOn(pool, 'closeSessionForBackgroundCleanup').mockImplementation(async id => {
    store.closeSession(id); pool.getActiveSessionsRegistry()?.clear();
    return { ok: true, outcome: 'closed' } as any;
  });
  vi.spyOn(manager, 'rememberLastCliInput').mockImplementation(() => undefined);
  vi.spyOn(manager, 'buildFollowUpCliInput').mockImplementation((prompt, id) => ({ content: `${id}:${prompt}` }));
  setIpcAuthSecret(secret); setLarkAppId('cli_fixture');
  ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});
afterEach(async () => {
  await ipc?.close(); vi.restoreAllMocks(); pool.setActiveSessionsRegistry(undefined); setIpcAuthSecret(null);
  store.init('cli_fixture'); config.session.dataDir = oldDataDir;
  rmSync(directory, { recursive: true, force: true });
});
async function post(mode: 'retry' | 'fresh') {
  const path = `/api/sessions/${ds.session.sessionId}/failure-recovery`;
  const body = { turnId: 'om_failed', failedAt: at, requestId: 'sqlite-request', mode };
  const response = await fetch(`http://127.0.0.1:${ipc.port}${path}`, { method: 'POST',
    headers: daemonIpcAuthHeaders({ secret, port: ipc.port, method: 'POST', path, headers: { 'content-type': 'application/json' } }), body: JSON.stringify(body) });
  expect(response.status).toBe(200); return response.json();
}
describe('HTTP recovery with real SQLite persistence', () => {
  it('reloads one input owner and refuses late or uncorrelated failures', () => {
    registerBot({ larkAppId: 'cli_fixture', larkAppSecret: 'fixture', cliId: 'codex', apiOnly: true });
    vi.mocked(manager.rememberLastCliInput).mockRestore();
    manager.rememberLastCliInput(ds, 'B', 'wrapped B', 'om_b');
    manager.rememberLastCliInput(ds, 'C', 'wrapped C', 'om_c');
    store.init('cli_fixture');
    const row = store.getSessionFresh(ds.session.sessionId)!;
    Object.assign(ds, { session: row, lastUserPrompt: row.lastUserPrompt,
      lastCliInput: row.lastCliInput, lastCliInputTurnId: row.lastCliInputTurnId });
    const previous = structuredClone(row.lastFailedTurn);
    recordFailedTurnTerminal(ds, { turnId: 'om_b', status: 'failed' },
      { workerGeneration: 1, caller, silent: false });
    ds.usageLimit = { limited: true, kind: 'rate' };
    recordLimitedFailedTurn(ds, 'om_b');
    expect(store.getSessionFresh(row.sessionId)?.lastFailedTurn).toEqual(previous);
    recordFailedTurnTerminal(ds, { turnId: 'om_c', status: 'failed' },
      { workerGeneration: 1, caller, silent: false });
    expect(store.getSessionFresh(row.sessionId)?.lastFailedTurn).toMatchObject({ turnId: 'om_c', cliInput: 'wrapped C' });
    manager.rememberLastCliInput(ds, 'untracked', 'untracked input', undefined);
    recordFailedTurnTerminal(ds, { turnId: 'om_c', status: 'failed' },
      { workerGeneration: 1, caller, silent: false });
    expect(store.getSessionFresh(row.sessionId)?.lastCliInputTurnId).toBeUndefined();
    expect(store.getSessionFresh(row.sessionId)?.lastFailedTurn?.cliInput).toBe('wrapped C');
  });
  it('persists attachments with the exact input and clears them on the next plain input', () => {
    registerBot({ larkAppId: 'cli_fixture', larkAppSecret: 'fixture', cliId: 'codex', apiOnly: true });
    vi.mocked(manager.rememberLastCliInput).mockRestore();
    const attachments = [{ type: 'image' as const, name: 'evidence.png', path: '/tmp/evidence.png' }];
    manager.rememberLastCliInput(ds, 'with attachment', { content: 'wrapped attachment', attachments }, 'om_with_attachment');
    expect(store.getSessionFresh(ds.session.sessionId)?.lastAttachments).toEqual(attachments);

    recordFailedTurnTerminal(ds, { turnId: 'om_with_attachment', status: 'failed' },
      { workerGeneration: 1, caller, silent: false });
    expect(store.getSessionFresh(ds.session.sessionId)?.lastFailedTurn?.attachments).toEqual(attachments);

    manager.rememberLastCliInput(ds, 'plain next input', 'wrapped plain', 'om_plain');
    expect(store.getSessionFresh(ds.session.sessionId)?.lastAttachments).toBeUndefined();
  });
  it('persists the clean session app, routing and frozen sandbox/profile through reload', async () => {
    Object.assign(ds.session, { cliConfigDir: '/tmp/frozen-cli', modelBackendVariant: 'max',
      larkThreadId: 'omt_original', creatorOpenId: 'ou_creator', lastCallerOpenId: 'ou_last',
      sandbox: 'scratch', sandboxScratch: { storage: 'tmpfs', tmpfsSizeMb: 96, denyPaths: ['/secret'] },
      sandboxNetworkPolicy: { version: 1, public: { mode: 'block' }, private: { mode: 'block' } },
      sandboxHidePaths: ['/hidden'], sandboxReadonlyPaths: ['/readonly'] });
    store.updateSession(ds.session);
    const first = await post('fresh');
    store.init('cli_fixture');
    const child = store.getSessionFresh(first.sessionId)!;
    expect(child).toMatchObject({ larkAppId: 'cli_fixture', cliConfigDir: '/tmp/frozen-cli',
      modelBackendVariant: 'max', larkThreadId: 'omt_original', creatorOpenId: 'ou_creator',
      lastCallerOpenId: 'ou_last', sandbox: 'scratch',
      sandboxScratch: { storage: 'tmpfs', tmpfsSizeMb: 96, denyPaths: ['/secret'] },
      sandboxNetworkPolicy: { version: 1, public: { mode: 'block' }, private: { mode: 'block' } },
      sandboxHidePaths: ['/hidden'], sandboxReadonlyPaths: ['/readonly'] });
    expect(child.cliSessionId).toBeUndefined();
  });
  it.each(['retry', 'fresh'] as const)('persists %s acceptance and deduplicates after store reload', async mode => {
    const id = ds.session.sessionId;
    const first = await post(mode);
    expect(first.state).toBe('accepted');
    const durable = store.getSessionFresh(id)!;
    expect(durable.lastFailedTurn?.recovery).toMatchObject({ state: 'accepted', sessionId: first.sessionId });
    expect(store.getSessionFresh(first.sessionId)?.failedTurnRecovery?.caller).toEqual(caller);
    if (mode === 'fresh') expect(store.getSessionFresh(first.sessionId)?.larkAppId).toBe('cli_fixture');
    store.init('cli_fixture');
    const restored = store.getSessionFresh(first.sessionId)!;
    expect(restored.currentReplyTarget).toBeUndefined();
    expect(restored.replyTargets?.[first.turnId]).toMatchObject({
      rootMessageId: 'om_root', senderOpenId: 'ou_user_a',
    });
    expect(await post(mode)).toEqual(first);
    expect(mode === 'retry' ? pool.sendWorkerInput : pool.forkWorker).toHaveBeenCalledTimes(1);
    if (mode === 'fresh') expect(store.getSessionFresh(id)?.status).toBe('closed');
  });

  it('does not let an unrelated terminal cancel the current limited record retry, and persists its proof boundary', () => {
    vi.useFakeTimers();
    try {
      const id = ds.session.sessionId;
      ds.workerGeneration = 7;
      ds.session.workerGeneration = 7;
      ds.session.lastFailedTurn = undefined;
      store.updateSession(ds.session);
      ds.lastCliInputTurnId = 'om_current';
      ds.lastUserPrompt = 'current task';
      ds.lastCliInput = 'wrapped current task';
      ds.activeInteractiveTurn = { turnId: 'om_current', caller };
      const antigravityWriteBoundary = { sampledTranscriptPath: '/tmp/current.jsonl', minByteOffset: 123 };
      ds.usageLimit = {
        limited: true, kind: 'usage', retryAtMs: Date.now() + 60_000,
        retryLabel: '1m', retryReady: false, source: 'antigravity-native-log',
        nativeEpisodeKey: 'log:current', directFailure: true, antigravityWriteBoundary,
      };

      store.__testOnly_setBeforeRowPersist(() => { throw new Error('sqlite busy'); });
      expect(() => recordLimitedFailedTurn(ds, 'om_current')).toThrow('sqlite busy');
      expect(store.getSessionFresh(id)?.lastFailedTurn).toBeUndefined();
      store.__testOnly_setBeforeRowPersist(undefined);

      recordFailedTurnTerminal(ds, { turnId: 'om_unrelated_old', status: 'completed' }, {
        workerGeneration: 7, caller, silent: false,
      });
      vi.advanceTimersByTime(600);

      expect(ds.session.lastFailedTurn).toMatchObject({
        turnId: 'om_current', directFailure: true, antigravityWriteBoundary,
      });
      expect(store.getSessionFresh(id)?.lastFailedTurn).toMatchObject({
        turnId: 'om_current', directFailure: true, antigravityWriteBoundary,
      });
    } finally {
      store.__testOnly_setBeforeRowPersist(undefined);
      vi.useRealTimers();
    }
  });

  it('aborts cleanup retry on new same-turn ds.usageLimit while permitting only current-generation completed terminal through sticky limit', async () => {
    const { clearLimitedFailedTurn, recordFailedTurnTerminal } = await import('../src/core/failed-turn-recovery.js');
    vi.useFakeTimers();
    try {
      const id = ds.session.sessionId;
      ds.workerGeneration = 3;
      ds.session.workerGeneration = 3;
      ds.lastCliInputTurnId = 'om_failed';
      ds.session.lastFailedTurn = {
        ...ds.session.lastFailedTurn,
        limitedSnapshot: true,
        directFailure: true,
      };
      store.updateSession(ds.session);

      // first clear fails, then same turn enters a new active ds.usageLimit -> retry MUST abort!
      store.__testOnly_setBeforeRowPersist(() => { throw new Error('sqlite busy'); });
      clearLimitedFailedTurn(ds, 'om_failed');
      store.__testOnly_setBeforeRowPersist(undefined);
      ds.usageLimit = {
        limited: true, kind: 'usage', retryAtMs: Date.now() + 60_000,
        retryLabel: '1m', retryReady: false, source: 'antigravity-native-log',
        nativeEpisodeKey: 'log:new-same-turn', directFailure: true,
      };
      vi.advanceTimersByTime(600);
      expect(ds.session.lastFailedTurn?.turnId).toBe('om_failed');
      expect(store.getSessionFresh(id)?.lastFailedTurn?.turnId).toBe('om_failed');

      // regression case negative control: stale-generation completed terminal does NOT clear through sticky limit.
      recordFailedTurnTerminal(ds, { turnId: 'om_failed', status: 'completed' }, {
        workerGeneration: 2, caller, silent: false,
      });
      expect(ds.session.lastFailedTurn?.turnId).toBe('om_failed');

      // regression case positive control: current-generation completed terminal gets currentGenerationCompleted=true and retries past sticky limit!
      store.__testOnly_setBeforeRowPersist(() => { throw new Error('sqlite busy 2'); });
      recordFailedTurnTerminal(ds, { turnId: 'om_failed', status: 'completed' }, {
        workerGeneration: 3, caller, silent: false,
      });
      expect(ds.session.lastFailedTurn?.turnId).toBe('om_failed');
      store.__testOnly_setBeforeRowPersist(undefined);
      vi.advanceTimersByTime(600);
      expect(ds.session.lastFailedTurn).toBeUndefined();
      expect(store.getSessionFresh(id)?.lastFailedTurn).toBeUndefined();
    } finally {
      store.__testOnly_setBeforeRowPersist(undefined);
      vi.useRealTimers();
    }
  });
});
