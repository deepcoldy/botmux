import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createMinimaxAdapter } from '../src/adapters/cli/minimax.js';
import { spawnTsScript, tsRunnerPrefix } from './helpers/ts-runner.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { finalizeRawCommandDelivery } from '../src/core/raw-command-writer.js';
import { classifyRawDispatchFailure, rewrapSubmissionFailure } from '../src/core/raw-dispatch-failure.js';
import { AmbiguousSubmissionBlockedError } from '../src/adapters/backend/types.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { isCodexAppCliId } from '../src/adapters/cli/types.js';
import { resolveCodexAppFinalTurnIdentity } from '../src/adapters/cli/codex-app-turn.js';
import { normalizeFinalUsage } from '../src/services/codex-app-runner-protocol.js';
import { bridgePostText } from '../src/services/bridge-fallback-gate.js';
import { runnerFinalOutcome } from '../src/services/runner-final-outcome.js';
import { decideQueuedReadyTransition } from '../src/core/queued-ready-transition.js';
import { claudeSwitchKindForCommand } from '../src/utils/claude-switch-confirm.js';
import { CodexAppFlushPromptReplay } from '../src/utils/codex-app-turn-liveness.js';

function rawWorker(adapter: ReturnType<typeof createMinimaxAdapter>, backend: { write(bytes: string): boolean }) {
  class SubmissionWriteError extends Error {
    constructor(message: string, readonly recoveryFailureReason?: string,
      readonly submissionStarted = true, readonly runnerGenerationUnsafe = false) { super(message); }
  }
  const events: Array<Record<string, unknown>> = [];
  const scope: Record<string, any> = {
    cliAdapter: adapter, SubmissionWriteError, commandLineWriteTail: Promise.resolve(), commandLineWritesPending: 0,
    backend, lastInitConfig: { cliId: 'minimax', adoptMode: false }, isPromptReady: true,
    isFlushing: false, cliRestartInProgress: false, currentBotmuxTurnId: undefined,
    pendingRawInputs: [], captureRevision: 0, captureIdentityAnnounced: false,
    renderer: undefined, usageLimitTracker: { beginTurn() {} }, currentUsageLimitSnapshot: () => undefined,
    applyMojoLivePatch() {}, tmuxScrolledHalfPages: 0, traexAutoModelController: undefined,
    activeTurnAuthority: { inheritOrStartControl: () => true },
    setCaptureIdentity: (id: string) => { scope.currentBotmuxTurnId = id; }, markTurnRetired() {},
    markTurnExecutionStart() {}, stampMojoTurnMark() {}, writeCliPidMarker() {}, publishSandboxRelayCapability() {},
    isEffortLevelCommand: () => false, claudeBtwQuestion: () => undefined,
    classifyRawDispatchFailure, isWorkflowWorker: () => false, claudeSwitchKindForCommand, disarmSwitchConfirm() {}, disarmBtwCapture() {},
    emitTurnTerminal: (turnId: string, status: string) => events.push({ type: 'turn_terminal', turnId, status }),
    send: (message: Record<string, unknown>) => events.push(message),
    sendFatalWorkerErrorAndExit: async () => { throw new Error('generation fenced'); },
    finalizeRawCommandDelivery, flushPending: async () => {}, idleDetector: { reset() {} },
    log() {}, t: (s: string) => s, cliName: () => 'MiniMax',
  };
  for (const name of ['sendRawCommandLine', 'runAmbiguousSubmissionTransaction', 'sendRawCommandLineWithRecoveryFence', 'deliverRawInput']) {
    scope[name] = loadWorkerFunction(name, scope);
  }
  return { events, scope, deliver: scope.deliverRawInput as (message: { type: 'raw_input'; content: string; turnId: string }) => Promise<void> };
}

/** Run the real native-ready and queue drain paths without booting a worker. */
function idleQueue(worker: ReturnType<typeof rawWorker>) {
  const scope = worker.scope;
  const noop = () => {}, off = () => false;
  const drains: Promise<void>[] = [];
  Object.assign(scope, {
    pendingMessages: [], pendingAdoptMessages: [], pendingInjections: [], pendingSessionRename: null,
    idleDetector: { isStartupPending: off, reset: noop, adoptPromptReady: noop },
    traexFirstPromptViewportRejects: off, currentInputDeliveryQuarantine: () => null,
    currentPostTerminalInputFence: () => null, stopStructuredStartGraceRecheck: noop,
    isCodexAppCliId, probeStartupBlocker: () => null, holdForNativeSessionFork: off,
    stopBusyPatternIdleProbe: noop, readyGate: { shouldHold: off }, spawnArgvTurnStartGateHolds: off,
    releaseInterruptedStructuredBridgeOnFirstPrompt: noop, hasStructuredLifecycleBlock: off,
    ptyOutputGeneration: { snapshot: () => 1 }, queuedTypeAheadTurns: [], decideQueuedReadyTransition,
    releaseActiveTurnAuthority: () => scope.activeTurnAuthority.clear(), promptReadyEdges: 0,
    judgeClaudeBridgeTurn: noop, bridgeQueue: { cliQueueDrained: noop },
    settleSessionRenameOnPrompt: noop, syncQueuedTurnsFromMarkerDisk: off, releaseRawInputRestartGate: noop,
    inflightInputs: { onTurnComplete: noop, retireTurn: noop }, maybeEmitWorkflowTranscriptOutput: noop,
    refreshBackgroundWait: noop, backgroundTaskTracker: { pendingTurnAgents: () => 0 },
    settleRestartAttemptOnReady: noop, shouldFlushInjectionsFirst: off,
    nativeSessionForkPending: off, codexModelMigrationCheckNeeded: off, shouldHoldCodexRunnerInput: off,
    resetTraexAutoModelBeforePendingTurn: off, sessionRenameInFlight: off, shouldDeferUserFlush: off,
    refreshHookReviewInputHold: noop, hookReviewHoldsQueuedWrite: off, pendingInputMayFlush: () => true,
    rpcLifecycleFailClosedOwners: new Set(), codexBridgeFallbackActive: off,
    runtimePtyInputPolicy: () => ({ supportsTypeAhead: false, allowBackToBackWrites: false }),
    pendingInputAllowsTypeAhead: off, directRpcTurnBlocksTypeAhead: off, activeTurnBlocks: off,
    promotePendingHumanInterruption: noop,
    effectiveBackendType: 'tmux', CodexAppFlushPromptReplay, codexAppTurnLiveness: { hasActiveTurn: off },
    bareShellChecked: true, firstWriteMayProceed: () => true, hasRunStartupCommands: true,
    freshnessInputQueue: { onPromptReady: () => 'continue', takeRaw: () => scope.pendingRawInputs.shift() },
  });
  scope.hasPendingInputForFlush = loadWorkerFunction('hasPendingInputForFlush', scope);
  const flush = loadWorkerFunction<() => Promise<void>>('flushPending', scope);
  scope.flushPending = () => { const task = flush(); drains.push(task); return task; };
  const markReady = loadWorkerFunction<() => void>('markPromptReady', scope);
  return { markReady, drained: () => Promise.all(drains) };
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each([false, true])('frames compact into the existing ACP session and accepts the next turn (failure: %s)', async failure => {
  const root = mkdtempSync(join(tmpdir(), 'botmux-compact-')); roots.push(root);
  const executable = join(root, 'mcode');
  const log = join(root, 'calls.jsonl');
  const runtime = tsRunnerPrefix();
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  writeFileSync(executable, `#!/bin/sh\nexec ${[runtime.command, resolve('test/fixtures/fake-minimax-compact-acp.mjs')].map(quote).join(' ')} "$@"\n`, { mode: 0o700 });
  const env = { ...process.env, MINIMAX_DATA_DIR: join(root, 'data'), MCODE_COMPACT_TEST_LOG: log,
    MCODE_COMPACT_TEST_FAIL: failure ? '1' : '0' };
  const adapter = createMinimaxAdapter(executable);
  const args = adapter.buildArgs({ sessionId: 'compact-test', resume: true, resumeSessionId: 'native-existing',
    workingDir: root, disableCliBypass: true, env });
  const child = spawnTsScript(resolve('src/minimax-runner.ts'), args.slice(1), { env });
  const closed = new Promise<void>(done => child.once('close', () => done()));
  const backend = { write: (bytes: string) => child.stdin!.write(bytes) };
  const worker = rawWorker(adapter, backend);
  let output = '';
  let errors = '';
  const finals = new Promise<Array<{ content: string; turnId: string; errorCode?: string }>>((done, reject) => {
    const timeout = setTimeout(() => reject(new Error(`compact runner timed out: ${errors}\n${output}`)), 15_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', () => { clearTimeout(timeout); reject(new Error(`compact runner exited: ${errors}\n${output}`)); });
    child.stderr!.on('data', chunk => { errors += chunk.toString(); });
    child.stdout!.on('data', chunk => {
      output += chunk.toString();
      const messages = [...output.matchAll(/\x1b\]777;botmux:final:([A-Za-z0-9+/=]+)\x07/g)]
        .map(m => JSON.parse(Buffer.from(m[1], 'base64').toString()));
      if (messages.length === 2) { clearTimeout(timeout); done(messages); }
    });
  });
  try {
    await worker.deliver({ type: 'raw_input', content: '/compact', turnId: 'compact-click' });
    await adapter.writeInput(backend, 'continue work', { turnId: 'next-message' });
    const [compact, next] = await finals;
    expect(compact.turnId).toBe('compact-click');
    if (failure) {
      expect(compact.errorCode).toBe('execution_failed');
      expect(compact.content).toContain('compaction failed');
    } else {
      expect(compact.errorCode).toBeUndefined();
      expect(compact.content).toBe('Compaction completed.\nMessages: 10 → 3\nTokens: 5000 → 1200');
    }
    expect(next).toMatchObject({ turnId: 'next-message', content: 'answer:continue work' });
    expect(next.errorCode).toBeUndefined();
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter(call => call.method === 'session/resume').map(call => call.params.sessionId))
      .toEqual(['native-existing', 'native-existing']);
    expect(calls.filter(call => call.method === 'session/prompt').map(call => call.params.prompt[0].text))
      .toEqual(['/compact', 'continue work']);
    expect(output).not.toContain('ignoring non-frame input');
  } finally { child.kill('SIGTERM'); await closed; }
});

it.each([true, false])('reannounces ready after a proven unsubmitted compact, including queue drain (%s)', async flushing => {
  const backend = { write: vi.fn(() => true), sendText: vi.fn(() => true), sendSpecialKeys: vi.fn(() => false) };
  const worker = rawWorker(createMinimaxAdapter('/not-executed'), backend);
  worker.scope.isFlushing = flushing;
  const drainStates: boolean[] = [];
  worker.scope.flushPending = async () => { drainStates.push(worker.scope.isFlushing); };
  await worker.deliver({ type: 'raw_input', content: '/compact', turnId: 'compact-rejected' });
  expect(backend.sendText).not.toHaveBeenCalled();
  expect(worker.events).toContainEqual({ type: 'turn_terminal', turnId: 'compact-rejected', status: 'ambiguous' });
  expect(worker.events.filter(event => event.type === 'prompt_ready')).toHaveLength(1);
  expect(worker.scope.isPromptReady).toBe(true);
  expect(drainStates).toEqual([]);
  // The outer flush releases its mutex only after deliverRawInput returns.
  worker.scope.isFlushing = false;
  // Queue a marker behind the production setImmediate. This observes the real
  // event-loop boundary on both Node and Bun without a wall-clock sleep.
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(drainStates).toEqual([false]);
});

it.each(['replaced', 'restarting'] as const)('does not reannounce a rejected compact when the backend is %s', async transition => {
  const backend = { write: vi.fn(() => true), sendText: vi.fn(() => true), sendSpecialKeys: vi.fn(() => false) };
  const replacement = { write: vi.fn(() => true) };
  const worker = rawWorker(createMinimaxAdapter('/not-executed'), backend);
  const drain = vi.fn(async () => {});
  worker.scope.flushPending = drain;
  backend.sendSpecialKeys.mockImplementation(() => {
    // Change lifecycle at the real writer's rejected pre-flush, before its
    // failure unwinds. A stale ready hint must not reopen the compact gate.
    if (transition === 'replaced') worker.scope.backend = replacement;
    else worker.scope.cliRestartInProgress = true;
    return false;
  });

  await worker.deliver({ type: 'raw_input', content: '/compact', turnId: 'compact-rejected' });
  expect(backend.sendSpecialKeys).toHaveBeenCalledWith('Enter');
  expect(backend.sendText).not.toHaveBeenCalled();
  expect(backend.write).not.toHaveBeenCalled();
  expect(worker.events).toContainEqual({ type: 'turn_terminal', turnId: 'compact-rejected', status: 'ambiguous' });
  expect(worker.events.filter(event => event.type === 'user_notify'))
    .toEqual([expect.objectContaining({ turnId: 'compact-rejected' })]);

  // Observe any recovery drain queued by the rejected command on Node and Bun.
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(worker.events.filter(event => event.type === 'prompt_ready')).toHaveLength(0);
  expect(drain).not.toHaveBeenCalled();
  expect(replacement.write).not.toHaveBeenCalled();
});

// ZMX keeps a submission journal around every logical write, so the same
// rejected compact goes through the real journal transaction and its rewrap of
// the writer's failure. The journal's verdict on cancel decides recovery.
it.each([
  ['cancelled cleanly', undefined, true],
  ['left for ZMX recovery', 'recovery-unconfirmed', false],
] as const)('with a submission journal, reannounces a rejected compact only when the journal is %s', async (_label, cancelFailure, recovers) => {
  const backend = {
    write: vi.fn(() => true), sendText: vi.fn(() => true), sendSpecialKeys: vi.fn(() => false),
    captureAmbiguousSubmissionFence: vi.fn(() => 7),
    cancelAmbiguousSubmission: vi.fn((_fence: number) => cancelFailure),
    confirmAmbiguousSubmission: vi.fn(() => undefined),
  };
  const worker = rawWorker(createMinimaxAdapter('/not-executed'), backend);
  Object.assign(worker.scope, {
    ambiguousSubmissionWriteTail: Promise.resolve(), AmbiguousSubmissionBlockedError, rewrapSubmissionFailure,
  });
  for (const name of ['captureAmbiguousSubmissionFence', 'cancelAmbiguousSubmissionAfterFailure',
    'confirmAmbiguousSubmissionAfterSuccess', 'ambiguousSubmissionRecoveryMessage']) {
    worker.scope[name] = loadWorkerFunction(name, worker.scope);
  }
  let drains = 0;
  worker.scope.flushPending = async () => { drains += 1; };
  await worker.deliver({ type: 'raw_input', content: '/compact', turnId: 'compact-rejected' });
  expect(backend.sendText).not.toHaveBeenCalled();
  expect(backend.cancelAmbiguousSubmission).toHaveBeenCalledWith(7);
  expect(backend.confirmAmbiguousSubmission).not.toHaveBeenCalled();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(worker.events.filter(event => event.type === 'prompt_ready')).toHaveLength(recovers ? 1 : 0);
  expect(drains).toBe(recovers ? 1 : 0);
});

it('keeps the active business final attributable until queued compact actually starts', async () => {
  const backend = { write: vi.fn(() => true) };
  const worker = rawWorker(createMinimaxAdapter('/not-executed'), backend);
  const authority = new ActiveTurnAuthority();
  Object.assign(worker.scope, {
    currentBotmuxTurnId: 'business-turn', isPromptReady: false,
    activeTurnAuthority: authority, isCodexAppCliId, resolveCodexAppFinalTurnIdentity,
    normalizeFinalUsage, bridgePostText, runnerFinalOutcome,
    readSendMarkers: () => [], bridgeGateInputForTurn: () => ({}), notifyExplicitRepliesObserved() {},
    attributableExplicitReplyMarkersForTurnWindow: () => [], shouldSuppressBridgeEmit: () => false,
    replyDeliveryMode: () => 'send', sessionId: 'compact-test', currentBotmuxDispatchAttempt: undefined,
  });
  worker.scope.setCaptureIdentity = loadWorkerFunction('setCaptureIdentity', worker.scope);
  const settle = loadWorkerFunction<(kind: string, payload: unknown) => Promise<boolean>>('handleTrustedCodexAppMarker', worker.scope);
  authority.reserve({ turnId: 'business-turn' });
  authority.markStarted({ turnId: 'business-turn' });
  const queue = idleQueue(worker);
  const compact = { type: 'raw_input' as const, content: '/compact', turnId: 'compact-click' };
  await worker.deliver(compact);
  expect(backend.write).not.toHaveBeenCalled();
  expect(worker.scope.pendingRawInputs).toEqual([compact]);
  expect(worker.scope.currentBotmuxTurnId).toBe('business-turn');
  expect(await settle('final', { turnId: 'business-turn', content: 'business answer' })).toBe(true);

  queue.markReady();
  await queue.drained();
  expect(backend.write).toHaveBeenCalledOnce();
  expect(worker.scope.pendingRawInputs).toEqual([]);
  expect(worker.events.filter(event => event.type === 'prompt_ready')).toHaveLength(0);
  expect(worker.scope.currentBotmuxTurnId).toBe('compact-click');
  expect(await settle('final', { turnId: 'compact-click', content: 'compacted' })).toBe(true);
  queue.markReady();
  await queue.drained();
  expect(worker.events.filter(event => event.type === 'prompt_ready')).toHaveLength(1);
  expect(worker.events.filter(event => event.type === 'final_output').map(event => event.turnId))
    .toEqual(['business-turn', 'compact-click']);
});

it('queues a compact IPC while the ordinary input flush owns submission', async () => {
  const backend = { write: vi.fn(() => true) };
  const worker = rawWorker(createMinimaxAdapter('/not-executed'), backend);
  Object.assign(worker.scope, {
    isFlushing: true, currentBotmuxTurnId: 'business-turn',
    unattendedRawInputRefusal: () => undefined, discardDeploymentContinuation() {},
    refreshHookReviewInputHold() {}, hookReviewAdmissionScreen: () => '', nativeSessionForkPending: () => false,
    firstWriteLivenessConfirmed: true, openingInputBoxSettled: true, startupCommandAckHold: null,
    sessionRenameInFlight: () => false, shouldHoldCodexRunnerInput: () => false,
    shouldDeferUserFlush: () => false, codexModelMigrationHoldsRawInput: () => false,
    freshnessInputQueue: { enqueueRaw: (msg: unknown) => worker.scope.pendingRawInputs.push(msg) },
  });
  const compact = { type: 'raw_input', content: '/compact', turnId: 'compact-click' };
  await loadWorkerMessageHandler('raw_input', worker.scope)(compact);
  expect(worker.scope.pendingRawInputs).toEqual([compact]);
  expect(worker.scope.currentBotmuxTurnId).toBe('business-turn');
  expect(backend.write).not.toHaveBeenCalled();
});
