import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexAsyncAnswerSteerTarget, codexAsyncSteerTargetMatches } from '../src/services/codex-async-user-input.js';
import { buildCodexAppTurnStartParams, supportsClientUserMessageId } from '../src/adapters/cli/codex-app-turn.js';
import { productionFunction, productionClass, delivery, deliveryIsCurrent } from './helpers/codex-async-answer-function-harness.js';
import { beginReplyTargetTurn, pickTurnReplyTarget } from '../src/core/reply-target.js';
import { dispatchCallerFromReply } from '../src/core/dispatch-user-delegation.js';
import { publishTurnCliIdentity } from '../src/core/turn-cli-identity.js';
import { recallProvenIdentityContent, forgetProvenIdentityContent } from '../src/core/cli-identity.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ServerResponse, IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { managedOriginCapabilityPath, replaceManagedOriginCapabilityFile } from '../src/core/managed-origin-capability.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/services/bytedcli-auth.js', () => ({
  mintBytedcliJwts: vi.fn(async (openId: string) => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return { cloudJwt: `fake-cloud-${openId}`, codeJwt: `fake-code-${openId}` };
  }),
  beginBytedcliLogin: vi.fn(async () => undefined),
}));

function runnerScope(): Record<string, any> {
  const scope: Record<string, any> = {
    generationFenced: false, cleanInputUnsupported: false,
    detectedCodexVersion: () => ({ major: 0, minor: 162, patch: 1 }),
    supportsClientUserMessageId,
    codexAsyncSteerTargetMatches, steerAdmitting: false,
  };
  scope.codexAsyncSteerTargetMatches = productionFunction('src/services/codex-async-user-input.ts', 'codexAsyncSteerTargetMatches', scope);
  scope.canSteerInputToNativeTurn = productionFunction('src/codex-app-runner.ts', 'canSteerInputToNativeTurn', scope);
  scope.canSteer = productionFunction('src/codex-app-runner.ts', 'canSteer', scope);
  return scope;
}
function answer() {
  return { content: 'answer', replyTurnId: 'codex-async-answer-probe', codexAppSteerable: true,
    codexAppInput: { text: 'answer', steerTargetTurnId: 'native-original' } };
}
function root() {
  return { completed: false, phase: 'open', canonicalNativeTurnId: 'native-original',
    accepted: [{ input: { codexAppSteerable: true }, clientUserMessageId: 'om_original' }] };
}
function daemonScope(): Record<string, any> {
  const scope: Record<string, any> = {
    result: {}, actor: { senderType: 'user' },
    askAnswerActorFor: () => scope.actor,
    isKnownPeerBot: () => false, config: { session: { dataDir: '/unused' } },
    askSession: { larkAppId: 'app', chatId: 'oc_chat', session: { backendType: 'pty' } },
    resolveSender: async () => ({ name: 'User' }),
    isCurrent: () => scope.current, current: true, asyncCaller: 'ou_owner',
    randomUUID: () => 'probe', getBot: () => ({ config: {}, botName: 'Bot', botOpenId: 'ou_bot' }),
    asyncOriginMessageId: 'om_original', asyncOriginTurn: 'om_original',
    boundAsk: { sessionId: 'session', larkAppId: 'app', chatId: 'oc_chat', rootMessageId: 'om_root' },
    beginReplyTargetTurn: vi.fn(), sessionPromptInjection: () => undefined,
    buildFollowUpCliInput: (_text: string, _session: string, opts: any) => ({ content: _text, codexAppInput: { text: opts.codexAppText } }),
    documentDelivery: undefined, asyncDocumentTarget: undefined,
    noteTurnReceived: vi.fn(async () => undefined),
    trustedCallerForInboundTurn: vi.fn(async () => ({ senderType: 'user', requestLarkAppId: 'app', requestUserOpenId: 'ou_owner' })),
    asyncInput: { threadId: 'thread', itemId: 'call', nativeTurnId: 'native-original' },
    codexAsyncAnswerSteerTarget, larkTransportEnabled: () => true,
    codexAppCleanInputAcceptedForSession: () => scope.clean, clean: true,
    sendWorkerInput: vi.fn(() => true), beginNewTurn: vi.fn(), rememberLastCliInput: vi.fn(),
    markSessionActivity: vi.fn(), sessionStore: { updateSession: vi.fn() }, logger: { info: vi.fn() },
  };
  scope.codexAsyncAnswerSteerTarget = productionFunction('src/services/codex-async-user-input.ts', 'codexAsyncAnswerSteerTarget', scope);
  return scope;
}

function steerScope(): Record<string, any> {
  const scope = runnerScope();
  const path = 'src/codex-app-runner.ts';
  Object.assign(scope, {
    AppServerRpcError: productionClass(path, 'AppServerRpcError', scope),
    activeTurn: root(), queue: [answer()], threadId: 'thread', args: { cwd: process.cwd() },
    buildCodexAppTurnStartParams, emitLifecycle: vi.fn(),
    fenceUnknown: vi.fn(() => { scope.generationFenced = true; }),
    resumeBufferedGroupCompletion: () => false,
  });
  scope.activeTurn.resolveDone = vi.fn();
  for (const name of ['isExplicitExpectedTurnInactive', 'isDefiniteRpcRejection', 'tryAdmitSteer']) {
    scope[name] = productionFunction(path, name, scope);
  }
  return scope;
}

afterEach(() => vi.useRealTimers());

describe('correlated async answer adversarial production probes', () => {
  it.each(['different-target', 'missing-sidecar', 'stripped-target', 'clean-disabled', 'old-version', 'missing-root-id'])(
    'keeps %s out of the current native group', mode => {
      const scope = runnerScope(); const input = answer(); const turn = root();
      if (mode === 'different-target') turn.canonicalNativeTurnId = 'native-new-goal';
      if (mode === 'missing-sidecar') delete (input as any).codexAppInput;
      if (mode === 'stripped-target') delete (input.codexAppInput as any).steerTargetTurnId;
      if (mode === 'clean-disabled') scope.cleanInputUnsupported = true;
      if (mode === 'old-version') scope.detectedCodexVersion = () => ({ major: 0, minor: 135, patch: 0 });
      if (mode === 'missing-root-id') delete (turn.accepted[0] as any).clientUserMessageId;
      expect(scope.canSteer(turn, input)).toBe(false);
    });
  it('permits exactly the matching attributed live group', () => {
    expect(runnerScope().canSteer(root(), answer())).toBe(true);
  });
  it('rechecks a newer native Goal after ensureThread awaits without dispatching or losing the answer', async () => {
    vi.useFakeTimers(); const scope = runnerScope(); const input = answer();
    Object.assign(scope, {
      nativeActiveTurnId: undefined, queue: [],
      ensureThread: () => new Promise(resolve => setTimeout(() => { scope.nativeActiveTurnId = 'native-new-goal'; resolve('thread'); }, 20)),
      makeTurn: vi.fn(() => { throw new Error('must not dispatch'); }),
    });
    const run = productionFunction('src/codex-app-runner.ts', 'runTurn', scope);
    const pending = run(input); await vi.advanceTimersByTimeAsync(20); await pending;
    expect(scope.queue).toEqual([input]); expect(scope.makeTurn).not.toHaveBeenCalled();
  });
  it.each(['replacement-at-sender', 'close-at-ledger', 'replacement-at-caller', 'wrong-answerer'])(
    'does not send after %s', async mode => {
      const scope = daemonScope();
      if (mode === 'replacement-at-sender') scope.resolveSender = async () => { scope.current = false; return {}; };
      if (mode === 'close-at-ledger') scope.noteTurnReceived = async () => { scope.current = false; };
      if (mode === 'replacement-at-caller') scope.trustedCallerForInboundTurn = async () => { scope.current = false; return {}; };
      expect(await delivery(scope)('answer', mode === 'wrong-answerer' ? 'ou_other' : 'ou_owner')).toBe(false);
      expect(scope.sendWorkerInput).not.toHaveBeenCalled();
    });
  it.each(['document', 'adopted', 'vc', 'api-only', 'no-proof', 'wrong-app', 'wrong-principal', 'bot', 'clean-flip', 'legacy-card'])(
    'keeps %s delivery serial at the real daemon grant boundary', async mode => {
      const scope = daemonScope();
      if (mode === 'document') scope.documentDelivery = { openId: 'ou_owner' };
      if (mode === 'adopted') scope.askSession.session.adoptedFrom = 'native';
      if (mode === 'vc') scope.askSession.session.vcMeetingReceiver = 'receiver';
      if (mode === 'api-only') scope.larkTransportEnabled = () => false;
      if (mode === 'no-proof') scope.trustedCallerForInboundTurn = async () => undefined;
      if (mode === 'wrong-app') scope.trustedCallerForInboundTurn = async () => ({ senderType: 'user', requestLarkAppId: 'other', requestUserOpenId: 'ou_owner' });
      if (mode === 'wrong-principal') scope.trustedCallerForInboundTurn = async () => ({ senderType: 'user', requestLarkAppId: 'app', requestUserOpenId: 'ou_other' });
      if (mode === 'bot') scope.actor = { senderType: 'bot', botSender: true };
      if (mode === 'clean-flip') scope.noteTurnReceived = async () => { scope.clean = false; };
      if (mode === 'legacy-card') delete scope.asyncInput.nativeTurnId;
      expect(await delivery(scope)('answer', 'ou_owner')).toBe(true);
      const [, payload, id, opts] = scope.sendWorkerInput.mock.calls[0];
      expect(id).toBe('codex-async-answer-probe');
      expect(opts.atMostOnce).toBe(true); expect(opts.codexAppSteerable).toBeUndefined();
      expect(payload.codexAppInput.steerTargetTurnId).toBeUndefined();
    });
  it('sends once while an accepted native steer is pending, then removes exactly its queued answer', async () => {
    vi.useFakeTimers(); const scope = steerScope();
    scope.client = { request: vi.fn(() => new Promise(resolve => setTimeout(() => resolve({ turnId: 'native-original' }), 20))) };
    const first = scope.tryAdmitSteer(); await scope.tryAdmitSteer();
    expect(scope.client.request).toHaveBeenCalledTimes(1); expect(scope.queue).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20); await first;
    expect(scope.queue).toHaveLength(0); expect(scope.activeTurn.accepted).toHaveLength(2);
    expect(scope.client.request.mock.calls[0][1].expectedTurnId).toBe('native-original');
    expect(scope.client.request.mock.calls[0][1].steerTargetTurnId).toBeUndefined();
  });
  it.each(['definite', 'timeout', 'generic-rpc', 'wrong-response'])(
    'preserves the pending answer on native %s instead of replaying an unknown result', async mode => {
      const scope = steerScope();
      scope.client = { request: vi.fn(async () => {
        if (mode === 'wrong-response') return { turnId: 'native-other' };
        if (mode === 'definite') throw new scope.AppServerRpcError('turn/steer', -32602, undefined, 'invalid params');
        if (mode === 'generic-rpc') throw new scope.AppServerRpcError('turn/steer', -32000, undefined, 'internal failure');
        throw new Error('timed out');
      }) };
      await scope.tryAdmitSteer();
      expect(scope.queue).toHaveLength(1); expect(scope.activeTurn.accepted).toHaveLength(1);
      expect(scope.client.request).toHaveBeenCalledTimes(1);
      if (mode === 'definite') {
        expect(scope.activeTurn.steeringClosed).toBe(true); expect(scope.fenceUnknown).not.toHaveBeenCalled();
      } else {
        expect(scope.generationFenced).toBe(true); expect(scope.activeTurn.completed).toBe(true);
      }
    });
  it('prepares the answer new turn identity before submission while a different human intervenes during credential lookup', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), 'codex-async-identity-probe-'));
    const scope = daemonScope();
    const botConfig = { triggerUserAuth: { enabled: true, tools: ['bytedcli'], credentialSource: 'local' } };
    Object.assign(scope, {
      config: { session: { dataDir: dir } }, getBot: () => ({ config: botConfig }),
      pickTurnReplyTarget, dispatchCallerFromReply, publishTurnCliIdentity,
      beginReplyTargetTurn, identityPublicationConflicted: () => false,
      identityModelForPublication: () => 'proven', localeForBot: () => 'en',
      triggerUserAuthEnabledFor: () => true, streamingCardDisabledFor: () => false,
    });
    Object.assign(scope.askSession, { scope: 'thread', activeInteractiveTurn: {
      turnId: 'om_original', caller: { senderType: 'user', requestLarkAppId: 'app', requestUserOpenId: 'ou_other' },
    } });
    Object.assign(scope.askSession.session, { sessionId: 'session', rootMessageId: 'om_root',
      ownerOpenId: 'ou_other', lastCallerOpenId: 'ou_other' });
    for (const name of ['dispatchUserForTurn', 'refreshTurnCliIdentity', 'noteTurnReceived']) {
      scope[name] = productionFunction('src/daemon.ts', name, scope);
    }
    scope.sendWorkerInput = vi.fn(() => {
      const content = recallProvenIdentityContent(dir, 'session', 'codex-async-answer-probe', 'bytedcli');
      expect(content).toContain('fake-cloud-ou_owner');
      expect(content).not.toContain('fake-cloud-ou_other');
      return true;
    });
    try {
      const pending = delivery(scope)('answer', 'ou_owner');
      // Drain only microtasks: real publication has begun its controlled provider wait.
      await vi.advanceTimersByTimeAsync(0);
      expect(scope.sendWorkerInput).not.toHaveBeenCalled();
      beginReplyTargetTurn(scope.askSession, 'om_root', 'om_intervening', undefined, {
        senderOpenId: 'ou_other', participants: [{ openId: 'ou_other', isBot: false }],
      });
      scope.askSession.session.quoteTargetId = 'om_intervening';
      scope.askSession.session.quoteTargetSenderOpenId = 'ou_other';
      scope.askSession.session.lastCallerOpenId = 'ou_other';
      await vi.advanceTimersByTimeAsync(20);
      expect(await pending).toBe(true);
      expect(scope.sendWorkerInput).toHaveBeenCalledTimes(1);
      expect(scope.sendWorkerInput.mock.calls[0][3].trustedCaller.requestUserOpenId).toBe('ou_owner');
      expect(pickTurnReplyTarget(scope.askSession.session, 'codex-async-answer-probe')?.senderOpenId).toBe('ou_owner');
      expect(recallProvenIdentityContent(dir, 'session', 'om_intervening', 'bytedcli')).toBeUndefined();
    } finally {
      forgetProvenIdentityContent(dir, 'session'); rmSync(dir, { recursive: true, force: true });
    }
  });
  it('publishes the answer turn and its frozen caller together to the real managed-origin file and IPC', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-async-origin-probe-'));
    const caller = { senderType: 'user', requestLarkAppId: 'app', requestUserOpenId: 'ou_owner' };
    const authority = new ActiveTurnAuthority();
    const original = { turnId: 'om_original', caller };
    authority.reserve(original); authority.markStarted(original);
    const scope: Record<string, any> = {
      activeTurnAuthority: authority, crossPrincipalIsolationOn: () => true,
      adoptActiveTurnWhenIsolationOff: () => false,
      sessionId: 'session', sandboxRelayCapability: undefined, sandboxPolicyCapability: undefined,
      currentBotmuxTurnId: 'om_old_capture', currentBotmuxDispatchAttempt: undefined,
      currentBotmuxLinkRefMode: undefined,
      sandboxRelayOutbox: undefined, readIsolationOriginChannelId: 'a'.repeat(64),
      lastInitConfig: { larkAppId: 'app', daemonBootId: 'boot' },
      process: { env: { SESSION_DATA_DIR: dir } }, config: { session: { dataDir: dir } },
      parseDaemonIpcPort: () => undefined, randomBytes, managedOriginCapabilityPath,
      replaceManagedOriginCapabilityFile, writeCliPidMarker: vi.fn(), send: vi.fn(), log: vi.fn(),
    };
    scope.turnAuthorityIdentity = productionFunction('src/worker.ts', 'turnAuthorityIdentity', scope);
    const mark = productionFunction('src/worker.ts', 'markActiveTurnStarted', scope);
    const publish = productionFunction('src/worker.ts', 'publishSandboxRelayCapability', scope);
    try {
      mark({ turnId: 'codex-async-answer-probe', trustedCaller: caller });
      // Caller objects elsewhere can mutate; authority owns its immutable snapshot.
      caller.requestUserOpenId = 'ou_other';
      expect(publish()).toBe(true);
      const msg = scope.send.mock.calls[0][0];
      expect(msg).toMatchObject({ type: 'managed_turn_origin', turnId: 'codex-async-answer-probe',
        identityTurnId: 'codex-async-answer-probe', trustedCaller: { requestUserOpenId: 'ou_owner' } });
      const stored = JSON.parse(readFileSync(managedOriginCapabilityPath(dir, 'session', 'a'.repeat(64)), 'utf8'));
      expect(stored.turnId).toBe('codex-async-answer-probe');
      expect(stored.capability).toBe(msg.capability);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(['sender', 'identity', 'caller'])(
    'does not submit an explicitly aborted native question while awaiting %s', async boundary => {
      vi.useFakeTimers(); const scope = daemonScope();
      const res = new ServerResponse(new IncomingMessage(new Socket()));
      const worker = { killed: false };
      Object.assign(scope.askSession, { worker });
      Object.assign(scope.askSession.session, { workerGeneration: 7, cliSessionId: 'thread' });
      Object.assign(scope, { res, asyncWorker: worker, asyncGeneration: 7,
        findActiveBySessionId: () => scope.askSession });
      scope.isCurrent = deliveryIsCurrent(scope);
      const pause = async (value: any) => new Promise(resolve => setTimeout(() => {
        res.destroy(); resolve(value);
      }, 20));
      if (boundary === 'sender') scope.resolveSender = () => pause({ name: 'User' });
      if (boundary === 'identity') scope.noteTurnReceived = () => pause(undefined);
      if (boundary === 'caller') scope.trustedCallerForInboundTurn = () => pause({
        senderType: 'user', requestLarkAppId: 'app', requestUserOpenId: 'ou_owner',
      });
      const pending = delivery(scope)('answer', 'ou_owner');
      // Drain microtasks first: the extracted delivery closure registers its
      // 20ms abort timer only after one/two internal awaits. Bun's fake-timer
      // shim advances time BEFORE flushing microtasks, so advancing without
      // this drain races the timer registration under `bun test` only.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20);
      expect(res.destroyed).toBe(true);
      expect(await pending).toBe(false);
      expect(scope.sendWorkerInput).not.toHaveBeenCalled();
    });
  it('allows an answer after natural native completion with an intact question response', async () => {
    const scope = daemonScope();
    const res = new ServerResponse(new IncomingMessage(new Socket()));
    const worker = { killed: false };
    Object.assign(scope.askSession, { worker });
    Object.assign(scope.askSession.session, { workerGeneration: 7, cliSessionId: 'thread' });
    Object.assign(scope, { res, asyncWorker: worker, asyncGeneration: 7,
      findActiveBySessionId: () => scope.askSession });
    scope.isCurrent = deliveryIsCurrent(scope);
    // Natural completion leaves the same worker/native thread alive and the
    // nonblocking question HTTP response pending; no native-busy requirement.
    expect(await delivery(scope)('answer', 'ou_owner')).toBe(true);
    expect(scope.sendWorkerInput).toHaveBeenCalledTimes(1);
    expect(res.destroyed).toBe(false); res.destroy();
  });
  it('actually attaches both the grant and target to an eligible daemon worker submission', async () => {
    const scope = daemonScope(); expect(await delivery(scope)('answer', 'ou_owner')).toBe(true);
    const [, payload, , opts] = scope.sendWorkerInput.mock.calls[0];
    expect(payload.codexAppInput.steerTargetTurnId).toBe('native-original');
    expect(opts.codexAppSteerable).toBe(true);
  });
});
