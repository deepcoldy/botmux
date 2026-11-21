/** Model choices survive interrupted persistence and overlapping native settings. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

let dataDir: string;
const bot = vi.hoisted(() => ({ config: { cliId: 'codex', model: 'A' } as any }));
vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return { ...actual, config: { ...actual.config,
    session: { ...actual.config.session, get dataDir() { return dataDir; } },
  } };
});
vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...await importOriginal() as object,
  getBot: () => bot,
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import * as store from '../src/services/session-store.js';
import {
  confirmCodexModelLaunch, readCodexModelLaunchReceipt, readCodexModelSettingsCursor,
  recordCodexModelLaunch, spawnWithCodexModelLaunch,
} from '../src/services/codex-model-selection.js';
import { resolveSessionLaunchModel } from '../src/core/session-model.js';
import {
  __testOnly_resetRestartCoordinator, isSessionRestartInFlight, latestModelForRespawn,
  requestSessionRestart, resetSessionCodexModelSelection,
  initWorkerPool, setActiveSessionsRegistry, __testOnly_setupWorkerHandlers,
} from '../src/core/worker-pool.js';
import { activeSessionKey } from '../src/core/types.js';
import { readPersistedSessionRows } from './helpers/session-store-disk.js';
import { loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { applyWorkerLaunchModel } from '../src/core/worker-launch-model.js';
import { applyRespawnConfigPatch } from '../src/core/respawn-config-patch.js';
import { settleDurableTurnForRestart } from '../src/core/restart-followup-policy.js';

const t0 = Date.parse('2026-11-04T10:00:00.000Z');
const appId = 'settings-native-model';
const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let path: string;
let home: string;
let fixture: string;
function settings(model: string, ms: number, extra = {}) {
  return JSON.stringify({ timestamp: new Date(t0 + ms).toISOString(), type: 'event_msg',
    payload: { type: 'thread_settings_applied', thread_id: sid,
      thread_settings: { model, ...extra } } }) + '\n';
}
function now(ms: number) { vi.setSystemTime(t0 + ms); }
function subject() {
  const session = store.createSession('oc-model', 'om-model', 'model settings');
  Object.assign(session, { cliId: 'codex', cliSessionId: sid, backendType: 'pty', model: 'A',
    cliInstanceBinding: { version: 1, source: 'legacy', codexHome: home,
      cliId: 'codex', instanceId: null, authMode: 'global' } });
  recordCodexModelLaunch(session, 'A');
  store.updateSession(session);
  const worker = Object.assign(new EventEmitter(), {
    killed: false, send: vi.fn(), kill: vi.fn(),
    stdout: new EventEmitter(), stderr: new EventEmitter(),
  });
  return { session, larkAppId: appId, chatId: 'oc-model', workingDir: fixture,
    hasHistory: true, workerReady: true, cliReady: true,
    worker, displayMode: 'hidden', initConfig: { model: 'A', cliId: 'codex', backendType: 'pty' } } as any;
}
function observer() { return { source: 'slash' as const, notify: vi.fn(async () => {}) }; }
function wireWorker(ds: any) {
  initWorkerPool({ sessionReply: vi.fn(async () => 'om-reply'),
    getSessionWorkingDir: () => fixture, getActiveCount: () => 1, closeSession: vi.fn() } as any);
  setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
  __testOnly_setupWorkerHandlers(ds, ds.worker);
  return ds.worker;
}

beforeEach(() => {
  vi.useFakeTimers();
  now(0);
  fixture = mkdtempSync(join(tmpdir(), 'botmux-codex-settings-'));
  dataDir = join(fixture, 'store');
  home = join(fixture, 'codex');
  mkdirSync(join(home, 'sessions'), { recursive: true });
  path = join(home, 'sessions', `rollout-2026-11-04T10-00-00-${sid}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: sid } }) + '\n');
  bot.config = { cliId: 'codex', model: 'A' };
  store.__testOnly_setBeforeRowPersist(undefined);
  store.init(appId);
  __testOnly_resetRestartCoordinator();
  setActiveSessionsRegistry(undefined);
});
afterEach(() => {
  store.__testOnly_setBeforeRowPersist(undefined);
  store.init('settings-test-detached');
  __testOnly_resetRestartCoordinator();
  setActiveSessionsRegistry(undefined);
  vi.useRealTimers();
  rmSync(fixture, { recursive: true, force: true });
});

describe('Codex model selection across interrupted and overlapping launches', () => {
  it('inherit before the chosen model has ever been relaunched survives a later unchanged settings snapshot', () => {
    const ds = subject();
    appendFileSync(path, settings('A', 10) + settings('B', 100));
    now(200);
    expect(resetSessionCodexModelSelection(ds)).toBe(true);
    expect(readPersistedSessionRows(dataDir, appId)[ds.session.sessionId].codexModelSelection.override).toBeUndefined();
    appendFileSync(path, settings('B', 300, { reasoning_effort: 'high' }));
    now(400);
    bot.config.model = 'C';
    const model = latestModelForRespawn(ds);
    expect(model).toBe('C');
  });

  it('inherit excludes an already persisted old choice in the same millisecond', () => {
    const ds = subject();
    appendFileSync(path, settings('A', 10) + settings('B', 100));
    now(100);
    expect(resetSessionCodexModelSelection(ds)).toBe(true);
    now(200);
    const model = latestModelForRespawn(ds);
    expect(model).toBe('A');
  });

  it('refuses inherit while the newest settings record is still a half-written line', () => {
    const ds = subject();
    appendFileSync(path, settings('A', 10) + settings('B', 100));
    now(200);
    expect(latestModelForRespawn(ds)).toBe('B');
    const durable = readPersistedSessionRows(dataDir, appId)[ds.session.sessionId];

    // A /model write is straddling the tail (no terminating newline yet). The
    // current native model is unprovable, so the reset must fail closed rather
    // than checkpoint a stale frontier and let the pending row resurrect B.
    const incoming = settings('C', 250);
    appendFileSync(path, incoming.slice(0, 12));
    expect(resetSessionCodexModelSelection(ds)).toBe(false);
    expect(readPersistedSessionRows(dataDir, appId)[ds.session.sessionId]).toEqual(durable);
    expect(ds.session).toEqual(durable);

    // Once the record terminates, the checkpoint is complete and inherit works.
    appendFileSync(path, incoming.slice(12));
    now(300);
    expect(resetSessionCodexModelSelection(ds)).toBe(true);
    expect(readPersistedSessionRows(dataDir, appId)[ds.session.sessionId].codexModelSelection.override).toBeUndefined();
    bot.config.model = 'D';
    now(400);
    expect(latestModelForRespawn(ds)).toBe('D');
  });

  it('refuses inherit while a restart is in flight, so the pending launch confirmation is not consumed', () => {
    const ds = subject();
    appendFileSync(path, settings('A', 10));
    now(100);
    expect(latestModelForRespawn(ds)).toBe('A');
    bot.config.model = 'C';
    now(200);
    requestSessionRestart(ds, observer());
    const startedAtMs = Date.now();
    const preSpawnCursor = readCodexModelSettingsCursor(path)?.cursor;
    const durable = readPersistedSessionRows(dataDir, appId)[ds.session.sessionId];

    // The restart is already carrying C to the worker. Clearing the preference
    // here would checkpoint a baseline for a launch that does not exist yet and
    // consume the pending confirmation, so the real spawn's receipt could no
    // longer establish the new generation's baseline.
    expect(isSessionRestartInFlight(ds)).toBe(true);
    expect(resetSessionCodexModelSelection(ds)).toBe(false);
    expect(ds.session).toEqual(durable);
    expect(readPersistedSessionRows(dataDir, appId)[ds.session.sessionId]).toEqual(durable);

    // Once the restart settles, the same spawn's confirmation is still accepted
    // and the checkpointed baseline is the model this process really runs.
    __testOnly_resetRestartCoordinator();
    now(300);
    expect(resetSessionCodexModelSelection(ds)).toBe(true);
    expect(ds.session.codexModelSelection?.launchStartedAtMs).toBe(t0 + 300);
    expect(confirmCodexModelLaunch(ds.session, { model: 'A', startedAtMs, nativeSessionId: sid,
      settingsCursor: preSpawnCursor })).toBe(false);
    bot.config.model = 'D';
    now(400);
    expect(latestModelForRespawn(ds)).toBe('D');
  });

  it('a failed launch handoff does not label the still-running old model as a new native preference', () => {
    const ds = subject();
    appendFileSync(path, settings('A', 10));
    now(200);
    bot.config.model = 'C';
    ds.worker.send.mockImplementationOnce(() => { throw new Error('IPC closed before worker received restart'); });
    const first = requestSessionRestart(ds, observer());
    expect(first?.startFailure).toBeDefined();
    appendFileSync(path, settings('A', 300, { reasoning_effort: 'high' }));
    now(400);
    const model = latestModelForRespawn(ds);
    expect(model).toBe('C');
  });

  it('a failed persistence write aborts the restart before handing stale model state to the worker', () => {
    const ds = subject();
    const durable = readPersistedSessionRows(dataDir, appId)[ds.session.sessionId];
    appendFileSync(path, settings('A', 10) + settings('B', 100));
    now(200);
    store.__testOnly_setBeforeRowPersist(() => { throw new Error('injected SQLITE_BUSY'); });
    const result = requestSessionRestart(ds, observer());
    expect(ds.worker.send).not.toHaveBeenCalled();
    expect(result?.startFailure).toBeDefined();
    expect(readPersistedSessionRows(dataDir, appId)[ds.session.sessionId]).toEqual(durable);
    expect(ds.session).toEqual(durable);
  });

  it('a failed save cannot restart with A and overwrite a native B choice', async () => {
    const ds = subject();
    appendFileSync(path, settings('A', 10) + settings('B', 100));
    now(200);
    store.__testOnly_setBeforeRowPersist(() => { throw new Error('injected SQLITE_BUSY'); });
    requestSessionRestart(ds, observer());
    const message = ds.worker.send.mock.calls[0]?.[0];
    if (message) {
      // Execute the real worker IPC branch, replacing only physical process
      // launch with a snapshot of what the native child would receive.
      const scope: Record<string, any> = {
        lastInitConfig: { cliId: 'codex', model: 'A', backendType: 'pty' },
        codexAutoUpgrade: undefined, effectiveBackendType: 'pty',
        cliRestartInProgress: false, tmuxRestartTimer: undefined,
        durableTurnInFlight: false, currentBotmuxTurnId: undefined,
        configureTraexAutoModel: vi.fn(), settleDurableTurnForRestart,
        restartCliProcess: vi.fn(async () => {}), applyWorkerLaunchModel, applyRespawnConfigPatch,
      };
      await loadWorkerMessageHandler('restart', scope)(message);
      now(250);
      appendFileSync(path, settings(scope.lastInitConfig.model, 250));
    }
    store.__testOnly_setBeforeRowPersist(undefined);
    now(300);
    const recovered = latestModelForRespawn(ds);
    expect(recovered).toBe('B');
  });

  it('follows later default changes again once the user returns to the inherited model', () => {
    const ds = subject();
    appendFileSync(path, settings('A', 10) + settings('B', 100));
    now(200);
    expect(latestModelForRespawn(ds)).toBe('B');
    expect(ds.session.codexModelSelection?.override).toBe('B');

    // The user switches the native CLI back to the model this session inherits.
    // Detecting "no longer different from the default" is the ONLY way the
    // preference is ever released without an explicit /models inherit. Comparing
    // the newest snapshot against a launch model that still carries the override
    // makes the answer "B", so the override survives and the session is pinned to
    // B forever — every later default change is silently ignored.
    appendFileSync(path, settings('A', 300, { reasoning_effort: 'high' }));
    now(400);
    expect(latestModelForRespawn(ds)).toBe('A');
    expect(ds.session.codexModelSelection?.override).toBeUndefined();

    bot.config.model = 'D';
    now(500);
    expect(latestModelForRespawn(ds)).toBe('D');
  });

  it('a partial native line completed after a restart boundary remains available for recovery', () => {
    const ds = subject();
    appendFileSync(path, settings('A', 10) + settings('B', 100).trimEnd());
    now(200);
    expect(latestModelForRespawn(ds)).toBe('A');
    now(250);
    appendFileSync(path, '\n');
    now(300);
    const model = latestModelForRespawn(ds);
    expect(model).toBe('B');
  });

  it('store rollback followed by retry without a physical restart retains native B', () => {
    const ds = subject();
    appendFileSync(path, settings('A', 10) + settings('B', 100));
    now(200);
    store.__testOnly_setBeforeRowPersist(() => { throw new Error('injected SQLITE_BUSY'); });
    expect(() => latestModelForRespawn(ds)).toThrow('injected SQLITE_BUSY');
    store.__testOnly_setBeforeRowPersist(undefined);
    now(300);
    expect(latestModelForRespawn(ds)).toBe('B');
    store.init(appId);
    ds.session = store.getSession(ds.session.sessionId);
    expect(resolveSessionLaunchModel(ds, bot.config)).toBe('B');
  });

  it('a one-shot launch followed by daemon restore and a later default change never becomes a preference', () => {
    const ds = subject();
    ds.spawnModelOverride = 'one-shot-B';
    now(100);
    expect(latestModelForRespawn(ds)).toBe('one-shot-B');
    appendFileSync(path, settings('one-shot-B', 110));
    now(200);
    store.init(appId);
    ds.session = store.getSession(ds.session.sessionId);
    delete ds.spawnModelOverride;
    bot.config.model = 'C';
    expect(latestModelForRespawn(ds)).toBe('C');
    expect(ds.session.codexModelSelection.override).toBeUndefined();
  });

  it('conversation rotation and another CLI ignore the old native preference', () => {
    const ds = subject();
    appendFileSync(path, settings('B', 100));
    now(200);
    expect(latestModelForRespawn(ds)).toBe('B');
    const nativePreference = structuredClone(ds.session.codexModelSelection);
    ds.session.cliSessionId = 'rotated-native-session';
    now(300);
    expect(latestModelForRespawn(ds)).toBe('A');
    bot.config = { cliId: 'claude-code', model: 'opus' };
    expect(latestModelForRespawn(ds)).toBe('A'); // existing Codex conversation keeps its own model family
    const otherSession = store.createSession('oc-claude', 'om-claude', 'other CLI');
    Object.assign(otherSession, { cliId: 'claude-code', cliSessionId: sid, model: 'sonnet',
      codexModelSelection: nativePreference });
    store.updateSession(otherSession);
    expect(latestModelForRespawn({ ...ds, session: otherSession })).toBe('opus');
  });

  it('reads a new native choice after the worker rotates the native conversation ID', async () => {
    const ds = subject();
    const worker = wireWorker(ds);
    appendFileSync(path, settings('A', 10) + settings('B', 100));
    now(200);
    expect(latestModelForRespawn(ds)).toBe('B');
    const rotated = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const nextPath = join(home, 'sessions', `rollout-2026-11-04T10-00-01-${rotated}.jsonl`);
    const nativeRow = (model: string, ms: number) => {
      const item = JSON.parse(settings(model, ms));
      item.payload.thread_id = rotated;
      return JSON.stringify(item) + '\n';
    };
    writeFileSync(nextPath, JSON.stringify({ type: 'session_meta', payload: { id: rotated } }) + '\n'
      + nativeRow('B', 300) + nativeRow('chosen-C', 400));
    now(450);
    const handler = worker.listeners('message')[0] as (msg: unknown) => Promise<void>;
    await handler({ type: 'cli_session_id', cliSessionId: rotated });
    expect(ds.session.cliSessionId).toBe(rotated);
    now(500);
    expect(latestModelForRespawn(ds)).toBe('chosen-C');
  });

  it('treats the first snapshot as baseline when no launch model or native baseline is known (documented limitation)', () => {
    const ds = subject();
    ds.session.model = undefined;
    delete ds.session.codexModelSelection;
    recordCodexModelLaunch(ds.session, undefined);
    store.updateSession(ds.session);
    appendFileSync(path, settings('user-chosen-B', 100));
    now(200);
    bot.config.model = 'C';
    const model = latestModelForRespawn(ds);
    expect(model).toBe('C');
    expect(ds.session.codexModelSelection.override).toBeUndefined();
  });

  it('periodic settings snapshots from the previous CLI overlapping a restart cannot fabricate a preference', async () => {
    const ds = subject();
    appendFileSync(path, settings('A', 10));
    bot.config.model = 'C';
    setTimeout(() => {
      const request = requestSessionRestart(ds, observer());
      expect(request?.startFailure).toBeUndefined();
      expect(ds.worker.send.mock.calls[0]?.[0].model).toBe('C');
    }, 100);
    setTimeout(() => appendFileSync(path, settings('A', 110, { reasoning_effort: 'high' })), 110);
    // Codex resume with no prompt emits no initial settings record. The old
    // A snapshot can therefore remain the latest record after C is ready.
    await vi.advanceTimersByTimeAsync(200);
    store.init(appId);
    ds.session = store.getSession(ds.session.sessionId);
    __testOnly_resetRestartCoordinator();
    const model = latestModelForRespawn(ds);
    expect(model).toBe('C');
  });

  it('a user can select the previous model after the new process has started but before its first turn', async () => {
    const ds = subject();
    wireWorker(ds);
    appendFileSync(path, settings('A', 10));
    now(100);
    bot.config.model = 'C';
    const request = requestSessionRestart(ds, observer());
    const preSpawnCursor = readCodexModelSettingsCursor(path)?.cursor;
    const message = ds.worker.send.mock.calls[0]?.[0];
    const scope: Record<string, any> = {
      lastInitConfig: { cliId: 'codex', model: 'A', backendType: 'pty' },
      codexAutoUpgrade: undefined, effectiveBackendType: 'pty',
      cliRestartInProgress: false, tmuxRestartTimer: undefined,
      durableTurnInFlight: false, currentBotmuxTurnId: undefined,
      configureTraexAutoModel: vi.fn(), settleDurableTurnForRestart,
      restartCliProcess: vi.fn(async () => {}), applyWorkerLaunchModel, applyRespawnConfigPatch,
    };
    await loadWorkerMessageHandler('restart', scope)(message);
    expect(scope.lastInitConfig.model).toBe('C');
    const publish = vi.fn(msg => ds.worker.emit('message', msg));
    spawnWithCodexModelLaunch({ dataDir, sessionId: ds.session.sessionId,
      launch: { model: scope.lastInitConfig.model, startedAtMs: Date.now(), nativeSessionId: sid, settingsCursor: preSpawnCursor },
      spawn: vi.fn(), reattached: () => false, publish });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex_model_launch', model: 'C' }));
    ds.worker.emit('message', { type: 'restart_result', attemptId: request!.attemptId, status: 'succeeded' });
    await Promise.resolve();
    expect(ds.workerReady).toBe(true);
    now(200);
    appendFileSync(path, settings('A', 200)); // user explicitly picks A on the NEW C process
    now(300);
    const model = latestModelForRespawn(ds);
    expect(model).toBe('A');
  });

  it.each(['stale worker', 'wrong model', 'wrong native session'])('rejects a launch confirmation from %s', async mismatch => {
    const ds = subject();
    const worker = wireWorker(ds);
    appendFileSync(path, settings('A', 10));
    now(100);
    bot.config.model = 'C';
    requestSessionRestart(ds, observer());
    const before = structuredClone(ds.session);
    const durable = readPersistedSessionRows(dataDir, appId)[ds.session.sessionId];
    const confirmation = { type: 'codex_model_launch', model: mismatch === 'wrong model' ? 'foreign-model' : 'C',
      nativeSessionId: mismatch === 'wrong native session' ? 'foreign-native-id' : sid,
      startedAtMs: Date.now(), settingsCursor: readCodexModelSettingsCursor(path)?.cursor };
    if (mismatch === 'stale worker') ds.worker = Object.assign(new EventEmitter(), { killed: false, send: vi.fn() });
    worker.emit('message', confirmation);
    await Promise.resolve();
    expect(ds.session).toEqual(before);
    expect(readPersistedSessionRows(dataDir, appId)[ds.session.sessionId]).toEqual(durable);
  });

  it('can recover a failed launch confirmation save without losing a later native choice', async () => {
    const ds = subject();
    const worker = wireWorker(ds);
    appendFileSync(path, settings('A', 10));
    now(100);
    bot.config.model = 'C';
    requestSessionRestart(ds, observer());
    const confirmation = { type: 'codex_model_launch', model: 'C', nativeSessionId: sid,
      startedAtMs: Date.now(), settingsCursor: readCodexModelSettingsCursor(path)?.cursor };
    store.__testOnly_setBeforeRowPersist(() => { throw new Error('injected SQLITE_BUSY'); });
    const handler = worker.listeners('message')[0] as (msg: unknown) => Promise<void>;
    const deliveries: Promise<void>[] = [];
    spawnWithCodexModelLaunch({ dataDir, sessionId: ds.session.sessionId, launch: confirmation,
      spawn: vi.fn(), reattached: () => false, publish: msg => { deliveries.push(handler(msg)); } });
    await expect(deliveries[0]).rejects.toThrow('injected SQLITE_BUSY');
    expect(readCodexModelLaunchReceipt(dataDir, ds.session.sessionId)).toMatchObject({ model: 'C' });
    store.__testOnly_setBeforeRowPersist(undefined);
    store.init(appId);
    ds.session = store.getSession(ds.session.sessionId); // no in-memory confirmation survives daemon restore
    now(200);
    appendFileSync(path, settings('A', 200)); // selected on the confirmed new C process
    now(300);
    expect(latestModelForRespawn(ds)).toBe('A');
  });

  it.each(['failed spawn', 'late reattachment', 'other CLI'])('does not publish or replace a launch receipt for %s', mode => {
    const ds = subject();
    let reattached = false;
    const publish = vi.fn();
    const spawn = vi.fn(() => {
      if (mode === 'failed spawn') throw new Error('native backend did not spawn');
      if (mode === 'late reattachment') reattached = true;
    });
    const launch = mode === 'other CLI' ? undefined : { model: 'C', nativeSessionId: sid, startedAtMs: Date.now() };
    const perform = () => spawnWithCodexModelLaunch({ dataDir, sessionId: ds.session.sessionId,
      launch, spawn, reattached: () => reattached, publish });
    if (mode === 'failed spawn') expect(perform).toThrow('native backend did not spawn');
    else perform();
    expect(spawn).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(readCodexModelLaunchReceipt(dataDir, ds.session.sessionId)).toBeUndefined();
  });

  it.each([1, 100])('a long settings row remains unread until its terminating newline (tail missing %i bytes)', missing => {
    const ds = subject();
    appendFileSync(path, settings('A', 10));
    now(50);
    expect(latestModelForRespawn(ds)).toBe('A');
    const longSettings = settings('B', 100, { collaboration_mode: { mode: 'default', settings: {
      model: 'B', reasoning_effort: null, developer_instructions: 'x'.repeat(70 * 1024),
    } } });
    appendFileSync(path, longSettings.slice(0, -missing));
    now(200);
    expect(latestModelForRespawn(ds)).toBe('A');
    appendFileSync(path, longSettings.slice(-missing));
    now(300);
    const model = latestModelForRespawn(ds);
    expect(model).toBe('B');
  });

  it('a failed inherit write rolls back the preference and a later retry survives unchanged native settings', () => {
    const ds = subject();
    appendFileSync(path, settings('A', 10) + settings('B', 100));
    now(200);
    expect(latestModelForRespawn(ds)).toBe('B');
    const durable = readPersistedSessionRows(dataDir, appId)[ds.session.sessionId];
    now(300);
    store.__testOnly_setBeforeRowPersist(() => { throw new Error('injected SQLITE_BUSY'); });
    expect(() => resetSessionCodexModelSelection(ds)).toThrow('injected SQLITE_BUSY');
    expect(ds.session).toEqual(durable);
    expect(readPersistedSessionRows(dataDir, appId)[ds.session.sessionId]).toEqual(durable);
    store.__testOnly_setBeforeRowPersist(undefined);
    now(400);
    expect(resetSessionCodexModelSelection(ds)).toBe(true);
    appendFileSync(path, settings('B', 500, { reasoning_effort: 'high' }));
    now(600);
    bot.config.model = 'C';
    expect(latestModelForRespawn(ds)).toBe('C');
  });
});
