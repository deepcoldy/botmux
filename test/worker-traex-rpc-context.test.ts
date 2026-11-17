import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as context from '../src/core/traex-native-context.js';
import { CodexRpcDeliveryError } from '../src/codex-rpc-engine.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const prompt = (role: string, text: string) =>
  `<role>${role}</role>\n\n<user_message>${text}</user_message>`;

function rpcHarness() {
  const h = workerSubmitHarness();
  Object.assign(h.scope, context, {
    CodexRpcDeliveryError,
    lastInitConfig: { cliId: 'traex', codexRpcInput: true, cliSessionId: 'thread' },
    codexRpcEngine: {
      activeThreadId: 'thread', activeNativeTurnId: undefined,
      sendTurn: vi.fn(async () => ({ nativeTurnId: 'native' })),
    },
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
  h.scope.publishTraexNativeContextReceipt = loadWorkerFunction('publishTraexNativeContextReceipt', h.scope);
  return h;
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
    const ambiguous = vi.fn(async () => {
      throw new CodexRpcDeliveryError('no response', 'rpc_turn_start_ambiguous', 'ambiguous');
    });
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
    h.scope.codexRpcEngine.sendTurn = vi.fn(async () => ({ nativeTurnId: 'native-2' }));
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
}) {
  const engines: any[] = [];
  class FakeEngine {
    appServerPid = 4242;
    wsUrl = 'ws://127.0.0.1:1';
    activeThreadId: string | undefined;
    stop = vi.fn();
    sendFirstTurn = vi.fn(async () => ({
      outcome: opts.firstOutcome ?? 'accepted',
      ...(opts.firstOutcome === 'accepted' || !opts.firstOutcome ? { nativeTurnId: 'native-1' } : {}),
    }));
    constructor() { engines.push(this); }
    async start() {}
    async startThread() { this.activeThreadId = 'thread-fresh'; return 'thread-fresh'; }
    async resumeThread(id: string) { this.activeThreadId = id; return id; }
  }
  const noop = () => undefined;
  const base: Record<string, any> = {
    ...context,
    CodexRpcEngine: FakeEngine,
    CliSpawnSupersededError: class extends Error {},
    CodexRpcEngineDiedDuringEngagementError: class extends Error {},
    randomBytes, currentBotmuxTurnId: undefined, followBotTraeHome: noop, larkUserNative: noop, homedir: () => '/home/fake', join: (...parts: string[]) => parts.join('/'),
    codexRpcEligible: () => true, sandboxEnabled: () => false,
    stopCodexRpcEngine: vi.fn(),
    rpcEngagementFence: { begin: () => 1, isCurrent: () => true, isLive: () => true, markDead: noop },
    cliSpawnGeneration: 1,
    createCliAdapterSync: () => ({ resolvedBin: '/bin/traex' }),
    buildSessionChildEnv: () => ({}),
    prependBotmuxBin: (_dir: string, path: string | undefined) => path,
    resolveBotmuxWrapperBinDir: () => '/bin',
    sessionMcpGatewayHost: null,
    MCP_GATEWAY_SOCKET_ENV: 'MCP_SOCKET', MCP_GATEWAY_REQUIRED_ENV: 'MCP_REQUIRED',
    botInjectedEnv: () => ({}), clearBotmuxPromptEnv: noop, applyCodexInstanceEnv: noop,
    applySessionOwnerEnv: noop, usesLarkToolBinding: () => false, isWorkflowWorker: () => false,
    cleanupLarkToolBinding: noop, resolveIdentityStorageModel: () => 'none',
    prepareTurnGitConfigEnv: noop, parseDaemonIpcPort: noop, prepareLarkToolEnv: noop,
    protectedMcpRedactedEnvKeys: () => [], traexNativeSubagentHookConfig: noop,
    nativeSubagentRuntimeHookCommand: noop, bridgeCodexUserInput: noop, handleRpcTurnTerminal: noop,
    codexCleanupLaunchTarget: undefined, freezeCodexCleanupLaunch: noop,
    registerRpcEnginePidMarker: () => 'marker', clearRpcEnginePidMarker: noop,
    publishLocalProcessAttestation: noop,
    installAwaitingRpcActivation: vi.fn(), clearAwaitingRpcActivation: vi.fn(),
    codexRolloutProbe: vi.fn(), acknowledgeNativeInputConsumed: vi.fn(),
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
  base.prepareFreshTraexFirstTurn = loadWorkerFunction('prepareFreshTraexFirstTurn', scope);
  base.publishTraexNativeContextReceipt = loadWorkerFunction('publishTraexNativeContextReceipt', scope);
  const engage = loadWorkerFunction<(cfg: any) => Promise<string>>('engageCodexRpc', scope);
  const cfg: any = {
    type: 'init', cliId: 'traex', sessionId: 'sid', larkAppId: 'app', chatId: 'oc', rootMessageId: 'om_root',
    turnId: 'om_first', prompt: prompt('A', 'hello'), codexRpcInput: true, backendType: 'tmux',
    ...(opts.resume ? { resume: true, cliSessionId: 'thread-old' } : {}),
    ...(opts.receipt ? { traexNativeContextReceipt: opts.receipt } : {}),
  };
  return {
    base, cfg, engines,
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
  });
});
