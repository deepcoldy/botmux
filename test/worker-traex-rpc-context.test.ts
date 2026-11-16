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
