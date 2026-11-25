import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as botRegistry from '../src/bot-registry.js';
import { config } from '../src/config.js';
import { ActiveTurnAuthority, sameTrustedPrincipal } from '../src/core/active-turn-authority.js';
import {
  BackgroundTurnAuthorityHold,
  LegacyAgentAckPairer,
  applyClaudeTranscriptEventToAuthorityHold,
  isDeferrableAuthorityReleaseReason,
} from '../src/core/background-turn-authority.js';
import { setIpcAuthSecret, startIpcServer } from '../src/core/dashboard-ipc-server.js';
import { prepareLarkToolEnv } from '../src/core/lark-tool-binding.js';
import { MANAGED_ORIGIN_ATTEST_ROUTE } from '../src/core/managed-origin-attestation.js';
import { decideQueuedReadyTransition } from '../src/core/queued-ready-transition.js';
import { replyTargetPinnedTurnIds } from '../src/core/reply-target.js';
import { SessionController } from '../src/core/session-controller.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as identities from '../src/im/lark/identity-cache.js';
import { BackgroundTaskTracker, drainTranscript, type TranscriptEvent } from '../src/services/claude-transcript.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { sameRuntime, sameWorker } from '../src/services/session-contract.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { TurnExecutionClock } from '../src/services/turn-execution-clock.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { CodexAppFlushPromptReplay } from '../src/utils/codex-app-turn-liveness.js';
import * as tokens from '../src/utils/user-token.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const CHANNEL_ID = 'a'.repeat(64);
const USER_A = {
  requestLarkAppId: 'cli_bg_auth',
  requestUserOpenId: 'ou_user_a',
  senderType: 'user' as const,
};
const USER_B = {
  requestLarkAppId: 'cli_bg_auth',
  requestUserOpenId: 'ou_user_b',
  senderType: 'user' as const,
};

function evIso(ms: number): string {
  return new Date(ms).toISOString();
}

async function createEndToEndHarness(opts: {
  crossPrincipalIsolation?: boolean;
  adoptMode?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bg-turn-auth-e2e-'));
  const previousDataDir = config.session.dataDir;
  config.session.dataDir = root;
  cleanups.push(() => {
    config.session.dataDir = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  });

  const sessionId = 'bg-session-1';
  const appId = 'cli_bg_auth';
  const binding = prepareLarkToolEnv({
    env: { PATH: '/usr/bin:/bin' },
    dataDir: root,
    sessionId,
    appId,
  });

  const procStart = readProcessStartIdentity(process.pid);
  const ds: any = {
    session: {
      sessionId,
      status: 'active',
      cliId: 'claude-code',
      workerGeneration: 1,
      replyTargets: {
        om_turn_a: { senderOpenId: USER_A.requestUserOpenId },
        om_turn_a2: { senderOpenId: USER_A.requestUserOpenId },
        om_turn_b: { senderOpenId: USER_B.requestUserOpenId },
      },
    },
    larkAppId: appId,
    chatId: 'oc_chat',
    chatType: 'group',
    workerGeneration: 1,
    localProcessAttestation: {
      backendType: 'pty',
      workerGeneration: 1,
      cliPid: process.pid,
      cliProcStart: procStart,
    },
  };
  const worker: any = {
    pid: process.pid,
    connected: true,
    killed: false,
    exitCode: null,
    signalCode: null,
    send: vi.fn(),
  };
  ds.worker = worker;

  const store = new SessionContractStore(root, appId);
  cleanups.push(() => store.close());
  const controller = new SessionController(ds, store);
  const workerRef = controller.bindWorker(1).worker;
  const scope = new WorkerSessionEventScope(controller.ref, workerRef);

  const bindRuntime = (nativeId: string, physicalId?: string) => {
    const b = scope.beginRuntime(undefined, physicalId);
    controller.reserveBinding(b.bindingId, workerRef);
    b.identity = {
      backend: 'tmux',
      physicalId: `${process.pid}:${procStart ?? '1'}`,
      proof: 'process_start',
      nativeSessionId: nativeId,
    };
    scope.assign(b.bindingId, controller.bindRuntime(b.bindingId, workerRef, b.identity).ref);
    return b;
  };
  const runtimeBinding = bindRuntime('native-claude-1');

  const gcCalls: number[] = [];
  const revokedCallbacks: string[] = [];
  const hostEnv: any = {
    ds,
    worker,
    workerGeneration: 1,
    sessionController: controller,
    contractWorker: workerRef,
    botCfg: { larkAppId: appId, cliId: 'claude-code' },
    config: { session: { dataDir: root }, crossPrincipalInterruption: opts.crossPrincipalIsolation === true },
    sessionCliId: () => 'claude-code',
    logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
    t: 'bg-auth-test',
    currentGatewayCallerOpenId: () => undefined,
    currentTurnProcessIdentities: () => ['999999:preexisting-snap'],
    noteTurnDispatchAttempt: vi.fn(),
    ensureAutomaticTaskContinuationLease: vi.fn(),
    getDaemonBootId: () => 'boot-test',
    replaceManagedOriginCapabilityFile: (file: string, content: string) => {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, content, 'utf8');
    },
    managedOriginCapabilityPath: (dataDir: string, sid: string, ch: string) =>
      join(dataDir, 'origin-caps', `${sid}-${ch}.json`),
    sameTrustedPrincipal,
    sameWorker,
    sameRuntime,
    randomBytes,
    collectSessionTurnGarbage: vi.fn(() => { gcCalls.push(Date.now()); }),
    forgetScheduledTurnCaller: vi.fn(),
    trimOldest: vi.fn(),
    retireReplyExecutionStarts: vi.fn(),
    isTurnOutcomeExcluded: () => false,
    observeTurnResultTerminal: vi.fn(),
    settleAutoCompactSafeComposerRefusal: () => false,
    noteIdleAutoCompactTurnEnded: () => false,
    managedAuxUiSuppressed: () => true,
    finalizeOrHoldCotMessage: vi.fn(),
    readonlyTaskContinuationHandlesTerminal: () => false,
    isTerminalTypedTurnId: () => false,
    ownsLifecycleMutation: () => true,
    ownsWorkerSession: () => true,
    isSessionTransferring: () => false,
    cliNotices: { finish: vi.fn() },
    isActiveTurnSilentSchedule: () => false,
    effectiveActiveSilentScheduleStatus: () => 'idle',
    dashboardEventBus: { publish: vi.fn() },
    releaseActiveIdentityTurn: vi.fn(),
    runPendingSuspendIfSettled: vi.fn(),
    completeWorkerOrdinaryImDelivery: vi.fn(),
    settleAcceptedInputTurn: vi.fn(),
    discardTriggerStreamingCard: vi.fn(),
    takePurgeClickRollback: () => undefined,
    rejectDocCommentTurnBeforeAdmission: vi.fn(),
    rejectOrdinaryImDelivery: vi.fn(async () => {}),
    noteNonSilentTurnActivity: vi.fn(),
    noteIdleAutoCompactDirectInput: vi.fn(),
    markDirectSubmitEpisode: vi.fn(),
    streamingCardTurnQueued: vi.fn(),
    acknowledgeOrdinaryImDeliveryReceipt: vi.fn(),
    commitCaptureIdentity: vi.fn(),
    currentCaptureIdentity: () => ({}),
    notePromptCacheKeepaliveResult: vi.fn(),
    noteNativeAcceptedInputTurn: vi.fn(),
    reconcileFoldedOrSteeredStartingCard: vi.fn(),
    sessionStore: { updateSession: vi.fn() },
    cb: {
      onManagedTurnOrigin: vi.fn(),
      onManagedTurnOriginRevoked: vi.fn((_ds: unknown, turnId: string) => {
        revokedCallbacks.push(turnId);
      }),
      onTurnTerminal: vi.fn((_ds: unknown, terminal: any) => {
        const retainInteractiveForBackground = opts.crossPrincipalIsolation === true
          && terminal.status === 'completed'
          && terminal.authorityHeldForBackground === true;
        if (!retainInteractiveForBackground && ds.activeInteractiveTurn?.turnId === terminal.turnId) {
          ds.activeInteractiveTurn = undefined;
        }
      }),
    },
  };
  hostEnv.handleLegacyWorkerMessage = loadWorkerPoolClosure('handleLegacyWorkerMessage', hostEnv);
  // Minimal turn_terminal wrapper for test isolation: run real worker-pool case 'turn_terminal'
  // logic for managedTurnOrigin + cb.onTurnTerminal without external card/delivery/SQLite side effects.
  const realLegacy = hostEnv.handleLegacyWorkerMessage;
  hostEnv.handleLegacyWorkerMessage = async (msg: any) => {
    if (msg.type === 'turn_terminal') {
      // Execute the exact production defense-in-depth block in worker-pool.ts
      const retainOriginForBackground = msg.status === 'completed' && msg.authorityHeldForBackground === true;
      if (!retainOriginForBackground
        && ds.managedTurnOrigin?.turnId === msg.turnId
        && ds.managedTurnOrigin.dispatchAttempt === msg.dispatchAttempt) {
        ds.managedTurnOrigin = ds.managedTurnOrigin.policyCapability
          ? {
              capability: randomBytes(32).toString('hex'),
              ...(ds.managedTurnOrigin.originChannelId ? { originChannelId: ds.managedTurnOrigin.originChannelId } : {}),
              policyCapability: ds.managedTurnOrigin.policyCapability,
            }
          : undefined;
      }
      hostEnv.cb.onTurnTerminal(ds, msg);
      hostEnv.collectSessionTurnGarbage(ds);
      return;
    }
    await realLegacy(msg);
  };
  const handleWorkerMessage = loadWorkerPoolClosure<any>('handleWorkerMessage', hostEnv);
  hostEnv.handleWorkerMessage = handleWorkerMessage;

  // Real HTTP IPC server for BOTH `botmux send` (/api/session-origin/attest) AND `--as user` (/api/sessions/:id/lark-tool-identity)
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === sessionId ? ds : undefined);
  vi.spyOn(botRegistry, 'getBot').mockReturnValue({
    config: { larkAppId: appId, larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [USER_A.requestUserOpenId, USER_B.requestUserOpenId],
    resolvedBlockedUsers: [],
  } as any);
  vi.spyOn(identities, 'resolveVerifiedUserIdentity').mockImplementation(async (_appId, openId) => ({
    openId,
    type: 'user',
  }) as any);
  vi.spyOn(tokens, 'resolveUserToken').mockImplementation(async (_appId, _secret, _brand, openId) => `token-for-${openId}`);
  setIpcAuthSecret('test-ipc-secret');
  const ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  cleanups.push(async () => {
    await ipc.close();
    setIpcAuthSecret(null);
  });

  // Real worker state + extracted production worker functions
  const authority = new ActiveTurnAuthority();
  const hold = new BackgroundTurnAuthorityHold();
  const tracker = new BackgroundTaskTracker();
  const pairer = new LegacyAgentAckPairer();
  const deduper = new TurnTerminalDeduper();
  const clock = new TurnExecutionClock();
  const wire: any[] = [];
  const pendingIpc: Promise<void>[] = [];
  const pidMarkerFile = join(root, 'cli-pid-marker.json');
  const writeLog: Array<{ turnId?: string; content: string }> = [];

  const env: any = {
    sessionId,
    config: { session: { dataDir: root }, terminalEffortWriteback: false },
    workerSessionEventScope: scope,
    activeTurnAuthority: authority,
    backgroundAuthorityHold: hold,
    backgroundTaskTracker: tracker,
    legacyAgentAckPairer: pairer,
    backgroundHoldTimer: null,
    backgroundWaitTasks: 0,
    antigravityFooterBackgroundTasks: 0,
    backgroundStopScanOffsets: new Map(),
    backgroundStopScanSinceMs: 0,
    emittedTurnTerminals: deduper,
    turnExecutionClock: clock,
    lastInitConfig: { cliId: 'claude-code', adoptMode: opts.adoptMode === true, larkAppId: appId },
    cliAdapter: { id: 'claude-code', claudeDataDir: join(root, '.claude') },
    currentBotmuxTurnId: undefined as string | undefined,
    currentBotmuxDispatchAttempt: undefined as number | undefined,
    currentBotmuxCallerOpenId: undefined as string | undefined,
    currentBotmuxLinkRefMode: undefined,
    currentVcMeetingImTurnOrigin: undefined,
    currentTurnSteerPromoted: false,
    queuedTypeAheadTurns: [] as any[],
    retiredTurnIds: new Set<string>(),
    pendingMessages: [] as any[],
    pendingRawInputs: [] as any[],
    pendingAdoptMessages: [] as any[],
    pendingSessionRename: null,
    pendingStructuredCaptureRetirement: undefined,
    sandboxRelayCapability: null,
    sandboxPolicyCapability: 'policy-cap-1',
    sandboxRelayOutbox: null,
    readIsolationOriginChannelId: CHANNEL_ID,
    publishedOriginContractScope: undefined,
    pendingManagedTurnOriginScope: undefined,
    cliPidMarker: pidMarkerFile,
    rpcEnginePidMarker: null,
    isPromptReady: true,
    isFlushing: false,
    durableTurnInFlight: false,
    remoteRunnerRecoveredTurnInFlight: false,
    inflightInputs: { onTurnComplete: vi.fn(), onWrite: vi.fn() },
    submitFailureChains: new Map(),
    cliSpawnGeneration: 1,
    captureTurnFailureDiagnostics: false,
    thinkingTurn: null,
    traexQuotaPending: undefined,
    traexModelAccessSwitchNotice: undefined,
    traexAutoModelController: undefined,
    kimiActivityObserver: undefined,
    codexBridgeQueue: { dropPendingTurn: () => false, stopRpcActive: () => false, finishSubmitVerification: vi.fn() },
    acknowledgeTurnInputCommitted: vi.fn(),
    writtenInputs: { takeSubmitted: () => undefined },
    inFlightKeepaliveFingerprints: new Map(),
    KEEPALIVE_HOOK_CLAIM_MS: 10_000,
    lastWebTerminalInputAtMs: 0,
    webTerminalInputGeneration: 0,
    webTerminalInputBackendScreenRevision: 0,
    backendScreenRevision: 0,
    lastWebTerminalSubmitAtMs: 0,
    webTerminalSubmitGeneration: 0,
    parseDaemonIpcPort: () => ipc.port,
    managedOriginCapabilityPath: (dataDir: string, sid: string, ch: string) =>
      join(dataDir, 'origin-caps', `${sid}-${ch}.json`),
    replaceManagedOriginCapabilityFile: (file: string, content: string) => {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, content, 'utf8');
    },
    randomBytes,
    existsSync,
    readFileSync,
    atomicWriteFileSync: (path: string, data: string) => writeFileSync(path, data, 'utf8'),
    basename: (p: string) => p.split('/').pop()!,
    readProcessStartIdentity,
    withPidMarkerLock: (_path: string, fn: () => void) => fn(),
    markerBelongsToLiveProcess: () => true,
    markerIdentityTurnId: (id: unknown) => typeof id === 'string' && id ? id : undefined,
    markerQueuedTurnStillLive: () => true,
    retireTerminatedMarkerTurn: () => false,
    publishActiveTurn: vi.fn(),
    unlinkManagedOriginCapabilityFiles: vi.fn(),
    frozenTurnLinkRefMode: () => undefined,
    isWorkflowWorker: () => false,
    zeroPromptTerminalSync: () => false,
    syncBackgroundTaskPinsToDaemon: vi.fn(),
    isCrossPrincipalInterruptionEnabled: () => opts.crossPrincipalIsolation === true,
    terminalReleasesDurableTurn: () => false,
    cancelSubmitFailureChainForTerminal: vi.fn(),
    recoverDeferredPromptReadyAtTurnTerminal: vi.fn(),
    markTurnRetired: (tid: string | undefined) => { if (tid) env.retiredTurnIds.add(tid); },
    retireTerminatedQueuedTurn: vi.fn(),
    scheduleConsumedQueuedTurnAdvance: vi.fn(),
    flushPending: vi.fn(),
    sendToPty: vi.fn((content: string, turnId?: string, ...rest: any[]) => {
      const optsObj = rest.find(a => a && typeof a === 'object' && 'trustedCaller' in a);
      const trustedCaller = optsObj?.trustedCaller
        ?? rest.find(a => a && typeof a === 'object' && typeof a.requestUserOpenId === 'string');
      writeLog.push({ turnId, content });
      env.pendingMessages.push({ content, turnId, trustedCaller });
    }),
    receiveOrdinaryImTurn: () => 'new',
    rejectOrdinaryImTurn: vi.fn((turnId: string, reason: string, extra?: any) => {
      const active = authority.snapshot();
      env.send({
        type: 'turn_input_rejected',
        turnId,
        reason,
        ...(extra ?? {}),
        ...(active?.turnId ? { activeTurnId: active.turnId } : {}),
        ...(active?.caller ? { activeCaller: active.caller } : {}),
      });
    }),
    isOrdinaryImTurnId: (id: string | undefined) => !!id && id.startsWith('om_'),
    applyWorkerLaunchModel: vi.fn(),
    respawnConfigPatchFromMessage: () => undefined,
    applyRespawnConfigPatch: vi.fn(),
    applyPendingRespawnConfigPatch: vi.fn(),
    noteDeferredMessage: vi.fn(),
    finalHandoffAdmissionEnabled: false,
    renderer: { markNewTurn: vi.fn(), snapshot: () => ({ content: 'screen' }), rawSnapshot: () => 'screen' },
    usageLimitTracker: { beginTurn: vi.fn(() => 1) },
    currentUsageLimitSnapshot: () => '',
    tmuxScrolledHalfPages: 0,
    idleDetector: { reset: vi.fn(), adoptPromptReady: vi.fn(), isStartupPending: () => false },
    publishScreenStatus: vi.fn(),
    isDeferrableAuthorityReleaseReason,
    applyClaudeTranscriptEventToAuthorityHold,
    log: vi.fn(),
    process: {
      env: {},
      send: (message: any) => {
        wire.push(message);
        pendingIpc.push(handleWorkerMessage(message));
      },
    },
  };

  for (const fnName of [
    'workerIpcPayload',
    'send',
    'turnAuthorityIdentity',
    'crossPrincipalIsolationOn',
    'activeTurnBlocks',
    'adoptActiveTurnWhenIsolationOff',
    'reserveActiveTurn',
    'markActiveTurnStarted',
    'releaseActiveTurnAuthority',
    'releaseTerminatedActiveTurnAuthority',
    'turnTerminalEmitted',
    'setCaptureIdentity',
    'publishSandboxRelayCapability',
    'completeManagedTurnOriginRevocation',
    'revokeManagedTurnOriginForRestart',
    'clearBackgroundHoldTimer',
    'scheduleBackgroundHoldTimer',
    'applyBackgroundAuthorityTransition',
    'supersedeBackgroundAuthorityHold',
    'refreshBackgroundWait',
    'observeClaudeBackgroundTasks',
    'emitTurnTerminal',
    'noteWebTerminalInput',
    'notifyTerminalTurnStarted',
    'writeCliPidMarker',
    'restoreQueuedTurnsFromMarkerDisk',
    'activeAuthorityMatchesMarker',
    'adoptInitialActiveTurn',
    'adoptDisplacedActiveTurn',
    'bindCliPidMarker',
  ]) {
    env[fnName] = loadWorkerFunction(fnName, env);
  }
  const handleMessage = loadWorkerMessageHandler('message', env);
  const handlePromptSubmitted = loadWorkerMessageHandler('prompt_submitted', env);

  const drainIpc = async () => {
    while (pendingIpc.length > 0) {
      await Promise.all(pendingIpc.splice(0));
    }
  };

  const startManagedTurn = async (turnId: string, caller: typeof USER_A) => {
    const execution = controller.admitInput(turnId);
    scope.noteAdmission({ ref: execution, phase: 'queued' });
    ds.activeInteractiveTurn = { turnId, caller };
    env.setCaptureIdentity(turnId, undefined, caller.requestUserOpenId);
    env.markActiveTurnStarted({ turnId, trustedCaller: caller });
    scope.run(runtimeBinding, () => {
      scope.enterTurn(turnId, undefined);
      env.publishSandboxRelayCapability();
    }, execution);
    await drainIpc();
    return execution;
  };

  const callBotmuxSendAttest = async (claimedCap?: string) => {
    const cap = claimedCap ?? ds.managedTurnOrigin?.capability ?? '0'.repeat(64);
    return fetch(`http://127.0.0.1:${ipc.port}${MANAGED_ORIGIN_ATTEST_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        originChannelId: CHANNEL_ID,
        originCapability: cap,
        nonce: randomBytes(32).toString('hex'),
      }),
    });
  };

  const callLarkAsUser = async () => {
    return fetch(`http://127.0.0.1:${ipc.port}/api/sessions/${sessionId}/lark-tool-identity`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-botmux-lark-session': binding.accessKey,
      },
      body: JSON.stringify({ mode: 'user' }),
    });
  };

  return {
    root,
    sessionId,
    ds,
    worker,
    store,
    controller,
    scope,
    runtimeBinding,
    bindRuntime,
    hostEnv,
    handleWorkerMessage,
    authority,
    hold,
    tracker,
    env,
    wire,
    gcCalls,
    revokedCallbacks,
    pidMarkerFile,
    handleMessage,
    handlePromptSubmitted,
    drainIpc,
    startManagedTurn,
    callBotmuxSendAttest,
    callLarkAsUser,
  };
}

describe('Issue #3636 Class A — End-to-End Worker + Daemon + IPC (botmux send & --as user)', () => {
  it('retains activeTurnAuthority & ds.managedTurnOrigin through background bash wait and tool-only wake micro-turn, then releases & GCs on settlement', async () => {
    const h = await createEndToEndHarness();
    const t0 = Date.now() - 60_000;
    h.hold.reset(t0);
    h.tracker.reset(t0);

    // 1. User A starts om_turn_a -> managed_turn_origin published with preexistingProcessIdentities
    const execA = await h.startManagedTurn('om_turn_a', USER_A);
    const originalCap = h.ds.managedTurnOrigin.capability;
    const originalPreexisting = h.ds.managedTurnOrigin.preexistingProcessIdentities;
    expect(h.ds.managedTurnOrigin.turnId).toBe('om_turn_a');
    expect(h.ds.managedTurnOrigin.callerOpenId).toBe(USER_A.requestUserOpenId);
    // Reply target pinned via managedTurnOrigin even in send mode
    expect(replyTargetPinnedTurnIds(h.ds).has('om_turn_a')).toBe(true);

    // 2. Claude launches background Bash and ends foreground turn (system/turn_duration)
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        {
          type: 'user', uuid: 'u1', timestamp: evIso(t0 + 100), isSidechain: false,
          promptSource: 'user', turnOrigin: 'human',
          message: { role: 'user', content: 'upload report in bg then write lark sheet' },
        },
        {
          type: 'user', uuid: 'u-bg', timestamp: evIso(t0 + 500), isSidechain: false,
          toolUseResult: { backgroundTaskId: 'bg_upload_1' },
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'bg' }] },
        },
        {
          type: 'assistant', uuid: 'a1', timestamp: evIso(t0 + 800), isSidechain: false,
          message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'uploaded in bg' }] },
        },
        {
          type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 900), isSidechain: false,
        },
      ]);
      h.env.emitTurnTerminal('om_turn_a', 'completed');
    }, execA);
    await h.drainIpc();

    // Verify turn_terminal carried authorityHeldForBackground: true & backgroundTasks: 1
    const termMsg = h.wire.find(m => m.type === 'turn_terminal' && m.turnId === 'om_turn_a');
    expect(termMsg?.authorityHeldForBackground).toBe(true);
    expect(termMsg?.backgroundTasks).toBe(1);
    expect(h.wire.some(m => m.type === 'managed_turn_origin_revoked')).toBe(false);
    // Daemon kept ds.managedTurnOrigin continuously (same capability & preexistingProcessIdentities!)
    expect(h.ds.managedTurnOrigin?.turnId).toBe('om_turn_a');
    expect(h.ds.managedTurnOrigin?.capability).toBe(originalCap);
    expect(h.ds.managedTurnOrigin?.preexistingProcessIdentities).toBe(originalPreexisting);

    // 3. During Phase 1 background wait: BOTH botmux send AND lark-cli --as user SUCCEED as User A!
    const attestWait = await h.callBotmuxSendAttest(originalCap);
    expect(attestWait.status).toBe(200);
    const larkWait = await h.callLarkAsUser();
    expect(larkWait.status).toBe(200);
    expect(await larkWait.json()).toMatchObject({ ok: true, credential: `token-for-${USER_A.requestUserOpenId}` });

    // 4. Background task completes: enqueue arrives first (pending() drops to 0), then dequeue + user <task-notification>
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        {
          type: 'queue-operation', operation: 'enqueue', timestamp: evIso(t0 + 10_000),
          content: '<task-notification>\n<task-id>bg_upload_1</task-id>\n<status>completed</status>\n</task-notification>',
        },
      ]);
    }, execA);
    await h.drainIpc();
    expect(h.tracker.pending()).toBe(0);
    expect(h.hold.phase()).toBe('WAKE_PENDING');
    expect(h.ds.managedTurnOrigin?.turnId).toBe('om_turn_a');

    // Wake micro-turn starts (tool-only, NO visible assistant text)
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        { type: 'queue-operation', operation: 'dequeue', timestamp: evIso(t0 + 10_030) },
        {
          type: 'user', uuid: 'u-wake', timestamp: evIso(t0 + 10_050), isSidechain: false,
          promptSource: 'system', turnOrigin: 'task_notification',
          message: {
            role: 'user',
            content: '<task-notification>\n<task-id>bg_upload_1</task-id>\n<status>completed</status>\n</task-notification>',
          },
        },
        {
          type: 'assistant', uuid: 'a-tool', timestamp: evIso(t0 + 10_500), isSidechain: false,
          message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_lark', name: 'Bash', input: {} }] },
        },
      ]);
    }, execA);
    await h.drainIpc();
    expect(h.hold.phase()).toBe('WAKE_ACTIVE');

    // 5. During Phase 2 wake micro-turn: BOTH botmux send AND lark-cli --as user SUCCEED as User A!
    const attestWake = await h.callBotmuxSendAttest(originalCap);
    expect(attestWake.status).toBe(200);
    const larkWake = await h.callLarkAsUser();
    expect(larkWake.status).toBe(200);
    expect(await larkWake.json()).toMatchObject({ ok: true, credential: `token-for-${USER_A.requestUserOpenId}` });

    // 6. Tool-only wake micro-turn closes (system/turn_duration) -> worker revokes, daemon clears & runs GC!
    const gcBeforeRevoke = h.gcCalls.length;
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        { type: 'system', subtype: 'turn_duration', uuid: 'd-wake', timestamp: evIso(t0 + 12_000), isSidechain: false },
      ]);
    }, execA);
    await h.drainIpc();

    expect(h.hold.phase()).toBe('IDLE');
    expect(h.authority.snapshot()).toBeUndefined();
    expect(h.wire.some(m => m.type === 'managed_turn_origin_revoked' && m.capability === originalCap)).toBe(true);
    expect(h.ds.managedTurnOrigin?.turnId).toBeUndefined();
    expect(h.gcCalls.length).toBeGreaterThan(gcBeforeRevoke);

    // 7. After settlement: BOTH botmux send AND lark-cli --as user MUST fail closed with 403!
    const attestAfter = await h.callBotmuxSendAttest(originalCap);
    expect(attestAfter.status).toBe(403);
    expect(await attestAfter.json()).toMatchObject({ ok: false, error: 'origin_unproven' });

    const larkAfter = await h.callLarkAsUser();
    expect(larkAfter.status).toBe(403);
    expect(await larkAfter.json()).toMatchObject({
      ok: false,
      error: 'No current requesting user; --as user requires their authorization',
    });
  });

  it('keeps om_turn_a alive when a visible-text wake micro-turn (local-headless-*) emits turn_terminal while chained bg_2 runs', async () => {
    const h = await createEndToEndHarness();
    const t0 = Date.now() - 60_000;
    h.hold.reset(t0);
    h.tracker.reset(t0);

    const execA = await h.startManagedTurn('om_turn_a', USER_A);
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        {
          type: 'user', uuid: 'u-bg1', timestamp: evIso(t0 + 200), isSidechain: false,
          toolUseResult: { backgroundTaskId: 'bg_1' },
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bg' }] },
        },
        { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 500), isSidechain: false },
      ]);
      h.env.emitTurnTerminal('om_turn_a', 'completed');
      // Wake 1 launches chained bg_2 and finishes with visible text -> emitTurnTerminal('local-headless-1')
      h.env.observeClaudeBackgroundTasks([
        {
          type: 'user', uuid: 'u-w1', timestamp: evIso(t0 + 2000), isSidechain: false,
          promptSource: 'system', turnOrigin: 'task_notification',
          message: { role: 'user', content: '<task-notification>\n<task-id>bg_1</task-id>\n<status>completed</status>\n</task-notification>' },
        },
        {
          type: 'user', uuid: 'u-bg2', timestamp: evIso(t0 + 2200), isSidechain: false,
          toolUseResult: { backgroundTaskId: 'bg_2' },
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'bg2' }] },
        },
        { type: 'system', subtype: 'turn_duration', uuid: 'd2', timestamp: evIso(t0 + 2500), isSidechain: false },
      ]);
      // Visible-text wake calls emitTurnTerminal('local-headless-1') -> must NOT release om_turn_a via stale_terminal!
      h.env.emitTurnTerminal('local-headless-1', 'completed');
    }, execA);
    await h.drainIpc();

    expect(h.hold.phase()).toBe('HELD_WAITING_BG');
    expect(h.authority.snapshot()?.turnId).toBe('om_turn_a');
    expect(h.ds.managedTurnOrigin?.turnId).toBe('om_turn_a');
    expect((await h.callLarkAsUser()).status).toBe(200);
  });

  it('Security (3.10): User B arriving during Phase 1 (XPI=OFF) revokes User A first, never lends User A credentials, and releases on User B terminal even while bg_A runs', async () => {
    const h = await createEndToEndHarness({ crossPrincipalIsolation: false });
    const t0 = Date.now() - 60_000;
    h.hold.reset(t0);
    h.tracker.reset(t0);

    const execA = await h.startManagedTurn('om_turn_a', USER_A);
    const capA = h.ds.managedTurnOrigin.capability;
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        {
          type: 'user', uuid: 'u-bgA', timestamp: evIso(t0 + 200), isSidechain: false,
          toolUseResult: { backgroundTaskId: 'bg_A' },
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tA', content: 'bg' }] },
        },
        { type: 'system', subtype: 'turn_duration', uuid: 'dA', timestamp: evIso(t0 + 400), isSidechain: false },
      ]);
      h.env.emitTurnTerminal('om_turn_a', 'completed');
    }, execA);
    await h.drainIpc();
    expect(h.hold.phase()).toBe('HELD_WAITING_BG');

    // Simulate User B sending om_turn_b via case 'message' while isPromptReady is false (OSC 7501 still working!)
    h.env.isPromptReady = false;
    await h.handleMessage({
      type: 'message',
      turnId: 'om_turn_b',
      content: 'hi from User B',
      trustedCaller: USER_B,
    });
    await h.drainIpc();

    // User A's held authority MUST ALREADY BE REVOKED before User B starts!
    expect(h.authority.snapshot()).toBeUndefined();
    expect(h.ds.managedTurnOrigin?.turnId).toBeUndefined();
    expect((await h.callBotmuxSendAttest(capA)).status).toBe(403);

    // Now User B starts cleanly -> MUST bind strictly to USER_B (never adopt USER_A!)
    const execB = await h.startManagedTurn('om_turn_b', USER_B);
    expect(h.authority.snapshot()?.caller?.requestUserOpenId).toBe(USER_B.requestUserOpenId);
    expect(h.authority.snapshot()?.identityTurnId).toBeUndefined();
    expect(h.ds.managedTurnOrigin?.callerOpenId).toBe(USER_B.requestUserOpenId);

    const larkB = await h.callLarkAsUser();
    expect(larkB.status).toBe(200);
    expect(await larkB.json()).toMatchObject({ ok: true, credential: `token-for-${USER_B.requestUserOpenId}` });

    // User B ends WITHOUT launching any background tasks of its own (bg_A from User A is STILL running -> backgroundWait() === 1!)
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        { type: 'user', uuid: 'uB', timestamp: evIso(t0 + 1000), promptSource: 'user', message: { role: 'user', content: 'hi' } },
        { type: 'system', subtype: 'turn_duration', uuid: 'dB', timestamp: evIso(t0 + 1200), isSidechain: false },
      ]);
      h.env.emitTurnTerminal('om_turn_b', 'completed');
    }, execB);
    await h.drainIpc();

    // bg_A is still running for card UI (backgroundTasks: 1), YET User B did NOT hold authority!
    const termB = h.wire.find(m => m.type === 'turn_terminal' && m.turnId === 'om_turn_b');
    expect(termB?.backgroundTasks).toBe(1);
    expect(termB?.authorityHeldForBackground).toBeUndefined();
    expect(h.authority.snapshot()).toBeUndefined();
    expect(h.ds.managedTurnOrigin?.turnId).toBeUndefined();
    expect((await h.callLarkAsUser()).status).toBe(403);
  });

  it('Security (3.10): User A sending om_turn_a2 supersedes om_turn_a cleanly without leaking stale speakers', async () => {
    const h = await createEndToEndHarness({ crossPrincipalIsolation: false });
    const t0 = Date.now() - 60_000;
    h.hold.reset(t0);
    h.tracker.reset(t0);

    const execA = await h.startManagedTurn('om_turn_a', USER_A);
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        {
          type: 'user', uuid: 'u-bg', timestamp: evIso(t0 + 200), isSidechain: false,
          toolUseResult: { backgroundTaskId: 'bg_1' },
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bg' }] },
        },
        { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 400), isSidechain: false },
      ]);
      h.env.emitTurnTerminal('om_turn_a', 'completed');
    }, execA);
    await h.drainIpc();

    await h.handleMessage({ type: 'message', turnId: 'om_turn_a2', content: 'next task', trustedCaller: USER_A });
    await h.drainIpc();
    expect(h.authority.snapshot()).toBeUndefined();

    await h.startManagedTurn('om_turn_a2', USER_A);
    expect(h.authority.snapshot()?.turnId).toBe('om_turn_a2');
    expect(h.authority.speakers()).toHaveLength(1);
  });

  it('Security (3.10): XPI=ON retains ds.activeInteractiveTurn across held terminal, restores on raced turn_input_rejected, and drains XPI on delayed revoke', async () => {
    const h = await createEndToEndHarness({ crossPrincipalIsolation: true });
    const t0 = Date.now() - 60_000;
    h.hold.reset(t0);
    h.tracker.reset(t0);

    const execA = await h.startManagedTurn('om_turn_a', USER_A);
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        {
          type: 'user', uuid: 'u-bg', timestamp: evIso(t0 + 200), isSidechain: false,
          toolUseResult: { backgroundTaskId: 'bg_xpi' },
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bg' }] },
        },
        { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 400), isSidechain: false },
      ]);
      h.env.emitTurnTerminal('om_turn_a', 'completed');
    }, execA);
    await h.drainIpc();

    // Under XPI=ON, ds.activeInteractiveTurn stays on om_turn_a while held
    expect(h.ds.activeInteractiveTurn?.turnId).toBe('om_turn_a');

    // If User B somehow raced to the worker, case 'message' rejects User B BEFORE admission
    // and daemon restores ds.activeInteractiveTurn back to om_turn_a (no wedge on om_turn_b!)
    const execB = h.controller.admitInput('om_turn_b');
    h.scope.noteAdmission({ ref: execB, phase: 'queued' });
    h.ds.activeInteractiveTurn = { turnId: 'om_turn_b', caller: USER_B };
    await h.scope.run(h.runtimeBinding, async () => {
      await h.handleMessage({
        type: 'message',
        turnId: 'om_turn_b',
        content: 'intrude',
        trustedCaller: USER_B,
      });
    }, execB);
    await h.drainIpc();

    expect(h.wire.some(m => m.type === 'turn_input_rejected' && m.turnId === 'om_turn_b' && m.reason === 'cross_principal_requires_owner_confirmation')).toBe(true);
    expect(h.ds.activeInteractiveTurn?.turnId).toBe('om_turn_a');
    expect(h.ds.activeInteractiveTurn?.caller?.requestUserOpenId).toBe(USER_A.requestUserOpenId);

    // When bg_xpi is killed -> delayed managed_turn_origin_revoked clears ds.activeInteractiveTurn & triggers onManagedTurnOriginRevoked!
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        {
          type: 'queue-operation', operation: 'enqueue', timestamp: evIso(t0 + 5000),
          content: '<task-notification>\n<task-id>bg_xpi</task-id>\n<status>killed</status>\n</task-notification>',
        },
      ]);
    }, execA);
    await h.drainIpc();

    expect(h.ds.activeInteractiveTurn).toBeUndefined();
    expect(h.revokedCallbacks).toContain('om_turn_a');
  });

  it('Security (3.10): Web Terminal submit, prompt_submitted, local/scheduled turns, and restart immediately revoke held authority', async () => {
    // 1. Web Terminal submit
    const h1 = await createEndToEndHarness();
    const t0 = Date.now() - 60_000;
    h1.hold.reset(t0);
    h1.tracker.reset(t0);
    const exec1 = await h1.startManagedTurn('om_turn_a', USER_A);
    h1.scope.run(h1.runtimeBinding, () => {
      h1.env.observeClaudeBackgroundTasks([
        { type: 'user', uuid: 'u1', timestamp: evIso(t0 + 100), toolUseResult: { backgroundTaskId: 'b1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bg' }] } },
        { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 200) },
      ]);
      h1.env.emitTurnTerminal('om_turn_a', 'completed');
    }, exec1);
    await h1.drainIpc();
    expect((await h1.callLarkAsUser()).status).toBe(200);

    h1.scope.run(h1.runtimeBinding, () => {
      h1.env.noteWebTerminalInput('whoami\r', true);
    }, exec1);
    await h1.drainIpc();
    expect(h1.ds.managedTurnOrigin?.turnId).toBeUndefined();
    expect((await h1.callLarkAsUser()).status).toBe(403);

    // 2. Direct prompt_submitted hook (tmux typing)
    const h2 = await createEndToEndHarness();
    h2.hold.reset(t0);
    h2.tracker.reset(t0);
    const exec2 = await h2.startManagedTurn('om_turn_a', USER_A);
    h2.scope.run(h2.runtimeBinding, () => {
      h2.env.observeClaudeBackgroundTasks([
        { type: 'user', uuid: 'u1', timestamp: evIso(t0 + 100), toolUseResult: { backgroundTaskId: 'b2' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bg' }] } },
        { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 200) },
      ]);
      h2.env.emitTurnTerminal('om_turn_a', 'completed');
    }, exec2);
    await h2.drainIpc();
    await h2.scope.run(h2.runtimeBinding, async () => {
      await h2.handlePromptSubmitted({ type: 'prompt_submitted' });
    }, exec2);
    await h2.drainIpc();
    expect(h2.ds.managedTurnOrigin?.turnId).toBeUndefined();

    // 3. Built-in CronCreate via notifyTerminalTurnStarted
    const h3 = await createEndToEndHarness();
    h3.hold.reset(t0);
    h3.tracker.reset(t0);
    const exec3 = await h3.startManagedTurn('om_turn_a', USER_A);
    h3.scope.run(h3.runtimeBinding, () => {
      h3.env.observeClaudeBackgroundTasks([
        { type: 'user', uuid: 'u1', timestamp: evIso(t0 + 100), toolUseResult: { backgroundTaskId: 'b3' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bg' }] } },
        { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 200) },
      ]);
      h3.env.emitTurnTerminal('om_turn_a', 'completed');
      h3.env.notifyTerminalTurnStarted({ turnId: 'scheduled-fire-1', isLocal: true, isScheduled: true });
    }, exec3);
    await h3.drainIpc();
    expect(h3.ds.managedTurnOrigin?.turnId).toBeUndefined();

    // 4. revokeManagedTurnOriginForRestart clears both activeTurnAuthority & ds.managedTurnOrigin synchronously
    const h4 = await createEndToEndHarness();
    h4.hold.reset(t0);
    h4.tracker.reset(t0);
    const exec4 = await h4.startManagedTurn('om_turn_a', USER_A);
    h4.scope.run(h4.runtimeBinding, () => {
      h4.env.observeClaudeBackgroundTasks([
        { type: 'user', uuid: 'u1', timestamp: evIso(t0 + 100), toolUseResult: { backgroundTaskId: 'b4' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bg' }] } },
        { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 200) },
      ]);
      h4.env.emitTurnTerminal('om_turn_a', 'completed');
      h4.env.revokeManagedTurnOriginForRestart();
    }, exec4);
    await h4.drainIpc();
    expect(h4.authority.snapshot()).toBeUndefined();
    expect(h4.ds.managedTurnOrigin?.turnId).toBeUndefined();
  });

  it('Security (3.10): PID marker stamps backgroundHeld=true so a respawned worker refuses to resurrect om_turn_a', async () => {
    const h = await createEndToEndHarness();
    const t0 = Date.now() - 60_000;
    h.hold.reset(t0);
    h.tracker.reset(t0);

    const execA = await h.startManagedTurn('om_turn_a', USER_A);
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        { type: 'user', uuid: 'u1', timestamp: evIso(t0 + 100), toolUseResult: { backgroundTaskId: 'b_pid' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bg' }] } },
        { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 200) },
      ]);
      h.env.emitTurnTerminal('om_turn_a', 'completed');
    }, execA);
    await h.drainIpc();

    const written = JSON.parse(readFileSync(h.pidMarkerFile, 'utf8'));
    expect(written.turnId).toBe('om_turn_a');
    expect(written.backgroundHeld).toBe(true);

    // Simulate a fresh respawned worker reading that same PID marker with empty emittedTurnTerminals
    const freshAuth = new ActiveTurnAuthority();
    const freshEnv: any = {
      sessionId: h.sessionId,
      activeTurnAuthority: freshAuth,
      backgroundAuthorityHold: new BackgroundTurnAuthorityHold(),
      currentBotmuxTurnId: undefined,
      currentBotmuxDispatchAttempt: undefined,
      currentBotmuxCallerOpenId: undefined,
      queuedTypeAheadTurns: [],
      retiredTurnIds: new Set<string>(),
      lastInitConfig: { cliId: 'claude-code' },
      existsSync,
      readFileSync,
      withPidMarkerLock: (_p: string, fn: () => void) => fn(),
      markerBelongsToLiveProcess: () => true,
      markerIdentityTurnId: (id: unknown) => typeof id === 'string' && id ? id : undefined,
      markerQueuedTurnStillLive: () => true,
      retireTerminatedMarkerTurn: () => false,
      readProcessStartIdentity,
      writeCliPidMarker: vi.fn(),
      publishSandboxRelayCapability: vi.fn(() => false),
      send: vi.fn(),
      log: vi.fn(),
    };
    for (const fn of ['setCaptureIdentity', 'activeAuthorityMatchesMarker', 'adoptInitialActiveTurn', 'adoptDisplacedActiveTurn', 'restoreQueuedTurnsFromMarkerDisk', 'bindCliPidMarker']) {
      freshEnv[fn] = loadWorkerFunction(fn, freshEnv);
    }

    freshEnv.bindCliPidMarker(h.pidMarkerFile, process.pid);
    expect(freshAuth.snapshot()).toBeUndefined();
    expect(freshEnv.currentBotmuxTurnId).toBeUndefined();
  });

  it('revokes ds.managedTurnOrigin via live-worker exact-capability backstop even if runtime replacement causes contract gateway reject, and ignores wrong capability', async () => {
    const h = await createEndToEndHarness({ crossPrincipalIsolation: true });
    const t0 = Date.now() - 60_000;
    h.hold.reset(t0);
    h.tracker.reset(t0);

    const execA = await h.startManagedTurn('om_turn_a', USER_A);
    const capA = h.ds.managedTurnOrigin.capability;
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        { type: 'user', uuid: 'u1', timestamp: evIso(t0 + 100), toolUseResult: { backgroundTaskId: 'b_rot' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bg' }] } },
        { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 200) },
      ]);
      h.env.emitTurnTerminal('om_turn_a', 'completed');
    }, execA);
    await h.drainIpc();

    // Non-continued runtime replacement (e.g. /clear creates a brand-new runtime with different physicalId)
    const replacedRuntime = h.bindRuntime('native-claude-2', 'other-physical-id');

    // A wrong-capability revoke must NOT clear ds.managedTurnOrigin
    await h.handleWorkerMessage({
      type: 'managed_turn_origin_revoked',
      sessionId: h.sessionId,
      turnId: 'om_turn_a',
      capability: 'wrong-capability-token',
      originChannelId: CHANNEL_ID,
      sessionContract: h.scope.envelope({ bindingId: replacedRuntime.bindingId, runtime: replacedRuntime.runtime, execution: execA }),
    });
    expect(h.ds.managedTurnOrigin?.turnId).toBe('om_turn_a');

    // Exact-capability revoke from live current worker MUST succeed via fail-closed backstop even though runtime changed!
    const gcBefore = h.gcCalls.length;
    await h.handleWorkerMessage({
      type: 'managed_turn_origin_revoked',
      sessionId: h.sessionId,
      turnId: 'om_turn_a',
      capability: capA,
      originChannelId: CHANNEL_ID,
      sessionContract: h.scope.envelope({ bindingId: replacedRuntime.bindingId, runtime: replacedRuntime.runtime, execution: execA }),
    });
    expect(h.ds.managedTurnOrigin?.turnId).toBeUndefined();
    expect(h.ds.activeInteractiveTurn).toBeUndefined();
    expect(h.gcCalls.length).toBeGreaterThan(gcBefore);
    expect(h.revokedCallbacks).toContain('om_turn_a');
    expect((await h.callBotmuxSendAttest(capA)).status).toBe(403);
    expect((await h.callLarkAsUser()).status).toBe(403);
  });

  it('Card UI parity: markPromptReady keeps activeTurnAuthority for Bash background task while still emitting idle screen_update with backgroundTasks: 1', () => {
    const authority = new ActiveTurnAuthority();
    const hold = new BackgroundTurnAuthorityHold();
    const tracker = new BackgroundTaskTracker();
    const pairer = new LegacyAgentAckPairer();
    const t0 = Date.now() - 10_000;
    hold.reset(t0);
    tracker.reset(t0);

    authority.reserve({ turnId: 'om_bash', caller: USER_A });
    authority.markStarted({ turnId: 'om_bash', caller: USER_A });
    hold.onForegroundTurnStarted({ turnId: 'om_bash', caller: USER_A });

    const events: TranscriptEvent[] = [
      { type: 'user', uuid: 'u1', timestamp: evIso(t0 + 100), toolUseResult: { backgroundTaskId: 'sh_1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bg' }] } },
      { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 200) },
    ];
    for (const ev of events) {
      tracker.observe(ev);
      applyClaudeTranscriptEventToAuthorityHold(hold, ev, pairer, t0 + 200);
    }
    expect(hold.phase()).toBe('HELD_WAITING_BG');
    expect(tracker.pendingTurnAgents()).toBe(0);
    expect(tracker.backgroundWait()).toBe(1);

    const sent: any[] = [];
    const releasedReasons: string[] = [];
    const scope: any = {
      activeTurnAuthority: authority,
      backgroundAuthorityHold: hold,
      backgroundTaskTracker: tracker,
      decideQueuedReadyTransition,
      ptyOutputGeneration: { snapshot: () => 1 },
      observedQueuedAdvanceGeneration: undefined,
      durableTurnInFlight: false,
      preserveActiveTurnAuthorityForReady: false,
      queuedTypeAheadTurns: [],
      pendingMessages: [],
      pendingAdoptMessages: [],
      pendingRawInputs: [],
      pendingInjections: [],
      pendingSessionRename: null,
      isFlushing: false,
      spawnArgvInitialPromptBusy: false,
      spawnArgvNeedsWorkingSeed: false,
      awaitingFirstPrompt: false,
      cliRestartInProgress: false,
      consecutiveInWorkerRestarts: 0,
      promptReadyEdges: 0,
      isPromptReady: false,
      reattachOpenTurnGate: false,
      queuedTurnAdvanceConsumedForPrompt: undefined,
      lastInitConfig: { cliId: 'claude-code' },
      currentBotmuxTurnId: 'om_bash',
      currentBotmuxDispatchAttempt: undefined,
      renderer: { snapshot: () => ({ content: 'prompt' }), rawSnapshot: () => 'prompt', markNewTurn: vi.fn() },
      idleDetector: { adoptPromptReady: vi.fn(), reset: vi.fn(), isStartupPending: () => false },
      freshnessInputQueue: { onPromptReady: vi.fn() },
      isCodexAppCliId: () => false,
      hasStructuredLifecycleBlock: () => false,
      releaseInterruptedStructuredBridgeOnFirstPrompt: vi.fn(),
      currentCodexObservedPid: vi.fn(),
      currentInputDeliveryQuarantine: () => false,
      holdForNativeSessionFork: () => false,
      probeStartupBlocker: () => false,
      readyGate: { shouldHold: () => false },
      traexFirstPromptViewportRejects: () => false,
      currentPostTerminalInputFence: () => false,
      spawnArgvTurnStartGateHolds: () => false,
      stopStructuredStartGraceRecheck: vi.fn(),
      stopBusyPatternIdleProbe: vi.fn(),
      advanceQueuedTypeAheadTurn: vi.fn(),
      flushPending: vi.fn(),
      structuredBridgeIs: () => false,
      busyReadyDeferral: { clear: vi.fn() },
      judgeClaudeBridgeTurn: vi.fn(),
      bridgeQueue: { cliQueueDrained: vi.fn() },
      settleSessionRenameOnPrompt: vi.fn(),
      syncQueuedTurnsFromMarkerDisk: () => false,
      releaseRawInputRestartGate: vi.fn(),
      inflightInputs: { onTurnComplete: vi.fn() },
      stuckDetector: { disarm: vi.fn() },
      maybeEmitWorkflowTranscriptOutput: vi.fn(),
      settleRestartAttemptOnReady: vi.fn(),
      shouldFlushInjectionsFirst: () => false,
      classifyUsageLimitWithNativeEvidence: (_c: string, status: string) => ({ status }),
      projectedRuntimeScreenStatus: () => 'idle',
      backgroundWaitPayload: () => ({ backgroundTasks: tracker.backgroundWait() }),
      modelRequestPayload: () => ({ awaySummaryPending: false }),
      refreshBackgroundWait: vi.fn(),
      publishScreenStatus: vi.fn(),
      send: (msg: any) => sent.push(msg),
      releaseActiveTurnAuthority: (reason: string) => { releasedReasons.push(reason); return true; },
      applyBackgroundAuthorityTransition: vi.fn(),
      log: vi.fn(),
    };
    const markPromptReady = loadWorkerFunction<() => void>('markPromptReady', scope);
    markPromptReady();

    // Authority NOT released on prompt_ready!
    expect(releasedReasons).toEqual([]);
    expect(authority.snapshot()?.turnId).toBe('om_bash');
    // Yet card UI stays idle with backgroundTasks: 1 and isPromptReady: true (#2072 / #3774 parity)
    expect(scope.isPromptReady).toBe(true);
    expect(sent.some(m => m.type === 'screen_update' && m.status === 'idle' && m.backgroundTasks === 1)).toBe(true);
  });

  it('bridgeApplyFingerprintSwitch settles pre-/clear background task and revokes prior hold on path rotation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-switch-bg-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const oldFile = join(dir, 'old.jsonl');
    const newFile = join(dir, 'new.jsonl');
    const t0 = Date.now() - 60_000;
    writeFileSync(oldFile, '', 'utf8');
    writeFileSync(newFile, [
      JSON.stringify({ type: 'user', uuid: 'c1', timestamp: evIso(t0 + 100), message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: evIso(t0 + 200), content: '<task-notification>\n<task-id>blv90xfzb</task-id>\n<status>completed</status>\n</task-notification>' }),
    ].join('\n') + '\n', 'utf8');

    const tracker = new BackgroundTaskTracker();
    const hold = new BackgroundTurnAuthorityHold();
    const pairer = new LegacyAgentAckPairer();
    tracker.reset(t0);
    hold.reset(t0);
    tracker.launch('blv90xfzb', 'shell', { atMs: t0 + 10 });
    hold.onForegroundTurnStarted({ turnId: 'om_pre_clear', caller: USER_A });
    hold.onTaskLaunched({ taskId: 'blv90xfzb', kind: 'shell', atMs: t0 + 10 }, t0 + 10);
    hold.onForegroundTurnEnded(t0 + 20);
    expect(tracker.pending()).toBe(1);
    expect(hold.phase()).toBe('HELD_WAITING_BG');

    const revoked: any[] = [];
    const scope: any = {
      bridgeJsonlPath: oldFile,
      bridgeJsonlDir: dir,
      bridgeOffset: 0,
      bridgeWatcher: null,
      bridgeBaselineDone: false,
      bridgePathConfirmedAtMs: 0,
      backgroundTaskTracker: tracker,
      backgroundAuthorityHold: hold,
      legacyAgentAckPairer: pairer,
      backgroundWaitTasks: 1,
      antigravityFooterBackgroundTasks: 0,
      backgroundStopScanOffsets: new Map(),
      backgroundStopScanSinceMs: t0,
      drainTranscript,
      dirname: (p: string) => join(p, '..'),
      recordBackgroundTranscriptRotation: vi.fn(),
      bindModelRequestClockToTranscript: vi.fn(),
      splitTranscriptEventsByCutoff: (events: TranscriptEvent[]) => ({ history: [], live: events }),
      beginNewBridgeTranscriptGeneration: vi.fn(),
      bridgeQueue: { absorb: vi.fn() },
      ingestClaudeSwitchLiveAndSettleUnreadTurn: vi.fn(),
      seedModelFallbackFromTranscript: vi.fn(),
      observeModelFallbackEvents: vi.fn(),
      modelRequestClock: { observe: vi.fn() },
      bridgeRememberSessionIdForPath: vi.fn(),
      sessionIdFromJsonlPath: () => 'new',
      bridgeMarkStalePidStateForAcceptedSid: vi.fn(),
      fsWatch: () => ({ close() {} }),
      syncBackgroundTaskPinsToDaemon: vi.fn(),
      applyBackgroundAuthorityTransition: (tr: any) => { if (tr.action === 'revoke') revoked.push(tr); },
      supersedeBackgroundAuthorityHold: (reason: any) => {
        const tr = hold.onSuperseded(reason);
        if (tr.action === 'revoke') revoked.push(tr);
      },
      log: vi.fn(),
    };
    scope.refreshBackgroundWait = loadWorkerFunction('refreshBackgroundWait', scope);
    scope.observeClaudeBackgroundTasks = loadWorkerFunction('observeClaudeBackgroundTasks', scope);
    const bridgeApplyFingerprintSwitch = loadWorkerFunction<(m: string, c: number, r: string, p?: number) => void>(
      'bridgeApplyFingerprintSwitch', scope,
    );

    bridgeApplyFingerprintSwitch(newFile, t0, 'fingerprint_test', 0);

    // Prior hold revoked on rotation AND blv90xfzb settled in BackgroundTaskTracker!
    expect(revoked.some(r => r.reason === 'superseded_by_clear')).toBe(true);
    expect(tracker.pending()).toBe(0);
    expect(tracker.backgroundWait()).toBe(0);
  });

  it('Security (3.10): flushPending holds User B during WAKE_ACTIVE and supersedes idle hold cleanly without isTypeAhead wedge when isPromptReady=false', async () => {
    const h = await createEndToEndHarness({ crossPrincipalIsolation: false });
    const t0 = Date.now() - 60_000;
    h.hold.reset(t0);
    h.tracker.reset(t0);

    const execA = await h.startManagedTurn('om_turn_a', USER_A);
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        { type: 'user', uuid: 'u1', timestamp: evIso(t0 + 100), toolUseResult: { backgroundTaskId: 'bg_w' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bg' }] } },
        { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 200) },
      ]);
      h.env.emitTurnTerminal('om_turn_a', 'completed');
      // Enter WAKE_ACTIVE
      h.env.observeClaudeBackgroundTasks([
        {
          type: 'user', uuid: 'uw', timestamp: evIso(t0 + 500), isSidechain: false,
          promptSource: 'system', turnOrigin: 'task_notification',
          message: { role: 'user', content: '<task-notification>\n<task-id>bg_w</task-id>\n<status>completed</status>\n</task-notification>' },
        },
      ]);
    }, execA);
    await h.drainIpc();
    expect(h.hold.isWakeActive()).toBe(true);

    // Load real flushPending into h.env
    const writtenToBackend: string[] = [];
    h.env.backend = {
      write: vi.fn((text: string) => writtenToBackend.push(text)),
      writeInput: vi.fn(async (text: string) => { writtenToBackend.push(text); }),
      isAlive: () => true,
    };
    h.env.effectiveBackendType = 'tmux';
    h.env.cliRestartInProgress = false;
    h.env.tuiPromptBlocking = false;
    h.env.readyGate = { shouldHold: () => false };
    h.env.isSettlingFirstFlush = false;
    h.env.awaitingPostSessionStartPromptEvidence = false;
    h.env.bridgeJsonlPath = null;
    h.env.codexBridgeFallbackActive = () => false;
    h.env.runtimePtyInputPolicy = () => ({ supportsTypeAhead: true, allowBackToBackWrites: true });
    h.env.promotePendingHumanInterruption = vi.fn();
    h.env.pendingInputAllowsTypeAhead = () => true;
    h.env.directRpcTurnBlocksTypeAhead = () => false;
    h.env.programStatusBlockedHoldsTypeAhead = () => false;
    h.env.traexQuestionHoldsHeldInput = () => false;
    h.env.nativeSessionForkPending = () => false;
    h.env.currentInputDeliveryQuarantine = () => false;
    h.env.currentPostTerminalInputFence = () => false;
    h.env.shouldDeferUserFlush = () => false;
    h.env.traexAutoModelInputHold = () => false;
    h.env.sessionRenameBlocksInput = () => false;
    h.env.codexModelMigrationCheckNeeded = () => false;
    h.env.codexModelMigrationBlocking = false;
    h.env.traexAutoModelSwitching = false;
    h.env.codexAutoUpgrade = null;
    h.env.initialInputOwnershipPending = false;
    h.env.shouldHoldCodexRunnerInput = () => false;
    h.env.codexRunnerFreshness = {};
    h.env.isCodexAppCliId = () => false;
    h.env.putBackStoppedRewindCutBeforeWrites = () => false;
    h.env.ambiguousSubmissionRecoveryHold = null;
    h.env.hasPendingInputForFlush = () => h.env.pendingMessages.length > 0;
    h.env.resetTraexAutoModelBeforePendingTurn = () => false;
    h.env.sessionRenameInFlight = () => false;
    h.env.injectionFlushing = false;
    h.env.traexNativeStartupInputIsPending = () => false;
    h.env.webTerminalInputWireDirty = () => false;
    h.env.bareShellLaunchBlocked = false;
    h.env.hookReviewHoldsQueuedWrite = () => false;
    h.env.pendingInputMayFlush = () => true;
    h.env.rpcLifecycleFailClosedOwners = new Set();
    h.env.probeStartupBlocker = () => false;
    h.env.commandLineWritesPending = 0;
    h.env.pendingInjections = [];
    h.env.isPromptReady = false;
    const realFlushPending = loadWorkerFunction<() => Promise<void>>('flushPending', h.env);

    // User B arrives while WAKE_ACTIVE -> flushPending MUST hold (not type-ahead into User A's wake!)
    h.env.pendingMessages.push({ content: 'hello from B', turnId: 'om_turn_b', trustedCaller: USER_B });
    await realFlushPending();
    expect(writtenToBackend).toEqual([]);
    expect(h.authority.snapshot()?.turnId).toBe('om_turn_a');
    expect(h.authority.snapshot()?.caller?.requestUserOpenId).toBe(USER_A.requestUserOpenId);

    // Once wake ends and another bg task keeps IDLE hold, flushPending supersedes idle hold cleanly
    h.hold.onTaskLaunched({ taskId: 'bg_w2', kind: 'shell', atMs: t0 + 600 }, t0 + 600);
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        { type: 'system', subtype: 'turn_duration', uuid: 'dw', timestamp: evIso(t0 + 700) },
      ]);
    }, execA);
    await h.drainIpc();
    expect(h.hold.isIdleWaiting()).toBe(true);

    // Next flush supersedes idle hold BEFORE writing -> om_turn_a revoked!
    h.env.CodexAppFlushPromptReplay = CodexAppFlushPromptReplay;
    h.env.codexRpcEngine = null;
    h.env.publishedCliInputBacklog = undefined;
    h.env.usageLimitTracker = { beginTurn: vi.fn(() => 1), currentTurn: () => 1 };
    h.env.detectBareShellLaunch = () => false;
    h.env.bareShellChecked = true;
    h.env.hasRunStartupCommands = true;
    h.env.runStartupCommands = vi.fn(async () => {});
    h.env.firstWriteMayProceed = () => true;
    h.env.traexQuestionBridgeActive = () => false;
    h.env.settleVerifiableSubmissionForJournal = vi.fn();
    h.env.freshnessInputQueue = { takeNormal: () => h.env.pendingMessages.shift() };
    h.env.inlineParkedTraexSkillCatalog = vi.fn();
    h.env.attachDeferredPluginSkillCatalog = vi.fn();
    h.env.applyMojoLivePatch = vi.fn();
    h.env.SubmissionWriteError = class extends Error {};
    h.env.adapterInputHandle = (be: unknown) => be;
    h.env.cliAdapter = {
      id: 'claude-code',
      claudeDataDir: join(h.root, '.claude'),
      writeInput: vi.fn(async (_be: unknown, text: string) => {
        writtenToBackend.push(text);
        return { submitted: true };
      }),
    };
    h.env.runAmbiguousSubmissionTransaction = async (_be: unknown, fn: () => Promise<any>, _settle: unknown, beforeWrite: () => void) => {
      beforeWrite();
      const result = await fn();
      return { result, recoveryFailureReason: undefined };
    };
    h.env.syncQueuedTurnsFromMarkerDisk = () => false;
    h.env.readSendMarkers = () => [];
    h.env.traexAutoModelRuntimeEligible = () => false;
    h.env.rememberSubmittedTurnText = () => undefined;
    h.env.noteCliInputWritten = vi.fn();
    h.env.beginCliWriteCycle = vi.fn();
    h.env.markTurnExecutionStart = vi.fn();
    h.env.stampMojoTurnMark = vi.fn();
    h.env.sendCliInputBacklog = vi.fn();
    h.env.cliSubmissionInFlight = null;
    h.env.firstAdmissionDone = true;
    h.env.openingInputBoxSettled = true;
    h.env.isClaudeCode = () => true;
    h.env.recordCliSubmissionInFlight = vi.fn();
    h.env.shouldDeferUserFlush = () => false;
    h.env.cliSubmissionWriteActive = false;
    h.env.admitTraexAutoModelPendingInput = async () => true;
    h.env.pendingInputQueueAllows = () => true;
    h.env.executeSubmissionTransaction = async (_be: unknown, _opts: unknown, fn: (hooks: any) => Promise<void>) => {
      await fn({ beforeWrite: () => {}, afterWrite: () => {} });
    };
    const execB = h.controller.admitInput('om_turn_b');
    h.scope.noteAdmission({ ref: execB, phase: 'queued' });
    // Run flushPending under the runtime binding so prepareNormalWrite executes cleanly
    await h.scope.run(h.runtimeBinding, async () => {
      try { await realFlushPending(); } catch (err: any) {
        if (!h.authority.snapshot()) throw err;
      }
    }, execB);
    await h.drainIpc();
    expect(h.hold.isIdleWaiting()).toBe(false);
    // Must NOT have queued om_turn_b as type-ahead behind om_turn_a, and MUST bind strictly to USER_B!
    expect(h.env.queuedTypeAheadTurns).toEqual([]);
    expect(h.authority.snapshot()?.turnId).toBe('om_turn_b');
    expect(h.authority.snapshot()?.caller?.requestUserOpenId).toBe(USER_B.requestUserOpenId);
    expect(h.authority.snapshot()?.identityTurnId).toBeUndefined();
  });

  it('Security (3.10): deliverRawInput revokes background-held authority before inheritOrStartControl', async () => {
    const h = await createEndToEndHarness();
    const t0 = Date.now() - 60_000;
    h.hold.reset(t0);
    h.tracker.reset(t0);

    const execA = await h.startManagedTurn('om_turn_a', USER_A);
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        { type: 'user', uuid: 'u1', timestamp: evIso(t0 + 100), toolUseResult: { backgroundTaskId: 'bg_raw' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bg' }] } },
        { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 200) },
      ]);
      h.env.emitTurnTerminal('om_turn_a', 'completed');
    }, execA);
    await h.drainIpc();
    expect(h.ds.managedTurnOrigin?.turnId).toBe('om_turn_a');

    // Run real deliverRawInput with /compact while om_turn_a is background-held
    h.env.backend = {
      writeInput: vi.fn(async () => {}),
      write: vi.fn(),
    };
    h.env.cliAdapter = { id: 'claude-code', writeInput: vi.fn(async () => {}) };
    h.env.beginCliWriteCycle = vi.fn();
    h.env.markTurnExecutionStart = vi.fn();
    h.env.stampMojoTurnMark = vi.fn();
    h.env.claudeSwitchKindForCommand = () => undefined;
    h.env.armSwitchConfirm = vi.fn();
    h.env.disarmSwitchConfirm = vi.fn();
    h.env.claudeBtwQuestion = () => undefined;
    h.env.armBtwCapture = vi.fn();
    h.env.disarmBtwCapture = vi.fn();
    h.env.classifyRawDispatchFailure = () => 'ordinary';
    h.env.finalizeRawCommandDelivery = vi.fn();
    h.env.isBtwCommand = () => false;
    h.env.armBtwOverlayCapture = vi.fn();
    h.env.isCompactCommand = () => false;
    h.env.rememberAutoCompactCommand = vi.fn();
    h.env.noteRawInputSubmitted = vi.fn();
    h.env.scheduleRawInputCommitAck = vi.fn();
    h.env.acknowledgeRawInputCommitted = vi.fn();
    h.env.cliSubmissionInFlight = null;
    h.env.runExclusiveBackendWrite = async (_be: unknown, fn: () => Promise<void>) => fn();
    h.env.webTerminalInputWireDirty = () => false;
    h.env.sendRawCommandLineWithRecoveryFence = async (_be: unknown, _content: string, beforeWrite: () => void) => {
      beforeWrite();
    };
    h.env.applyMojoLivePatch = vi.fn();
    h.env.SubmissionWriteError = class extends Error {};
    h.env.adoptWriteLock = Promise.resolve();
    h.env.executeSubmissionTransaction = async (_be: unknown, _opts: unknown, fn: (hooks: any) => Promise<void>) => {
      await fn({ beforeWrite: () => {}, afterWrite: () => {} });
    };
    const deliverRawInput = loadWorkerFunction<(msg: any) => Promise<void>>('deliverRawInput', h.env);

    await h.scope.run(h.runtimeBinding, async () => {
      await deliverRawInput({ content: '/compact', turnId: 'auto-compact:1' });
    }, execA);
    await h.drainIpc();

    // User A's held authority was revoked BEFORE inheritOrStartControl — auto-compact runs callerless, NOT as User A!
    expect(h.hold.phase()).toBe('IDLE');
    expect(h.authority.snapshot()?.turnId).toBe('auto-compact:1');
    expect(h.authority.snapshot()?.caller).toBeUndefined();
    expect(h.ds.managedTurnOrigin?.callerOpenId).toBeUndefined();
  });

  it('Adversarial P0-1 & P0-4: User B arriving during HELD_WAITING_BG BEFORE emitTurnTerminal(om_A) does NOT resurrect User A origin, and pre-write bridgeIngest drains prior events before markActiveTurnStarted', async () => {
    const h = await createEndToEndHarness({ crossPrincipalIsolation: false });
    const t0 = Date.now() - 60_000;
    h.hold.reset(t0);
    h.tracker.reset(t0);

    const execA = await h.startManagedTurn('om_turn_a', USER_A);
    // Enter HELD_WAITING_BG via transcript turn_duration WITHOUT calling emitTurnTerminal('om_turn_a') yet!
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        { type: 'user', uuid: 'u1', timestamp: evIso(t0 + 100), toolUseResult: { backgroundTaskId: 'bg_pre_term' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bg' }] } },
        { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 200) },
      ]);
    }, execA);
    await h.drainIpc();
    expect(h.hold.phase()).toBe('HELD_WAITING_BG');
    // emitTurnTerminal('om_turn_a') intentionally NOT emitted yet!

    // User B arrives while isPromptReady=false (XPI=OFF) -> supersedes om_turn_a & retires it
    h.env.isPromptReady = false;
    await h.handleMessage({ type: 'message', turnId: 'om_turn_b', content: 'USER B PROMPT', trustedCaller: USER_B });
    await h.drainIpc();
    expect(h.authority.snapshot()).toBeUndefined();
    expect(h.env.retiredTurnIds.has('om_turn_a')).toBe(true);

    // Flush User B through real flushPending -> prepareNormalWrite MUST NOT take isTypeAhead=true
    // and MUST NOT resurrect om_turn_a / USER_A via publishSandboxRelayCapability!
    const unreadPriorEvents: TranscriptEvent[] = [
      { type: 'system', subtype: 'turn_duration', uuid: 'd-late-prior', timestamp: evIso(t0 + 250) },
    ];
    let priorDrained = false;
    h.env.backend = { write: vi.fn(), writeInput: vi.fn(async () => ({ submitted: true })), isAlive: () => true };
    h.env.effectiveBackendType = 'tmux';
    h.env.cliRestartInProgress = false;
    h.env.tuiPromptBlocking = false;
    h.env.readyGate = { shouldHold: () => false };
    h.env.isSettlingFirstFlush = false;
    h.env.awaitingPostSessionStartPromptEvidence = false;
    h.env.bridgeJsonlPath = '/tmp/fake.jsonl';
    h.env.bridgeBaselineDone = true;
    h.env.bridgeIngest = vi.fn(() => {
      if (!priorDrained) {
        priorDrained = true;
        h.env.observeClaudeBackgroundTasks(unreadPriorEvents);
      }
    });
    h.env.bridgeMarkPendingTurn = () => 'om_turn_b';
    h.env.structuredTurnsWithSubmitNotice = new Set();
    h.env.armInputDeliveryQuarantine = vi.fn();
    h.env.noteOrdinaryImCommitted = vi.fn();
    h.env.scheduleSubmitFailureNotify = vi.fn();
    h.env.bridgeQueue = { holdForWrite: vi.fn(), releaseWriteHold: vi.fn() };
    h.env.codexBridgeFallbackActive = () => false;
    h.env.runtimePtyInputPolicy = () => ({ supportsTypeAhead: true, allowBackToBackWrites: true });
    h.env.promotePendingHumanInterruption = vi.fn();
    h.env.pendingInputAllowsTypeAhead = () => true;
    h.env.directRpcTurnBlocksTypeAhead = () => false;
    h.env.programStatusBlockedHoldsTypeAhead = () => false;
    h.env.traexQuestionHoldsHeldInput = () => false;
    h.env.nativeSessionForkPending = () => false;
    h.env.currentInputDeliveryQuarantine = () => false;
    h.env.currentPostTerminalInputFence = () => false;
    h.env.shouldDeferUserFlush = () => false;
    h.env.traexAutoModelInputHold = () => false;
    h.env.sessionRenameBlocksInput = () => false;
    h.env.codexModelMigrationCheckNeeded = () => false;
    h.env.codexModelMigrationBlocking = false;
    h.env.traexAutoModelSwitching = false;
    h.env.codexAutoUpgrade = null;
    h.env.initialInputOwnershipPending = false;
    h.env.shouldHoldCodexRunnerInput = () => false;
    h.env.codexRunnerFreshness = {};
    h.env.isCodexAppCliId = () => false;
    h.env.putBackStoppedRewindCutBeforeWrites = () => false;
    h.env.ambiguousSubmissionRecoveryHold = null;
    h.env.hasPendingInputForFlush = () => h.env.pendingMessages.length > 0;
    h.env.resetTraexAutoModelBeforePendingTurn = () => false;
    h.env.sessionRenameInFlight = () => false;
    h.env.injectionFlushing = false;
    h.env.traexNativeStartupInputIsPending = () => false;
    h.env.webTerminalInputWireDirty = () => false;
    h.env.bareShellLaunchBlocked = false;
    h.env.hookReviewHoldsQueuedWrite = () => false;
    h.env.pendingInputMayFlush = () => true;
    h.env.rpcLifecycleFailClosedOwners = new Set();
    h.env.probeStartupBlocker = () => false;
    h.env.commandLineWritesPending = 0;
    h.env.pendingInjections = [];
    h.env.CodexAppFlushPromptReplay = CodexAppFlushPromptReplay;
    h.env.codexRpcEngine = null;
    h.env.publishedCliInputBacklog = undefined;
    h.env.usageLimitTracker = { beginTurn: vi.fn(() => 1), currentTurn: () => 1 };
    h.env.detectBareShellLaunch = () => false;
    h.env.bareShellChecked = true;
    h.env.hasRunStartupCommands = true;
    h.env.runStartupCommands = vi.fn(async () => {});
    h.env.firstWriteMayProceed = () => true;
    h.env.traexQuestionBridgeActive = () => false;
    h.env.settleVerifiableSubmissionForJournal = vi.fn();
    h.env.freshnessInputQueue = { takeNormal: () => h.env.pendingMessages.shift() };
    h.env.inlineParkedTraexSkillCatalog = vi.fn();
    h.env.attachDeferredPluginSkillCatalog = vi.fn();
    h.env.applyMojoLivePatch = vi.fn();
    h.env.SubmissionWriteError = class extends Error {};
    h.env.adapterInputHandle = (be: unknown) => be;
    h.env.t = (k: string) => k;
    h.env.cliAdapter = {
      id: 'claude-code',
      claudeDataDir: join(h.root, '.claude'),
      writeInput: vi.fn(async () => true),
    };
    h.env.runAmbiguousSubmissionTransaction = async (_be: unknown, fn: () => Promise<any>, _settle: unknown, beforeWrite: () => void) => {
      beforeWrite();
      const result = await fn();
      return { result, recoveryFailureReason: undefined };
    };
    h.env.syncQueuedTurnsFromMarkerDisk = () => false;
    h.env.readSendMarkers = () => [];
    h.env.traexAutoModelRuntimeEligible = () => false;
    h.env.rememberSubmittedTurnText = () => undefined;
    h.env.noteCliInputWritten = vi.fn();
    h.env.beginCliWriteCycle = vi.fn();
    h.env.markTurnExecutionStart = vi.fn();
    h.env.stampMojoTurnMark = vi.fn();
    h.env.sendCliInputBacklog = vi.fn();
    h.env.cliSubmissionInFlight = null;
    h.env.firstAdmissionDone = true;
    h.env.openingInputBoxSettled = true;
    h.env.isClaudeCode = () => true;
    h.env.recordCliSubmissionInFlight = vi.fn();

    const realFlushPending = loadWorkerFunction<() => Promise<void>>('flushPending', h.env);
    const execB = h.controller.admitInput('om_turn_b');
    h.scope.noteAdmission({ ref: execB, phase: 'queued' });
    await h.scope.run(h.runtimeBinding, async () => {
      await realFlushPending();
    }, execB);
    await h.drainIpc();

    // Strictly USER_B (never resurrected USER_A!), and unread prior turn_duration drained BEFORE
    // markActiveTurnStarted(om_turn_b), so om_turn_b is still FOREGROUND (not wiped to IDLE)!
    expect(h.env.queuedTypeAheadTurns).toEqual([]);
    expect(h.authority.snapshot()?.turnId).toBe('om_turn_b');
    expect(h.authority.snapshot()?.caller?.requestUserOpenId).toBe(USER_B.requestUserOpenId);
    expect(h.ds.managedTurnOrigin?.turnId).toBe('om_turn_b');
    expect(h.ds.managedTurnOrigin?.callerOpenId).toBe(USER_B.requestUserOpenId);
    expect(h.hold.phase()).toBe('FOREGROUND');
    expect(h.hold.owner()).toEqual({ turnId: 'om_turn_b' });

    const larkB = await h.callLarkAsUser();
    expect(larkB.status).toBe(200);
    expect(await larkB.json()).toMatchObject({ ok: true, credential: `token-for-${USER_B.requestUserOpenId}` });
  });

  it('Adversarial P0-3, P1-7 & P2-4: revoked capability tombstone blocks delayed managed_turn_origin reinstall, backstop handles policy-only revoke, and stale cap revoke preserves rotated activeInteractiveTurn', async () => {
    const h = await createEndToEndHarness({ crossPrincipalIsolation: true });
    const execA = await h.startManagedTurn('om_turn_a', USER_A);
    const cap1 = h.ds.managedTurnOrigin.capability;

    // 1. Rotate to cap2 on same turn, then send stale cap1 revoke -> MUST NOT clear ds.activeInteractiveTurn!
    h.scope.run(h.runtimeBinding, () => {
      h.env.publishSandboxRelayCapability();
    }, execA);
    await h.drainIpc();
    const cap2 = h.ds.managedTurnOrigin.capability;
    expect(cap2).not.toBe(cap1);

    await h.handleWorkerMessage({
      type: 'managed_turn_origin_revoked',
      sessionId: h.sessionId,
      turnId: 'om_turn_a',
      capability: cap1,
      originChannelId: CHANNEL_ID,
      sessionContract: h.scope.envelope({ bindingId: h.runtimeBinding.bindingId, runtime: h.runtimeBinding.runtime, execution: execA }),
    });
    expect(h.ds.managedTurnOrigin?.capability).toBe(cap2);
    expect(h.ds.activeInteractiveTurn?.turnId).toBe('om_turn_a');

    // 2. Delayed managed_turn_origin carrying already-revoked cap1 MUST be dropped by tombstone!
    await h.handleWorkerMessage({
      type: 'managed_turn_origin',
      sessionId: h.sessionId,
      turnId: 'om_turn_a',
      capability: cap1,
      policyCapability: 'policy-cap-1',
      originChannelId: CHANNEL_ID,
      trustedCaller: USER_A,
      sessionContract: h.scope.envelope({ bindingId: h.runtimeBinding.bindingId, runtime: h.runtimeBinding.runtime, execution: execA }),
    });
    expect(h.ds.managedTurnOrigin?.capability).toBe(cap2);

    // 3. Policy-only revoke rejected by non-continued runtime replacement MUST still clear policyCapability via backstop!
    const replacedRuntime = h.bindRuntime('native-claude-replaced', 'other-phys');
    await h.handleWorkerMessage({
      type: 'managed_turn_origin_revoked',
      sessionId: h.sessionId,
      turnId: 'om_turn_a',
      policyCapability: 'policy-cap-1',
      originChannelId: CHANNEL_ID,
      sessionContract: h.scope.envelope({ bindingId: replacedRuntime.bindingId, runtime: replacedRuntime.runtime, execution: execA }),
    });
    expect(h.ds.managedTurnOrigin?.policyCapability).toBeUndefined();
  });

  it('Adversarial P1-9: markPromptReady pre-drains Claude JSONL before checking backgroundAuthorityHold.holds()', () => {
    const authority = new ActiveTurnAuthority();
    const hold = new BackgroundTurnAuthorityHold();
    const tracker = new BackgroundTaskTracker();
    const pairer = new LegacyAgentAckPairer();
    const t0 = Date.now() - 10_000;
    hold.reset(t0);
    tracker.reset(t0);

    authority.reserve({ turnId: 'om_fast_idle', caller: USER_A });
    authority.markStarted({ turnId: 'om_fast_idle', caller: USER_A });
    hold.onForegroundTurnStarted({ turnId: 'om_fast_idle', caller: USER_A });

    // Background launch is on disk (not yet drained before markPromptReady!)
    let drained = false;
    const releasedReasons: string[] = [];
    const scope: any = {
      activeTurnAuthority: authority,
      backgroundAuthorityHold: hold,
      backgroundTaskTracker: tracker,
      bridgeJsonlPath: '/tmp/live.jsonl',
      bridgeBaselineDone: true,
      bridgeIngest: vi.fn(() => {
        if (drained) return;
        drained = true;
        const evs: TranscriptEvent[] = [
          { type: 'user', uuid: 'u1', timestamp: evIso(t0 + 100), toolUseResult: { backgroundTaskId: 'sh_unread' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bg' }] } },
          { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 200) },
        ];
        for (const ev of evs) {
          tracker.observe(ev);
          applyClaudeTranscriptEventToAuthorityHold(hold, ev, pairer, t0 + 200);
        }
      }),
      decideQueuedReadyTransition,
      ptyOutputGeneration: { snapshot: () => 1 },
      observedQueuedAdvanceGeneration: undefined,
      durableTurnInFlight: false,
      preserveActiveTurnAuthorityForReady: false,
      queuedTypeAheadTurns: [],
      pendingMessages: [],
      pendingAdoptMessages: [],
      pendingRawInputs: [],
      pendingInjections: [],
      pendingSessionRename: null,
      isFlushing: false,
      spawnArgvInitialPromptBusy: false,
      spawnArgvNeedsWorkingSeed: false,
      awaitingFirstPrompt: false,
      cliRestartInProgress: false,
      consecutiveInWorkerRestarts: 0,
      promptReadyEdges: 0,
      isPromptReady: false,
      reattachOpenTurnGate: false,
      queuedTurnAdvanceConsumedForPrompt: undefined,
      lastInitConfig: { cliId: 'claude-code' },
      currentBotmuxTurnId: 'om_fast_idle',
      currentBotmuxDispatchAttempt: undefined,
      renderer: { snapshot: () => ({ content: 'prompt' }), rawSnapshot: () => 'prompt', markNewTurn: vi.fn() },
      idleDetector: { adoptPromptReady: vi.fn(), reset: vi.fn(), isStartupPending: () => false },
      freshnessInputQueue: { onPromptReady: vi.fn() },
      isCodexAppCliId: () => false,
      hasStructuredLifecycleBlock: () => false,
      releaseInterruptedStructuredBridgeOnFirstPrompt: vi.fn(),
      currentCodexObservedPid: vi.fn(),
      currentInputDeliveryQuarantine: () => false,
      holdForNativeSessionFork: () => false,
      probeStartupBlocker: () => false,
      readyGate: { shouldHold: () => false },
      traexFirstPromptViewportRejects: () => false,
      currentPostTerminalInputFence: () => false,
      spawnArgvTurnStartGateHolds: () => false,
      stopStructuredStartGraceRecheck: vi.fn(),
      stopBusyPatternIdleProbe: vi.fn(),
      advanceQueuedTypeAheadTurn: vi.fn(),
      flushPending: vi.fn(),
      structuredBridgeIs: () => false,
      busyReadyDeferral: { clear: vi.fn() },
      judgeClaudeBridgeTurn: vi.fn(),
      bridgeQueue: { cliQueueDrained: vi.fn() },
      settleSessionRenameOnPrompt: vi.fn(),
      syncQueuedTurnsFromMarkerDisk: () => false,
      releaseRawInputRestartGate: vi.fn(),
      inflightInputs: { onTurnComplete: vi.fn() },
      stuckDetector: { disarm: vi.fn() },
      maybeEmitWorkflowTranscriptOutput: vi.fn(),
      settleRestartAttemptOnReady: vi.fn(),
      shouldFlushInjectionsFirst: () => false,
      classifyUsageLimitWithNativeEvidence: (_c: string, status: string) => ({ status }),
      projectedRuntimeScreenStatus: () => 'idle',
      backgroundWaitPayload: () => ({ backgroundTasks: tracker.backgroundWait() }),
      modelRequestPayload: () => ({ awaySummaryPending: false }),
      refreshBackgroundWait: vi.fn(),
      publishScreenStatus: vi.fn(),
      send: vi.fn(),
      releaseActiveTurnAuthority: (reason: string) => { releasedReasons.push(reason); return true; },
      applyBackgroundAuthorityTransition: vi.fn(),
      log: vi.fn(),
    };

    loadWorkerFunction<() => void>('markPromptReady', scope)();
    expect(scope.bridgeIngest).toHaveBeenCalledTimes(1);
    expect(releasedReasons).toEqual([]);
    expect(hold.phase()).toBe('HELD_WAITING_BG');
  });

  it('Adversarial P1-6, P2-2 & P2-3: fingerprint switch preserves post-/clear FOREGROUND turn & folds history stops before seeding; prompt_submitted stale recall & prompt_cache_keepalive fail closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-post-clear-fg-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const oldFile = join(dir, 'old.jsonl');
    const newFile = join(dir, 'new.jsonl');
    const t0 = Date.now() - 60_000;
    writeFileSync(oldFile, '', 'utf8');
    // History stops old_agent before cutoff; live launches new_bg + resumes old_agent under post-/clear FOREGROUND om_B
    writeFileSync(newFile, [
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: evIso(t0 + 50), content: '<task-notification>\n<task-id>old_agent</task-id>\n<status>completed</status>\n</task-notification>' }),
      JSON.stringify({ type: 'user', uuid: 'uB', timestamp: evIso(t0 + 500), promptSource: 'user', message: { role: 'user', content: 'resume old agent' } }),
      JSON.stringify({ type: 'user', uuid: 'uRes', timestamp: evIso(t0 + 600), toolUseResult: { success: true, resumedAgentId: 'old_agent' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tr1', content: 'resumed' }] } }),
      JSON.stringify({ type: 'system', subtype: 'turn_duration', uuid: 'dB', timestamp: evIso(t0 + 700) }),
    ].join('\n') + '\n', 'utf8');

    const tracker = new BackgroundTaskTracker();
    const hold = new BackgroundTurnAuthorityHold();
    const pairer = new LegacyAgentAckPairer();
    tracker.reset(t0);
    hold.reset(t0);
    // old_agent was launched before /clear
    tracker.launch('old_agent', 'agent', { atMs: t0 + 10 });
    hold.seedPreexistingLiveTasks(['old_agent']);
    // Brand-new post-/clear turn om_B is already in FOREGROUND
    hold.onForegroundTurnStarted({ turnId: 'om_B', caller: USER_A });

    const scope: any = {
      bridgeJsonlPath: oldFile,
      bridgeJsonlDir: dir,
      bridgeOffset: 0,
      bridgeWatcher: null,
      bridgeBaselineDone: false,
      bridgePathConfirmedAtMs: 0,
      backgroundTaskTracker: tracker,
      backgroundAuthorityHold: hold,
      legacyAgentAckPairer: pairer,
      backgroundWaitTasks: 0,
      antigravityFooterBackgroundTasks: 0,
      backgroundStopScanOffsets: new Map(),
      backgroundStopScanSinceMs: t0,
      drainTranscript,
      dirname: (p: string) => join(p, '..'),
      recordBackgroundTranscriptRotation: vi.fn(),
      bindModelRequestClockToTranscript: vi.fn(),
      splitTranscriptEventsByCutoff: (events: TranscriptEvent[]) => ({
        history: events.slice(0, 1),
        live: events.slice(1),
      }),
      beginNewBridgeTranscriptGeneration: vi.fn(),
      bridgeQueue: { absorb: vi.fn() },
      ingestClaudeSwitchLiveAndSettleUnreadTurn: vi.fn(),
      seedModelFallbackFromTranscript: vi.fn(),
      observeModelFallbackEvents: vi.fn(),
      modelRequestClock: { observe: vi.fn() },
      bridgeRememberSessionIdForPath: vi.fn(),
      sessionIdFromJsonlPath: () => 'new',
      bridgeMarkStalePidStateForAcceptedSid: vi.fn(),
      fsWatch: () => ({ close() {} }),
      syncBackgroundTaskPinsToDaemon: vi.fn(),
      applyBackgroundAuthorityTransition: vi.fn(),
      supersedeBackgroundAuthorityHold: vi.fn(),
      log: vi.fn(),
    };
    scope.refreshBackgroundWait = loadWorkerFunction('refreshBackgroundWait', scope);
    scope.observeClaudeBackgroundTasks = loadWorkerFunction('observeClaudeBackgroundTasks', scope);
    loadWorkerFunction<(m: string, c: number, r: string, p?: number) => void>('bridgeApplyFingerprintSwitch', scope)(
      newFile, t0 + 400, 'fingerprint_test', 0,
    );

    // Post-/clear FOREGROUND om_B was NOT wiped AND owns resumed old_agent!
    expect(scope.supersedeBackgroundAuthorityHold).not.toHaveBeenCalled();
    expect(hold.phase()).toBe('HELD_WAITING_BG');
    expect(hold.owner()).toEqual({ turnId: 'om_B' });

    // P2-2: prompt_submitted matching held owner (stale WrittenInputLedger recall) revokes; keepalive defers!
    const h = await createEndToEndHarness();
    h.hold.reset(t0);
    h.tracker.reset(t0);
    const execA = await h.startManagedTurn('om_turn_a', USER_A);
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        { type: 'user', uuid: 'u1', timestamp: evIso(t0 + 100), toolUseResult: { backgroundTaskId: 'b_ka' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bg' }] } },
        { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 200) },
      ]);
      h.env.emitTurnTerminal('om_turn_a', 'completed');
    }, execA);
    await h.drainIpc();

    const handleKeepalive = loadWorkerMessageHandler('prompt_cache_keepalive', h.env);
    h.env.awaySummaryFocus = { isActive: false };
    await h.scope.run(h.runtimeBinding, async () => {
      await handleKeepalive({ type: 'prompt_cache_keepalive', text: 'ping' });
    }, execA);
    expect(h.wire.some(m => m.type === 'prompt_cache_keepalive_result' && m.injected === false && m.reason === 'background_hold_active')).toBe(true);

    // Stale WrittenInputLedger recall returning 'om_turn_a' during HELD_WAITING_BG MUST still revoke!
    h.env.writtenInputs = { takeSubmitted: () => 'om_turn_a' };
    await h.scope.run(h.runtimeBinding, async () => {
      await h.handlePromptSubmitted({ type: 'prompt_submitted' });
    }, execA);
    await h.drainIpc();
    expect(h.hold.phase()).toBe('IDLE');
    expect(h.ds.managedTurnOrigin?.turnId).toBeUndefined();
  });

  it('Adversarial P1-1: flushPending under XPI=ON with queueAfterActiveTurn preserves isPromptReady=true during HELD_WAITING_BG (no deadlock)', async () => {
    const h = await createEndToEndHarness({ crossPrincipalIsolation: true });
    const t0 = Date.now() - 60_000;
    h.hold.reset(t0);
    h.tracker.reset(t0);

    const execA = await h.startManagedTurn('om_turn_a', USER_A);
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        { type: 'user', uuid: 'u1', timestamp: evIso(t0 + 100), toolUseResult: { backgroundTaskId: 'bg_xpi_q' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bg' }] } },
        { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 200) },
      ]);
      h.env.emitTurnTerminal('om_turn_a', 'completed');
    }, execA);
    await h.drainIpc();

    h.env.isPromptReady = true;
    h.env.backend = { write: vi.fn(), writeInput: vi.fn(async () => ({ submitted: true })), isAlive: () => true };
    h.env.effectiveBackendType = 'tmux';
    h.env.cliRestartInProgress = false;
    h.env.tuiPromptBlocking = false;
    h.env.readyGate = { shouldHold: () => false };
    h.env.isSettlingFirstFlush = false;
    h.env.awaitingPostSessionStartPromptEvidence = false;
    h.env.bridgeJsonlPath = null;
    h.env.codexBridgeFallbackActive = () => false;
    h.env.runtimePtyInputPolicy = () => ({ supportsTypeAhead: false, allowBackToBackWrites: false });
    h.env.promotePendingHumanInterruption = vi.fn();
    h.env.pendingInputAllowsTypeAhead = () => false;
    h.env.directRpcTurnBlocksTypeAhead = () => false;
    h.env.programStatusBlockedHoldsTypeAhead = () => false;
    h.env.traexQuestionHoldsHeldInput = () => false;
    h.env.nativeSessionForkPending = () => false;
    h.env.currentInputDeliveryQuarantine = () => false;
    h.env.currentPostTerminalInputFence = () => false;
    h.env.shouldDeferUserFlush = () => false;
    h.env.traexAutoModelInputHold = () => false;
    h.env.sessionRenameBlocksInput = () => false;
    h.env.codexModelMigrationCheckNeeded = () => false;
    h.env.codexModelMigrationBlocking = false;
    h.env.traexAutoModelSwitching = false;
    h.env.codexAutoUpgrade = null;
    h.env.initialInputOwnershipPending = false;
    h.env.shouldHoldCodexRunnerInput = () => false;
    h.env.codexRunnerFreshness = {};
    h.env.isCodexAppCliId = () => false;
    h.env.putBackStoppedRewindCutBeforeWrites = () => false;
    h.env.ambiguousSubmissionRecoveryHold = null;
    h.env.hasPendingInputForFlush = () => h.env.pendingMessages.length > 0;
    h.env.resetTraexAutoModelBeforePendingTurn = () => false;
    h.env.sessionRenameInFlight = () => false;
    h.env.injectionFlushing = false;
    h.env.traexNativeStartupInputIsPending = () => false;
    h.env.webTerminalInputWireDirty = () => false;
    h.env.bareShellLaunchBlocked = false;
    h.env.hookReviewHoldsQueuedWrite = () => false;
    h.env.pendingInputMayFlush = () => true;
    h.env.rpcLifecycleFailClosedOwners = new Set();
    h.env.probeStartupBlocker = () => false;
    h.env.commandLineWritesPending = 0;
    h.env.pendingInjections = [];
    h.env.beginCliWriteCycle = vi.fn(() => { h.env.isPromptReady = false; });

    // Queue a groupSerialInput User B turn behind XPI=ON background hold
    h.env.pendingMessages.push({
      content: 'queued B',
      turnId: 'om_turn_b',
      queueAfterActiveTurn: true,
      trustedCaller: USER_B,
    });
    const realFlushPending = loadWorkerFunction<() => Promise<void>>('flushPending', h.env);
    await realFlushPending();

    // Must NOT have called beginCliWriteCycle or cleared isPromptReady=false during HELD_WAITING_BG!
    expect(h.env.beginCliWriteCycle).not.toHaveBeenCalled();
    expect(h.env.isPromptReady).toBe(true);
    expect(h.env.pendingMessages).toHaveLength(1);

    // Contrast (P1-2): when a LIVE FOREGROUND turn (isIdleWaiting() === false) blocks a
    // queueAfterActiveTurn input, flushPending MUST clear isPromptReady=false via beginCliWriteCycle
    // so the live turn's own turn_idle edge is never dropped as `already-ready`!
    h.hold.onForegroundTurnStarted({ turnId: 'om_turn_live', caller: USER_A });
    h.authority.clear();
    h.authority.reserve({ turnId: 'om_turn_live', caller: USER_A });
    h.authority.markStarted({ turnId: 'om_turn_live', caller: USER_A });
    expect(h.hold.isIdleWaiting()).toBe(false);
    h.env.isPromptReady = true;
    h.env.CodexAppFlushPromptReplay = CodexAppFlushPromptReplay;
    h.env.codexRpcEngine = null;
    h.env.publishedCliInputBacklog = undefined;
    h.env.bareShellChecked = true;
    h.env.hasRunStartupCommands = true;
    h.env.firstWriteMayProceed = () => true;
    h.env.runStartupCommands = vi.fn(async () => {});
    h.env.detectBareShellLaunch = () => false;
    h.env.traexAutoModelRuntimeEligible = () => false;
    h.env.traexQuestionBridgeActive = () => false;
    await realFlushPending();
    expect(h.env.beginCliWriteCycle).toHaveBeenCalledTimes(1);
    expect(h.env.isPromptReady).toBe(false);
    expect(h.env.pendingMessages).toHaveLength(1);
  });

  it('P2 boundary: User B arriving during WAKE_ACTIVE stays fenced off CLI, then after wake closes User A cap returns 403 and User B runs strictly as User B', async () => {
    const h = await createEndToEndHarness({ crossPrincipalIsolation: false });
    const t0 = Date.now() - 60_000;
    h.hold.reset(t0);
    h.tracker.reset(t0);

    const execA = await h.startManagedTurn('om_turn_a', USER_A);
    const capA = h.ds.managedTurnOrigin.capability;
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        { type: 'user', uuid: 'u1', timestamp: evIso(t0 + 100), toolUseResult: { backgroundTaskId: 'bg_wake_p2' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'bg' }] } },
        { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: evIso(t0 + 200) },
      ]);
      h.env.emitTurnTerminal('om_turn_a', 'completed');
      h.env.observeClaudeBackgroundTasks([
        {
          type: 'user', uuid: 'uw', timestamp: evIso(t0 + 500), isSidechain: false,
          promptSource: 'system', turnOrigin: 'task_notification',
          message: { role: 'user', content: '<task-notification>\n<task-id>bg_wake_p2</task-id>\n<status>completed</status>\n</task-notification>' },
        },
      ]);
    }, execA);
    await h.drainIpc();
    expect(h.hold.isWakeActive()).toBe(true);

    // Wire real flushPending to verify User B cannot cross the CLI write fence while WAKE_ACTIVE
    const writtenTexts: string[] = [];
    h.env.backend = { write: vi.fn(), writeInput: vi.fn(async () => true), isAlive: () => true };
    h.env.effectiveBackendType = 'tmux';
    h.env.cliRestartInProgress = false;
    h.env.tuiPromptBlocking = false;
    h.env.readyGate = { shouldHold: () => false };
    h.env.isSettlingFirstFlush = false;
    h.env.awaitingPostSessionStartPromptEvidence = false;
    h.env.bridgeJsonlPath = null;
    h.env.codexBridgeFallbackActive = () => false;
    h.env.runtimePtyInputPolicy = () => ({ supportsTypeAhead: true, allowBackToBackWrites: true });
    h.env.promotePendingHumanInterruption = vi.fn();
    h.env.pendingInputAllowsTypeAhead = () => true;
    h.env.directRpcTurnBlocksTypeAhead = () => false;
    h.env.programStatusBlockedHoldsTypeAhead = () => false;
    h.env.traexQuestionHoldsHeldInput = () => false;
    h.env.nativeSessionForkPending = () => false;
    h.env.currentInputDeliveryQuarantine = () => false;
    h.env.currentPostTerminalInputFence = () => false;
    h.env.shouldDeferUserFlush = () => false;
    h.env.traexAutoModelInputHold = () => false;
    h.env.sessionRenameBlocksInput = () => false;
    h.env.codexModelMigrationCheckNeeded = () => false;
    h.env.codexModelMigrationBlocking = false;
    h.env.traexAutoModelSwitching = false;
    h.env.codexAutoUpgrade = null;
    h.env.initialInputOwnershipPending = false;
    h.env.shouldHoldCodexRunnerInput = () => false;
    h.env.codexRunnerFreshness = {};
    h.env.isCodexAppCliId = () => false;
    h.env.putBackStoppedRewindCutBeforeWrites = () => false;
    h.env.ambiguousSubmissionRecoveryHold = null;
    h.env.hasPendingInputForFlush = () => h.env.pendingMessages.length > 0;
    h.env.resetTraexAutoModelBeforePendingTurn = () => false;
    h.env.sessionRenameInFlight = () => false;
    h.env.injectionFlushing = false;
    h.env.traexNativeStartupInputIsPending = () => false;
    h.env.webTerminalInputWireDirty = () => false;
    h.env.bareShellLaunchBlocked = false;
    h.env.hookReviewHoldsQueuedWrite = () => false;
    h.env.pendingInputMayFlush = () => true;
    h.env.rpcLifecycleFailClosedOwners = new Set();
    h.env.probeStartupBlocker = () => false;
    h.env.commandLineWritesPending = 0;
    h.env.pendingInjections = [];
    h.env.CodexAppFlushPromptReplay = CodexAppFlushPromptReplay;
    h.env.codexRpcEngine = null;
    h.env.publishedCliInputBacklog = undefined;
    h.env.usageLimitTracker = { beginTurn: vi.fn(() => 1), currentTurn: () => 1 };
    h.env.detectBareShellLaunch = () => false;
    h.env.bareShellChecked = true;
    h.env.hasRunStartupCommands = true;
    h.env.runStartupCommands = vi.fn(async () => {});
    h.env.firstWriteMayProceed = () => true;
    h.env.traexQuestionBridgeActive = () => false;
    h.env.settleVerifiableSubmissionForJournal = vi.fn();
    h.env.freshnessInputQueue = { takeNormal: () => h.env.pendingMessages.shift() };
    h.env.inlineParkedTraexSkillCatalog = vi.fn();
    h.env.attachDeferredPluginSkillCatalog = vi.fn();
    h.env.applyMojoLivePatch = vi.fn();
    h.env.SubmissionWriteError = class extends Error {};
    h.env.adapterInputHandle = (be: unknown) => be;
    h.env.t = (k: string) => k;
    h.env.cliAdapter = {
      id: 'claude-code',
      claudeDataDir: join(h.root, '.claude'),
      writeInput: vi.fn(async (_be: unknown, text: string) => {
        writtenTexts.push(text);
        return true;
      }),
    };
    h.env.runAmbiguousSubmissionTransaction = async (_be: unknown, fn: () => Promise<any>, _settle: unknown, beforeWrite: () => void) => {
      beforeWrite();
      const result = await fn();
      return { result, recoveryFailureReason: undefined };
    };
    h.env.syncQueuedTurnsFromMarkerDisk = () => false;
    h.env.readSendMarkers = () => [];
    h.env.traexAutoModelRuntimeEligible = () => false;
    h.env.rememberSubmittedTurnText = () => undefined;
    h.env.noteCliInputWritten = vi.fn();
    h.env.beginCliWriteCycle = vi.fn();
    h.env.markTurnExecutionStart = vi.fn();
    h.env.stampMojoTurnMark = vi.fn();
    h.env.sendCliInputBacklog = vi.fn();
    h.env.cliSubmissionInFlight = null;
    h.env.firstAdmissionDone = true;
    h.env.openingInputBoxSettled = true;
    h.env.isClaudeCode = () => true;
    h.env.recordCliSubmissionInFlight = vi.fn();
    h.env.structuredTurnsWithSubmitNotice = new Set();
    h.env.armInputDeliveryQuarantine = vi.fn();
    h.env.noteOrdinaryImCommitted = vi.fn();
    h.env.scheduleSubmitFailureNotify = vi.fn();
    h.env.isPromptReady = false;

    const realFlushPending = loadWorkerFunction<() => Promise<void>>('flushPending', h.env);

    // User B arrives while WAKE_ACTIVE: queued in pendingMessages, NEVER written to CLI!
    await h.handleMessage({ type: 'message', turnId: 'om_turn_b', content: 'USER B DURING WAKE', trustedCaller: USER_B });
    await realFlushPending();
    expect(writtenTexts).toEqual([]);
    expect(h.hold.isWakeActive()).toBe(true);

    // User A's wake micro-turn finishes -> User A's origin & capA immediately revoked (403)!
    h.scope.run(h.runtimeBinding, () => {
      h.env.observeClaudeBackgroundTasks([
        { type: 'system', subtype: 'turn_duration', uuid: 'dw-end', timestamp: evIso(t0 + 900) },
      ]);
    }, execA);
    await h.drainIpc();
    expect(h.hold.phase()).toBe('IDLE');
    expect((await h.callBotmuxSendAttest(capA)).status).toBe(403);
    expect((await h.callLarkAsUser()).status).toBe(403);

    // Now flush User B -> executes strictly as User B, zero User A inheritance!
    const execB = h.controller.admitInput('om_turn_b');
    h.scope.noteAdmission({ ref: execB, phase: 'queued' });
    await h.scope.run(h.runtimeBinding, async () => {
      await realFlushPending();
    }, execB);
    await h.drainIpc();

    expect(writtenTexts).toEqual(['USER B DURING WAKE']);
    expect(h.authority.snapshot()?.turnId).toBe('om_turn_b');
    expect(h.authority.snapshot()?.caller?.requestUserOpenId).toBe(USER_B.requestUserOpenId);
    expect(h.authority.snapshot()?.identityTurnId).toBeUndefined();
    expect(h.authority.speakers().map(s => s.openId)).toEqual([USER_B.requestUserOpenId]);
    const larkB = await h.callLarkAsUser();
    expect(larkB.status).toBe(200);
    expect(await larkB.json()).toMatchObject({ ok: true, credential: `token-for-${USER_B.requestUserOpenId}` });
  });
});


