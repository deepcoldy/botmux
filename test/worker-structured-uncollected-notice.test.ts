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

/** CLI readiness as the worker tracks it. Default: the CLI did come up. */
interface Readiness {
  isPromptReady?: boolean;
  promptReadyEdges?: number;
  promptReadyEdgesAtFreshCliStart?: number;
  structuredRejectedReadyEvidenceGeneration?: number;
  startupBlocker?: unknown;
}

function harness(dropped: CodexPendingTurn[], readiness: Readiness = { isPromptReady: true }) {
  const scope: Record<string, any> = {
    codexBridgeQueue: { refreshUnstartedHeadAttributionLease: vi.fn() },
    isPromptReady: false,
    promptReadyEdges: 1,
    promptReadyEdgesAtFreshCliStart: -1,
    structuredRejectedReadyEvidenceGeneration: undefined,
    startupBlocker: null,
    lastInitConfig: { adoptMode: false },
    // Stand-in: that the blocker cap is used matters here, not its value.
    STARTUP_BLOCKER_HOLD_MAX_MS: 'startup-blocker-cap',
    ...readiness,
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
    t: (key: string, vars?: Record<string, string>) => (vars
      ? `${key}|${vars.cliName}${vars.blocker ? `|${vars.blocker}` : ''}${vars.to ? `|${vars.from}→${vars.to}` : ''}`
      : key),
    cliName: () => 'Pi',
    uncollectedTurnsNeedingNotice,
    // The write of this turn threw; its own submit-failure notice is out.
    structuredTurnsWithSubmitNotice: new Set(['om_write_failed']),
    // A deferred submit recheck is still deciding this one.
    submitFailureChains: {
      has: (key: { turnId?: string; cliGeneration: number }) => key.turnId === 'om_rechecking' && key.cliGeneration === 3,
    },
  };
  scope.freshCliNeverReady = loadWorkerFunction('freshCliNeverReady', scope);
  scope.startupBlockerVisibleNow = loadWorkerFunction('startupBlockerVisibleNow', scope);
  scope.startupUpgradeHint = loadWorkerFunction('startupUpgradeHint', scope);
  scope.startupBlockerLabel = loadWorkerFunction('startupBlockerLabel', scope);
  scope.uncollectedStructuredTurnNotice = loadWorkerFunction('uncollectedStructuredTurnNotice', scope);
  scope.holdStructuredStartLeasesWhileCliStarting = loadWorkerFunction('holdStructuredStartLeasesWhileCliStarting', scope);
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

  it('says "not started" only behind a recognized startup blocker', () => {
    const neverReady = { isPromptReady: false, promptReadyEdges: 0, promptReadyEdgesAtFreshCliStart: 0 };
    const blocked = harness([{ turnId: 'om_ordinary', started: false }], {
      ...neverReady,
      startupBlocker: { generation: 3, blocker: { kind: 'folder_trust', rule: 'grok-folder-trust' }, visible: true },
    });
    blocked.prune('structured bridge tick');
    expect(blocked.scope.send.mock.calls.map(([msg]: [any]) => msg.message)).toEqual([
      'worker.structured_turn_not_started_blocked|Pi|worker.startup_blocker_label.folder_trust',
    ]);
    // The lease was held (bounded) before anything could expire.
    expect(blocked.scope.codexBridgeQueue.refreshUnstartedHeadAttributionLease)
      .toHaveBeenCalledWith(expect.any(Number), 'startup-blocker-cap');
  });

  it('keeps the normal lease and wording without positive blocker evidence, adding a recent upgrade on a first turn', () => {
    // Pi draws its composer before consuming the argv prompt: "never ready" by
    // edge count alone is no proof the CLI is stuck.
    const firstTurn = harness([{ turnId: 'om_ordinary', started: false }], {
      isPromptReady: false, promptReadyEdges: 0, promptReadyEdgesAtFreshCliStart: 0,
      lastInitConfig: { adoptMode: false, cliUpgrade: { from: '1.0.62', to: '1.0.67' } },
    });
    firstTurn.prune('structured bridge tick');
    expect(firstTurn.scope.send.mock.calls.map(([msg]: [any]) => msg.message)).toEqual([
      'worker.structured_turn_not_collected|Piworker.startup_upgrade_hint|Pi|1.0.62→1.0.67',
    ]);
    expect(firstTurn.scope.codexBridgeQueue.refreshUnstartedHeadAttributionLease).not.toHaveBeenCalled();

    // A blocker seen earlier but answered since: the CLI showed a prompt, the
    // turn really is missing — no hold, transcript wording, no upgrade claim.
    const later = harness([{ turnId: 'om_ordinary', started: false }], {
      isPromptReady: false, promptReadyEdges: 2, promptReadyEdgesAtFreshCliStart: 0,
      startupBlocker: { generation: 3, blocker: { kind: 'folder_trust', rule: 'grok-folder-trust' }, visible: false },
      lastInitConfig: { adoptMode: false, cliUpgrade: { from: '1.0.62', to: '1.0.67' } },
    });
    later.prune('structured bridge tick');
    expect(later.scope.send.mock.calls.map(([msg]: [any]) => msg.message)).toEqual(['worker.structured_turn_not_collected|Pi']);
    expect(later.scope.codexBridgeQueue.refreshUnstartedHeadAttributionLease).not.toHaveBeenCalled();
  });

  it('stays quiet when nothing expired', () => {
    const { scope, prune } = harness([]);
    expect(prune('structured bridge tick')).toBe(false);
    expect(scope.send).not.toHaveBeenCalled();
  });
});
