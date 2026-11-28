import { describe, expect, it, vi } from 'vitest';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { inputForcesSerialTurn, mergeQueuedCliInput, resetPreservingPendingCliInputs } from '../src/utils/pending-input-queue.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { AsyncSerialQueue } from '../src/utils/async-serial-queue.js';
import { runAdoptQueuedWriteSequence } from '../src/services/adopt-input-sequence.js';

const caller = { requestUserOpenId: 'ou_human', requestLarkAppId: 'app', senderType: 'user' as const };

function authority(turnId = 'trg_model_retry') {
  const active = new ActiveTurnAuthority();
  active.reserve({ turnId, caller });
  active.markStarted({ turnId, caller });
  return active;
}

describe('real inbound turns behind a trigger', () => {
  it.each(['stale-generation', 'write-failure'])('releases hidden trigger admission after %s', async failure => {
    const scope: Record<string, any> = {
      activeTurnAuthority: new ActiveTurnAuthority(), inputForcesSerialTurn,
      adoptWriteQueue: new AsyncSerialQueue(), runAdoptQueuedWriteSequence,
      pendingAdoptTriggerInputs: new Set(),
      captureAdoptWriteFence: () => ({ generation: 1, backend: {} }),
      adoptWriteFenceIsCurrent: () => failure !== 'stale-generation',
      writeAdoptMessage: vi.fn(async () => { throw new Error('fixture write failure'); }),
    };
    scope.turnAuthorityIdentity = loadWorkerFunction('turnAuthorityIdentity', scope);
    const run = loadWorkerFunction<(item: any, requeue: () => void) => Promise<string>>('runAdoptMessageForCapturedGeneration', scope);
    const requeue = vi.fn();
    const promise = run({ turnId: 'trg_old', content: 'continue' }, requeue);
    if (failure === 'stale-generation') {
      await expect(promise).resolves.toBe('stale-before-write');
      expect(requeue).toHaveBeenCalledOnce();
      expect(scope.writeAdoptMessage).not.toHaveBeenCalled();
    } else await expect(promise).rejects.toThrow('fixture write failure');
    expect(scope.pendingAdoptTriggerInputs.size).toBe(0);
  });

  it.each([1, 2])('keeps %s earlier mutex-waiting inputs ahead of a later visible-queue input', async earlyCount => {
    vi.useFakeTimers();
    try {
      const activeTurnAuthority = new ActiveTurnAuthority();
      const adoptWriteQueue = new AsyncSerialQueue();
      const blocker = adoptWriteQueue.run(() => new Promise<void>(resolve => setTimeout(resolve, 200)));
      const scope: Record<string, any> = {
        activeTurnAuthority, inputForcesSerialTurn, adoptWriteQueue, runAdoptQueuedWriteSequence,
        pendingAdoptMessages: [], pendingAdoptTriggerInputs: new Set(), backend: {},
        crossPrincipalIsolationOn: () => false,
        recoverSessionRenameAfterPersistentReattach: () => false, sessionRenameInFlight: () => false,
        sessionInputBlocksDeliveryNow: () => false, flushPending: vi.fn(), log: vi.fn(),
        captureAdoptWriteFence: () => ({ generation: 1, backend: {} }), adoptWriteFenceIsCurrent: () => true,
        writeAdoptMessage: async (_text: string, turnId: string) => {
          if (turnId === 'trg_queued') {
            activeTurnAuthority.reserve({ turnId, caller });
            activeTurnAuthority.markStarted({ turnId, caller });
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          return 'completed';
        },
      };
      scope.turnAuthorityIdentity = loadWorkerFunction('turnAuthorityIdentity', scope);
      scope.activeTurnBlocks = loadWorkerFunction('activeTurnBlocks', scope);
      scope.runAdoptMessageForCapturedGeneration = loadWorkerFunction('runAdoptMessageForCapturedGeneration', scope);
      const admit = loadWorkerFunction<(item: any) => Promise<void>>('admitAdoptMessage', scope);
      const item = (turnId: string) => ({ turnId, content: turnId, trustedCaller: caller });
      const trigger = admit(item('trg_queued'));
      const earlyIds = Array.from({ length: earlyCount }, (_, index) => `om_early_${index}`);
      const early = earlyIds.map(turnId => admit(item(turnId)));
      await vi.advanceTimersByTimeAsync(200);
      await admit(item('om_second'));
      await vi.advanceTimersByTimeAsync(500);
      await Promise.all([blocker, trigger, ...early]);
      expect(scope.pendingAdoptMessages.map((input: any) => input.turnId)).toEqual([...earlyIds, 'om_second']);
      expect(scope.pendingAdoptMessages.every((input: any) => input.queueAfterActiveTurn === true)).toBe(true);
      expect(scope.pendingAdoptTriggerInputs.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('rechecks trigger ownership after waiting inside the adopt write mutex', async () => {
    vi.useFakeTimers();
    try {
      const activeTurnAuthority = new ActiveTurnAuthority();
      const adoptWriteQueue = new AsyncSerialQueue();
      const blocker = adoptWriteQueue.run(() => new Promise<void>(resolve => setTimeout(resolve, 500)));
      const returned: any[] = [];
      const written: string[] = [];
      const scope: Record<string, any> = {
        activeTurnAuthority, inputForcesSerialTurn, adoptWriteQueue, runAdoptQueuedWriteSequence,
        crossPrincipalIsolationOn: () => false,
        captureAdoptWriteFence: () => ({ generation: 1, backend: {} }), adoptWriteFenceIsCurrent: () => true,
        writeAdoptMessage: async (_text: string, turnId: string) => {
          written.push(turnId);
          if (turnId === 'trg_queued') {
            activeTurnAuthority.reserve({ turnId, caller });
            activeTurnAuthority.markStarted({ turnId, caller });
          }
          return 'completed';
        },
      };
      scope.turnAuthorityIdentity = loadWorkerFunction('turnAuthorityIdentity', scope);
      scope.activeTurnBlocks = loadWorkerFunction('activeTurnBlocks', scope);
      const run = loadWorkerFunction<(item: any, requeue: () => void) => Promise<string>>('runAdoptMessageForCapturedGeneration', scope);
      const items = ['trg_queued', 'om_first', 'om_second'].map(turnId => ({ turnId, content: turnId, trustedCaller: caller }));
      const runs = items.map(item => run(item, () => returned.push(item)));
      await vi.advanceTimersByTimeAsync(500);
      await blocker;
      expect(await Promise.all(runs)).toEqual(['completed', 'stale-before-write', 'stale-before-write']);
      expect(written).toEqual(['trg_queued']);
      expect(returned).toEqual(items.slice(1).map(item => ({ ...item, queueAfterActiveTurn: true })));
      activeTurnAuthority.clear();
      for (const item of returned) await run(item, () => { throw new Error('unexpected requeue'); });
      expect(written).toEqual(['trg_queued', 'om_first', 'om_second']);
    } finally { vi.useRealTimers(); }
  });

  it.each(['trg_retry', 'trg_owner_retry', 'trg_runas_retry'])('serializes human messages behind %s without changing other input classes', activeTurnId => {
    const human = { turnId: 'om_checkpoint', trustedCaller: caller };
    expect(inputForcesSerialTurn(human, caller, activeTurnId)).toBe(true);
    expect(inputForcesSerialTurn({ ...human, trustedCaller: { ...caller, senderType: 'bot' } }, caller, activeTurnId)).toBe(false);
    expect(inputForcesSerialTurn({ turnId: human.turnId }, caller, activeTurnId)).toBe(false);
    expect(inputForcesSerialTurn({ ...human, trustedCaller: { ...caller, source: 'schedule_creator' } }, caller, activeTurnId)).toBe(false);
    expect(inputForcesSerialTurn({ ...human, turnId: 'trg_next' }, caller, activeTurnId)).toBe(false);
  });

  it.each([undefined, 'om_active', 'join_active', 'schedule:task:run', 'workflow-event:run:1', 'bmx-recovery'])('preserves type-ahead policy for %s', activeTurnId => {
    expect(inputForcesSerialTurn({ turnId: 'om_checkpoint', trustedCaller: caller }, caller, activeTurnId)).toBe(false);
  });

  it('retains each inbound message as a serial turn through a CLI restart', () => {
    const activeTurnAuthority = authority();
    const pendingMessages: any[] = [];
    const submit = loadWorkerFunction<(content: string, turnId: string, opts: any) => boolean>('sendToPty', {
      rememberTurnLinkRefMode: () => {}, inputForcesSerialTurn, activeTurnAuthority,
      traexAutoModelRuntimeEligible: () => false, pendingMessages,
      initPromptMaterialized: false, log: () => {},
    });
    submit('create the checkpoint', 'om_first', { trustedCaller: caller });
    submit('use the updated deadline', 'om_second', { trustedCaller: caller });
    resetPreservingPendingCliInputs(pendingMessages, () => { pendingMessages.length = 0; });
    expect(pendingMessages).toMatchObject([
      { turnId: 'om_first', content: 'create the checkpoint', trustedCaller: caller, queueAfterActiveTurn: true },
      { turnId: 'om_second', content: 'use the updated deadline', trustedCaller: caller, queueAfterActiveTurn: true },
    ]);
    expect(activeTurnAuthority.snapshot()?.turnId).toBe('trg_model_retry');
  });

  it.each([false, true])('does not concatenate real and trigger inputs from the same principal (reverse=%s)', reverse => {
    const trigger = { turnId: 'trg_pending', content: 'continue', trustedCaller: caller };
    const human = { turnId: 'om_checkpoint', content: 'checkpoint', trustedCaller: caller };
    const pending = [reverse ? human : trigger];
    expect(mergeQueuedCliInput(pending, reverse ? trigger : human)).toBe(false);
    expect(pending).toEqual([reverse ? human : trigger]);
    expect(trigger.content).toBe('continue');
    expect(human.content).toBe('checkpoint');
  });

  it('retains the synthetic execution boundary when its reply envelope has advanced', () => {
    const activeTurnAuthority = authority();
    activeTurnAuthority.adoptEnvelopePreservingPrincipal({ turnId: 'om_absorbed', caller });
    const pendingMessages: any[] = [];
    const submit = loadWorkerFunction<(content: string, turnId: string, opts: any) => boolean>('sendToPty', {
      rememberTurnLinkRefMode: () => {}, inputForcesSerialTurn, activeTurnAuthority,
      traexAutoModelRuntimeEligible: () => false, pendingMessages,
      initPromptMaterialized: false, log: () => {},
    });
    submit('checkpoint', 'om_checkpoint', { trustedCaller: caller });
    expect(pendingMessages[0]).toMatchObject({ turnId: 'om_checkpoint', queueAfterActiveTurn: true });
    expect(activeTurnAuthority.snapshot()).toMatchObject({ turnId: 'om_absorbed', identityTurnId: 'trg_model_retry' });
  });

  it('freezes serial admission for every real message behind a trigger queued before startup', () => {
    const pendingMessages: any[] = [{ turnId: 'trg_pending', content: 'continue', trustedCaller: caller }];
    const submit = loadWorkerFunction<(content: string, turnId: string, opts: any) => boolean>('sendToPty', {
      rememberTurnLinkRefMode: () => {}, inputForcesSerialTurn, activeTurnAuthority: authority('om_previous'),
      traexAutoModelRuntimeEligible: () => false, pendingMessages,
      initPromptMaterialized: false, log: () => {},
    });
    submit('first request', 'om_first', { trustedCaller: caller });
    submit('second request', 'om_second', { trustedCaller: caller });
    expect(pendingMessages.slice(1)).toMatchObject([
      { turnId: 'om_first', queueAfterActiveTurn: true },
      { turnId: 'om_second', queueAfterActiveTurn: true },
    ]);
  });

  it.each([false, true])('normalizes before IPC authority admission with isolation=%s', async isolation => {
    const activeTurnAuthority = authority();
    const sendToPty = vi.fn(() => true);
    const sent: any[] = [];
    const scope: Record<string, any> = {
      activeTurnAuthority, inputForcesSerialTurn,
      crossPrincipalIsolationOn: () => isolation,
      lastInitConfig: { adoptMode: false, cliId: 'traex' },
      restoredDeploymentTurnId: undefined, backend: {}, crashDiagnosticStopped: false,
      discardDeploymentContinuation: vi.fn(), applyWorkerLaunchModel: vi.fn(),
      applyRespawnConfigPatch: vi.fn(), respawnConfigPatchFromMessage: vi.fn(() => ({})),
      finalHandoffAdmissionEnabled: false, isOrdinaryImTurnId: () => false,
      tmuxScrolledHalfPages: 0, sendToPty,
      deferTurnInputCommitUntilSubmission: () => false, acknowledgeTurnInputCommitted: vi.fn(),
      send: (msg: any) => sent.push(msg), log: vi.fn(),
    };
    scope.turnAuthorityIdentity = loadWorkerFunction('turnAuthorityIdentity', scope);
    scope.activeTurnBlocks = loadWorkerFunction('activeTurnBlocks', scope);
    await loadWorkerFunction<(raw: unknown) => Promise<void>>('handleContractDaemonMessage', scope)({
      type: 'message', turnId: 'om_checkpoint', content: 'checkpoint', trustedCaller: caller,
    });
    expect(sent.filter(msg => msg.type === 'turn_input_rejected')).toEqual([]);
    expect(sendToPty).toHaveBeenCalledOnce();
    expect(sendToPty.mock.calls[0]?.[2]).toMatchObject({ queueAfterActiveTurn: true, trustedCaller: caller });
    expect(activeTurnAuthority.snapshot()?.turnId).toBe('trg_model_retry');
  });

  it('holds an adopted pane message instead of writing into the synthetic turn', async () => {
    const item = { turnId: 'om_checkpoint', content: 'checkpoint', trustedCaller: caller };
    const scope: Record<string, any> = {
      activeTurnAuthority: authority(), inputForcesSerialTurn,
      backend: {}, pendingAdoptMessages: [],
      recoverSessionRenameAfterPersistentReattach: () => false, sessionRenameInFlight: () => false,
      sessionInputBlocksDeliveryNow: () => false,
      runAdoptMessageForCapturedGeneration: vi.fn(), flushPending: vi.fn(), log: vi.fn(),
    };
    await loadWorkerFunction<(item: unknown) => Promise<void>>('admitAdoptMessage', scope)(item);
    expect(scope.runAdoptMessageForCapturedGeneration).not.toHaveBeenCalled();
    expect(scope.pendingAdoptMessages).toEqual([{ ...item, queueAfterActiveTurn: true }]);
  });
});
