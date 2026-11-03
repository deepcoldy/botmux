/**
 * Worker wiring around the bridge queue's duration-marker hold, executed as
 * the real worker functions (test/helpers/worker-function-harness.ts):
 *   - the non-adopt baseline skips history without parsing it, so it must seed
 *     the queue from the transcript tail — or the first turn after every
 *     restart is settled on a block-level stop_reason again;
 *   - the idle-edge settles (PTY prompt, Herdr status) keep waiting while the
 *     head turn is still being written, and drop out once the CLI moves on;
 *   - when the CLI generation ends, a held turn is settled instead of being
 *     lost: the pre-interrupt drain lets its terminal beat `cli_exit`, and the
 *     watcher teardown emits it before clearing the queue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeTurnQueue, makeFingerprint } from '../src/services/bridge-turn-queue.js';
import { BridgeBlindTurnWatch } from '../src/services/claude-bridge-blind-turn.js';
import { localTurnFailureNotice } from '../src/services/local-turn-failure.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { t } from '../src/i18n/index.js';
import { transcriptShowsTurnDurationMarker, type TranscriptEvent } from '../src/services/claude-transcript.js';
import { createTranscriptTerminalSettle } from '../src/services/transcript-terminal-settle.js';
import { baselineJsonlCursor } from '../src/services/jsonl-cursor.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bmx-dur-'));
  path = join(dir, 'session.jsonl');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const user = (uuid: string, content: string): TranscriptEvent => ({ type: 'user', uuid, message: { role: 'user', content } });
const thinkingFinal = (uuid: string): TranscriptEvent => ({
  type: 'assistant', uuid,
  message: { id: 'msg-final', role: 'assistant', content: [{ type: 'thinking', thinking: '…' }], stop_reason: 'end_turn' },
} as TranscriptEvent);

function baselineInto(queue: BridgeTurnQueue): void {
  const bridgeAbsorbBaseline = loadWorkerFunction<() => void>('bridgeAbsorbBaseline', {
    bridgeJsonlPath: path,
    lastInitConfig: { cliId: 'claude-code' },
    bridgeQueue: queue,
    bridgeOffset: 0,
    bridgeBaselineDone: false,
    cliTranscriptEverExisted: false,
    restoreScheduledTaskAnchorsOnce: () => {},
    scanRestartInterruption: () => {},
    tryRestoreInterruptedBridgeTurns: () => false,
    baselineJsonlCursor,
    transcriptShowsTurnDurationMarker,
  });
  bridgeAbsorbBaseline();
}

describe('worker bridge baseline: duration-marker capability', () => {
  it('holds the first turn after a restart on a transcript whose history shows the marker', () => {
    appendFileSync(path, `${JSON.stringify({ type: 'system', subtype: 'turn_duration', uuid: 'old-d' })}\n`);
    const queue = new BridgeTurnQueue();
    baselineInto(queue);
    queue.mark('om_turn', makeFingerprint('next prompt'), 100, 'next prompt', 1);
    queue.ingest([user('u1', 'next prompt'), thinkingFinal('a1')]);
    expect(queue.drainEmittable({ explicitTerminalOnly: true })).toEqual([]);
  });

  it('still holds when the history shows none, until a wait for the marker runs out', () => {
    appendFileSync(path, `${JSON.stringify({ type: 'user', uuid: 'old-u', message: { role: 'user', content: 'hi' } })}\n`);
    const queue = new BridgeTurnQueue();
    baselineInto(queue);
    queue.mark('om_turn', makeFingerprint('next prompt'), 100, 'next prompt', 1);
    queue.ingest([user('u1', 'next prompt'), thinkingFinal('a1')]);
    expect(queue.drainEmittable({ explicitTerminalOnly: true })).toEqual([]);
    queue.noteDurationMarkerWaitExpired();
    expect(queue.drainEmittable({ explicitTerminalOnly: true }).map(turn => turn.turnId)).toEqual(['om_turn']);
  });
});

describe('worker bridgeHeadTurnAwaitingTerminal (idle-edge settles)', () => {
  function idleSettle(queue: BridgeTurnQueue) {
    const scope = {
      bridgeJsonlPath: path,
      lastInitConfig: { cliId: 'claude-code' },
      bridgeIngest: () => {},
      bridgeQueue: queue,
    };
    return {
      awaiting: loadWorkerFunction<(opts?: { startedOnly?: boolean }) => boolean>('bridgeHeadTurnAwaitingTerminal', scope),
      expire: loadWorkerFunction<() => void>('noteBridgeTurnCloseWaitExpired', scope),
    };
  }
  const durationMarker = { type: 'system', subtype: 'turn_duration', uuid: 'd1' } as TranscriptEvent;

  it('keeps waiting while the head turn is held for its duration marker', () => {
    const queue = new BridgeTurnQueue();
    queue.noteDurationMarkerObserved();
    const { awaiting } = idleSettle(queue);
    queue.mark('om_turn', makeFingerprint('next prompt'), 100, 'next prompt', 1);
    queue.ingest([user('u1', 'next prompt'), thinkingFinal('a1')]);
    expect(awaiting()).toBe(true);
    queue.ingest([durationMarker]);
    expect(awaiting()).toBe(false);
  });

  it('waits on a running turn before any of its closing records was read', () => {
    const queue = new BridgeTurnQueue();
    queue.noteDurationMarkerObserved();
    const { awaiting } = idleSettle(queue);
    queue.mark('om_turn', makeFingerprint('next prompt'), 100, 'next prompt');
    expect(awaiting({ startedOnly: true })).toBe(false);
    expect(awaiting()).toBe(true);
    queue.ingest([user('u1', 'next prompt')]);
    expect(awaiting({ startedOnly: true })).toBe(true);
  });

  it('waits on the first turn of a session until the wait has run out once', () => {
    const queue = new BridgeTurnQueue();
    const { awaiting, expire } = idleSettle(queue);
    queue.mark('om_turn', makeFingerprint('next prompt'), 100, 'next prompt');
    queue.ingest([user('u1', 'next prompt'), thinkingFinal('a1')]);
    expect(awaiting({ startedOnly: true })).toBe(true);
    expire();
    expect(awaiting({ startedOnly: true })).toBe(false);
    expect(queue.drainEmittable({ terminalBoundary: true }).map(turn => turn.turnId)).toEqual(['om_turn']);
  });

  describe('an idle edge still settling when the CLI moves on', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    /** A PTY idle edge waiting on a turn whose closing records never arrive. */
    function pendingIdleEdge() {
      const proceed = vi.fn();
      const settle = createTranscriptTerminalSettle({ awaitingTerminal: () => true });
      settle.request(proceed);
      return { proceed, settle };
    }

    it('is dropped when the next input is written to the CLI', () => {
      const { proceed, settle } = pendingIdleEdge();
      const scope: Record<string, unknown> = {
        idleTranscriptSettle: settle,
        beginRuntimeWriteCycle: (cycle: { setPromptReady: (ready: boolean) => void; resetIdleDetector: () => void }) => {
          cycle.setPromptReady(false);
          cycle.resetIdleDetector();
        },
        isPromptReady: false,
        idleDetector: null,
        backgroundTaskTracker: { noteMainTurn: () => {} },
        backgroundWaitTasks: 0,
      };
      loadWorkerFunction<() => void>('beginCliWriteCycle', scope)();
      vi.advanceTimersByTime(10_000);
      expect(proceed).not.toHaveBeenCalled();
    });

    it('is dropped when the CLI shows its busy marker again', () => {
      const { proceed, settle } = pendingIdleEdge();
      let busy: (() => void) | undefined;
      const scope: Record<string, unknown> = {
        idleTranscriptSettle: settle,
        isPromptReady: false,
        log: () => {},
        noteClaudeBridgeTurnStarted: () => {},
        publishScreenStatus: () => {},
      };
      loadWorkerFunction<(detector: unknown, label: string) => void>('wireIdleDetectorBusyTransition', scope)(
        { onBusy: (cb: () => void) => { busy = cb; } }, 'Claude PTY');
      busy!();
      vi.advanceTimersByTime(10_000);
      expect(proceed).not.toHaveBeenCalled();
    });
  });

  it('does not take a turn that never wrote any terminal record as a CLI without the marker', () => {
    const queue = new BridgeTurnQueue();
    const { awaiting, expire } = idleSettle(queue);
    queue.mark('om_quiet', makeFingerprint('quiet prompt'), 100, 'quiet prompt');
    queue.ingest([user('u0', 'quiet prompt')]);
    expire();
    queue.drainEmittable({ terminalBoundary: true });
    queue.mark('om_turn', makeFingerprint('next prompt'), 200, 'next prompt');
    queue.ingest([user('u1', 'next prompt'), thinkingFinal('a1')]);
    expect(awaiting({ startedOnly: true })).toBe(true);
  });
});

/** The real emitReadyTurns plus the exit-path callers, sharing one scope. The
 *  fallback-text helpers are stubbed: the turns under test carry no visible
 *  text, so only the terminal side matters. */
function exitPath(queue: BridgeTurnQueue) {
  const deduper = new TurnTerminalDeduper();
  const terminals: unknown[][] = [];
  const scope: Record<string, unknown> = {
    bridgeQueue: queue,
    bridgeJsonlPath: path,
    bridgeBaselineDone: true,
    bridgeFingerprintScanLastMs: new Map(),
    journalBridgeTurnClear: () => {},
    rememberTurnLinkRefMode: () => {},
    readSendMarkers: () => [],
    lastInitConfig: { cliId: 'claude-code' },
    log: () => {},
    cliName: () => 'Claude',
    t,
    zeroPromptTerminalSync: () => false,
    localTurnFailureNotice,
    WORKER_STARTED_AT_MS: 0,
    send: () => {},
    notifyExplicitRepliesObserved: () => {},
    attributableExplicitReplyMarkersForTurnWindow: () => [],
    drainTranscript: () => ({ events: [], newOffset: 0, pendingTail: '' }),
    trailingAssistantText: () => '',
    replyDeliveryMode: () => 'auto',
    emitTurnTerminal: (turnId: string, status: string, ...rest: unknown[]) => {
      if (deduper.claim('sid', turnId, rest[1] as number | undefined)) terminals.push([turnId, status, ...rest]);
    },
    // drainReliableTerminalBeforeInterrupt / bridgeDrainAndMaybeEmit
    cliAdapter: { reliableTurnTerminal: true },
    bridgeIngest: () => {},
    refreshOrcaClaudeWebHistory: () => {},
    pruneSecondaryPaths: () => {},
    codexBridgeFallbackActive: () => false,
    // stopBridgeWatcher teardown
    clearHerdrAdoptBridgeQuietTimer: () => {},
    bridgeWatcher: null,
    bridgeFallbackTimer: null,
    bridgeKnownSessionIds: new Set(),
    bridgeSecondaryPaths: new Map(),
    bridgeRestoreGate: { markGenerationRetired: () => {} },
    bridgeBlindTurnWatch: new BridgeBlindTurnWatch(),
    resetThinkingChannel: () => {},
    disarmProvisionalExitWatch: () => {},
    beginNewBridgeTranscriptGeneration: () => {},
  };
  scope.emitReadyTurns = loadWorkerFunction('emitReadyTurns', scope);
  scope.bridgeDrainAndMaybeEmit = loadWorkerFunction('bridgeDrainAndMaybeEmit', scope);
  return {
    terminals,
    drainBeforeInterrupt: loadWorkerFunction<() => void>('drainReliableTerminalBeforeInterrupt', scope),
    stopBridgeWatcher: loadWorkerFunction<() => void>('stopBridgeWatcher', scope),
    /** What the exit handler sends right after the pre-interrupt drain. */
    cliExit: (turnId: string, attempt: number) => (scope.emitTurnTerminal as Function)(turnId, 'ambiguous', 'cli_exit', attempt),
  };
}

describe('worker bridge: a held turn when the CLI generation ends', () => {
  function heldTurn(dispatchAttempt?: number): BridgeTurnQueue {
    const queue = new BridgeTurnQueue();
    queue.noteDurationMarkerObserved();
    queue.mark('om_turn', makeFingerprint('next prompt'), 100, 'next prompt', dispatchAttempt);
    queue.ingest([user('u1', 'next prompt'), thinkingFinal('a1')]);
    expect(queue.drainEmittable({ terminalBoundary: true, requireExplicitTerminalForDurable: true })).toEqual([]);
    return queue;
  }

  it('lets the finished durable turn win the deduper before cli_exit (no replay of a completed turn)', () => {
    const w = exitPath(heldTurn(3));
    w.drainBeforeInterrupt();
    w.cliExit('om_turn', 3);
    expect(w.terminals).toEqual([['om_turn', 'completed', undefined, 3, undefined, undefined]]);
  });

  it('settles an ordinary held turn at watcher teardown instead of clearing it away', () => {
    const queue = heldTurn();
    const w = exitPath(queue);
    w.stopBridgeWatcher();
    expect(w.terminals).toEqual([['om_turn', 'completed', undefined, undefined, undefined, undefined]]);
    expect(queue.peek()).toEqual([]);
  });
});

/**
 * Increment over #2227: the bounded close wait used to be reachable only from
 * an idle edge's settle. When no idle edge ever fires (a background task keeps
 * the screen busy / program-status `working`), the head turn waited forever.
 * updateProvisionalExitWatch arms a watchdog applying the SAME wait-expired
 * verdict the idle settle would; it stands down while a prompt is on screen or
 * a settle is in flight, and never taints the verdict from a restored turn.
 */
describe('provisional-exit watchdog (no idle edge fallback)', () => {
  const textFinal = (uuid: string, body = 'the answer'): TranscriptEvent => ({
    type: 'assistant', uuid,
    message: { id: 'msg-final', role: 'assistant', content: [{ type: 'text', text: body }], stop_reason: 'end_turn' },
  });
  const thinkingOnly = (uuid: string): TranscriptEvent => ({
    type: 'assistant', uuid,
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: '…' }], stop_reason: 'end_turn' },
  });

  function harness(opts: { screenShowsPrompt?: boolean; heldWorking?: boolean } = {}) {
    vi.useFakeTimers();
    const queue = new BridgeTurnQueue();
    const drained: unknown[] = [];
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    let boundTurn: unknown = null;
    const scope: Record<string, unknown> = {
      bridgeQueue: queue,
      bridgeJsonlPath: path,
      lastInitConfig: { cliId: 'claude-code' },
      idleTranscriptSettleInFlight: false,
      get provisionalExitTimer() { return watchdogTimer; },
      set provisionalExitTimer(v) { watchdogTimer = v; },
      get provisionalExitBoundTurn() { return boundTurn; },
      set provisionalExitBoundTurn(v) { boundTurn = v; },
      bridgeTranscriptGeneration: 0,
      // Mirror production disarmProvisionalExitWatch exactly: clear the bound
      // turn as well as the timer, or future tests on this seam would observe
      // state production can never hold.
      disarmProvisionalExitWatch: () => {
        if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
        boundTurn = null;
      },
      PROVISIONAL_EXIT_WATCH_MS: 2_000,
      idleDetector: {
        isIdleNow: () => false,
        screenShowsPrompt: () => opts.screenShowsPrompt ?? false,
        programStatusHeldWorking: () => opts.heldWorking ?? false,
      },
      log: () => {},
      // Mirror the production timer callback: explicit ingest first, then an
      // emit that drains with the same identity gate — never a global
      // terminal-boundary drain that could pop a following type-ahead turn.
      bridgeIngest: () => { queue.ingest([]); },
      emitReadyTurns: (o: { explicitTerminalOnly?: boolean; onlyTurn?: { turnId: string; dispatchAttempt?: number } }) => {
        const popped = queue.drainEmittable(o.explicitTerminalOnly
          ? { explicitTerminalOnly: true, onlyTurn: o.onlyTurn }
          : { terminalBoundary: true, requireExplicitTerminalForDurable: true, onlyTurn: o.onlyTurn });
        for (const turn of popped) drained.push(turn);
      },
    };
    const update = loadWorkerFunction<() => void>('updateProvisionalExitWatch', scope);
    // The watchdog timer closes over these worker functions; load the real
    // ones against the same scope so verdicts/drains behave in production.
    const realNoteExpired = loadWorkerFunction<() => void>('noteBridgeTurnCloseWaitExpired', scope);
    scope.noteBridgeTurnCloseWaitExpired = realNoteExpired;
    return {
      queue, scope, drains: () => drained.length, drainedTurns: () => drained, update,
      advance: (ms: number) => vi.advanceTimersByTime(ms),
      cleanup: () => vi.useRealTimers(),
    };
  }

  afterEach(() => vi.useRealTimers());

  it('does nothing without a fresh head awaiting its marker', () => {
    const h = harness();
    h.update();
    expect(h.scope.provisionalExitTimer).toBeNull();
  });

  it('drains and learns wait-expired after the bound when no idle edge comes', () => {
    const h = harness();
    h.queue.mark('om_first', makeFingerprint('first prompt'), 100, 'first prompt', 1);
    h.queue.ingest([user('u1', 'first prompt'), textFinal('a1')]);
    h.update();
    expect(h.scope.provisionalExitTimer).not.toBeNull();
    h.advance(1_999);
    expect(h.drains()).toBe(0);
    h.advance(2);
    expect(h.drains()).toBe(1);
    h.queue.mark('om_second', makeFingerprint('second prompt'), 200, 'second prompt', 1);
    h.queue.ingest([user('u2', 'second prompt'), textFinal('a2', 'answer two')]);
    expect(h.queue.drainEmittable({ explicitTerminalOnly: true }).map(turn => turn.turnId)).toEqual(['om_second']);
  });

  it('stands down while the prompt is on screen WITHOUT a held working status (idle quiescence window)', () => {
    // PTY backends have no OSC status: the composer visible means the idle
    // edge's quiescence confirmation is in flight. Firing here would race it.
    const h = harness({ screenShowsPrompt: true, heldWorking: false });
    h.queue.mark('om_first', makeFingerprint('first prompt'), 100, 'first prompt', 1);
    h.queue.ingest([user('u1', 'first prompt'), thinkingOnly('a-think')]);
    h.update();
    expect(h.scope.provisionalExitTimer).not.toBeNull();
    h.advance(2_001);
    expect(h.drains()).toBe(0);
  });

  it('still fires when a held working status keeps the composer busy forever (no idle edge ever comes)', () => {
    // Background task: OSC says working AND the composer is on screen. The
    // idle edge never fires; the visible prompt must not cancel the fallback.
    const h = harness({ screenShowsPrompt: true, heldWorking: true });
    h.queue.mark('om_first', makeFingerprint('first prompt'), 100, 'first prompt', 1);
    h.queue.ingest([user('u1', 'first prompt'), textFinal('a1')]);
    h.update();
    h.advance(2_001);
    expect(h.drains()).toBe(1);
  });

  it('restarts the bound when the SAME turn keeps flushing blocks (split final, held working)', () => {
    // Claude writes the final message one block per flush, each stamped with
    // stop_reason. Anchoring the bound at the FIRST block settles the turn on
    // a truncated body: the bound must measure transcript QUIET — new records
    // attributed to the bound turn restart it.
    const h = harness({ heldWorking: true });
    h.queue.mark('om_first', makeFingerprint('first prompt'), 100, 'first prompt', 1);
    h.queue.ingest([user('u1', 'first prompt'), textFinal('a-text1', 'first part')]);
    h.update();
    h.advance(1_500); // original deadline would be t=2000
    // The remaining block lands AFTER that, within one flush gap of its own.
    h.queue.ingest([textFinal('a-text2', 'second part')]);
    h.update();
    h.advance(1_999); // t=3499: restarted bound (t=3500) has not fired
    expect(h.drains()).toBe(0);
    h.advance(2);
    expect(h.drains()).toBe(1);
    // The wait-expired settlement carries BOTH blocks, not just the first.
    const emitted = h.drainedTurns() as Array<{ turnId: string; assistantUuids: string[] }>;
    expect(emitted.map(t => [t.turnId, t.assistantUuids])).toEqual([
      ['om_first', ['a-text1', 'a-text2']],
    ]);
  });

  it('does not emit a zero-uuid completion when the first flushed block is thinking-only', () => {
    // Worst truncation shape: first block = thinking, text body flushes only
    // after the original bound. The old anchor fired with zero answer uuids
    // and the later body was synthesised into a suppressed local turn — the
    // user got an empty reply and the body vanished. Restarting on the bound
    // turn's new blocks settles WITH the body.
    const h = harness({ heldWorking: true });
    h.queue.mark('om_first', makeFingerprint('first prompt'), 100, 'first prompt', 1);
    h.queue.ingest([user('u1', 'first prompt'), thinkingOnly('a-think')]);
    h.update();
    h.advance(1_500);
    h.queue.ingest([textFinal('a-text', 'the real answer')]);
    h.update();
    h.advance(1_999); // t=3499: original t=2000 deadline passed, restarted one open
    expect(h.drains()).toBe(0);
    h.advance(2);
    const emitted = h.drainedTurns() as Array<{ turnId: string; assistantUuids: string[] }>;
    expect(emitted.map(t => [t.turnId, t.assistantUuids])).toEqual([
      ['om_first', ['a-text']],
    ]);
  });

  it('keeps the original bound when new records belong to a FOLLOWING turn, not the bound one', () => {
    // A type-ahead turn starting its tool call is activity for ANOTHER turn:
    // it must not buy the bound turn extra time (or silence the fallback).
    const h = harness({ heldWorking: true });
    h.queue.mark('A', makeFingerprint('first'), 100, 'first', 1);
    h.queue.ingest([user('u-a', 'first'), textFinal('a1')]);
    h.update();
    h.advance(1_500);
    h.queue.mark('B', makeFingerprint('second'), 200, 'second');
    h.queue.ingest([user('u-b', 'second'),
      { type: 'assistant', uuid: 'b-tool', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'tool_use' } }]);
    h.update();
    h.advance(499); // t=1999
    expect(h.drains()).toBe(0);
    h.advance(2); // t=2001: still the ORIGINAL bound — A settles, B is untouched
    const emitted = h.drainedTurns() as Array<{ turnId: string }>;
    expect(emitted.map(t => t.turnId)).toEqual(['A']);
    // B keeps running and later answers with its own attributed final.
    h.queue.ingest([textFinal('b-answer', 'B actual answer'),
      { type: 'system', subtype: 'turn_duration', uuid: 'd-b' }]);
    expect(h.queue.drainEmittable({ explicitTerminalOnly: true })
      .map(turn => [turn.turnId, turn.assistantUuids])).toEqual([['B', ['b-answer']]]);
  });

  it('re-arms the new head immediately when its bound turn already closed normally while armed', () => {
    // The bound turn closes at the NEXT turn's user boundary (no marker yet,
    // verdict still undecided) and the type-ahead B is already collecting its
    // own first block. The stale deadline bound to A must not hold B's window
    // to A's remainder: B gets a fresh bound anchored at its own ingest.
    const h = harness({ heldWorking: true });
    h.queue.mark('A', makeFingerprint('first'), 100, 'first', 1);
    h.queue.ingest([user('u-a', 'first'), textFinal('a1')]);
    h.update();
    h.advance(500);
    // B's user start boundary-closes A; B's first terminal block lands in the
    // same read, with the marker verdict for this transcript still undecided.
    h.queue.mark('B', makeFingerprint('second'), 200, 'second');
    h.queue.ingest([user('u-b', 'second'), textFinal('b-part1', 'B part 1')]);
    h.queue.drainEmittable({ terminalBoundary: true, requireExplicitTerminalForDurable: true }); // A out
    h.update(); // B is the fresh head: A's stale deadline is replaced now
    // B's window is anchored at its OWN block (t≈500), not A's arm (t=0):
    // with the stale deadline B would not fire until t≈4000; the fresh arm
    // fires right after t=2500.
    h.advance(1_999);
    expect(h.drains()).toBe(0);
    h.advance(2);
    expect((h.drainedTurns() as Array<{ turnId: string }>).map(t => t.turnId)).toEqual(['B']);
  });

  it('arms the next head fresh at the END of a fire that drained its bound turn', () => {
    // The fire's own bridgeIngest can discover the bound turn's follower:
    // B's user boundary-closes A and B's first terminal block is already on
    // disk. The fire drains only A (onlyTurn gate withholds B); without the
    // explicit end-of-fire re-arm B would then wait for a FUTURE ingest to
    // arm it — its bound skew by up to one window (and the fire's self-arm
    // against the pre-drain head was voided). B must leave the fire already
    // holding its own full window.
    const h = harness({ heldWorking: true });
    h.queue.mark('A', makeFingerprint('first'), 100, 'first', 1);
    h.queue.mark('B', makeFingerprint('second'), 200, 'second', 1);
    h.queue.ingest([user('u-a', 'first'), textFinal('a1')]);
    h.update();
    // A's fire discovers B's start + first block in one read.
    let pending: TranscriptEvent[] = [user('u-b', 'second'), textFinal('b-part1', 'B part 1')];
    h.scope.bridgeIngest = () => { h.queue.ingest(pending.splice(0)); };
    h.advance(2_001);
    const first = h.drainedTurns() as Array<{ turnId: string }>;
    expect(first.map(t => t.turnId)).toEqual(['A']); // only A emitted; B withheld
    // B is armed with a fresh full window WITHOUT another external update:
    // its deadline sits ~one full window after the fire (t≈4000), not at the
    // fire itself. Assert via the armed handle the harness already mirrors
    // and via B's fire time — no internal turn-binding reads.
    expect(h.scope.provisionalExitTimer).not.toBeNull();
    h.advance(1_998);
    expect(h.drains()).toBe(1); // B's own bound has not fired yet
    h.advance(3);
    expect((h.drainedTurns() as Array<{ turnId: string }>).map(t => t.turnId)).toEqual(['A', 'B']);
  });

  it('a waitExpired verdict learned before a rotation does not strip the new generation first turn', () => {
    // P3 from review: beyond the K3 structural guard, prove the generation
    // boundary end-to-end through the real helper — old writer learns
    // waitExpired, /clear-style rotation, new writer first turn stays fresh.
    const h = harness();
    h.queue.mark('old-A', makeFingerprint('first'), 100, 'first', 1);
    h.queue.ingest([user('u-a', 'first'), textFinal('a1')]);
    h.update();
    h.advance(2_001); // old-A settles: this CLI is marked waitExpired
    expect(h.drains()).toBe(1);
    const beginGeneration = loadWorkerFunction<() => void>('beginNewBridgeTranscriptGeneration', h.scope);
    h.scope.beginNewBridgeTranscriptGeneration = beginGeneration;
    beginGeneration();
    h.queue.mark('new-B', makeFingerprint('second'), 200, 'second', 1);
    h.queue.ingest([user('u-b', 'second'), thinkingOnly('b-think')]);
    expect(h.queue.isFreshHeadAwaitingMarker(h.queue.peek()[0])).toBe(true);
    expect(h.queue.drainEmittable({ explicitTerminalOnly: true })).toEqual([]);
  });

  it('voids an old deadline when the head turn completes before it fires', () => {
    const h = harness();
    h.queue.mark('A', makeFingerprint('first'), 100, 'first', 1);
    h.queue.mark('B', makeFingerprint('second'), 200, 'second', 1);
    h.queue.ingest([user('u-a', 'first'), textFinal('a1')]);
    h.update();
    // A finishes WITH its marker before the deadline (verdict becomes seen);
    // type-ahead B is already running a tool call.
    h.queue.ingest([{ type: 'system', subtype: 'turn_duration', uuid: 'd-a' },
      user('u-b', 'second'),
      { type: 'assistant', uuid: 'b-tool', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'tool_use' } }]);
    h.queue.drainEmittable({ explicitTerminalOnly: true });
    h.advance(2_001); // A's old deadline fires — must not touch B
    expect(h.drains()).toBe(0);
    // B closes normally with its own marker; the answer attributes to B.
    h.queue.ingest([textFinal('b-final', 'B actual answer'), { type: 'system', subtype: 'turn_duration', uuid: 'd-b' }]);
    const ready = h.queue.drainEmittable({ explicitTerminalOnly: true });
    expect(ready.map(turn => [turn.turnId, turn.isLocal, turn.assistantUuids])).toEqual([
      ['B', undefined, ['b-final']],
    ]);
  });

  it('does not settle a type-ahead B when its marker+start records arrive only inside the watchdog drain', () => {
    // The bound turn's verify happens AFTER a synchronous ingest: A's marker
    // and B's user/tool_use can be unread on disk when the timer fires. After
    // ingest A closes normally; B is a tool-running head with no terminal and
    // no dispatchAttempt. The watchdog must emit only A — a global
    // terminal-boundary drain would pop B empty and headless its answer.
    const h = harness({ screenShowsPrompt: false, heldWorking: true });
    h.queue.mark('A', makeFingerprint('first'), 100, 'first', 1);
    h.queue.mark('B', makeFingerprint('second'), 200, 'second');
    h.queue.ingest([user('u-a', 'first'), textFinal('a1')]);
    h.update();
    // Timer fires; ONLY now do A's marker and B's start reach the transcript.
    let pending: TranscriptEvent[] = [
      { type: 'system', subtype: 'turn_duration', uuid: 'd-a' },
      user('u-b', 'second'),
      { type: 'assistant', uuid: 'b-tool', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'tool_use' } },
    ];
    (h.scope.bridgeIngest as () => void) = () => { h.queue.ingest(pending.splice(0)); };
    h.advance(2_001);
    const emitted = h.drainedTurns() as Array<{ turnId: string }>;
    expect(emitted.map(t => t.turnId)).toEqual(['A']);
    // B then finishes with its own answer + marker and attributes to B.
    h.queue.ingest([textFinal('b-answer', 'B actual answer'), { type: 'system', subtype: 'turn_duration', uuid: 'd-b' }]);
    const late = h.queue.drainEmittable({ explicitTerminalOnly: true });
    expect(late.map(t => [t.turnId, t.isLocal, t.assistantUuids])).toEqual([
      ['B', undefined, ['b-answer']],
    ]);
  });

  it('voids an old deadline across a transcript generation change discovered INSIDE its own ingest', () => {
    // performRotationSwitch can run during the watchdog's own bridgeIngest:
    // the generation bumps while the SAME bound turn object is carried over.
    // The post-ingest re-check must void the deadline so it never records a
    // negative marker verdict into the new generation (which would strip the
    // new file's first-turn protection).
    const h = harness();
    const beginGeneration = loadWorkerFunction<() => void>('beginNewBridgeTranscriptGeneration', h.scope);
    h.scope.beginNewBridgeTranscriptGeneration = beginGeneration;
    h.queue.mark('A', makeFingerprint('first'), 100, 'first', 1);
    h.queue.ingest([user('u-a', 'first'), textFinal('a1')]);
    h.update();
    // The fire's ingest discovers a rotation: bump generation + reset, but A
    // (the same object) is carried onto the new file.
    // Rotate on the watchdog's ingest ONCE (the fire discovers it), then
    // behave like a normal empty-ingest on later fires.
    let rotated = false;
    h.scope.bridgeIngest = () => { if (!rotated) { rotated = true; beginGeneration(); } };
    h.advance(2_001);
    expect(h.drains()).toBe(0); // old deadline voided: no drain, no verdict
    expect((h.scope.bridgeTranscriptGeneration as number)).toBe(1);
    // The carried A got a FRESH window from reArm; it settles there with its
    // real text-bearing outcome, not a negative verdict learned by the old writer.
    h.advance(2_001);
    expect((h.drainedTurns() as Array<{ turnId: string }>).map(t => t.turnId)).toEqual(['A']);
    // New file's first turn B now heads the queue with full fresh protection.
    h.queue.mark('B', makeFingerprint('second'), 200, 'second', 1);
    h.queue.ingest([user('u-b', 'second'), thinkingOnly('b-think')]);
    expect(h.queue.drainEmittable({ explicitTerminalOnly: true })).toEqual([]);
    h.queue.ingest([textFinal('b-answer', 'B actual answer'),
      { type: 'system', subtype: 'turn_duration', uuid: 'd-b' }]);
    expect(h.queue.drainEmittable({ explicitTerminalOnly: true })
      .map(turn => [turn.turnId, turn.assistantUuids])).toEqual([['B', ['b-answer']]]);
  });

  it('an idle settle timeout on a carried head does not teach the new generation waitExpired', () => {
    // Shared by the PTY/Herdr idle settle's onTimeout: it must exclude a
    // carried turn the same way the watchdog does, otherwise the idle path
    // (which never touches updateProvisionalExitWatch) still taints the new
    // file's first-turn hold.
    const queue = new BridgeTurnQueue();
    queue.noteDurationMarkerObserved(); // old file proved marker-present
    queue.mark('old-A', makeFingerprint('first'), 100, 'first', 1);
    queue.ingest([user('u-a', 'first'), textFinal('a1')]);
    queue.markPendingTurnsCarriedAcrossGeneration();
    queue.resetDurationMarkerVerdicts(); // rotation: new generation undecided
    expect(queue.peek()[0].carriedAcrossGeneration).toBe(true);
    // Simulate an idle-settle onTimeout against the carried head.
    const noteExpired = loadWorkerFunction<() => void>('noteBridgeTurnCloseWaitExpired', {
      bridgeQueue: queue,
    });
    noteExpired();
    // The carried A is then released at the idle settle's terminal boundary
    // (its carried exception), but no negative verdict was learned.
    expect(queue.drainEmittable({ terminalBoundary: true, requireExplicitTerminalForDurable: true })
      .map(turn => turn.turnId)).toEqual(['old-A']);
    // A new file turn still gets the full hold (verdict was not learned).
    queue.mark('new-B', makeFingerprint('second'), 200, 'second', 1);
    queue.ingest([user('u-b', 'second'), thinkingOnly('b-think')]);
    expect(queue.isFreshHeadAwaitingMarker(queue.peek()[0])).toBe(true);
    expect(queue.drainEmittable({ explicitTerminalOnly: true })).toEqual([]);
  });

  it('does not tag an unstarted mark as carried; it binds live in the new file', () => {
    // A Lark mark queued BEFORE a /resume rotation but whose user record lands
    // in the NEW file belongs to the new writer. It must keep the new file's
    // normal hold even when that file's history proves marker-present.
    const queue = new BridgeTurnQueue();
    queue.mark('A', makeFingerprint('first'), 100, 'first', 1);
    queue.ingest([user('u-a', 'first'), textFinal('a1')]); // A started in old file
    queue.mark('B', makeFingerprint('second'), 200, 'second'); // B queued, not started
    queue.markPendingTurnsCarriedAcrossGeneration();
    queue.resetDurationMarkerVerdicts();
    queue.noteDurationMarkerObserved(); // new file already has marker history
    expect(queue.peek()[0].carriedAcrossGeneration).toBe(true); // A carried
    // A completes on the boundary (old writer's terminal exception); B follows.
    queue.drainEmittable({ terminalBoundary: true, requireExplicitTerminalForDurable: true });
    const b = queue.peek()[0];
    expect(b.turnId).toBe('B');
    expect(b.carriedAcrossGeneration).toBeUndefined(); // never tagged: unstarted
    // B binds its user event in the new file and keeps the marker-present hold:
    // a partial text record must NOT settle before the error/marker.
    queue.ingest([user('u-b', 'second'), textFinal('new-text', 'partial')]);
    expect(queue.drainEmittable({ explicitTerminalOnly: true })).toEqual([]);
    expect(queue.drainEmittable({ terminalBoundary: true, requireExplicitTerminalForDurable: true })).toEqual([]);
  });

  it('queue drain with onlyTurn stops before a following turn at every edge', () => {
    const queue = new BridgeTurnQueue();
    queue.mark('A', makeFingerprint('first'), 100, 'first', 1);
    queue.mark('B', makeFingerprint('second'), 200, 'second');
    queue.ingest([user('u-a', 'first'), textFinal('a1')]);
    queue.ingest([user('u-b', 'second'),
      { type: 'assistant', uuid: 'b-tool', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop_reason: 'tool_use' } }]);
    queue.drainEmittable({ explicitTerminalOnly: true }); // A out
    // B is head, tool-running, no terminal: even the terminal boundary must
    // not pop it once A is the gate identity (A is gone → gate fails on B).
    const afterA = queue.drainEmittable({
      terminalBoundary: true, requireExplicitTerminalForDurable: true,
      onlyTurn: { turnId: 'A', dispatchAttempt: 1 },
    });
    expect(afterA).toEqual([]);
    expect(queue.peek()[0].turnId).toBe('B');
  });

  it('voids an old deadline across a transcript generation change', () => {
    const h = harness();
    h.queue.mark('A', makeFingerprint('first'), 100, 'first', 1);
    h.queue.ingest([user('u-a', 'first'), thinkingOnly('a-think')]);
    h.update();
    // /clear-style rotation: new generation, reset verdicts.
    (h.scope.bridgeTranscriptGeneration as number)++;
    h.queue.resetDurationMarkerVerdicts();
    h.queue.mark('B', makeFingerprint('second'), 200, 'second', 1);
    h.queue.ingest([user('u-b', 'second'), thinkingOnly('b-think')]);
    h.advance(2_001);
    expect(h.drains()).toBe(0); // old timer was generation-bound
  });

  it('never arms while an idle settle is in flight', () => {
    const h = harness();
    h.scope.idleTranscriptSettleInFlight = true;
    h.queue.mark('om_first', makeFingerprint('first prompt'), 100, 'first prompt', 1);
    h.queue.ingest([user('u1', 'first prompt'), textFinal('a1')]);
    h.update();
    expect(h.scope.provisionalExitTimer).toBeNull();
  });

  it('does not taint the live verdict when the waiting head is journal-restored', () => {
    const h = harness();
    h.queue.mark('recovered', makeFingerprint('recovered prompt'), 100, 'recovered prompt', 1, { restoredFromJournal: true });
    h.queue.ingest([user('rec-u', 'recovered prompt'), textFinal('rec-text', 'partial recovered')]);
    h.update();
    h.advance(2_001);
    expect(h.drains()).toBe(1);
    h.queue.mark('live-next', makeFingerprint('next prompt after recovery'), 200, 'next prompt after recovery', 1);
    h.queue.ingest([user('live-u', 'next prompt after recovery'), thinkingOnly('live-think')]);
    expect(h.queue.isFreshHeadAwaitingMarker(h.queue.peek()[0])).toBe(true);
    expect(h.queue.drainEmittable({ explicitTerminalOnly: true })).toEqual([]);
  });

  it('releases a journal-restored head at an idle/terminal boundary without teaching absent', () => {
    const queue = new BridgeTurnQueue();
    queue.mark('recovered', makeFingerprint('recovered prompt'), 100, 'recovered prompt', 1, { restoredFromJournal: true });
    queue.ingest([user('rec-u', 'recovered prompt'), textFinal('rec-text', 'partial recovered')]);
    expect(queue.drainEmittable({ explicitTerminalOnly: true })).toEqual([]);
    expect(queue.drainEmittable({ terminalBoundary: true, requireExplicitTerminalForDurable: true })
      .map(turn => turn.turnId)).toEqual(['recovered']);
    queue.mark('live-next', makeFingerprint('next prompt after recovery'), 200, 'next prompt after recovery', 1);
    queue.ingest([user('live-u', 'next prompt after recovery'), thinkingOnly('live-think')]);
    expect(queue.drainEmittable({ explicitTerminalOnly: true })).toEqual([]);
  });
});

// 源码结构护栏(K3)：marker 能力的负结论只能活在一个 writer/transcript
// 世代内；无 idle 边的看门狗必须与 idle settle 互斥。漏掉任一接线，旧
// writer 的 absent 会让新会话首轮在 thinking 记录上空结算、丢掉正文，或
// 看门狗抢先于 idle settle 发出错误 completed。
describe('marker verdict lifecycle wiring guard', () => {
  it('resets verdicts at teardown, watcher start, and both transcript switches', () => {
    const workerSrc = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    // Four boundaries route through the single generation-boundary helper.
    expect(workerSrc.match(/beginNewBridgeTranscriptGeneration\(\);/g)).toHaveLength(4);
    // The helper disarms the old watchdog, tags carried turns, bumps the
    // generation and resets verdicts.
    expect(workerSrc).toMatch(/function beginNewBridgeTranscriptGeneration\(\): void \{\s*\n\s*disarmProvisionalExitWatch\(\);[\s\S]{0,300}?bridgeQueue\.markPendingTurnsCarriedAcrossGeneration\(\);\s*\n\s*bridgeTranscriptGeneration\+\+;\s*\n\s*bridgeQueue\.resetDurationMarkerVerdicts\(\);/);
  });

  it('disarms the watchdog when an idle settle is requested, and clears it at teardown', () => {
    const workerSrc = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    // The settle factory disarms the watchdog at the top of request().
    expect(workerSrc).toMatch(/request: \(proceed: \(\) => void\): void => \{\s*\n\s*disarmProvisionalExitWatch\(\);/);
    // Stand-down distinguishes the idle quiescence window from a held
    // `working` composer: held working overrides the visible prompt so the
    // liveness fallback still fires.
    expect(workerSrc).toMatch(/programStatusHeldWorking\(\) === true/);
    expect(workerSrc).toMatch(/!\s*heldWorking \s*&& idleDetector\?\.screenShowsPrompt\(\) === true/);
    // The deadline is bound to its turn object and transcript generation.
    expect(workerSrc).toMatch(/boundGeneration !== bridgeTranscriptGeneration/);
    expect(workerSrc).toMatch(/current !== boundTurn/);
    // Generation boundaries (teardown/start/switches) disarm the old timer.
    expect(workerSrc).toMatch(/function beginNewBridgeTranscriptGeneration[\s\S]{0,200}?disarmProvisionalExitWatch\(\);/);
  });

  it('arms ONLY from the tail of bridgeIngest — the sole production entry — and never for adopt/local turns', () => {
    // Every behavior test above calls updateProvisionalExitWatch directly;
    // none goes through bridgeIngest. Deleting this production call therefore
    // went fully green while the no-idle fallback silently stopped existing
    // (a fresh first turn hangs forever again). Pin the adjacency of the
    // queue ingest and the arming call.
    const workerSrc = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    expect(workerSrc).toMatch(
      /bridgeQueue\.ingest\(result\.events, bridgeJsonlPath, observeThinkingAttribution\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*updateProvisionalExitWatch\(\);/,
    );
    // Fallback scope is the Claude non-adopt transcript bridge only: adopt
    // sessions and headless local turns are timed out by other paths.
    expect(workerSrc).toMatch(/if \(!bridgeJsonlPath \|\| lastInitConfig\?\.adoptMode\) return;/);
    expect(workerSrc).toMatch(/if \(!head \|\| head\.isLocal \|\| !bridgeQueue\.isFreshHeadAwaitingMarker\(head\)\) return;/);
    // The bound restarts only on the bound turn's own new activity.
    expect(workerSrc).toMatch(/provisionalExitBoundTurn === head/);
  });
});
