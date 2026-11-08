import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import * as registry from '../src/bot-registry.js';
import * as store from '../src/services/session-store.js';
import { setSessionReasoningEffort, setTopicReasoningEffort, updateCodexCliEffort, updateCodexAppEffort, writeSessionModelPin,
  requestSessionRestart, __testOnly_resetRestartCoordinator, __testOnly_sessionAgentConfig, latestPinEffortForRespawn } from '../src/core/worker-pool.js';
import { clearModelPins } from '../src/core/model-pin-store.js';
import { ModelPinBusyError } from '../src/core/model-pin.js';
import { resolveSessionModelPinView } from '../src/core/session-model.js';
const app = 'pin-effort-app';
const model = 'gpt-6.1-terra';
let dir: string, previous: string;
let bot: any;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pin-effort-')); previous = config.session.dataDir; config.session.dataDir = dir;
  store.init(app); __testOnly_resetRestartCoordinator();
  bot = { cliId: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' };
  vi.spyOn(registry, 'getBot').mockImplementation(() => ({ config: bot }) as any);
});
afterEach(() => {
  store.__testOnly_setBeforeRowPersist(undefined); __testOnly_resetRestartCoordinator(); vi.useRealTimers(); vi.restoreAllMocks();
  config.session.dataDir = previous; store.init(app); rmSync(dir, { recursive: true, force: true });
});
function fixture(cliId = 'codex') {
  bot.cliId = cliId;
  const s = store.createSession('chat', crypto.randomUUID(), 'topic');
  Object.assign(s, { larkAppId: app, cliId, model, backendType: 'tmux', reasoningEffort: 'high', agentFrozen: true,
    modelPin: { model, effort: 'high', source: 'topic-header', setBy: 'owner', setAt: '2026-11-06T00:00:00Z' } });
  store.updateSession(s, { modelPinWrite: true });
  const worker: any = Object.assign(new EventEmitter(), { killed: false, send: vi.fn(), kill: vi.fn() });
  const ds: any = { session: s, worker, workerReady: true, cliReady: true, workerGeneration: 1, activeModel: model,
    initConfig: { cliId, backendType: 'tmux', model, reasoningEffort: 'high' }, activeReasoningEffort: 'high',
    larkAppId: app, chatId: 'chat', lastScreenStatus: 'idle', hasHistory: true };
  return { ds, worker };
}
function receipt(worker: any, type = 'codex_cli_effort_result') {
  const msg = worker.send.mock.calls.at(-1)[0];
  worker.emit('message', { type, requestId: msg.requestId, status: 'future_only', reason: type === 'codex_cli_effort_result' ? 'cli_next_turn' : undefined });
}
it('the real suspended-session effort entry commits the later selection and pin in one SQLite write', () => {
  const { ds } = fixture(); ds.worker = null; ds.session.suspendedColdResume = true;
  expect(setSessionReasoningEffort(ds, 'low', { source: 'card', setBy: 'owner' })).toBe('saved');
  expect(ds.session.modelPin.effort).toBe('low');
  store.init(app); const row = store.getOwnedSession(ds.session.sessionId)!;
  expect(row.modelPin?.effort).toBe('low'); expect(row.reasoningEffort).toBe('low');
  expect(__testOnly_sessionAgentConfig({ ...ds, session: row }, bot).reasoningEffort).toBe('low');
  expect(latestPinEffortForRespawn({ ...ds, session: row })).toEqual({ reasoningEffort: 'low' });
});
it('receipt-confirmed Codex /effort persists pin and restart/cold restore use the newer effort', async () => {
  const { ds, worker } = fixture();
  const result = updateCodexCliEffort(ds, 'low', 1000, () => true, { source: 'command', setBy: 'owner' }); receipt(worker);
  expect(await result).toMatchObject({ status: 'future_only' });
  expect(ds.activeReasoningEffort).toBe('high'); expect(ds.session.modelPin.effort).toBe('low');
  requestSessionRestart(ds, { source: 'slash', notify: async () => {} });
  expect(worker.send.mock.calls.at(-1)[0]).toMatchObject({ type: 'restart', model, reasoningEffort: 'low' });
  store.init(app); const row = store.getOwnedSession(ds.session.sessionId)!;
  expect(__testOnly_sessionAgentConfig({ ...ds, worker: null, session: row }, bot).reasoningEffort).toBe('low');
});
it.each(['codex', 'codex-app'])('a failed %s receipt write rolls back session, pin and launch snapshot together', async cliId => {
  const { ds, worker } = fixture(cliId); const before = structuredClone(ds.session.modelPin);
  store.__testOnly_setBeforeRowPersist(() => { throw new Error('disk failure'); });
  const fn = cliId === 'codex' ? updateCodexCliEffort : updateCodexAppEffort;
  const pending = fn(ds, 'low'); receipt(worker, cliId === 'codex' ? 'codex_cli_effort_result' : 'codex_app_effort_result');
  expect(await pending).toEqual({ status: 'error' });
  expect(ds.session.modelPin).toEqual(before); expect(ds.session.reasoningEffort).toBe('high');
  expect(ds.initConfig.reasoningEffort).toBe('high');
  store.__testOnly_setBeforeRowPersist(undefined); store.init(app);
  expect(store.getOwnedSession(ds.session.sessionId)?.modelPin).toEqual(before);
});
it.each(['codex', 'codex-app'])('%s cannot commit a receipt after operator permission is revoked', async cliId => {
  const { ds, worker } = fixture(cliId); let allowed = true;
  const fn = cliId === 'codex' ? updateCodexCliEffort : updateCodexAppEffort;
  const pending = fn(ds, 'low', 1000, () => allowed); allowed = false;
  receipt(worker, cliId === 'codex' ? 'codex_cli_effort_result' : 'codex_app_effort_result');
  expect(await pending).toEqual({ status: 'error' }); expect(ds.session.modelPin.effort).toBe('high');
});
it('native effort waits serialize explicit pin updates and timeout without overwriting intent', async () => {
  vi.useFakeTimers(); const { ds } = fixture();
  const pending = updateCodexCliEffort(ds, 'low', 100);
  expect(() => writeSessionModelPin(ds, { ...ds.session.modelPin, effort: 'medium' })).toThrow();
  expect(() => clearModelPins(app, undefined, { findActive: () => ds, assertMutable: () => { throw new ModelPinBusyError([{ sessionId: ds.session.sessionId, reason: 'effort_change' }]); }, publish() {} })).toThrow(ModelPinBusyError);
  await vi.advanceTimersByTimeAsync(100); expect(await pending).toEqual({ status: 'error' });
  expect(ds.session.modelPin.effort).toBe('high');
  expect(writeSessionModelPin(ds, { ...ds.session.modelPin, effort: 'medium' })).toBe(true);
});
it('a model switch while waiting invalidates the old native receipt', async () => {
  const { ds, worker } = fixture(); const pending = updateCodexCliEffort(ds, 'low');
  ds.activeModel = 'gpt-6-astra'; receipt(worker);
  expect(await pending).toEqual({ status: 'error' }); expect(ds.session.modelPin.effort).toBe('high');
});
it('TraeX actual topic effort entry preserves the newer matching pin effort', () => {
  const { ds } = fixture('traex'); ds.session.modelPin.model = ds.activeModel = ds.initConfig.model = 'gpt-5.4';
  store.updateSession(ds.session, { modelPinWrite: true });
  expect(setTopicReasoningEffort(ds, 'low', { source: 'card', setBy: 'owner' })).toBe('saved');
  expect(ds.session.modelPin.effort).toBe('low'); store.init(app);
  expect(store.getOwnedSession(ds.session.sessionId)?.modelPin?.effort).toBe('low');
});
it('an effort edit for a different runtime model leaves the pin effort unchanged', async () => {
  const { ds, worker } = fixture(); ds.activeModel = ds.initConfig.model = 'gpt-6-astra';
  const pending = updateCodexCliEffort(ds, 'low'); receipt(worker);
  expect(await pending).toMatchObject({ status: 'future_only' }); expect(ds.session.modelPin.effort).toBe('high');
});

it('the actual /effort command rechecks operator permission before committing its native receipt', async () => {
  const { handleCommand } = await import('../src/core/command-handler.js');
  const { sessionKey } = await import('../src/core/types.js');
  const dispatcher = await import('../src/im/lark/event-dispatcher.js');
  let allowed = true; vi.spyOn(dispatcher, 'canOperate').mockImplementation(() => allowed);
  const { ds, worker } = fixture(); const root = ds.session.rootMessageId;
  const deps: any = { activeSessions: new Map([[sessionKey(root, app), ds]]), sessionReply: vi.fn(async () => 'reply') };
  const pending = handleCommand('/effort', root, { messageId: 'effort-command', senderId: 'owner', content: '/effort low', msgType: 'text' } as any, deps, app);
  expect(worker.send.mock.calls[0][0].type).toBe('codex_cli_effort');
  allowed = false; receipt(worker); await pending;
  expect(ds.session.modelPin.effort).toBe('high'); expect(store.getOwnedSession(ds.session.sessionId)?.modelPin?.effort).toBe('high');
});

it('a restart begun while the native setting is pending invalidates its late receipt', async () => {
  const { ds, worker } = fixture(); const pending = updateCodexCliEffort(ds, 'low');
  const requestId = worker.send.mock.calls[0][0].requestId;
  requestSessionRestart(ds, { source: 'dashboard', notify: async () => {} });
  worker.emit('message', { type: 'codex_cli_effort_result', requestId, status: 'future_only', reason: 'cli_next_turn' });
  expect(await pending).toEqual({ status: 'error' }); expect(ds.session.modelPin.effort).toBe('high');
  expect(store.getOwnedSession(ds.session.sessionId)?.modelPin?.effort).toBe('high');
});

it('the Codex App receipt persists the later effort into its matching pin', async () => {
  const { ds, worker } = fixture('codex-app');
  const pending = updateCodexAppEffort(ds, 'low', 1000, () => true, { source: 'command', setBy: 'owner' });
  receipt(worker, 'codex_app_effort_result'); expect(await pending).toMatchObject({ status: 'future_only' });
  store.init(app); expect(store.getOwnedSession(ds.session.sessionId)?.modelPin?.effort).toBe('low');
  expect(__testOnly_sessionAgentConfig({ ...ds, worker: null, session: store.getOwnedSession(ds.session.sessionId) }, bot).reasoningEffort).toBe('low');
});
it('the actual cold preference entry does not treat a differing pin effort as an unchanged legacy preference', () => {
  const { ds } = fixture(); ds.worker = null; ds.session.suspendedColdResume = true;
  ds.session.reasoningEffort = 'low'; store.updateSession(ds.session); // legacy fallback already low; pin remains high
  expect(setSessionReasoningEffort(ds, 'low', { source: 'card', setBy: 'owner' })).toBe('saved');
  expect(ds.session.modelPin.effort).toBe('low'); store.init(app);
  expect(store.getOwnedSession(ds.session.sessionId)?.modelPin?.effort).toBe('low');
});

it.each(['cleared', 'replaced', 'same timestamp'])('a detached effort selection cannot overwrite a pin that was %s in SQLite', change => {
  const { ds } = fixture(); ds.worker = null; ds.session.suspendedColdResume = true;
  const stale: any = { ...ds, session: structuredClone(ds.session) };
  store.mutateOwnedSessionsAtomically([ds.session.sessionId], rows => {
    const row = rows.get(ds.session.sessionId)!;
    if (change === 'cleared') delete row.modelPin;
    else row.modelPin = { ...row.modelPin!, effort: 'medium', setBy: 'new-owner',
      setAt: change === 'same timestamp' ? row.modelPin!.setAt : '2026-11-06T01:00:00Z' };
  }, { modelPinWrite: true });
  const expected = structuredClone(store.getOwnedSession(ds.session.sessionId));
  expect(() => setSessionReasoningEffort(stale, 'low', { source: 'card', setBy: 'owner' })).toThrow('model_pin_changed');
  expect(stale.session.modelPin.effort).toBe('high');
  store.init(app); const row = store.getOwnedSession(ds.session.sessionId)!;
  expect(row.modelPin).toEqual(expected?.modelPin); expect(row.reasoningEffort).toBe('high');
});
it('a detached matching effort selection reads the new row and preserves unrelated durable changes', () => {
  const { ds } = fixture(); ds.worker = null; ds.session.suspendedColdResume = true;
  ds.session = structuredClone(ds.session);
  store.mutateOwnedSessionsAtomically([ds.session.sessionId], rows => { rows.get(ds.session.sessionId)!.title = 'new durable title'; });
  expect(setSessionReasoningEffort(ds, 'low')).toBe('saved');
  store.init(app); const row = store.getOwnedSession(ds.session.sessionId)!;
  expect(row.modelPin?.effort).toBe('low'); expect(row.title).toBe('new durable title');
});
it('a native receipt from a detached session cannot revive a pin cleared during the menu wait', async () => {
  const { ds, worker } = fixture(); ds.session = structuredClone(ds.session);
  const pending = updateCodexCliEffort(ds, 'low');
  store.mutateOwnedSessionsAtomically([ds.session.sessionId], rows => { delete rows.get(ds.session.sessionId)!.modelPin; }, { modelPinWrite: true });
  receipt(worker); expect(await pending).toEqual({ status: 'error' });
  expect(ds.initConfig.reasoningEffort).toBe('high');
  store.init(app); expect(store.getOwnedSession(ds.session.sessionId)?.modelPin).toBeUndefined();
});
it.each(['gpt-6-astra', model])('the actual command clears a shadowed pin without interrupting its worker (%s)', async override => {
  const { handleCommand } = await import('../src/core/command-handler.js');
  const { sessionKey } = await import('../src/core/types.js');
  const dispatcher = await import('../src/im/lark/event-dispatcher.js');
  vi.spyOn(dispatcher, 'canOperate').mockReturnValue(true);
  const { ds, worker } = fixture(); ds.spawnModelOverride = override;
  const root = ds.session.rootMessageId;
  const deps: any = { activeSessions: new Map([[sessionKey(root, app), ds]]), sessionReply: vi.fn(async () => 'reply') };
  await handleCommand('/modelpin', root, { senderId: 'owner', content: '/modelpin --follow-bot', msgType: 'text' } as any, deps, app);
  expect(ds.session.modelPin).toBeUndefined(); expect(worker.send).not.toHaveBeenCalled(); expect(worker.kill).not.toHaveBeenCalled();
  expect(ds.spawnModelOverride).toBe(override);
  store.init(app); expect(store.getOwnedSession(ds.session.sessionId)?.modelPin).toBeUndefined();
});

it('shows the current TraeX topic selection separately from a waiting model pin', async () => {
  const { resolveSessionModelPinView } = await import('../src/core/session-model.js');
  const { topicReasoningControl } = await import('../src/core/worker-pool.js');
  const { ds } = fixture('traex');
  ds.session.modelPin.model = 'gpt-5.4'; ds.activeModel = ds.initConfig.model = 'gpt-5.2';
  store.updateSession(ds.session, { modelPinWrite: true });
  expect(setTopicReasoningEffort(ds, 'low')).toBe('saved');
  expect(topicReasoningControl(ds)?.selected).toBe('low');
  const note = resolveSessionModelPinView(ds, bot)?.pendingEffortNote;
  for (const value of ['gpt-5.2', 'low', 'gpt-5.4', 'high']) expect(note).toContain(value);
  expect(ds.session.modelPin.effort).toBe('high');
});

it.each([
  ['ds.adoptedFrom', (ds: any) => { ds.adoptedFrom = { source: 'external' }; }],
  ['session.adoptedFrom', (ds: any) => { ds.session.adoptedFrom = { source: 'external' }; }],
  ['initConfig.adoptMode', (ds: any) => { ds.initConfig.adoptMode = true; }],
  ['session.existingAppServerEndpoint', (ds: any) => { ds.session.existingAppServerEndpoint = 'ws://app-server.example:1234'; }],
])('refuses to set a pin in an adopted session (%s) but still allows clearing', (_name, mark) => {
  const { ds } = fixture();
  mark(ds);
  expect(() => writeSessionModelPin(ds, { model: 'gpt-6-astra', source: 'command', setBy: 'owner', setAt: new Date().toISOString() })).toThrow(/adopt|接管/);
  expect(ds.session.modelPin.model).toBe(model);
  // Read and write sides agree on every shape: the stored pin is suspended, not active.
  expect(resolveSessionModelPinView(ds, bot)?.active).toBe(false);
  expect(resolveSessionModelPinView(ds, bot)?.inactiveReason).toContain('接管');
  store.init(app);
  expect(store.getOwnedSession(ds.session.sessionId)?.modelPin?.model).toBe(model);
  expect(writeSessionModelPin(ds, undefined)).toBe(true);
  expect(ds.session.modelPin).toBeUndefined();
});

it('a pin already stored when a shared adopt begins stays on the row but is suspended from launch, view and respawn', () => {
  const { ds } = fixture();
  ds.session.modelPin.effort = 'medium';
  store.updateSession(ds.session, { modelPinWrite: true });
  // Adopt arrives AFTER the pin (both traditional pane and --remote viewer shapes).
  ds.session.adoptedFrom = { source: 'external' };
  expect(__testOnly_sessionAgentConfig(ds, bot)).toMatchObject({ model: bot.model, reasoningEffort: 'high' });
  ds.session.adoptedFrom = undefined;
  ds.session.existingAppServerEndpoint = 'ws://app-server.example:1234';
  const cfg = __testOnly_sessionAgentConfig(ds, bot);
  expect(cfg.model).toBe(bot.model); expect(cfg.reasoningEffort).toBe('high');
  expect(latestPinEffortForRespawn(ds)).toEqual({ reasoningEffort: 'high' });
  // A restart while adopted explicitly carries the bot-default launch, never the
  // suspended pin (the --remote argv ignores it, but the wire must not pretend it applies).
  requestSessionRestart(ds, { source: 'slash', notify: async () => {} });
  expect(ds.worker.send.mock.calls.at(-1)[0]).toMatchObject({ type: 'restart', model: bot.model, reasoningEffort: 'high' });
  const view = resolveSessionModelPinView(ds, bot);
  expect(view).toMatchObject({ active: false, launchModel: bot.model, launchEffort: 'high' });
  expect(view?.inactiveReason).toContain('接管');
  // The durable pin is untouched; ending the adopt reactivates it without a rewrite.
  store.init(app); expect(store.getOwnedSession(ds.session.sessionId)?.modelPin).toMatchObject({ model, effort: 'medium' });
  delete ds.session.existingAppServerEndpoint;
  expect(__testOnly_sessionAgentConfig(ds, bot)).toMatchObject({ model, reasoningEffort: 'medium' });
  expect(resolveSessionModelPinView(ds, bot)?.active).toBe(true);
});
