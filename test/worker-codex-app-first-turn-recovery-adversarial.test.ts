import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { CodexAppTurnDispatchQueue } from '../src/utils/codex-app-turn-dispatch.js';

// Mutation runs replace only worker.ts in a scratch directory. Imports retain
// the real queue/authority components; the existing AST harness reads cwd.
if (process.env.BOTMUX_ATTESTATION_MUTATION_ROOT) process.chdir(process.env.BOTMUX_ATTESTATION_MUTATION_ROOT);

function fixture() {
  const entry = { state: 'prepared', dispatchId: 'dispatch-original', turnId: 'om_original', dispatchAttempt: 3,
    codexAppSteerable: true as const, replyTargetSenderOpenId: 'ou_original', replyTargetSenderIsBot: false };
  const queue = new CodexAppTurnDispatchQueue(); queue.restore([entry]);
  const authority = new ActiveTurnAuthority();
  const scope: Record<string, any> = {
    currentBotmuxTurnId: undefined, currentBotmuxDispatchAttempt: undefined,
    codexAppRunnerProcessIdentity: { enginePid: 70, engineProcStart: '700' },
    codexAppCompletionAwaitingFinal: false, codexAppControlProven: true,
    codexAppControlStateValue: { status: 'active', identities: [{ generation: 'g1' }] },
    codexAppGenerationCommits: [], codexAppRecoveredDispatches: [entry], codexAppTurnDispatchQueue: queue,
    lastInitConfig: { cliId: 'codex-app', larkAppId: 'cli_original' }, activeTurnAuthority: authority,
    markerIdentityTurnId: (id: string) => id,
    setCaptureIdentity: (turnId: string, attempt: number, caller: string) => {
      scope.currentBotmuxTurnId = turnId; scope.currentBotmuxDispatchAttempt = attempt; scope.turnCallerOpenId = caller;
    },
    publishSandboxRelayCapability: vi.fn(() => true), log: vi.fn(),
    isCodexAppCliId: (id: string) => id === 'codex-app', pendingMessages: [],
  };
  scope.adoptInitialActiveTurn = loadWorkerFunction('adoptInitialActiveTurn', scope);
  const restore = loadWorkerFunction<(turn: unknown, control?: any) => void>('restoreCodexAppAttestedTurn', scope);
  const retire = loadWorkerFunction<(turn: string, attempt: number) => Promise<boolean>>('retireCodexAppDispatchForDurableReplay', scope);
  return { entry, queue, authority, scope, restore, retire };
}
afterEach(() => vi.useRealTimers());

describe('warm first-turn attestation adversarial lifecycle probes', () => {
  it.each([1, 250])('restores a first uncommitted turn at seq %i exactly once into real authority', seq => {
    const { scope, restore, authority } = fixture();
    restore('om_original', { generation: 'g1', seq });
    restore('om_original', { generation: 'g1', seq });
    expect(authority.snapshot()).toMatchObject({ turnId: 'om_original', dispatchAttempt: 3, started: true,
      caller: { requestLarkAppId: 'cli_original', requestUserOpenId: 'ou_original', senderType: 'user' } });
    expect(scope.publishSandboxRelayCapability).toHaveBeenCalledTimes(1);
  });
  it.each(['proof', 'missing-state', 'pending-state', 'empty-identities', 'multiple-identities', 'generation',
    'zero', 'negative', 'fractional', 'nan', 'infinite', 'unsafe-integer', 'committed-equal', 'committed-older'])(
    'does not revive authority through %s', reason => {
      const { scope, restore, authority } = fixture(); let seq = 1;
      if (reason === 'proof') scope.codexAppControlProven = false;
      if (reason === 'missing-state') scope.codexAppControlStateValue = undefined;
      if (reason === 'pending-state') scope.codexAppControlStateValue.status = 'pending';
      if (reason === 'empty-identities') scope.codexAppControlStateValue.identities = [];
      if (reason === 'multiple-identities') scope.codexAppControlStateValue.identities.push({ generation: 'g2' });
      if (reason === 'generation') scope.codexAppControlStateValue.identities[0].generation = 'g2';
      if (reason === 'zero') seq = 0;
      if (reason === 'negative') seq = -1;
      if (reason === 'fractional') seq = 1.5;
      if (reason === 'nan') seq = NaN;
      if (reason === 'infinite') seq = Infinity;
      if (reason === 'unsafe-integer') seq = Number.MAX_SAFE_INTEGER + 1;
      if (reason === 'committed-equal') scope.codexAppGenerationCommits = [{ generation: 'g1', committedThrough: 1 }];
      if (reason === 'committed-older') scope.codexAppGenerationCommits = [{ generation: 'g1', committedThrough: 2 }];
      restore('om_original', { generation: 'g1', seq });
      expect(authority.snapshot()).toBeUndefined(); expect(scope.publishSandboxRelayCapability).not.toHaveBeenCalled();
    });
  it('uses the live generation zero boundary instead of a different generation high-water', () => {
    const { scope, restore, authority } = fixture();
    scope.codexAppControlStateValue.identities[0].generation = 'g2';
    scope.codexAppGenerationCommits = [{ generation: 'g1', committedThrough: 250 }];
    restore('om_original', { generation: 'g1', seq: 251 });
    expect(authority.snapshot()).toBeUndefined();
    restore('om_original', { generation: 'g2', seq: 1 });
    expect(authority.snapshot()?.turnId).toBe('om_original');
    expect(scope.publishSandboxRelayCapability).toHaveBeenCalledTimes(1);
  });
  it.each(['generation-change', 'reauth-pending', 'completed-awaiting-final', 'human-takeover', 'high-water-commit'])(
    'rechecks %s when queued recovery returns after a delay', async change => {
      vi.useFakeTimers(); const { scope, restore, authority } = fixture();
      setTimeout(() => {
        if (change === 'generation-change') scope.codexAppControlStateValue.identities[0].generation = 'g2';
        if (change === 'reauth-pending') scope.codexAppControlProven = false;
        if (change === 'completed-awaiting-final') scope.codexAppCompletionAwaitingFinal = true;
        if (change === 'high-water-commit') scope.codexAppGenerationCommits = [{ generation: 'g1', committedThrough: 12 }];
        if (change === 'human-takeover') scope.adoptInitialActiveTurn({ turnId: 'om_new', trustedCaller: {
          requestLarkAppId: 'cli_original', requestUserOpenId: 'ou_new', senderType: 'user',
        } });
      }, 10);
      setTimeout(() => restore('om_original', { generation: 'g1', seq: 12 }), 20);
      await vi.advanceTimersByTimeAsync(20);
      expect(scope.publishSandboxRelayCapability).not.toHaveBeenCalled();
      if (change === 'human-takeover') expect(authority.snapshot()?.caller?.requestUserOpenId).toBe('ou_new');
      else expect(authority.snapshot()).toBeUndefined();
    });
  it.each([true, false])('handles durable cancellation ACK=%s before the late recovery marker', async acknowledged => {
    vi.useFakeTimers(); const { scope, restore, retire, authority, queue } = fixture();
    scope.requestCodexAppDispatchTransition = vi.fn(() => new Promise(resolve => setTimeout(() => resolve(acknowledged), 10)));
    const cancel = retire('om_original', 3);
    expect(queue.recoveredPrefix()).toHaveLength(1);
    setTimeout(() => restore('om_original', { generation: 'g1', seq: 12 }), 20);
    await vi.advanceTimersByTimeAsync(20);
    expect(await cancel).toBe(acknowledged);
    expect(scope.requestCodexAppDispatchTransition).toHaveBeenCalledWith('cancel', [{
      dispatchId: 'dispatch-original', turnId: 'om_original', dispatchAttempt: 3,
    }]);
    if (acknowledged) {
      expect(queue.recoveredPrefix()).toHaveLength(0); expect(scope.codexAppRecoveredDispatches).toHaveLength(0);
      expect(authority.snapshot()).toBeUndefined(); expect(scope.publishSandboxRelayCapability).not.toHaveBeenCalled();
    } else {
      expect(queue.recoveredPrefix()).toHaveLength(1); expect(authority.snapshot()?.turnId).toBe('om_original');
      expect(scope.publishSandboxRelayCapability).toHaveBeenCalledTimes(1);
    }
  });
  it('cannot restore after only one half of a prepared reservation remains', () => {
    for (const missing of ['ledger', 'reservation']) {
      const { scope, restore, authority, queue } = fixture();
      if (missing === 'ledger') scope.codexAppRecoveredDispatches = [];
      else queue.cancelExact(queue.recoveredPrefix()[0].handle);
      restore('om_original', { generation: 'g1', seq: 1 });
      expect(authority.snapshot()).toBeUndefined(); expect(scope.publishSandboxRelayCapability).not.toHaveBeenCalled();
    }
  });
});
