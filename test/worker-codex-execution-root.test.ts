import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDaemonCurrentExecution } from '../src/core/current-execution.js';
import { snapshotProcessIdentities } from '../src/core/current-actor-attestation.js';
import { cliIdForComm, findLaunchedCliPid, isNonInteractiveCodexArgv } from '../src/core/session-discovery.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Real worker observation/publication and daemon execution proof against a
 * controlled process table. No rollout, history, UI text or user identity is
 * used to authorize a process. */
function executionFixture(scope: Record<string, any>) {
  const procRoot = mkdtempSync(join(tmpdir(), 'codex-execution-root-'));
  roots.push(procRoot);
  const proc = (pid: number, ppid: number, start: string) => {
    const tail = ['S', String(ppid), ...Array(17).fill('0'), start];
    mkdirSync(join(procRoot, String(pid)), { recursive: true });
    writeFileSync(join(procRoot, String(pid), 'stat'), `${pid} (test) ${tail.join(' ')}\n`);
  };
  proc(90, 1, '900');
  proc(100, 90, '1000'); // resident wrapper
  proc(200, 100, '1200'); // native CLI already alive when a turn is admitted
  proc(210, 200, '1250'); // old-turn command, NEVER an execution root
  const ds: any = {
    session: { sessionId: 'session', status: 'active' },
    worker: { pid: 90, killed: false }, workerGeneration: 7,
    chatId: 'chat', larkAppId: 'app', initConfig: { apiOnly: false },
    localProcessAttestation: {
      backendType: 'pty', cliPid: 100, cliProcStart: '1000', workerGeneration: 7,
    },
    managedTurnOrigin: {
      capability: 'test-capability', turnId: 'delivery', callerOpenId: 'caller',
      preexistingProcessIdentities: snapshotProcessIdentities(100, procRoot),
    },
  };
  proc(220, 200, '1500'); // this turn's tool
  proc(211, 210, '1510'); // new child of an OLD tool
  proc(230, 1, '1520'); // unrelated same-host process
  const verify = (pid = 220, procStart = '1500') => resolveDaemonCurrentExecution({
    sessionId: 'session', peer: { pid, procStart }, findSession: () => ds, procRoot,
  });
  const events: string[] = [];
  Object.assign(scope, {
    backend: { cliPid: 100, getChildPid: () => 100 },
    lastInitConfig: { cliId: 'codex' },
    lastSpawnCodexLauncherActive: true, lastSpawnCodexLauncherPid: 100,
    lastSpawnCodexExecutable: undefined, codexOwnershipAttestationPending: false,
    currentBotmuxTurnId: 'delivery', codexRpcEngine: undefined,
    effectiveBackendType: 'pty', currentCliCredentialIsolated: false,
    readComm: (pid: number) => pid === 200 ? 'codex' : 'node',
    readCmdline: () => ['/opt/codex'], isZombieProcess: () => false,
    cliIdForComm, isNonInteractiveCodexArgv, snapshotChildPids: () => () => [],
    findLaunchedCliPid: (pid: number) => findLaunchedCliPid(pid, 'codex', 6, {
      childrenOf: p => p === 100 ? [200] : [],
      commOf: p => p === 200 ? 'codex' : 'node',
      cmdlineOf: () => ['/opt/codex'], isZombie: () => false,
    }),
    readProcessStartIdentity: (pid: number) => pid === 200 ? '1200' : '1000',
    send: (msg: any) => {
      if (msg.type === 'local_process_attestation') {
        events.push(`root:${msg.cliPid}`);
        ds.localProcessAttestation = { ...msg, workerGeneration: 7 };
      }
    },
    publishSandboxRelayCapability: vi.fn(() => { events.push('origin'); return true; }),
    log: vi.fn(),
  });
  for (const name of ['codexProcessIsNativeLeaf', 'resolveCodexOwnershipPid',
    'publishLocalProcessAttestation', 'currentCodexObservedPid']) {
    scope[name] = loadWorkerFunction(name, scope);
  }
  return { verify, ds, events };
}

describe('Codex execution root at ready and input boundaries', () => {
  it('refreshes a late native root at readiness without waiting for history', () => {
    const scope: Record<string, any> = {
      traexFirstPromptViewportRejects: () => false,
      currentInputDeliveryQuarantine: () => null,
      currentPostTerminalInputFence: () => null,
      stopStructuredStartGraceRecheck: vi.fn(), isCodexAppCliId: () => false,
      // Stop before unrelated readiness transitions, AFTER the real root refresh.
      probeStartupBlocker: () => true,
    };
    const { verify, events } = executionFixture(scope);
    expect(verify()).toBeNull();
    loadWorkerFunction<() => void>('markPromptReady', scope)();
    expect(events).toEqual(['root:200', 'origin']);
    expect(verify()).toMatchObject({ status: 'verified', turnId: 'delivery' });
    expect(verify(211, '1510')).toBeNull();
    expect(verify(230, '1520')).toBeNull();
    expect(verify(220, 'reused-pid')).toBeNull();
  });

  it.each([true, false])('refreshes before dequeue/first write even without a ready edge (ready=%s)', async ready => {
    const { scope, flush } = workerSubmitHarness();
    const { verify, events } = executionFixture(scope);
    scope.isPromptReady = ready; // false is the type-ahead / timeout path
    scope.codexBridgeFallbackActive = () => false;
    scope.stampMojoTurnMark = vi.fn();
    scope.deferTurnInputCommitUntilSubmission = () => false;
    scope.maybeQueuePostSubmitNativeSessionTitle = () => false;
    scope.cliAdapter.writeInput = vi.fn(async () => {
      events.push('write');
      expect(verify()).toMatchObject({ status: 'verified', turnId: 'delivery' });
      expect(verify(211, '1510')).toBeNull();
      return { submitted: true };
    });
    const take = scope.freshnessInputQueue.takeNormal;
    scope.freshnessInputQueue.takeNormal = () => {
      expect(verify()).toMatchObject({ status: 'verified' });
      events.push('dequeue');
      return take();
    };
    expect(verify()).toBeNull();
    await flush();
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
    expect(scope.pendingMessages).toEqual([]);
    expect(events.indexOf('root:200')).toBeLessThan(events.indexOf('origin'));
    expect(events.indexOf('origin')).toBeLessThan(events.indexOf('dequeue'));
    expect(events.indexOf('dequeue')).toBeLessThan(events.indexOf('write'));
  });

  it('does not refresh or dequeue while the generation is being replaced', async () => {
    const { scope, flush } = workerSubmitHarness();
    const { events } = executionFixture(scope);
    scope.cliRestartInProgress = true;
    await flush();
    expect(events).toEqual([]);
    expect(scope.pendingMessages).toHaveLength(1);
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
  });

  it('keeps non-Codex submit paths independent of Codex discovery', async () => {
    const { scope, flush } = workerSubmitHarness();
    scope.currentCodexObservedPid = vi.fn(() => { throw new Error('wrong CLI'); });
    await flush();
    expect(scope.currentCodexObservedPid).not.toHaveBeenCalled();
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
  });
});
