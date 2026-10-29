import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { spawnTsEval } from './helpers/ts-runner.js';
import { CodexAppEngineRootWaitCancelled, parseCodexAppEngineIdentityClaim, verifyCodexAppEngineIdentity } from '../src/services/codex-app-engine-identity.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { isCodexAppCliId } from '../src/adapters/cli/types.js';
import {
  CodexAppControlProofDeadline, codexAppSignedStateReadiness,
  CodexAppControlRecordApplicationGate, CodexAppControlReplayWindow,
  CodexAppControlSequenceFence, CodexAppControlFinalAssembler,
  parseCodexAppControlWireRecord, verifyCodexAppSignedControlMarker,
  encodeCodexAppSignedControlMarker, encodeCodexAppControlAck,
} from '../src/utils/codex-app-control.js';
import { committedCodexAppSequence } from '../src/utils/codex-app-dispatch-ledger.js';
import { applyTrustedCodexAppStateMarker, CodexAppReadyAuthority, CodexAppTurnLiveness } from '../src/utils/codex-app-turn-liveness.js';

const children: ChildProcess[] = [];
const scopes: Record<string, any>[] = [];
afterEach(async () => {
  for (const scope of scopes.splice(0)) {
    scope.codexAppControlFatal = true;
    scope.codexAppProofDeadline.clear();
  }
  await vi.advanceTimersByTimeAsync(100);
  vi.useRealTimers();
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
});

async function harness() {
  const child = spawnTsEval('setTimeout(() => {}, 60_000)', { stdio: 'ignore' });
  children.push(child);
  await once(child, 'spawn');
  const proof = { pid: child.pid!, procStart: readProcessStartIdentity(child.pid!)! };
  const root: { pid: number | null } = { pid: null };
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const scope: Record<string, any> = {
    process,
    backend: { getChildPid: vi.fn(() => root.pid) },
    codexAppControlActiveSocket: {}, codexAppControlChannelId: 1,
    codexAppControlProven: true, codexAppControlFatal: false,
    codexAppSignedStateObserved: false, codexAppInputReady: false,
    codexAppReadyAuthority: new CodexAppReadyAuthority(), codexAppTurnLiveness: new CodexAppTurnLiveness(),
    codexAppProofDeadline: new CodexAppControlProofDeadline(),
    isPromptReady: false, idleDetector: { reset: vi.fn() },
    lastInitConfig: { cliId: 'codex-app' }, codexAppEngineIdentity: undefined,
    codexAppSignedStateReadiness, CodexAppEngineRootWaitCancelled,
    parseCodexAppEngineIdentityClaim, verifyCodexAppEngineIdentity,
    readProcessStartIdentity, isCodexAppCliId, applyTrustedCodexAppStateMarker,
    effectiveBackendType: 'zellij', codexRpcEngine: undefined, currentCliCredentialIsolated: false,
    currentBotmuxTurnId: undefined, awaitingFirstPrompt: false,
    send: vi.fn(), log: vi.fn(), cleanupCodexAppControlBootstrap: vi.fn(), flushPending: vi.fn(),
    rejectCodexAppControlMarker: vi.fn(),
  };
  scope.failCodexAppControlGeneration = vi.fn(() => { scope.codexAppControlFatal = true; });
  scope.waitForCodexAppEngineRoot = loadWorkerFunction('waitForCodexAppEngineRoot', scope);
  scope.publishLocalProcessAttestation = loadWorkerFunction('publishLocalProcessAttestation', scope);
  const handle = loadWorkerFunction<(...args: any[]) => Promise<boolean>>('handleTrustedCodexAppMarker', scope);
  scopes.push(scope);
  const apply = (claim: unknown = proof) => handle('state', {
    acceptingInput: true, busy: true, appServerProcess: claim,
  }, { generation: 'test-generation', seq: 1 });
  return { scope, root, proof, apply };
}

function wireHarness(h: Awaited<ReturnType<typeof harness>>) {
  const pair = generateKeyPairSync('ed25519');
  const generation = randomBytes(32).toString('base64url');
  const identity = {
    generation, publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  };
  Object.assign(h.scope, {
    lastInitConfig: { cliId: 'codex-app', sessionId: 'root-wait-session' },
    codexAppControlEndpointEpoch: 'test-epoch', codexAppGenerationCommits: [], committedCodexAppSequence,
    codexAppControlRecordApplicationGate: new CodexAppControlRecordApplicationGate(),
    codexAppControlReplayWindow: new CodexAppControlReplayWindow(),
    parseCodexAppControlWireRecord, verifyCodexAppSignedControlMarker, encodeCodexAppControlAck,
  });
  h.scope.handleTrustedCodexAppMarker = loadWorkerFunction('handleTrustedCodexAppMarker', h.scope);
  const line = loadWorkerFunction<(...args: any[]) => Promise<void>>('handleCodexAppControlLine', h.scope);
  const connection = () => {
    const socket = { destroyed: false, write: vi.fn(), destroy: vi.fn(() => { socket.destroyed = true; }) };
    return {
      socket, identity, authenticated: true, channelId: 1, epoch: 'test-epoch',
      challenge: randomBytes(32).toString('base64url'),
      sequenceFence: new CodexAppControlSequenceFence(), finalAssembler: new CodexAppControlFinalAssembler(),
    };
  };
  const state = (c: ReturnType<typeof connection>) => encodeCodexAppSignedControlMarker(
    pair.privateKey, 'root-wait-session', generation, c.challenge, 1, 'state',
    { acceptingInput: true, busy: true, appServerProcess: h.proof },
  );
  return { line, connection, state, generation };
}

describe.skipIf(process.platform !== 'linux')('Codex App asynchronous backend engine root', () => {
  it('keeps the signed frame pending until the host root resolves, then verifies and publishes', async () => {
    const h = await harness();
    let settled = false;
    const applied = h.apply().then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    expect(h.scope.codexAppInputReady).toBe(false);
    expect(h.scope.send).not.toHaveBeenCalled();
    expect(h.scope.flushPending).not.toHaveBeenCalled();
    h.root.pid = process.pid;
    await vi.advanceTimersByTimeAsync(100);
    expect(await applied).toBe(true);
    expect(h.scope.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'local_process_attestation', enginePid: h.proof.pid, engineProcStart: h.proof.procStart,
    }));
    expect(h.scope.codexAppInputReady).toBe(true);
    expect(h.scope.codexAppProofDeadline.armed).toBe(false);
    expect(h.scope.flushPending).toHaveBeenCalledTimes(1);
    expect(h.scope.failCodexAppControlGeneration).not.toHaveBeenCalled();
  });

  it('keeps the existing absolute deadline when the root never resolves', async () => {
    const h = await harness();
    h.scope.codexAppProofDeadline.arm(() => h.scope.failCodexAppControlGeneration(), 50);
    const applied = h.apply().catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await applied).toBeInstanceOf(CodexAppEngineRootWaitCancelled);
    expect(h.scope.failCodexAppControlGeneration).toHaveBeenCalledTimes(1);
    expect(h.scope.send).not.toHaveBeenCalled();
    expect(h.scope.codexAppInputReady).toBe(false);
  });

  it('waits for an asynchronously installed backend without spinning or releasing input', async () => {
    const h = await harness();
    const nextBackend = h.scope.backend;
    h.scope.backend = null;
    const applied = h.apply();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.scope.send).not.toHaveBeenCalled();
    h.root.pid = process.pid;
    h.scope.backend = nextBackend;
    await vi.advanceTimersByTimeAsync(100);
    expect(await applied).toBe(true);
    expect(h.scope.send).toHaveBeenCalledTimes(1);
  });

  it.each(['socket', 'closed', 'backend', 'channel', 'epoch', 'shutdown'] as const)(
    'never lets a pending frame publish after its %s changes', async change => {
      const h = await harness();
      const applied = h.apply().catch(error => error);
      if (change === 'socket') h.scope.codexAppControlActiveSocket = {};
      if (change === 'closed') h.scope.codexAppControlActiveSocket.destroyed = true;
      if (change === 'backend') h.scope.backend = { getChildPid: () => process.pid };
      if (change === 'channel') h.scope.codexAppControlChannelId++;
      if (change === 'epoch') h.scope.codexAppControlEndpointEpoch = 'rotated-epoch';
      if (change === 'shutdown') h.scope.codexAppControlFatal = true;
      h.root.pid = process.pid;
      await vi.advanceTimersByTimeAsync(100);
      expect(await applied).toBeInstanceOf(CodexAppEngineRootWaitCancelled);
      expect(h.scope.send).not.toHaveBeenCalled();
      expect(h.scope.codexAppInputReady).toBe(false);
    },
  );

  it('rechecks ownership after root resolution across the await boundary', async () => {
    const h = await harness();
    const applied = h.apply().catch(error => error);
    h.scope.backend.getChildPid = () => {
      queueMicrotask(() => { h.scope.codexAppControlActiveSocket = {}; });
      return process.pid;
    };
    await vi.advanceTimersByTimeAsync(100);
    expect(await applied).toBeInstanceOf(CodexAppEngineRootWaitCancelled);
    expect(h.scope.send).not.toHaveBeenCalled();
    expect(h.scope.codexAppInputReady).toBe(false);
  });

  it('does not ACK a signed state until the host root verifies', async () => {
    const h = await harness();
    const wire = wireHarness(h);
    const c = wire.connection();
    h.scope.codexAppControlActiveSocket = c.socket;
    const pending = wire.line(c, wire.state(c));
    await vi.advanceTimersByTimeAsync(100);
    expect(c.socket.write).not.toHaveBeenCalled();
    expect(h.scope.send).not.toHaveBeenCalled();
    expect(h.scope.codexAppControlReplayWindow.highWater(wire.generation)).toBe(0);
    h.root.pid = process.pid;
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(c.socket.write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(c.socket.write.mock.calls[0]![0])).toMatchObject({ type: 'ack', seq: 1 });
    expect(h.scope.send).toHaveBeenCalledTimes(1);
    expect(h.scope.codexAppControlReplayWindow.highWater(wire.generation)).toBe(1);
  });

  it('revalidates a replay on the new connection when the shared old wait is cancelled', async () => {
    const h = await harness();
    const wire = wireHarness(h);
    const first = wire.connection();
    h.scope.codexAppControlActiveSocket = first.socket;
    const old = wire.line(first, wire.state(first)).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    const second = wire.connection();
    first.socket.destroy();
    h.scope.codexAppControlActiveSocket = second.socket;
    const replay = wire.line(second, wire.state(second));
    h.root.pid = process.pid;
    await vi.advanceTimersByTimeAsync(100);
    expect(await old).toBeInstanceOf(CodexAppEngineRootWaitCancelled);
    await replay;
    expect(second.socket.destroyed).toBe(false);
    expect(second.socket.write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(second.socket.write.mock.calls[0]![0])).toMatchObject({ type: 'ack', seq: 1 });
    expect(h.scope.send).toHaveBeenCalledTimes(1);
    const third = wire.connection();
    h.scope.codexAppControlActiveSocket = third.socket;
    await wire.line(third, wire.state(third));
    expect(third.socket.write).toHaveBeenCalledTimes(1);
    expect(h.scope.send).toHaveBeenCalledTimes(1);
  });

  it.each(['replacement', 'removed'] as const)('does not retry a retired backend on the same connection: %s', async mode => {
    const h = await harness();
    const wire = wireHarness(h);
    const c = wire.connection();
    h.scope.codexAppControlActiveSocket = c.socket;
    const pending = wire.line(c, wire.state(c)).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    h.scope.backend = mode === 'removed' ? null : { getChildPid: () => process.pid };
    h.root.pid = process.pid;
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBeInstanceOf(CodexAppEngineRootWaitCancelled);
    expect(h.scope.send).not.toHaveBeenCalled();
    expect(c.socket.write).not.toHaveBeenCalled();
    expect(h.scope.codexAppControlReplayWindow.highWater(wire.generation)).toBe(0);
  });

  it('allows a new connection to verify the first backend installation during a pending replay', async () => {
    const h = await harness();
    const wire = wireHarness(h);
    const firstBackend = h.scope.backend;
    h.scope.backend = null;
    const first = wire.connection();
    h.scope.codexAppControlActiveSocket = first.socket;
    const old = wire.line(first, wire.state(first)).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    const second = wire.connection();
    first.socket.destroy();
    h.scope.codexAppControlActiveSocket = second.socket;
    const replay = wire.line(second, wire.state(second));
    h.scope.backend = firstBackend;
    h.root.pid = process.pid;
    await vi.advanceTimersByTimeAsync(100);
    expect(await old).toBeInstanceOf(CodexAppEngineRootWaitCancelled);
    await replay;
    expect(second.socket.destroyed).toBe(false);
    expect(second.socket.write).toHaveBeenCalledTimes(1);
    expect(h.scope.send).toHaveBeenCalledTimes(1);
  });

  it.each(['backend', 'channel'] as const)('does not transfer a pending replay across a retired %s', async owner => {
    const h = await harness();
    const wire = wireHarness(h);
    const first = wire.connection();
    h.scope.codexAppControlActiveSocket = first.socket;
    const old = wire.line(first, wire.state(first)).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    const second = wire.connection();
    if (owner === 'backend') h.scope.backend = { getChildPid: () => process.pid };
    else h.scope.codexAppControlChannelId = second.channelId = 2;
    first.socket.destroy();
    h.scope.codexAppControlActiveSocket = second.socket;
    const replay = wire.line(second, wire.state(second)).catch(error => error);
    h.root.pid = process.pid;
    await vi.advanceTimersByTimeAsync(100);
    expect(await old).toBeInstanceOf(CodexAppEngineRootWaitCancelled);
    expect(await replay).toBeInstanceOf(CodexAppEngineRootWaitCancelled);
    expect(second.socket.write).not.toHaveBeenCalled();
    expect(h.scope.send).not.toHaveBeenCalled();
    expect(h.scope.codexAppControlReplayWindow.highWater(wire.generation)).toBe(0);
  });

  it('still fails malformed signed claims immediately while the root is unresolved', async () => {
    const h = await harness();
    expect(await h.apply({ pid: 'invalid', procStart: '123' })).toBe(false);
    expect(h.scope.failCodexAppControlGeneration).toHaveBeenCalledTimes(1);
    expect(h.scope.backend.getChildPid).not.toHaveBeenCalled();
  });

  it('still rejects a resolved but invalid backend PID', async () => {
    const h = await harness();
    const applied = h.apply();
    h.root.pid = 0;
    await vi.advanceTimersByTimeAsync(100);
    expect(await applied).toBe(false);
    expect(h.scope.failCodexAppControlGeneration).toHaveBeenCalledTimes(1);
    expect(h.scope.send).not.toHaveBeenCalled();
  });
});
