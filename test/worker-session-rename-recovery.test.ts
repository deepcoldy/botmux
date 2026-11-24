import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { decideSessionRenameSettlement } from '../src/core/session-rename-settlement.js';

const TITLE = '[BotMux·Lark] restored title';
const COMMAND = `/rename ${TITLE}`;

function recoveryHarness(surface: 'settled' | 'unsubmitted' | 'occupied' | 'unknown') {
  const probe = vi.fn(() => false);
  const watchSessionRename = vi.fn(() => probe);
  const scope: Record<string, any> = {
    cliSpawnGeneration: 7,
    sessionRenameReattachRecoveryGeneration: -1,
    sessionRenamePhase: 'idle',
    lastSpawnPersistentReattach: true,
    lastInitConfig: { nativeSessionTitle: TITLE },
    backend: {},
    cliAdapter: {
      buildSessionRenameCommand: (title: string) => `/rename ${title}`,
      sessionRenameSurface: () => surface,
      watchSessionRename,
    },
    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    sessionRenameSurfaceNow: () => surface,
    sessionRenameNativeSessionIdNow: () => 'native-id',
    sessionRenameResubmitted: false,
    sessionRenameHoldLogged: false,
    sessionRenameHoldNoticeSent: false,
    sessionRenameSentAtMs: 0,
    sessionRenameReattachRetryTimer: null,
    armSessionRenameReattachRecoveryRetry: vi.fn(),
    notifySessionRenameInputHeld: vi.fn(),
    armSessionRenameIdleTimeout: vi.fn(),
    log: vi.fn(),
  };
  return { scope, probe, watchSessionRename, recover: loadWorkerFunction<() => boolean>('recoverSessionRenameAfterPersistentReattach', scope) };
}

describe('native rename recovery after persistent worker reattach', () => {
  it('re-arms an exact surviving draft with the original receipt baseline and dynamic identity', () => {
    const h = recoveryHarness('unsubmitted');
    expect(h.recover()).toBe(true);
    expect(h.scope.sessionRenamePhase).toBe('sent');
    expect(h.scope.sessionRenameCommand).toBe(COMMAND);
    expect(h.scope.armSessionRenameIdleTimeout).toHaveBeenCalledOnce();
    expect(h.watchSessionRename).toHaveBeenCalledWith(COMMAND, {
      getCliSessionId: h.scope.sessionRenameNativeSessionIdNow,
      fromByte: 0,
    });
    expect(h.recover()).toBe(false);
    expect(h.scope.armSessionRenameIdleTimeout).toHaveBeenCalledOnce();
  });

  it('holds an occupied surface even when the predecessor already wrote this exact receipt', () => {
    const h = recoveryHarness('occupied');
    expect(h.recover()).toBe(true);
    const surface = h.scope.sessionRenameSurfaceNow();
    expect(decideSessionRenameSettlement({ surface, recorded: true, resubmitted: false, fromPrompt: false })).toBe('hold');
  });

  it('does not invent a rename hold for a settled surviving composer', () => {
    const h = recoveryHarness('settled');
    expect(h.recover()).toBe(false);
    expect(h.scope.sessionRenamePhase).toBe('idle');
    expect(h.scope.sessionRenameCommand).toBeUndefined();
    expect(h.watchSessionRename).not.toHaveBeenCalled();
  });

  it('blocks unknown evidence, schedules another read, and never guesses that the composer is safe', () => {
    const h = recoveryHarness('unknown');
    expect(h.recover()).toBe(true);
    expect(h.scope.sessionRenameReattachRecoveryGeneration).toBe(-1);
    expect(h.scope.armSessionRenameReattachRecoveryRetry).toHaveBeenCalledOnce();
    h.scope.sessionRenameSurfaceNow = () => 'unsubmitted';
    expect(h.recover()).toBe(true);
    expect(h.scope.sessionRenamePhase).toBe('sent');
  });
});

describe('sessionRenameNativeSessionIdNow', () => {
  it('recovers a TRAE id from the rollout owned by the live CLI pid', () => {
    const scope: Record<string, any> = {
      inputDeliveryObservedCliSessionId: undefined,
      lastInitConfig: { cliId: 'traex', cliSessionId: 'stale-config-id' },
      backend: {}, codexBridgeRolloutPath: '/tmp/rollout-native.jsonl',
      currentTraexObservedPid: () => 123,
      findTraexRolloutSetByPid: () => new Set(['native-id']),
      traexSessionIdFromRolloutPath: () => 'native-id',
    };
    const resolve = loadWorkerFunction<() => string | undefined>('sessionRenameNativeSessionIdNow', scope);
    expect(resolve()).toBe('native-id');
    expect(scope.inputDeliveryObservedCliSessionId).toBe('native-id');
  });

  it('does not substitute a configured resume id when live ownership is unavailable', () => {
    const scope: Record<string, any> = {
      inputDeliveryObservedCliSessionId: undefined,
      lastInitConfig: { cliId: 'traex', cliSessionId: 'stale-config-id' },
      backend: {}, codexBridgeRolloutPath: '/tmp/rollout-native.jsonl',
      currentTraexObservedPid: () => 123,
      findTraexRolloutSetByPid: () => undefined,
    };
    const resolve = loadWorkerFunction<() => string | undefined>('sessionRenameNativeSessionIdNow', scope);
    expect(resolve()).toBeUndefined();
    expect(scope.inputDeliveryObservedCliSessionId).toBeUndefined();
  });

  it('recovers a Codex id from an owned bridge rollout rather than the configured resume target', () => {
    const scope: Record<string, any> = {
      inputDeliveryObservedCliSessionId: undefined,
      lastInitConfig: { cliId: 'codex', cliSessionId: 'stale-config-id' },
      backend: {}, codexRpcEngine: undefined, codexBridgeRolloutPath: '/tmp/rollout-native.jsonl',
      currentCodexObservedPid: () => 123,
      findCodexRolloutSetByPid: () => new Set(['native-id']),
      readCodexLiveSessionId: () => undefined,
      codexGenerationSessionIdFromRolloutPath: () => 'native-id',
      codexHistorySidIsOwned: (sid: string, owned: Set<string>) => owned.has(sid),
    };
    const resolve = loadWorkerFunction<() => string | undefined>('sessionRenameNativeSessionIdNow', scope);
    expect(resolve()).toBe('native-id');
    expect(scope.inputDeliveryObservedCliSessionId).toBe('native-id');
  });

  it('uses an explicitly bound remote Codex thread without requiring a local rollout fd', () => {
    const scope: Record<string, any> = {
      inputDeliveryObservedCliSessionId: undefined,
      lastInitConfig: { cliId: 'codex' },
      backend: { expectedCodexSessionId: 'remote-thread-id' },
      codexRpcEngine: undefined,
    };
    const resolve = loadWorkerFunction<() => string | undefined>('sessionRenameNativeSessionIdNow', scope);
    expect(resolve()).toBe('remote-thread-id');
  });
});
