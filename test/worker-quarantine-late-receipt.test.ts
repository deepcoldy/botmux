import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { createQueuedActivationReceiptObserver } from '../src/services/queued-activation-receipts.js';
import type { SubmitRecheckResult } from '../src/adapters/cli/types.js';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers(); });

function harness() {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const h = workerSubmitHarness();
  const { scope } = h;
  const recheck = vi.fn<() => Promise<SubmitRecheckResult>>(async () => false);
  Object.assign(scope, {
    inputDeliveryQuarantine: null,
    lastInitConfig: { cliId: 'traex', cliSessionId: 'owned-session' },
    deferTurnInputCommitUntilSubmission: () => false,
    maybeQueuePostSubmitNativeSessionTitle: () => false,
    createQueuedActivationReceiptObserver,
    structuredTurnsWithSubmitNotice: new Set(),
    bridgeQueue: { dropPendingTurn: () => null },
    emitReadyCodexTurns: vi.fn(),
    submitActivityEvidenceSince: () => undefined,
    effectiveBackendType: 'pty', lastPtyActivityAtMs: 0,
    captureBackendScreen: () => '❯ [Pasted text #1]',
    diagnoseBackendSubmitFailure: () => ({ reason: 'draft_parked', evidence: 'screen' }),
    shouldWaitThroughBusyTurn: () => false,
    armPostTerminalInputFence: vi.fn(),
    idleDetector: { isStartupPending: () => false, programStatusHeldWorking: () => false, fireIdle: vi.fn() },
  });
  scope.cliAdapter.quarantineUnconfirmedSubmits = true;
  scope.cliAdapter.writeInput = vi.fn(async () => ({ submitted: false, recheck }));
  for (const name of ['currentInputDeliveryQuarantine', 'armInputDeliveryQuarantine',
    'releaseInputDeliveryQuarantine', 'releaseInputDeliveryQuarantineForStructuredTerminal', 'dropFailedBridgeMark']) {
    scope[name] = loadWorkerFunction(name, scope);
  }
  scope.flushPending = h.flush;
  cleanups.push(() => { h.submitFailureChains.clear(); scope.inputDeliveryQuarantine?.cancelReceipt?.(); });
  return { ...h, recheck };
}

async function warnAndDrop(h: ReturnType<typeof harness>) {
  await h.flush();
  expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
  expect(h.scope.inputDeliveryQuarantine).not.toBeNull();
  expect(h.scope.inputDeliveryQuarantine.draftContent).toBe('payload');
  await vi.advanceTimersByTimeAsync(40_000);
  expect(h.queue.hasPendingTurn('delivery', 1)).toBe(false);
  expect(h.scope.emitTurnTerminal).toHaveBeenCalledWith('delivery', 'failed', 'submit_unconfirmed', 1);
  expect(h.submitFailureChains.size()).toBe(0);
  h.scope.pendingMessages.push({ turnId: 'successor', dispatchAttempt: 2, content: 'next input' });
  await h.flush();
  expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
}

describe('quarantine receipt outlives bounded warning and bridge attribution', () => {
  it('keeps the parked draft and exact bridge quarantine alongside its late receipt observer', async () => {
    const h = harness();
    h.queue.mark('parked', 'original draft', 0);
    const quarantine = h.scope.armInputDeliveryQuarantine(
      h.scope.backend, { turnId: 'parked' }, 'original draft', h.recheck,
    );
    expect(quarantine.draftContent).toBe('original draft');
    expect(quarantine.cancelReceipt).toBeTypeOf('function');
    expect(h.queue.peek()[0]?.inputDeliveryQuarantined).toBe(true);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    h.scope.releaseInputDeliveryQuarantine(quarantine, 'exact submit proof');
    expect(h.queue.peek()[0]?.inputDeliveryQuarantined).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.recheck).not.toHaveBeenCalled();
  });

  it('also recovers when attribution expiry wins the race against the warning callback', async () => {
    const h = harness();
    await h.flush();
    vi.setSystemTime(31_000);
    expect(h.queue.pruneExpiredPreStartHeads().map(turn => turn.turnId)).toEqual(['delivery']);
    h.scope.pendingMessages.push({ turnId: 'successor', dispatchAttempt: 2, content: 'next input' });
    h.recheck.mockResolvedValue({ submitted: true, ownershipProven: true, cliSessionId: 'owned-session' });
    h.scope.cliAdapter.writeInput.mockResolvedValue({ submitted: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).toBeNull();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(2);
    expect(h.scope.cliAdapter.writeInput.mock.calls[1][1]).toBe('next input');
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
  });

  it('recovers an owned late receipt after the mark was dropped, without replaying the original input', async () => {
    const h = harness();
    await warnAndDrop(h);
    h.recheck.mockResolvedValue({ submitted: true, ownershipProven: true, cliSessionId: 'owned-session' });
    h.scope.cliAdapter.writeInput.mockResolvedValue({ submitted: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).toBeNull();
    expect(h.scope.armPostTerminalInputFence).toHaveBeenCalledTimes(1);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(2);
    expect(h.scope.cliAdapter.writeInput.mock.calls[1][1]).toBe('next input');
    expect(h.queue.hasPendingTurn('delivery', 1)).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(2);
    expect(h.scope.emitTurnTerminal).toHaveBeenCalledTimes(1);
  });

  it('ignores same-text unowned receipts, unrelated terminals and screen-idle without recovery evidence', async () => {
    const h = harness(); await warnAndDrop(h);
    const original = h.scope.inputDeliveryQuarantine;
    h.recheck.mockResolvedValue({ submitted: true, cliSessionId: 'foreign-session' });
    h.scope.releaseInputDeliveryQuarantineForStructuredTerminal('unrelated', 1);
    h.scope.releaseInputDeliveryQuarantineForStructuredTerminal('delivery', 2);
    await vi.advanceTimersByTimeAsync(80_000);
    expect(h.scope.inputDeliveryQuarantine).toBe(original);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    // Even a process-owned record cannot switch the quarantined native thread.
    h.recheck.mockResolvedValue({ submitted: true, ownershipProven: true, cliSessionId: 'different-owned-session' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).toBe(original);
    h.recheck.mockResolvedValue({ submitted: true, ownershipProven: true, cliSessionId: 'owned-session' });
    h.scope.cliAdapter.writeInput.mockResolvedValue({ submitted: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).toBeNull();
  });

  it('with no known native session id, only a positively owned receipt can release the quarantine', async () => {
    const h = harness();
    // Fresh session: the native session id is learned only after the first
    // owned receipt, so at arm time there is no expected id to bind against.
    h.scope.lastInitConfig = { cliId: 'traex' };
    await warnAndDrop(h);
    const original = h.scope.inputDeliveryQuarantine;
    // A sibling's same-text history line: the traex recheck can prove submit
    // but not ownership, and returns no session id. With no expected id to
    // match, ownershipProven is the ONLY guard against a false release.
    h.recheck.mockResolvedValue({ submitted: true });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.scope.inputDeliveryQuarantine).toBe(original);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    // An unowned candidate id is equally insufficient without an expected id.
    h.recheck.mockResolvedValue({ submitted: true, cliSessionId: 'sibling-session' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).toBe(original);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    // The first positively owned receipt (freshly learned id) unlocks the queue.
    h.recheck.mockResolvedValue({ submitted: true, ownershipProven: true, cliSessionId: 'freshly-learned-sid' });
    h.scope.cliAdapter.writeInput.mockResolvedValue({ submitted: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).toBeNull();
    expect(h.scope.armPostTerminalInputFence).toHaveBeenCalledTimes(1);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(2);
    expect(h.scope.cliAdapter.writeInput.mock.calls[1][1]).toBe('next input');
  });

  it('with no known native session id, an owned receipt without a session id cannot release', async () => {
    const h = harness();
    h.scope.lastInitConfig = { cliId: 'traex' };
    await warnAndDrop(h);
    const original = h.scope.inputDeliveryQuarantine;
    h.recheck.mockResolvedValue({ submitted: true, ownershipProven: true });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.scope.inputDeliveryQuarantine).toBe(original);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
  });

  it('binds to a native session id learned while quarantined', async () => {
    const h = harness();
    h.scope.lastInitConfig = { cliId: 'traex' };
    await warnAndDrop(h);
    const original = h.scope.inputDeliveryQuarantine;
    // The binding can be learned after arm (e.g. rollout attach); from then on
    // a receipt owned by a different native session must not release the queue.
    h.scope.lastInitConfig.cliSessionId = 'learned-session';
    h.recheck.mockResolvedValue({ submitted: true, ownershipProven: true, cliSessionId: 'other-owned-session' });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.scope.inputDeliveryQuarantine).toBe(original);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    h.recheck.mockResolvedValue({ submitted: true, ownershipProven: true, cliSessionId: 'learned-session' });
    h.scope.cliAdapter.writeInput.mockResolvedValue({ submitted: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.scope.inputDeliveryQuarantine).toBeNull();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(2);
    expect(h.scope.cliAdapter.writeInput.mock.calls[1][1]).toBe('next input');
  });

  it.each(['backend', 'generation', 'restart', 'replacement', 'native-session'] as const)(
    'rejects an otherwise-valid owned receipt after %s change', async change => {
      const h = harness(); await warnAndDrop(h);
      let resolve!: (result: SubmitRecheckResult) => void;
      h.recheck.mockImplementation(() => new Promise(done => { resolve = done; }));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(resolve).toBeTypeOf('function');
      const original = h.scope.inputDeliveryQuarantine;
      if (change === 'backend') h.scope.backend = {};
      if (change === 'generation') h.scope.cliSpawnGeneration++;
      if (change === 'restart') h.scope.cliRestartInProgress = true;
      if (change === 'replacement') h.scope.inputDeliveryQuarantine = { ...original, dispatchAttempt: 2 };
      if (change === 'native-session') h.scope.lastInitConfig.cliSessionId = 'new-session';
      const current = h.scope.inputDeliveryQuarantine;
      // A receipt that passes every recheck-LAYER filter (owned, id matches the
      // arm-time session): the isCurrent fence is the only thing that may reject.
      resolve({ submitted: true, ownershipProven: true, cliSessionId: 'owned-session' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.scope.inputDeliveryQuarantine).toBe(current);
      expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
      expect(h.scope.armPostTerminalInputFence).not.toHaveBeenCalled();
    },
  );

  it.each(['backend', 'generation', 'restart', 'replacement', 'native-session'] as const)(
    'fences an awaited receipt across %s changes', async change => {
      const h = harness(); await warnAndDrop(h);
      let resolve!: (result: SubmitRecheckResult) => void;
      h.recheck.mockImplementation(() => new Promise(done => { resolve = done; }));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(resolve).toBeTypeOf('function');
      const original = h.scope.inputDeliveryQuarantine;
      if (change === 'backend') h.scope.backend = {};
      if (change === 'generation') h.scope.cliSpawnGeneration++;
      if (change === 'restart') h.scope.cliRestartInProgress = true;
      if (change === 'replacement') h.scope.inputDeliveryQuarantine = { ...original, dispatchAttempt: 2 };
      if (change === 'native-session') h.scope.lastInitConfig.cliSessionId = 'new-session';
      const current = h.scope.inputDeliveryQuarantine;
      resolve({ submitted: true, ownershipProven: true, cliSessionId: 'old-session' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.scope.inputDeliveryQuarantine).toBe(current);
      expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
      expect(h.scope.armPostTerminalInputFence).not.toHaveBeenCalled();
      expect(h.scope.persistCliSessionId).not.toHaveBeenCalled();
    },
  );
});
