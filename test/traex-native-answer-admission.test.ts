import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraexQuestionBridge } from '../src/core/traex-question-bridge.js';
import { NATIVE_STANDALONE_ASK_ORIGIN } from '../src/core/ask-types.js';
import { CODEX_ASYNC_ASK_ORIGIN, CODEX_ASYNC_RESTORE_ASK_ORIGIN } from '../src/services/codex-async-user-input.js';
import { InputTurnDeduper } from '../src/core/input-turn-dedupe.js';
import { isOrdinaryImTurnId } from '../src/core/ordinary-im-turn.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { InflightInputTracker } from '../src/core/inflight-input-tracker.js';
import { productionConst, productionFunction } from './helpers/codex-async-answer-function-harness.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';

function harness() {
  const admissions = new Map<string, (input?: any) => void>();
  const inputs = new WeakMap<object, any>();
  const handoffs: Array<{ result: object; input: any }> = [];
  const inputSet = inputs.set.bind(inputs);
  inputs.set = (result: object, input: any) => { handoffs.push({ result, input }); return inputSet(result, input); };
  const events: Array<Record<string, any>> = [];
  const requests: Array<{ body: any; resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
  const postCodexAsk = productionFunction('src/services/codex-user-input.ts', 'postCodexAsk', {
    randomUUID,
    NATIVE_STANDALONE_ASK_ORIGIN,
    CODEX_ASYNC_ASK_ORIGIN,
    CODEX_ASYNC_RESTORE_ASK_ORIGIN,
    process: { env: {} },
    resolveBotmuxDataDir: () => '/tmp/traex-native-answer-admission-unused',
    readManagedOriginCapability: () => undefined,
    resolveDaemonIpcPort: () => 1,
    findOnlineDaemon: () => undefined,
    loopbackFetch: () => { throw new Error('unexpected loopback fetch'); },
    fetchDaemonIpc: (_port: number, _path: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      requests.push({ body: JSON.parse(String(init.body)), resolve, reject });
    }),
  });
  const lastInitConfig = {
    sessionId: 'sess-native-admission', larkAppId: 'app-native-admission', chatId: 'chat-native-admission',
    rootMessageId: null, adoptMode: false,
  };
  const queue = new CodexBridgeQueue();
  const inflight = new InflightInputTracker();
  const releaseActiveTurnAuthority = vi.fn();
  const terminal = (turnId: string, status: string, reason: string) => events.push({ type: 'terminal', turnId, status, reason });
  const runAnswer = loadWorkerFunction('runTraexNativeAnswer', {
    traexNativeAnswerInputs: inputs,
    traexNativeAnswerSubmission: undefined,
    workerSessionEventScope: undefined,
    codexBridgeQueue: queue,
    inflightInputs: inflight,
    releaseActiveTurnAuthority,
    emitTurnTerminal: terminal,
  });
  const bridge = productionConst('src/worker.ts', 'traexQuestionBridge', {
    TraexQuestionBridge,
    lastInitConfig,
    randomUUID,
    postCodexAsk,
    traexNativeAnswerAdmissions: admissions,
    traexNativeAnswerInputs: inputs,
    currentBotmuxTurnId: undefined,
    currentBotmuxDispatchAttempt: undefined,
    runTraexNativeAnswer: runAnswer,
    traexQuestionWrite: async () => false,
    traexQuestionCapture: async () => undefined,
    traexQuestionOpenPending: async () => false,
    traexQuestionMayOpenPending: () => false,
    traexQuestionBridgeActive: () => false,
    cliRestartInProgress: false,
    cliLifetimeNonce: 1,
    send: (event: Record<string, unknown>) => events.push(event),
    t: (key: string) => key,
    cliName: () => 'TraeX',
    log: () => {},
  });
  const handlerScope: Record<string, any> = {
    lastInitConfig,
    restoredDeploymentTurnId: undefined,
    backend: {}, crashDiagnosticStopped: false,
    applyWorkerLaunchModel: () => {}, applyRespawnConfigPatch: () => {}, respawnConfigPatchFromMessage: () => ({}),
    isOrdinaryImTurnId, finalHandoffAdmissionEnabled: false, activeTurnBlocks: () => false,
    activeTurnAuthority: { snapshot: () => undefined },
    ordinaryImTurnDedupe: new InputTurnDeduper(256), universalOutputHandoff: undefined,
    send: (event: Record<string, unknown>) => events.push(event),
    traexNativeAnswerAdmissions: admissions,
    log: () => {}, emitTurnTerminal: terminal,
  };
  handlerScope.acknowledgeTurnInputReceived = loadWorkerFunction('acknowledgeTurnInputReceived', handlerScope);
  handlerScope.acknowledgeTurnInputCommitted = loadWorkerFunction('acknowledgeTurnInputCommitted', handlerScope);
  handlerScope.receiveOrdinaryImTurn = loadWorkerFunction('receiveOrdinaryImTurn', handlerScope);
  const handleMessage = loadWorkerMessageHandler('message', handlerScope);
  const question = { prompt: 'Pick one', multiSelect: false, options: [{ key: '1', label: 'Alpha' }, { key: '2', label: 'Beta' }] };

  async function start() {
    const controller = new AbortController();
    const pending = bridge.deps.ask(question, controller.signal, { delivery: 'async' });
    while (requests.length === 0) await Promise.resolve();
    const request = requests.shift()!;
    const input = {
      type: 'message', turnId: `native-question-answer-${request.body.requestId}`, content: 'Alpha',
      nativeQuestionAnswer: { requestId: request.body.requestId }, atMostOnce: true,
    };
    await handleMessage(input);
    return { controller, pending, request, input };
  }
  return { admissions, inputs, handoffs, events, requests, queue, inflight, releaseActiveTurnAuthority, bridge, handleMessage, start };
}

const answered = () => ({ kind: 'answered', answers: [['1']], by: 'ou_probe', comment: null, timedOut: false });
const response = (result: ReturnType<typeof answered>) => new Response(JSON.stringify(result), {
  status: 200, headers: { 'content-type': 'application/json' },
});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('native answer admission handoff', () => {
  it('hands an admitted answer to the bridge when the response completes normally', async () => {
    const h = harness();
    const { pending, request, input } = await h.start();
    const result = answered();
    request.resolve(response(result));
    const returned = await pending;
    expect(returned).toEqual(result);
    expect(h.inputs.get(returned)).toEqual(input);
    expect(h.handoffs).toHaveLength(1);
    expect(h.events.filter(event => event.type === 'terminal')).toEqual([]);
    h.bridge.dispose();
  });

  it.each(['abort', 'transport failure'])('settles an admitted answer once when %s prevents the HTTP handoff', async failure => {
    const h = harness();
    const { controller, pending, request, input } = await h.start();
    const rejection = expect(pending).rejects.toThrow(failure === 'abort' ? 'question left the screen' : 'connection reset');
    if (failure === 'abort') {
      controller.abort(new Error('question left the screen'));
      request.resolve(response(answered()));
    } else {
      request.reject(new Error('connection reset'));
    }
    await rejection;
    expect(h.handoffs).toHaveLength(0);
    expect(h.admissions.size).toBe(0);
    expect(h.events.filter(event => event.type === 'turn_input_committed')).toHaveLength(1);
    expect(h.events.filter(event => event.type === 'terminal')).toEqual([{
      type: 'terminal', turnId: input.turnId, status: 'failed', reason: 'native_question_not_submitted',
    }]);
    expect(h.releaseActiveTurnAuthority).toHaveBeenCalledTimes(1);
    expect(h.queue.peek()).toEqual([]);
    h.inflight.onCliExit();
    expect(h.inflight.takeCarryOver()).toEqual([]);

    controller.abort(new Error('repeated abort'));
    await h.handleMessage(input);
    expect(h.events.filter(event => event.type === 'turn_input_committed')).toHaveLength(2);
    expect(h.events.filter(event => event.type === 'terminal')).toHaveLength(1);
    expect(h.releaseActiveTurnAuthority).toHaveBeenCalledTimes(1);
    h.bridge.dispose();
  });

  it('settles a handed-off answer when reset lands before onResult', async () => {
    const h = harness();
    const page = {
      delivery: 'async', index: 1, total: 1, prompt: 'Pick one', multiSelect: false,
      options: [{ number: 1, label: 'Alpha', other: false }, { number: 2, label: 'Beta', other: false }],
    };
    h.bridge.open(page, 'signature', 1);
    while (h.requests.length === 0) await Promise.resolve();
    const request = h.requests.shift()!;
    request.resolve(response(answered()));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.handoffs).toHaveLength(0);
    const requestId = request.body.requestId;
    const input = {
      type: 'message', turnId: `native-question-answer-${requestId}`, content: 'Alpha',
      nativeQuestionAnswer: { requestId }, atMostOnce: true,
    };
    const handling = h.handleMessage(input);
    h.bridge.reset('question left the screen');
    await handling;
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.handoffs).toHaveLength(1);
    expect(h.bridge.hasOpenCard()).toBe(false);
    expect(h.events.filter(event => event.type === 'terminal')).toEqual([{
      type: 'terminal', turnId: input.turnId, status: 'failed', reason: 'native_question_not_submitted',
    }]);
    expect(h.releaseActiveTurnAuthority).toHaveBeenCalledTimes(1);
    expect(h.queue.peek()).toEqual([]);
    h.inflight.onCliExit();
    expect(h.inflight.takeCarryOver()).toEqual([]);

    h.bridge.reset('repeated reset');
    await h.handleMessage(input);
    expect(h.events.filter(event => event.type === 'terminal')).toHaveLength(1);
    expect(h.releaseActiveTurnAuthority).toHaveBeenCalledTimes(1);
    h.bridge.dispose();
  });
});
