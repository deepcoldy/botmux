import { describe, it, expect } from 'vitest';
import {
  cancelAntigravityRotationReplay,
  clearInFlightAntigravityRotation,
  formatAntigravityCooldown,
  formatAntigravityStatusLine,
  isAntigravityQuotaAutoRotateEligible,
  tryAntigravityQuotaAutoRotate,
  type AntigravityQuotaAutoRotateDeps,
  type AntigravitySessionRotationState,
} from '../src/core/antigravity-rotation.js';
import { RestartCoordinator, type RestartObserverStatus } from '../src/core/restart-coordinator.js';
import type { CliUsageLimitState } from '../src/utils/cli-usage-limit.js';
import { shouldSuppressRestartInterruptionScan } from '../src/services/restart-interruption.js';

function nativeAgyLimit(overrides: Partial<CliUsageLimitState> = {}): CliUsageLimitState {
  return {
    limited: true,
    kind: 'usage',
    retryAtMs: 1_800_000_000_000,
    retryLabel: '4h',
    retryReady: false,
    source: 'antigravity-error-composer',
    ...overrides,
  };
}

function makeHarness(overrides: Partial<AntigravityQuotaAutoRotateDeps> = {}) {
  let rotationState: AntigravitySessionRotationState | undefined;
  let sessionAccountId: string | undefined = 'acc1';
  let clearedUsageLimit = 0;
  let settleRestart: ((status: RestartObserverStatus) => void | Promise<void>) | undefined;
  const events: Array<{ type: string; payload?: unknown }> = [];
  let tokenSeq = 0;

  const baseDeps: AntigravityQuotaAutoRotateDeps = {
    effectiveCliId: 'antigravity',
    usageLimit: nativeAgyLimit(),
    suppressRecoveryCard: false,
    isAdoptSession: false,
    isRemoteBackend: false,
    isTransferring: false,
    hasProtectedMutation: false,
    hasPendingFork: false,
    restartInFlight: false,
    sessionAccountId,
    screenTurnId: 'turn-1',
    lastCliInputTurnId: 'turn-1',
    lastMessageAt: 1_000,
    replayPayload: { sourceTurnId: 'turn-1', cliInput: 'fix the bug', userPrompt: 'fix the bug' },
    createToken: () => `tok-${++tokenSeq}`,
    getRotationState: () => rotationState,
    setRotationState: s => { rotationState = s; },
    rotateAccount: () => ({
      outcome: 'rotated',
      fromId: 'acc1',
      fromEmail: 'a@example.com',
      toId: 'acc2',
      toEmail: 'b@example.com',
      cooldownUntilMs: 1_800_000_000_000,
    }),
    requestRestart: onSettled => {
      settleRestart = onSettled;
      events.push({ type: 'restart_requested' });
      return { started: true };
    },
    isStillOwned: () => true,
    hasManualIntervention: () => false,
    updateSessionAccount: id => {
      sessionAccountId = id;
      events.push({ type: 'account_updated', payload: id });
    },
    clearUsageLimit: () => {
      clearedUsageLimit += 1;
      events.push({ type: 'usage_limit_cleared' });
    },
    replayTurn: payload => {
      events.push({ type: 'replayed', payload });
      return { accepted: true, retryTurnId: `replay-${tokenSeq}` };
    },
    notifySwitching: info => events.push({ type: 'notify_switching', payload: info }),
    notifyRestartFailed: info => events.push({ type: 'notify_restart_failed', payload: info }),
    notifyManualReplayNeeded: info => events.push({ type: 'notify_manual_replay', payload: info }),
    notifyReplayFailed: info => events.push({ type: 'notify_replay_failed', payload: info }),
    ...overrides,
  };

  return {
    deps: baseDeps,
    events,
    getRotationState: () => rotationState,
    setRotationState: (s: AntigravitySessionRotationState | undefined) => { rotationState = s; },
    getSessionAccountId: () => sessionAccountId,
    getClearedUsageLimit: () => clearedUsageLimit,
    triggerRestartSettled: (status: RestartObserverStatus) => settleRestart?.(status),
  };
}

describe('antigravity quota auto-rotation state machine', () => {
  it('enforces every fail-closed eligibility gate', () => {
    const valid = {
      effectiveCliId: 'antigravity',
      usageLimit: nativeAgyLimit(),
    };
    expect(isAntigravityQuotaAutoRotateEligible(valid)).toBe(true);
    expect(isAntigravityQuotaAutoRotateEligible({ ...valid, effectiveCliId: 'claude-code' })).toBe(false);
    expect(isAntigravityQuotaAutoRotateEligible({ ...valid, usageLimit: nativeAgyLimit({ kind: 'rate' }) })).toBe(false);
    expect(isAntigravityQuotaAutoRotateEligible({ ...valid, usageLimit: nativeAgyLimit({ source: undefined }) })).toBe(false);
    expect(isAntigravityQuotaAutoRotateEligible({ ...valid, suppressRecoveryCard: true })).toBe(false);
    expect(isAntigravityQuotaAutoRotateEligible({ ...valid, isAdoptSession: true })).toBe(false);
    expect(isAntigravityQuotaAutoRotateEligible({ ...valid, isRemoteBackend: true })).toBe(false);
    expect(isAntigravityQuotaAutoRotateEligible({ ...valid, isTransferring: true })).toBe(false);
    expect(isAntigravityQuotaAutoRotateEligible({ ...valid, hasProtectedMutation: true })).toBe(false);
    expect(isAntigravityQuotaAutoRotateEligible({ ...valid, hasPendingFork: true })).toBe(false);
    expect(isAntigravityQuotaAutoRotateEligible({ ...valid, restartInFlight: true })).toBe(false);
    expect(isAntigravityQuotaAutoRotateEligible({
      ...valid,
      currentRotation: { logicalTurnId: 't1', attemptedAccountIds: ['acc1'], rotationsUsed: 1, inFlightToken: 'tok-1' },
    })).toBe(false);
  });

  it('rotates, restarts, clears limit, updates account, and replays the interrupted turn on success', () => {
    const h = makeHarness();
    const res = tryAntigravityQuotaAutoRotate(h.deps);
    expect(res).toMatchObject({ outcome: 'started', fromId: 'acc1', toId: 'acc2', alreadyRotated: false });
    expect(h.getRotationState()?.inFlightToken).toBe('tok-1');
    expect(h.events.map(e => e.type)).toEqual(['restart_requested', 'notify_switching']);

    // Intermediate in_progress status is ignored.
    h.triggerRestartSettled('in_progress');
    expect(h.getRotationState()?.inFlightToken).toBe('tok-1');

    // Restart succeeds -> updates account, clears limit, replays turn, links lastReplayTurnId.
    h.triggerRestartSettled('succeeded');
    expect(h.getSessionAccountId()).toBe('acc2');
    expect(h.getClearedUsageLimit()).toBe(1);
    expect(h.getRotationState()?.inFlightToken).toBeUndefined();
    expect(h.getRotationState()?.lastReplayTurnId).toBe('replay-1');
    expect(h.events.map(e => e.type)).toEqual([
      'restart_requested',
      'notify_switching',
      'account_updated',
      'usage_limit_cleared',
      'replayed',
    ]);
  });

  it('preserves logicalTurnId and exclusion set across multi-hop retries and stops on budget or exhaustion', () => {
    const excludedCalls: string[][] = [];
    let hop = 0;
    const h = makeHarness({
      maxRotationsPerTurn: 2,
      rotateAccount: params => {
        excludedCalls.push([...(params.excludeAccountIds ?? [])]);
        hop += 1;
        if (hop === 1) return { outcome: 'rotated', fromId: 'acc1', toId: 'acc2' };
        if (hop === 2) return { outcome: 'rotated', fromId: 'acc2', toId: 'acc3' };
        return { outcome: 'rotated', fromId: 'acc3', toId: 'acc4' };
      },
    });

    // Hop 1: acc1 -> acc2, replays as replay-1.
    expect(tryAntigravityQuotaAutoRotate(h.deps).outcome).toBe('started');
    h.triggerRestartSettled('succeeded');
    expect(h.getRotationState()?.lastReplayTurnId).toBe('replay-1');

    // Hop 2: replay-1 immediately hits quota on acc2 -> same logicalTurnId, excludes acc1 & acc2!
    const hop2 = tryAntigravityQuotaAutoRotate({
      ...h.deps,
      sessionAccountId: 'acc2',
      screenTurnId: 'replay-1',
      lastCliInputTurnId: 'replay-1',
      replayPayload: { sourceTurnId: 'replay-1', cliInput: 'fix the bug', userPrompt: 'fix the bug' },
    });
    expect(hop2).toMatchObject({ outcome: 'started', fromId: 'acc2', toId: 'acc3' });
    expect(excludedCalls[1]).toEqual(expect.arrayContaining(['acc1', 'acc2']));
    h.triggerRestartSettled('succeeded');

    // Hop 3: replay-2 hits quota on acc3 -> maxRotationsPerTurn (2) reached! Stops without calling rotateAccount again.
    const hop3 = tryAntigravityQuotaAutoRotate({
      ...h.deps,
      sessionAccountId: 'acc3',
      screenTurnId: 'replay-2',
      lastCliInputTurnId: 'replay-2',
    });
    expect(hop3).toMatchObject({ outcome: 'exhausted', reason: 'turn_budget_exhausted', fromId: 'acc3' });
    expect(hop).toBe(2);

    // A brand-new user turn (turn-2) resets the per-turn rotation budget!
    const turn2 = tryAntigravityQuotaAutoRotate({
      ...h.deps,
      sessionAccountId: 'acc3',
      screenTurnId: 'turn-2',
      lastCliInputTurnId: 'turn-2',
      replayPayload: { sourceTurnId: 'turn-2', cliInput: 'new task', userPrompt: 'new task' },
    });
    expect(turn2).toMatchObject({ outcome: 'started', fromId: 'acc3', toId: 'acc4' });
  });

  it('skips auto-replay when a human intervenes mid-restart, while still adopting the new account', () => {
    let intervened = false;
    const h = makeHarness({
      hasManualIntervention: () => intervened,
    });
    expect(tryAntigravityQuotaAutoRotate(h.deps).outcome).toBe('started');

    // User sends a new message while restart is in flight.
    intervened = true;
    h.triggerRestartSettled('succeeded');

    expect(h.getSessionAccountId()).toBe('acc2');
    expect(h.getClearedUsageLimit()).toBe(1);
    expect(h.events.some(e => e.type === 'replayed')).toBe(false);
  });

  it('honors worker-reported account override if an operator switched active account mid-restart', () => {
    const h = makeHarness();
    expect(tryAntigravityQuotaAutoRotate(h.deps).outcome).toBe('started');
    // Simulate worker reporting `antigravity_account: acc3` before restart_result arrives.
    const st = h.getRotationState()!;
    h.setRotationState({ ...st, workerReportedAccountId: 'acc3' });
    h.triggerRestartSettled('succeeded');

    expect(h.getSessionAccountId()).toBe('acc3');
    expect(h.getRotationState()?.attemptedAccountIds).toContain('acc3');
  });

  it('releases inFlightToken and rolls back budget when requestRestart refuses or throws', () => {
    const h = makeHarness({
      requestRestart: () => ({ started: false }),
    });
    const res = tryAntigravityQuotaAutoRotate(h.deps);
    expect(res).toEqual({ outcome: 'restart_refused', toId: 'acc2' });
    expect(h.getRotationState()?.inFlightToken).toBeUndefined();
    expect(h.getRotationState()?.rotationsUsed).toBe(0);
    expect(h.events.some(e => e.type === 'notify_switching')).toBe(false);
  });

  it('keeps usageLimit and account unchanged when restart fails or times out, and stays silent on cancel or stale ownership', () => {
    const hFail = makeHarness();
    expect(tryAntigravityQuotaAutoRotate(hFail.deps).outcome).toBe('started');
    hFail.triggerRestartSettled('failed');
    expect(hFail.getSessionAccountId()).toBe('acc1');
    expect(hFail.getClearedUsageLimit()).toBe(0);
    expect(hFail.events.some(e => e.type === 'notify_restart_failed')).toBe(true);
    expect(hFail.events.some(e => e.type === 'replayed')).toBe(false);

    // Cancelled (session closed mid-restart): silent, no replay, no restart-failed notice.
    const hCancel = makeHarness();
    expect(tryAntigravityQuotaAutoRotate(hCancel.deps).outcome).toBe('started');
    hCancel.triggerRestartSettled('cancelled');
    expect(hCancel.events.some(e => e.type === 'notify_restart_failed')).toBe(false);
    expect(hCancel.events.some(e => e.type === 'replayed')).toBe(false);

    // Stale ownership (worker/session closed underneath): zero side effects on late callback.
    let owned = true;
    const hStale = makeHarness({ isStillOwned: () => owned });
    expect(tryAntigravityQuotaAutoRotate(hStale.deps).outcome).toBe('started');
    owned = false;
    hStale.triggerRestartSettled('succeeded');
    expect(hStale.getClearedUsageLimit()).toBe(0);
    expect(hStale.events.some(e => e.type === 'replayed')).toBe(false);
  });

  it('notifies appropriately when replayPayload is missing or replay is rejected', () => {
    const hNoPayload = makeHarness({ replayPayload: undefined });
    expect(tryAntigravityQuotaAutoRotate(hNoPayload.deps).outcome).toBe('started');
    hNoPayload.triggerRestartSettled('succeeded');
    expect(hNoPayload.events.some(e => e.type === 'notify_manual_replay')).toBe(true);

    const hReject = makeHarness({ replayTurn: () => ({ accepted: false }) });
    expect(tryAntigravityQuotaAutoRotate(hReject.deps).outcome).toBe('started');
    hReject.triggerRestartSettled('succeeded');
    expect(hReject.events.some(e => e.type === 'notify_replay_failed')).toBe(true);
  });

  it('formats /status account lines, cooldowns, and suppresses interruption scan only for antigravity rotation', () => {
    const managedLine = formatAntigravityStatusLine({
      sessionAccountId: 'acc1',
      inspection: {
        managed: true,
        autoRotate: true,
        activeId: 'acc2',
        liveTokenPresent: true,
        liveTokenMatchesActive: true,
        keyringRisk: { status: 'file-storage-active' },
        accounts: [
          { id: 'acc1', email: 'alice@example.com', maskedEmail: 'al***e@example.com', enabled: true, active: false, hasValidToken: true, inCooldown: true, addedAt: '' },
          { id: 'acc2', email: 'bob@example.com', maskedEmail: 'bo***b@example.com', enabled: true, active: true, hasValidToken: true, inCooldown: false, addedAt: '' },
        ],
        availableCount: 1,
        enabledCount: 2,
      },
    });
    expect(managedLine).toBe('Antigravity account: acc1 (al***e@example.com) → active: acc2 (pool 1/2 ready, auto-rotate: on)');

    expect(formatAntigravityStatusLine({
      inspection: {
        managed: false,
        autoRotate: true,
        activeId: null,
        liveTokenPresent: true,
        liveEmail: 'solo@example.com',
        liveMaskedEmail: 'so***o@example.com',
        liveTokenMatchesActive: false,
        keyringRisk: { status: 'file-storage-active' },
        accounts: [],
        availableCount: 0,
        enabledCount: 0,
      },
    })).toBe('Antigravity account: so***o@example.com (unmanaged)');

    expect(formatAntigravityCooldown(90 * 60_000, 'zh')).toBe('1 小时 30 分钟');
    expect(formatAntigravityCooldown(90 * 60_000, 'en')).toBe('1h 30m');

    expect(shouldSuppressRestartInterruptionScan({
      restartCause: 'antigravity-account-rotation',
      cliId: 'antigravity',
    })).toBe(true);
    expect(shouldSuppressRestartInterruptionScan({
      restartCause: 'antigravity-account-rotation',
      cliId: 'claude-code',
    })).toBe(false);
  });

  it('clears inFlightToken and notifies restart failure when worker crashes mid-restart (isStillOwned=false, isSessionActive=true)', () => {
    let workerAlive = true;
    const h = makeHarness({
      isStillOwned: () => workerAlive,
      isSessionActive: () => true,
    });
    expect(tryAntigravityQuotaAutoRotate(h.deps).outcome).toBe('started');
    // Simulate worker.on('exit') setting ds.worker = null BEFORE failSession microtask runs.
    workerAlive = false;
    h.triggerRestartSettled('failed');

    expect(h.getRotationState()?.inFlightToken).toBeUndefined();
    expect(h.events.some(e => e.type === 'notify_restart_failed')).toBe(true);
    expect(h.events.some(e => e.type === 'replayed')).toBe(false);

    // Subsequent worker generation can rotate again without being wedged.
    workerAlive = true;
    const nextRes = tryAntigravityQuotaAutoRotate({
      ...h.deps,
      sessionAccountId: 'acc2',
      screenTurnId: 'turn-2',
      lastCliInputTurnId: 'turn-2',
    });
    expect(nextRes.outcome).toBe('started');
  });

  it('honors /stop cancellation mid-restart, catches rotateAccount exceptions, rejects null worker reconcile report, and continues logical turn via screenTurnId', () => {
    // 1. /stop cancels auto-replay while still adopting the new account.
    const hStop = makeHarness();
    expect(tryAntigravityQuotaAutoRotate(hStop.deps).outcome).toBe('started');
    expect(cancelAntigravityRotationReplay(hStop.getRotationState())).toBe(true);
    hStop.triggerRestartSettled('succeeded');
    expect(hStop.getSessionAccountId()).toBe('acc2');
    expect(hStop.getClearedUsageLimit()).toBe(1);
    expect(hStop.events.some(e => e.type === 'replayed')).toBe(false);

    // 2. rotateAccount throwing (e.g. corrupt state / lock timeout) returns write_failed cleanly.
    const hThrow = makeHarness({
      rotateAccount: () => { throw new Error('state.json corrupted'); },
    });
    expect(tryAntigravityQuotaAutoRotate(hThrow.deps)).toEqual({
      outcome: 'write_failed',
      error: 'state.json corrupted',
    });

    // 3. Worker explicitly reporting `null` (pre-spawn reconcile failure) must NOT falsely adopt acc2 or replay.
    const hNullReport = makeHarness();
    expect(tryAntigravityQuotaAutoRotate(hNullReport.deps).outcome).toBe('started');
    hNullReport.setRotationState({ ...hNullReport.getRotationState()!, workerReportedAccountId: null });
    hNullReport.triggerRestartSettled('succeeded');
    expect(hNullReport.getSessionAccountId()).toBe('acc1');
    expect(hNullReport.getClearedUsageLimit()).toBe(0);
    expect(hNullReport.events.some(e => e.type === 'notify_restart_failed')).toBe(true);
    expect(hNullReport.events.some(e => e.type === 'replayed')).toBe(false);

    // 4. Continuing logical turn by matching `screenTurnId === prev.logicalTurnId` (even without lastReplayTurnId).
    const excluded: string[][] = [];
    const hCont = makeHarness({
      rotateAccount: params => {
        excluded.push([...(params.excludeAccountIds ?? [])]);
        return { outcome: 'rotated', fromId: params.failedAccountId, toId: 'acc3' };
      },
    });
    hCont.setRotationState({
      logicalTurnId: 'turn-1',
      attemptedAccountIds: ['acc1', 'acc2'],
      rotationsUsed: 1,
    });
    expect(tryAntigravityQuotaAutoRotate({
      ...hCont.deps,
      sessionAccountId: 'acc2',
      screenTurnId: 'turn-1',
      lastCliInputTurnId: 'different-id',
    }).outcome).toBe('started');
    expect(excluded[0]).toEqual(expect.arrayContaining(['acc1', 'acc2']));

    // 5. clearInFlightAntigravityRotation preserves per-turn counters while clearing in-flight fields.
    const cleared = clearInFlightAntigravityRotation({
      logicalTurnId: 't1',
      attemptedAccountIds: ['acc1', 'acc2'],
      rotationsUsed: 2,
      inFlightToken: 'tok-x',
      pendingAccountId: 'acc2',
      replayCancelledByUser: true,
      lastReplayTurnId: 'r-2',
    });
    expect(cleared).toEqual({
      logicalTurnId: 't1',
      attemptedAccountIds: ['acc1', 'acc2'],
      rotationsUsed: 2,
      lastReplayTurnId: 'r-2',
    });

    // 6. RestartCoordinator.activeAttemptId detects persisted non-planned attempts (prevents joined rotation).
    const coord = new RestartCoordinator({
      persistence: {
        restore: () => ({ id: 'persisted-attempt-1', uncertain: false }),
        record: () => 'joined',
      },
    });
    expect(coord.activeAttemptId('sid-persisted')).toBe('persisted-attempt-1');
  });
});
