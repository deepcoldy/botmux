import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
import { withFileLockSync } from '../src/utils/file-lock.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

// Regression for a merge regression: writeCliPidMarker() runs inside the
// non-reentrant marker lock, and the queued-turn adopt path calls
// publishSandboxRelayCapability(), whose tail re-enters writeCliPidMarker().
// A naive re-lock self-deadlocks for the lock timeout (5s) and the rotating
// capability never reaches disk — which is exactly the proof `botmux manager`
// needs. This drives the REAL file lock + REAL atomic writer through that chain.
describe('pid marker reentrancy + capability persistence', () => {
  let dir: string;
  let markerPath: string;
  const scope: Record<string, unknown> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pid-marker-reentry-'));
    markerPath = join(dir, '12345.pid-marker');

    // Shared module state (the harness Proxy writes `let` mutations back here).
    Object.assign(scope, {
      heldPidMarkerPaths: new Set<string>(),
      // node/path primitives
      existsSync, readFileSync, basename,
      readProcessStartIdentity: () => undefined,
      withFileLockSync,
      atomicWriteFileSync,
      // marker identity
      sessionId: 's-reentry',
      cliPidMarker: markerPath,
      rpcEnginePidMarker: undefined,
      currentBotmuxTurnId: 'om_current',
      currentBotmuxDispatchAttempt: 1,
      currentBotmuxCallerOpenId: undefined,
      currentTurnSteerPromoted: false,
      currentVcMeetingImTurnOrigin: undefined,
      sandboxRelayCapability: undefined,
      activeTurnAuthority: { snapshot: () => undefined },
      retiredTurnIds: new Set<string>(),
      queuedTypeAheadTurns: [{ turnId: 'om_next', dispatchAttempt: 2 }],
      queuedTurnAdvanceConsumedForPrompt: false,
      // turn side-effects
      markTurnRetired: () => {},
      markActiveTurnStarted: () => {},
      adoptInitialActiveTurn: () => {},
      adoptDisplacedActiveTurn: () => {},
      // SESSION_DATA_DIR is set in the dev shell; the active-turn identity write is
      // unrelated to this marker-lock regression, so stub it out.
      publishActiveTurn: () => {},
      log: () => {},
      setCaptureIdentity: (turnId: string, dispatchAttempt?: number) => {
        scope.currentBotmuxTurnId = turnId;
        scope.currentBotmuxDispatchAttempt = dispatchAttempt;
      },
    });

    // The three functions share one scope so the module-level lock-depth Set and
    // sibling calls resolve to the same real implementations.
    const withPidMarkerLock = loadWorkerFunction<(p: string, fn: () => void) => void>('withPidMarkerLock', scope);
    const writeCliPidMarker = loadWorkerFunction<() => void>('writeCliPidMarker', scope);
    scope.withPidMarkerLock = withPidMarkerLock;
    scope.writeCliPidMarker = writeCliPidMarker;
    // Production publish tail: publish the capability for the now-current turn,
    // then re-write the marker — the call that used to self-deadlock.
    scope.publishSandboxRelayCapability = () => {
      scope.sandboxRelayCapability = {
        token: 'a'.repeat(64),
        turnId: scope.currentBotmuxTurnId,
        dispatchAttempt: scope.currentBotmuxDispatchAttempt,
      };
      (scope.writeCliPidMarker as () => void)();
    };

    // Disk names an in-queue newer turn (the prompt_ready promotion scenario).
    writeFileSync(markerPath, JSON.stringify({
      sessionId: 's-reentry', turnId: 'om_next', dispatchAttempt: 2,
    }), { mode: 0o600 });
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('adopts a queued turn under the lock without self-deadlocking and persists a 0600 capability', () => {
    const sync = loadWorkerFunction<() => boolean>('syncQueuedTurnsFromMarkerDisk', scope);

    const t0 = Date.now();
    const synced = sync();
    const elapsed = Date.now() - t0;

    // Old code waited the full 5s lock timeout here (and returned false because
    // the write threw inside the lock). Must be fast and report a sync.
    expect(synced).toBe(true);
    expect(elapsed).toBeLessThan(1000);
    expect(scope.currentBotmuxTurnId).toBe('om_next');

    const onDisk = JSON.parse(readFileSync(markerPath, 'utf-8'));
    expect(onDisk.turnId).toBe('om_next');
    expect(onDisk.capability).toBe('a'.repeat(64));
    expect((statSync(markerPath).mode & 0o777)).toBe(0o600);
  });
});
