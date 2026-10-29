import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { spawnTsEval } from './helpers/ts-runner.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { CodexAppTurnDispatchQueue } from '../src/utils/codex-app-turn-dispatch.js';
import { CodexAppEngineRootWaitCancelled, parseCodexAppEngineIdentityClaim, verifyCodexAppEngineIdentity } from '../src/services/codex-app-engine-identity.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { CodexAppControlProofDeadline, codexAppSignedStateReadiness } from '../src/utils/codex-app-control.js';
import { applyTrustedCodexAppStateMarker, CodexAppReadyAuthority, CodexAppTurnLiveness } from '../src/utils/codex-app-turn-liveness.js';

if (process.env.BOTMUX_MERGE_ATTESTATION_MUTATION_ROOT) process.chdir(process.env.BOTMUX_MERGE_ATTESTATION_MUTATION_ROOT);
const children: ChildProcess[] = [];
const scopes: Record<string, any>[] = [];
afterEach(async () => {
  for (const scope of scopes.splice(0)) { scope.codexAppControlFatal = true; scope.codexAppProofDeadline.clear(); }
  vi.useRealTimers();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  }
});
async function fixture() {
  const child = spawnTsEval('setTimeout(() => {}, 60_000)', { stdio: 'ignore' });
  children.push(child); await once(child, 'spawn');
  const proof = { pid: child.pid!, procStart: readProcessStartIdentity(child.pid!)! };
  const queue = new CodexAppTurnDispatchQueue();
  const entry = { state: 'prepared', dispatchId: 'd-original', turnId: 'om_original', dispatchAttempt: 3,
    codexAppSteerable: true as const, replyTargetSenderOpenId: 'ou_original', replyTargetSenderIsBot: false };
  queue.restore([entry]);
  const authority = new ActiveTurnAuthority();
  const root: { pid: number | undefined } = { pid: process.pid };
  const scope: Record<string, any> = {
    process, backend: { getChildPid: () => root.pid },
    codexAppControlActiveSocket: { destroyed: false }, codexAppControlChannelId: 1,
    codexAppControlEndpointEpoch: 'epoch', codexAppControlProven: true, codexAppControlFatal: false,
    codexAppControlStateValue: { status: 'active', identities: [{ generation: 'g1' }] },
    codexAppGenerationCommits: [], codexAppRecoveredDispatches: [entry], codexAppTurnDispatchQueue: queue,
    codexAppCompletionAwaitingFinal: false, codexAppRunnerProcessIdentity: undefined, codexAppEngineIdentity: undefined,
    codexAppSignedStateObserved: false, codexAppInputReady: false,
    codexAppReadyAuthority: new CodexAppReadyAuthority(), codexAppTurnLiveness: new CodexAppTurnLiveness(),
    codexAppProofDeadline: new CodexAppControlProofDeadline(), activeTurnAuthority: authority,
    lastInitConfig: { cliId: 'codex-app', sessionId: 'merge-probe', larkAppId: 'cli_original' },
    codexAppSignedStateReadiness, CodexAppEngineRootWaitCancelled,
    parseCodexAppEngineIdentityClaim, verifyCodexAppEngineIdentity, readProcessStartIdentity,
    isCodexAppCliId: (id: string) => id === 'codex-app', applyTrustedCodexAppStateMarker,
    verifyCodexAppProcessIdentity: vi.fn(), captureAttachedCodexAppProcessIdentity: vi.fn(),
    effectiveBackendType: 'tmux', codexRpcEngine: undefined, currentCliCredentialIsolated: false,
    currentBotmuxTurnId: undefined, currentBotmuxDispatchAttempt: undefined, awaitingFirstPrompt: false,
    markerIdentityTurnId: (id: string) => id,
    setCaptureIdentity: (id: string, attempt: number) => { scope.currentBotmuxTurnId = id; scope.currentBotmuxDispatchAttempt = attempt; },
    send: vi.fn(), publishSandboxRelayCapability: vi.fn(), log: vi.fn(),
    cleanupCodexAppControlBootstrap: vi.fn(), flushPending: vi.fn(), idleDetector: { reset: vi.fn() },
    rejectCodexAppControlMarker: vi.fn(), queueMicrotask: vi.fn(), pendingMessages: [],
  };
  scope.publishedOrigins = [];
  scope.publishSandboxRelayCapability.mockImplementation(() => { scope.publishedOrigins.push({ turnId: scope.currentBotmuxTurnId, caller: authority.snapshot()?.caller }); });
  scope.failCodexAppControlGeneration = vi.fn(() => { scope.codexAppControlFatal = true; scope.codexAppControlProven = false; });
  for (const name of ['adoptInitialActiveTurn', 'restoreCodexAppAttestedTurn', 'waitForCodexAppEngineRoot',
    'publishLocalProcessAttestation', 'clearCodexAppEngineIdentity']) scope[name] = loadWorkerFunction(name, scope);
  const apply = loadWorkerFunction<(...args: any[]) => Promise<boolean>>('handleTrustedCodexAppMarker', scope);
  const state = (extra: Record<string, any> = {}) => ({ acceptingInput: true, busy: true, tracksTurn: true,
    activeReplyTurnId: 'om_original', appServerProcess: proof, ...extra });
  const control = () => ({ generation: 'g1', seq: 1, socket: scope.codexAppControlActiveSocket, channelId: 1, epoch: 'epoch' });
  scopes.push(scope); return { scope, proof, root, authority, queue, apply, state, control };
}

describe.skipIf(process.platform !== 'linux')('merged modern and surviving legacy engine recovery', () => {
  it('prefers the real modern host proof over an incompatible simultaneous legacy claim and restores the first turn', async () => {
    const h = await fixture();
    expect(await h.apply('state', h.state({ processIdentity: { untrusted: 'legacy-shape' } }), h.control())).toBe(true);
    expect(h.scope.verifyCodexAppProcessIdentity).not.toHaveBeenCalled();
    expect(h.scope.captureAttachedCodexAppProcessIdentity).not.toHaveBeenCalled();
    expect(h.scope.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'local_process_attestation',
      enginePid: h.proof.pid, engineProcStart: h.proof.procStart }));
    expect(h.authority.snapshot()).toMatchObject({ turnId: 'om_original', dispatchAttempt: 3,
      caller: { requestUserOpenId: 'ou_original', senderType: 'user' } });
    expect(h.scope.publishSandboxRelayCapability).toHaveBeenCalledTimes(1);
    await h.apply('state', h.state(), { ...h.control(), seq: 2 });
    expect(h.scope.send).toHaveBeenCalledTimes(1); expect(h.scope.publishSandboxRelayCapability).toHaveBeenCalledTimes(1);
  });
  it('does not resnapshot a live modern engine through a later legacy-only state', async () => {
    const h = await fixture(); await h.apply('state', h.state(), h.control());
    h.scope.verifyCodexAppProcessIdentity.mockReturnValue({ launcherPid: 10, launcherProcStart: '10', enginePid: 20, engineProcStart: '20' });
    const oldOnly = h.state({ appServerProcess: undefined, processIdentity: { legacy: true } });
    expect(await h.apply('state', oldOnly, { ...h.control(), seq: 2 })).toBe(false);
    expect(h.scope.verifyCodexAppProcessIdentity).not.toHaveBeenCalled();
    expect(h.scope.send).toHaveBeenCalledTimes(1);
    expect(h.scope.codexAppEngineIdentity).toEqual(h.proof);
  });
  it('publishes the modern frozen birth token when the legacy cache reuses the same pid', async () => {
    const h = await fixture(); await h.apply('state', h.state(), h.control());
    h.scope.codexAppRunnerProcessIdentity = { enginePid: h.proof.pid, engineProcStart: 'stale-legacy-token' };
    h.scope.publishLocalProcessAttestation(process.pid);
    expect(h.scope.send).toHaveBeenLastCalledWith(expect.objectContaining({
      enginePid: h.proof.pid, engineProcStart: h.proof.procStart,
    }));
  });
  it('publishes the modern frozen birth token before an old compatibility cache', async () => {
    const h = await fixture(); await h.apply('state', h.state(), h.control());
    h.scope.codexAppRunnerProcessIdentity = { enginePid: process.pid, engineProcStart: 'stale-legacy-token' };
    h.scope.publishLocalProcessAttestation(process.pid);
    expect(h.scope.send).toHaveBeenLastCalledWith(expect.objectContaining({ enginePid: h.proof.pid, engineProcStart: h.proof.procStart }));
  });
  it.each(['close', 'reauth', 'generation', 'final', 'takeover', 'cancel'])(
    'rechecks %s while a modern host root is unresolved', async change => {
      const h = await fixture(); h.root.pid = undefined;
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const result = h.apply('state', h.state(), h.control()).catch(error => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.scope.publishSandboxRelayCapability, 'no origin before root resolves').not.toHaveBeenCalled();
      if (change === 'close') h.scope.codexAppControlActiveSocket.destroyed = true;
      if (change === 'reauth') h.scope.codexAppControlProven = false;
      if (change === 'generation') h.scope.codexAppControlStateValue.identities[0].generation = 'g2';
      if (change === 'final') h.scope.codexAppCompletionAwaitingFinal = true;
      if (change === 'takeover') h.scope.adoptInitialActiveTurn({ turnId: 'om_new', trustedCaller: {
        requestLarkAppId: 'cli_original', requestUserOpenId: 'ou_new', senderType: 'user' } });
      if (change === 'takeover') {
        expect(h.scope.currentBotmuxTurnId).toBe('om_new');
        expect(h.authority.snapshot()?.caller?.requestUserOpenId).toBe('ou_new');
      }
      if (change === 'cancel') {
        h.scope.requestCodexAppDispatchTransition = async () => true;
        const retire = loadWorkerFunction<(id: string, attempt: number) => Promise<boolean>>('retireCodexAppDispatchForDurableReplay', h.scope);
        expect(await retire('om_original', 3)).toBe(true);
      }
      h.root.pid = process.pid; await vi.advanceTimersByTimeAsync(100);
      const outcome = await result;
      if (change === 'takeover') expect(h.scope.currentBotmuxTurnId, 'final current').toBe('om_new');
      if (change === 'takeover') {
        expect(h.scope.publishedOrigins).toEqual([{ turnId: 'om_new', caller: {
          requestLarkAppId: 'cli_original', requestUserOpenId: 'ou_new', senderType: 'user' } }]);
      } else expect(h.scope.publishSandboxRelayCapability).not.toHaveBeenCalled();
      if (change === 'close' || change === 'reauth') {
        expect(outcome).toBeInstanceOf(CodexAppEngineRootWaitCancelled); expect(h.scope.send).not.toHaveBeenCalled();
        expect(h.scope.codexAppInputReady).toBe(false);
      } else expect(outcome).toBe(true);
      if (change === 'takeover') expect(h.authority.snapshot()?.caller?.requestUserOpenId).toBe('ou_new');
      else expect(h.authority.snapshot()).toBeUndefined();
    });
});
