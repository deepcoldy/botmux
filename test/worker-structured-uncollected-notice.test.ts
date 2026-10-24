/**
 * Executes the worker's real pruneExpiredStructuredHeadsAndEmit and
 * notifyUncollectedStructuredTurns (see helpers/worker-function-harness.ts):
 * which expired pre-start heads get the "reply cannot be collected" notice in
 * the thread, and which are already covered by something else.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CodexPendingTurn } from '../src/services/codex-bridge-queue.js';
import { uncollectedTurnsNeedingNotice } from '../src/services/structured-uncollected-notice.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

function harness(dropped: CodexPendingTurn[]) {
  const scope: Record<string, any> = {
    codexBridgeQueue: {},
    emitReadyCodexTurns: vi.fn(),
    pruneExpiredPreStartHeadsAndEmit: (_queue: unknown, _emit: unknown, _now: unknown,
      onDropped: (turns: CodexPendingTurn[]) => void) => {
      onDropped(dropped);
      return dropped;
    },
    rpcTurnOwnerKey: (id: { turnId: string; dispatchAttempt?: number }) => `${id.turnId}|${id.dispatchAttempt ?? '-'}`,
    rpcLifecycleFailClosedOwners: new Map(),
    clearRpcLifecycleFailClosedOwner: vi.fn(),
    clearAwaitingRpcActivation: vi.fn(),
    sameRpcGeneration: vi.fn(),
    deferredFreshRpcTurn: undefined,
    codexRpcEngine: undefined,
    cliSpawnGeneration: 3,
    cliRestartInProgress: false,
    emitTurnTerminal: vi.fn(),
    restartCliProcess: vi.fn(),
    redriveRejectedStructuredReady: vi.fn(),
    log: vi.fn(),
    send: vi.fn(),
    t: (key: string, vars: { cliName: string }) => `${key}|${vars.cliName}`,
    cliName: () => 'Pi',
    uncollectedTurnsNeedingNotice,
    // The write of this turn threw; its own submit-failure notice is out.
    structuredTurnsWithSubmitNotice: new Set(['om_write_failed']),
    // A deferred submit recheck is still deciding this one.
    submitFailureChains: {
      has: (key: { turnId?: string; cliGeneration: number }) => key.turnId === 'om_rechecking' && key.cliGeneration === 3,
    },
  };
  scope.notifyUncollectedStructuredTurns = loadWorkerFunction('notifyUncollectedStructuredTurns', scope);
  const prune = loadWorkerFunction<(source: string) => boolean>('pruneExpiredStructuredHeadsAndEmit', scope);
  return { scope, prune };
}

describe('worker: expired structured heads', () => {
  it('tells the thread about an ordinary Lark turn only', () => {
    const { scope, prune } = harness([
      { turnId: 'om_ordinary', started: false },
      { turnId: 'om_durable', dispatchAttempt: 1, started: false },
      { turnId: 'codex-local-1', isLocal: true, started: false },
      { turnId: 'om_write_failed', started: false },
      { turnId: 'om_rechecking', started: false },
    ]);

    expect(prune('structured bridge tick')).toBe(true);

    const notices = scope.send.mock.calls.map(([msg]: [any]) => msg);
    expect(notices).toEqual([{
      type: 'user_notify',
      message: 'worker.structured_turn_not_collected|Pi',
      turnId: 'om_ordinary',
    }]);
    // The durable attempt is settled by its own terminal instead.
    expect(scope.emitTurnTerminal.mock.calls).toEqual([
      ['om_durable', 'ambiguous', 'structured_start_timeout', 1],
    ]);
    // A consumed write-failure entry does not suppress a later, fresh mark.
    expect(scope.structuredTurnsWithSubmitNotice.has('om_write_failed')).toBe(false);
  });

  it('stays quiet when nothing expired', () => {
    const { scope, prune } = harness([]);
    expect(prune('structured bridge tick')).toBe(false);
    expect(scope.send).not.toHaveBeenCalled();
  });
});
