import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { InflightInputTracker } from '../src/core/inflight-input-tracker.js';
import { isRemoteBackendType } from '../src/core/persistent-backend.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { settleStaleWriteContinuation } from '../src/services/submit-confirmation.js';
import {
  dropNoReplayPendingInputsOnBackendExit,
  handoffQueuedDurableInputsOnBackendExit,
  type PendingCliInput,
} from '../src/utils/pending-input-queue.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';

const SID = '019dd80d-d922-7a11-8339-0208d8c5b4ee';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function prewriteHarness(item: PendingCliInput, onPrecheck?: (scope: Record<string, any>) => void) {
  const home = mkdtempSync(join(tmpdir(), 'botmux-prewrite-lifecycle-'));
  dirs.push(home);
  vi.stubEnv('CODEX_HOME', home);
  writeFileSync(join(home, 'history.jsonl'), '');
  const h = workerSubmitHarness();
  const adapter = createCodexAdapter();
  const tracker = new InflightInputTracker();
  const viewport = 'Previous conversation\n› Implement {feature}\n\n  gpt-5.6-sol default · ~/data';
  const backend = {
    write: vi.fn(), submitBracketedPaste: vi.fn(), kill: vi.fn(),
    captureInputState: () => {
      onPrecheck?.(h.scope);
      return { viewport, cursor: { x: 2, y: 1 } };
    },
  };
  const staleSettlement = vi.fn(settleStaleWriteContinuation);
  h.scope.pendingMessages.splice(0, h.scope.pendingMessages.length, item);
  Object.assign(h.scope, {
    backend,
    inflightInputs: tracker,
    cliAdapter: { ...adapter, writeInput: vi.fn(adapter.writeInput) },
    lastInitConfig: { cliId: 'codex', backendType: 'tmux', promptInjection: 'none' },
    effectiveBackendType: 'tmux',
    isRemoteBackendType,
    cancelRetiredRuntimeExit: vi.fn(),
    closeRequested: false,
    beginCliWriteCycle: vi.fn(),
    settleStaleWriteContinuation: staleSettlement,
    captureBackendScreen: () => viewport,
    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    openingInputBoxSettled: true,
    inputBoxJudgeable: () => false,
    deferTurnInputCommitUntilSubmission: () => false,
    maybeQueuePostSubmitNativeSessionTitle: () => false,
    stampMojoTurnMark: vi.fn(),
    currentBotmuxTurnId: item.turnId,
    currentBotmuxDispatchAttempt: item.dispatchAttempt,
    currentCodexObservedPid: () => 12345,
    durableTurnInFlight: false,
  });
  return { h, item, backend, tracker, staleSettlement };
}

function expectNoPaste(h: ReturnType<typeof workerSubmitHarness>, backend: { submitBracketedPaste: ReturnType<typeof vi.fn> }) {
  expect(backend.submitBracketedPaste).not.toHaveBeenCalled();
  expect(h.scope.durableTurnInFlight).not.toBe(true);
}

describe('Codex deferred-precheck lifecycle ownership', () => {
  it('does not revive a durable attempt after backend-exit handoff', async () => {
    const item: PendingCliInput = { content: 'durable payload', turnId: 'durable-turn', dispatchAttempt: 1 };
    let handedOff: PendingCliInput[] = [];
    const { h, item: exact, backend, tracker, staleSettlement } = prewriteHarness(item, scope => {
      handedOff = handoffQueuedDurableInputsOnBackendExit(scope.pendingMessages, { intentionalRestart: false });
      scope.backend = null;
    });

    await h.flush();

    expect(handedOff).toEqual([exact]);
    expect(h.scope.pendingMessages).toEqual([]);
    tracker.onCliExit();
    expect(tracker.takeCarryOver()).toEqual([]);
    expect(staleSettlement).not.toHaveBeenCalled();
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
    expectNoPaste(h, backend);
  });

  it('does not revive a noReplay item dropped by backend exit', async () => {
    const item: PendingCliInput = { content: 'at most once', turnId: 'no-replay-turn', noReplay: true };
    let dropped: PendingCliInput[] = [];
    const { h, item: exact, backend, staleSettlement } = prewriteHarness(item, scope => {
      dropped = dropNoReplayPendingInputsOnBackendExit(scope.pendingMessages, { intentionalRestart: false });
      scope.backend = null;
    });

    await h.flush();

    expect(dropped).toEqual([exact]);
    expect(h.scope.pendingMessages).toEqual([]);
    expect(staleSettlement).not.toHaveBeenCalled();
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
    expectNoPaste(h, backend);
  });

  it('lets the startup circuit terminalize the prewrite item instead of resurrecting it', async () => {
    const item: PendingCliInput = { content: 'startup payload', turnId: 'startup-turn' };
    const { h, backend, staleSettlement } = prewriteHarness(item, scope => {
      scope.backend = null;
      scope.stopStartupFailedInputs();
    });
    Object.assign(h.scope, {
      stopScreenUpdates: vi.fn(), stopStuckDetector: vi.fn(), stopSpawnArgvTurnStartFailOpen: vi.fn(),
      crashDiagnosticStopped: false, cliRestartEpoch: 1,
      sendFatalWorkerErrorAndExit: vi.fn(async () => {}),
    });
    h.scope.stopStartupFailedInputs = loadWorkerFunction('stopStartupFailedInputs', h.scope);

    await h.flush();

    expect(h.scope.pendingMessages).toEqual([]);
    expect(staleSettlement).not.toHaveBeenCalled();
    expect(h.scope.emitTurnTerminal).toHaveBeenCalledWith(
      'startup-turn', 'failed', 'cli_startup_failed', undefined, undefined, false,
    );
    expectNoPaste(h, backend);
  });

  it('keeps a tokened activation queued without ACK across the startup circuit', async () => {
    const item: PendingCliInput = { content: 'activation payload', turnId: 'activation-turn', queuedActivationToken: 'activation-token' };
    const { h, item: exact, backend } = prewriteHarness(item, scope => {
      scope.backend = null;
      scope.stopStartupFailedInputs();
    });
    Object.assign(h.scope, {
      stopScreenUpdates: vi.fn(), stopStuckDetector: vi.fn(), stopSpawnArgvTurnStartFailOpen: vi.fn(),
      crashDiagnosticStopped: false, cliRestartEpoch: 1,
      sendFatalWorkerErrorAndExit: vi.fn(async () => {}),
    });
    h.scope.stopStartupFailedInputs = loadWorkerFunction('stopStartupFailedInputs', h.scope);

    await h.flush();

    expect(h.scope.pendingMessages).toEqual([exact]);
    expect(h.scope.send.mock.calls.filter(([event]: [any]) => event.type === 'queued_activation_submitted')).toEqual([]);
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
    expectNoPaste(h, backend);
  });

  it('does not resurrect an item cleared by a non-preserving killCli', async () => {
    const item: PendingCliInput = { content: 'kill payload', turnId: 'kill-turn' };
    const { h, backend, staleSettlement } = prewriteHarness(item);
    h.scope.idleDetector.dispose = vi.fn();
    Object.assign(h.scope, {
      stopNativeSessionTitleSync: vi.fn(), stopSessionMcpGatewayHost: vi.fn(),
      stopCodexRpcEngine: vi.fn(), cleanupCodexAppControlBootstrap: vi.fn(),
      stopCodexAppControlChannel: vi.fn(), destroyCrashDiagnosticTerminal: vi.fn(),
      stopReattachIdleProbe: vi.fn(), stopBusyPatternIdleProbe: vi.fn(),
      cancelTurnTerminalReadyRecovery: vi.fn(), stopStructuredStartGraceRecheck: vi.fn(),
      stopSpawnArgvTurnStartFailOpen: vi.fn(), stopStuckDetector: vi.fn(),
      clearPostHookEvidenceFallback: vi.fn(),
      stopScreenUpdates: vi.fn(), stopBridgeWatcher: vi.fn(), stopCodexBridge: vi.fn(),
      completeManagedTurnOriginRevocation: vi.fn(), cleanupPiInitialPromptFiles: vi.fn(),
      codexAppTurnLiveness: { clear: vi.fn() }, codexAppReadyAuthority: { reset: vi.fn() },
      ptyOutputGeneration: { reset: vi.fn(), snapshot: () => 0 },
      activeTurnAuthority: new ActiveTurnAuthority(),
      clearBackgroundHoldTimer: vi.fn(), appRunnerControlDecoder: { reset: vi.fn() },
      codexUpdateDialogGuard: { reset: vi.fn() },
      retiredTurnIds: new Set(), submittedCodexAppReplyTurnIds: new Set(),
      pendingCodexAppSteerAckIds: new Set(), acknowledgedCodexAppSteers: new Set(),
      inFlightKeepaliveFingerprints: new Set(),
      resetCodexModelMigrationState: vi.fn(), disarmSwitchConfirm: vi.fn(), disarmBtwCapture: vi.fn(),
    });
    let killError: unknown;
    h.scope.forceClearSessionRenameInFlight = loadWorkerFunction('forceClearSessionRenameInFlight', h.scope);
    const kill = loadWorkerFunction<(opts: { preservePending?: boolean }) => void>('killCli', h.scope);
    h.scope.killCli = (opts: { preservePending?: boolean }) => {
      try { kill(opts); } catch (error) { killError = error; throw error; }
    };
    backend.captureInputState = () => {
      h.scope.killCli({ preservePending: false });
      return {
        viewport: 'Previous conversation\n› Implement {feature}\n\n  gpt-5.6-sol default · ~/data',
        cursor: { x: 2, y: 1 },
      };
    };

    await h.flush();

    expect((killError as Error | undefined)?.stack).toBeUndefined();
    expect(h.scope.pendingMessages, JSON.stringify(h.scope.log.mock.calls)).toEqual([]);
    expect(staleSettlement).not.toHaveBeenCalled();
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
    expectNoPaste(h, backend);
  });

  it('expires the exact prewrite durable item before it can be pasted', async () => {
    const item: PendingCliInput = { content: 'expiring payload', turnId: 'expiring-turn', dispatchAttempt: 7 };
    let expiry!: Promise<void>;
    const { h, backend } = prewriteHarness(item, scope => {
      expiry = loadWorkerMessageHandler('expire_durable_turn', scope)({
        type: 'expire_durable_turn', turnId: 'expiring-turn', dispatchAttempt: 7,
      });
    });
    h.scope.retireCodexAppDispatchForDurableReplay = vi.fn(async () => true);
    h.scope.restartCliProcess = vi.fn(async () => {});

    await h.flush();
    await expiry;

    expect(h.scope.pendingMessages).toEqual([]);
    expect(h.scope.retireCodexAppDispatchForDurableReplay).toHaveBeenCalledWith('expiring-turn', 7);
    expect(h.scope.send).toHaveBeenCalledWith({
      type: 'durable_expiry_ready', sessionId: 'test-session', turnId: 'expiring-turn',
      dispatchAttempt: 7, disposition: 'queued_removed',
    });
    expect(h.scope.restartCliProcess).not.toHaveBeenCalled();
    expectNoPaste(h, backend);
  });

  it('restores the exact FIFO item and withholds the ACK when the durable retire ledger refuses', async () => {
    const item: PendingCliInput = { content: 'expiring payload', turnId: 'expiring-turn', dispatchAttempt: 7 };
    // No flush: drive the expire handler directly so the queue outcome is not
    // racy with a concurrent precheck/beforeSubmit consuming the same item.
    const { h, item: exact } = prewriteHarness(item);
    expect(h.scope.pendingMessages).toEqual([exact]);
    h.scope.retireCodexAppDispatchForDurableReplay = vi.fn(async () => false);

    await loadWorkerMessageHandler('expire_durable_turn', h.scope)({
      type: 'expire_durable_turn', turnId: 'expiring-turn', dispatchAttempt: 7,
    });

    // The ledger refused: the item must be back at its FIFO position and no
    // removal ACK may escape (the daemon fences the unproven expiry itself).
    expect(h.scope.pendingMessages).toEqual([exact]);
    expect(h.scope.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'durable_expiry_ready',
      disposition: 'queued_removed',
    }));
  });

  it.each([
    { name: 'ordinary', item: { content: 'ordinary survives', turnId: 'om_ordinary' } },
    { name: 'durable', item: { content: 'durable survives', turnId: 'durable-turn', dispatchAttempt: 3 } },
  ])('retains a $name input when the Web wire dirties during preparation', async ({ item }) => {
    let dirty = false;
    const { h, item: exact, backend } = prewriteHarness(item, () => { dirty = true; });
    h.scope.webTerminalInputWireDirty = () => dirty;

    await h.flush();

    expect(backend.submitBracketedPaste).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toEqual([exact]);
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
  });

  it('does not paste after the real close branch fences writes but is still awaiting ACK flush', async () => {
    vi.useFakeTimers();
    let closePromise: Promise<void> | undefined;
    const { h, backend } = prewriteHarness(
      { content: 'must not write during close', turnId: 'om_close' },
      scope => {
        if (!closePromise) closePromise = loadWorkerMessageHandler('close', scope)({ type: 'close' });
      },
    );
    h.scope.sendAndFlush = vi.fn(() => new Promise<void>(() => {}));

    const flushing = h.flush();
    await vi.advanceTimersByTimeAsync(3_300);
    await flushing;

    expect(h.scope.closeRequested).toBe(true);
    expect(h.scope.sendAndFlush).toHaveBeenCalledWith({ type: 'session_close_ready', sessionId: 'test-session' });
    expect(backend.submitBracketedPaste).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toHaveLength(1);
  });
});
