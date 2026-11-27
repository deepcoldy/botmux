import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as context from '../src/core/traex-native-context.js';
import { CodexRpcDeliveryError, CodexRpcEngine } from '../src/codex-rpc-engine.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { TurnExecutionClock } from '../src/services/turn-execution-clock.js';
import { pendingInputMayFlush } from '../src/utils/pending-input-queue.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const prompt = (role: string, text: string) =>
  `<role>${role}</role>\n\n<user_message>${text}</user_message>`;

type SendTurnOpts = { onDispatch?: () => void } | undefined;
/** A healthy app-server: the frame leaves (onDispatch) and turn/start is ACKed. */
const acceptingSendTurn = (nativeTurnId = 'native') =>
  vi.fn(async (_text: string, _identity: unknown, opts?: SendTurnOpts) => {
    opts?.onDispatch?.();
    return { nativeTurnId };
  });
/** The frame left, then the response was lost. */
const ambiguousSendTurn = () =>
  vi.fn(async (_text: string, _identity: unknown, opts?: SendTurnOpts) => {
    opts?.onDispatch?.();
    throw new CodexRpcDeliveryError('no response', 'rpc_turn_start_ambiguous', 'ambiguous');
  });

function rpcHarness() {
  const h = workerSubmitHarness();
  Object.assign(h.scope, context, {
    CodexRpcDeliveryError,
    lastInitConfig: { cliId: 'traex', codexRpcInput: true, cliSessionId: 'thread' },
    codexRpcEngine: {
      activeThreadId: 'thread', activeNativeTurnId: undefined,
      canSteerTurn: () => false,
      sendTurn: acceptingSendTurn(),
    },
    rpcTurnsAwaitingActivation: new Map(), rpcActiveOwners: new Map(),
    settlingRpcTerminalOwners: new Map(), rpcTerminalHydrationOwners: new Map(),
    installAwaitingRpcActivation: vi.fn(),
    clearAwaitingRpcActivation: vi.fn(),
    runAfterAmbiguousSubmissionWrites: async (_backend: unknown, action: () => unknown) => action(),
    acknowledgeNativeInputConsumed: vi.fn(),
    activateRpcTurnLifecycle: vi.fn(() => true),
    codexBridgeDrainAndMaybeEmit: vi.fn(),
    awaitingRpcActivationReplayAnchorMs: () => 1,
    installRpcLifecycleFailClosedOwner: vi.fn(),
    settleSubmission: vi.fn(),
    deferTurnInputCommitUntilSubmission: () => false,
    maybeQueuePostSubmitNativeSessionTitle: () => false,
    stampMojoTurnMark: vi.fn(),
  });
  h.scope.hybridRpcInputMaySteer = loadWorkerFunction('hybridRpcInputMaySteer', h.scope);
  h.scope.rpcTurnOwnerKey = loadWorkerFunction('rpcTurnOwnerKey', h.scope);
  h.scope.hybridRpcTurnBlocksAdministrativeInput = loadWorkerFunction('hybridRpcTurnBlocksAdministrativeInput', h.scope);
  h.scope.publishTraexNativeContextReceipt = loadWorkerFunction('publishTraexNativeContextReceipt', h.scope);
  h.scope.invalidateTraexNativeContextReceipt = loadWorkerFunction('invalidateTraexNativeContextReceipt', h.scope);
  return h;
}

/** A real engine whose app-server socket closed after flushPending captured it. */
function deadSocketEngine() {
  const engine = new CodexRpcEngine({ cliBin: '/nonexistent', cwd: '/tmp', env: {}, sessionId: 'sid' } as any);
  (engine as any).threadId = 'thread';
  (engine as any).ws = { readyState: 3, send: () => { throw new Error('socket closed'); } };
  return engine;
}

/** Real per-turn submission bookkeeping, so a half-committed write is observable. */
function withRealSubmissionScope(h: ReturnType<typeof rpcHarness>) {
  const scope = new WorkerSessionEventScope({ appId: 'cli_app', sessionId: 'sid' } as any, { workerId: 'w1', generation: 1 } as any);
  const binding = scope.beginRuntime();
  scope.assign(binding.bindingId, { runtimeId: 'rt', epoch: 1 });
  h.scope.workerSessionEventScope = scope;
  h.scope.turnExecutionClock = new TurnExecutionClock();
  h.scope.markTurnExecutionStart = loadWorkerFunction('markTurnExecutionStart', h.scope);
}

describe('actual worker TraeX RPC write edge', () => {
  it('publishes accepted context only after the native ACK', async () => {
    const h = rpcHarness();
    h.scope.pendingMessages[0].content = prompt('A', 'hello');
    await h.flush();
    expect(h.scope.codexRpcEngine.sendTurn, JSON.stringify(h.scope.log.mock.calls)).toHaveBeenCalledTimes(1);
    expect(h.scope.lastInitConfig.traexNativeContextReceipt).toMatchObject({
      nativeThreadId: 'thread', turnId: 'delivery', status: 'accepted',
    });
  });

  it('keeps the exact FIFO head when a native turn is still active', async () => {
    const h = rpcHarness();
    h.scope.codexRpcEngine.activeNativeTurnId = 'running';
    h.scope.pendingMessages[0].content = prompt('A', 'hello');
    const head = h.scope.pendingMessages[0];
    await h.flush();
    expect(h.scope.codexRpcEngine.sendTurn).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages[0]).toBe(head);
    expect(h.scope.lastInitConfig.traexNativeContextReceipt).toBeUndefined();
    expect(h.scope.installRpcLifecycleFailClosedOwner).not.toHaveBeenCalled();
  });

  it('omits an accepted role only at the RPC write edge and fingerprints the sent text', async () => {
    const h = rpcHarness();
    const accepted = context.settleTraexNativeContextReceipt(
      context.prepareTraexNativeContext(prompt('A', 'first'), 'thread'), 'om_first', 'accepted',
    )!;
    h.scope.lastInitConfig.traexNativeContextReceipt = accepted;
    h.scope.pendingMessages[0].content = prompt('A', 'hello');
    await h.flush();
    const sent = h.scope.codexRpcEngine.sendTurn.mock.calls[0]?.[0];
    expect(sent).toBe('<user_message>hello</user_message>');
    // The transcript bridge must match the user record the thread recorded.
    expect(h.scope.activateRpcTurnLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'delivery' }), sent, false, expect.anything(),
    );
  });

  it('resends the full fixed context after an unknown receipt instead of parking the FIFO', async () => {
    const h = rpcHarness();
    h.scope.lastInitConfig.traexNativeContextReceipt = context.settleTraexNativeContextReceipt(
      context.prepareTraexNativeContext(prompt('A', 'lost?'), 'thread'), 'om_unknown', 'unknown',
    );
    h.scope.pendingMessages[0].content = prompt('A', 'hello');
    await h.flush();
    expect(h.scope.codexRpcEngine.sendTurn).toHaveBeenCalledTimes(1);
    expect(h.scope.codexRpcEngine.sendTurn.mock.calls[0][0]).toBe(prompt('A', 'hello'));
    expect(h.scope.pendingMessages).toHaveLength(0);
    expect(h.scope.send.mock.calls.filter(([m]: any[]) => m.type === 'user_notify')).toHaveLength(0);
    expect(h.scope.lastInitConfig.traexNativeContextReceipt).toMatchObject({
      nativeThreadId: 'thread', turnId: 'delivery', status: 'accepted',
    });
  });

  it('records an ambiguous turn/start as unknown, then resends the full context on the next write', async () => {
    const h = rpcHarness();
    const acceptedA = context.settleTraexNativeContextReceipt(
      context.prepareTraexNativeContext(prompt('A', 'first'), 'thread'), 'om_first', 'accepted',
    );
    h.scope.lastInitConfig.traexNativeContextReceipt = acceptedA;
    h.scope.codexBridgeMarkPendingTurn = vi.fn((_text: string, turnId: string) => turnId);
    h.scope.restartCliProcess = vi.fn();
    const ambiguous = ambiguousSendTurn();
    const write = async (turnId: string, content: string) => {
      h.scope.pendingMessages.push({ turnId, dispatchAttempt: 1, content });
      h.scope.isPromptReady = true;
      await h.flush();
    };
    h.scope.pendingMessages.length = 0;

    // Accepted role A is omitted; the fallback attribution must fingerprint
    // the text that was actually dispatched, and nothing new is unknown.
    h.scope.codexRpcEngine.sendTurn = ambiguous;
    await write('om_a', prompt('A', 'hello'));
    expect(ambiguous.mock.calls[0][0]).toBe('<user_message>hello</user_message>');
    expect(h.scope.codexBridgeMarkPendingTurn).toHaveBeenLastCalledWith(
      '<user_message>hello</user_message>', 'om_a', 1, expect.anything(),
    );
    expect(h.scope.lastInitConfig.traexNativeContextReceipt).toBe(acceptedA);

    // A changed role rides an ambiguous turn: its acceptance becomes unknown.
    await write('om_b', prompt('B', 'switch'));
    expect(ambiguous.mock.calls[1][0]).toBe(prompt('B', 'switch'));
    expect(h.scope.lastInitConfig.traexNativeContextReceipt).toMatchObject({ turnId: 'om_b', status: 'unknown' });

    // Without proof the thread holds B, the next write sends it in full.
    h.scope.codexRpcEngine.sendTurn = acceptingSendTurn('native-2');
    await write('om_c', prompt('B', 'again'));
    expect(h.scope.codexRpcEngine.sendTurn.mock.calls[0]?.[0]).toBe(prompt('B', 'again'));
    expect(h.scope.pendingMessages).toHaveLength(0);
    expect(h.scope.lastInitConfig.traexNativeContextReceipt).toMatchObject({ turnId: 'om_c', status: 'accepted' });
  });

  it('fails an over-budget turn terminally without sending or truncating it', async () => {
    const h = rpcHarness();
    h.scope.pendingMessages[0].content = prompt('X'.repeat(context.TRAEX_INITIAL_FIXED_CONTEXT_BUDGET_BYTES), 'hello');
    await h.flush();
    expect(h.scope.codexRpcEngine.sendTurn).not.toHaveBeenCalled();
    expect(h.scope.emitTurnTerminal).toHaveBeenCalledWith('delivery', 'failed', 'traex_fixed_context_budget_exceeded', 1);
    expect(h.scope.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'user_notify', turnId: 'delivery' }));
    expect(h.scope.pendingMessages).toHaveLength(0);
    expect(h.scope.lastInitConfig.traexNativeContextReceipt).toBeUndefined();
  });

  it.each([
    { kind: 'ordinary', dispatchAttempt: undefined },
    { kind: 'durable', dispatchAttempt: 1 },
  ])('retains a $kind head whose frame never left a dead socket and delivers it after the restart', async ({ dispatchAttempt }) => {
    const h = rpcHarness();
    withRealSubmissionScope(h);
    h.scope.pendingInputMayFlush = pendingInputMayFlush;
    h.scope.durableTurnInFlight = false;
    h.scope.codexRpcEngine = deadSocketEngine();
    h.scope.pendingMessages.length = 0;
    const item = { turnId: 'om_retained', content: prompt('A', 'hello'), ...(dispatchAttempt ? { dispatchAttempt } : {}) };
    h.scope.pendingMessages.push(item);
    await h.flush();
    expect(h.scope.pendingMessages[0]).toBe(item);
    // Nothing about this turn may be committed before its frame exists.
    expect(h.scope.send.mock.calls.some(([m]: any[]) => m.type === 'turn_execution_started')).toBe(false);
    expect(h.scope.durableTurnInFlight).toBe(false);

    h.scope.codexRpcEngine = { activeThreadId: 'thread', activeNativeTurnId: undefined, sendTurn: acceptingSendTurn('native-2') };
    h.scope.cliSpawnGeneration += 1;
    h.scope.isPromptReady = true;
    await h.flush();
    expect(h.scope.codexRpcEngine.sendTurn).toHaveBeenCalledTimes(1);
    expect(h.scope.send.mock.calls.filter(([m]: any[]) => m.type === 'turn_input_rejected')).toEqual([]);
    expect(h.scope.pendingMessages).toHaveLength(0);
  });

  it('resends the role after native compaction invalidates an accepted receipt', async () => {
    const h = rpcHarness();
    h.scope.lastInitConfig.traexNativeContextReceipt = context.settleTraexNativeContextReceipt(
      context.prepareTraexNativeContext(prompt('A', 'first'), 'thread'), 'om_first', 'accepted',
    );
    h.scope.invalidateTraexNativeContextReceipt('other-thread');
    expect(h.scope.lastInitConfig.traexNativeContextReceipt.status).toBe('accepted');

    h.scope.invalidateTraexNativeContextReceipt('thread');
    expect(h.scope.lastInitConfig.traexNativeContextReceipt).toMatchObject({ nativeThreadId: 'thread', status: 'unknown' });
    expect(h.scope.send).toHaveBeenCalledWith({
      type: 'traex_native_context_receipt',
      receipt: expect.objectContaining({ nativeThreadId: 'thread', status: 'unknown' }),
    });
    h.scope.pendingMessages[0].content = prompt('A', 'after compaction');
    await h.flush();
    expect(h.scope.codexRpcEngine.sendTurn.mock.calls[0][0]).toBe(prompt('A', 'after compaction'));
  });

  it('folds a catalog parked for RPC back into the text when the write falls back to paste', async () => {
    const h = rpcHarness();
    h.scope.codexRpcEngine = undefined;
    Object.assign(h.scope.pendingMessages[0], {
      content: prompt('A', 'hello'),
      traexSkillCatalog: '<botmux_skills_refresh>catalog</botmux_skills_refresh>',
      traexSkillCatalogDigest: 'catalog-version',
    });
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.scope.cliAdapter.writeInput.mock.calls[0][1]).toBe(
      `${prompt('A', 'hello')}\n\n<botmux_skills_refresh>catalog</botmux_skills_refresh>`,
    );
  });

  it('routes a deferred catalog through context accounting, not blind concatenation', () => {
    const h = rpcHarness();
    Object.assign(h.scope, {
      deferredPluginSkillCatalog: '<botmux_skills>catalog</botmux_skills>',
      deferredPluginSkillCatalogDigest: 'catalog-version',
      deferredPluginSkillCatalogFingerprint: 'fingerprint',
    });
    const attach = loadWorkerFunction('attachDeferredPluginSkillCatalog', h.scope);
    const item = { content: prompt('A', 'hello') };
    attach(item);
    expect(item).toMatchObject({
      content: prompt('A', 'hello'),
      traexSkillCatalog: '<botmux_skills>catalog</botmux_skills>',
      traexSkillCatalogDigest: 'catalog-version',
    });
  });
});

/** Run the real engageCodexRpc against a fake app-server. Unlisted worker
 * globals throw instead of resolving to undefined, so a new dependency fails
 * loudly rather than silently skipping a branch. */
function engageHarness(opts: {
  resume?: boolean;
  firstOutcome?: 'accepted' | 'not-sent' | 'ambiguous';
  receipt?: context.TraexNativeContextReceipt;
  startGates?: Array<Promise<void>>;
  stopAndWaitOutcome?: 'false' | 'throw';
}) {
  const engines: any[] = [];
  class FakeEngine {
    appServerPid: number;
    wsUrl = 'ws://127.0.0.1:1';
    activeThreadId: string | undefined;
    stop = vi.fn();
    stopAndWait = vi.fn(async () => {
      if (opts.stopAndWaitOutcome === 'throw') throw new Error('live descendant');
      return opts.stopAndWaitOutcome === 'false' ? false : true;
    });
    sendFirstTurn = vi.fn(async () => ({
      outcome: opts.firstOutcome ?? 'accepted',
      ...(opts.firstOutcome === 'accepted' || !opts.firstOutcome ? { nativeTurnId: 'native-1' } : {}),
    }));
    private readonly index: number;
    constructor(readonly opts: any) {
      this.index = engines.length;
      this.appServerPid = 4242 + this.index;
      engines.push(this);
    }
    async start() {
      await opts.startGates?.[this.index];
      this.opts.onAppServerSpawn?.(this.appServerPid);
    }
    async startThread() { this.activeThreadId = 'thread-fresh'; return 'thread-fresh'; }
    async resumeThread(id: string) { this.activeThreadId = id; return id; }
  }
  const noop = () => undefined;
  const lease = {
    occupantId: 'occupant-a',
    domain: { domainKey: 'domain-a', registryPath: '/registry', skillsDir: '/skills', lockPath: '/lock' },
    snapshot: {
      traexPath: '/snapshots/combo-a/traex', helperPath: '/snapshots/combo-a/helper',
      dir: '/snapshots/combo-a', comboKey: 'combo-a', snapshot: true,
    },
    markRunning: vi.fn(async () => {}),
    markUnknown: vi.fn(async () => {}),
    markDeathUnproven: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    abandon: vi.fn(async () => {}),
  };
  const base: Record<string, any> = {
    ...context,
    CodexRpcEngine: FakeEngine,
    CliSpawnSupersededError: class extends Error {},
    CodexRpcEngineDiedDuringEngagementError: class extends Error {},
    randomBytes, currentBotmuxTurnId: undefined, followBotTraeHome: noop, larkUserNative: noop, homedir: () => '/home/fake', join: (...parts: string[]) => parts.join('/'),
    codexRpcEligible: () => true, sandboxEnabled: () => false,
    stopCodexRpcEngine: vi.fn(),
    traexLaunchUsesSharedRuntimeGate: () => true,
    resolveCommandEntry: (path: string) => path,
    resolveCommandReal: (path: string) => path,
    releaseDirForExecutable: (path: string) => `${path}/..`,
    resolveTraexChildHome: () => '/home/trae',
    daemonBirthIdentity: () => ({ daemonPid: 1, daemonStart: 'boot' }),
    readProcessStartIdentity: (pid: number) => `start-${pid}`,
    resolveInstallIdentity: () => ({}),
    applyTraexRuntimeOwnershipEnv: (env: NodeJS.ProcessEnv, lease: any) => {
      env.BOTMUX_TRAEX_OCCUPANT_ID = lease.occupantId;
      env.BOTMUX_TRAEX_DOMAIN_KEY = lease.domain.domainKey;
    },
    acquireTraexRuntimeLease: vi.fn(async () => ({ kind: 'granted', lease })),
    rpcEngagementFence: { begin: () => 1, isCurrent: () => true, isLive: () => true, markDead: noop },
    closeRequested: false,
    cancelledQueuedTurnIds: new Set(),
    pendingRpcEngagement: undefined,
    traexRpcLeaseContext: undefined,
    traexRuntimeLeaseContext: undefined,
    traexSpawnLeaseContext: undefined,
    traexLeaseSettlements: new Set(),
    pendingTraexSpawnAbandon: undefined,
    cliSpawnGeneration: 1,
    createCliAdapterSync: () => ({ resolvedBin: '/bin/traex' }),
    // RPC hook-trust gating (PR #3515): the engine reads the global toggle and
    // probes the CLI version during engageCodexRpc. Stub both so the harness does
    // not exec the fake resolvedBin and keeps a deterministic supported verdict.
    config: { bypassCodexHookTrust: true },
    probeTraexHookTrustSupport: () => ({ status: 'supported' as const }),
    buildSessionChildEnv: () => ({}),
    prependBotmuxBin: (_dir: string, path: string | undefined) => path,
    resolveBotmuxWrapperBinDir: () => '/bin',
    sessionMcpGatewayHost: null,
    MCP_GATEWAY_SOCKET_ENV: 'MCP_SOCKET', MCP_GATEWAY_REQUIRED_ENV: 'MCP_REQUIRED',
    botInjectedEnv: () => ({}), clearBotmuxPromptEnv: noop, applyCodexInstanceEnv: noop,
    applySessionOwnerEnv: noop, usesLarkToolBinding: () => false, isWorkflowWorker: () => false,
    cleanupLarkToolBinding: noop, resolveIdentityStorageModel: () => 'none',
    prepareTurnGitConfigEnv: noop, parseDaemonIpcPort: noop, prepareLarkToolEnv: noop,
    workerCliExecutionReport: () => undefined,
    protectedMcpRedactedEnvKeys: () => [], traexNativeSubagentHookConfig: noop,
    nativeSubagentRuntimeHookCommand: noop, bridgeCodexUserInput: noop, handleRpcTurnTerminal: noop,
    codexCleanupLaunchTarget: undefined, freezeCodexCleanupLaunch: noop,
    registerRpcEnginePidMarker: () => 'marker', clearRpcEnginePidMarker: noop,
    publishLocalProcessAttestation: noop,
    installAwaitingRpcActivation: vi.fn(), clearAwaitingRpcActivation: vi.fn(),
    codexRolloutProbe: vi.fn(), acknowledgeNativeInputConsumed: vi.fn(), recordStructuredInput: vi.fn(),
    durableTurnInFlight: false, shouldPreMarkFirstTurn: (outcome: string) => outcome === 'accepted',
    activateRpcTurnLifecycle: vi.fn(() => true), deferredFreshRpcTurn: undefined,
    codexBridgeMarkPendingTurn: vi.fn(() => 'om_first'), installRpcLifecycleFailClosedOwner: vi.fn(),
    awaitingRpcActivationReplayAnchorMs: () => 1,
    codexRpcEngine: undefined, taskContinuationRpcGeneration: undefined,
    remoteWsUrl: undefined, remoteThreadId: undefined, persistCliSessionId: vi.fn(),
    syncFreshCodexNativeSessionTitle: vi.fn(async () => {}),
    deferredPluginSkillCatalog: '<botmux_skills_refresh>catalog</botmux_skills_refresh>',
    deferredPluginSkillCatalogDigest: 'catalog-version',
    lastInitConfig: { cliId: 'traex', codexRpcInput: true },
    send: vi.fn(), log: vi.fn(),
  };
  const scope = new Proxy(base, {
    has: (_target, key) => typeof key === 'string',
    get: (target, key) => {
      if (key in target) return target[key as string];
      if (key in globalThis) return (globalThis as any)[key];
      throw new ReferenceError(`engage harness: unstubbed worker global ${String(key)}`);
    },
  });
  base.createTraexSpawnLeaseContext = loadWorkerFunction('createTraexSpawnLeaseContext', scope);
  base.settleTraexSpawnLease = loadWorkerFunction('settleTraexSpawnLease', scope);
  base.startTraexSpawnLeaseHeartbeat = loadWorkerFunction('startTraexSpawnLeaseHeartbeat', scope);
  base.stopTraexLeaseHeartbeat = loadWorkerFunction('stopTraexLeaseHeartbeat', scope);
  base.settleTraexRpcLease = loadWorkerFunction('settleTraexRpcLease', scope);
  base.prepareFreshTraexFirstTurn = loadWorkerFunction('prepareFreshTraexFirstTurn', scope);
  base.publishTraexNativeContextReceipt = loadWorkerFunction('publishTraexNativeContextReceipt', scope);
  base.invalidateTraexNativeContextReceipt = loadWorkerFunction('invalidateTraexNativeContextReceipt', scope);
  const engage = loadWorkerFunction<(cfg: any) => Promise<string>>('engageCodexRpc', scope);
  const cfg: any = {
    type: 'init', cliId: 'traex', sessionId: 'sid', larkAppId: 'app', chatId: 'oc', rootMessageId: 'om_root',
    turnId: 'om_first', prompt: prompt('A', 'hello'), codexRpcInput: true, backendType: 'tmux',
    ...(opts.resume ? { resume: true, cliSessionId: 'thread-old' } : {}),
    ...(opts.receipt ? { traexNativeContextReceipt: opts.receipt } : {}),
  };
  return {
    base, cfg, engines, lease,
    engageRaw: () => engage(cfg),
    engage: async () => {
      const outcome = await engage(cfg);
      // The generic catch would turn a harness gap into a silent paste fallback.
      expect(base.log.mock.calls.flat().join('\n')).not.toContain('failed to start');
      return outcome;
    },
  };
}

describe('actual worker TraeX RPC engagement', () => {
  const acceptedOld = context.settleTraexNativeContextReceipt(
    context.prepareTraexNativeContext(prompt('A', 'earlier'), 'thread-old'), 'om_earlier', 'accepted',
  )!;

  it('keeps the queued resume prompt self-contained; omission waits for the RPC write edge', async () => {
    const h = engageHarness({ resume: true, receipt: acceptedOld });
    await expect(h.engage()).resolves.toBe('resumed');
    expect(h.cfg.prompt).toBe(prompt('A', 'hello'));
    // The refreshed catalog still rides the first written turn.
    expect(h.base.deferredPluginSkillCatalog).toBe('<botmux_skills_refresh>catalog</botmux_skills_refresh>');
  });

  it('leaves the prompt and catalog intact when the fresh first frame never left', async () => {
    const h = engageHarness({ firstOutcome: 'not-sent', receipt: acceptedOld });
    await expect(h.engage()).resolves.toBe('not-engaged');
    expect(h.engines[0].sendFirstTurn.mock.calls[0][0]).toContain('catalog');
    expect(h.cfg.prompt).toBe(prompt('A', 'hello'));
    expect(h.base.deferredPluginSkillCatalog).toBe('<botmux_skills_refresh>catalog</botmux_skills_refresh>');
    expect(h.lease.release).toHaveBeenCalledTimes(1);
    expect(h.engines[0].stopAndWait.mock.invocationCallOrder[0]).toBeLessThan(h.lease.release.mock.invocationCallOrder[0]);
  });

  it.each(['false', 'throw'] as const)('keeps a not-sent RPC lease when final teardown cannot prove death (%s)', async mode => {
    const h = engageHarness({ firstOutcome: 'not-sent', receipt: acceptedOld, stopAndWaitOutcome: mode });
    await expect(h.engage()).resolves.toBe('not-engaged');
    expect(h.lease.markDeathUnproven).toHaveBeenCalledWith(4242);
    expect(h.lease.release).not.toHaveBeenCalled();
  });

  it('consumes the catalog with an accepted fresh first turn and fingerprints the sent text', async () => {
    const h = engageHarness({ firstOutcome: 'accepted' });
    await expect(h.engage()).resolves.toBe('accepted');
    const sent = h.engines[0].sendFirstTurn.mock.calls[0][0];
    expect(sent).toBe(`${prompt('A', 'hello')}\n\n<botmux_skills_refresh>catalog</botmux_skills_refresh>`);
    expect(h.base.deferredPluginSkillCatalog).toBeNull();
    expect(h.base.activateRpcTurnLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'om_first' }), sent, false, expect.anything(), true,
    );
    expect(h.base.lastInitConfig.traexNativeContextReceipt).toMatchObject({
      nativeThreadId: 'thread-fresh', turnId: 'om_first', status: 'accepted',
    });
    // The app-server reports auto-compaction: the next write must resend.
    h.engines[0].opts.onContextCompacted('thread-fresh');
    expect(h.base.lastInitConfig.traexNativeContextReceipt).toMatchObject({
      nativeThreadId: 'thread-fresh', status: 'unknown',
    });
  });

  it('admits the RPC app-server with the frozen snapshot and records its pid', async () => {
    const h = engageHarness({ firstOutcome: 'accepted' });
    await expect(h.engage()).resolves.toBe('accepted');
    expect(h.base.acquireTraexRuntimeLease).toHaveBeenCalledTimes(1);
    expect(h.engines[0].opts.cliBin).toBe('/snapshots/combo-a/traex');
    expect(h.engines[0].opts.env).toMatchObject({
      TRAEX_CODE_MODE_HOST_PATH: '/snapshots/combo-a/helper',
      BOTMUX_TRAEX_OCCUPANT_ID: 'occupant-a',
      BOTMUX_TRAEX_DOMAIN_KEY: 'domain-a',
    });
    expect(h.lease.markRunning).toHaveBeenCalledWith(4242, 'start-4242');
  });

  it('does not construct an engine for an opening cancelled while the gate was waiting', async () => {
    const h = engageHarness({ resume: false });
    h.base.cancelledQueuedTurnIds.add('om_first');
    await expect(h.engageRaw()).rejects.toBeInstanceOf(h.base.CliSpawnSupersededError);
    expect(h.engines).toHaveLength(0);
    expect(h.lease.abandon).toHaveBeenCalledTimes(1);
    expect(h.lease.markRunning).not.toHaveBeenCalled();
  });

  it.each(['false', 'throw'] as const)('retains a spawned RPC lease when stopAndWait cannot prove group death (%s)', async mode => {
    let openA!: () => void;
    const gateA = new Promise<void>(resolve => { openA = resolve; });
    const h = engageHarness({ resume: true, startGates: [gateA] });
    let generation = 0;
    h.base.rpcEngagementFence = {
      begin: () => ++generation, isCurrent: (token: number) => token === generation,
      isLive: () => true, markDead: () => undefined,
    };
    const resultA = h.engageRaw().then(outcome => ({ outcome }), error => ({ error }));
    for (let i = 0; i < 30 && h.engines.length === 0; i++) await Promise.resolve();
    if (mode === 'throw') h.engines[0].stopAndWait.mockRejectedValue(new Error('unverified descendant'));
    else h.engines[0].stopAndWait.mockResolvedValue(false);
    const resultB = h.engageRaw();
    openA();
    const a = await resultA;
    expect((a as any).error).toBeInstanceOf(h.base.CliSpawnSupersededError);
    await expect(resultB).resolves.toBe('resumed');
    expect(h.engines[0].stopAndWait).toHaveBeenCalled();
    expect(h.lease.release).not.toHaveBeenCalled();
    expect(h.lease.abandon).not.toHaveBeenCalled();
    expect(h.lease.markDeathUnproven).toHaveBeenCalledWith(4242);
  });

  it('abandons a stale pre-spawn lease without publishing over the replacement', async () => {
    const h = engageHarness({ resume: true });
    let grantA!: (value: { kind: 'granted'; lease: any }) => void;
    const gateA = new Promise<{ kind: 'granted'; lease: any }>(resolve => { grantA = resolve; });
    const leaseB = {
      ...h.lease, occupantId: 'occupant-b',
      markRunning: vi.fn(async () => {}), release: vi.fn(async () => {}), abandon: vi.fn(async () => {}),
    };
    h.base.acquireTraexRuntimeLease = vi.fn()
      .mockImplementationOnce(() => gateA)
      .mockResolvedValueOnce({ kind: 'granted', lease: leaseB });
    let generation = 0;
    h.base.rpcEngagementFence = {
      begin: () => ++generation,
      isCurrent: (token: number) => token === generation,
      isLive: () => true,
      markDead: () => undefined,
    };
    const resultA = h.engageRaw().then(
      outcome => ({ outcome }), error => ({ error }),
    );
    for (let i = 0; i < 30 && h.base.acquireTraexRuntimeLease.mock.calls.length === 0; i++) await Promise.resolve();
    const resultB = h.engageRaw();
    grantA({ kind: 'granted', lease: h.lease });
    const a = await resultA;
    expect((a as any).error).toBeInstanceOf(h.base.CliSpawnSupersededError);
    await expect(resultB).resolves.toBe('resumed');
    expect(h.lease.abandon).toHaveBeenCalledTimes(1);
    expect(h.lease.release).not.toHaveBeenCalled();
    expect(h.lease.markRunning).not.toHaveBeenCalled();
    expect(h.engines).toHaveLength(1);
    expect(h.base.traexRpcLeaseContext?.lease).toBe(leaseB);
  });

  it('keeps overlapping engagements on their own lease contexts', async () => {
    let openA!: () => void;
    let openB!: () => void;
    const startGates = [
      new Promise<void>(resolve => { openA = resolve; }),
      new Promise<void>(resolve => { openB = resolve; }),
    ];
    const h = engageHarness({ resume: true, startGates });
    const leaseB = {
      ...h.lease,
      occupantId: 'occupant-b',
      domain: { ...h.lease.domain, domainKey: 'domain-b' },
      snapshot: { ...h.lease.snapshot, traexPath: '/snapshots/combo-b/traex', dir: '/snapshots/combo-b' },
      markRunning: vi.fn(async () => {}), release: vi.fn(async () => {}), abandon: vi.fn(async () => {}),
    };
    h.base.acquireTraexRuntimeLease = vi.fn()
      .mockResolvedValueOnce({ kind: 'granted', lease: h.lease })
      .mockResolvedValueOnce({ kind: 'granted', lease: leaseB });
    let generation = 0;
    h.base.rpcEngagementFence = {
      begin: () => ++generation,
      isCurrent: (token: number) => token === generation,
      isLive: () => true,
      markDead: () => undefined,
    };
    h.base.settleTraexRpcLease = loadWorkerFunction('settleTraexRpcLease', h.base);
    const waitForEngines = async (count: number) => {
      for (let i = 0; i < 30 && h.engines.length !== count; i++) await Promise.resolve();
      expect(h.engines).toHaveLength(count);
    };

    const resultA = h.engageRaw().then(
      outcome => ({ outcome }),
      error => ({ error }),
    );
    await waitForEngines(1);
    const resultB = h.engageRaw();
    await waitForEngines(2);

    openA();
    const a = await resultA;
    expect((a as any).error).toBeInstanceOf(h.base.CliSpawnSupersededError);
    expect(h.lease.markRunning).toHaveBeenCalledWith(4242, 'start-4242');
    expect(h.engines[0].stopAndWait).toHaveBeenCalled();
    expect(h.engines[0].stopAndWait.mock.invocationCallOrder[0]).toBeLessThan(h.lease.release.mock.invocationCallOrder[0]);
    expect(h.lease.release).toHaveBeenCalledTimes(1);
    expect(leaseB.markRunning).not.toHaveBeenCalled();
    expect(leaseB.release).not.toHaveBeenCalled();
    expect(leaseB.abandon).not.toHaveBeenCalled();
    // B is still inside start(): its granted lease stays local and cannot be
    // overwritten by A's late cleanup or published as the active generation.
    expect(h.base.traexRpcLeaseContext).toBeUndefined();
    expect(h.base.pendingRpcEngagement?.lease?.lease).toBe(leaseB);

    openB();
    await expect(resultB).resolves.toBe('resumed');
    expect(leaseB.markRunning).toHaveBeenCalledWith(4243, 'start-4243');
    expect(leaseB.release).not.toHaveBeenCalled();
    expect(leaseB.abandon).not.toHaveBeenCalled();
    expect(h.base.codexRpcEngine).toBe(h.engines[1]);
    expect(h.base.traexRpcLeaseContext?.lease).toBe(leaseB);
  });

  it('refuses an unadmitted RPC start before constructing the app-server', async () => {
    const h = engageHarness({ firstOutcome: 'accepted' });
    h.base.acquireTraexRuntimeLease = vi.fn(async () => ({ kind: 'error', reason: 'snapshot-failed', detail: 'bad' }));
    await expect(h.engage()).rejects.toThrow('TRAE runtime gate refused the RPC start');
    expect(h.engines).toHaveLength(0);
  });
});
