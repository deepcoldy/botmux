import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWriteFileSync } from '../src/utils/atomic-write.js';
import { isValidMarkerIdentityTurnId } from '../src/core/turn-id-shape.js';

/**
 * Live wedge (Claude, chat-scope session + 10-minute silent schedule):
 * a Lark message typed ahead while turn A ran was folded into A as a
 * `queued_command` attachment, so its bridge turn B ended together with A.
 * The worker still held B as a queued type-ahead record and advanced the
 * active turn authority to it AFTER both terminals had gone out. Nothing could
 * release B any more, and every later `queueAfterActiveTurn` schedule fire
 * queued as "Claude is busy" for 13 hours while the CLI sat at its prompt.
 */
function harness(opts: { markerPath?: string } = {}) {
  const scope: Record<string, any> = {
    sessionId: 'sid',
    currentBotmuxTurnId: undefined,
    currentBotmuxDispatchAttempt: undefined,
    currentBotmuxCallerOpenId: undefined,
    currentBotmuxLinkRefMode: undefined,
    currentVcMeetingImTurnOrigin: undefined,
    currentTurnSteerPromoted: false,
    queuedTurnAdvanceConsumedForPrompt: false,
    rememberQueuedTurnAdvanceForPendingReady: vi.fn(),
    queuedTypeAheadTurns: [],
    retiredTurnIds: new Set<string>(),
    activeTurnAuthority: new ActiveTurnAuthority(),
    emittedTurnTerminals: new TurnTerminalDeduper(),
    submitFailureChains: new Map(),
    cliSpawnGeneration: 1,
    cancelSubmitFailureChainForTerminal: vi.fn(),
    turnExecutionClock: { settle: () => undefined, forget: vi.fn() },
    traexAutoModelController: undefined,
    lastTurnFailureSurfacedAtMs: undefined,
    codexBridgeQueue: { dropPendingTurn: () => false },
    thinkingTurn: undefined,
    sandboxRelayCapability: null,
    completeManagedTurnOriginRevocation: vi.fn(),
    terminalReleasesDurableTurn: () => false,
    remoteRunnerRecoveredTurnInFlight: false,
    flushPending: vi.fn(),
    queueMicrotask: (fn: () => void) => fn(),
    writeCliPidMarker: vi.fn(),
    publishSandboxRelayCapability: vi.fn(),
    syncQueuedTurnsFromMarkerDisk: () => false,
    crossPrincipalIsolationOn: () => false,
    send: vi.fn(),
    log: vi.fn(),
  };
  scope.markTurnRetired = (turnId?: string) => { if (turnId) scope.retiredTurnIds.add(turnId); };
  scope.setCaptureIdentity = (turnId?: string, dispatchAttempt?: number, caller?: string) => {
    scope.currentBotmuxTurnId = turnId;
    scope.currentBotmuxDispatchAttempt = dispatchAttempt;
    scope.currentBotmuxCallerOpenId = caller;
  };
  const names = [
    'turnAuthorityIdentity',
    'adoptActiveTurnWhenIsolationOff',
    'activeTurnBlocks',
    'markActiveTurnStarted',
    'releaseActiveTurnAuthority',
    'releaseTerminatedActiveTurnAuthority',
    'retireTerminatedQueuedTurn',
    'advanceQueuedTypeAheadTurn',
    'emitTurnTerminal',
    'dropQueuedTurnRecord',
    'turnTerminalEmitted',
    'retireTerminatedMarkerTurn',
  ];
  if (opts.markerPath) {
    // Real PID-marker round trip: the disk copy is what a lagging advance reads.
    Object.assign(scope, {
      cliPidMarker: opts.markerPath, rpcEnginePidMarker: undefined,
      existsSync, readFileSync, basename, atomicWriteFileSync,
      readProcessStartIdentity: () => undefined, publishActiveTurn: vi.fn(),
      withPidMarkerLock: (_path: string, fn: () => void) => fn(),
      adoptInitialActiveTurn: vi.fn(), adoptDisplacedActiveTurn: vi.fn(),
      markerIdentityTurnId: loadWorkerFunction('markerIdentityTurnId', { isValidMarkerIdentityTurnId }),
    });
    names.push('syncQueuedTurnsFromMarkerDisk', 'writeCliPidMarker', 'markerQueuedTurnStillLive');
  }
  for (const name of names) scope[name] = loadWorkerFunction(name, scope);
  return scope;
}

function startTurn(h: Record<string, any>, turnId: string): void {
  h.setCaptureIdentity(turnId);
  h.markActiveTurnStarted({ turnId });
}

describe('turn terminal releases the active turn authority', () => {
  it('does not advance authority to a type-ahead turn that ended inside its host turn', () => {
    const h = harness();
    startTurn(h, 'om_host');
    // Typed ahead while the host ran; Claude absorbed it into the host turn.
    h.queuedTypeAheadTurns.push({ turnId: 'om_absorbed' });

    h.emitTurnTerminal('om_host', 'completed');
    h.emitTurnTerminal('om_absorbed', 'completed');
    // The prompt-ready edge that follows tries to advance queued attribution.
    h.advanceQueuedTypeAheadTurn('prompt_ready');

    expect(h.activeTurnAuthority.snapshot()).toBeUndefined();
    expect(h.queuedTypeAheadTurns).toEqual([]);
    expect(h.retiredTurnIds.has('om_absorbed')).toBe(true);
    // A silent scheduled fire must be deliverable again.
    expect(h.activeTurnBlocks({ turnId: 'schedule:task:1', queueAfterActiveTurn: true })).toBe(false);
  });

  it('frees an authority still held by a turn whose terminal already went out', () => {
    const h = harness();
    startTurn(h, 'schedule:task:1');
    h.emitTurnTerminal('schedule:task:1', 'completed');
    // Wedged state: a lagging advance re-attached the finished turn.
    startTurn(h, 'schedule:task:1');
    expect(h.activeTurnBlocks({ turnId: 'schedule:task:2', queueAfterActiveTurn: true })).toBe(true);

    // The next real turn's terminal does not match the stale holder exactly.
    h.emitTurnTerminal('om_next', 'completed');

    expect(h.activeTurnAuthority.snapshot()).toBeUndefined();
    expect(h.activeTurnBlocks({ turnId: 'schedule:task:2', queueAfterActiveTurn: true })).toBe(false);
  });

  it('keeps a live authority when an unrelated terminal arrives', () => {
    const h = harness();
    startTurn(h, 'om_running');
    h.emitTurnTerminal('om_superseded', 'completed');
    expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('om_running');
  });

  it('keeps a queued retry of the same turn under another dispatch attempt', () => {
    const h = harness();
    startTurn(h, 'om_running');
    h.queuedTypeAheadTurns.push({ turnId: 'om_retry', dispatchAttempt: 2 });
    h.emitTurnTerminal('om_retry', 'failed', 'x', 1);
    expect(h.queuedTypeAheadTurns).toEqual([{ turnId: 'om_retry', dispatchAttempt: 2 }]);
    expect(h.retiredTurnIds.has('om_retry')).toBe(false);
  });
});

describe('queued type-ahead advance skips turns whose terminal already went out', () => {
  function withMarker(fn: (marker: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'terminal-authority-marker-'));
    try { fn(join(dir, 'marker')); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const readMarker = (marker: string) => JSON.parse(readFileSync(marker, 'utf8'));

  it('never re-attaches authority to a finished turn the PID marker still names', () => {
    withMarker(marker => {
      const h = harness({ markerPath: marker });
      startTurn(h, 'om_host');
      h.queuedTypeAheadTurns.push({ turnId: 'om_absorbed' });
      // The send hook promoted the queued turn on disk while the host ran.
      writeFileSync(marker, JSON.stringify({ sessionId: 'sid', turnId: 'om_absorbed',
        queuedTurns: [{ turnId: 'om_absorbed' }] }));
      h.emitTurnTerminal('om_host', 'completed');
      // Terminal claimed without the in-memory retire (e.g. another emitter).
      h.emittedTurnTerminals.claim('sid', 'om_absorbed', undefined, 'completed');

      expect(h.syncQueuedTurnsFromMarkerDisk()).toBe(false);
      expect(h.advanceQueuedTypeAheadTurn('prompt_ready')).toBe(false);

      expect(h.activeTurnAuthority.snapshot()).toBeUndefined();
      expect(h.queuedTypeAheadTurns).toEqual([]);
      expect(h.retiredTurnIds.has('om_absorbed')).toBe(true);
      expect(h.activeTurnBlocks({ turnId: 'schedule:task:1', queueAfterActiveTurn: true })).toBe(false);
    });
  });

  it('advances past an absorbed B to the unfinished C through the PID marker', () => {
    withMarker(marker => {
      const h = harness({ markerPath: marker });
      startTurn(h, 'om_host');
      h.queuedTypeAheadTurns.push({ turnId: 'om_B' }, { turnId: 'om_C' });
      writeFileSync(marker, JSON.stringify({ sessionId: 'sid', turnId: 'om_B',
        queuedTurns: [{ turnId: 'om_B' }, { turnId: 'om_C' }] }));
      h.emitTurnTerminal('om_host', 'completed');
      h.emittedTurnTerminals.claim('sid', 'om_B', undefined, 'completed');

      expect(h.advanceQueuedTypeAheadTurn('prompt_ready')).toBe(true);

      expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('om_C');
      expect(h.currentBotmuxTurnId).toBe('om_C');
      expect(h.queuedTypeAheadTurns).toEqual([]);
      expect(readMarker(marker).turnId).toBe('om_C');
      expect(h.retiredTurnIds.has('om_B')).toBe(true);
    });
  });

  it('does not re-queue a finished turn that only the PID marker still lists', () => {
    withMarker(marker => {
      const h = harness({ markerPath: marker });
      startTurn(h, 'om_running');
      writeFileSync(marker, JSON.stringify({ sessionId: 'sid', turnId: 'om_running',
        queuedTurns: [{ turnId: 'om_B' }, { turnId: 'om_C' }] }));
      h.emittedTurnTerminals.claim('sid', 'om_B', undefined, 'completed');

      h.syncQueuedTurnsFromMarkerDisk();

      expect(h.queuedTypeAheadTurns).toEqual([{ turnId: 'om_C' }]);
    });
  });

  it('skips a finished head in memory and advances to the next unfinished record', () => {
    const h = harness();
    startTurn(h, 'om_host');
    h.queuedTypeAheadTurns.push({ turnId: 'om_B' }, { turnId: 'om_C' });
    h.emitTurnTerminal('om_host', 'completed');
    h.emittedTurnTerminals.claim('sid', 'om_B', undefined, 'completed');

    expect(h.advanceQueuedTypeAheadTurn('prompt_ready')).toBe(true);

    expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('om_C');
    expect(h.retiredTurnIds.has('om_B')).toBe(true);
  });

  it('leaves authority untouched when every queued record has finished', () => {
    const h = harness();
    startTurn(h, 'om_running');
    h.queuedTypeAheadTurns.push({ turnId: 'om_B' });
    h.emittedTurnTerminals.claim('sid', 'om_B', undefined, 'completed');

    expect(h.advanceQueuedTypeAheadTurn('prompt_ready')).toBe(false);

    expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('om_running');
    expect(h.currentBotmuxTurnId).toBe('om_running');
  });

  it('keeps a live retry attempt the marker lists while retiring its dead attempt head', () => {
    withMarker(marker => {
      const h = harness({ markerPath: marker });
      startTurn(h, 'om_host');
      // The head names durable attempt 1, whose terminal is already out, while
      // the same turn's attempt 2 is live work queued alongside it.
      writeFileSync(marker, JSON.stringify({ sessionId: 'sid', turnId: 'om_T', dispatchAttempt: 1,
        queuedTurns: [{ turnId: 'om_T', dispatchAttempt: 2 }] }));
      h.emittedTurnTerminals.claim('sid', 'om_T', 1, 'completed');

      h.syncQueuedTurnsFromMarkerDisk();

      // The attempt-agnostic turnId tombstone must not kill the retry: the
      // record is restored from disk and later promotion stays possible.
      expect(h.queuedTypeAheadTurns).toEqual([{ turnId: 'om_T', dispatchAttempt: 2 }]);
      expect(h.retiredTurnIds.has('om_T')).toBe(false);
      expect(h.currentBotmuxTurnId).toBe('om_host');
    });
  });

  it('adopts a memory-held live retry after the marker promotes that attempt', () => {
    withMarker(marker => {
      const h = harness({ markerPath: marker });
      startTurn(h, 'om_host');
      h.queuedTypeAheadTurns.push({ turnId: 'om_T', dispatchAttempt: 2 });
      writeFileSync(marker, JSON.stringify({ sessionId: 'sid', turnId: 'om_T', dispatchAttempt: 1,
        queuedTurns: [{ turnId: 'om_T', dispatchAttempt: 2 }] }));
      h.emittedTurnTerminals.claim('sid', 'om_T', 1, 'completed');

      h.syncQueuedTurnsFromMarkerDisk();
      expect(h.queuedTypeAheadTurns).toEqual([{ turnId: 'om_T', dispatchAttempt: 2 }]);
      expect(h.retiredTurnIds.has('om_T')).toBe(false);

      // A later marker write promotes the still-live attempt 2 to head.
      writeFileSync(marker, JSON.stringify({ sessionId: 'sid', turnId: 'om_T', dispatchAttempt: 2,
        queuedTurns: [{ turnId: 'om_T', dispatchAttempt: 2 }] }));
      expect(h.syncQueuedTurnsFromMarkerDisk()).toBe(true);

      expect(h.currentBotmuxTurnId).toBe('om_T');
      expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('om_T');
    });
  });

  it('tombstones the turnId when every attempt named in the marker has terminated', () => {
    withMarker(marker => {
      const h = harness({ markerPath: marker });
      startTurn(h, 'om_host');
      writeFileSync(marker, JSON.stringify({ sessionId: 'sid', turnId: 'om_T', dispatchAttempt: 1,
        queuedTurns: [{ turnId: 'om_T', dispatchAttempt: 2 }] }));
      h.emittedTurnTerminals.claim('sid', 'om_T', 1, 'completed');
      h.emittedTurnTerminals.claim('sid', 'om_T', 2, 'failed');

      h.syncQueuedTurnsFromMarkerDisk();

      expect(h.queuedTypeAheadTurns).toEqual([]);
      expect(h.retiredTurnIds.has('om_T')).toBe(true);
      expect(h.currentBotmuxTurnId).toBe('om_host');
    });
  });

  it('spares a memory-only live retry when a lagging marker heads its dead attempt', () => {
    withMarker(marker => {
      const h = harness({ markerPath: marker });
      startTurn(h, 'om_host');
      // Retry delivered via IPC into memory; the lagging marker still heads the
      // dead attempt 1 and does not list queuedTurns yet.
      h.queuedTypeAheadTurns.push({ turnId: 'om_T', dispatchAttempt: 2 });
      writeFileSync(marker, JSON.stringify({ sessionId: 'sid', turnId: 'om_T', dispatchAttempt: 1 }));
      h.emittedTurnTerminals.claim('sid', 'om_T', 1, 'completed');

      h.syncQueuedTurnsFromMarkerDisk();

      expect(h.queuedTypeAheadTurns).toEqual([{ turnId: 'om_T', dispatchAttempt: 2 }]);
      expect(h.retiredTurnIds.has('om_T')).toBe(false);

      writeFileSync(marker, JSON.stringify({ sessionId: 'sid', turnId: 'om_T', dispatchAttempt: 2 }));
      expect(h.syncQueuedTurnsFromMarkerDisk()).toBe(true);
      expect(h.currentBotmuxTurnId).toBe('om_T');
      expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('om_T');
    });
  });

  it('never refills a turn the worker already advanced past, even with an explicit attempt', () => {
    withMarker(marker => {
      const h = harness({ markerPath: marker });
      startTurn(h, 'om_host');
      // markTurnRetired is attempt-agnostic and always marks the previous turn
      // when advancing. A lagging marker (e.g. the slower of the dual markers,
      // or a rewrite whose failure was swallowed) can still list that turn as
      // a durable queued record. Refilling it would re-adopt a finished turn
      // whose ordinary attempt-less terminal can never release the
      // attempt-qualified authority again.
      h.retiredTurnIds.add('om_A');
      writeFileSync(marker, JSON.stringify({ sessionId: 'sid', turnId: 'om_host',
        queuedTurns: [{ turnId: 'om_A', dispatchAttempt: 1 }] }));

      h.syncQueuedTurnsFromMarkerDisk();
      expect(h.queuedTypeAheadTurns).toEqual([]);
      expect(h.advanceQueuedTypeAheadTurn('prompt_ready')).toBe(false);
      expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('om_host');

      // The host ending releases authority normally; a scheduled fire is
      // admitted instead of parking behind a resurrected dead turn.
      h.emitTurnTerminal('om_B', 'completed');
      h.emitTurnTerminal('om_A', 'completed');
      h.emitTurnTerminal('om_host', 'completed');
      expect(h.activeTurnAuthority.snapshot()).toBeUndefined();
      expect(h.activeTurnBlocks({ turnId: 'schedule:task:2', queueAfterActiveTurn: true })).toBe(false);
    });
  });

  for (const status of ['completed', 'cancelled'] as const) {
    it(`does not refill an attempt-qualified record whose generic-key terminal is ${status}`, () => {
      withMarker(marker => {
        const h = harness({ markerPath: marker });
        startTurn(h, 'om_host');
        // Ordinary IM turns emit terminals without a dispatchAttempt; a
        // completed/cancelled turn is terminal under every delivery policy,
        // so an attempt-qualified marker record for the same turn is dead.
        writeFileSync(marker, JSON.stringify({ sessionId: 'sid', turnId: 'om_host',
          queuedTurns: [{ turnId: 'om_G', dispatchAttempt: 3 }] }));
        h.emittedTurnTerminals.claim('sid', 'om_G', undefined, status);

        h.syncQueuedTurnsFromMarkerDisk();
        expect(h.queuedTypeAheadTurns).toEqual([]);
      });
    });
  }

  for (const status of ['failed', 'ambiguous'] as const) {
    it(`keeps an attempt-qualified durable retry after a generic-key ${status} terminal`, () => {
      withMarker(marker => {
        const h = harness({ markerPath: marker });
        startTurn(h, 'om_host');
        // Durable delivery (VC meeting / hidden schedule) re-dispatches after
        // failed/ambiguous with dispatchAttempt + 1; the attempt-qualified
        // record IS that retry and must survive both in memory and in the
        // marker rewrite that follows the sync.
        writeFileSync(marker, JSON.stringify({ sessionId: 'sid', turnId: 'om_host',
          queuedTurns: [{ turnId: 'om_T', dispatchAttempt: 2 }] }));
        h.emittedTurnTerminals.claim('sid', 'om_T', undefined, status);

        h.syncQueuedTurnsFromMarkerDisk();
        expect(h.queuedTypeAheadTurns).toEqual([{ turnId: 'om_T', dispatchAttempt: 2 }]);
        expect(JSON.parse(readFileSync(marker, 'utf8')).queuedTurns)
          .toEqual([{ turnId: 'om_T', dispatchAttempt: 2 }]);
      });
    });
  }
});
