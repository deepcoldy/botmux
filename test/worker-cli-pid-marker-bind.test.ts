import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
import { withFileLockSync } from '../src/utils/file-lock.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { markerBelongsToLiveProcess, readProcessStartIdentity } from '../src/core/session-marker.js';
import { isValidMarkerIdentityTurnId } from '../src/core/turn-id-shape.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';

// A successor worker that reattaches a live CLI binds the PID marker its
// predecessor left behind on a daemon restart. That marker records the turn the
// CLI is still executing; the successor must take it back AND republish its
// managed-send capability on the spot. On tmux a later launch-layer unwrap
// happens to republish too, so the real-worker lifecycle test cannot tell; a
// pane with no launch layers (e.g. macOS, a non-Claude CLI) has only this one.
describe('bindCliPidMarker: taking the executing turn back on reattach', () => {
  let dir: string;
  let markerPath: string;
  let scope: Record<string, unknown>;
  let published: Array<string | undefined>;
  const caller = {
    requestUserOpenId: 'ou_asker',
    requestUserUnionId: 'on_asker',
    requestLarkAppId: 'cli_app',
    senderType: 'user' as const,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pid-marker-bind-'));
    // Named for a pid that is alive with a known birth time: this test process.
    markerPath = join(dir, String(process.pid));
    published = [];
    scope = {
      heldPidMarkerPaths: new Set<string>(),
      existsSync, readFileSync, unlinkSync, basename,
      withFileLockSync, atomicWriteFileSync,
      readProcessStartIdentity, markerBelongsToLiveProcess, isValidMarkerIdentityTurnId,
      sessionId: 's-bind',
      cliPidMarker: null,
      rpcEnginePidMarker: null,
      currentBotmuxTurnId: undefined,
      currentBotmuxDispatchAttempt: undefined,
      currentBotmuxCallerOpenId: undefined,
      currentBotmuxLinkRefMode: undefined,
      currentTurnSteerPromoted: false,
      currentVcMeetingImTurnOrigin: undefined,
      sandboxRelayCapability: null,
      activeTurnAuthority: new ActiveTurnAuthority(),
      retiredTurnIds: new Set<string>(),
      emittedTurnTerminals: new TurnTerminalDeduper(),
      queuedTypeAheadTurns: [],
      queuedTurnAdvanceConsumedForPrompt: undefined,
      workerSessionEventScope: undefined,
      markTurnRetired: (turnId: string) => { (scope.retiredTurnIds as Set<string>).add(turnId); },
      markActiveTurnStarted: () => {},
      adoptDisplacedActiveTurn: () => { throw new Error('no turn was current before the bind'); },
      // The identity wrapper's turn file lives under SESSION_DATA_DIR; unrelated here.
      publishActiveTurn: () => {},
      log: () => {},
      setCaptureIdentity: (turnId?: string, dispatchAttempt?: number, callerOpenId?: string) => {
        scope.currentBotmuxTurnId = turnId;
        scope.currentBotmuxDispatchAttempt = dispatchAttempt;
        scope.currentBotmuxCallerOpenId = callerOpenId;
      },
      // Production shape: mint a token for the authority's turn, then rewrite the marker.
      publishSandboxRelayCapability: () => {
        const turnId = (scope.activeTurnAuthority as ActiveTurnAuthority).identity().turnId
          ?? scope.currentBotmuxTurnId as string | undefined;
        published.push(turnId);
        scope.sandboxRelayCapability = {
          token: 'c'.repeat(64),
          turnId,
          dispatchAttempt: scope.currentBotmuxDispatchAttempt,
        };
        (scope.writeCliPidMarker as () => void)();
        return true;
      },
    };
    for (const name of ['withPidMarkerLock', 'writeCliPidMarker', 'restoreQueuedTurnsFromMarkerDisk', 'adoptInitialActiveTurn', 'markerIdentityTurnId',
      'turnTerminalEmitted', 'dropQueuedTurnRecord', 'retireTerminatedMarkerTurn', 'markerQueuedTurnStillLive', 'seedInitTurnTerminals']) {
      scope[name] = loadWorkerFunction(name, scope);
    }
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const bind = (): void => loadWorkerFunction<(path: string, pid: number) => void>('bindCliPidMarker', scope)(markerPath, process.pid);
  const seedInit = (msg: Record<string, unknown>): void =>
    (scope.seedInitTurnTerminals as (raw: Record<string, unknown>) => void)(msg);
  const onDisk = (): { turnId: string | null; identityTurnId?: string; capability?: string; procStart?: string } =>
    JSON.parse(readFileSync(markerPath, 'utf8'));

  it('takes the turn back with its caller and republishes that turn\'s capability', () => {
    writeFileSync(markerPath, JSON.stringify({
      sessionId: 's-bind',
      turnId: 'om_live',
      // Isolation off: this envelope still executes as the opening turn's principal.
      identityTurnId: 'om_opening',
      callerOpenId: 'ou_asker',
      trustedCaller: caller,
      procStart: readProcessStartIdentity(process.pid),
    }));

    bind();

    expect(scope.currentBotmuxTurnId).toBe('om_live');
    expect((scope.activeTurnAuthority as ActiveTurnAuthority).identity())
      .toMatchObject({ turnId: 'om_live', identityTurnId: 'om_opening', caller });
    expect(published).toEqual(['om_live']);
    expect(onDisk()).toMatchObject({ turnId: 'om_live', identityTurnId: 'om_opening', capability: 'c'.repeat(64) });
  });

  it('discards a marker stamped with another process birth time and adopts nothing', () => {
    writeFileSync(markerPath, JSON.stringify({
      sessionId: 's-bind',
      turnId: 'om_stale',
      trustedCaller: caller,
      procStart: '1',
    }));

    bind();

    expect(scope.currentBotmuxTurnId).toBeUndefined();
    expect((scope.activeTurnAuthority as ActiveTurnAuthority).snapshot()).toBeUndefined();
    expect(published).toEqual([]);
    // Rewritten for the live process, without the planted turn.
    expect(onDisk()).toMatchObject({ turnId: null, procStart: readProcessStartIdentity(process.pid) });
  });

  it('writes a fresh marker when the CLI has none', () => {
    bind();

    expect(existsSync(markerPath)).toBe(true);
    expect(onDisk().turnId).toBeNull();
    expect(published).toEqual([]);
  });

  it('retires a marker turn already settled in ordinaryTurnRecovery on reattach', () => {
    writeFileSync(markerPath, JSON.stringify({
      sessionId: 's-bind',
      turnId: 'om_settled_pre_contract',
      dispatchAttempt: 1,
      callerOpenId: 'ou_asker',
      trustedCaller: caller,
      queuedTurns: [
        { turnId: 'om_cancelled_queued', dispatchAttempt: 1 },
        { turnId: 'om_live_queued', dispatchAttempt: 1 },
      ],
      procStart: readProcessStartIdentity(process.pid),
    }));

    seedInit({
      type: 'init',
      sessionId: 's-bind',
      sessionContract: {
        session: { appId: 'cli_app', sessionId: 's-bind' },
        worker: { workerId: 'w-2', generation: 2 },
        executions: [
          {
            ref: { executionId: 'exec-cancelled', turnId: 'om_cancelled_queued', dispatchAttempt: 1 },
            phase: 'cancelled',
          },
        ],
      },
      settledTurnTerminals: [
        { turnId: 'om_settled_pre_contract', status: 'completed' },
      ],
    });
    bind();

    expect(scope.currentBotmuxTurnId).toBeUndefined();
    expect((scope.activeTurnAuthority as ActiveTurnAuthority).snapshot()).toBeUndefined();
    expect(published).toEqual([]);
    expect((scope.retiredTurnIds as Set<string>).has('om_settled_pre_contract')).toBe(true);
    expect(scope.queuedTypeAheadTurns).toEqual([{ turnId: 'om_live_queued', dispatchAttempt: 1 }]);
    expect(onDisk()).toMatchObject({ turnId: null, procStart: readProcessStartIdentity(process.pid) });
  });

  it('never retires a marker turn when sessionContract still holds an unsettled execution for it', () => {
    writeFileSync(markerPath, JSON.stringify({
      sessionId: 's-bind',
      turnId: 'om_still_submitting',
      dispatchAttempt: 2,
      callerOpenId: 'ou_asker',
      trustedCaller: caller,
      procStart: readProcessStartIdentity(process.pid),
    }));

    seedInit({
      type: 'init',
      sessionId: 's-bind',
      sessionContract: {
        session: { appId: 'cli_app', sessionId: 's-bind' },
        worker: { workerId: 'w-2', generation: 2 },
        executions: [
          {
            ref: { executionId: 'exec-old-1', turnId: 'om_still_submitting', dispatchAttempt: 1 },
            phase: 'cancelled',
          },
          {
            ref: { executionId: 'exec-live-2', turnId: 'om_still_submitting', dispatchAttempt: 2 },
            phase: 'submitting',
          },
        ],
      },
      settledTurnTerminals: [
        { turnId: 'om_still_submitting', status: 'completed' },
      ],
    });
    bind();

    expect(scope.currentBotmuxTurnId).toBe('om_still_submitting');
    expect(scope.currentBotmuxDispatchAttempt).toBe(2);
    expect(published).toEqual(['om_still_submitting']);
    expect(onDisk()).toMatchObject({ turnId: 'om_still_submitting', capability: 'c'.repeat(64) });
  });

  it('retires a marker turn already settled in sessionContract executions across attempt shapes', () => {
    writeFileSync(markerPath, JSON.stringify({
      sessionId: 's-bind',
      turnId: 'om_contract_succeeded',
      trustedCaller: caller,
      procStart: readProcessStartIdentity(process.pid),
    }));

    seedInit({
      type: 'init',
      sessionId: 's-bind',
      sessionContract: {
        session: { appId: 'cli_app', sessionId: 's-bind' },
        worker: { workerId: 'w-2', generation: 2 },
        executions: [
          {
            ref: { executionId: 'exec-1', turnId: 'om_contract_succeeded', dispatchAttempt: 1 },
            phase: 'succeeded',
          },
        ],
      },
    });
    bind();

    expect(scope.currentBotmuxTurnId).toBeUndefined();
    expect((scope.activeTurnAuthority as ActiveTurnAuthority).snapshot()).toBeUndefined();
    expect(published).toEqual([]);
    expect(onDisk()).toMatchObject({ turnId: null, procStart: readProcessStartIdentity(process.pid) });
  });

  it('retires a marker turn whose own attempt already failed in sessionContract executions', () => {
    // A failed attempt settles only its own (turn, attempt) key: no generic
    // key, so this pins the attempt-scoped arm of the seeding.
    writeFileSync(markerPath, JSON.stringify({
      sessionId: 's-bind',
      turnId: 'om_attempt_failed',
      dispatchAttempt: 1,
      callerOpenId: 'ou_asker',
      trustedCaller: caller,
      procStart: readProcessStartIdentity(process.pid),
    }));

    seedInit({
      type: 'init',
      sessionId: 's-bind',
      sessionContract: {
        session: { appId: 'cli_app', sessionId: 's-bind' },
        worker: { workerId: 'w-2', generation: 2 },
        executions: [
          {
            ref: { executionId: 'exec-failed-1', turnId: 'om_attempt_failed', dispatchAttempt: 1 },
            phase: 'failed',
          },
        ],
      },
    });
    bind();

    expect(scope.currentBotmuxTurnId).toBeUndefined();
    expect((scope.activeTurnAuthority as ActiveTurnAuthority).snapshot()).toBeUndefined();
    expect(published).toEqual([]);
    expect(onDisk()).toMatchObject({ turnId: null, procStart: readProcessStartIdentity(process.pid) });
  });

  it('preserves a retry attempt when only an earlier attempt failed in sessionContract executions', () => {
    writeFileSync(markerPath, JSON.stringify({
      sessionId: 's-bind',
      turnId: 'om_retryable',
      dispatchAttempt: 2,
      callerOpenId: 'ou_asker',
      trustedCaller: caller,
      procStart: readProcessStartIdentity(process.pid),
    }));

    seedInit({
      type: 'init',
      sessionId: 's-bind',
      sessionContract: {
        session: { appId: 'cli_app', sessionId: 's-bind' },
        worker: { workerId: 'w-2', generation: 2 },
        executions: [
          {
            ref: { executionId: 'exec-fail-1', turnId: 'om_retryable', dispatchAttempt: 1 },
            phase: 'failed',
          },
          {
            ref: { executionId: 'exec-run-2', turnId: 'om_retryable', dispatchAttempt: 2 },
            phase: 'running',
          },
        ],
      },
    });
    bind();

    expect(scope.currentBotmuxTurnId).toBe('om_retryable');
    expect(scope.currentBotmuxDispatchAttempt).toBe(2);
    expect(published).toEqual(['om_retryable']);
    expect(onDisk()).toMatchObject({ turnId: 'om_retryable', capability: 'c'.repeat(64) });
  });
});
