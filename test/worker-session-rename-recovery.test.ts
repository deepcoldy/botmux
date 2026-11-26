import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { decideSessionRenameSettlement } from '../src/core/session-rename-settlement.js';
import { beginRuntimeWriteCycle } from '../src/utils/runtime-screen-status.js';
import { watchNativeSessionIndex } from '../src/services/native-session-index.js';

const TITLE = '[BotMux·Lark] restored title';
const COMMAND = `/rename ${TITLE}`;

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function recoveryHarness(surface: 'settled' | 'unsubmitted' | 'occupied' | 'blocked' | 'unknown') {
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
    SESSION_RENAME_HOLD_TIMEOUT_MS: 45_000,
    sessionRenameReattachRetryTimer: null,
    armSessionRenameReattachRecoveryRetry: vi.fn(),
    notifySessionRenameInputHeld: vi.fn(),
    notifySessionRenameInputTimeout: vi.fn(),
    idleDetector: { programStatusHeldBusy: () => false, adoptPromptReady: vi.fn() },
    programStatusBlockedHoldsTypeAhead: () => false,
    isPromptReady: false,
    reattachOpenTurnGate: true,
    armSessionRenameIdleTimeout: vi.fn(),
    log: vi.fn(),
  };
  scope.restoreSessionRenameReadiness = loadWorkerFunction('restoreSessionRenameReadiness', scope);
  return { scope, probe, watchSessionRename, recover: loadWorkerFunction<() => boolean>('recoverSessionRenameAfterPersistentReattach', scope) };
}

describe('native rename recovery after persistent worker reattach', () => {
  it('re-arms an exact surviving draft with a fresh receipt baseline and dynamic identity', () => {
    const h = recoveryHarness('unsubmitted');
    expect(h.recover()).toBe(true);
    expect(h.scope.sessionRenamePhase).toBe('sent');
    expect(h.scope.sessionRenameCommand).toBe(COMMAND);
    expect(h.scope.armSessionRenameIdleTimeout).toHaveBeenCalledOnce();
    expect(h.watchSessionRename).toHaveBeenCalledTimes(2);
    expect(h.watchSessionRename).toHaveBeenNthCalledWith(1, COMMAND, {
      getCliSessionId: h.scope.sessionRenameNativeSessionIdNow,
    });
    expect(h.watchSessionRename).toHaveBeenNthCalledWith(2, COMMAND, {
      getCliSessionId: h.scope.sessionRenameNativeSessionIdNow,
      fromByte: 0,
    });
    expect(h.recover()).toBe(false);
    expect(h.scope.armSessionRenameIdleTimeout).toHaveBeenCalledOnce();
  });

  it('does not let a historical same-title receipt release an unknown surviving surface', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-rename-recovery-index-'));
    try {
      const path = join(dir, 'session_index.jsonl');
      const receipt = `${JSON.stringify({ id: 'native-id', thread_name: TITLE, updated_at: '2026-11-24T00:00:00Z' })}\n`;
      writeFileSync(path, receipt);
      const h = recoveryHarness('unsubmitted');
      h.scope.cliAdapter.watchSessionRename = (_command: string, opts: {
        getCliSessionId: () => string | undefined; fromByte?: number;
      }) => watchNativeSessionIndex(path, TITLE, opts.getCliSessionId, opts.fromByte);
      expect(h.recover()).toBe(true);

      h.scope.sessionRenameSurfaceNow = () => 'unknown';
      expect(h.scope.sessionRenameRecorded()).toBe(false);
      expect(decideSessionRenameSettlement({
        surface: 'unknown', recorded: h.scope.sessionRenameRecorded(), resubmitted: true, fromPrompt: false,
      })).toBe('hold');

      appendFileSync(path, receipt);
      expect(h.scope.sessionRenameRecorded()).toBe(true);
      expect(decideSessionRenameSettlement({
        surface: 'unknown', recorded: h.scope.sessionRenameRecorded(), resubmitted: true, fromPrompt: false,
      })).toBe('release');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('arms the receipt watcher before reading the surface so an intervening receipt counts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-rename-arm-race-'));
    try {
      const path = join(dir, 'session_index.jsonl');
      writeFileSync(path, '');
      const receipt = `${JSON.stringify({ id: 'native-id', thread_name: TITLE })}\n`;
      const h = recoveryHarness('unsubmitted');
      h.scope.cliAdapter.watchSessionRename = (_command: string, opts: {
        getCliSessionId: () => string | undefined; fromByte?: number;
      }) => watchNativeSessionIndex(path, TITLE, opts.getCliSessionId, opts.fromByte);
      h.scope.sessionRenameSurfaceNow = () => {
        // The receipt lands in the exact window between arming and screen read.
        appendFileSync(path, receipt);
        return 'unsubmitted';
      };
      expect(h.recover()).toBe(true);
      expect(h.scope.sessionRenameRecorded()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reuses the same armed watcher across unknown retries without losing an intervening receipt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-rename-unknown-reuse-'));
    try {
      const path = join(dir, 'session_index.jsonl');
      writeFileSync(path, '');
      let arms = 0;
      const h = recoveryHarness('unknown');
      h.scope.forceClearSessionRenameInFlight = loadWorkerFunction('forceClearSessionRenameInFlight', h.scope);
      h.scope.cliAdapter.watchSessionRename = (_command: string, opts: {
        getCliSessionId: () => string | undefined; fromByte?: number;
      }) => {
        arms++;
        return watchNativeSessionIndex(path, TITLE, opts.getCliSessionId, opts.fromByte);
      };
      expect(h.recover()).toBe(true);
      expect(arms).toBe(2);

      appendFileSync(path, `${JSON.stringify({ id: 'native-id', thread_name: TITLE })}\n`);
      expect(h.recover()).toBe(false);
      expect(arms).toBe(2);
      expect(h.scope.sessionRenameRecorded).toBeUndefined();
      expect(h.scope.sessionRenamePhase).toBe('idle');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases restored input at the hard cap when surviving evidence stays unknown', () => {
    const h = recoveryHarness('unknown');
    Object.assign(h.scope, {
      sessionRenameSentAtMs: Date.now() - 45_000,
      SESSION_RENAME_HOLD_TIMEOUT_MS: 45_000,
      notifySessionRenameInputTimeout: vi.fn(),
      isPromptReady: false,
      reattachOpenTurnGate: true,
    });
    h.scope.forceClearSessionRenameInFlight = loadWorkerFunction('forceClearSessionRenameInFlight', h.scope);
    expect(h.recover()).toBe(false);
    expect(h.scope.notifySessionRenameInputTimeout).toHaveBeenCalledWith('released');
    expect(h.scope.armSessionRenameReattachRecoveryRetry).not.toHaveBeenCalled();
    expect(h.scope.isPromptReady).toBe(false);
    expect(h.scope.reattachOpenTurnGate).toBe(true);
    expect(h.scope.sessionRenameReattachRecoveryGeneration).toBe(h.scope.cliSpawnGeneration);
  });

  it('does not manufacture readiness at the unknown cap when no reattach gate remains', () => {
    const h = recoveryHarness('unknown');
    Object.assign(h.scope, {
      sessionRenameSentAtMs: Date.now() - 45_000,
      isPromptReady: false,
      reattachOpenTurnGate: false,
    });
    h.scope.forceClearSessionRenameInFlight = loadWorkerFunction('forceClearSessionRenameInFlight', h.scope);

    expect(h.recover()).toBe(false);

    expect(h.scope.isPromptReady).toBe(false);
    expect(h.scope.reattachOpenTurnGate).toBe(false);
    expect(h.scope.idleDetector.adoptPromptReady).not.toHaveBeenCalled();
    expect(h.scope.notifySessionRenameInputTimeout).toHaveBeenCalledWith('released');
  });

  it.each([
    { before: 'unsubmitted' as const, after: 'settled' as const },
    { before: 'occupied' as const, after: 'unknown' as const },
    { before: 'blocked' as const, after: 'unknown' as const },
  ])('preserves reattach readiness provenance across $before → $after before timer release', async ({ before, after }) => {
    vi.useFakeTimers();
    const h = recoveryHarness(before);
    Object.assign(h.scope, {
      sessionRenameIdleTimer: null,
      SESSION_RENAME_IDLE_TIMEOUT_MS: 5_000,
      SESSION_RENAME_RECHECK_MS: 2_000,
      SESSION_RENAME_SLOW_RECHECK_MS: 10_000,
      SESSION_RENAME_FAST_RECHECK_WINDOW_MS: 30_000,
      SESSION_RENAME_RECOVERY_AFTER_MS: 60_000,
      decideSessionRenameSettlement,
      recoverUnconfirmedSessionRename: vi.fn(() => false),
      resubmitSessionRename: vi.fn(() => false),
      flushPending: vi.fn(),
      cliName: () => 'Codex',
    });
    h.scope.forceClearSessionRenameInFlight = loadWorkerFunction('forceClearSessionRenameInFlight', h.scope);
    h.scope.settleSessionRename = loadWorkerFunction('settleSessionRename', h.scope);
    h.scope.armSessionRenameIdleTimeout = loadWorkerFunction('armSessionRenameIdleTimeout', h.scope);

    expect(h.recover()).toBe(true);
    expect(h.scope.sessionRenamePhase).toBe('sent');
    expect(h.scope.reattachOpenTurnGate).toBe(true);
    h.scope.sessionRenameSurfaceNow = () => after;
    await vi.advanceTimersByTimeAsync(46_000);

    expect(h.scope.sessionRenamePhase).toBe('idle');
    expect(h.scope.isPromptReady).toBe(false);
    expect(h.scope.reattachOpenTurnGate).toBe(true);
    expect(h.scope.idleDetector.adoptPromptReady).not.toHaveBeenCalled();
  });

  it('restores an already-ready reattach after a real resubmit and silent settled receipt', async () => {
    vi.useFakeTimers();
    const h = recoveryHarness('unsubmitted');
    Object.assign(h.scope, {
      isPromptReady: true,
      reattachOpenTurnGate: false,
      rawInputRestartGate: false,
      commandLineWritesPending: 0,
      isFlushing: false,
      injectionFlushing: false,
      beginRuntimeWriteCycle,
      pendingMessages: [{ content: 'restored follow-up', turnId: 'restored-turn' }],
      flushPending: vi.fn(),
      sessionRenameIdleTimer: null,
      SESSION_RENAME_IDLE_TIMEOUT_MS: 5_000,
      SESSION_RENAME_RECHECK_MS: 2_000,
      SESSION_RENAME_SLOW_RECHECK_MS: 10_000,
      SESSION_RENAME_FAST_RECHECK_WINDOW_MS: 30_000,
      SESSION_RENAME_RECOVERY_AFTER_MS: 60_000,
      decideSessionRenameSettlement,
      recoverUnconfirmedSessionRename: vi.fn(() => false),
      cliName: () => 'Codex',
    });
    h.scope.idleDetector.reset = vi.fn();
    h.scope.backend.write = vi.fn(() => {
      h.probe.mockReturnValue(true);
      h.scope.sessionRenameSurfaceNow = () => 'settled';
    });
    h.scope.forceClearSessionRenameInFlight = loadWorkerFunction('forceClearSessionRenameInFlight', h.scope);
    h.scope.beginCliWriteCycle = loadWorkerFunction('beginCliWriteCycle', h.scope);
    h.scope.resubmitSessionRename = loadWorkerFunction('resubmitSessionRename', h.scope);
    h.scope.settleSessionRename = loadWorkerFunction('settleSessionRename', h.scope);
    h.scope.armSessionRenameIdleTimeout = loadWorkerFunction('armSessionRenameIdleTimeout', h.scope);

    expect(h.recover()).toBe(true);
    expect(h.scope.sessionRenamePreserveReattachReadiness).toBe(false);
    await vi.advanceTimersByTimeAsync(46_000);

    expect(h.scope.backend.write).toHaveBeenCalledExactlyOnceWith('\r');
    expect(h.scope.isPromptReady).toBe(true);
    expect(h.scope.reattachOpenTurnGate).toBe(false);
    expect(h.scope.sessionRenamePhase).toBe('idle');
    expect(h.scope.flushPending).toHaveBeenCalledOnce();
    expect(h.scope.idleDetector.adoptPromptReady).toHaveBeenCalled();
  });

  it('keeps one recovery clock when an unknown surface becomes an exact surviving draft', () => {
    const h = recoveryHarness('unknown');
    const startedAt = Date.now() - 1_000;
    h.scope.sessionRenameSentAtMs = startedAt;
    expect(h.recover()).toBe(true);
    h.scope.sessionRenameSurfaceNow = () => 'unsubmitted';
    expect(h.recover()).toBe(true);
    expect(h.scope.sessionRenameSentAtMs).toBe(startedAt);
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
    expect(h.scope.sessionRenameRecorded).toBeUndefined();
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
      adapterInputHandle: (value: unknown) => value,
      traexTerminalSessionIsBound: () => false,
      traexSessionIdFromRolloutPath: () => undefined,
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
      adapterInputHandle: (value: unknown) => value,
      traexTerminalSessionIsBound: () => false,
      traexSessionIdFromRolloutPath: () => undefined,
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

  it('uses an exact terminal binding for a shared Codex daemon with no owned rollout fd', () => {
    const backend = {};
    const scope: Record<string, any> = {
      inputDeliveryObservedCliSessionId: undefined,
      lastInitConfig: { cliId: 'codex' }, backend,
      adapterInputHandle: (value: unknown) => value,
      codexTerminalSessionIsBound: (_terminal: unknown, sid: string) => sid === 'thread-a',
      codexRpcEngine: undefined, codexBridgeRolloutPath: '/tmp/rollout-thread-a.jsonl',
      currentCodexObservedPid: () => 123,
      findCodexRolloutSetByPid: () => new Set(),
      codexGenerationSessionIdFromRolloutPath: () => 'thread-a',
    };
    const resolve = loadWorkerFunction<() => string | undefined>('sessionRenameNativeSessionIdNow', scope);
    expect(resolve()).toBe('thread-a');
    expect(scope.inputDeliveryObservedCliSessionId).toBe('thread-a');
  });

  it('uses an exact terminal binding when Linux sandboxing hides rollout ownership', () => {
    const backend = {};
    const scope: Record<string, any> = {
      inputDeliveryObservedCliSessionId: 'thread-b',
      lastInitConfig: { cliId: 'codex' }, backend,
      adapterInputHandle: (value: unknown) => value,
      codexTerminalSessionIsBound: (_terminal: unknown, sid: string) => sid === 'thread-b',
      codexRpcEngine: undefined, codexBridgeRolloutPath: '/tmp/rollout-thread-a.jsonl',
      currentCodexObservedPid: () => 123,
      findCodexRolloutSetByPid: () => undefined,
      codexGenerationSessionIdFromRolloutPath: () => 'thread-a',
    };
    const resolve = loadWorkerFunction<() => string | undefined>('sessionRenameNativeSessionIdNow', scope);
    expect(resolve()).toBe('thread-b');
    expect(scope.inputDeliveryObservedCliSessionId).toBe('thread-b');
  });

  it('refuses a bare bridge/cache identity when shared or sandbox ownership is unbound', () => {
    for (const owned of [new Set<string>(), undefined] as const) {
      const backend = {};
      const scope: Record<string, any> = {
        inputDeliveryObservedCliSessionId: 'thread-a',
        lastInitConfig: { cliId: 'codex' }, backend,
        adapterInputHandle: (value: unknown) => value,
        codexTerminalSessionIsBound: () => false,
        codexRpcEngine: undefined, codexBridgeRolloutPath: '/tmp/rollout-thread-a.jsonl',
        currentCodexObservedPid: () => 123,
        findCodexRolloutSetByPid: () => owned,
        codexGenerationSessionIdFromRolloutPath: () => 'thread-a',
      };
      const resolve = loadWorkerFunction<() => string | undefined>('sessionRenameNativeSessionIdNow', scope);
      expect(resolve()).toBeUndefined();
      expect(scope.inputDeliveryObservedCliSessionId).toBe('thread-a');
    }
  });

  it('follows the live Codex thread instead of polling a previously cached thread id', () => {
    const scope: Record<string, any> = {
      inputDeliveryObservedCliSessionId: 'thread-a',
      lastInitConfig: { cliId: 'codex' },
      backend: {}, codexRpcEngine: undefined, codexBridgeRolloutPath: '/tmp/rollout-thread-a.jsonl',
      currentCodexObservedPid: () => 123,
      findCodexRolloutSetByPid: () => new Set(['thread-a', 'thread-b']),
      readCodexLiveSessionId: () => 'thread-b',
      codexGenerationSessionIdFromRolloutPath: () => 'thread-a',
      codexHistorySidIsOwned: (sid: string, owned: Set<string>) => owned.has(sid),
    };
    const resolve = loadWorkerFunction<() => string | undefined>('sessionRenameNativeSessionIdNow', scope);
    expect(resolve()).toBe('thread-b');
    expect(scope.inputDeliveryObservedCliSessionId).toBe('thread-b');
  });

  it('refuses ambiguous Codex bridge/cache identity with multiple owned rollouts, then relies on the hold cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-rename-multi-codex-'));
    try {
      const scope: Record<string, any> = {
        inputDeliveryObservedCliSessionId: 'thread-a',
        lastInitConfig: { cliId: 'codex' },
        backend: {}, codexRpcEngine: undefined, codexBridgeRolloutPath: '/tmp/rollout-thread-a.jsonl',
        currentCodexObservedPid: () => 123,
        findCodexRolloutSetByPid: () => new Set(['thread-a', 'thread-b']),
        readCodexLiveSessionId: () => undefined,
        codexGenerationSessionIdFromRolloutPath: () => 'thread-a',
        codexHistorySidIsOwned: (sid: string, owned: Set<string>) => owned.has(sid),
      };
      const resolve = loadWorkerFunction<() => string | undefined>('sessionRenameNativeSessionIdNow', scope);
      expect(resolve()).toBeUndefined();
      expect(scope.inputDeliveryObservedCliSessionId).toBe('thread-a');

      // A newer cache value must not be overwritten by a different bridge id
      // when neither can identify the current top-level thread.
      scope.inputDeliveryObservedCliSessionId = 'thread-b';
      expect(resolve()).toBeUndefined();
      expect(scope.inputDeliveryObservedCliSessionId).toBe('thread-b');

      const path = join(dir, 'session_index.jsonl');
      writeFileSync(path, '');
      const recorded = watchNativeSessionIndex(path, TITLE, resolve);
      appendFileSync(path, `${JSON.stringify({ id: 'thread-a', thread_name: TITLE })}\n`);
      appendFileSync(path, `${JSON.stringify({ id: 'thread-b', thread_name: TITLE })}\n`);
      expect(recorded()).toBe(false);
      expect(decideSessionRenameSettlement({
        surface: 'unknown', recorded: recorded(), resubmitted: true, fromPrompt: false,
      })).toBe('hold');
      expect(decideSessionRenameSettlement({
        surface: 'unknown', recorded: recorded(), resubmitted: true, fromPrompt: false, holdExpired: true,
      })).toBe('release_unconfirmed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses ambiguous TRAE bridge/cache identity with multiple owned rollouts', () => {
    const scope: Record<string, any> = {
      inputDeliveryObservedCliSessionId: 'thread-b',
      lastInitConfig: { cliId: 'traex' },
      backend: {}, codexBridgeRolloutPath: '/tmp/rollout-thread-a.jsonl',
      currentTraexObservedPid: () => 123,
      findTraexRolloutSetByPid: () => new Set(['thread-a', 'thread-b']),
      traexSessionIdFromRolloutPath: () => 'thread-a',
    };
    const resolve = loadWorkerFunction<() => string | undefined>('sessionRenameNativeSessionIdNow', scope);
    expect(resolve()).toBeUndefined();
    expect(scope.inputDeliveryObservedCliSessionId).toBe('thread-b');
  });

  it('uses the explicitly bound RPC thread for TRAE shared app-server sessions', () => {
    const scope: Record<string, any> = {
      inputDeliveryObservedCliSessionId: undefined,
      lastInitConfig: { cliId: 'traex' },
      backend: {}, codexRpcEngine: { activeThreadId: 'rpc-thread' },
      currentTraexObservedPid: () => undefined,
      findTraexRolloutSetByPid: () => undefined,
    };
    const resolve = loadWorkerFunction<() => string | undefined>('sessionRenameNativeSessionIdNow', scope);
    expect(resolve()).toBe('rpc-thread');
    expect(scope.inputDeliveryObservedCliSessionId).toBe('rpc-thread');
  });

  it('uses the exact TRAE terminal binding when shared or sandbox ownership is unavailable', () => {
    for (const owned of [new Set<string>(), undefined] as const) {
      const backend = {};
      const scope: Record<string, any> = {
        inputDeliveryObservedCliSessionId: undefined,
        lastInitConfig: { cliId: 'traex' }, backend,
        adapterInputHandle: (value: unknown) => value,
        traexTerminalSessionIsBound: (_terminal: unknown, sid: string) => sid === 'thread-a',
        codexRpcEngine: undefined, codexBridgeRolloutPath: '/tmp/rollout-thread-a.jsonl',
        currentTraexObservedPid: () => 123,
        findTraexRolloutSetByPid: () => owned,
        traexSessionIdFromRolloutPath: () => 'thread-a',
      };
      const resolve = loadWorkerFunction<() => string | undefined>('sessionRenameNativeSessionIdNow', scope);
      expect(resolve()).toBe('thread-a');
      expect(scope.inputDeliveryObservedCliSessionId).toBe('thread-a');
    }
  });

  it('rejects an unbound TRAE bridge/cache when shared ownership is unavailable', () => {
    const backend = {};
    const scope: Record<string, any> = {
      inputDeliveryObservedCliSessionId: 'thread-a',
      lastInitConfig: { cliId: 'traex' }, backend,
      adapterInputHandle: (value: unknown) => value,
      traexTerminalSessionIsBound: () => false,
      codexRpcEngine: undefined, codexBridgeRolloutPath: '/tmp/rollout-thread-a.jsonl',
      currentTraexObservedPid: () => 123,
      findTraexRolloutSetByPid: () => new Set<string>(),
      traexSessionIdFromRolloutPath: () => 'thread-a',
    };
    const resolve = loadWorkerFunction<() => string | undefined>('sessionRenameNativeSessionIdNow', scope);
    expect(resolve()).toBeUndefined();
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
