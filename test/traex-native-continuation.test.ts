import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraexNativeContinuationTracker } from '../src/core/traex-native-continuation.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import {
  TraexAutoModelController,
  traexAutoModelPreflightEnabled,
} from '../src/services/traex-auto-model.js';
import {
  CodexBridgeQueue,
  STRUCTURED_SUBMIT_START_GRACE_MS,
  pruneExpiredPreStartHeadsAndEmit,
} from '../src/services/codex-bridge-queue.js';
import { drainTraexRollout } from '../src/services/traex-transcript.js';
import {
  createTraexAdapter,
  traexCapacityQueueVisible,
  traexModelProgressVisible,
  traexQueuedTypeAheadVisible,
} from '../src/adapters/cli/traex.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import { ProgramStatusFramingStream } from '../src/utils/program-status-parser.js';
import { programStatusBlockHoldsTypeAhead } from '../src/core/program-status-gate.js';
import {
  STALE_PROGRAM_STATUS_QUIET_MS,
  staleProgramStatusVerdict,
} from '../src/utils/stale-program-status.js';
import { pendingInputAllowsTypeAhead } from '../src/utils/pending-input-queue.js';
import { beginRuntimeWriteCycle } from '../src/utils/runtime-screen-status.js';
import { inspectPostTerminalComposer } from '../src/utils/pty-input-policy.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

const SID = '00000000-0000-7000-8000-000000003943';
const tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createRolloutFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'traex-native-cont-'));
  tempDirs.push(dir);
  const path = join(dir, `rollout-2026-11-28T00-00-00-${SID}.jsonl`);
  writeFileSync(path, '');
  return path;
}

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function traexTaskStarted(turnId: string, rootTurnId: string | undefined, atIso: string): string {
  return line({
    timestamp: atIso,
    type: 'event_msg',
    payload: {
      type: 'task_started',
      turn_id: turnId,
      ...(rootTurnId !== undefined ? { root_turn_id: rootTurnId } : {}),
    },
  });
}

function traexUserMessage(text: string, turnId: string, messageId: string, atIso: string): string {
  return line({
    timestamp: atIso,
    type: 'history_mutation',
    payload: {
      version: 1,
      commit_id: messageId,
      operation: 'append',
      turn_id: turnId,
      items: [{
        type: 'message',
        id: messageId,
        role: 'user',
        content: [{ type: 'input_text', text }],
        internal_chat_message_metadata_passthrough: {
          turn_id: turnId,
          content_item_kinds: ['user.text'],
        },
      }],
    },
  });
}

function traexTaskComplete(turnId: string, answer: string, atIso: string): string {
  return line({
    timestamp: atIso,
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: turnId,
      last_agent_message: answer,
    },
  });
}

function traexTurnAborted(turnId: string, atIso: string): string {
  return line({
    timestamp: atIso,
    type: 'event_msg',
    payload: {
      type: 'turn_aborted',
      turn_id: turnId,
      reason: 'interrupted',
    },
  });
}

describe('TraexNativeContinuationTracker & drainTraexRollout', () => {
  it('records nested subagent task_started on nativeTurnLifecycle without emitting a CodexBridgeEvent turn_started', () => {
    const path = createRolloutFile();
    const rootTurnId = 'native-t1';
    const subagentTurnId = 'native-t2';
    writeFileSync(
      path,
      traexTaskComplete(rootTurnId, 'main turn done', '2026-11-28T00:00:10.000Z')
        + traexTaskStarted(subagentTurnId, rootTurnId, '2026-11-28T00:00:12.000Z'),
    );

    const drained = drainTraexRollout(path, 0);
    // Nested task_started must NOT enter `events` (must not claim a Lark turn).
    expect(drained.events.filter(ev => ev.kind === 'turn_started')).toEqual([]);
    expect(drained.nativeTurnLifecycle).toEqual([
      { kind: 'ended', turnId: rootTurnId },
      { kind: 'started', turnId: subagentTurnId, rootTurnId },
    ]);

    const tracker = new TraexNativeContinuationTracker();
    const first = tracker.observeTranscriptLifecycle(drained.nativeTurnLifecycle ?? []);
    expect(first).toEqual({ becameActive: true, closedTranscriptContinuation: false });
    expect(tracker.hasTranscriptContinuation()).toBe(true);
    expect(tracker.isActive(false)).toBe(true);

    appendFileSync(path, traexTaskComplete(subagentTurnId, 'subagent synthesis', '2026-11-28T00:05:00.000Z'));
    const closed = drainTraexRollout(path, drained.newOffset);
    const second = tracker.observeTranscriptLifecycle(closed.nativeTurnLifecycle ?? []);
    expect(second).toEqual({ becameActive: false, closedTranscriptContinuation: true });
    expect(tracker.hasTranscriptContinuation()).toBe(false);
    expect(tracker.isActive(false)).toBe(false);
  });

  it('cleans up a nested sub-turn that began before its parent root turn ended', () => {
    const tracker = new TraexNativeContinuationTracker();
    tracker.observeTranscriptLifecycle([
      { kind: 'started', turnId: 'nested-inside-t1', rootTurnId: 'native-t1' },
    ]);
    expect(tracker.hasTranscriptContinuation()).toBe(true);

    // Parent root turn closes without a separate terminal for the earlier nested step.
    const afterRootEnd = tracker.observeTranscriptLifecycle([
      { kind: 'ended', turnId: 'native-t1' },
    ]);
    expect(afterRootEnd.closedTranscriptContinuation).toBe(true);
    expect(tracker.hasTranscriptContinuation()).toBe(false);
    expect(tracker.isActive(false)).toBe(false);

    // A later subagent wakeup after native-t1's terminal stays active until its own end.
    const afterWake = tracker.observeTranscriptLifecycle([
      { kind: 'started', turnId: 'native-t2', rootTurnId: 'native-t1' },
    ]);
    expect(afterWake.becameActive).toBe(true);
    expect(tracker.hasTranscriptContinuation()).toBe(true);
  });

  it('closes cleanly on turn_aborted and ignores stray root task_started while a Botmux turn is open', () => {
    const path = createRolloutFile();
    const tracker = new TraexNativeContinuationTracker();

    // Stray root task_started while a Botmux turn is open must NOT arm native continuation.
    const stray = tracker.observeTranscriptLifecycle(
      [{ kind: 'started', turnId: 'retry-root', rootTurnId: 'retry-root' }],
      { ownedNativeTurnIds: new Set(['native-t1']), hasOpenBotmuxTurn: true, botmuxWriteInFlight: false },
    );
    expect(stray).toEqual({ becameActive: false, closedTranscriptContinuation: false });
    expect(tracker.isActive(false)).toBe(false);

    // Once no Botmux turn is open, an unowned root task_started activates and closes on turn_aborted.
    writeFileSync(
      path,
      traexTaskStarted('native-unowned', 'native-unowned', '2026-11-28T00:01:00.000Z'),
    );
    const started = drainTraexRollout(path, 0);
    expect(tracker.observeTranscriptLifecycle(started.nativeTurnLifecycle ?? []).becameActive).toBe(true);
    expect(tracker.isActive(false)).toBe(true);

    appendFileSync(path, traexTurnAborted('native-unowned', '2026-11-28T00:02:00.000Z'));
    const aborted = drainTraexRollout(path, started.newOffset);
    expect(tracker.observeTranscriptLifecycle(aborted.nativeTurnLifecycle ?? []).closedTranscriptContinuation).toBe(true);
    expect(tracker.isActive(false)).toBe(false);
  });

  it('distinguishes post-idle OSC 7501 working from post-terminal (!wasPromptReady) working', () => {
    const tracker = new TraexNativeContinuationTracker();

    // Post-terminal window: composer not yet observed (`wasPromptReady: false`) — must NOT activate.
    const lateFromPredecessor = tracker.observeProgramStatus({
      state: 'working',
      wasPromptReady: false,
      programStatusHeldWorking: true,
      hasBotmuxTurnOwner: false,
      botmuxOperationInFlight: false,
    });
    expect(lateFromPredecessor.becameActive).toBe(false);
    expect(tracker.isActive(true)).toBe(false);

    // Botmux turn owns CLI — must NOT activate.
    const botmuxOwned = tracker.observeProgramStatus({
      state: 'working',
      wasPromptReady: true,
      programStatusHeldWorking: true,
      hasBotmuxTurnOwner: true,
      botmuxOperationInFlight: false,
    });
    expect(botmuxOwned.becameActive).toBe(false);
    expect(tracker.isActive(true)).toBe(false);

    // Post-idle native wakeup: CLI was confirmed ready, no Botmux turn/op in flight.
    const nativeWake = tracker.observeProgramStatus({
      state: 'working',
      wasPromptReady: true,
      programStatusHeldWorking: true,
      hasBotmuxTurnOwner: false,
      botmuxOperationInFlight: false,
    });
    expect(nativeWake.becameActive).toBe(true);
    expect(tracker.isActive(true)).toBe(true);
    // If IdleDetector no longer holds working (e.g. blocked or done), immediately inactive.
    expect(tracker.isActive(false)).toBe(false);

    // A rollout terminal carries no turn id on the OSC working state, so it
    // cannot prove the working hold belongs to the ending turn: an OSC-only
    // sibling continuation may still run under that same hold. The latch stays
    // armed while the detector still holds working.
    tracker.observeTranscriptLifecycle([{ kind: 'ended', turnId: 'native-t2' }], {}, true);
    expect(tracker.isActive(true)).toBe(true);

    // Once the detector drops the working hold, the same terminal retires the
    // now-inert latch instead of leaving it stranded.
    tracker.observeTranscriptLifecycle([{ kind: 'ended', turnId: 'native-t3' }], {}, false);
    expect(tracker.isActive(false)).toBe(false);

    // Re-arm, then prove the OSC state machine itself owns teardown: an explicit
    // non-working report clears the latch even while a rollout terminal never names it.
    const reWake = tracker.observeProgramStatus({
      state: 'working',
      wasPromptReady: true,
      programStatusHeldWorking: true,
      hasBotmuxTurnOwner: false,
      botmuxOperationInFlight: false,
    });
    expect(reWake.becameActive).toBe(true);
    const goIdle = tracker.observeProgramStatus({
      state: 'idle',
      wasPromptReady: false,
      programStatusHeldWorking: false,
      hasBotmuxTurnOwner: false,
      botmuxOperationInFlight: false,
    });
    expect(goIdle.becameActive).toBe(false);
    expect(tracker.isActive(false)).toBe(false);
  });

  it('keeps an OSC-first continuation active when a transcript-only sibling closes first under the same working hold', () => {
    const tracker = new TraexNativeContinuationTracker();

    // Continuation B wakes via OSC 7501 working before any rollout edge lands.
    const bWake = tracker.observeProgramStatus({
      state: 'working',
      wasPromptReady: true,
      programStatusHeldWorking: true,
      hasBotmuxTurnOwner: false,
      botmuxOperationInFlight: false,
    });
    expect(bWake.becameActive).toBe(true);
    expect(tracker.hasTranscriptContinuation()).toBe(false);

    // Sibling A's nested task_started flushes later while B keeps running.
    tracker.observeTranscriptLifecycle([
      { kind: 'started', turnId: 'native-A', rootTurnId: 'native-root' },
    ], {}, true);
    expect(tracker.hasTranscriptContinuation()).toBe(true);

    // A completes first; B still runs and the detector still holds working.
    const closeA = tracker.observeTranscriptLifecycle(
      [{ kind: 'ended', turnId: 'native-A' }],
      {},
      true,
    );
    expect(closeA.closedTranscriptContinuation).toBe(true);
    expect(tracker.hasTranscriptContinuation()).toBe(false);
    // B's OSC evidence must survive A's terminal — no cross-continuation clear.
    expect(tracker.isActive(true)).toBe(true);

    // B's own non-working OSC report is what finally retires the latch.
    tracker.observeProgramStatus({
      state: 'idle',
      wasPromptReady: false,
      programStatusHeldWorking: false,
      hasBotmuxTurnOwner: false,
      botmuxOperationInFlight: false,
    });
    expect(tracker.isActive(false)).toBe(false);
  });

  it('tracks the OSC-only window with a bounded timestamp anchor for stale recovery', () => {
    vi.useFakeTimers();
    const base = Date.parse('2026-11-28T00:00:00.000Z');
    vi.setSystemTime(base);
    const tracker = new TraexNativeContinuationTracker();

    // OSC-first wake: map empty, latch armed -> OSC-only anchor starts now.
    tracker.observeProgramStatus({
      state: 'working', wasPromptReady: true, programStatusHeldWorking: true,
      hasBotmuxTurnOwner: false, botmuxOperationInFlight: false,
    });
    expect(tracker.programStatusOnlyForMs(base, true)).toBe(0);

    // A transcript turn opening leaves the OSC-only state.
    vi.setSystemTime(base + 5_000);
    tracker.observeTranscriptLifecycle(
      [{ kind: 'started', turnId: 'B', rootTurnId: 'root' }], {}, true,
    );
    expect(tracker.programStatusOnlyForMs(Date.now(), true)).toBeUndefined();

    // The turn closes while OSC still holds working: the anchor re-arms at close.
    vi.setSystemTime(base + 30_000);
    tracker.observeTranscriptLifecycle([{ kind: 'ended', turnId: 'B' }], {}, true);
    expect(tracker.programStatusOnlyForMs(Date.now(), true)).toBe(0);
    vi.setSystemTime(base + 30_000 + 65_000);
    expect(tracker.programStatusOnlyForMs(Date.now(), true)).toBe(65_000);

    // Lost working hold (or OSC terminal) drops the anchor even without an event.
    expect(tracker.programStatusOnlyForMs(Date.now(), false)).toBeUndefined();

    // An explicit non-working OSC report clears the latch and anchor; a later
    // working re-wake then re-arms the anchor at that moment.
    vi.setSystemTime(base + 100_000);
    tracker.observeProgramStatus({
      state: 'idle', wasPromptReady: false, programStatusHeldWorking: false,
      hasBotmuxTurnOwner: false, botmuxOperationInFlight: false,
    });
    expect(tracker.programStatusOnlyForMs(Date.now(), false)).toBeUndefined();
    tracker.observeProgramStatus({
      state: 'working', wasPromptReady: true, programStatusHeldWorking: true,
      hasBotmuxTurnOwner: false, botmuxOperationInFlight: false,
    });
    expect(tracker.programStatusOnlyForMs(Date.now(), true)).toBe(0);
    vi.setSystemTime(base + 100_000 + 70_000);
    expect(tracker.programStatusOnlyForMs(Date.now(), true)).toBe(70_000);
    vi.useRealTimers();
  });
});

describe('Worker resetTraexAutoModelBeforePendingTurn & flushPending during TRAE native continuation', () => {
  function buildWorkerHarness(opts: {
    reselectPerTurn?: boolean;
    preflightLoadCheck?: boolean;
    trigger?: 'capacity' | 'quota';
    switchToBackupFirst?: boolean;
    viewport?: string;
    crossPrincipalIsolation?: boolean;
  } = {}) {
    const h = workerSubmitHarness();
    const { scope } = h;
    scope.pendingMessages.splice(0, scope.pendingMessages.length);
    const adapter = createTraexAdapter();
    const detector = new IdleDetector(adapter);
    const controller = new TraexAutoModelController({
      enabled: true,
      trigger: opts.trigger ?? 'capacity',
      models: ['core', 'backup'],
      reselectPerTurn: opts.reselectPerTurn ?? false,
      preflightLoadCheck: opts.preflightLoadCheck ?? false,
      queueTimeoutMs: 5_000,
    });
    controller.beginTurn('om_1');
    if (opts.switchToBackupFirst) {
      expect(controller.commitSwitch({
        kind: 'switch',
        reason: 'available_model',
        turnId: 'om_1',
        fromModel: 'core',
        toModel: 'backup',
        toIndex: 1,
        loadPercent: 40,
      })).toBe(true);
    }
    controller.endTurn('om_1');

    const tracker = new TraexNativeContinuationTracker();
    const authority = new ActiveTurnAuthority();
    const queue = new CodexBridgeQueue(() => Date.now());
    const rolloutPath = createRolloutFile();
    let viewport = opts.viewport ?? '◆ Working… (3s • esc to interrupt)\n❯ Ask TRAE CLI to do anything';

    Object.assign(scope, {
      cliAdapter: adapter,
      idleDetector: detector,
      programStatusStream: new ProgramStatusFramingStream(),
      traexNativeContinuation: tracker,
      activeTurnAuthority: authority,
      codexBridgeQueue: queue,
      codexBridgeRolloutPath: rolloutPath,
      codexBridgeOffset: 0,
      codexBridgePendingTail: '',
      codexBridgeBaselineDone: true,
      structuredBridgeIs: (id: string) => id === 'traex',
      structuredBridgeIngestPath: (path: string, offset: number) => drainTraexRollout(path, offset),
      rpcTranscriptIngestBlockedByAwaitingActivation: () => false,
      bridgeSpecFor: () => undefined,
      OrcaBackend: class {},
      traexAutoModelController: controller,
      traexAutoModelRuntimeEligible: () => true,
      traexAutoModelSwitching: false,
      traexQuotaPending: undefined,
      traexAutoModelPreflightPending: undefined,
      traexAutoModelPreflightEnabled,
      traexAutoModelTurnReplayForbidden: false,
      traexAutoModelInputHold: () => false,
      executeTraexAutoModelSwitch: vi.fn(() => true),
      selectTraexCapacityModelBeforeTurn: vi.fn(() => true),
      selectTraexQuotaModelBeforeTurn: vi.fn(() => true),
      lastInitConfig: {
        cliId: 'traex',
        cliSessionId: SID,
        adoptMode: false,
        model: controller.currentModel(),
      },
      backend: {
        write: vi.fn(() => true),
        captureViewport: () => viewport,
        captureViewportAsync: vi.fn(async () => viewport),
      },
      captureBackendScreen: () => viewport,
      backendScreenEvidenceIsAuthoritativeForMutation: () => true,
      backendScreenRevision: 0,
      observedPaneGridRevision: 0,
      promptReadinessRevision: 0,
      webTerminalInputGeneration: 0,
      cliSpawnGeneration: 1,
      renderer: {
        write: vi.fn(),
        writeAndFlush: vi.fn(async () => {}),
        rawSnapshot: () => viewport,
        markNewTurn: vi.fn(),
      },
      currentBotmuxTurnId: undefined,
      currentBotmuxDispatchAttempt: undefined,
      queuedTypeAheadTurns: [],
      retiredTurnIds: new Set<string>(),
      commandLineWritesPending: 0,
      injectionFlushing: false,
      awaitingFirstPrompt: false,
      cliRestartInProgress: false,
      isFlushing: false,
      cliSubmissionInFlight: null,
      postTerminalInputFence: null,
      beginRuntimeWriteCycle,
      traexCapacityQueueVisible,
      traexModelProgressVisible,
      traexQueuedTypeAheadVisible,
      inspectPostTerminalComposer,
      programStatusBlockHoldsTypeAhead,
      pendingInputAllowsTypeAhead,
      crossPrincipalIsolationOn: () => opts.crossPrincipalIsolation === true,
      turnAuthorityIdentity: (input: any) => ({
        turnId: input.turnId,
        dispatchAttempt: input.dispatchAttempt,
        queueAfterActiveTurn: input.queueAfterActiveTurn,
        caller: input.trustedCaller,
        controller: input.trustedController,
      }),
      activeTurnBlocks: (input: any) => {
        if (!input.queueAfterActiveTurn && opts.crossPrincipalIsolation !== true) return false;
        return authority.blocks({
          turnId: input.turnId,
          dispatchAttempt: input.dispatchAttempt,
          queueAfterActiveTurn: input.queueAfterActiveTurn,
          caller: input.trustedCaller,
          controller: input.trustedController,
        });
      },
      markActiveTurnStarted: (input: any) => {
        const id = {
          turnId: input.turnId,
          dispatchAttempt: input.dispatchAttempt,
          caller: input.trustedCaller,
          controller: input.trustedController,
        };
        if (!authority.reserve(id) || !authority.markStarted(id)) {
          throw new Error(`turn authority mismatch (${input.turnId})`);
        }
      },
      noteCliInputWritten: (item: any) => {
        if (item.turnId) queue.mark(item.turnId, item.logicalContent ?? item.content, Date.now(), item.dispatchAttempt);
      },
      confirmSubmit: (turnId: string) => {
        queue.confirmPendingTurn(turnId, Date.now());
      },
      publishActiveRuntime: vi.fn(),
      publishedActiveRuntime: {},
      publishScreenStatus: vi.fn(),
      noteAntigravityWorkingOwner: vi.fn(),
      holdStructuredStartLeasesWhileProgramStatusBusy: vi.fn(),
      holdStructuredStartLeasesWhileCliStarting: vi.fn(),
      holdStructuredStartLeasesWhileCliHoldsInput: vi.fn(),
      holdStructuredStartLeaseWhileDriverAwaitsInput: vi.fn(),
      pruneExpiredPreStartHeadsAndEmit,
      observeStructuredBackgroundTasks: vi.fn(),
      noteSpawnArgvTurnStartTranscriptEvidence: vi.fn(),
      emitReadyCodexTurns: vi.fn(),
      deferFinalIdleSignal: vi.fn(),
      scheduleStaleProgramStatusCheck: vi.fn(),
      armPostTerminalInputFence: () => {
        scope.postTerminalInputFence = { backend: scope.backend, generation: scope.cliSpawnGeneration };
        scope.isPromptReady = false;
      },
      currentPostTerminalInputFence: () => scope.postTerminalInputFence,
      postTerminalInputIsBlocked: async () => {
        scope.codexBridgeIngest({ signalIdle: false });
        if (!scope.postTerminalInputFence) return false;
        return scope.postTerminalPromptFenceHolds('external', scope.backend);
      },
      retryTraexAutoModelAdmission: vi.fn(),
      setCaptureIdentity: (turnId?: string, dispatchAttempt?: number) => {
        scope.currentBotmuxTurnId = turnId;
        scope.currentBotmuxDispatchAttempt = dispatchAttempt;
      },
      rpcTurnOwnerKey: (id: { turnId: string; dispatchAttempt?: number }) => `${id.turnId}:${id.dispatchAttempt ?? ''}`,
      structuredTurnsWithSubmitNotice: new Set<string>(),
      submitFailureChains: { has: () => false },
      inputDeliveryEvidence: { writeStartedAtMs: () => undefined },
      submitActivityEvidenceSince: () => 'none',
      notifyUncollectedStructuredTurns: vi.fn(),
      uncollectedTurnsNeedingNotice: (turns: unknown[]) => turns,
      markTurnRetired: (turnId: string) => { scope.retiredTurnIds.add(turnId); },
      acknowledgeTurnInputCommitted: vi.fn(),
      maybeQueuePostSubmitNativeSessionTitle: vi.fn(),
      deferNativeCodexInputCommit: () => false,
      deferTurnInputCommitUntilSubmission: () => false,
      handlePtyDataChunk: vi.fn(),
      lastPtyActivityAtMs: 0,
      spawnArgvNeedsWorkingSeed: false,
      spawnArgvTurnStartEvidenceSeen: false,
      spawnArgvTurnStartBusyScanTail: '',
      traexQuestionBlockReported: () => false,
      traexQuestionBridgeActive: () => false,
      log: vi.fn(),
      send: vi.fn(),
    });

    scope.traexNativeContinuationActive = loadWorkerFunction('traexNativeContinuationActive', scope);
    scope.holdStructuredStartLeasesWhileTraexNativeContinuation = loadWorkerFunction(
      'holdStructuredStartLeasesWhileTraexNativeContinuation',
      scope,
    );
    scope.resetTraexAutoModelBeforePendingTurn = loadWorkerFunction('resetTraexAutoModelBeforePendingTurn', scope);
    scope.admitTraexAutoModelPendingInput = loadWorkerFunction('admitTraexAutoModelPendingInput', scope);
    scope.programStatusBlockedHoldsTypeAhead = loadWorkerFunction('programStatusBlockedHoldsTypeAhead', scope);
    scope.revokePromptReadiness = loadWorkerFunction('revokePromptReadiness', scope);
    scope.beginCliWriteCycle = loadWorkerFunction('beginCliWriteCycle', scope);
    scope.postTerminalPromptFenceHolds = loadWorkerFunction('postTerminalPromptFenceHolds', scope);
    scope.codexBridgeIngest = loadWorkerFunction('codexBridgeIngest', scope);
    scope.pruneExpiredStructuredHeadsAndEmit = loadWorkerFunction('pruneExpiredStructuredHeadsAndEmit', scope);
    scope.onPtyData = loadWorkerFunction('onPtyData', scope);
    scope.flushPending = h.flush;

    // Wire real IdleDetector busy transition so OSC 7501 `working` revokes prompt readiness just like production.
    detector.onBusy(() => {
      scope.revokePromptReadiness();
    });
    // Simulate that Turn 1 already started an input cycle and returned to idle prompt.
    detector.reset({ inputCycle: true });
    detector.adoptPromptReady();
    scope.isPromptReady = true;

    scope.cliAdapter.writeInput = vi.fn(async () => ({ submitted: true }));

    return {
      ...h,
      controller,
      tracker,
      authority,
      queue,
      detector,
      rolloutPath,
      setViewport: (next: string) => { viewport = next; },
    };
  }

  it('does not block a follow-up message during a TRAE subagent native continuation and settles reply attribution', async () => {
    const h = buildWorkerHarness({ reselectPerTurn: false, preflightLoadCheck: false });
    const { scope, rolloutPath, queue, authority } = h;
    const now = Date.now();

    // 1. Main turn T1 already completed, authority released, composer recovered (`isPromptReady === true`).
    expect(authority.snapshot()).toBeUndefined();
    expect(scope.isPromptReady).toBe(true);

    // 2. Subagent callback wakes TRAE natively: rollout gets nested task_started + OSC 7501 working.
    appendFileSync(
      rolloutPath,
      traexTaskStarted('native-t2', 'native-t1', new Date(now).toISOString()),
    );
    scope.onPtyData('\x1b]7501;state=working:app=traecli\x1b\\');
    expect(scope.isPromptReady).toBe(false);
    expect(scope.idleDetector.programStatusHeldWorking()).toBe(true);
    scope.codexBridgeIngest();
    expect(scope.traexNativeContinuationActive()).toBe(true);

    // 3. User sends ordinary Feishu follow-up during the native continuation.
    const caller = { requestLarkAppId: 'app_test', requestUserOpenId: 'ou_alice', senderType: 'user' as const };
    scope.pendingMessages.push({ content: '顺便看下日志', turnId: 'om_2', trustedCaller: caller });
    expect(scope.resetTraexAutoModelBeforePendingTurn()).toBe(false);

    await h.flush();
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(scope.pendingMessages).toEqual([]);
    expect(scope.currentBotmuxTurnId).toBe('om_2');
    expect(authority.snapshot()).toMatchObject({ turnId: 'om_2', started: true });
    expect(scope.traexAutoModelTurnReplayForbidden).toBe(true);
    expect(queue.peek().map(t => t.turnId)).toEqual(['om_2']);

    // 4. TRAE steers the follow-up into native-t2 and finishes with task_complete.
    const steeredAt = Date.now();
    appendFileSync(
      rolloutPath,
      traexUserMessage('顺便看下日志', 'native-t2', 'msg_2', new Date(steeredAt + 500).toISOString())
        + traexTaskComplete('native-t2', '日志排查结果', new Date(steeredAt + 1_000).toISOString()),
    );
    scope.codexBridgeIngest();
    expect(scope.traexNativeContinuation.hasTranscriptContinuation()).toBe(false);
    // The rollout terminal alone must not clear the OSC working latch: while
    // the detector still holds working, an OSC-only sibling could be running.
    expect(scope.traexNativeContinuationActive()).toBe(true);
    // TRAE reports the non-working state once its OSC working actually ends;
    // that OSC edge owns the latch teardown.
    scope.onPtyData('\x1b]7501;state=done:app=traecli\x1b\\');
    expect(scope.traexNativeContinuationActive()).toBe(false);
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({
        turnId: 'om_2',
        sourceTurnId: 'native-t2',
        finalText: '日志排查结果',
      }),
    ]);
  });

  it('admits a follow-up on post-idle OSC 7501 working even before task_started is drained from disk', async () => {
    const h = buildWorkerHarness({ reselectPerTurn: false });
    const { scope } = h;

    // OSC 7501 working arrives after composer was already ready; rollout has not flushed task_started yet.
    scope.onPtyData('\x1b]7501;state=working:app=traecli\x1b\\');
    expect(scope.isPromptReady).toBe(false);
    expect(scope.traexNativeContinuation.hasTranscriptContinuation()).toBe(false);
    expect(scope.traexNativeContinuationActive()).toBe(true);

    scope.pendingMessages.push({ content: 'fast follow-up', turnId: 'om_fast' });
    expect(scope.resetTraexAutoModelBeforePendingTurn()).toBe(false);
    await h.flush();
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(scope.pendingMessages).toEqual([]);
  });

  it('keeps a confirmed follow-up pre-start lease alive through a long parked native continuation, then settles on the next native turn', async () => {
    vi.useFakeTimers();
    const baseMs = Date.parse('2026-11-28T00:00:00.000Z');
    vi.setSystemTime(baseMs);

    const h = buildWorkerHarness({ reselectPerTurn: false });
    const { scope, rolloutPath, queue } = h;
    scope.notifyUncollectedStructuredTurns = vi.fn();
    scope.uncollectedTurnsNeedingNotice = (turns: unknown[]) => turns;
    scope.retireStructuredTurnAttribution = vi.fn();

    // Native subagent continuation starts at t=0.
    appendFileSync(rolloutPath, traexTaskStarted('native-t2', 'native-t1', new Date(baseMs).toISOString()));
    scope.onPtyData('\x1b]7501;state=working:app=traecli\x1b\\');
    scope.codexBridgeIngest();

    // User submits M2 at t=1s; TRAE confirms receipt in history.jsonl but parks M2 until native-t2 ends.
    vi.setSystemTime(baseMs + 1_000);
    scope.pendingMessages.push({ content: 'parked follow-up', turnId: 'om_parked' });
    await h.flush();
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    queue.confirmPendingTurn('om_parked', Date.now());

    // Advance 25 minutes in 10s steps — well past the 20s STRUCTURED_SUBMIT_START_GRACE_MS.
    for (let elapsed = 10_000; elapsed <= 25 * 60_000; elapsed += 10_000) {
      vi.setSystemTime(baseMs + 1_000 + elapsed);
      expect(scope.pruneExpiredStructuredHeadsAndEmit('poll')).toBe(false);
    }
    expect(queue.peek().map(t => t.turnId)).toEqual(['om_parked']);
    expect(scope.notifyUncollectedStructuredTurns).not.toHaveBeenCalled();

    // native-t2 completes at minute 25; handoff refreshes om_parked's 20s grace window.
    const endT2Ms = baseMs + 25 * 60_000 + 2_000;
    vi.setSystemTime(endT2Ms);
    appendFileSync(rolloutPath, traexTaskComplete('native-t2', 'subagent finished', new Date(endT2Ms).toISOString()));
    scope.codexBridgeIngest();
    expect(scope.traexNativeContinuation.hasTranscriptContinuation()).toBe(false);

    // 5 seconds later (< 20s handoff grace), TRAE dequeues om_parked into native-t3 and answers it.
    const startT3Ms = endT2Ms + 5_000;
    vi.setSystemTime(startT3Ms);
    appendFileSync(
      rolloutPath,
      traexTaskStarted('native-t3', 'native-t3', new Date(startT3Ms).toISOString())
        + traexUserMessage('parked follow-up', 'native-t3', 'msg_parked', new Date(startT3Ms).toISOString())
        + traexTaskComplete('native-t3', 'answer to parked follow-up', new Date(startT3Ms + 1_000).toISOString()),
    );
    scope.codexBridgeIngest();
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({
        turnId: 'om_parked',
        sourceTurnId: 'native-t3',
        finalText: 'answer to parked follow-up',
      }),
    ]);

    // Verify bounded expiry when a parked follow-up genuinely never starts after a continuation ends.
    const t4StartMs = startT3Ms + 10_000;
    vi.setSystemTime(t4StartMs);
    appendFileSync(rolloutPath, traexTaskStarted('native-t4', 'native-t3', new Date(t4StartMs).toISOString()));
    scope.codexBridgeIngest();
    queue.mark('om_lost', 'lost after continuation', t4StartMs + 1_000);
    queue.confirmPendingTurn('om_lost', t4StartMs + 1_000);
    const t4EndMs = t4StartMs + 60_000;
    vi.setSystemTime(t4EndMs);
    appendFileSync(rolloutPath, traexTaskComplete('native-t4', 'done', new Date(t4EndMs).toISOString()));
    scope.codexBridgeIngest();
    // OSC working ends with the last continuation; without this edge the
    // bounded (120s) program-status lease would keep refreshing om_lost.
    scope.onPtyData('\x1b]7501;state=done:app=traecli\x1b\\');
    vi.setSystemTime(t4EndMs + STRUCTURED_SUBMIT_START_GRACE_MS + 1_000);
    expect(scope.pruneExpiredStructuredHeadsAndEmit('post-continuation-expiry')).toBe(true);
    expect(queue.peek()).toEqual([]);
  });

  it('clears an armed post-terminal fence and wakes a held follow-up when a subagent continuation begins before composer redraw', async () => {
    const h = buildWorkerHarness({
      reselectPerTurn: false,
      viewport: '◆ Working… (1s • esc to interrupt)',
    });
    const { scope, rolloutPath } = h;

    // T1 ended and armed postTerminalInputFence before the composer redrew.
    scope.armPostTerminalInputFence();
    expect(scope.isPromptReady).toBe(false);
    expect(scope.postTerminalInputFence).not.toBeNull();

    // Follow-up arrives during the post-terminal gap and is held.
    scope.pendingMessages.push({ content: 'follow-up during gap', turnId: 'om_gap' });
    await h.flush();
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toHaveLength(1);

    // Subagent wakes TRAE immediately (`task_started` with `root_turn_id` pointing to T1).
    appendFileSync(
      rolloutPath,
      traexTaskStarted('native-t2', 'native-t1', '2026-11-28T00:01:00.000Z'),
    );
    scope.codexBridgeIngest();
    expect(scope.postTerminalInputFence).toBeNull();
    expect(scope.traexNativeContinuation.hasTranscriptContinuation()).toBe(true);

    // Let the microtask flush re-kick settle.
    await Promise.resolve();
    await vi.waitFor(() => expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce());
    expect(scope.pendingMessages).toEqual([]);
  });

  it('does not publish idle when a nested task_complete lands while a sibling continuation stays open without an OSC working hold', () => {
    const h = buildWorkerHarness({ reselectPerTurn: false });
    const { scope, rolloutPath, detector } = h;

    // Two nested subagent continuations start in one drain; the becameActive
    // branch revokes readiness and resets the detector before any OSC working.
    appendFileSync(
      rolloutPath,
      traexTaskStarted('native-t2', 'native-t1', '2026-11-28T00:01:00.000Z')
        + traexTaskStarted('native-t3', 'native-t1', '2026-11-28T00:01:01.000Z'),
    );
    scope.codexBridgeIngest();
    expect(scope.traexNativeContinuation.hasTranscriptContinuation()).toBe(true);
    // OSC 7501 has no heartbeat: the working hold can be absent while rollout
    // still proves both continuations running.
    expect(detector.programStatusHeldWorking()).toBe(false);
    expect(detector.isIdleNow()).toBe(false);

    // Sibling t3 closes with its own assistant_final; t2 remains open.
    appendFileSync(
      rolloutPath,
      traexTaskComplete('native-t3', 'sibling synthesis', '2026-11-28T00:02:00.000Z'),
    );
    scope.codexBridgeIngest();
    expect(scope.traexNativeContinuation.hasTranscriptContinuation()).toBe(true);
    // The assistant_final must not fireIdle() into a wrong ready edge while t2
    // is demonstrably still running on transcript evidence alone.
    expect(detector.isIdleNow()).toBe(false);
  });

  it('does not publish idle when an OSC-first continuation outlives a transcript sibling that closes first', () => {
    const h = buildWorkerHarness({ reselectPerTurn: false });
    const { scope, rolloutPath, detector } = h;

    // Continuation B wakes via OSC 7501 working while its rollout has not flushed.
    scope.onPtyData('\x1b]7501;state=working:app=traecli\x1b\\');
    expect(detector.programStatusHeldWorking()).toBe(true);
    expect(scope.traexNativeContinuationActive()).toBe(true);
    expect(scope.traexNativeContinuation.hasTranscriptContinuation()).toBe(false);

    // Sibling A's nested task_started lands, then A completes with an
    // assistant_final while B still runs under the same OSC working hold.
    appendFileSync(
      rolloutPath,
      traexTaskStarted('native-A', 'native-root', '2026-11-28T00:01:00.000Z')
        + traexTaskComplete('native-A', 'sibling synthesis', '2026-11-28T00:02:00.000Z'),
    );
    scope.codexBridgeIngest();

    // A's terminal must neither clear B's OSC latch nor fireIdle() into a false
    // ready edge: B is demonstrably still working.
    expect(scope.traexNativeContinuation.hasTranscriptContinuation()).toBe(false);
    expect(scope.traexNativeContinuationActive()).toBe(true);
    expect(detector.programStatusHeldWorking()).toBe(true);
    expect(detector.isIdleNow()).toBe(false);

    // B's own OSC terminal releases the latch and admits idle normally.
    scope.onPtyData('\x1b]7501;state=done:app=traecli\x1b\\');
    expect(scope.traexNativeContinuationActive()).toBe(false);
  });

  it('retires an armed post-terminal fence from the external-idle path while a transcript continuation stays open', () => {
    const h = buildWorkerHarness({
      reselectPerTurn: false,
      viewport: '◆ Working… (1s • esc to interrupt)',
    });
    const { scope, rolloutPath } = h;

    scope.armPostTerminalInputFence();
    expect(scope.postTerminalInputFence).not.toBeNull();

    // Nested continuation opens with no started/queued Botmux turn in the queue.
    appendFileSync(
      rolloutPath,
      traexTaskStarted('native-t2', 'native-t1', '2026-11-28T00:01:00.000Z'),
    );
    scope.codexBridgeIngest();
    expect(scope.traexNativeContinuation.hasTranscriptContinuation()).toBe(true);

    // An external idle edge reaches the fence while the continuation is open:
    // it must retire the stale predecessor fence instead of keeping input held.
    expect(scope.postTerminalPromptFenceHolds('external', scope.backend)).toBe(true);
    expect(scope.postTerminalInputFence).toBeNull();
  });

  it('still holds post-terminal successors waiting for composer recovery when NOT in native continuation (reselectPerTurn on & off)', () => {
    for (const reselectPerTurn of [false, true]) {
      const h = buildWorkerHarness({ reselectPerTurn, switchToBackupFirst: true });
      const { scope } = h;

      // Post-terminal transition window: !isPromptReady, no authority, no type-ahead, no native continuation.
      scope.isPromptReady = false;
      scope.pendingMessages.push({ content: 'independent turn', turnId: 'om_next' });
      expect(scope.resetTraexAutoModelBeforePendingTurn()).toBe(true);
      expect(scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();

      // Even a late OSC 7501 `working` arriving during `!isPromptReady` must NOT bypass the hold.
      scope.onPtyData('\x1b]7501;state=working:app=traecli\x1b\\');
      expect(scope.traexNativeContinuationActive()).toBe(false);
      expect(scope.resetTraexAutoModelBeforePendingTurn()).toBe(true);
      expect(scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();

      // Once composer recovers (`isPromptReady === true`), reselectPerTurn resets to preferred model;
      // reselectPerTurn=false proceeds without switching.
      scope.isPromptReady = true;
      expect(scope.resetTraexAutoModelBeforePendingTurn()).toBe(reselectPerTurn);
      expect(scope.executeTraexAutoModelSwitch).toHaveBeenCalledTimes(reselectPerTurn ? 1 : 0);
    }
  });

  it('preserves preflightLoadCheck, quota trigger, switching, quotaPending, preflightPending, and catalogUnavailable protections', () => {
    // 1. Post-terminal hold protects preflightLoadCheck & quota trigger until composer recovers.
    for (const mode of ['preflight', 'quota'] as const) {
      const h = buildWorkerHarness(
        mode === 'preflight' ? { preflightLoadCheck: true } : { trigger: 'quota' },
      );
      h.scope.isPromptReady = false;
      h.scope.pendingMessages.push({ content: 'independent', turnId: 'om_indep' });
      expect(h.scope.resetTraexAutoModelBeforePendingTurn()).toBe(true);
      expect(h.scope.selectTraexCapacityModelBeforeTurn).not.toHaveBeenCalled();
      expect(h.scope.selectTraexQuotaModelBeforeTurn).not.toHaveBeenCalled();

      h.scope.isPromptReady = true;
      expect(h.scope.resetTraexAutoModelBeforePendingTurn()).toBe(true);
      if (mode === 'preflight') {
        expect(h.scope.selectTraexCapacityModelBeforeTurn).toHaveBeenCalledOnce();
      } else {
        expect(h.scope.selectTraexQuotaModelBeforeTurn).toHaveBeenCalledOnce();
      }
    }

    // 2. Even while a native continuation IS active, switching / quotaPending / preflightPending /
    // catalogUnavailable / inputHold continue to hold.
    const h = buildWorkerHarness({ reselectPerTurn: true, switchToBackupFirst: true });
    const { scope, rolloutPath } = h;
    appendFileSync(rolloutPath, traexTaskStarted('native-t2', 'native-t1', '2026-11-28T00:01:00.000Z'));
    scope.onPtyData('\x1b]7501;state=working:app=traecli\x1b\\');
    scope.codexBridgeIngest();
    expect(scope.traexNativeContinuationActive()).toBe(true);
    scope.pendingMessages.push({ content: 'follow-up', turnId: 'om_2' });

    scope.traexAutoModelSwitching = true;
    expect(scope.resetTraexAutoModelBeforePendingTurn()).toBe(true);
    scope.traexAutoModelSwitching = false;

    scope.traexQuotaPending = { turnId: 'om_1' };
    expect(scope.resetTraexAutoModelBeforePendingTurn()).toBe(true);
    scope.traexQuotaPending = undefined;

    scope.traexAutoModelPreflightPending = { item: scope.pendingMessages[0], generation: 1, startedAtMs: 0 };
    expect(scope.resetTraexAutoModelBeforePendingTurn()).toBe(true);
    scope.traexAutoModelPreflightPending = undefined;

    scope.traexAutoModelInputHold = () => true;
    expect(scope.resetTraexAutoModelBeforePendingTurn()).toBe(true);
    scope.traexAutoModelInputHold = () => false;

    // Healthy native continuation with reselectPerTurn=true steers the running backup model without restarting it;
    // the next idle independent turn still triggers preferred-model reset back to core.
    expect(scope.resetTraexAutoModelBeforePendingTurn()).toBe(false);
    expect(scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();

    scope.lastInitConfig.traexAutoModel = { catalogUnavailable: true };
    expect(scope.resetTraexAutoModelBeforePendingTurn()).toBe(true);
    delete scope.lastInitConfig.traexAutoModel;

    // Once native-t2 completes and prompt is ready, the next independent turn resets to core.
    appendFileSync(rolloutPath, traexTaskComplete('native-t2', 'done', '2026-11-28T00:02:00.000Z'));
    scope.codexBridgeIngest();
    scope.isPromptReady = true;
    expect(scope.resetTraexAutoModelBeforePendingTurn()).toBe(true);
    expect(scope.executeTraexAutoModelSwitch).toHaveBeenCalledOnce();
  });

  it('keeps groupSerialInput, durable turns, permission blocks, and cross-principal isolation intact during native continuation', async () => {
    const h = buildWorkerHarness({ reselectPerTurn: false, crossPrincipalIsolation: true });
    const { scope, rolloutPath } = h;
    appendFileSync(rolloutPath, traexTaskStarted('native-t2', 'native-t1', '2026-11-28T00:01:00.000Z'));
    scope.onPtyData('\x1b]7501;state=working:app=traecli\x1b\\');
    scope.codexBridgeIngest();
    expect(scope.traexNativeContinuationActive()).toBe(true);

    // 1. groupSerialInput (`queueAfterActiveTurn: true`) must still wait for idle.
    scope.pendingMessages.splice(0, scope.pendingMessages.length, {
      content: 'serial group msg',
      turnId: 'om_serial',
      queueAfterActiveTurn: true,
    });
    await h.flush();
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();

    // 2. Durable turn (`dispatchAttempt: 1`) must still wait for idle.
    scope.pendingMessages.splice(0, scope.pendingMessages.length, {
      content: 'durable msg',
      turnId: 'om_durable',
      dispatchAttempt: 1,
    });
    await h.flush();
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();

    // 3. OSC 7501 `blocked` (permission approval) must still hold ordinary follow-ups.
    scope.onPtyData('\x1b]7501;state=blocked:app=traecli:kind=permission\x1b\\');
    scope.pendingMessages.splice(0, scope.pendingMessages.length, {
      content: 'blocked during approval',
      turnId: 'om_blocked',
    });
    await h.flush();
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();

    // Permission answered -> back to working; ordinary user A follow-up submits and acquires authority.
    scope.onPtyData('\x1b]7501;state=working:app=traecli\x1b\\');
    const alice = { requestLarkAppId: 'app_test', requestUserOpenId: 'ou_alice', senderType: 'user' as const };
    const bob = { requestLarkAppId: 'app_test', requestUserOpenId: 'ou_bob', senderType: 'user' as const };
    scope.pendingMessages.splice(0, scope.pendingMessages.length, {
      content: 'alice follow-up',
      turnId: 'om_alice',
      trustedCaller: alice,
    });
    await h.flush();
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(scope.activeTurnAuthority.snapshot()).toMatchObject({ turnId: 'om_alice', started: true });

    // 4. Cross-principal isolation: Bob cannot steer Alice's active turn.
    scope.pendingMessages.push({
      content: 'bob cross-principal',
      turnId: 'om_bob',
      trustedCaller: bob,
    });
    await h.flush();
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(scope.pendingMessages.map((m: any) => m.turnId)).toEqual(['om_bob']);
  });

  it('recovers a lost OSC terminal via the bounded stale check, but not while busy or inside the quiet window', () => {
    vi.useFakeTimers();
    const base = Date.parse('2026-11-28T00:00:00.000Z');
    vi.setSystemTime(base);

    const buildStuck = () => {
      const h = buildWorkerHarness({ reselectPerTurn: false });
      const { scope, rolloutPath, detector } = h;
      let viewportIdle = true;
      Object.assign(scope, {
        backgroundTaskTracker: { pending: () => 0 },
        staleProgramStatusVerdict,
        viewportShowsIdlePrompt: () => viewportIdle,
      });
      scope.checkStaleProgramStatus = loadWorkerFunction('checkStaleProgramStatus', scope);

      // OSC working wakes a continuation, then its rollout opens and closes
      // without any OSC done/idle ever arriving (the lost terminal report).
      scope.onPtyData('\x1b]7501;state=working:app=traecli\x1b\\');
      appendFileSync(
        rolloutPath,
        traexTaskStarted('native-B', 'native-root', new Date(base).toISOString())
          + traexTaskComplete('native-B', 'B done', new Date(base + 1_000).toISOString()),
      );
      scope.codexBridgeIngest();
      expect(detector.programStatusHeldWorking()).toBe(true);
      expect(scope.traexNativeContinuation.hasTranscriptContinuation()).toBe(false);
      expect(scope.traexNativeContinuationActive()).toBe(true);
      // Reaching the OSC-only state with working held arms the bounded stale check.
      expect(scope.scheduleStaleProgramStatusCheck).toHaveBeenCalled();
      return { h, scope, detector, setViewportIdle: (v: boolean) => { viewportIdle = v; } };
    };

    // 1. Inside the quiet window: the verdict waits, nothing is released.
    const early = buildStuck();
    vi.setSystemTime(base + STALE_PROGRAM_STATUS_QUIET_MS - 1_000);
    early.scope.checkStaleProgramStatus();
    expect(early.detector.programStatusHeldWorking()).toBe(true);
    expect(early.scope.traexNativeContinuationActive()).toBe(true);

    // 2. Past the window but the screen still looks busy: keep holding, reschedule.
    vi.setSystemTime(base + STALE_PROGRAM_STATUS_QUIET_MS + 5_000);
    early.setViewportIdle(false);
    early.scope.checkStaleProgramStatus();
    expect(early.detector.programStatusHeldWorking()).toBe(true);
    expect(early.scope.traexNativeContinuationActive()).toBe(true);
    expect(early.scope.scheduleStaleProgramStatusCheck).toHaveBeenCalled();

    // 3. Window elapsed and the authoritative viewport shows the idle prompt:
    //    the lost terminal report is treated as idle and the tracker retires.
    early.setViewportIdle(true);
    early.scope.checkStaleProgramStatus();
    expect(early.detector.programStatusHeldWorking()).toBe(false);
    expect(early.detector.isIdleNow()).toBe(true);
    expect(early.scope.traexNativeContinuationActive()).toBe(false);
    expect(early.scope.traexNativeContinuation.programStatusOnlyForMs(Date.now(), false)).toBeUndefined();
    vi.useRealTimers();
  });
});
