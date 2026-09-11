/** Execute the worker's real swap and input-fence functions without importing
 * its process entry point. Process, RPC, and terminal readiness are boundaries
 * controlled by this harness; the ordering and failure gates are production code. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexExecutable, CodexProcess } from '../src/services/codex-session-upgrade.js';

const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
const parsed = ts.createSourceFile('worker.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function extracted(name: string): string {
  const declaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement)
    && statement.name?.text === name);
  if (!declaration) throw new Error(`Missing worker function: ${name}`);
  return ts.transpileModule(declaration.getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

type Upgrade = (target: CodexExecutable, running: CodexProcess[]) => Promise<void>;

function evaluate<T>(name: string, state: Record<string, any>): T {
  // A separate lexical scope per harness keeps mutable worker globals isolated.
  // eslint-disable-next-line no-new-func
  return new Function('state', `with (state) { ${extracted(name)}; return ${name}; }`)(state) as T;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const target: CodexExecutable = { path: '/runtime/new/codex', version: '0.153.4', fingerprint: 'new-file' };
const oldProcesses: CodexProcess[] = [{ path: '/runtime/old/codex', version: '0.146.0', fingerprint: 'old-file', pid: 101, started: 'old-birth' }];
const replacement: CodexProcess[] = [{ ...target, pid: 201, started: 'new-birth' }];
const threadId = '01a07a8a-134d-7bb1-bf6c-af19f14f3f4f';

function harness() {
  const steps: string[] = [];
  const delivered: unknown[] = [];
  const state: Record<string, any> = {
    config: { autoUpgradeCodexSessions: true },
    lastInitConfig: {
      cliId: 'codex', cliSessionId: threadId, sessionId: 'botmux-session',
      workingDir: '/project', prompt: 'previous already executed prompt',
      env: { CODEX_TEST_SETTING: 'original' },
      resume: false, forkSession: true, model: 'gpt-6-astra', reasoningEffort: 'high',
      nativeSessionTitle: 'Old title', nativeSessionTitlePrompt: 'rename instructions',
    },
    remoteThreadId: undefined,
    codexAutoUpgrade: undefined,
    cliRestartInProgress: false,
    replacementSpawnInProgress: false,
    rawInputRestartGate: false,
    cliSpawnGeneration: 9,
    intentionalRestartBackend: undefined,
    awaitingFirstPrompt: false,
    isPromptReady: true,
    tmuxRestartTimer: undefined,
    isFlushing: false,
    injectionFlushing: false,
    commandLineWritesPending: 0,
    initialInputOwnershipPending: false,
    pendingMessages: [], pendingRawInputs: [], pendingInjections: [], pendingAdoptMessages: [],
    sessionRenameInFlight: () => false,
    pendingSessionRename: undefined,
    durableTurnInFlight: undefined,
    tuiPromptBlocking: false,
    hookReviewInputHold: false,
    bareShellCheckInProgress: false,
    ambiguousSubmissionRecoveryHold: undefined,
    submitFailureChains: { size: () => 0 },
    codexAppTurnLiveness: { hasActiveTurn: () => false },
    codexAppCompletionAwaitingFinal: false,
    codexAppTurnDispatchQueue: { size: () => 0 },
    codexAppRecoveredDispatches: [],
    hasStructuredLifecycleBlock: () => false,
    wsClients: new Set(), clientPtys: new Map(),
    codexUpgradeInspectionBlock: undefined,
    codexRunnerFreshness: 'current',
    shouldHoldCodexRunnerInput: () => false,
    cliAdapter: {},
    hasPendingInputForFlush: vi.fn(() => false),
    log: vi.fn(),
    send: vi.fn(),
    sandboxEnabled: () => false,
    setTimeout,
    clearTimeout,
  };
  const oldBackend = { destroySession: vi.fn(async () => { steps.push('destroy'); }) };
  state.backend = oldBackend;
  state.killCli = vi.fn(() => {
    steps.push('kill');
    state.backend = null;
    state.remoteThreadId = undefined;
  });
  state.waitForCodexExit = vi.fn(async () => { steps.push('exit confirmed'); });
  state.codexRpcEligible = vi.fn(() => false);
  state.createCliAdapterSync = vi.fn(() => ({ id: 'codex' }));
  state.prepareCliPluginGenerationAndGateway = vi.fn(async () => { steps.push('plugins'); });
  state.engageCodexRpc = vi.fn(async () => {
    steps.push('rpc resume');
    state.remoteThreadId = threadId;
    return 'resumed';
  });
  state.startScreenUpdates = vi.fn();
  state.startStuckDetector = vi.fn();
  state.spawnCli = vi.fn(async (_cfg: unknown) => {
    steps.push('spawn');
    state.backend = { generation: 'replacement' };
    state.isPromptReady = false;
  });
  state.inspectCodexUpgradeRuntime = vi.fn(async () => {
    steps.push('inspect replacement');
    return replacement;
  });
  state.findCodexRolloutSetByPid = vi.fn(() => {
    steps.push('verify thread fd');
    return new Set([threadId]);
  });
  state.codexUpgradeBlocked = evaluate<() => string | undefined>('codexUpgradeBlocked', state);
  state.releaseRawInputRestartGate = evaluate<() => void>('releaseRawInputRestartGate', state);
  state.flushPendingInjections = vi.fn(async () => {
    steps.push('injections flush requested');
    expect(state.cliRestartInProgress).toBe(false);
    expect(state.rawInputRestartGate).toBe(false);
  });
  const realFlush = evaluate<() => Promise<void>>('flushPending', state);
  state.flushPending = vi.fn(async () => {
    steps.push('flush requested');
    // Execute the production entrypoint to prove an armed fence returns before
    // even consulting queued work. Actual CLI delivery is outside this harness.
    await realFlush();
    if (!state.cliRestartInProgress) delivered.push(...state.pendingMessages.splice(0));
  });
  const upgrade = evaluate<Upgrade>('autoUpgradeCodex', state);
  const ready = () => {
    state.isPromptReady = true;
    state.awaitingFirstPrompt = false;
    state.codexAutoUpgrade?.ready?.();
  };
  const run = () => upgrade(target, oldProcesses).then(() => undefined, error => error as Error);
  return { state, oldBackend, steps, delivered, upgrade, ready, run, realFlush };
}

async function settleMicrotasks(): Promise<void> {
  // Boundaries in autoUpgradeCodex deliberately await several independent
  // promises. No timers or real worker processes are needed to advance them.
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}

describe('worker ready-time Codex runtime version observation', () => {
  function observationHarness() {
    const state: Record<string, any> = {
      backend: { name: 'observed-backend' },
      cliSpawnGeneration: 3,
      cliRestartInProgress: false,
      codexAutoUpgrade: undefined,
      inspectCodexUpgradeRuntime: vi.fn(async () => replacement),
      send: vi.fn(),
    };
    const observe = evaluate<() => Promise<void>>('observeCodexRuntimeVersionOnReady', state);
    return { state, observe };
  }

  it('publishes the observed version after all running Codex processes agree', async () => {
    const h = observationHarness();
    h.state.inspectCodexUpgradeRuntime.mockResolvedValue([
      replacement[0], { ...replacement[0], pid: 202 },
    ]);
    const done = h.observe();
    expect(h.state.send).not.toHaveBeenCalled();
    await done;
    expect(h.state.send).toHaveBeenCalledExactlyOnceWith({ type: 'cli_runtime_version', version: '0.153.4' });
  });

  it.each(['generation-changed', 'backend-replaced', 'backend-exited'] as const)('discards an asynchronous observation after %s', async change => {
    const h = observationHarness();
    const inspected = deferred<CodexProcess[]>();
    h.state.inspectCodexUpgradeRuntime.mockImplementationOnce(() => inspected.promise);
    const done = h.observe();
    expect(h.state.inspectCodexUpgradeRuntime).toHaveBeenCalledTimes(1);
    if (change === 'generation-changed') h.state.cliSpawnGeneration++;
    else if (change === 'backend-replaced') h.state.backend = { name: 'new-backend' };
    else h.state.backend = null;
    inspected.resolve(replacement);
    await done;
    expect(h.state.send).not.toHaveBeenCalled();
  });

  it.each(['cliRestartInProgress', 'codexAutoUpgrade'] as const)('does not publish past the %s validation fence', async fence => {
    const h = observationHarness();
    const inspected = deferred<CodexProcess[]>();
    h.state.inspectCodexUpgradeRuntime.mockImplementationOnce(() => inspected.promise);
    const done = h.observe();
    h.state[fence] = fence === 'cliRestartInProgress' ? true : { stage: 'restoring', threadId };
    inspected.resolve(replacement);
    await done;
    expect(h.state.send).not.toHaveBeenCalled();
  });

  it('does not publish an observation that began without a live backend', async () => {
    const h = observationHarness();
    h.state.backend = null;
    await h.observe();
    expect(h.state.send).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'empty process list', processes: [] },
    { name: 'mixed running versions', processes: [replacement[0], oldProcesses[0]] },
  ])('rejects $name without reporting a version', async ({ processes }) => {
    const h = observationHarness();
    h.state.inspectCodexUpgradeRuntime.mockResolvedValue(processes);
    await expect(h.observe()).rejects.toThrow('Running Codex processes do not identify a single version');
    expect(h.state.send).not.toHaveBeenCalled();
  });

  it('propagates an inspection failure for caller logging without publishing a version', async () => {
    const h = observationHarness();
    const failure = new Error('runtime process identity is unavailable');
    h.state.inspectCodexUpgradeRuntime.mockRejectedValue(failure);
    await expect(h.observe()).rejects.toBe(failure);
    expect(h.state.send).not.toHaveBeenCalled();
  });
});

describe('worker Codex session automatic upgrade', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('leaves a configured CLI launcher in control of its runtime', async () => {
    const h = harness();
    h.state.lastInitConfig.wrapperCli = 'custom-launcher codex';
    expect(await h.run()).toEqual(new Error('a configured CLI wrapper controls the runtime'));
    expect(h.oldBackend.destroySession).not.toHaveBeenCalled();
    expect(h.state.spawnCli).not.toHaveBeenCalled();
    expect(h.state.cliRestartInProgress).toBe(false);
  });

  it('preserves a hook-review prompt and can upgrade after the hold is released', async () => {
    const h = harness();
    h.state.hookReviewInputHold = true;
    expect(h.state.codexUpgradeBlocked()).toBeDefined();
    expect(await h.run()).toBeInstanceOf(Error);
    expect(h.oldBackend.destroySession).not.toHaveBeenCalled();
    expect(h.state.killCli).not.toHaveBeenCalled();
    expect(h.state.spawnCli).not.toHaveBeenCalled();
    expect(h.state.cliRestartInProgress).toBe(false);
    expect(h.state.rawInputRestartGate).toBe(false);

    h.state.hookReviewInputHold = false;
    const done = h.run();
    await settleMicrotasks();
    expect(h.state.spawnCli).toHaveBeenCalledTimes(1);
    h.ready();
    expect(await done).toBeUndefined();
  });

  it('confirms old CLI exit before spawning a replacement and resumes exactly the original thread', async () => {
    const h = harness();
    h.state.lastInitConfig.cliPathOverride = '/configured/codex';
    const originalConfig = h.state.lastInitConfig;
    const destroyed = deferred<void>();
    const exited = deferred<void>();
    h.oldBackend.destroySession.mockImplementationOnce(() => destroyed.promise);
    h.state.waitForCodexExit.mockImplementationOnce(() => exited.promise);
    const done = h.run();
    expect(h.state.cliRestartInProgress).toBe(true);
    expect(h.state.rawInputRestartGate).toBe(true);
    expect(h.state.cliSpawnGeneration).toBe(10);
    expect(h.state.replacementSpawnInProgress).toBe(false);
    expect(h.state.intentionalRestartBackend).toBe(h.oldBackend);
    expect(h.state.killCli).not.toHaveBeenCalled();
    destroyed.resolve();
    await settleMicrotasks();
    expect(h.state.killCli).toHaveBeenCalledWith({
      preservePending: true, preservePolicyCapability: true, preserveInjections: true,
    });
    expect(h.state.waitForCodexExit).toHaveBeenCalledWith(oldProcesses);
    expect(h.state.spawnCli).not.toHaveBeenCalled();
    exited.resolve();
    await settleMicrotasks();
    expect(h.state.spawnCli).toHaveBeenCalledTimes(1);
    expect(h.state.replacementSpawnInProgress).toBe(true);
    expect(h.state.spawnCli).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'botmux-session', workingDir: '/project', cliId: 'codex',
      resume: true, cliSessionId: threadId, prompt: '', forkSession: false,
      cliPathOverride: target.path, model: undefined, reasoningEffort: undefined,
      nativeSessionTitle: undefined, nativeSessionTitlePrompt: undefined,
    }), { pluginGenerationPrepared: false });
    expect(h.state.inspectCodexUpgradeRuntime).not.toHaveBeenCalled();
    h.ready();
    expect(await done).toBeUndefined();
    expect(h.state.replacementSpawnInProgress).toBe(false);
    expect(h.state.lastInitConfig).toBe(originalConfig);
    expect(h.state.lastInitConfig.cliPathOverride).toBe('/configured/codex');
    expect(h.state.send).toHaveBeenCalledWith({ type: 'cli_runtime_version', version: '0.153.4' });
  });

  it('holds newly arriving inputs until readiness and runtime/thread fd verification both finish', async () => {
    const h = harness();
    const inspected = deferred<CodexProcess[]>();
    h.state.inspectCodexUpgradeRuntime.mockImplementationOnce(() => inspected.promise);
    const done = h.run();
    await settleMicrotasks();
    expect(h.state.replacementSpawnInProgress).toBe(true);
    const pending = { turnId: 'new-turn', text: 'follow up arriving during restore' };
    h.state.pendingMessages.push(pending);
    await h.realFlush();
    expect(h.state.hasPendingInputForFlush).not.toHaveBeenCalled();
    expect(h.state.pendingMessages).toEqual([pending]);
    expect(h.state.flushPending).not.toHaveBeenCalled();
    expect(h.state.flushPendingInjections).not.toHaveBeenCalled();
    h.ready();
    await settleMicrotasks();
    expect(h.state.inspectCodexUpgradeRuntime).toHaveBeenCalledTimes(1);
    expect(h.state.replacementSpawnInProgress).toBe(true);
    await h.realFlush();
    expect(h.state.hasPendingInputForFlush).not.toHaveBeenCalled();
    expect(h.state.findCodexRolloutSetByPid).not.toHaveBeenCalled();
    expect(h.state.rawInputRestartGate).toBe(true);
    inspected.resolve(replacement);
    expect(await done).toBeUndefined();
    await settleMicrotasks();
    expect(h.state.findCodexRolloutSetByPid).toHaveBeenCalledWith(201);
    expect(h.state.cliRestartInProgress).toBe(false);
    expect(h.state.rawInputRestartGate).toBe(false);
    expect(h.state.codexAutoUpgrade).toBeUndefined();
    expect(h.state.replacementSpawnInProgress).toBe(false);
    expect(h.state.flushPendingInjections).toHaveBeenCalledTimes(1);
    expect(h.state.flushPending).toHaveBeenCalledTimes(1);
    expect(h.state.hasPendingInputForFlush).toHaveBeenCalledTimes(1);
    expect(h.steps.indexOf('verify thread fd')).toBeLessThan(h.steps.indexOf('flush requested'));
    expect(h.steps.indexOf('verify thread fd')).toBeLessThan(h.steps.indexOf('injections flush requested'));
    expect(h.steps.indexOf('injections flush requested')).toBeLessThan(h.steps.indexOf('flush requested'));
    expect(h.delivered).toEqual([pending]);
  });

  it('keeps accepted inputs and failure gates when old CLI exit cannot be confirmed, with no fresh retry', async () => {
    const h = harness();
    const exited = deferred<void>();
    h.state.waitForCodexExit.mockImplementationOnce(() => exited.promise);
    const done = h.run();
    await settleMicrotasks();
    const pending = { text: 'accepted while stopping' };
    h.state.pendingMessages.push(pending);
    exited.reject(new Error('old Codex is still alive'));
    expect(await done).toEqual(new Error('old Codex is still alive'));
    expect(h.state.codexAutoUpgrade).toEqual({ stage: 'failed', threadId });
    expect(h.state.cliRestartInProgress).toBe(true);
    expect(h.state.rawInputRestartGate).toBe(true);
    expect(h.state.replacementSpawnInProgress).toBe(false);
    await h.realFlush();
    expect(h.state.pendingMessages).toEqual([pending]);
    expect(h.state.spawnCli).not.toHaveBeenCalled();
    expect(h.state.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'user_notify' }));
    expect(await h.run()).toBeInstanceOf(Error);
    expect(h.oldBackend.destroySession).toHaveBeenCalledTimes(1);
    expect(h.state.spawnCli).not.toHaveBeenCalled();
  });

  it('does not retry a failed spawn as a fresh thread or flush accepted input', async () => {
    const h = harness();
    const spawned = deferred<void>();
    h.state.spawnCli.mockImplementationOnce(() => spawned.promise);
    const done = h.run();
    await settleMicrotasks();
    h.state.pendingMessages.push({ text: 'keep this turn' });
    spawned.reject(new Error('resume failed'));
    expect(await done).toEqual(new Error('resume failed'));
    expect(h.state.codexAutoUpgrade).toEqual({ stage: 'failed', threadId });
    expect(h.state.replacementSpawnInProgress).toBe(false);
    expect(h.state.pendingMessages).toEqual([{ text: 'keep this turn' }]);
    expect(h.state.flushPending).not.toHaveBeenCalled();
    expect(await h.run()).toBeInstanceOf(Error);
    expect(h.state.spawnCli).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails a replacement that never becomes ready without starting another CLI', async () => {
    const h = harness();
    const done = h.run();
    await settleMicrotasks();
    h.state.pendingMessages.push({ text: 'queued until ready' });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await done).toEqual(new Error('New Codex did not become ready'));
    expect(h.state.pendingMessages).toEqual([{ text: 'queued until ready' }]);
    expect(h.state.codexAutoUpgrade.stage).toBe('failed');
    expect(h.state.cliRestartInProgress).toBe(true);
    expect(h.state.replacementSpawnInProgress).toBe(false);
    expect(h.state.spawnCli).toHaveBeenCalledTimes(1);
    expect(h.state.inspectCodexUpgradeRuntime).not.toHaveBeenCalled();
    expect(h.state.flushPending).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'wrong version', runtime: [{ ...replacement[0]!, version: '0.146.0' }], fds: [threadId] },
    { name: 'wrong thread fd', runtime: replacement, fds: ['another-thread'] },
    { name: 'shared thread fd owner', runtime: replacement, fds: [threadId, 'another-thread'] },
    { name: 'missing replacement PID', runtime: [], fds: [threadId] },
  ])('keeps inputs fenced after readiness when validation finds $name', async ({ runtime, fds }) => {
    const h = harness();
    h.state.inspectCodexUpgradeRuntime.mockResolvedValue(runtime);
    h.state.findCodexRolloutSetByPid.mockReturnValue(new Set(fds));
    const done = h.run();
    await settleMicrotasks();
    h.state.pendingMessages.push({ text: 'must stay queued' });
    h.ready();
    expect(await done).toEqual(new Error('Replacement Codex runtime or thread identity did not match'));
    expect(h.state.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'cli_runtime_version' }));
    await h.realFlush();
    expect(h.state.pendingMessages).toEqual([{ text: 'must stay queued' }]);
    expect(h.state.codexAutoUpgrade.stage).toBe('failed');
    expect(h.state.cliRestartInProgress).toBe(true);
    expect(h.state.rawInputRestartGate).toBe(true);
    expect(h.state.replacementSpawnInProgress).toBe(false);
    expect(h.state.flushPending).not.toHaveBeenCalled();
    expect(h.state.flushPendingInjections).not.toHaveBeenCalled();
  });

  it.each(['workingDir', 'env'] as const)('rejects a concurrent %s change before releasing accepted input', async field => {
    const h = harness();
    const done = h.run();
    await settleMicrotasks();
    h.state.pendingMessages.push({ text: 'keep this accepted turn' });
    h.state.pendingInjections.push({ kind: 'cwd', cwd: '/new-project' });
    if (field === 'workingDir') h.state.lastInitConfig.workingDir = '/new-project';
    else h.state.lastInitConfig.env = { CODEX_TEST_SETTING: 'changed' };
    h.ready();
    expect(await done).toEqual(new Error('Session launch settings changed during upgrade; restart is required'));
    expect(h.state.codexAutoUpgrade).toEqual({ stage: 'failed', threadId });
    expect(h.state.cliRestartInProgress).toBe(true);
    expect(h.state.rawInputRestartGate).toBe(true);
    expect(h.state.replacementSpawnInProgress).toBe(false);
    expect(h.state.pendingMessages).toEqual([{ text: 'keep this accepted turn' }]);
    expect(h.state.pendingInjections).toEqual([{ kind: 'cwd', cwd: '/new-project' }]);
    expect(h.state.flushPending).not.toHaveBeenCalled();
    expect(h.state.flushPendingInjections).not.toHaveBeenCalled();
  });

  it('restores RPC ownership and plugin generation before spawning the original thread viewer', async () => {
    const h = harness();
    h.state.codexRpcEligible.mockReturnValue(true);
    const done = h.run();
    await settleMicrotasks();
    expect(h.state.engageCodexRpc).toHaveBeenCalledWith(expect.objectContaining({
      cliSessionId: threadId, resume: true, prompt: '', forkSession: false,
    }));
    expect(h.steps.indexOf('plugins')).toBeLessThan(h.steps.indexOf('rpc resume'));
    expect(h.steps.indexOf('rpc resume')).toBeLessThan(h.steps.indexOf('spawn'));
    expect(h.state.spawnCli).toHaveBeenCalledWith(expect.anything(), { pluginGenerationPrepared: true });
    h.ready();
    expect(await done).toBeUndefined();
  });

  it.each([
    { outcome: 'not-engaged', remote: threadId },
    { outcome: 'started', remote: threadId },
    { outcome: 'resumed', remote: 'wrong-thread' },
  ])('rejects RPC restoration outcome $outcome / $remote before spawning', async ({ outcome, remote }) => {
    const h = harness();
    h.state.codexRpcEligible.mockReturnValue(true);
    h.state.engageCodexRpc.mockImplementation(async () => {
      h.state.remoteThreadId = remote;
      h.state.pendingMessages.push({ text: 'accepted while RPC reconnects' });
      return outcome;
    });
    expect(await h.run()).toEqual(new Error('Codex RPC did not resume the original thread'));
    expect(h.state.spawnCli).not.toHaveBeenCalled();
    expect(h.state.flushPending).not.toHaveBeenCalled();
    expect(h.state.pendingMessages).toEqual([{ text: 'accepted while RPC reconnects' }]);
    expect(h.state.cliRestartInProgress).toBe(true);
    expect(h.state.rawInputRestartGate).toBe(true);
    expect(h.state.replacementSpawnInProgress).toBe(false);
    expect(h.state.flushPendingInjections).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
