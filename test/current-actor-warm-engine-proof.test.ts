import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDaemonCurrentActor, snapshotProcessIdentities } from '../src/core/current-actor-attestation.js';
import { resolveDaemonCurrentExecution } from '../src/core/current-execution.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { SessionController } from '../src/core/session-controller.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { verifyCodexAppProcessIdentity } from '../src/services/codex-app-process-attestation.js';
import { CodexAppReadyAuthority, CodexAppTurnLiveness, applyTrustedCodexAppStateMarker } from '../src/utils/codex-app-turn-liveness.js';
import { codexAppSignedStateReadiness } from '../src/utils/codex-app-control.js';
import { isCodexAppCliId } from '../src/adapters/cli/types.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function proc(root: string, pid: number, parent: number, exe: string, argv = [exe], birth = String(pid * 10)) {
  const dir = join(root, String(pid)); mkdirSync(join(dir, 'fd'), { recursive: true });
  writeFileSync(join(dir, 'stat'), `${pid} (proc ${pid}) ${['S', String(parent), ...Array(17).fill('0'), birth].join(' ')}\n`);
  symlinkSync(exe, join(dir, 'exe')); writeFileSync(join(dir, 'cmdline'), argv.join('\0') + '\0');
  symlinkSync('pipe:[1001]', join(dir, 'fd', '0')); symlinkSync('pipe:[1002]', join(dir, 'fd', '1'));
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'actor-engine-proof-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  proc(root, 90, 1, '/bin/botmux'); proc(root, 100, 90, '/bin/botmux');
  proc(root, 200, 100, '/release/bin/codex', ['codex', 'app-server', '--listen', 'stdio://']);
  const ds: any = { session: { sessionId: 's1', status: 'active', cliId: 'codex-app' },
    larkAppId: 'cli_actor_probe', chatId: 'oc_chat', workerGeneration: 7, initConfig: { apiOnly: false },
    localProcessAttestation: { backendType: 'tmux', credentialIsolated: false, workerGeneration: 7, cliPid: 100, cliProcStart: '1000' },
    managedTurnOrigin: { capability: 'ca'.repeat(32), turnId: 'turn-current', callerOpenId: 'ou_current',
      preexistingProcessIdentities: snapshotProcessIdentities(100, root) } };
  proc(root, 400, 200, '/bin/sh'); // The tool starts after the current turn snapshot.
  const store = new SessionContractStore(join(root, 'contract'), ds.larkAppId); cleanups.push(() => store.close());
  const controller = new SessionController(ds, store); const workerRef = controller.bindWorker(7).worker;
  const eventScope = new WorkerSessionEventScope(controller.ref, workerRef);
  let bindingSequence = 0;
  const bind = (physicalId?: string) => {
    const binding = eventScope.beginRuntime(undefined, physicalId);
    controller.reserveBinding(binding.bindingId, workerRef);
    const identity = { backend: 'tmux', physicalId: '100:1000', proof: 'process_start' as const, nativeSessionId: `native-${++bindingSequence}` };
    binding.identity = identity; eventScope.assign(binding.bindingId, controller.bindRuntime(binding.bindingId, workerRef, identity).ref);
    return binding;
  };
  const startup = bind(); const current = bind(startup.physicalId);
  const worker: any = { pid: 90, killed: false, connected: true }; ds.worker = worker;
  const hostEnv: any = { sessionController: controller, contractWorker: workerRef, ds, worker,
    // The sliced worker-pool closure reads workerGeneration as a free variable;
    // without it the attestation worker-generation guard compares 7 !== undefined
    // and drops a legitimate engine attestation. It matches ds.workerGeneration.
    workerGeneration: 7,
    sessionCliId: () => 'codex-app', botCfg: {}, logger: { warn: vi.fn(), debug: vi.fn() }, t: 'actor-proof' };
  hostEnv.handleLegacyWorkerMessage = loadWorkerPoolClosure('handleLegacyWorkerMessage', hostEnv);
  const host = loadWorkerPoolClosure<any>('handleWorkerMessage', hostEnv); hostEnv.handleWorkerMessage = host;
  const pending: Promise<void>[] = []; const wire: any[] = [];
  const env: any = { workerSessionEventScope: eventScope, sessionId: 's1',
    lastInitConfig: { cliId: 'codex-app', sessionId: 's1' }, isCodexAppCliId,
    backend: { getChildPid: () => 100 }, effectiveBackendType: 'tmux', currentCliCredentialIsolated: false,
    readProcessStartIdentity: (pid: number) => String(pid * 10),
    codexAppControlProven: true, codexAppCompletionAwaitingFinal: false,
    codexAppSignedStateReadiness, applyTrustedCodexAppStateMarker,
    codexAppTurnLiveness: new CodexAppTurnLiveness(), codexAppReadyAuthority: new CodexAppReadyAuthority(),
    codexAppProofDeadline: { clear: vi.fn() }, cleanupCodexAppControlBootstrap: vi.fn(),
    restoreCodexAppAttestedTurn: vi.fn(), flushPending: vi.fn(), idleDetector: { reset: vi.fn() },
    rejectCodexAppControlMarker: vi.fn(), log: vi.fn(), closeRequested: false,
    frozenTurnLinkRefMode: () => undefined, isWorkflowWorker: () => false,
    verifyCodexAppProcessIdentity: (value: unknown, pid: number) => verifyCodexAppProcessIdentity(value, pid, root),
    process: { platform: 'linux', execPath: process.execPath, send: (message: any) => { wire.push(message); pending.push(host(message)); } } };
  for (const name of ['workerIpcPayload', 'send', 'publishLocalProcessAttestation', 'handleTrustedCodexAppMarker']) env[name] = loadWorkerFunction(name, env);
  const proof = { launcherPid: 100, launcherProcStart: '1000', enginePid: 200, engineProcStart: '2000' };
  const signedState = (claim = proof) => eventScope.run(current, () => env.handleTrustedCodexAppMarker('state',
    { processIdentity: claim, busy: true, tracksTurn: false, acceptingInput: true }, { generation: 'generation', seq: 1 }));
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  const resolveIdentity = vi.fn(async () => ({ type: 'user' as const, openId: 'ou_current', email: 'current@example.com' }));
  const input = () => ({ sessionId: 's1', peer: { pid: 400, procStart: '4000' }, findSession: () => ds, procRoot: root });
  const actor = () => resolveDaemonCurrentActor({ ...input(), resolveIdentity });
  return { root, ds, store, controller, eventScope, startup, current, env, wire, proof, signedState, drain, actor, input, resolveIdentity, hostEnv, bind };
}
describe('warm Codex App current actor requires native engine proof before input', () => {
  it('blocks a new tool at the preexisting app-server until verified signed state attests that exact engine', async () => {
    const h = fixture();
    expect(h.ds.managedTurnOrigin.preexistingProcessIdentities).toContain('200:2000');
    expect(resolveDaemonCurrentExecution(h.input())).toBeNull();
    await expect(h.actor()).resolves.toEqual({ ok: false, error: 'current_actor_unverified' });
    expect(h.resolveIdentity).not.toHaveBeenCalled();
    expect(await h.signedState()).toBe(true); await h.drain();
    expect(h.wire[0]).toMatchObject({ type: 'local_process_attestation', enginePid: 200, engineProcStart: '2000',
      sessionContract: { scope: { runtime: h.current.runtime } } });
    expect(h.ds.localProcessAttestation).toMatchObject({ enginePid: 200, engineProcStart: '2000', workerGeneration: 7 });
    expect(resolveDaemonCurrentExecution(h.input())).toMatchObject({ status: 'verified', turnId: 'turn-current' });
    await expect(h.actor()).resolves.toMatchObject({ ok: true, document: { actor: { email: 'current@example.com' } } });
  });
  it('does not release readiness or actor identity from an invalid kernel process claim', async () => {
    const h = fixture();
    expect(await h.signedState({ ...h.proof, engineProcStart: '1999' })).toBe(false); await h.drain();
    expect(h.env.codexAppInputReady).not.toBe(true); expect(h.wire).toHaveLength(0);
    await expect(h.actor()).resolves.toEqual({ ok: false, error: 'current_actor_unverified' });
  });
  it('rejects late process attestation from the retired semantic runtime instead of promoting its roots', async () => {
    const h = fixture(); h.env.codexAppRunnerProcessIdentity = h.proof;
    h.eventScope.run(h.startup, () => h.env.publishLocalProcessAttestation(100)); await h.drain();
    expect(h.ds.localProcessAttestation.enginePid).toBeUndefined();
    await expect(h.actor()).resolves.toEqual({ ok: false, error: 'current_actor_unverified' });
    expect(h.hostEnv.logger.debug).toHaveBeenCalledWith(expect.stringContaining('stale_runtime_scope'));
  });
  it('keeps an old tool blocked even after the native engine itself is correctly attested', async () => {
    const h = fixture(); h.ds.managedTurnOrigin.preexistingProcessIdentities.push('400:4000');
    expect(await h.signedState()).toBe(true); await h.drain();
    await expect(h.actor()).resolves.toEqual({ ok: false, error: 'current_actor_unverified' });
  });
  it.each(['engine-birth', 'worker-replacement'] as const)('rejects %s after the process proof', async change => {
    const h = fixture(); expect(await h.signedState()).toBe(true); await h.drain();
    if (change === 'engine-birth') writeFileSync(join(h.root, '200', 'stat'), '200 (reused) ' + ['S', '100', ...Array(17).fill('0'), '2001'].join(' ') + '\n');
    else h.ds.workerGeneration = 8;
    await expect(h.actor()).resolves.toEqual({ ok: false, error: 'current_actor_unverified' });
  });
  it('revokes an otherwise valid actor result when the turn changes during identity lookup', async () => {
    const h = fixture(); expect(await h.signedState()).toBe(true); await h.drain();
    h.resolveIdentity.mockImplementationOnce(async () => { h.ds.managedTurnOrigin.turnId = 'turn-replacement';
      return { type: 'user', openId: 'ou_current', email: 'current@example.com' }; });
    await expect(h.actor()).resolves.toEqual({ ok: false, error: 'current_actor_unverified' });
  });
});
