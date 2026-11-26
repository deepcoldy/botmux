import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { CodexRpcDeliveryError, CodexRpcEngine } from '../src/codex-rpc-engine.js';
import { TurnTerminalDeduper } from '../src/services/turn-terminal-deduper.js';
import { TurnExecutionClock } from '../src/services/turn-execution-clock.js';
import * as context from '../src/core/traex-native-context.js';
import { pendingInputAllowsTypeAhead, pendingInputMayFlush, shouldStopPendingBatch, terminalReleasesDurableTurn } from '../src/utils/pending-input-queue.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';

const owner = { requestUserOpenId: 'ou_owner', requestLarkAppId: 'cli_app', senderType: 'user' as const };
const prompt = (text: string) => `<role>A</role>\n\n<user_message>${text}</user_message>`;

function harness() {
  const h = workerSubmitHarness();
  const authority = new ActiveTurnAuthority();
  authority.reserve({ turnId: 'om_root', caller: owner, controller: owner });
  authority.markStarted({ turnId: 'om_root', caller: owner, controller: owner });
  Object.assign(h.scope, context, {
    CodexRpcDeliveryError, activeTurnAuthority: authority,
    lastInitConfig: { cliId: 'traex', codexRpcInput: true, cliSessionId: 'thread' },
    currentBotmuxTurnId: 'om_root', currentBotmuxDispatchAttempt: undefined,
    durableTurnInFlight: false, isPromptReady: false,
    pendingInputAllowsTypeAhead, pendingInputMayFlush, shouldStopPendingBatch,
    rpcTurnsAwaitingActivation: new Map(), rpcActiveOwners: new Map([['root', {}]]),
    settlingRpcTerminalOwners: new Map(), rpcTerminalHydrationOwners: new Map(),
    codexRpcEngine: {
      activeThreadId: 'thread', activeNativeTurnId: 'native-root',
      canSteerTurn: vi.fn(() => true),
      sendTurn: vi.fn(async (_text: string, _identity: unknown, opts: any) => {
        opts?.onDispatch?.(); return { nativeTurnId: 'native-next' };
      }),
      steerTurn: vi.fn(async (_text: string, _identity: unknown, native: string, opts: any) => {
        opts?.onDispatch?.(); return { nativeTurnId: native };
      }),
    },
    installAwaitingRpcActivation: vi.fn(), clearAwaitingRpcActivation: vi.fn(),
    runAfterAmbiguousSubmissionWrites: async (_backend: unknown, action: () => unknown) => action(),
    acknowledgeNativeInputConsumed: vi.fn(), activateRpcTurnLifecycle: vi.fn(() => true),
    codexBridgeDrainAndMaybeEmit: vi.fn(), awaitingRpcActivationReplayAnchorMs: () => 1,
    installRpcLifecycleFailClosedOwner: vi.fn(),
    deferTurnInputCommitUntilSubmission: () => false, maybeQueuePostSubmitNativeSessionTitle: () => false,
    stampMojoTurnMark: vi.fn(),
  });
  h.scope.activeTurnBlocks = (item: any) => authority.blocks(h.scope.turnAuthorityIdentity(item));
  h.scope.freshnessInputQueue.takeRaw = () => h.scope.pendingRawInputs.shift();
  h.scope.turnAuthorityIdentity = loadWorkerFunction('turnAuthorityIdentity', h.scope);
  h.scope.rpcTurnOwnerKey = loadWorkerFunction('rpcTurnOwnerKey', h.scope);
  h.scope.directRpcTurnBlocksTypeAhead = loadWorkerFunction('directRpcTurnBlocksTypeAhead', h.scope);
  // Lazily resolve the worker's actual authorization at the write edge.
  h.scope.hybridRpcInputMaySteer = (...args: any[]) =>
    loadWorkerFunction('hybridRpcInputMaySteer', h.scope)(...args);
  h.scope.hybridRpcTurnBlocksAdministrativeInput = (...args: any[]) =>
    loadWorkerFunction('hybridRpcTurnBlocksAdministrativeInput', h.scope)(...args);
  h.scope.publishTraexNativeContextReceipt = loadWorkerFunction('publishTraexNativeContextReceipt', h.scope);
  h.scope.pendingMessages.length = 0;
  h.scope.pendingMessages.push({ turnId: 'om_correction', content: prompt('Use the correction'), trustedCaller: owner });
  return h;
}

describe('hybrid RPC active-turn steering at the actual worker write edge', () => {
  it('sends an owner correction to the existing native turn without a second start', async () => {
    const h = harness();
    await h.flush();
    expect(h.scope.codexRpcEngine.steerTurn).toHaveBeenCalledWith(
      prompt('Use the correction'), { turnId: 'om_correction' }, 'native-root', expect.objectContaining({ onDispatch: expect.any(Function) }),
    );
    expect(h.scope.codexRpcEngine.sendTurn).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toHaveLength(0);
    expect(h.scope.acknowledgeNativeInputConsumed).toHaveBeenCalledWith(
      'om_correction', 'codex_rpc_turn_steer', 'thread', 'native-root', undefined,
    );
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
  });

  it.each([
    ['durable', { dispatchAttempt: 1 }],
    ['scheduled', { queueAfterActiveTurn: true, trustedCaller: { ...owner, source: 'schedule_creator', taskId: 'task' } }],
    ['explicit serial', { queueAfterActiveTurn: true }],
    ['another principal', { trustedCaller: { ...owner, requestUserOpenId: 'ou_other' } }],
    ['bot', { trustedCaller: { ...owner, senderType: 'bot' } }],
    ['unattributed', { trustedCaller: undefined }],
    ['control', { turnId: 'control-turn' }],
    ['at-most-once continuation', { noReplay: true }],
  ])('retains the exact %s head behind the active native turn', async (_label, patch) => {
    const h = harness();
    const head = Object.assign(h.scope.pendingMessages[0], patch);
    await h.flush();
    expect(h.scope.pendingMessages[0]).toBe(head);
    expect(h.scope.codexRpcEngine.steerTurn).not.toHaveBeenCalled();
    expect(h.scope.codexRpcEngine.sendTurn).not.toHaveBeenCalled();
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
  });

  it.each(['rpcTurnsAwaitingActivation', 'settlingRpcTerminalOwners', 'rpcTerminalHydrationOwners', 'rpcLifecycleFailClosedOwners'])
    ('holds a correction during %s', async mapName => {
      const h = harness();
      h.scope[mapName].set('held', {});
      const head = h.scope.pendingMessages[0];
      await h.flush();
      expect(h.scope.pendingMessages[0]).toBe(head);
      expect(h.scope.codexRpcEngine.steerTurn).not.toHaveBeenCalled();
    });

  it('rechecks terminal hydration after an awaited write mutex before starting a task', async () => {
    const h = harness();
    h.scope.runAfterAmbiguousSubmissionWrites = async (_backend: unknown, action: () => unknown) => {
      h.scope.codexRpcEngine.activeNativeTurnId = undefined;
      h.scope.rpcActiveOwners.clear();
      h.scope.rpcTerminalHydrationOwners.set('root', {});
      return action();
    };
    const head = h.scope.pendingMessages[0];
    await h.flush();
    expect(h.scope.codexRpcEngine.sendTurn).not.toHaveBeenCalled();
    expect(h.scope.codexRpcEngine.steerTurn).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages[0]).toBe(head);
  });

  it('does not write raw input or rename through a stale idle while a native task is active', async () => {
    const h = harness();
    h.scope.isPromptReady = true;
    h.scope.pendingRawInputs.push({ content: '/clear' });
    h.scope.pendingSessionRename = 'renamed';
    h.scope.deliverRawInput = vi.fn();
    await h.flush();
    expect(h.scope.pendingRawInputs).toHaveLength(1);
    expect(h.scope.pendingSessionRename).toBe('renamed');
    expect(h.scope.deliverRawInput).not.toHaveBeenCalled();
    expect(h.scope.codexRpcEngine.steerTurn).toHaveBeenCalledTimes(1);
  });

  it('holds a passthrough at the IPC handler while the native RPC task runs', async () => {
    const h = harness();
    Object.assign(h.scope, {
      msg: { type: 'raw_input', content: '/clear', turnId: 'raw-command' },
      unattendedRawInputRefusal: () => undefined, discardDeploymentContinuation: vi.fn(),
      hookReviewAdmissionScreen: () => undefined, refreshHookReviewInputHold: vi.fn(),
      firstWriteLivenessConfirmed: true, openingInputBoxSettled: true,
      startupCommandsInProgress: false, startupCommandAckHold: null,
      nativeSessionForkPending: () => false, deliverRawInput: vi.fn(),
      codexModelMigrationHoldsRawInput: () => false,
    });
    h.scope.freshnessInputQueue.enqueueRaw = (msg: any) => h.scope.pendingRawInputs.push(msg);
    const handle = loadWorkerMessageHandler('raw_input', h.scope);
    await handle(h.scope.msg);
    expect(h.scope.pendingRawInputs).toEqual([h.scope.msg]);
    expect(h.scope.deliverRawInput).not.toHaveBeenCalled();
  });

  it('keeps a definitely rejected correction until completion, then starts it once', async () => {
    const h = harness();
    h.scope.codexRpcEngine.steerTurn.mockImplementationOnce(async () => {
      throw new CodexRpcDeliveryError('no active turn', 'rpc_turn_steer_not_sent' as any, 'not_sent');
    });
    const head = h.scope.pendingMessages[0];
    await h.flush();
    expect(h.scope.codexRpcEngine.steerTurn).toHaveBeenCalledTimes(1);
    expect(h.scope.pendingMessages[0]).toBe(head);
    await h.flush();
    expect(h.scope.codexRpcEngine.steerTurn).toHaveBeenCalledTimes(1);
    h.scope.codexRpcEngine.activeNativeTurnId = undefined;
    h.scope.rpcActiveOwners.clear();
    h.scope.activeTurnAuthority.clear();
    h.scope.isPromptReady = true;
    await h.flush();
    expect(h.scope.codexRpcEngine.sendTurn).toHaveBeenCalledTimes(1);
    expect(h.scope.pendingMessages).toHaveLength(0);
  });

  it('quarantines an unknown steer without requeueing or starting a successor', async () => {
    const h = harness();
    h.scope.codexRpcEngine.steerTurn.mockImplementationOnce(async (_text: string, _id: unknown, _native: string, opts: any) => {
      opts?.onDispatch?.();
      throw new CodexRpcDeliveryError('response lost', 'rpc_turn_steer_ambiguous' as any, 'ambiguous');
    });
    h.scope.installRpcLifecycleFailClosedOwner.mockImplementation(() => { h.scope.rpcLifecycleFailClosedOwners.set('unknown', {}); });
    await h.flush();
    expect(h.scope.codexRpcEngine.steerTurn).toHaveBeenCalledTimes(1);
    expect(h.scope.installRpcLifecycleFailClosedOwner).toHaveBeenCalledTimes(1);
    expect(h.scope.pendingMessages).toHaveLength(0);
    h.scope.pendingMessages.push({ turnId: 'om_next', content: prompt('Next'), trustedCaller: owner });
    await h.flush();
    expect(h.scope.codexRpcEngine.steerTurn).toHaveBeenCalledTimes(1);
    expect(h.scope.codexRpcEngine.sendTurn).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toHaveLength(1);
  });

  it('keeps ordinary TUI type-ahead on the existing adapter path', async () => {
    const h = harness();
    h.scope.codexRpcEngine = undefined;
    h.scope.cliAdapter.writeInput.mockResolvedValueOnce({ submitted: true });
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(h.scope.pendingMessages).toHaveLength(0);
  });
});

describe('hybrid RPC steering identity with cross-principal isolation disabled', () => {
  it.each([
    ['bot', { ...owner, senderType: 'bot' }],
    ['unknown sender type', { requestUserOpenId: 'ou_unknown', requestLarkAppId: 'cli_app' }],
    ['unattributed', undefined],
  ])('retains %s input at the default-off write edge', async (_label, caller) => {
    const h = harness();
    h.scope.isCrossPrincipalInterruptionEnabled = () => false;
    h.scope.crossPrincipalIsolationOn = loadWorkerFunction('crossPrincipalIsolationOn', h.scope);
    h.scope.activeTurnBlocks = loadWorkerFunction('activeTurnBlocks', h.scope);
    const head = h.scope.pendingMessages[0];
    head.trustedCaller = caller;
    await h.flush();
    expect(h.scope.pendingMessages[0]).toBe(head);
    expect(h.scope.codexRpcEngine.steerTurn).not.toHaveBeenCalled();
    expect(h.scope.codexRpcEngine.sendTurn).not.toHaveBeenCalled();
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
  });
});

/** Real engine request/ACK ownership, real bridge queue and real worker RPC
 * lifecycle. Only transport I/O and output presentation are controlled. */
function lifecycleHarness() {
  const h = harness();
  const s = h.scope;
  const events: any[] = [];
  const requests: any[] = [];
  let nativeSequence = 0;
  let native = '';
  let holdSteerAck: (() => void) | undefined;
  const engine = new CodexRpcEngine({
    cliBin: '/unused', cwd: '/tmp', env: {}, sessionId: 'sid',
    onTurnTerminal: terminal => s.handleRpcTurnTerminal(terminal, { engine, cliGeneration: s.cliSpawnGeneration }),
    onDead: () => {
      if (s.teardownOnDead) { s.cliSpawnGeneration += 1; s.stopCodexRpcEngine(); }
    },
  });
  Object.assign(engine as any, { threadId: 'thread', ws: { readyState: 1, send: (frame: string) => {
    const request = JSON.parse(frame);
    requests.push(request);
    if (request.method === 'turn/start') native = `native-${++nativeSequence}`;
    if (request.method === 'turn/start' || request.method === 'turn/steer') {
      const text = request.params.input[0].text;
      events.push({ kind: 'user', text, uuid: `user-${requests.length}`, timestampMs: Date.now(),
        sourceSessionId: 'thread', sourceTurnId: native, sourceMessageId: `message-${requests.length}` });
      const respond = () => (engine as any).onMessage(JSON.stringify({ id: request.id,
        result: request.method === 'turn/start' ? { turn: { id: native } } : { turnId: native } }));
      if (request.method === 'turn/steer' && holdSteerAck) holdSteerAck = respond;
      else queueMicrotask(respond);
    }
  } } });
  Object.assign(s, {
    codexRpcEngine: engine, sessionId: 'sid', currentBotmuxTurnId: undefined,
    currentBotmuxDispatchAttempt: undefined, isPromptReady: true,
    emittedTurnTerminals: new TurnTerminalDeduper(), turnExecutionClock: new TurnExecutionClock(),
    terminalReleasesDurableTurn, cancelSubmitFailureChainForTerminal: vi.fn(),
    releaseTerminatedActiveTurnAuthority: vi.fn(), retireTerminatedQueuedTurn: vi.fn(),
    scheduleConsumedQueuedTurnAdvance: vi.fn(), captureTurnFailureDiagnostics: false,
    releaseActiveTurnAuthority: (_reason: string, identity: any) => s.activeTurnAuthority.releaseExact(identity),
    setCaptureIdentity: (id: string, attempt?: number) => { s.currentBotmuxTurnId = id; s.currentBotmuxDispatchAttempt = attempt; },
    markTurnRetired: vi.fn(),
    markActiveTurnStarted: (item: any) => {
      const identity = s.turnAuthorityIdentity(item);
      if (!s.activeTurnAuthority.reserve(identity) || !s.activeTurnAuthority.markStarted(identity)) throw new Error('authority refused');
    },
    rpcTurnsAwaitingActivationIdentities: new Map(), rpcTurnsAwaitingActivationReplayAnchors: new Map(),
    pendingRpcTurnTerminals: new Map(), rpcLifecycleFailClosedIdentities: new Map(),
    rpcTerminalHydrationTimers: new Map(), rpcTerminalHydrationTerminals: new Map(),
    CODEX_RPC_TERMINAL_HYDRATION_DELAYS_MS: [10, 20],
    universalOutputHandoff: false, checkpointCodexAdoptRecovery: vi.fn(), checkpointStructuredBridgeRecovery: vi.fn(),
    armPostTerminalInputFence: vi.fn(), recoverTraexQuotaTurn: () => false,
    isExistingAppServerSharedBridge: () => false, zeroPromptTerminalSync: () => false,
    structuredBridgeIs: (cli: string) => cli === 'traex',
    bridgeGateInputForTurn: (_id: string, turn: any) => turn, structuredFallbackKind: () => 'final',
    bridgeTurnOutcome: () => 'answered', replyDeliveryMode: () => 'fallback',
    attributableExplicitReplyMarkersForTurnWindow: () => [], notifyExplicitRepliesObserved: vi.fn(),
    shouldSuppressStructuredFallback: () => false, deliveredFinalFailureNoticeSuppressed: () => false,
    bridgePostText: (content: string) => content, releaseInputDeliveryQuarantineForStructuredTerminal: vi.fn(),
    retireStructuredTurnAttribution: vi.fn(),
    rpcEngagementFence: { invalidate: vi.fn() }, clearRpcEnginePidMarker: vi.fn(),
    stopStructuredStartGraceRecheck: vi.fn(),
  });
  s.usageLimitTracker.noteTurnCompleted = vi.fn();
  s.activeTurnAuthority.clear(); s.rpcActiveOwners.clear(); s.pendingMessages.length = 0;
  for (const name of ['rpcTurnOwnerKey', 'sameRpcGeneration', 'installAwaitingRpcActivation',
    'awaitingRpcActivationReplayAnchorMs', 'clearAwaitingRpcActivation', 'clearRpcLifecycleFailClosedOwner',
    'installRpcLifecycleFailClosedOwner', 'activateRpcTurnLifecycle', 'handleRpcTurnTerminal',
    'settleRpcTurnTerminal', 'hydrateCompletedRpcTurn', 'finalizeRpcTurnTerminal',
    'retireRpcLifecycleFromStructuredTerminal', 'observeCodexCotSuperseded', 'emitReadyCodexTurns', 'emitTurnTerminal',
    'stopCodexRpcEngine', 'notifyRpcTeardownBeforeActivation']) {
    s[name] = loadWorkerFunction(name, s);
  }
  s.ambiguousRpcActivationTokens = new Map();
  s.pendingAmbiguousFreshRpcActivation = undefined;
  h.queue.setCotSupersededObserver(s.observeCodexCotSuperseded);
  s.codexBridgeDrainAndMaybeEmit = () => { h.queue.ingest(events.splice(0)); s.emitReadyCodexTurns(); };
  s.idleDetector.fireIdle = vi.fn(() => { s.isPromptReady = true; });
  const write = async (turnId: string, text: string) => {
    s.pendingMessages.push({ turnId, content: prompt(text), trustedCaller: owner });
    await h.flush();
  };
  const complete = (withTranscript = true) => {
    if (withTranscript) events.push({ kind: 'assistant_final', text: 'Combined answer', uuid: `final-${native}`,
      timestampMs: Date.now(), sourceSessionId: 'thread', sourceTurnId: native });
    (engine as any).onMessage(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: native, status: 'completed' } } }));
  };
  return { ...h, engine, events, requests, write, complete, holdSteer: () => { holdSteerAck = () => {}; },
    acceptSteer: () => { const respond = holdSteerAck; holdSteerAck = undefined; respond?.(); } };
}

afterEach(() => vi.useRealTimers());

describe('hybrid RPC engine and merged bridge lifecycle', () => {
  it('retires the superseded root once and emits one latest final and terminal, then starts a new task', async () => {
    vi.useFakeTimers();
    const h = lifecycleHarness();
    await h.write('om_root', 'Task');
    await h.write('om_correction', 'Use the correction');
    expect(h.requests.map(r => r.method), JSON.stringify(h.scope.log.mock.calls)).toEqual(['turn/start', 'turn/steer']);
    expect((h.engine as any).deadNotified, JSON.stringify(h.scope.log.mock.calls)).toBe(false);
    expect(h.queue.peek().map(turn => ({id: turn.turnId, started: turn.started, text: turn.messageText})), JSON.stringify(h.scope.log.mock.calls)).toHaveLength(1);
    expect(h.scope.send.mock.calls.map(([m]: any[]) => m).filter(m => m.type === 'thinking_superseded'))
      .toEqual([expect.objectContaining({ turnId: 'om_root' })]);
    h.complete();
    const messages = h.scope.send.mock.calls.map(([m]: any[]) => m);
    expect(messages.filter(m => m.type === 'final_output')).toEqual([expect.objectContaining({ turnId: 'om_correction', content: 'Combined answer' })]);
    expect(messages.filter(m => m.type === 'turn_terminal')).toEqual([expect.objectContaining({ turnId: 'om_correction', status: 'completed' })]);
    expect(h.scope.rpcActiveOwners.size).toBe(0);
    expect(h.scope.rpcTerminalHydrationOwners.size).toBe(0);
    expect(h.scope.directRpcTurnBlocksTypeAhead()).toBe(false);
    await h.write('om_next', 'Next task');
    expect(h.requests.map(r => r.method)).toEqual(['turn/start', 'turn/steer', 'turn/start']);
    h.engine.stop();
  });

  it('keeps successors outside a completion that precedes the steer ACK and transcript hydration', async () => {
    vi.useFakeTimers();
    const h = lifecycleHarness();
    await h.write('om_root', 'Task');
    h.holdSteer();
    const steering = h.write('om_correction', 'Use the correction');
    await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    h.complete(false);
    expect(h.scope.send.mock.calls.map(([m]: any[]) => m).filter(m => m.type === 'turn_terminal')).toEqual([]);
    h.acceptSteer(); await steering;
    expect(h.scope.rpcTerminalHydrationOwners.size).toBeGreaterThan(0);
    h.scope.isPromptReady = true;
    await h.write('om_next', 'Next task');
    expect(h.requests).toHaveLength(2);
    h.events.push({ kind: 'assistant_final', text: 'Combined answer', uuid: 'late-final',
      timestampMs: Date.now(), sourceSessionId: 'thread', sourceTurnId: 'native-1' });
    await vi.advanceTimersByTimeAsync(11);
    expect(h.scope.rpcTerminalHydrationOwners.size).toBe(0);
    await h.flush();
    expect(h.requests.map(r => r.method)).toEqual(['turn/start', 'turn/steer', 'turn/start']);
    expect(h.scope.send.mock.calls.map(([m]: any[]) => m).filter(m => m.type === 'final_output')).toHaveLength(1);
    h.engine.stop();
  });

  it.each(['terminal-before-ack', 'ack-then-terminal-same-batch'])(
    'keeps an already-readable combined final on the accepted correction: %s',
    async ordering => {
      vi.useFakeTimers();
      const h = lifecycleHarness();
      await h.write('om_root', 'Task');
      h.holdSteer();
      const steering = h.write('om_correction', 'Use the correction');
      await vi.waitFor(() => expect(h.requests).toHaveLength(2));
      if (ordering === 'terminal-before-ack') {
        h.complete();
        h.acceptSteer();
      } else {
        h.acceptSteer();
        h.complete();
      }
      await steering;
      await vi.advanceTimersByTimeAsync(40);
      const messages = h.scope.send.mock.calls.map(([m]: any[]) => m);
      expect(messages.filter(m => m.type === 'final_output')).toEqual([
        expect.objectContaining({ turnId: 'om_correction', content: 'Combined answer' }),
      ]);
      expect(messages.filter(m => m.type === 'turn_terminal')).toEqual([
        expect.objectContaining({ turnId: 'om_correction', status: 'completed' }),
      ]);
      expect(h.queue.peek()).toEqual([]);
      expect(h.scope.rpcTerminalHydrationOwners.size).toBe(0);
      h.engine.stop();
    },
  );

  it('attributes an early terminal and final to the newest of multiple accepted steers', async () => {
    vi.useFakeTimers();
    const h = lifecycleHarness();
    await h.write('om_root', 'Task');
    await h.write('om_second', 'Second');
    h.holdSteer();
    const steering = h.write('om_third', 'Third');
    await vi.waitFor(() => expect(h.requests).toHaveLength(3));
    h.complete();
    h.acceptSteer();
    await steering;
    await vi.advanceTimersByTimeAsync(40);
    const messages = h.scope.send.mock.calls.map(([m]: any[]) => m);
    expect(messages.filter(m => m.type === 'final_output')).toEqual([
      expect.objectContaining({ turnId: 'om_third', content: 'Combined answer' }),
    ]);
    expect(messages.filter(m => m.type === 'turn_terminal')).toEqual([
      expect.objectContaining({ turnId: 'om_third', status: 'completed' }),
    ]);
    expect(h.requests.map(r => r.method)).toEqual(['turn/start', 'turn/steer', 'turn/steer']);
    expect(h.queue.peek()).toEqual([]);
    h.engine.stop();
  });

  it('does not defer predecessor hydration for an independent successor activation', async () => {
    vi.useFakeTimers();
    const h = lifecycleHarness();
    await h.write('om_root', 'Task');
    const generation = { engine: h.engine, cliGeneration: h.scope.cliSpawnGeneration };
    h.scope.rpcTurnsAwaitingActivation.set('om_independent\0', generation);
    h.scope.rpcTurnsAwaitingActivationIdentities.set('om_independent\0', { turnId: 'om_independent' });
    h.complete();
    const messages = h.scope.send.mock.calls.map(([m]: any[]) => m);
    expect(messages.filter(m => m.type === 'final_output')).toEqual([
      expect.objectContaining({ turnId: 'om_root', content: 'Combined answer' }),
    ]);
    expect(messages.filter(m => m.type === 'turn_terminal')).toEqual([
      expect.objectContaining({ turnId: 'om_root', status: 'completed' }),
    ]);
    h.engine.stop();
  });

  it('delivers an already-readable predecessor final during teardown with an unacknowledged steer', async () => {
    vi.useFakeTimers();
    const h = lifecycleHarness();
    await h.write('om_root', 'Task');
    h.holdSteer();
    const steering = h.write('om_correction', 'Use the correction');
    await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    h.complete();
    h.scope.stopCodexRpcEngine();
    await steering;
    const messages = h.scope.send.mock.calls.map(([m]: any[]) => m);
    expect(messages.filter(m => m.type === 'final_output')).toEqual([
      expect.objectContaining({ turnId: 'om_root', content: 'Combined answer' }),
    ]);
    expect(messages.filter(m => m.type === 'turn_terminal' && m.turnId === 'om_root')).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ]);
    expect(messages.filter(m => m.type === 'turn_terminal' && m.turnId === 'om_correction')).toEqual([
      expect.objectContaining({ status: 'ambiguous' }),
    ]);
    expect(h.requests.map(r => r.method)).toEqual(['turn/start', 'turn/steer']);
    expect(h.queue.peek()).toEqual([]);
  });

  it('settles an unknown steer once when engine death tears down the worker before the request catch resumes', async () => {
    vi.useFakeTimers();
    const h = lifecycleHarness();
    h.scope.teardownOnDead = true;
    await h.write('om_root', 'Task');
    h.holdSteer();
    const steering = h.write('om_correction', 'Use the correction');
    await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    (h.engine as any).failAll(new Error('transport closed'));
    await steering;
    expect(h.scope.codexRpcEngine).toBeUndefined();
    expect(h.scope.pendingMessages).toHaveLength(0);
    expect(h.scope.rpcTurnsAwaitingActivation.size).toBe(0);
    expect(h.scope.rpcActiveOwners.size).toBe(0);
    expect(h.scope.rpcLifecycleFailClosedOwners.size).toBe(0);
    const terminals = h.scope.send.mock.calls.map(([m]: any[]) => m).filter(m => m.type === 'turn_terminal');
    expect(terminals.filter(m => m.turnId === 'om_correction')).toEqual([expect.objectContaining({ status: 'ambiguous' })]);
    expect(terminals.filter(m => m.turnId === 'om_root')).toHaveLength(1);
    expect(h.requests.map(r => r.method)).toEqual(['turn/start', 'turn/steer']);
  });
});
