/**
 * The worker's hc branches, executed from src/worker.ts through the function
 * harness (helpers/worker-function-harness.ts) against injected globals: hc
 * must reach its own branch at every backend-naming site, never a tmux or
 * pty fallthrough.
 */
import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { WebSocket } from 'ws';
import { classifyRestartTeardown } from '../src/adapters/backend/destroy-result.js';
import { hcDiagnosticTarget, type HcTarget } from '../src/adapters/backend/hc/cli-ops.js';
import { HcBackend } from '../src/adapters/backend/hc-backend.js';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { isRemoteBackendType, resolvePersistentBackendTarget } from '../src/core/persistent-backend.js';
import { decideRestartFollowup, restartLaunchSettings } from '../src/core/restart-followup-policy.js';
import { restartSpendsFreshBudget } from '../src/core/restart-fresh-budget.js';
import { InputDeliveryEvidenceTracker } from '../src/services/input-delivery-evidence.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';

const SID = '0123abcd-4567-89ef-0123-456789abcdef';
const TARGET: HcTarget = { backendType: 'hc', sessionName: 'bmx-0123abcd', hcSession: 'botmux-x', socket: '/tmp/bmhc-x/herdr-core/botmux-x.sock' };

function client(open = true) {
  return { readyState: open ? WebSocket.OPEN : WebSocket.CLOSED, send: vi.fn() };
}

describe('persistent pane lookups', () => {
  function paneInfo(probe: string) {
    const probePersistentBackendTarget = vi.fn(() => probe);
    const fn = loadWorkerFunction<(type: string, sid: string, target?: unknown) => { name: string; live: boolean } | null>(
      'persistentPaneInfo', { resolvePersistentBackendTarget, probePersistentBackendTarget },
    );
    return { result: fn('hc', SID, TARGET), probePersistentBackendTarget };
  }

  it("probes the recorded hc terminal and reads only an authoritative 'missing' as gone", () => {
    const unknown = paneInfo('unknown');
    expect(unknown.result).toEqual({ name: TARGET.sessionName, live: true });
    expect(unknown.probePersistentBackendTarget).toHaveBeenCalledWith(TARGET);
    expect(paneInfo('exists').result).toEqual({ name: TARGET.sessionName, live: true });
    expect(paneInfo('missing').result).toEqual({ name: TARGET.sessionName, live: false });
  });

  it('falls back to the name-only probe when no target is recorded', () => {
    const probePersistentSession = vi.fn(() => 'missing');
    const probePersistentBackendTarget = vi.fn();
    const probe = loadWorkerFunction<(type: string, name: string, target?: unknown) => string>(
      'persistentPaneProbe', { probePersistentSession, probePersistentBackendTarget },
    );
    expect(probe('hc', 'bmx-0123abcd')).toBe('gone');
    expect(probePersistentSession).toHaveBeenCalledWith('hc', 'bmx-0123abcd');
    expect(probePersistentBackendTarget).not.toHaveBeenCalled();
  });
});

describe('Codex instance binding on hc', () => {
  const refuse = (cfg: Record<string, unknown>, daemonBackend = 'tmux') => loadWorkerFunction<(cfg: unknown) => void>(
    'refuseUnverifiableInstanceBinding', { config: { daemon: { backendType: daemonBackend } } },
  )(cfg);
  const binding = { source: 'pool', codexHome: '/codex/instance-1' };

  it('refuses a bound hc session, including one that inherits hc from the daemon default', () => {
    expect(() => refuse({ backendType: 'hc', cliInstanceBinding: binding })).toThrow(/backendType 改回 tmux/);
    expect(() => refuse({ cliInstanceBinding: binding }, 'hc')).toThrow(/backendType 改回 tmux/);
  });

  it('leaves tmux, legacy and unbound sessions alone', () => {
    expect(() => refuse({ backendType: 'tmux', cliInstanceBinding: binding })).not.toThrow();
    expect(() => refuse({ backendType: 'hc', cliInstanceBinding: { ...binding, source: 'legacy' } })).not.toThrow();
    expect(() => refuse({ backendType: 'hc' })).not.toThrow();
  });
});

describe('terminal input cancels a deployment continuation on hc', () => {
  it('asks the daemon to cancel before the input is written', async () => {
    const send = vi.fn();
    const receipts = new Map<string, (ok: boolean) => void>();
    const cancel = loadWorkerFunction<() => Promise<boolean>>('cancelDeploymentForTerminalInput', {
      nativeSessionForkPending: () => false,
      lastInitConfig: { cliId: 'codex', adoptMode: false, codexRpcInput: false },
      effectiveBackendType: 'hc',
      discardDeploymentContinuation: vi.fn(),
      deploymentCancellationReceipts: receipts,
      randomBytes,
      send,
    });
    const pending = cancel();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'cancel_deployment_continuation' }));
    const { requestId } = send.mock.calls[0][0];
    receipts.get(requestId)!(true);
    await expect(pending).resolves.toBe(true);
  });
});

describe('Codex App generation kill on hc', () => {
  it('passes the session id to the name-only kill so hc can check the owner label', () => {
    const killPersistentSession = vi.fn();
    const killPersistentBackendTarget = vi.fn();
    loadWorkerFunction<(sid: string, name: string) => void>('killCodexAppGenerationPane', {
      lastInitConfig: {},
      effectiveBackendType: 'hc',
      killPersistentSession,
      killPersistentBackendTarget,
    })(SID, 'bmx-0123abcd');
    expect(killPersistentSession).toHaveBeenCalledWith('hc', 'bmx-0123abcd', SID);
    expect(killPersistentBackendTarget).not.toHaveBeenCalled();
  });
});

describe('web clients of an owned hc pane', () => {
  it('re-pins read-only followers to the pane grid', () => {
    const reader = client();
    const writer = client();
    const closed = client(false);
    const scope = {
      effectiveBackendType: 'hc',
      isPipeMode: true,
      lastInitConfig: { adoptMode: false },
      backend: { getPaneSize: () => ({ cols: 132, rows: 41 }) },
      wsClients: new Set([reader, writer, closed]),
      authedClients: new Set([writer]),
      WebSocket,
    };
    loadWorkerFunction<() => void>('broadcastOwnedPaneReadOnlyFollowerGrid', scope)();
    expect(reader.send).toHaveBeenCalledWith('\x1b]1989;follower;132;41\x07');
    expect(writer.send).not.toHaveBeenCalled();
    expect(closed.send).not.toHaveBeenCalled();
  });

  it('replaces every view with a reattach paint, re-asserting input modes for write clients', () => {
    const reader = client();
    const writer = client();
    const scope: Record<string, any> = {
      scrollback: 'stale bytes',
      MAX_SCROLLBACK: 1_000_000,
      backend: { capturePaneInputModes: () => '\x1b[?2004h' },
      wsClients: new Set([reader, writer]),
      authedClients: new Set([writer]),
      WebSocket,
    };
    loadWorkerFunction<(snapshot: string) => void>('relayHcWebSnapshot', scope)('history\r\nscreen');
    expect(scope.scrollback).toBe('history\r\nscreen');
    expect(reader.send).toHaveBeenCalledWith('\x1b]1989;history;0\x07history\r\nscreen');
    expect(writer.send).toHaveBeenCalledWith('\x1b]1989;history;0\x07history\r\nscreen\x1b[?2004h');
  });

  it('keeps the relay scrollback bounded at a line boundary', () => {
    const scope: Record<string, any> = {
      scrollback: '', MAX_SCROLLBACK: 10, backend: null, wsClients: new Set(), authedClients: new Set(), WebSocket,
    };
    loadWorkerFunction<(snapshot: string) => void>('relayHcWebSnapshot', scope)('first line\nsecond\nthird');
    expect(scope.scrollback).toBe('\x1bcthird');
  });
});

describe('crash diagnostic terminal on hc', () => {
  const diag = hcDiagnosticTarget(TARGET, SID);

  function parkScope(over: Record<string, unknown> = {}) {
    const scope: Record<string, any> = {
      lastInitConfig: { adoptMode: false, workingDir: '/project', persistentBackendTarget: TARGET },
      sessionId: SID,
      effectiveBackendType: 'hc',
      crashDiagnosticPath: () => '/fixture/crash-diagnostics/sid.ansi',
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
      dirname,
      tailChars: (text: string, max: number) => text.slice(-max),
      scrollback: 'LAST CLI OUTPUT',
      CRASH_DIAGNOSTIC_RAW_MAX: 1_000,
      cliName: () => 'codex',
      hcDiagnosticTarget,
      parkHcDiagnosticTerminal: vi.fn(),
      renderCols: 120,
      renderRows: 40,
      PTY_COLS: 80,
      PTY_ROWS: 24,
      stopScreenUpdates: vi.fn(),
      stopStuckDetector: vi.fn(),
      log: vi.fn(),
      crashDiagnosticHcTarget: undefined,
      isTmuxMode: false,
      isPipeMode: true,
      TmuxBackend: { parkDiagnosticSession: vi.fn(() => true), diagnosticSessionName: (sid: string) => `bmx-diag-${sid}` },
      preferredManagedTmuxSocket: vi.fn(),
      ...over,
    };
    scope.canParkCrashDiagnostic = loadWorkerFunction<() => boolean>('canParkCrashDiagnostic', scope);
    return scope;
  }

  it('is parkable only on the recorded core of a non-adopted session', () => {
    expect(parkScope().canParkCrashDiagnostic()).toBe(true);
    expect(parkScope({ lastInitConfig: { persistentBackendTarget: undefined } }).canParkCrashDiagnostic()).toBe(false);
    expect(parkScope({ lastInitConfig: { adoptMode: true, persistentBackendTarget: TARGET } }).canParkCrashDiagnostic()).toBe(false);
    expect(parkScope({ effectiveBackendType: 'pty' }).canParkCrashDiagnostic()).toBe(false);
  });

  it("parks bmx-diag-<sid8> on the session's core with the captured output and keeps pipe mode", () => {
    const scope = parkScope();
    const parked = loadWorkerFunction<(code: number | null, signal: string | null) => boolean>('parkCrashDiagnosticTerminal', scope)(1, null);
    expect(parked).toBe(true);
    expect(scope.parkHcDiagnosticTerminal).toHaveBeenCalledWith(
      { ...TARGET, sessionName: 'bmx-diag-0123abcd' }, SID,
      { cwd: '/project', cols: 120, rows: 40, contentPath: '/fixture/crash-diagnostics/sid.ansi' },
    );
    expect(scope.writeFileSync.mock.calls[0][1]).toContain('LAST CLI OUTPUT');
    expect(scope.crashDiagnosticHcTarget).toEqual(diag);
    expect(scope.stopScreenUpdates).toHaveBeenCalled();
    expect(scope.TmuxBackend.parkDiagnosticSession).not.toHaveBeenCalled();
    expect([scope.isTmuxMode, scope.isPipeMode]).toEqual([false, true]);
  });

  it('reports a failed park and drops the captured file', () => {
    const scope = parkScope({ parkHcDiagnosticTerminal: vi.fn(() => { throw new Error('hc 终端名已被占用'); }) });
    const parked = loadWorkerFunction<(code: number | null, signal: string | null) => boolean>('parkCrashDiagnosticTerminal', scope)(1, null);
    expect(parked).toBe(false);
    expect(scope.unlinkSync).toHaveBeenCalledWith('/fixture/crash-diagnostics/sid.ansi');
    expect(scope.crashDiagnosticHcTarget).toBeUndefined();
    expect(scope.TmuxBackend.parkDiagnosticSession).not.toHaveBeenCalled();
  });

  it('destroys the parked terminal through the label-checked kill', () => {
    for (const outcome of [{ result: 'killed', address: 't3' }, { result: 'mismatch', address: 't3', owner: 'other' }]) {
      const scope: Record<string, any> = {
        crashDiagnosticStopped: true,
        crashDiagnosticHcTarget: diag,
        crashDiagnosticTmuxParked: false,
        sessionId: SID,
        killHcTerminal: vi.fn(() => outcome),
        crashDiagnosticPath: () => '/fixture/crash-diagnostics/sid.ansi',
        unlinkSync: vi.fn(),
        log: vi.fn(),
        TmuxBackend: { killSession: vi.fn() },
      };
      loadWorkerFunction<(reason: string) => void>('destroyCrashDiagnosticTerminal', scope)('retry');
      expect(scope.killHcTerminal).toHaveBeenCalledWith(diag, SID);
      expect(scope.crashDiagnosticHcTarget).toBeUndefined();
      expect(scope.crashDiagnosticStopped).toBe(false);
      expect(scope.unlinkSync).toHaveBeenCalledWith('/fixture/crash-diagnostics/sid.ansi');
      expect(scope.TmuxBackend.killSession).not.toHaveBeenCalled();
    }
  });
});

describe('restart on hc', () => {
  it('staggers the teardown like tmux: one core serves every session', async () => {
    const timers: Array<{ fn: () => unknown; ms: number }> = [];
    const scope: Record<string, any> = {
      codexAutoUpgrade: undefined,
      lastInitConfig: { cliId: 'claude-code', sessionId: 'sid', workingDir: '/project', resume: false },
      cliSpawnGeneration: 1,
      submitFailureChains: { clear: vi.fn() },
      inputDeliveryEvidence: new InputDeliveryEvidenceTracker(),
      queuedActivationReceipts: { clear: vi.fn() },
      cliRestartInProgress: false,
      replacementSpawnInProgress: false,
      restartWindowLaunch: undefined,
      rawInputRestartGate: false,
      consecutiveInWorkerRestarts: 2,
      lastCliExitServerReplaced: false,
      restartSpendsFreshBudget,
      tmuxRestartTimer: null,
      tmuxRestartJitterMs: vi.fn(() => 1_234),
      remoteThreadId: undefined,
      intentionalRestartBackend: undefined,
      effectiveBackendType: 'hc',
      awaitingFirstPrompt: false,
      isPromptReady: true,
      pendingLaunchConvergence: undefined,
      codexRpcEngine: undefined,
      classifyRestartTeardown,
      isRemoteBackendType,
      decideRestartFollowup,
      restartLaunchSettings,
      CliSpawnSupersededError: class extends Error {},
      log: vi.fn(),
      revokeManagedTurnOriginForRestart: vi.fn(),
      traexAutoModelController: { noteProcessExited: vi.fn() },
      stopOwnedSessionScope: vi.fn(),
      startScreenUpdates: vi.fn(),
      startStuckDetector: vi.fn(),
      adoptPendingLaunchConvergence: vi.fn(),
      codexRpcEligible: () => false,
      traexAutoModelRuntimeEligible: () => false,
      traexAutoModelSwitching: false,
      sandboxEnabled: () => false,
      prepareCodexNativeTitleGeneration: vi.fn(async () => {}),
      settleRestartAttemptOnReady: vi.fn(),
      releaseRawInputRestartGate: vi.fn(),
      flushPending: vi.fn(async () => {}),
      sendFatalWorkerErrorAndExit: vi.fn(async () => {}),
      clearTimeout: vi.fn(),
      setTimeout: (fn: () => unknown, ms: number) => { timers.push({ fn, ms }); return { unref() {} }; },
    };
    scope.backend = { destroySession: vi.fn() };
    scope.killCli = vi.fn(() => { scope.backend = null; scope.isPromptReady = false; });
    scope.spawnCli = vi.fn(async () => { scope.backend = { generation: 'replacement' }; });
    await loadWorkerFunction<(reason: string) => Promise<void>>('restartCliProcess', scope)('daemon request');

    expect(scope.tmuxRestartJitterMs).toHaveBeenCalledWith('sid', scope.consecutiveInWorkerRestarts);
    expect(timers.map(t => t.ms)).toEqual([1_234]);
    expect(scope.killCli).not.toHaveBeenCalled();
    await timers.shift()!.fn();
    expect(scope.killCli).toHaveBeenCalled();
  });
});

describe('Codex cleanup target on hc', () => {
  it('publishes the archive target of a worker-owned local Codex thread', () => {
    const publishCliSessionIdToDaemon = vi.fn(() => true);
    const launch = { codexBin: '/usr/bin/codex', codexHome: '/home/u/.codex' };
    loadWorkerFunction<(id: string) => void>('persistCliSessionId', {
      nativeSessionForkPending: () => false,
      publishCliSessionIdToDaemon,
      lastInitConfig: { cliId: 'codex', backendType: 'hc', adoptMode: false, wrapperCli: undefined, sandbox: false },
      codexCleanupLaunchTarget: launch,
      sessionId: SID,
      currentBotmuxTurnId: undefined,
      currentBotmuxDispatchAttempt: undefined,
      send: vi.fn(),
      log: vi.fn(),
    })('thread-1');
    expect(publishCliSessionIdToDaemon).toHaveBeenCalledWith(expect.objectContaining({
      codexCleanupTarget: { threadId: 'thread-1', ...launch },
    }));
  });
});

describe('native effort controls admit hc', () => {
  function effortScope(backendType: string) {
    const send = vi.fn();
    return {
      send,
      scope: {
        backend: { id: 'live' },
        codexBridgeRolloutPath: '/fixture/rollout.jsonl',
        publishedActiveRuntime: { model: 'gpt-5.5' },
        cliLifetimeNonce: 1,
        lastInitConfig: { cliId: 'codex', backendType, wrapperCli: undefined, adoptMode: false, sandbox: false, readIsolation: false },
        codexRpcEngine: undefined,
        sandboxBoolValue: () => false,
        sandboxEnabled: () => false,
        sessionRenameInFlight: () => false,
        sessionRenamePhase: 'idle',
        isFlushing: false,
        injectionFlushing: false,
        commandLineWritesPending: 0,
        cliRestartInProgress: false,
        pendingMessages: [],
        pendingRawInputs: [],
        bareShellCheckInProgress: false,
        bareShellLaunchBlocked: false,
        tuiPromptBlocking: false,
        shouldHoldCodexRunnerInput: () => false,
        codexRunnerFreshness: undefined,
        codexCliEffortOperation: undefined,
        codexCliEffortRecovery: undefined,
        statSync: () => { throw new Error('ENOENT'); },
        log: vi.fn(),
        send,
      },
    };
  }

  it('lets an hc Codex session past worker admission to the native menu', async () => {
    for (const [backendType, status] of [['hc', 'error'], ['tmux', 'error'], ['zellij', 'unavailable']] as const) {
      const { scope, send } = effortScope(backendType);
      await loadWorkerMessageHandler('codex_cli_effort', scope)({ type: 'codex_cli_effort', requestId: 'r1', deadline: Date.now() + 5_000 });
      expect(send, backendType).toHaveBeenCalledWith(expect.objectContaining({ type: 'codex_cli_effort_result', status }));
    }
  });

  it('validates a TraeX topic effort restart on hc instead of refusing it outright', async () => {
    for (const [backendType, validated] of [['hc', true], ['zellij', false]] as const) {
      const validateTraexTopicEffortRestart = vi.fn(() => undefined);
      const send = vi.fn();
      await loadWorkerMessageHandler('restart', {
        lastInitConfig: { cliId: 'traex', backendType, sandbox: false, readIsolation: false },
        backend: { id: 'live' },
        isPromptReady: true,
        cliRestartInProgress: false,
        tmuxRestartTimer: null,
        isFlushing: false,
        injectionFlushing: false,
        commandLineWritesPending: 0,
        pendingMessages: [],
        pendingRawInputs: [],
        sandboxBoolValue: () => false,
        sandboxEnabled: () => false,
        validateTraexTopicEffortRestart,
        captureBackendScreen: () => 'screen',
        send,
      })({ type: 'restart', topicEffort: 'high', attemptId: 'a1' });
      expect(validateTraexTopicEffortRestart.mock.calls.length > 0, backendType).toBe(validated);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'restart_result', attemptId: 'a1', status: 'failed' }));
    }
  });
});

describe('TraeX first-prompt readiness on hc', () => {
  async function check(observed: object) {
    const capture = vi.fn(async () => 'READY COMPOSER');
    Object.assign(observed, { captureViewportAsync: capture });
    const detector = { observeStartupHistory: vi.fn(() => true), seedReadyEvidence: vi.fn() };
    vi.useFakeTimers();
    try {
      loadWorkerFunction<(backend: unknown) => void>('scheduleTraexFirstPromptReadiness', {
        lastInitConfig: { cliId: 'traex' },
        backendScreenEvidenceIsAuthoritativeForMutation: () => true,
        idleDetector: detector,
        cliAdapter: { startupReadyFromHistory: (screen: string) => screen === 'READY COMPOSER' },
        cliSpawnGeneration: 1,
        webTerminalInputGeneration: 1,
        awaitingFirstPrompt: true,
        backend: observed,
        renderer: { writeAndFlush: async () => {}, rawSnapshot: () => 'footer drawn before the attach' },
        inflightInputs: { hasUnacked: () => false },
        lastPtyOutputAtMs: 0,
        backendScreenRevision: 1,
        ptyOutputGeneration: { snapshot: () => 1, isCurrent: () => true },
        FIRST_PROMPT_HARD_TIMEOUT_MS: 90_000,
        TmuxPipeBackend,
        HcBackend,
        effectiveBackendType: 'hc',
        cliName: () => 'traex',
        log: vi.fn(),
      })(observed);
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      vi.useRealTimers();
    }
    return { capture, detector };
  }

  it('reads the composer from the hc terminal when the stream missed its first paint', async () => {
    const { capture, detector } = await check(Object.create(HcBackend.prototype));
    expect(capture).toHaveBeenCalled();
    expect(detector.observeStartupHistory).toHaveBeenCalledWith('READY COMPOSER');
    expect(detector.seedReadyEvidence).toHaveBeenCalledWith(true);
  });

  it('reads no native viewport from a backend without one', async () => {
    const { capture, detector } = await check({});
    expect(capture).not.toHaveBeenCalled();
    expect(detector.seedReadyEvidence).not.toHaveBeenCalled();
  });
});
