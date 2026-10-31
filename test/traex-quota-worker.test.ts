import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { TraexAutoModelController } from '../src/services/traex-auto-model.js';
import { TRAEX_QUOTA_ERROR_CODE } from '../src/services/traex-quota.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { checkpointCodexAdoptTurns, restoreCodexAdoptTurns } from '../src/services/codex-adopt-recovery.js';

function fixture(extra: Record<string, unknown> = {}) {
  const controller = new TraexAutoModelController({ enabled: true, trigger: 'quota', models: ['first', 'second', 'last'], queueTimeoutMs: 5000 });
  controller.beginTurn('turn');
  const authority = new ActiveTurnAuthority();
  authority.reserve({ turnId: 'turn' });
  authority.markStarted({ turnId: 'turn' });
  let resolve!: (value: any) => void;
  const catalog = new Promise<any>(done => { resolve = done; });
  const scope: Record<string, any> = {
    traexAutoModelRuntimeEligible: () => true, traexAutoModelController: controller,
    activeTurnAuthority: authority, currentBotmuxTurnId: 'turn', cliSpawnGeneration: 1,
    lastInitConfig: { cliSessionId: 'native', model: 'first' }, TRAEX_QUOTA_ERROR_CODE,
    currentTraexQuotas: vi.fn(() => catalog), executeTraexAutoModelSwitch: vi.fn(() => true),
    publishActiveRuntime: vi.fn(), emitReadyCodexTurns: vi.fn(), idleDetector: { fireIdle: vi.fn() },
    t: (key: string) => key, ...extra,
  };
  const recover = loadWorkerFunction<(turn: any) => boolean>('recoverTraexQuotaTurn', scope);
  const turn = { turnId: 'turn', sourceTurnId: 'native-turn', started: true,
    terminalStatus: 'failed', terminalErrorCode: TRAEX_QUOTA_ERROR_CODE };
  return { scope, recover, turn, resolve, controller };
}

describe('quota recovery worker boundary', () => {
  it('admits steady preferred-model turns without a remote quota read', () => {
    const f = fixture();
    f.controller.endTurn('turn');
    const head = { turnId: 'next', content: 'new task' };
    const scope = { ...f.scope, pendingMessages: [head], isPromptReady: true };
    expect(loadWorkerFunction('selectTraexQuotaModelBeforeTurn', scope)(head)).toBe(false);
    expect(scope.currentTraexQuotas).not.toHaveBeenCalled();
    expect(f.controller.beginTurn('next')).toEqual({ kind: 'none' });
  });
  it('still queries persisted blocks and resumes the preferred model after confirmed recovery', async () => {
    const f = fixture();
    const action = f.controller.observeQuotaFailure('turn', null);
    if (action.kind === 'switch') f.controller.commitSwitch(action);
    const restored = new TraexAutoModelController(f.controller.config, f.controller.runtimeState('native'));
    const head = { turnId: 'next', content: 'new task' };
    const scope = { ...f.scope, traexAutoModelController: restored, pendingMessages: [head],
      activeTurnAuthority: new ActiveTurnAuthority(), isPromptReady: true, flushPending: vi.fn() };
    expect(loadWorkerFunction('selectTraexQuotaModelBeforeTurn', scope)(head)).toBe(true);
    expect(scope.currentTraexQuotas).toHaveBeenCalledOnce();
    f.resolve(new Map([['first', { depleted: false }]]));
    await vi.waitFor(() => expect(scope.executeTraexAutoModelSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'next', toModel: 'first' }), { resumeCurrentTurn: false }));
  });
  it('still queries when the preferred model is at index 0 but carries a persisted block, then fails closed', async () => {
    const f = fixture();
    // Restored state: even the current preferred model has a persisted block.
    const state = f.controller.runtimeState('native');
    state.quotaBlocks = f.controller.config.models.map(model => ({ model }));
    const blocked = new TraexAutoModelController(f.controller.config, state);
    expect(blocked.currentModelIndex()).toBe(0);
    expect(blocked.hasQuotaBlocks()).toBe(true);
    const head = { turnId: 'next', content: 'new task' };
    const scope = { ...f.scope, traexAutoModelController: blocked, pendingMessages: [head],
      activeTurnAuthority: new ActiveTurnAuthority(), isPromptReady: true, flushPending: vi.fn(),
      send: vi.fn(), emitTurnTerminal: vi.fn() };
    expect(loadWorkerFunction('selectTraexQuotaModelBeforeTurn', scope)(head)).toBe(true);
    expect(scope.currentTraexQuotas).toHaveBeenCalledOnce();
    f.resolve(null); // Unknown evidence must not clear persisted blocks.
    await vi.waitFor(() => expect(scope.emitTurnTerminal).toHaveBeenCalledWith(
      'next', 'failed', TRAEX_QUOTA_ERROR_CODE));
    expect(scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
  });
  it('keeps the attribution journal recoverable during the async quota lookup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quota-journal-'));
    try {
      const path = join(dir, 'journal.json');
      const queue = new CodexBridgeQueue(() => 100000);
      queue.mark('turn', 'task', 100000);
      const user = { kind: 'user' as const, timestampMs: 100000, text: 'task', uuid: 'u', sourceTurnId: 'native-turn' };
      const final = { kind: 'assistant_final' as const, timestampMs: 101000, text: '', uuid: 'f', sourceTurnId: 'native-turn',
        terminalStatus: 'failed' as const, terminalErrorCode: TRAEX_QUOTA_ERROR_CODE };
      queue.ingest([user]);
      checkpointCodexAdoptTurns(path, '/rollout', queue);
      queue.ingest([final]);
      const scope: Record<string, any> = {
        codexBridgeQueue: queue, recoverTraexQuotaTurn: (turn: unknown) => {
          scope.traexQuotaPending = { turnId: 'turn', failedTurn: turn }; return true;
        }, checkpointCodexAdoptRecovery: () => {}, structuredBridgeJournalPath: () => path,
        codexBridgeRolloutPath: '/rollout', structuredBridgeRecoveryAttempted: true,
        codexBridgeOffset: 5000, checkpointCodexAdoptTurns, log: vi.fn(),
      };
      scope.checkpointStructuredBridgeRecovery = loadWorkerFunction('checkpointStructuredBridgeRecovery', scope);
      loadWorkerFunction('emitReadyCodexTurns', scope)();
      const fresh = new CodexBridgeQueue(() => 110000);
      const restored = restoreCodexAdoptTurns(path, '/rollout', fresh, [user, final], 109000, 110000);
      fresh.absorb(restored.history); fresh.ingest(restored.live);
      expect(restored.restored).toBe(1);
      expect(fresh.drainEmittable()).toEqual([expect.objectContaining({ turnId: 'turn', terminalStatus: 'failed' })]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('holds exactly one terminal, switches with original identity, and does not emit failure', async () => {
    const f = fixture();
    expect(f.recover(f.turn)).toBe(true);
    expect(f.recover(f.turn)).toBe(true);
    expect(f.scope.currentTraexQuotas).toHaveBeenCalledOnce();
    f.resolve(null);
    await vi.waitFor(() => expect(f.scope.executeTraexAutoModelSwitch).toHaveBeenCalledOnce());
    expect(f.scope.executeTraexAutoModelSwitch).toHaveBeenCalledWith(expect.objectContaining({
      turnId: 'turn', toModel: 'second', reason: 'quota_exhausted',
    }), { resumeCurrentTurn: true });
    expect(f.scope.emitReadyCodexTurns).not.toHaveBeenCalled();
  });
  it.each([
    { traexAutoModelTurnReplayForbidden: true }, { cliRestartInProgress: true },
    { traexAutoModelRuntimeEligible: () => false }, { lastInitConfig: {} },
  ])('fails closed for unsafe runtime %j', extra => {
    const f = fixture(extra);
    expect(f.recover(f.turn)).toBe(false);
    expect(f.scope.currentTraexQuotas).not.toHaveBeenCalled();
  });
  it.each([
    { terminalErrorCode: 'codex_rate_limited' }, { sourceTurnId: undefined },
    { dispatchAttempt: 1 }, { isLocal: true }, { supersededTurns: [{ turnId: 'steer' }] },
  ])('does not recover unsafe/unrelated terminal %j', extra => {
    const f = fixture();
    expect(f.recover({ ...f.turn, ...extra })).toBe(false);
  });
  it.each(['generation', 'cancel', 'session'])('does not resume after %s changes during catalog IO', async change => {
    const f = fixture();
    expect(f.recover(f.turn)).toBe(true);
    if (change === 'generation') f.scope.cliSpawnGeneration++;
    if (change === 'cancel') f.scope.traexQuotaPending = undefined;
    if (change === 'session') f.scope.lastInitConfig.cliSessionId = 'another';
    f.resolve(null);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
    expect(f.scope.emitReadyCodexTurns).not.toHaveBeenCalled();
  });
  it('delivers original failure when restart admission is refused', async () => {
    const f = fixture({ executeTraexAutoModelSwitch: vi.fn(() => false) });
    f.recover(f.turn);
    f.resolve(null);
    await vi.waitFor(() => expect(f.scope.emitReadyCodexTurns).toHaveBeenCalledWith([f.turn]));
  });
  it('a delivered stop key settles the held failure and cancels late recovery', async () => {
    const f = fixture({
      cliAdapter: { id: 'traex' }, isRemoteBackendType: () => false, backend: {},
      isCriticalInterruptKey: () => true,
      runAfterAmbiguousSubmissionWrites: async (_backend: unknown, action: () => unknown) => action(),
      sendCriticalControlKey: async (_key: string, action: () => unknown) => action(),
      sendTermActionOnce: vi.fn(() => true), log: vi.fn(), scheduleOneShotAfterAction: vi.fn(),
    });
    expect(f.recover(f.turn)).toBe(true);
    await loadWorkerFunction<(key: string) => Promise<void>>('handleTermAction', f.scope)('ctrlc');
    expect(f.scope.sendTermActionOnce).toHaveBeenCalledOnce();
    expect(f.scope.emitReadyCodexTurns).toHaveBeenCalledWith([f.turn]);
    f.resolve(null);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
    expect(f.scope.emitReadyCodexTurns).toHaveBeenCalledOnce();
  });
  it('stops after final model and releases failure exactly once', async () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) {
      const action = f.controller.observeQuotaFailure('turn', null);
      if (action.kind === 'switch') f.controller.commitSwitch(action);
    }
    f.recover(f.turn);
    f.resolve(null);
    await vi.waitFor(() => expect(f.scope.emitReadyCodexTurns).toHaveBeenCalledOnce());
    expect(f.scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
  });
});
