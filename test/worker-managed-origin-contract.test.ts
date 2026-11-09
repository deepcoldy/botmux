import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as botRegistry from '../src/bot-registry.js';
import { config } from '../src/config.js';
import { ActiveTurnAuthority, sameTrustedPrincipal } from '../src/core/active-turn-authority.js';
import { setIpcAuthSecret, startIpcServer } from '../src/core/dashboard-ipc-server.js';
import { larkToolBindingPath } from '../src/core/lark-tool-binding.js';
import { SessionController } from '../src/core/session-controller.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as identities from '../src/im/lark/identity-cache.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import * as tokens from '../src/utils/user-token.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure, loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Tracked sender tests start without any admission; the two publisher controls opt in explicitly.
function fixture({ preAdmit = false, cliId = 'codex-app' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'managed-origin-proof-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const ds: any = { session: { sessionId: 's1', status: 'active', cliId, workerGeneration: 7 }, larkAppId: 'cli_origin_probe', chatId: 'oc_chat', workerGeneration: 7 };
  const store = new SessionContractStore(root, ds.larkAppId); cleanups.push(() => store.close());
  const controller = new SessionController(ds, store); const workerRef = controller.bindWorker(7).worker;
  const scope = new WorkerSessionEventScope(controller.ref, workerRef);
  const bind = (native: string, physicalId?: string) => {
    const b = scope.beginRuntime(undefined, physicalId); controller.reserveBinding(b.bindingId, workerRef);
    b.identity = { backend: 'tmux', physicalId: '100:1000', proof: 'process_start', nativeSessionId: native };
    scope.assign(b.bindingId, controller.bindRuntime(b.bindingId, workerRef, b.identity).ref); return b;
  };
  const startup = bind('launcher'); const current = bind('native', startup.physicalId);
  const execution: any = preAdmit ? controller.admitInput('om_new_turn') : { turnId: 'om_new_turn' };
  if (preAdmit) scope.noteAdmission({ ref: execution, phase: 'queued' });
  const caller = { requestLarkAppId: ds.larkAppId, requestUserOpenId: 'ou_human', senderType: 'user' as const };
  const authority = new ActiveTurnAuthority(); authority.reserve({ turnId: execution.turnId, caller }); authority.markStarted({ turnId: execution.turnId, caller });
  const commands: any[] = [];
  const worker: any = { pid: 90, connected: true, killed: false, send: (message: any, callback?: (error: null) => void) => {
    commands.push({ ...message, sessionCommand: controller.command(message) }); callback?.(null); return true; } }; ds.worker = worker;
  const hostEnv: any = { ds, worker, sessionController: controller, contractWorker: workerRef, botCfg: {}, sessionCliId: () => cliId,
    logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() }, t: 'managed-origin', currentGatewayCallerOpenId: () => undefined,
    currentTurnProcessIdentities: () => ['100:1000'], noteTurnDispatchAttempt: vi.fn(), ensureAutomaticTaskContinuationLease: vi.fn(), sameTrustedPrincipal };
  hostEnv.handleLegacyWorkerMessage = loadWorkerPoolClosure('handleLegacyWorkerMessage', hostEnv);
  const realLegacy = hostEnv.handleLegacyWorkerMessage;
  hostEnv.handleLegacyWorkerMessage = async (message: any) => {
    if (message.type === 'turn_input_received') sender.acknowledgeOrdinaryImDeliveryReceipt(ds, message.turnId, 7);
    else if (message.type === 'turn_input_committed') sender.completeOrdinaryImDelivery(ds, message.turnId, 7);
    else await realLegacy(message);
  };
  const host = loadWorkerPoolClosure<any>('handleWorkerMessage', hostEnv); hostEnv.handleWorkerMessage = host;
  const wire: any[] = []; const pending: Promise<void>[] = [];
  const env: any = { workerSessionEventScope: scope, activeTurnAuthority: authority, sessionId: 's1', lastInitConfig: { cliId },
    currentBotmuxTurnId: execution.turnId, writeCliPidMarker: vi.fn(), parseDaemonIpcPort: () => 7956, randomBytes,
    frozenTurnLinkRefMode: () => undefined, isWorkflowWorker: () => false,
    process: { env: {}, send: (message: any) => { wire.push(message); pending.push(host(message)); } } };
  for (const name of ['workerIpcPayload', 'send', 'publishSandboxRelayCapability']) env[name] = loadWorkerFunction(name, env);
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  const sender: any = { controllerForSession: () => controller, pendingOrdinaryImDeliveries: new Map(),
    workerIpcBootstrapStates: new Map(), logger: hostEnv.logger, tag: () => 'tracked-origin', ORDINARY_IM_TRANSPORT_TIMEOUT_MS: 2_000, ORDINARY_IM_MAX_ATTEMPTS: 3,
    failOrdinaryImDelivery: vi.fn() };
  for (const name of ['ordinaryImDeliveryKey', 'ensurePrincipalLaneInboundTurnBinding', 'clearOrdinaryImDeliveryTimer',
    'clearOrdinaryImDelivery', 'acknowledgeOrdinaryImDeliveryReceipt', 'completeOrdinaryImDelivery',
    'retryOrFailOrdinaryImDelivery', 'afterWorkerIpcBootstrap', 'releaseWorkerIpcBootstrap',
    'sendOrdinaryImDeliveryAttempt', 'sendOrdinaryImDeliveryTracked']) sender[name] = loadWorkerPoolFunction(name, sender);
  cleanups.push(() => { for (const record of sender.pendingOrdinaryImDeliveries.values()) clearTimeout(record.timer); });
  const tracked = () => sender.sendOrdinaryImDeliveryTracked(ds, { type: 'message', turnId: execution.turnId,
    content: 'authorize current human', trustedCaller: caller });
  const receive = (effects = ['turn_input_received', 'managed_turn_origin', 'turn_input_committed']) => {
    const message = commands.at(-1); const admitted = message.sessionCommand.execution;
    if (admitted) scope.rememberExecution(admitted);
    scope.run(current, () => {
      for (const effect of effects) {
        if (effect === 'managed_turn_origin') { scope.enterTurn(message.turnId, message.dispatchAttempt); env.publishSandboxRelayCapability(); }
        else env.send({ type: effect, turnId: message.turnId });
      }
    }, admitted);
  };
  return { root, ds, store, controller, scope, startup, current, execution, authority, caller, hostEnv, env, wire, drain,
    sender, commands, tracked, receive };
}
describe('managed origin publication through the session contract', () => {
  it('publishes the queued ordinary turn and its full human caller before execution starts', async () => {
    const h = fixture({ preAdmit: true });
    h.scope.run(h.startup, () => h.scope.rememberExecution(h.execution)); // IPC resource may retain launcher context.
    h.scope.run(h.current, () => { h.scope.enterTurn(h.execution.turnId); h.env.publishSandboxRelayCapability(); });
    await h.drain();
    expect(h.wire).toHaveLength(1);
    expect(h.wire[0]).toMatchObject({ type: 'managed_turn_origin', turnId: h.execution.turnId,
      trustedCaller: h.caller, sessionContract: { scope: { runtime: h.current.runtime, execution: h.execution } } });
    expect(h.ds.managedTurnOrigin).toMatchObject({ turnId: h.execution.turnId, callerOpenId: 'ou_human', trustedCaller: h.caller });
    expect(h.store.execution(h.controller.ref, h.execution.executionId)).toMatchObject({ phase: 'queued' });
    expect(h.store.execution(h.controller.ref, h.execution.executionId)?.runtime).toBeUndefined();
  });
  it('rejects a publication from an old semantic context even if the PID marker and authority have the new turn', async () => {
    const h = fixture({ preAdmit: true }); h.scope.rememberExecution(h.execution, h.current);
    h.scope.run(h.startup, () => h.env.publishSandboxRelayCapability()); await h.drain();
    expect(h.env.writeCliPidMarker).toHaveBeenCalled(); expect(h.authority.identity().caller).toEqual(h.caller);
    expect(h.ds.managedTurnOrigin).toBeUndefined();
    expect(h.hostEnv.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Dropped managed_turn_origin from current worker turn=\S+ reason=(stale_runtime_scope|execution_scope_unproven)$/));
  });
});


describe('tracked ordinary input admits authority before private worker IPC', () => {
  it.each(['codex-app', 'claude-code'])('admits %s human input before receipt, capability publication and commit', async cliId => {
    const h = fixture({ cliId });
    expect(h.store.executions(h.controller.ref)).toHaveLength(0);
    expect(h.tracked()).toBe(true);
    expect(h.commands[0].sessionCommand.execution).toMatchObject({ turnId: 'om_new_turn' });
    expect(h.commands[0].sessionCommand.execution.dispatchAttempt).toBeUndefined();
    expect(h.sender.pendingOrdinaryImDeliveries.size).toBe(1);
    h.receive(['turn_input_received']); await h.drain();
    expect([...h.sender.pendingOrdinaryImDeliveries.values()][0].received).toBe(true);
    h.receive(['managed_turn_origin']); await h.drain();
    expect(h.ds.managedTurnOrigin).toMatchObject({ turnId: 'om_new_turn', callerOpenId: 'ou_human' });
    h.receive(['turn_input_committed']); await h.drain();
    expect(h.sender.pendingOrdinaryImDeliveries.size).toBe(0);
    expect(h.hostEnv.logger.debug).not.toHaveBeenCalled();
    expect(h.store.executions(h.controller.ref)).toHaveLength(1);
  });
  it('reuses the exact frozen execution through IPC transport retries and duplicate enqueue', async () => {
    const h = fixture(); expect(h.tracked()).toBe(true);
    const first = h.commands[0].sessionCommand.execution;
    const record = [...h.sender.pendingOrdinaryImDeliveries.values()][0];
    expect(h.sender.sendOrdinaryImDeliveryAttempt(record)).toBe(true);
    expect(h.tracked()).toBe(true);
    expect(h.commands).toHaveLength(2);
    expect(h.commands.every(message => message.sessionCommand.execution.executionId === first.executionId)).toBe(true);
    expect(h.store.executions(h.controller.ref)).toHaveLength(1);
  });
  it('keeps one durable execution across timed retry, late callback and receipt cleanup', async () => {
    vi.useFakeTimers();
    const h = fixture(); const callbacks: Array<(error: null) => void> = [];
    vi.spyOn(h.ds.worker, 'send').mockImplementation((message: any, callback?: (error: null) => void) => {
      h.commands.push({ ...message, sessionCommand: h.controller.command(message) });
      if (callback) callbacks.push(callback);
      return true;
    });
    expect(h.tracked()).toBe(true);
    const executionId = h.commands[0].sessionCommand.execution.executionId;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.commands).toHaveLength(2);
    expect(h.commands.every(message => message.sessionCommand.execution.executionId === executionId)).toBe(true);
    callbacks[0](null); // First attempt's callback arrives after its retry.
    expect([...h.sender.pendingOrdinaryImDeliveries.values()][0].transportConfirmed).toBe(false);
    h.receive(); await h.drain();
    callbacks[1](null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.commands).toHaveLength(2);
    expect(h.sender.pendingOrdinaryImDeliveries.size).toBe(0);
    expect(h.store.executions(h.controller.ref)).toHaveLength(1);
    expect(h.sender.failOrdinaryImDelivery).not.toHaveBeenCalled();
  });
  it('rolls back a partially written admission before recording or sending input', () => {
    const h = fixture();
    const remember = vi.spyOn(h.store, 'rememberResultBinding').mockImplementationOnce(() => { throw new Error('disk write failed'); });
    expect(() => h.tracked()).toThrow('disk write failed');
    expect(h.commands).toHaveLength(0);
    expect(h.sender.pendingOrdinaryImDeliveries.size).toBe(0);
    expect(h.store.executions(h.controller.ref)).toHaveLength(0);
    remember.mockRestore();
    expect(h.tracked()).toBe(true);
    expect(h.commands).toHaveLength(1);
    expect(h.store.executions(h.controller.ref)).toHaveLength(1);
  });
  it('refuses a new tracked turn while the logical session is closing', () => {
    const h = fixture(); h.controller.beginControl('close');
    expect(h.tracked()).toBe(false);
    expect(h.commands).toHaveLength(0); expect(h.sender.pendingOrdinaryImDeliveries.size).toBe(0);
    expect(h.store.executions(h.controller.ref)).toHaveLength(0);
  });
});


it('authorizes the real bound auth-request route from the human origin produced by tracked delivery', async () => {
  const h = fixture(); h.ds.chatType = 'p2p';
  expect(h.tracked()).toBe(true); h.receive(); await h.drain();
  expect(h.ds.managedTurnOrigin?.callerOpenId).toBe('ou_human');
  vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === 's1' ? h.ds : undefined);
  vi.spyOn(botRegistry, 'getBot').mockReturnValue({ config: { larkAppId: h.ds.larkAppId, larkAppSecret: 'test-secret',
    triggerUserAuth: { enabled: true, tools: ['lark-cli'], fallback: 'none' } } } as any);
  vi.spyOn(identities, 'getIdentity').mockReturnValue({ openId: 'ou_human', type: 'user', source: 'sender', updatedAt: 0 });
  vi.spyOn(identities, 'resolveVerifiedUserIdentity').mockResolvedValue(undefined);
  const oauth = vi.spyOn(tokens, 'requestUserAuthorization').mockResolvedValue({ authUrl: 'https://accounts.feishu.cn/oauth/device?user_code=test',
    scopes: ['offline_access', 'im:chat:read'], expiresIn: 600, poll: vi.fn().mockResolvedValue({ status: 'pending' }) } as any);
  setIpcAuthSecret('tracked-auth-test-secret'); cleanups.push(() => setIpcAuthSecret(null));
  const ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true }); cleanups.push(() => ipc.close());
  const accessKey = 'bd'.repeat(32); const path = larkToolBindingPath(config.session.dataDir, 's1');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 2, sessionId: 's1', appId: h.ds.larkAppId, brand: 'feishu', defaultAs: 'user',
    ipcPort: ipc.port, accessKey, realBinary: '/usr/bin/true', configDir: h.root, dataDir: config.session.dataDir }), { mode: 0o600 });
  cleanups.push(() => rmSync(path, { force: true }));
  const response = await fetch(`http://127.0.0.1:${ipc.port}/api/sessions/s1/auth-request`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': accessKey },
    body: JSON.stringify({ scopes: ['im:chat:read'] }),
  });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, authUrl: expect.any(String) });
  expect(oauth).toHaveBeenCalledOnce(); expect(oauth.mock.calls[0]?.[4]).toBe('ou_human');
});
