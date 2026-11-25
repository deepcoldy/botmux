/**
 * Worker-wiring regression tests for Claude open-turn lifecycle hold, bounded
 * fallback, Scenario 3B dedup/ground-truth emission, multi-settle tracking,
 * and post-settlement redrive safety (#3702).
 *
 * Exercises the real functions extracted from `src/worker.ts` via
 * `loadWorkerFunction` with deterministic fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeTurnQueue, makeFingerprint } from '../src/services/bridge-turn-queue.js';
import {
  CLAUDE_AWAITING_MARKER_REDRIVE_SAFETY_MS,
  CLAUDE_OPEN_TURN_POLL_MS,
  ClaudeOpenTurnWatchdog,
} from '../src/services/claude-open-turn-watchdog.js';
import {
  attributableBridgeReplyMarkers,
  bridgeGateInputForTurn,
  bridgePostText,
  finalBridgeSendMarkerCoversOwnThread,
  hasTrailingBridgeSentinelLine,
  isBridgeNothingToSendFinal,
  isFinalBridgeSendMarker,
  shouldSuppressBridgeEmit,
  type BridgeSendMarker,
} from '../src/services/bridge-fallback-gate.js';
import {
  drainTranscript,
  isClaudeMemoryToolUse,
  joinAssistantText,
  trailingAssistantText,
  type TranscriptEvent,
} from '../src/services/claude-transcript.js';
import { createTranscriptTerminalSettle, type TranscriptTerminalSettle } from '../src/services/transcript-terminal-settle.js';
import { SessionController } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { WrittenInputLedger } from '../src/services/prompt-submission-match.js';
import { fingerprintPromptText } from '../src/services/prompt-context-store.js';

const mkUser = (uuid: string, content: string): TranscriptEvent => ({
  type: 'user',
  uuid,
  parentUuid: null,
  timestamp: new Date().toISOString(),
  message: { role: 'user', content },
});

const mkAssistant = (uuid: string, parentUuid: string, text: string, stopReason: string | null = 'end_turn'): TranscriptEvent => ({
  type: 'assistant',
  uuid,
  parentUuid,
  timestamp: new Date().toISOString(),
  message: { role: 'assistant', model: 'claude-test', stop_reason: stopReason, content: [{ type: 'text', text }] },
});

const mkDuration = (uuid: string, parentUuid: string): TranscriptEvent => ({
  type: 'system',
  subtype: 'turn_duration',
  uuid,
  parentUuid,
  timestamp: new Date().toISOString(),
});

function createWatchdogWiring(opts: {
  bareQuietMs?: number;
  inflightQuietMs?: number;
  userStopQuietMs?: number;
  markers?: BridgeSendMarker[];
  cliAlive?: boolean;
  programStatusHeldBusy?: boolean;
  bridgeIngestFn?: () => void;
} = {}) {
  const queue = new BridgeTurnQueue();
  const watchdog = new ClaudeOpenTurnWatchdog({
    bareQuietMs: opts.bareQuietMs ?? 3_000,
    inflightQuietMs: opts.inflightQuietMs ?? 10_000,
    userStopQuietMs: opts.userStopQuietMs ?? 1_500,
  });
  let cliAlive = opts.cliAlive ?? true;
  let programStatusHeldBusy = opts.programStatusHeldBusy ?? false;
  let redrives = 0;
  const released: Array<{ turnId: string; source: string }> = [];
  const emitted: Array<{ opts: unknown }> = [];
  const backend = { id: 'be-1' };

  const scope: Record<string, unknown> = {
    bridgeJsonlPath: '/tmp/claude-session.jsonl',
    lastInitConfig: { cliId: 'claude-code', chatId: 'oc_chat', rootMessageId: 'om_root', adoptMode: false },
    sessionId: 'sess-1',
    bridgeQueue: queue,
    bridgeTranscriptGeneration: 1,
    cliSpawnGeneration: 1,
    backend,
    isPromptReady: false,
    idleTranscriptSettleInFlight: false,
    claudeOpenTurnWatchdog: watchdog,
    claudeOpenTurnWatchdogTimer: null,
    claudeAwaitingMarkerSafetyTimer: null,
    claudeUserPromptSubmittedTurnId: undefined,
    currentBotmuxTurnId: undefined,
    currentBotmuxDispatchAttempt: undefined,
    CLAUDE_OPEN_TURN_POLL_MS,
    CLAUDE_AWAITING_MARKER_REDRIVE_SAFETY_MS,
    ptyOutputGeneration: { snapshot: () => 1 },
    backendScreenRevision: 1,
    cliAdapter: { readyPattern: /❯/, busyPattern: /esc to interrupt/ },
    backendScreenEvidenceIsAuthoritativeForMutation: () => false,
    captureBackendScreen: () => '',
    backgroundTaskTracker: { pendingTurnAgents: () => 0 },
    idleDetector: {
      reset: vi.fn(),
      fireIdle: vi.fn(() => { redrives++; }),
      isIdleNow: () => false,
      programStatusHeldBusy: () => programStatusHeldBusy,
    },
    busyReadyLogThrottle: { shouldLog: () => true },
    cliProcessAliveFromBackend: () => cliAlive,
    readSendMarkers: () => opts.markers ?? [],
    zeroPromptTerminalSync: () => false,
    attributableExplicitReplyMarkersForTurnWindow: (
      turnId: string,
      gateInput: Parameters<typeof attributableBridgeReplyMarkers>[0],
      nextBoundaryMs: number | undefined,
      markers: readonly BridgeSendMarker[],
    ) => attributableBridgeReplyMarkers({ ...gateInput, turnId }, nextBoundaryMs, markers),
    finalBridgeSendMarkerCoversOwnThread,
    isFinalBridgeSendMarker,
    log: () => {},
    markPromptReady: vi.fn(() => { redrives++; }),
    hasStructuredLifecycleBlock: () => false,
    bridgeIngest: () => {
      if (opts.bridgeIngestFn) opts.bridgeIngestFn();
      (scope.reconcileClaudeOpenTurnWatchdogAfterIngest as () => void)();
    },
    emitReadyTurns: (emitOpts: { explicitTerminalOnly?: boolean; releaseHeldTerminals?: boolean; onlyTurn?: { turnId: string; dispatchAttempt?: number } }) => {
      emitted.push({ opts: emitOpts });
      queue.drainEmittable(emitOpts?.explicitTerminalOnly
        ? { explicitTerminalOnly: true, releaseHeldTerminals: emitOpts.releaseHeldTerminals, onlyTurn: emitOpts.onlyTurn }
        : { terminalBoundary: true, requireExplicitTerminalForDurable: true, releaseHeldTerminals: emitOpts?.releaseHeldTerminals, onlyTurn: emitOpts?.onlyTurn });
    },
  };

  for (const name of [
    'clearSubmittedClaudeTurnIf',
    'hasSubmittedUnstartedClaudeHead',
    'openClaudeLifecycleTurn',
    'claudeOpenTurnKey',
    'stopClaudeOpenTurnWatchdogTimers',
    'disarmClaudeOpenTurnWatchdog',
    'noteClaudeOpenTurnUserStop',
    'captureClaudeOpenTurnObservation',
    'openClaudeTurnHasExplicitFinalSend',
    'fireClaudeRedriveEdge',
    'maybeHoldOpenClaudeTurn',
    'reconcileClaudeOpenTurnWatchdogAfterIngest',
    'bridgeHeadTurnAwaitingTerminal',
  ]) {
    scope[name] = loadWorkerFunction(name, scope);
  }

  return {
    scope,
    queue,
    watchdog,
    backend,
    released,
    emitted,
    redrives: () => redrives,
    setCliAlive: (v: boolean) => { cliAlive = v; },
    setProgramStatusHeldBusy: (v: boolean) => { programStatusHeldBusy = v; },
    hold: (source = 'screen') =>
      (scope.maybeHoldOpenClaudeTurn as (s: string, be: unknown, cb: (t: any, src: string) => void) => boolean)(
        source,
        backend,
        (t, src) => { released.push({ turnId: t.turnId, source: src }); },
      ),
    reconcile: () => (scope.reconcileClaudeOpenTurnWatchdogAfterIngest as () => void)(),
    disarm: () => (scope.disarmClaudeOpenTurnWatchdog as () => void)(),
  };
}

describe('worker Claude open-turn wiring regressions (#3702 adversarial fixes)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('Finding 1: does NOT fire redrive when a scheduled, local, or CLI-queued successor turn is active at head', () => {
    const h = createWatchdogWiring();
    h.queue.mark('om_1', makeFingerprint('first im'), 100, 'first im');
    h.queue.ingest([mkUser('u1', 'first im')], '/t/s.jsonl');
    expect(h.hold('screen')).toBe(true);

    // CronCreate scheduled turn opens and closes om_1 via HOL drop/boundary.
    h.queue.ingest([{
      type: 'user', uuid: 'sf1', isMeta: true, turnOrigin: 'scheduled', scheduledFireId: 'fire_1',
      timestamp: new Date().toISOString(), message: { role: 'user', content: 'cron job' },
    }], '/t/s.jsonl');
    h.reconcile();
    expect(h.watchdog.isActive()).toBe(false);
    expect(h.redrives()).toBe(0);
    // Scheduled turn remains untouched at head!
    expect(h.queue.peek()[0]?.turnId).toBe('scheduled-fire_1');
  });

  it('Finding 3: durationMarkerSeen=true + missing turn_duration settles non-durable turn BEFORE redriving (no split-brain), and never arms release timer for durable turns', () => {
    // Non-durable turn
    {
      const h = createWatchdogWiring();
      h.queue.noteDurationMarkerObserved();
      h.queue.mark('om_nd', makeFingerprint('non durable'), 100, 'non durable');
      h.queue.ingest([mkUser('u1', 'non durable')], '/t/s.jsonl');
      expect(h.hold('screen')).toBe(true);

      // end_turn arrives without turn_duration
      h.queue.ingest([mkAssistant('a1', 'u1', 'Answer text', 'end_turn')], '/t/s.jsonl');
      h.reconcile();
      expect(h.watchdog.getPhase()).toBe('awaiting-marker-redrive');
      expect(h.redrives()).toBe(0);

      // After safety timer expires, emits the held turn FIRST (releaseHeldTerminals:true), then redrives.
      vi.advanceTimersByTime(CLAUDE_AWAITING_MARKER_REDRIVE_SAFETY_MS + 100);
      expect(h.emitted).toEqual([
        expect.objectContaining({
          opts: expect.objectContaining({
            releaseHeldTerminals: true,
            onlyTurn: { turnId: 'om_nd', dispatchAttempt: undefined },
          }),
        }),
      ]);
      expect(h.queue.peek()).toEqual([]);
      expect(h.watchdog.isActive()).toBe(false);
      expect(h.redrives()).toBe(1);
    }

    // Durable turn: must NOT arm 6s release timer or redrive while awaiting turn_duration
    {
      const h = createWatchdogWiring();
      h.queue.noteDurationMarkerObserved();
      h.queue.mark('om_dur', makeFingerprint('durable'), 100, 'durable', 1);
      h.queue.ingest([mkUser('u1', 'durable')], '/t/s.jsonl');
      expect(h.hold('screen')).toBe(true);
      h.queue.ingest([mkAssistant('a1', 'u1', 'Durable answer', 'end_turn')], '/t/s.jsonl');
      h.reconcile();
      vi.advanceTimersByTime(CLAUDE_AWAITING_MARKER_REDRIVE_SAFETY_MS * 3);
      expect(h.emitted).toEqual([]);
      expect(h.redrives()).toBe(0);
      expect(h.queue.peek()[0]?.turnId).toBe('om_dur');
      h.disarm();
    }
  });

  it('Finding 9: cliAlive=false preserves savedEvidenceSource and still redrives if closing records land during pre-settlement ingest', () => {
    let injectClosing = false;
    const h = createWatchdogWiring({
      bridgeIngestFn: () => {
        if (injectClosing) {
          h.queue.ingest([mkAssistant('a1', 'u1', 'Final before exit', 'end_turn'), mkDuration('d1', 'a1')], '/t/s.jsonl');
          h.queue.drainEmittable({ explicitTerminalOnly: true });
        }
      },
    });
    h.queue.mark('om_dead', makeFingerprint('exiting turn'), 100, 'exiting turn');
    h.queue.ingest([mkUser('u1', 'exiting turn')], '/t/s.jsonl');
    expect(h.hold('herdr-done')).toBe(true);

    // Sub-case A: closing records arrive on the pre-settlement ingest -> redrive fires!
    injectClosing = true;
    h.setCliAlive(false);
    vi.advanceTimersByTime(CLAUDE_OPEN_TURN_POLL_MS);
    expect(h.redrives()).toBe(1);
    expect(h.released).toEqual([]);

    // Sub-case B: no closing records -> onBoundedRelease receives preserved 'herdr-done' source
    const h2 = createWatchdogWiring();
    h2.queue.mark('om_dead2', makeFingerprint('exiting silent'), 100, 'exiting silent');
    h2.queue.ingest([mkUser('u2', 'exiting silent')], '/t/s.jsonl');
    expect(h2.hold('herdr-done')).toBe(true);
    h2.setCliAlive(false);
    vi.advanceTimersByTime(CLAUDE_OPEN_TURN_POLL_MS);
    expect(h2.released).toEqual([{ turnId: 'om_dead2', source: 'herdr-done' }]);
  });

  it('Finding 13: persistent bridgeIngest failures during release retry twice and still release on the 3rd tick', () => {
    let calls = 0;
    const h = createWatchdogWiring({
      bareQuietMs: 2_000,
      bridgeIngestFn: () => { calls++; throw new Error('ENOENT'); },
    });
    h.queue.mark('om_err', makeFingerprint('missing file'), 100, 'missing file');
    h.queue.ingest([mkUser('u1', 'missing file')], '/t/s.jsonl');
    expect(h.hold('screen')).toBe(true);

    vi.advanceTimersByTime(2_000); // 1st failure (t=2s)
    expect(calls).toBe(1);
    expect(h.released).toEqual([]);
    vi.advanceTimersByTime(1_000); // 2nd failure (t=3s)
    expect(calls).toBe(2);
    expect(h.released).toEqual([]);
    vi.advanceTimersByTime(1_000); // 3rd failure (t=4s) -> bounded release proceeds!
    expect(calls).toBe(3);
    expect(h.released).toEqual([{ turnId: 'om_err', source: 'screen' }]);
  });

  it('Finding 14: UserPromptSubmit pre-start hold protects an unstarted head turn before u1 lands in JSONL', () => {
    const h = createWatchdogWiring({ bareQuietMs: 3_000 });
    h.queue.mark('om_slow_u1', makeFingerprint('slow user row'), 100, 'slow user row');
    // Without UserPromptSubmit, unstarted head does NOT hold (dropped Enter must not block).
    expect((h.scope.openClaudeLifecycleTurn as () => unknown)()).toBeUndefined();
    expect((h.scope.bridgeHeadTurnAwaitingTerminal as (o: { startedOnly: boolean }) => boolean)({ startedOnly: true })).toBe(false);

    // Once UserPromptSubmit confirms delivery, the unstarted head IS held cleanly.
    h.scope.claudeUserPromptSubmittedTurnId = 'om_slow_u1';
    expect((h.scope.openClaudeLifecycleTurn as () => { turnId: string } | undefined)()?.turnId).toBe('om_slow_u1');
    expect((h.scope.bridgeHeadTurnAwaitingTerminal as (o: { startedOnly: boolean }) => boolean)({ startedOnly: true })).toBe(true);
    expect(h.hold('screen')).toBe(true);
    h.disarm();
  });

  it('Finding 14b: durable retry hooks prove only their own dispatchAttempt', async () => {
    const h = createWatchdogWiring({ bareQuietMs: 3_000 });
    const content = 'same durable payload';
    const ledger = new WrittenInputLedger();
    ledger.noteWritten('om_retry', content, 1);
    ledger.noteWritten('om_retry', content, 2);
    h.queue.mark('om_retry', makeFingerprint(content), 100, content, 2);
    const sent: any[] = [];
    Object.assign(h.scope, {
      writtenInputs: ledger,
      send: (msg: unknown) => { sent.push(msg); },
      revokePromptReadiness: vi.fn(),
      publishScreenStatus: vi.fn(),
      inFlightKeepaliveFingerprints: new Map(),
      isPromptReady: false,
    });
    const handler = loadWorkerMessageHandler('prompt_submitted', h.scope);

    await handler({ type: 'prompt_submitted', fingerprint: fingerprintPromptText(content) });
    expect((h.scope.openClaudeLifecycleTurn as () => unknown)()).toBeUndefined();

    await handler({ type: 'prompt_submitted', fingerprint: fingerprintPromptText(content) });
    expect((h.scope.openClaudeLifecycleTurn as () => { turnId: string; dispatchAttempt?: number } | undefined)())
      .toMatchObject({ turnId: 'om_retry', dispatchAttempt: 2 });
    expect(sent.filter(msg => msg.type === 'prompt_submitted_input')).toEqual([
      { type: 'prompt_submitted_input', turnId: 'om_retry', dispatchAttempt: 1 },
      { type: 'prompt_submitted_input', turnId: 'om_retry', dispatchAttempt: 2 },
    ]);
    h.disarm();
  });

  it('Scenario 3 re-attachment starts a fresh bounded open-turn episode', () => {
    for (const resultFirst of [false, true]) {
      const h = createWatchdogWiring();
      h.queue.mark('om_reopen', makeFingerprint('reopen'), 100, 'reopen');
      h.queue.ingest([
        mkUser('u1', 'reopen'),
        mkAssistant('a_nar', 'u1', 'working', null),
        {
          ...mkAssistant('a_tool', 'a_nar', '', 'tool_use'),
          message: {
            role: 'assistant', model: 'claude-test', stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }],
          },
        },
      ], '/t/s.jsonl');
      expect(h.hold('screen')).toBe(true);
      h.disarm();
      h.queue.drainEmittable({ terminalBoundary: true, requireExplicitTerminalForDurable: true });
      if (resultFirst) {
        h.queue.ingest([{
          type: 'user', uuid: 'tr1', parentUuid: 'a_tool', timestamp: new Date().toISOString(),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
        }], '/t/s.jsonl');
      }
      h.queue.ingest([
        mkAssistant('a_late', resultFirst ? 'tr1' : 'a_tool', 'still working', null),
      ], '/t/s.jsonl');

      expect(h.hold('screen')).toBe(true);
      h.disarm();
    }
  });

  it('Finding 17: openClaudeTurnHasExplicitFinalSend ignores cross-chat detoured_send and terminalIndependent markers', () => {
    const now = Date.now();
    const h = createWatchdogWiring({
      markers: [
        { sentAtMs: now, sessionId: 'sess-1', turnId: 'om_m', deliveryKind: 'detoured_send', targetChatId: 'oc_OTHER', responseKind: 'final' },
        { sentAtMs: now, sessionId: 'sess-1', turnId: 'om_m', deliveryKind: 'current_session_send', responseKind: 'final', terminalIndependent: true },
      ],
    });
    h.queue.mark('om_m', makeFingerprint('my task'), now - 100, 'my task');
    h.queue.ingest([mkUser('u1', 'my task')], '/t/s.jsonl');
    const head = h.queue.peek()[0]!;
    expect((h.scope.openClaudeTurnHasExplicitFinalSend as (t: unknown) => boolean)(head)).toBe(false);
    expect(h.hold('screen')).toBe(true);
    h.disarm();
  });

  it('Finding 12: multi-settle tracking keeps idleTranscriptSettleInFlight true until EVERY active settle finishes/cancels', () => {
    const scope: Record<string, unknown> = {
      activeIdleTranscriptSettles: new Set<TranscriptTerminalSettle>(),
      registeredIdleTranscriptSettles: new Set<TranscriptTerminalSettle>(),
      idleTranscriptSettleInFlight: false,
      disarmProvisionalExitWatch: vi.fn(),
      createTranscriptTerminalSettle,
    };
    const makeSettle = loadWorkerFunction<
      (awaiting: () => boolean, onTimeout?: () => void) => TranscriptTerminalSettle
    >('makeBridgeTranscriptSettle', scope);
    const cancelAll = loadWorkerFunction<() => void>('cancelAllIdleTranscriptSettles', scope);

    const pty = makeSettle(() => true);
    const herdr = makeSettle(() => true);
    const ptyProceed = vi.fn();
    const herdrProceed = vi.fn();

    pty.request(ptyProceed);
    herdr.request(herdrProceed);
    expect(scope.idleTranscriptSettleInFlight).toBe(true);

    // Cancelling only herdr must NOT clear idleTranscriptSettleInFlight while pty is still polling.
    herdr.cancel();
    expect(scope.idleTranscriptSettleInFlight).toBe(true);

    // cancelAll cancels every registered settle cleanly.
    cancelAll();
    expect(scope.idleTranscriptSettleInFlight).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(ptyProceed).not.toHaveBeenCalled();
    expect(herdrProceed).not.toHaveBeenCalled();
  });

  it('Findings 4 & 6: emitReadyTurns deduplicates Scenario 3B late-recovery against originating om_* send markers and reconciles ground-truth emission', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bmx-emit-3b-'));
    try {
      const jsonl = join(dir, 's.jsonl');
      const now = Date.now();
      const rows: TranscriptEvent[] = [
        mkUser('u1', 'do task'),
        mkAssistant('a_part', 'u1', 'Partial note', null),
      ];
      writeFileSync(jsonl, rows.map(r => `${JSON.stringify(r)}\n`).join(''));

      const queue = new BridgeTurnQueue();
      queue.mark('om_orig', makeFingerprint('do task'), now - 1_000, 'do task');
      queue.ingest(rows, jsonl);

      const markers: BridgeSendMarker[] = [];
      const notifiedExplicitReplyTurnIds: string[] = [];
      const sent: unknown[] = [];
      const terminals: unknown[] = [];

      const scope: Record<string, unknown> = {
        bridgeQueue: queue,
        bridgeJsonlPath: jsonl,
        sessionId: 'sess-1',
        lastInitConfig: { cliId: 'claude-code', chatId: 'oc_c', rootMessageId: 'om_r', adoptMode: false },
        workerFinalOutputHandoff: null,
        finalHandoffAdmissionEnabled: false,
        universalOutputHandoff: null,
        journalBridgeTurnClear: () => {},
        bridgeFingerprintScanLastMs: new Map(),
        readSendMarkers: () => markers,
        rememberTurnLinkRefMode: () => {},
        zeroPromptTerminalSync: () => false,
        replyDeliveryMode: () => 'send' as const,
        shouldSuppressBridgeEmit,
        attributableExplicitReplyMarkersForTurnWindow: (
          turnId: string,
          gateInput: Parameters<typeof attributableBridgeReplyMarkers>[0],
          nextBoundaryMs: number | undefined,
          ms: readonly BridgeSendMarker[],
        ) => attributableBridgeReplyMarkers({ ...gateInput, turnId }, nextBoundaryMs, ms),
        isFinalBridgeSendMarker,
        notifyExplicitRepliesObserved: (turnId: string, observed: readonly unknown[]) => {
          if (observed.length > 0) notifiedExplicitReplyTurnIds.push(turnId);
        },
        drainTranscript,
        followUpReplyEnabled: () => false,
        joinAssistantText,
        trailingAssistantText,
        isClaudeMemoryToolUse,
        hasTrailingBridgeSentinelLine,
        bridgeGateInputForTurn,
        usageLimitTracker: { noteTurnCompleted: () => {} },
        isBridgeNothingToSendFinal,
        bridgePostText,
        send: (msg: unknown) => { sent.push(msg); },
        emitTurnTerminal: (...args: unknown[]) => { terminals.push(args); },
        log: () => {},
      };

      const emitReadyTurns = loadWorkerFunction<(opts?: { explicitTerminalOnly?: boolean }) => void>('emitReadyTurns', scope);

      // Pop unobserved: emits Partial note -> hadTrailingVisibleText confirmed true (Sub-case 3B).
      emitReadyTurns({});
      expect(sent).toHaveLength(1);
      expect(terminals).toHaveLength(1);

      // Now model explicitly sent final via `botmux send --response-kind final` under `om_orig`!
      markers.push({
        sentAtMs: now + 500,
        sessionId: 'sess-1',
        turnId: 'om_orig',
        deliveryKind: 'current_session_send',
        responseKind: 'final',
      });

      // Late assistant summary arrives -> mints `late-recovery-a_late` with `replyAnchorTurnId: 'om_orig'`.
      const lateRows: TranscriptEvent[] = [
        mkAssistant('a_late', 'a_part', 'All done, already sent above.', 'end_turn'),
        mkDuration('d_late', 'a_late'),
      ];
      writeFileSync(jsonl, [...rows, ...lateRows].map(r => `${JSON.stringify(r)}\n`).join(''));
      queue.ingest(lateRows, jsonl);

      // emitReadyTurns MUST evaluate send markers against `om_orig` and SUPPRESS duplicate!
      emitReadyTurns({ explicitTerminalOnly: true });
      expect(sent).toHaveLength(1); // zero duplicate post!
      expect(terminals).toHaveLength(1); // zero duplicate terminal!
      expect(notifiedExplicitReplyTurnIds).toEqual(['om_orig']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hasStructuredLifecycleBlock locks markPromptReady / authority whenever a Claude open turn is active', () => {
    const queue = new BridgeTurnQueue();
    queue.mark('om_lock', makeFingerprint('active work'), 100, 'active work');
    queue.ingest([mkUser('u1', 'active work')], '/t/s.jsonl');
    const scope: Record<string, unknown> = {
      traexQuotaPending: undefined,
      bridgeJsonlPath: '/t/s.jsonl',
      lastInitConfig: { cliId: 'claude-code', adoptMode: false },
      bridgeQueue: queue,
      claudeUserPromptSubmittedTurnId: undefined,
      rpcTurnsAwaitingActivation: new Set(),
      rpcLifecycleFailClosedOwners: new Set(),
      rpcTerminalHydrationOwners: new Set(),
      codexBridgeQueue: { peek: () => [], hasBlockingTurn: () => false },
      isStructuredBridgeLifecycleBlockingCli: () => false,
    };
    scope.hasSubmittedUnstartedClaudeHead = loadWorkerFunction('hasSubmittedUnstartedClaudeHead', scope);
    scope.openClaudeLifecycleTurn = loadWorkerFunction('openClaudeLifecycleTurn', scope);
    const hasBlock = loadWorkerFunction<() => boolean>('hasStructuredLifecycleBlock', scope);
    expect(hasBlock()).toBe(true);
    queue.ingest([mkAssistant('a1', 'u1', 'done', 'end_turn'), mkDuration('d1', 'a1')], '/t/s.jsonl');
    expect(hasBlock()).toBe(false);
  });

  it('Finding 16: SessionController attaches Scenario 3B late-recovery final_output to originating om_* execution without minting a dangling contract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bmx-sc-3b-'));
    const store = new SessionContractStore(dir, 'app_test');
    try {
      const ref = { appId: 'app_test', sessionId: 'sess-sc-3b' };
      const ds = {
        larkAppId: ref.appId,
        chatId: 'oc_1',
        scope: 'chat',
        workerGeneration: 1,
        session: { sessionId: ref.sessionId, larkAppId: ref.appId, status: 'active', workerGeneration: 1, cliId: 'claude-code' },
        initConfig: { cliId: 'claude-code' },
      } as any;
      const controller = new SessionController(ds, store);
      const producer = controller.bindWorker(1).worker;
      const runtime = controller.reserveBinding('b1', producer);
      controller.bindRuntime('b1', producer, { backend: 'pty', physicalId: '111:start', nativeSessionId: 'native-1', proof: 'process_start' });
      const eventScope = new WorkerSessionEventScope(ref, producer);
      const binding = eventScope.beginRuntime();
      eventScope.assign(binding.bindingId, runtime);
      const metadata = loadWorkerFunction<(message: any) => any>('sessionEventMetadata', { workerSessionEventScope: eventScope });
      controller.admitInput('om_orig_sc');
      const termMsg = eventScope.run(binding, () => metadata({
        type: 'turn_terminal',
        turnId: 'om_orig_sc',
        status: 'completed',
        outputDisposition: 'boundary_unobserved',
      }));
      const term = controller.ingest(termMsg, producer);
      expect(term).toMatchObject({ kind: 'current' });

      const lateMsg = eventScope.run(binding, () => metadata({
        type: 'final_output',
        turnId: 'late-recovery-a_final',
        replyTurnId: 'om_orig_sc',
        content: 'Recovered 3B text',
        lastUuid: 'a_final',
      }));
      const late = controller.ingest(lateMsg, producer);
      expect(late).toMatchObject({ kind: 'current' });
      // Must NOT have minted a dangling execution for 'late-recovery-a_final'!
      expect(store.executions(ref, 'late-recovery-a_final')).toEqual([]);
      expect(store.executions(ref, 'om_orig_sc')).toHaveLength(1);

      const missingOriginMsg = eventScope.run(binding, () => metadata({
        type: 'final_output',
        turnId: 'late-recovery-missing_origin',
        replyTurnId: 'om_missing_sc',
        content: 'Recovered after the original execution was pruned',
        lastUuid: 'a_missing',
      }));
      const missingOrigin = controller.ingest(missingOriginMsg, producer);
      expect(missingOrigin).toMatchObject({ kind: 'current' });
      expect(store.executions(ref, 'late-recovery-missing_origin')).toEqual([]);
      expect(store.executions(ref, 'om_missing_sc')).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
