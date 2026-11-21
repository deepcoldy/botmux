/**
 * Executes the worker's real pruneExpiredStructuredHeadsAndEmit and
 * notifyUncollectedStructuredTurns (see helpers/worker-function-harness.ts):
 * which expired pre-start heads get the "reply cannot be collected" notice in
 * the thread, and which are already covered by something else.
 */
import { describe, expect, it, vi } from 'vitest';
import { CodexBridgeQueue, type CodexPendingTurn } from '../src/services/codex-bridge-queue.js';
import { uncollectedTurnsNeedingNotice } from '../src/services/structured-uncollected-notice.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { InputDeliveryEvidenceTracker } from '../src/services/input-delivery-evidence.js';

/** CLI readiness as the worker tracks it. Default: the CLI did come up. */
interface Readiness {
  lastInitConfig?: { adoptMode: boolean; cliUpgrade?: { from: string; to: string } };
  isPromptReady?: boolean;
  promptReadyEdges?: number;
  promptReadyEdgesAtFreshCliStart?: number;
  structuredRejectedReadyEvidenceGeneration?: number;
  startupBlocker?: unknown;
}

function harness(
  dropped: CodexPendingTurn[],
  readiness: Readiness = { isPromptReady: true },
  extra: Record<string, unknown> = {},
) {
  const scope: Record<string, any> = {
    codexBridgeQueue: { refreshUnstartedHeadAttributionLease: vi.fn(), peek: () => dropped },
    // No adapter evidence that the CLI still holds submitted input.
    cliAdapter: undefined,
    cliHeldInputProbe: undefined,
    cliHeldInputReleased: new WeakSet(),
    CLI_HELD_INPUT_MAX_MS: 'held-input-cap',
    CLI_HELD_INPUT_PROBE_INTERVAL_MS: 750,
    CLI_HELD_INPUT_SETTLE_MS: 2_000,
    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    captureBackendScreen: vi.fn(() => ''),
    bridgeSpecFor: () => undefined,
    structuredBridgeDriverState: undefined,
    isPromptReady: false,
    promptReadyEdges: 1,
    promptReadyEdgesAtFreshCliStart: -1,
    structuredRejectedReadyEvidenceGeneration: undefined,
    startupBlocker: null,
    lastInitConfig: { adoptMode: false },
    // Stand-in: that the blocker cap is used matters here, not its value.
    STARTUP_BLOCKER_HOLD_MAX_MS: 'startup-blocker-cap',
    // No CLI process had its fd table refused, no transcript bound yet.
    codexBridgeRolloutPath: undefined,
    structuredBridgeIs: (id: string) => id === 'traex',
    currentTraexObservedPid: () => 4242,
    currentCodexObservedPid: () => undefined,
    backend: { cliPid: 4241, getChildPid: () => 4240 },
    processOpenFilesDenial: vi.fn(() => undefined),
    setuidRootBwrap: vi.fn(() => undefined),
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
    retireStructuredTurnAttribution: vi.fn(),
    restartCliProcess: vi.fn(),
    redriveRejectedStructuredReady: vi.fn(),
    log: vi.fn(),
    send: vi.fn(),
    t: (key: string, vars?: Record<string, string>) => (vars
      ? [key, vars.cliName, vars.blocker, vars.to ? `${vars.from}→${vars.to}` : undefined,
        vars.pid ? `pid=${vars.pid}` : undefined, vars.code, vars.hint, vars.path].filter(Boolean).join('|')
      : key),
    cliName: () => 'Pi',
    uncollectedTurnsNeedingNotice,
    // The write of this turn threw; its own submit-failure notice is out.
    structuredTurnsWithSubmitNotice: new Set(['om_write_failed']),
    inputDeliveryEvidence: new InputDeliveryEvidenceTracker(),
    submitActivityEvidenceSince: vi.fn((_sinceMs: number, identity?: { turnId?: string }) =>
      identity?.turnId === 'om_sent_during_receipt' ? 'botmux-send' : undefined),
    // A deferred submit recheck is still deciding this one.
    submitFailureChains: {
      has: (key: { turnId?: string; cliGeneration: number }) => key.turnId === 'om_rechecking' && key.cliGeneration === 3,
    },
    ...extra,
  };
  scope.freshCliNeverReady = loadWorkerFunction('freshCliNeverReady', scope);
  scope.startupBlockerVisibleNow = loadWorkerFunction('startupBlockerVisibleNow', scope);
  scope.startupUpgradeHint = loadWorkerFunction('startupUpgradeHint', scope);
  scope.startupBlockerLabel = loadWorkerFunction('startupBlockerLabel', scope);
  scope.uncollectedTranscriptFdDenial = loadWorkerFunction('uncollectedTranscriptFdDenial', scope);
  scope.uncollectedStructuredTurnNotice = loadWorkerFunction('uncollectedStructuredTurnNotice', scope);
  scope.holdStructuredStartLeasesWhileCliStarting = loadWorkerFunction('holdStructuredStartLeasesWhileCliStarting', scope);
  scope.holdStructuredStartLeasesWhileCliHoldsInput = loadWorkerFunction('holdStructuredStartLeasesWhileCliHoldsInput', scope);
  scope.driverPendingInputTurn = loadWorkerFunction('driverPendingInputTurn', scope);
  scope.holdStructuredStartLeaseWhileDriverAwaitsInput = loadWorkerFunction('holdStructuredStartLeaseWhileDriverAwaitsInput', scope);
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
      { turnId: 'om_sent_during_receipt', started: false },
    ]);
    scope.inputDeliveryEvidence.start({ turnId: 'om_sent_during_receipt', cliGeneration: 3 }, 100);

    expect(prune('structured bridge tick')).toBe(true);

    const notices = scope.send.mock.calls.map(([msg]: [any]) => msg);
    expect(notices.filter(msg => msg.type === 'turn_display_retired').map(msg => msg.turnId)).toEqual([
      'om_write_failed', 'om_rechecking', 'om_sent_during_receipt',
    ]);
    expect(notices.filter(msg => msg.type === 'user_notify')).toEqual([{
      type: 'user_notify',
      message: 'worker.structured_turn_not_collected|Pi',
      kind: 'structured_turn_not_collected',
      turnId: 'om_ordinary',
    }]);
    // The durable attempt is settled by its own terminal instead.
    expect(scope.emitTurnTerminal.mock.calls).toEqual([
      ['om_durable', 'ambiguous', 'structured_start_timeout', 1],
    ]);
    expect(scope.retireStructuredTurnAttribution).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ turnId: 'om_ordinary' }),
    ]));
    // A consumed write-failure entry does not suppress a later, fresh mark.
    expect(scope.structuredTurnsWithSubmitNotice.has('om_write_failed')).toBe(false);
    expect(scope.submitActivityEvidenceSince).toHaveBeenCalledWith(100,
      expect.objectContaining({ turnId: 'om_sent_during_receipt' }));
  });

  it('says "not started" only behind a recognized startup blocker', () => {
    const neverReady = { isPromptReady: false, promptReadyEdges: 0, promptReadyEdgesAtFreshCliStart: 0 };
    const blocked = harness([{ turnId: 'om_ordinary', started: false }], {
      ...neverReady,
      startupBlocker: { generation: 3, blocker: { kind: 'folder_trust', rule: 'grok-folder-trust' }, visible: true },
    });
    blocked.prune('structured bridge tick');
    expect(blocked.scope.send.mock.calls.filter(([msg]: [any]) => msg.type === 'user_notify').map(([msg]: [any]) => msg.message)).toEqual([
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
    expect(firstTurn.scope.send.mock.calls.filter(([msg]: [any]) => msg.type === 'user_notify').map(([msg]: [any]) => msg.message)).toEqual([
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
    expect(later.scope.send.mock.calls.filter(([msg]: [any]) => msg.type === 'user_notify').map(([msg]: [any]) => msg.message)).toEqual(['worker.structured_turn_not_collected|Pi']);
    expect(later.scope.codexBridgeQueue.refreshUnstartedHeadAttributionLease).not.toHaveBeenCalled();
  });

  describe('while the CLI visibly holds input it already took (Doubao send queue)', () => {
    const heldScreen = '◈ Running tool… (40s • esc to interrupt)\n❯  Ask Doubao to do anything\n1 queued · second task · Ctrl+Q manage';
    const adapter = {
      screenHoldsSubmittedInput: (screen: string) => screen.includes('queued'),
      screenShowsNoPendingInput: (screen: string) => screen.includes('Ask Doubao') && !screen.includes('queued'),
    };

    it('keeps the unstarted heads\' lease alive, bounded, before anything can expire', () => {
      const held = harness([{ turnId: 'om_ordinary', started: false }], undefined, {
        cliAdapter: adapter, captureBackendScreen: vi.fn(() => heldScreen),
      });
      held.prune('structured bridge tick');
      expect(held.scope.codexBridgeQueue.refreshUnstartedHeadAttributionLease)
        .toHaveBeenCalledWith(expect.any(Number), 'held-input-cap', expect.any(Function));
      // One viewport read serves the burst of prunes an ingest produces.
      held.prune('structured ingest');
      expect(held.scope.captureBackendScreen).toHaveBeenCalledTimes(1);
      expect(held.scope.codexBridgeQueue.refreshUnstartedHeadAttributionLease).toHaveBeenCalledTimes(2);
    });

    it('stops covering a head the CLI was seen free of after its write settled', () => {
      const now = Date.now();
      const dead: CodexPendingTurn = { turnId: 'om_removed', started: false, writeSettledAtMs: now - 10_000 };
      const fresh: CodexPendingTurn = { turnId: 'om_just_written', started: false, writeSettledAtMs: now - 500 };
      // A panel covers the composer: nothing is proven either way.
      let screen = 'Queued messages · remove';
      const h = harness([dead, fresh], undefined, { cliAdapter: adapter, captureBackendScreen: vi.fn(() => screen) });
      h.prune('structured bridge tick');
      screen = heldScreen;
      h.scope.cliHeldInputProbe.atMs -= 1_000;
      h.prune('structured bridge tick');
      const before = h.scope.codexBridgeQueue.refreshUnstartedHeadAttributionLease.mock.calls[0][2] as (t: CodexPendingTurn) => boolean;
      expect(before(dead)).toBe(true);
      h.scope.codexBridgeQueue.refreshUnstartedHeadAttributionLease.mockClear();
      // Doubao idle with nothing queued: neither head is refreshed.
      screen = '❯  Ask Doubao to do anything';
      h.scope.cliHeldInputProbe.atMs -= 1_000;
      h.prune('structured bridge tick');
      expect(h.scope.codexBridgeQueue.refreshUnstartedHeadAttributionLease).not.toHaveBeenCalled();
      // A successor keeps Doubao busy: only a head written too recently to
      // have been drawn as taken is still covered.
      screen = heldScreen;
      h.scope.cliHeldInputProbe.atMs -= 1_000;
      h.prune('structured bridge tick');
      const eligible = h.scope.codexBridgeQueue.refreshUnstartedHeadAttributionLease.mock.calls[0][2] as (t: CodexPendingTurn) => boolean;
      expect(eligible(dead)).toBe(false);
      expect(eligible(fresh)).toBe(true);
    });

    it('lets the normal lease run once the evidence is gone, in adopt mode, or on a non-authoritative screen', () => {
      for (const extra of [
        { captureBackendScreen: vi.fn(() => '❯  Ask Doubao to do anything') },
        { captureBackendScreen: vi.fn(() => heldScreen), lastInitConfig: { adoptMode: true } },
        { captureBackendScreen: vi.fn(() => heldScreen), backendScreenEvidenceIsAuthoritativeForMutation: () => false },
      ]) {
        const h = harness([{ turnId: 'om_ordinary', started: false }], undefined, { cliAdapter: adapter, ...extra });
        h.prune('structured bridge tick');
        expect(h.scope.codexBridgeQueue.refreshUnstartedHeadAttributionLease).not.toHaveBeenCalled();
      }
      // Nothing unstarted: the screen is not even read.
      const idle = harness([], undefined, { cliAdapter: adapter, captureBackendScreen: vi.fn(() => heldScreen) });
      idle.prune('structured bridge tick');
      expect(idle.scope.captureBackendScreen).not.toHaveBeenCalled();
    });
  });

  it('keeps only the next pending head while the transcript driver waits at its request row', () => {
    const next: CodexPendingTurn = { turnId: 'om_next', started: false };
    const later: CodexPendingTurn = { turnId: 'om_later', started: false };
    const spec = { awaitsPendingInput: (state: unknown) => (state as { parked?: boolean })?.parked === true };
    const waiting = harness([next, later], undefined, { bridgeSpecFor: () => spec, structuredBridgeDriverState: { parked: true } });
    waiting.prune('structured bridge tick');
    const [, cap, eligible] = waiting.scope.codexBridgeQueue.refreshUnstartedHeadAttributionLease.mock.calls[0];
    expect(cap).toBe('held-input-cap');
    expect([next, later].map(turn => eligible(turn))).toEqual([true, false]);
    for (const extra of [
      { bridgeSpecFor: () => spec, structuredBridgeDriverState: { parked: false } },
      { bridgeSpecFor: () => spec, structuredBridgeDriverState: { parked: true }, lastInitConfig: { adoptMode: true } },
    ]) {
      const idle = harness([next, later], undefined, extra);
      idle.prune('structured bridge tick');
      expect(idle.scope.codexBridgeQueue.refreshUnstartedHeadAttributionLease).not.toHaveBeenCalled();
    }
  });

  it('does not expire the driver-parked head when a later submit receipt arrives', () => {
    const q = new CodexBridgeQueue(() => 1_000);
    q.mark('om_A', 'A request', 1_000);
    q.mark('om_B', 'B request', 1_000);
    q.confirmPendingTurn('om_B', 1_000);
    const h = harness([], undefined, {
      codexBridgeQueue: q,
      cliAdapter: { screenHoldsSubmittedInput: () => true },
      bridgeSpecFor: () => ({ awaitsPendingInput: (state: unknown) => state === 'parked-A' }),
      structuredBridgeDriverState: 'parked-A',
      pruneExpiredStructuredHeadsAndEmit: vi.fn(),
    });
    const expire = loadWorkerFunction('expireHeldInputBeforeReceivedTurn', h.scope);
    expire('om_B');
    expect(q.hasPendingTurn('om_A')).toBe(true);
    expect(q.peek()[0]?.unconfirmedAttributionStartedAtMs).toBe(1_000);
    expect(q.hasPendingTurn('om_B')).toBe(true);
  });

  it('expires a dead predecessor rather than protecting it for a successor\'s parked row', () => {
    const q = new CodexBridgeQueue(() => 1_000);
    q.mark('om_deleted_A', 'A request', 1_000);
    q.mark('om_B', 'B request', 1_000);
    q.confirmPendingTurn('om_B', 1_000);
    const h = harness([], undefined, {
      codexBridgeQueue: q,
      cliAdapter: { screenHoldsSubmittedInput: () => true },
      bridgeSpecFor: () => ({
        awaitsPendingInput: (state: unknown) => state === 'parked-B',
        pendingInputOwner: (state: unknown) => state === 'parked-B' ? { turnId: 'om_B' } : undefined,
      }),
      structuredBridgeDriverState: 'parked-B',
      pruneExpiredStructuredHeadsAndEmit: vi.fn(),
    });
    const expire = loadWorkerFunction('expireHeldInputBeforeReceivedTurn', h.scope);
    expire('om_B');
    expect(q.peek()[0]).toMatchObject({ turnId: 'om_deleted_A', unconfirmedAttributionStartedAtMs: Number.NEGATIVE_INFINITY });
    expect(q.peek()[1]).toMatchObject({ turnId: 'om_B', submitConfirmedAtMs: 1_000 });
  });

  describe('when procfs refused the CLI process its open files', () => {
    const refusedFor = (pid: number) => vi.fn((asked: number) => (asked === pid
      ? { code: 'EACCES', stage: 'readlink', atMs: 1 }
      : undefined));
    const notices = (scope: Record<string, any>) => scope.send.mock.calls
      .filter(([msg]: [any]) => msg.type === 'user_notify').map(([msg]: [any]) => msg.message);

    it('says permission was denied, naming the process and a setuid bwrap behind it', () => {
      const { scope, prune } = harness([{ turnId: 'om_ordinary', started: false }], {
        isPromptReady: true,
        processOpenFilesDenial: refusedFor(4242),
        setuidRootBwrap: () => '/usr/bin/bwrap',
      } as Readiness);
      prune('structured bridge tick');
      expect(notices(scope)).toEqual([
        'worker.structured_turn_not_collected_fd_denied|Pi|pid=4242|EACCES|worker.fd_denied_setuid_bwrap_hint|/usr/bin/bwrap',
      ]);
    });

    it('still says permission denied without a setuid bwrap, just without that cause', () => {
      const { scope, prune } = harness([{ turnId: 'om_ordinary', started: false }], {
        isPromptReady: true,
        processOpenFilesDenial: refusedFor(4241),
      } as Readiness);
      prune('structured bridge tick');
      expect(notices(scope)).toEqual(['worker.structured_turn_not_collected_fd_denied|Pi|pid=4241|EACCES']);
    });

    it('keeps the transcript wording once a transcript was located anyway', () => {
      const { scope, prune } = harness([{ turnId: 'om_ordinary', started: false }], {
        isPromptReady: true,
        processOpenFilesDenial: refusedFor(4242),
        setuidRootBwrap: () => '/usr/bin/bwrap',
        codexBridgeRolloutPath: '/home/u/.trae/cli/sessions/2026/11/20/rollout-x.jsonl',
      } as Readiness);
      prune('structured bridge tick');
      expect(notices(scope)).toEqual(['worker.structured_turn_not_collected|Pi']);
    });
  });

  it('stays quiet when nothing expired', () => {
    const { scope, prune } = harness([]);
    expect(prune('structured bridge tick')).toBe(false);
    expect(scope.send).not.toHaveBeenCalled();
  });
});
