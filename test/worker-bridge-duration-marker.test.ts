/**
 * Worker wiring around the bridge queue's duration-marker hold, executed as
 * the real worker functions (test/helpers/worker-function-harness.ts):
 *   - the non-adopt baseline skips history without parsing it, so it must seed
 *     the queue from the transcript tail — or the first turn after every
 *     restart is settled on a block-level stop_reason again;
 *   - the Herdr idle settle keeps waiting while the head turn is held;
 *   - when the CLI generation ends, a held turn is settled instead of being
 *     lost: the pre-interrupt drain lets its terminal beat `cli_exit`, and the
 *     watcher teardown emits it before clearing the queue.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeTurnQueue, makeFingerprint } from '../src/services/bridge-turn-queue.js';
import { BridgeBlindTurnWatch } from '../src/services/claude-bridge-blind-turn.js';
import { localTurnFailureNotice } from '../src/services/local-turn-failure.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { t } from '../src/i18n/index.js';
import { transcriptShowsTurnDurationMarker, type TranscriptEvent } from '../src/services/claude-transcript.js';
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

  it('keeps settling on the stop_reason when the history shows none', () => {
    appendFileSync(path, `${JSON.stringify({ type: 'user', uuid: 'old-u', message: { role: 'user', content: 'hi' } })}\n`);
    const queue = new BridgeTurnQueue();
    baselineInto(queue);
    queue.mark('om_turn', makeFingerprint('next prompt'), 100, 'next prompt', 1);
    queue.ingest([user('u1', 'next prompt'), thinkingFinal('a1')]);
    expect(queue.drainEmittable({ explicitTerminalOnly: true }).map(turn => turn.turnId)).toEqual(['om_turn']);
  });
});

describe('worker bridgeHeadTurnAwaitingTerminal (Herdr idle settle)', () => {
  it('keeps waiting while the head turn is held for its duration marker', () => {
    const queue = new BridgeTurnQueue();
    queue.noteDurationMarkerObserved();
    const awaiting = loadWorkerFunction<() => boolean>('bridgeHeadTurnAwaitingTerminal', {
      bridgeJsonlPath: path,
      lastInitConfig: { cliId: 'claude-code' },
      bridgeIngest: () => {},
      bridgeQueue: queue,
    });
    queue.mark('om_turn', makeFingerprint('next prompt'), 100, 'next prompt', 1);
    queue.ingest([user('u1', 'next prompt'), thinkingFinal('a1')]);
    expect(awaiting()).toBe(true);
    queue.ingest([{ type: 'system', subtype: 'turn_duration', uuid: 'd1' }]);
    expect(awaiting()).toBe(false);
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
