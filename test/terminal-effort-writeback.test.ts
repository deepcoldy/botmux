import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Session } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';
import { persistTerminalEffortChoice, terminalEffortChoiceWasSaved, hasConfirmedNativeGrokEffort } from '../src/core/terminal-effort-writeback.js';
import { terminalEffortPreferenceKey, type TerminalEffortChoice } from '../src/services/terminal-effort-choice.js';
import { resolveSessionLaunchEffort } from '../src/core/session-model.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { loadWorkerPoolMessageHandlers } from './helpers/worker-pool-message-harness.js';
import { loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';
import { resolveSessionLaunchModelChoice } from '../src/core/session-model.js';
import { resolveCliRuntime, snapshotCliRuntime, runtimePathOverride } from '../src/adapters/cli/runtime.js';
import { cliModelSupportsReasoningEffort, isBackendVariantCliId, isConfigurableReasoningCliId } from '../src/services/codex-reasoning-effort.js';
import { createGrokAdapter } from '../src/adapters/cli/grok.js';
import { applyClaudeEffortObservation } from '../src/core/claude-effort-observation.js';
import { applyNativeReasoningObservation } from '../src/core/native-reasoning-observation.js';
import { ClaudeEffortObserver } from '../src/services/claude-effort-observer.js';
import { TerminalEffortChoiceTracker, readClaudeEffortCommandReceipt } from '../src/services/terminal-effort-choice.js';
import { parseStatuslinePayload, writeStatuslineSnapshot, statuslineFilePath } from '../src/services/statusline-snapshot.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { admitSessionCommand } from '../src/services/session-command-gateway.js';

let directory: string;
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return directory; } } } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/core/cost-calculator.js', () => ({ getSessionTokenUsage: vi.fn(() => null) }));
import * as store from '../src/services/session-store.js';

const NOW = 1_799_000_000_000;
const APP = 'writeback-fixture';
const worker = { send: vi.fn() } as NonNullable<DaemonSession['worker']>;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'effort-writeback-')); vi.useFakeTimers(); vi.setSystemTime(NOW); store.init(APP); });
afterEach(() => { store.init('release-fixture'); vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });
function fixture(cliId: TerminalEffortChoice['cliId'] = 'claude-code') {
  const row = store.createSession('chat', 'root', 'effort', 'group', 'chat');
  Object.assign(row, { cliId, cliSessionId: 'native', model: 'claude-opus-5-5', reasoningEffort: 'high', workerGeneration: 4, agentFrozen: true });
  store.updateSession(row);
  const state = { worker, workerGeneration: 4, activeModel: row.model,
    localProcessAttestation: { cliSpawnGeneration: 2 }, session: structuredClone(row) } as DaemonSession;
  const selection: TerminalEffortChoice = { nonce: 'choice-1', cliId, nativeSessionId: 'native', cliSpawnGeneration: 2,
    requestedEffort: 'medium', requestedAtMs: NOW - 10, confirmedAtMs: NOW, model: row.model, source: 'terminal-input', enableEpoch: 0, expectedPreference: terminalEffortPreferenceKey(row) };
  const observation = { reasoningEffort: 'medium', userSelection: selection,
    ...(cliId === 'claude-code' ? { claudeSessionId: 'native' } : { cliId, nativeSessionId: 'native',
      cliSpawnGeneration: 2, observedAtMs: NOW, source: cliId === 'grok' ? 'native-summary' : 'native-settings' }) };
  const source = { worker, workerGeneration: 4, cliId };
  const options = { enabled: true, mutate: store.mutateOwnedSessionsAtomically, supportsEffort: () => true, now: NOW };
  return { row, state, selection, observation, source, options };
}

describe('terminal effort persistence', () => {
  it.each(['claude-code', 'codex', 'traex', 'grok'] as const)('%s saves a confirmed choice and cold reload resolves the new effort', cliId => {
    const f = fixture(cliId);
    expect(persistTerminalEffortChoice(f.state, f.observation, f.source, f.options)).toBe(true);
    expect(f.state.session.reasoningEffort).toBe('medium');
    store.init(APP);
    const restored = store.getSession(f.row.sessionId)!;
    expect(restored.reasoningEffort).toBe('medium');
    expect(resolveSessionLaunchEffort({ session: restored }, { cliId, model: restored.model }, restored.model, restored.reasoningEffort)).toBe('medium');
    if (cliId === 'claude-code') {
      const args = createClaudeCodeAdapter().buildArgs({ sessionId: restored.sessionId, resume: true,
        resumeSessionId: restored.cliSessionId, model: restored.model, reasoningEffort: restored.reasoningEffort } as any);
      expect(args[args.indexOf('--effort') + 1]).toBe('medium');
      expect(args[args.indexOf('--resume') + 1]).toBe('native');
    }
  });

  it('remembers native Grok xhigh for the exact resumed model even before the static table knows it', () => {
    const f = fixture('grok');
    f.state.activeModel = 'grok-4.7-build-fast'; f.row.model = f.state.activeModel; f.state.session.model = f.row.model;
    store.updateSession(f.row);
    const selection = { ...f.selection, requestedEffort: 'xhigh' as const, model: f.row.model,
      expectedPreference: terminalEffortPreferenceKey(f.row) };
    expect(persistTerminalEffortChoice(f.state, { ...f.observation, model: f.row.model, reasoningEffort: 'xhigh', userSelection: selection },
      f.source, { ...f.options, supportsEffort: () => false })).toBe(true);
    store.init(APP); const restored = store.getSession(f.row.sessionId)!;
    expect(hasConfirmedNativeGrokEffort(restored, restored.model)).toBe(true);
    expect(hasConfirmedNativeGrokEffort(restored, 'grok-other')).toBe(false);
    expect(hasConfirmedNativeGrokEffort({ ...restored, cliSessionId: 'other' }, restored.model)).toBe(false);
  });

  it.each([false, true])('fences newly confirmed Grok xhigh at the actual cold launch, snapshot=%s', snapshot => {
    const f = fixture('grok');
    Object.assign(f.row, { model: 'grok-4.7-build-fast', cliRuntime: snapshotCliRuntime(resolveCliRuntime({ cliId: 'grok' })) });
    if (snapshot) f.row.cliLaunchSnapshot = { cliId: 'grok', cliRuntime: f.row.cliRuntime, state: 'resolved', reasoningEffort: 'high', startupCommands: [] } as any;
    store.updateSession(f.row); f.state.session = structuredClone(f.row); f.state.activeModel = f.row.model;
    const choice = { ...f.selection, model: f.row.model, requestedEffort: 'xhigh' as const, expectedPreference: terminalEffortPreferenceKey(f.row) };
    expect(persistTerminalEffortChoice(f.state, { ...f.observation, model: f.row.model, reasoningEffort: 'xhigh', userSelection: choice },
      f.source, { ...f.options, supportsEffort: () => false })).toBe(true);
    store.init(APP); const saved = structuredClone(store.getSession(f.row.sessionId)!);
    function cold(enabled: boolean, model = saved.model, pin?: Session['modelPin']) {
      const ds = { session: { ...structuredClone(saved), ...(pin ? { modelPin: pin } : {}) } };
      const scope: Record<string, any> = { config: { terminalEffortWriteback: enabled }, sessionStore: { updateSession: store.updateSession },
        resolveSessionGroupSettings: () => ({}), resolveCliRuntime, snapshotCliRuntime, runtimePathOverride,
        isBackendVariantCliId, isConfigurableReasoningCliId, resolveSessionLaunchModelChoice, resolveSessionLaunchEffort,
        hasConfirmedNativeGrokEffort, cliModelSupportsReasoningEffort, recordCodexModelLaunch: () => false,
        refreshNativeCodexModel: () => false, cliSupportsConfigDir: () => false, RPC_CAPABLE_CLIS: new Set(['codex', 'traex']) };
      scope.recordLaunchModel = loadWorkerPoolFunction('recordLaunchModel', scope);
      scope.sessionServiceTier = loadWorkerPoolFunction('sessionServiceTier', scope);
      const cfg = loadWorkerPoolFunction('sessionAgentConfig', scope)(ds, { cliId: 'grok', model });
      const args = createGrokAdapter('/fake/grok').buildArgs({ sessionId: saved.sessionId, resume: true,
        resumeSessionId: saved.cliSessionId, model: cfg.model, reasoningEffort: cfg.reasoningEffort } as any);
      return { args, cfg, session: ds.session };
    }
    expect(cold(true).args).toContain('xhigh');
    const off = cold(false); expect(off.args).not.toContain('xhigh');
    expect(off.session.reasoningEffort).toBeUndefined();
    if (snapshot) expect(off.session.cliLaunchSnapshot?.reasoningEffort).toBeUndefined();
    expect(cold(true, 'grok-4.5').args).not.toContain('xhigh');
    const pin: NonNullable<Session['modelPin']> = { model: saved.model!, effort: 'high', source: 'command', setBy: 'fixture', setAt: new Date(NOW).toISOString() };
    store.mutateOwnedSessionsAtomically([saved.sessionId], rows => { rows.get(saved.sessionId)!.modelPin = pin; }, { modelPinWrite: true });
    expect(cold(true, saved.model, pin).cfg.reasoningEffort).toBe('high');
  });

  it('off means no disk write, including an otherwise valid selection', () => {
    const f = fixture(); const mutate = vi.fn(f.options.mutate);
    expect(persistTerminalEffortChoice(f.state, f.observation, f.source, { ...f.options, enabled: false, mutate })).toBe(false);
    expect(mutate).not.toHaveBeenCalled(); store.init(APP);
    expect(store.getSession(f.row.sessionId)!.reasoningEffort).toBe('high');
  });

  it('native observations without a user choice never write back', () => {
    const f = fixture();
    for (const reasoningEffort of ['medium', 'low', null]) {
      expect(persistTerminalEffortChoice(f.state, { claudeSessionId: 'native', reasoningEffort }, f.source, f.options)).toBe(false);
    }
    expect(store.getSession(f.row.sessionId)!.reasoningEffort).toBe('high');
  });

  it('rejects stale worker/native/process identities, invalid levels and unconfirmed observations', () => {
    const f = fixture();
    for (const source of [{ ...f.source, workerGeneration: 3 }, { ...f.source, worker: {} as typeof worker }]) {
      expect(persistTerminalEffortChoice(f.state, f.observation, source, f.options)).toBe(false);
    }
    for (const patch of [{ nativeSessionId: 'other' }, { cliSpawnGeneration: 1 }, { confirmedAtMs: NOW + 1 },
      { requestedAtMs: NOW - 61_000 }, { requestedEffort: 'invalid' }]) {
      expect(persistTerminalEffortChoice(f.state, { ...f.observation, userSelection: { ...f.selection, ...patch } as TerminalEffortChoice }, f.source, f.options)).toBe(false);
    }
    expect(persistTerminalEffortChoice(f.state, { ...f.observation, reasoningEffort: 'low' }, f.source, f.options)).toBe(false);
    expect(store.getSession(f.row.sessionId)!.reasoningEffort).toBe('high');
  });

  it('commits the matching launch snapshot in the same transaction', () => {
    const f = fixture();
    f.state.session.cliLaunchSnapshot = { cliId: 'claude-code', reasoningEffort: 'high' } as any;
    Object.assign(f.row, f.state.session); store.updateSession(f.row);
    f.selection.expectedPreference = terminalEffortPreferenceKey(f.row);
    const beforePin = f.state.session.modelPin;
    expect(persistTerminalEffortChoice(f.state, f.observation, f.source, f.options)).toBe(true);
    store.init(APP); const restored = store.getSession(f.row.sessionId)!;
    expect(restored.cliLaunchSnapshot?.reasoningEffort).toBe('medium');
    expect(restored.modelPin).toEqual(beforePin);
  });

  it('a failed transaction does not advance session memory and the same receipt can retry', () => {
    const f = fixture();
    const failed = () => { throw new Error('disk failure'); };
    expect(() => persistTerminalEffortChoice(f.state, f.observation, f.source, { ...f.options, mutate: failed })).toThrow('disk failure');
    expect(f.state.session.reasoningEffort).toBe('high');
    expect(store.getSession(f.row.sessionId)!.reasoningEffort).toBe('high');
    expect(persistTerminalEffortChoice(f.state, f.observation, f.source, f.options)).toBe(true);
    expect(persistTerminalEffortChoice(f.state, f.observation, f.source, f.options)).toBe(false);
  });

  it('a concurrent card or API edit wins the transaction compare-and-swap', () => {
    const f = fixture();
    f.row.reasoningEffort = 'low'; store.updateSession(f.row);
    expect(() => persistTerminalEffortChoice(f.state, f.observation, f.source, f.options)).toThrow('terminal_effort_selection_stale');
    expect(f.state.session.reasoningEffort).toBe('high');
    expect(store.getSession(f.row.sessionId)!.reasoningEffort).toBe('low');
  });

  it('an intervening edit wins even when daemon memory also catches up before the old ACK', () => {
    const f = fixture();
    f.row.reasoningEffort = 'low'; store.updateSession(f.row);
    f.state.session.reasoningEffort = 'low';
    expect(() => persistTerminalEffortChoice(f.state, f.observation, f.source, f.options)).toThrow('terminal_effort_selection_stale');
    expect(store.getSession(f.row.sessionId)!.reasoningEffort).toBe('low');
  });

  it('a replacement worker can save its first choice even when its local nonce repeats', () => {
    const f = fixture('codex');
    expect(persistTerminalEffortChoice(f.state, f.observation, f.source, f.options)).toBe(true);
    f.state.workerGeneration = 5; f.state.session.workerGeneration = 5;
    f.state.worker = { send: vi.fn() } as typeof worker;
    store.updateSession(f.state.session);
    const next = { ...f.selection, requestedEffort: 'high' as const, expectedPreference: terminalEffortPreferenceKey(f.state.session) };
    expect(persistTerminalEffortChoice(f.state, { ...f.observation, reasoningEffort: 'high', userSelection: next },
      { worker: f.state.worker, workerGeneration: 5, cliId: 'codex' }, f.options)).toBe(true);
    expect(store.getSession(f.row.sessionId)!.reasoningEffort).toBe('high');
  });

  it('a matching TraeX topic preference is updated with the session preference for cold resume', () => {
    const f = fixture('traex');
    f.state.session.topicReasoningEffort = { model: f.row.model!, effort: 'high' };
    store.updateSession(f.state.session);
    f.selection.expectedPreference = terminalEffortPreferenceKey(f.state.session);
    expect(persistTerminalEffortChoice(f.state, f.observation, f.source, f.options)).toBe(true);
    store.init(APP); const restored = store.getSession(f.row.sessionId)!;
    expect(resolveSessionLaunchEffort({ session: restored }, { cliId: 'traex', model: restored.model }, restored.model, restored.reasoningEffort)).toBe('medium');
  });

  it('an off/on toggle epoch expires old user intents even when no OFF observation arrived', () => {
    const f = fixture();
    expect(persistTerminalEffortChoice(f.state, f.observation, f.source, { ...f.options, enableEpoch: 2 })).toBe(false);
    expect(store.getSession(f.row.sessionId)!.reasoningEffort).toBe('high');
  });

  it('leaves dispatch and adopted session authority unchanged', () => {
    for (const patch of [{ dispatchLaunchSpec: { effective: { model: 'model', reasoningEffort: 'high' } } }, { adoptedFrom: {} }]) {
      const f = fixture(); Object.assign(f.state.session, patch);
      expect(persistTerminalEffortChoice(f.state, f.observation, f.source, f.options)).toBe(false);
      expect(store.getSession(f.row.sessionId)!.reasoningEffort).toBe('high');
    }
  });

  it.each(['claude-code', 'codex', 'traex', 'grok'] as const)('actual %s IPC branch gates writeback while preserving card observations', cliId => {
    const f = fixture(cliId);
    const msg = { type: cliId === 'claude-code' ? 'claude_effort' : 'native_reasoning', ...f.observation };
    const handle = (enabled: boolean) => loadWorkerPoolMessageHandlers([msg.type], {
      ds: f.state, worker, workerGeneration: 4, effectiveCliId: cliId, config: { terminalEffortWriteback: enabled },
      persistTerminalEffortChoice, terminalEffortChoiceWasSaved, terminalEffortPreferenceKey, sessionStore: store, cliModelSupportsReasoningEffort: () => true,
      applyClaudeEffortObservation, applyNativeReasoningObservation, scheduleActiveRuntimePatch: vi.fn(),
      logger: { warn: vi.fn() }, t: 'test',
    });
    handle(false)(msg); expect(f.state.session.reasoningEffort).toBe('high');
    handle(true)(msg); expect(f.state.session.reasoningEffort).toBe('medium');
  });
});

describe('actual worker confirmation, transaction and ACK pipeline', () => {
  function pipeline(options: { enabled?: boolean; failWrite?: boolean; failAck?: boolean; override?: string } = {}) {
    const f = fixture();
    const nativeFile = join(directory, 'native.jsonl');
    writeFileSync(nativeFile, '');
    const scope: Record<string, any> = {
      backend: {}, closeRequested: false, cliSpawnGeneration: 2, cliLifetimeNonce: 'fixture-lifetime',
      lastInitConfig: { cliId: 'claude-code', sessionId: f.row.sessionId, cliSessionId: 'native',
        larkAppId: APP, model: f.row.model, env: options.override ? { CLAUDE_CODE_EFFORT_LEVEL: options.override } : {} },
      config: { terminalEffortWriteback: options.enabled !== false, terminalEffortWritebackEpoch: 0,
        terminalEffortWritebackEnabledAtMs: NOW - 1, session: { dataDir: directory } },
      bridgeJsonlPath: nativeFile, sessionIdFromJsonlPath: () => 'native',
      claudeEffortNotBeforeMs: NOW - 1, claudeEffortObserver: new ClaudeEffortObserver(),
      terminalEffortTracker: new TerminalEffortChoiceTracker(), terminalEffortPendingChoice: undefined,
      terminalEffortSavedNonce: undefined, terminalEffortEnabledSinceMs: NOW - 1, terminalEffortEnableEpoch: 0,
      terminalEffortPreferenceAtSpawn: terminalEffortPreferenceKey(f.row), readClaudeEffortCommandReceipt,
      workerSessionEventScope: undefined,
      terminalEffortAwaitingClaudeChoice: undefined, sessionStore: store, terminalEffortPreferenceKey,
    };
    scope.readTerminalEffortPreference = loadWorkerFunction('readTerminalEffortPreference', scope);
    scope.terminalEffortWritebackEnabled = loadWorkerFunction('terminalEffortWritebackEnabled', scope);
    scope.confirmedTerminalEffortChoice = loadWorkerFunction('confirmedTerminalEffortChoice', scope);
    const ack = loadWorkerMessageHandler('terminal_effort_writeback_ack', scope);
    let ackFailure = options.failAck;
    const currentWorker = { send: vi.fn(message => {
      if (ackFailure) { ackFailure = false; throw new Error('ACK transport failed'); }
      expect(admitSessionCommand(message.type, undefined).allowed).toBe(true);
      void ack(message);
    }) } as unknown as typeof worker;
    f.state.worker = currentWorker;
    let writeFailure = options.failWrite;
    const mutate = vi.fn((...args: Parameters<typeof store.mutateOwnedSessionsAtomically>) => {
      if (writeFailure) { writeFailure = false; throw new Error('database is locked'); }
      return store.mutateOwnedSessionsAtomically(...args);
    });
    const handler = loadWorkerPoolMessageHandlers(['claude_effort'], {
      ds: f.state, worker: currentWorker, workerGeneration: 4, effectiveCliId: 'claude-code', config: scope.config,
      persistTerminalEffortChoice, terminalEffortChoiceWasSaved, terminalEffortPreferenceKey,
      sessionStore: { mutateOwnedSessionsAtomically: mutate }, cliModelSupportsReasoningEffort: () => true,
      applyClaudeEffortObservation, scheduleActiveRuntimePatch: vi.fn(), logger: { warn: vi.fn() }, t: 'fixture',
    });
    scope.send = vi.fn(handler);
    const poll = loadWorkerFunction<() => void>('publishClaudeEffortObservation', scope);
    function snapshot(level: 'high' | 'medium', at = Date.now()) {
      writeStatuslineSnapshot(directory, f.row.sessionId, parseStatuslinePayload({ session_id: 'native',
        model: { id: f.row.model }, effort: { level } }, at)!);
      // File-cache invalidation must advance along with the fake clock: Bun's
      // stat can give rapid same-size fixture rewrites the same real mtime.
      utimesSync(statuslineFilePath(directory, f.row.sessionId), at / 1000, at / 1000);
    }
    function command(at = Date.now(), success = true) {
      const content = '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>medium</command-args>';
      const stdout = success ? 'Set effort level to medium (saved as your default for new sessions): Balanced'
        : 'CLAUDE_CODE_EFFORT_LEVEL overrides this session';
      writeFileSync(nativeFile, [content, `<local-command-stdout>${stdout}</local-command-stdout>`].map((text, i) => JSON.stringify({
        type: 'user', sessionId: 'native', timestamp: new Date(at).toISOString(), uuid: `${at}:${i}`, message: { content: text },
      })).join('\n') + '\n');
    }
    function browserIntent(at = Date.now()) {
      scope.terminalEffortTracker.observe({ binding: { cliId: 'claude-code', nativeSessionId: 'native', cliSpawnGeneration: 2 },
        effort: 'high', model: f.row.model, atMs: at - 1 }, true, 'statusline');
      scope.terminalEffortTracker.input({}, '/effort medium\r', { cliId: 'claude-code', nativeSessionId: 'native', cliSpawnGeneration: 2 }, {
        enabled: true, ready: true, now: at, enableEpoch: scope.config.terminalEffortWritebackEpoch,
        readPreference: () => terminalEffortPreferenceKey(store.getSession(f.row.sessionId)!),
      });
    }
    return { f, scope, poll, snapshot, command, browserIntent, mutate, currentWorker, nativeFile };
  }

  it('does not turn an observed startup default into a preference, but a successful native command survives cold reload', () => {
    const p = pipeline(); p.snapshot('medium'); p.poll();
    expect(p.mutate).not.toHaveBeenCalled();
    p.command(); vi.setSystemTime(NOW + 1); p.snapshot('medium'); p.poll();
    expect(p.mutate).toHaveBeenCalledTimes(1);
    store.init(APP); expect(store.getSession(p.f.row.sessionId)!.reasoningEffort).toBe('medium');
  });

  it('retries the same retained native receipt after a database failure with no further CLI output', () => {
    const p = pipeline({ failWrite: true }); p.command(); p.snapshot('medium'); p.poll();
    expect(p.f.state.session.reasoningEffort).toBe('high');
    expect(p.f.state.activeReasoningEffort).toBe('medium');
    p.poll();
    expect(p.mutate).toHaveBeenCalledTimes(2);
    expect(p.f.state.session.reasoningEffort).toBe('medium');
    p.poll(); expect(p.mutate).toHaveBeenCalledTimes(2);
  });

  it('retries a lost ACK without committing the preference twice', () => {
    const p = pipeline({ failAck: true }); p.command(); p.snapshot('medium'); p.poll();
    expect(p.f.state.session.reasoningEffort).toBe('medium');
    p.poll();
    expect(p.mutate).toHaveBeenCalledTimes(1);
    expect(p.currentWorker.send).toHaveBeenCalledTimes(2);
    expect(p.scope.terminalEffortPendingChoice).toBeUndefined();
  });

  it('does not harvest commands executed while the switch was off when it is later enabled', () => {
    const p = pipeline({ enabled: false }); p.command(); p.snapshot('medium'); p.poll();
    vi.setSystemTime(NOW + 1000);
    Object.assign(p.scope.config, { terminalEffortWriteback: true, terminalEffortWritebackEpoch: 1, terminalEffortWritebackEnabledAtMs: NOW + 1000 });
    p.snapshot('medium'); p.poll();
    expect(p.mutate).not.toHaveBeenCalled();
    // A command stamped in the enabling tick remains ambiguous; exercise a
    // genuinely later user command (both runners use millisecond timestamps).
    vi.setSystemTime(NOW + 1001); p.command(); vi.setSystemTime(NOW + 1002); p.snapshot('medium'); p.poll();
    expect(p.mutate).toHaveBeenCalledTimes(1);
  });

  it('an environment override or failed command never supplies a successful user choice', () => {
    const p = pipeline({ override: 'medium' }); p.command(NOW, false); p.snapshot('medium'); p.poll();
    expect(p.mutate).not.toHaveBeenCalled();
  });

  it('retains browser CAS evidence if statusline arrives before the native success record', () => {
    const p = pipeline();
    p.f.row.reasoningEffort = 'low'; p.f.row.terminalEffortPreferenceEdit = { atMs: NOW + 5, source: 'explicit' };
    p.f.state.session.reasoningEffort = 'low'; store.updateSession(p.f.row);
    vi.setSystemTime(NOW + 10); p.browserIntent();
    writeFileSync(p.nativeFile, JSON.stringify({ type: 'user', sessionId: 'native', timestamp: new Date(NOW + 10).toISOString(),
      message: { content: '<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>medium</command-args>' } }) + '\n');
    vi.setSystemTime(NOW + 20); p.snapshot('medium'); p.poll();
    expect(p.mutate).not.toHaveBeenCalled(); expect(p.scope.terminalEffortAwaitingClaudeChoice).toBeDefined();
    vi.setSystemTime(NOW + 30); p.command(NOW + 10); p.poll();
    expect(p.f.state.session.reasoningEffort).toBe('medium');
  });

  it('a direct native command after an earlier explicit edit uses the current confirmed preference', () => {
    const p = pipeline();
    p.f.row.reasoningEffort = 'low'; p.f.row.terminalEffortPreferenceEdit = { atMs: NOW + 5, source: 'explicit' };
    p.f.state.session.reasoningEffort = 'low'; store.updateSession(p.f.row);
    vi.setSystemTime(NOW + 10); p.command(); vi.setSystemTime(NOW + 20); p.snapshot('medium'); p.poll();
    expect(p.f.state.session.reasoningEffort).toBe('medium');
  });

  it('an explicit edit after a direct native request prevents that older request from writing', () => {
    const p = pipeline(); p.command(NOW);
    p.f.row.reasoningEffort = 'low'; p.f.row.terminalEffortPreferenceEdit = { atMs: NOW + 5, source: 'explicit' };
    p.f.state.session.reasoningEffort = 'low'; store.updateSession(p.f.row);
    vi.setSystemTime(NOW + 20); p.snapshot('medium'); p.poll();
    expect(p.mutate).not.toHaveBeenCalled(); expect(p.f.state.session.reasoningEffort).toBe('low');
  });
});
