// A follow-up IM turn on a long-lived worker must publish its own requesting
// user to the daemon exactly like the opening turn does, after the relay has
// rebound the runtime to the real CLI pid, without leaving its delivery
// unconfirmed or its queued input unprotected. Drives the real daemon IPC
// handlers, contract controller, worker event scope and IPC send, and both
// identity routes; only the Lark/network edges are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as bots from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import * as identities from '../src/im/lark/identity-cache.js';
import * as tokens from '../src/utils/user-token.js';
import { controllerForSession } from '../src/core/session-controller.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { admitSessionCommand } from '../src/services/session-command-gateway.js';
import { resolveDaemonCurrentActor } from '../src/core/current-actor-attestation.js';
import { startIpcServer, setIpcAuthSecret, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { prepareLarkToolEnv } from '../src/core/lark-tool-binding.js';
import { clearLarkToolDelegations } from '../src/core/lark-tool-delegation.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { logger } from '../src/utils/logger.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import type { DaemonSession } from '../src/core/types.js';

const APP = 'cli_follow_up_origin';
const SESSION = 'follow-up-origin-session';
const OPENING = 'om_opening_turn';
const FOLLOW_UP = 'om_follow_up_turn';
const caller = (openId: string) => ({ requestUserOpenId: openId, requestLarkAppId: APP, senderType: 'user' as const });
const physicalId = (pid: number) => `${pid}:${readProcessStartIdentity(pid)}`;

let dir: string;
let sessionReply: ReturnType<typeof vi.fn>;
let previousDataDir: string;
let ipc: IpcServerHandle | undefined;
let scenario: ReturnType<typeof startScenario> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'follow-up-origin-'));
  previousDataDir = config.session.dataDir; config.session.dataDir = dir;
  workerPool.__testOnly_resetOrdinaryImDeliveries();
  workerPool.__testOnly_setSuspendBackingVerifier(() => true);
  vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);
  vi.spyOn(bots, 'getBot').mockReturnValue({
    config: { larkAppId: APP, larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'FollowUpBot',
  } as any);
  sessionReply = vi.fn(async () => 'om_reply');
  workerPool.initWorkerPool({
    sessionReply,
    getSessionWorkingDir: () => dir,
    getActiveCount: () => 1,
    closeSession: vi.fn(),
  } as any);
});

afterEach(async () => {
  clearLarkToolDelegations(dir, SESSION);
  await ipc?.close(); ipc = undefined; setIpcAuthSecret(null);
  scenario?.controller.store.close(); scenario = undefined;
  workerPool.__testOnly_resetOrdinaryImDeliveries();
  workerPool.__testOnly_setSuspendBackingVerifier();
  config.session.dataDir = previousDataDir;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function startScenario() {
  const worker = new EventEmitter() as any;
  worker.killed = false; worker.connected = true; worker.pid = process.pid;
  worker.kill = vi.fn(); worker.stdout = new EventEmitter(); worker.stderr = new EventEmitter();
  const toWorker: any[] = [];
  worker.send = vi.fn((message: any, callback?: (error: Error | null) => void) => {
    toWorker.push(message); callback?.(null); return true;
  });
  const ds = {
    session: {
      sessionId: SESSION, chatId: 'oc_group', chatType: 'group', status: 'active', cliId: 'claude-code',
      createdAt: new Date().toISOString(), workerGeneration: 1,
      replyTargets: {
        [OPENING]: { rootMessageId: OPENING, senderOpenId: 'ou_opening_sender', updatedAt: new Date().toISOString() },
        [FOLLOW_UP]: { rootMessageId: FOLLOW_UP, senderOpenId: 'ou_follow_up_sender', updatedAt: new Date().toISOString() },
      },
    },
    larkAppId: APP, chatId: 'oc_group', chatType: 'group', scope: 'chat',
    worker, workerGeneration: 1, workerPort: 0, workerToken: 'token',
    spawnedAt: Date.now(), cliVersion: '1', lastMessageAt: Date.now(), hasHistory: true,
  } as unknown as DaemonSession;

  // forkWorker's contract bootstrap: the opening turn rides on init.
  const controller = controllerForSession(ds, true)!;
  const contract = controller.bindWorker(1);
  const openingExecution = controller.admitInput(OPENING);
  ds.initConfig = { type: 'init', sessionId: SESSION, cliId: 'claude-code', backendType: 'tmux', turnId: OPENING, sessionContract: contract } as any;
  workerPool.__testOnly_setupWorkerHandlers(ds, worker, undefined, 1);

  // Worker side: the real event scope, envelope builder, IPC admission and
  // IPC send. The runtime was first bound to the relay's launcher process.
  const scope = new WorkerSessionEventScope(controller.ref, contract.worker);
  const binding = scope.beginRuntime();
  const runtime = controller.reserveBinding(binding.bindingId, contract.worker);
  controller.bindRuntime(binding.bindingId, contract.worker, {
    backend: 'tmux', physicalId: physicalId(process.ppid), nativeSessionId: SESSION, proof: 'process_start',
  });
  scope.assign(binding.bindingId, runtime);
  scope.rememberExecution(openingExecution, binding);
  const inFlight: Promise<unknown>[] = [];
  const ws: any = {
    workerSessionEventScope: scope, pendingMessages: [], pendingRawInputs: [], pendingAdoptMessages: [],
    cliSubmissionInFlight: null, submitFailureChains: { size: () => 0 }, publishedCliInputBacklog: 'false:',
    universalOutputHandoff: null, closeRequested: false, isWorkflowWorker: () => false,
    ordinaryImTurnDedupe: { commit: vi.fn() },
    process: { send: (payload: unknown) => {
      inFlight.push(Promise.all(worker.listeners('message').map((listener: (value: unknown) => unknown) => listener(payload))));
    } },
  };
  for (const name of ['sessionEventMetadata', 'workerIpcPayload', 'cliInputBacklogKey', 'cliInputBacklog',
    'publishCliInputBacklog', 'send', 'acknowledgeTurnInputCommitted']) ws[name] = loadWorkerFunction(name, ws);
  const drain = async () => { while (inFlight.length) await Promise.all(inFlight.splice(0)); };
  const post = async (payload: unknown) => { ws.process.send(payload); await drain(); };
  const toDaemon = async (message: any) => { ws.send(message); await drain(); };
  // Mirrors the worker's process.on('message') fence for daemon -> worker IPC.
  const receive = (message: any, work: () => void) => {
    const current = scope.currentBinding()!;
    const admission = admitSessionCommand(message.type, message.sessionCommand, current.runtime ?? current.proposedRuntime);
    if (!admission.allowed) throw new Error(`worker rejected ${message.type}: ${admission.reason}`);
    if (message.sessionCommand?.execution) scope.rememberExecution(message.sessionCommand.execution);
    return scope.run(current, work, message.sessionCommand?.execution, message.sessionCommand?.operationId);
  };
  let capabilitySequence = 0;
  // flushPending: enter the written turn, publish its authority and, unless the
  // input was already committed to the queue, commit it.
  const writeTurn = (turnId: string, trustedCaller: unknown, commit = true) => scope.run(binding, async () => {
    scope.enterTurn(turnId);
    const capability = `capability-${++capabilitySequence}`;
    await toDaemon({ type: 'managed_turn_origin', sessionId: SESSION, capability, policyCapability: 'policy-capability',
      trustedCaller: trustedCaller ?? null, identityTurnId: turnId, turnId });
    await toDaemon({ type: 'turn_execution_started', turnId });
    if (commit) await toDaemon({ type: 'turn_input_committed', turnId });
    return capability;
  });
  const finishTurn = (turnId: string, capability: string) => scope.run(binding, async () => {
    scope.enterTurn(turnId);
    await toDaemon({ type: 'managed_turn_origin_revoked', sessionId: SESSION, capability, turnId });
    await toDaemon({ type: 'turn_terminal', sessionId: SESSION, turnId, status: 'completed' });
  });
  const boot = async () => {
    await scope.run(binding, () => toDaemon({ type: 'ready', port: 0, token: 'token' }));
    await scope.run(binding, () => toDaemon({ type: 'local_process_attestation', backendType: 'tmux', credentialIsolated: false,
      cliPid: process.pid, cliProcStart: readProcessStartIdentity(process.pid) }));
    await scope.run(binding, () => toDaemon({ type: 'prompt_ready' }));
  };
  // The relay swaps its launcher pid for the real CLI pid and re-announces the
  // runtime; the daemon refuses the changed identity and keeps the old binding.
  const relayRebind = () => scope.run(binding, () => toDaemon({ type: 'runtime_binding', bindingId: binding.bindingId,
    identity: { backend: 'tmux', physicalId: physicalId(process.pid), nativeSessionId: SESSION, proof: 'process_start' } }));
  const deliverFollowUp = () => {
    expect(workerPool.sendWorkerInput(ds, 'follow-up question', FOLLOW_UP, { trustedCaller: caller('ou_follow_up_sender') })).toBe(true);
    const delivered = toWorker.find(message => message.type === 'message' && message.turnId === FOLLOW_UP);
    expect(delivered.sessionCommand?.execution).toMatchObject({ turnId: FOLLOW_UP });
    return delivered;
  };
  // The worker's message case: receipt ACK, enqueue, then the commit ACK.
  const queueFollowUp = (delivered: any) => receive(delivered, async () => {
    await toDaemon({ type: 'turn_input_received', turnId: FOLLOW_UP });
    ws.pendingMessages.push({ turnId: FOLLOW_UP, content: 'follow-up question' });
    ws.acknowledgeTurnInputCommitted(FOLLOW_UP);
    await drain();
  });
  return { ds, worker, controller, scope, binding, toWorker, ws, drain, post, toDaemon, receive, writeTurn, finishTurn, boot, relayRebind, deliverFollowUp, queueFollowUp };
}

async function runToFollowUp() {
  const s = scenario = startScenario();
  // Opening turn: the CLI's first prompt_ready lands before the opening prompt
  // is flushed, then the turn runs and terminates normally.
  await s.boot();
  const openingCapability = await s.writeTurn(OPENING, caller('ou_opening_sender'));
  const opening = { ...s.ds.managedTurnOrigin };
  await s.finishTurn(OPENING, openingCapability);
  await s.scope.run(s.binding, () => s.toDaemon({ type: 'prompt_ready' }));
  await s.relayRebind();

  // An ordinary IM follow-up on the same worker, through the daemon's real
  // ordinary-IM delivery path; flushPending then writes it to the CLI.
  const delivered = s.deliverFollowUp();
  await s.queueFollowUp(delivered);
  s.ws.pendingMessages.length = 0;
  await s.writeTurn(FOLLOW_UP, delivered.trustedCaller, false);
  return { s, opening };
}

describe('ordinary IM follow-up turn origin', () => {
  it('publishes the follow-up turn and its own sender as the daemon live origin after the relay rebinds the pid', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const { s, opening } = await runToFollowUp();
    expect(warn.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringContaining('runtime_identity_changed'));
    expect(s.controller.store.runtime(s.controller.ref)?.identity?.physicalId).toBe(physicalId(process.ppid));
    expect(opening).toMatchObject({ turnId: OPENING, callerOpenId: 'ou_opening_sender' });
    expect(s.ds.managedTurnOrigin).toMatchObject({ turnId: FOLLOW_UP, callerOpenId: 'ou_follow_up_sender' });
    // The worker's commit ACK for the follow-up settles the tracked delivery.
    expect(workerPool.hasPendingOrdinaryImDelivery(s.ds)).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('serves the follow-up sender to actor current and the lark-tool user route', async () => {
    const { s } = await runToFollowUp();
    const peer = { pid: process.pid, procStart: readProcessStartIdentity(process.pid)! };
    const actor = await resolveDaemonCurrentActor({
      sessionId: SESSION, peer, findSession: id => id === SESSION ? s.ds : undefined,
      resolveIdentity: async (_appId, openId) => ({ openId, type: 'user', email: `${openId}@example.test` }) as any,
    });
    expect(actor).toMatchObject({ ok: true, document: { status: 'verified', turnId: FOLLOW_UP, actor: { email: 'ou_follow_up_sender@example.test' } } });

    const binding = prepareLarkToolEnv({ env: { PATH: '/usr/bin:/bin' }, dataDir: dir, sessionId: SESSION, appId: APP });
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => id === SESSION ? s.ds : undefined);
    vi.spyOn(identities, 'resolveVerifiedUserIdentity').mockImplementation(async (_appId, openId) => ({ openId, type: 'user' }) as any);
    vi.spyOn(tokens, 'resolveUserToken').mockImplementation(async (_appId, _secret, _brand, openId) => `user-token:${openId}`);
    setIpcAuthSecret('follow-up-origin-key');
    ipc = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
    const response = await fetch(`http://127.0.0.1:${ipc.port}/api/sessions/${SESSION}/lark-tool-identity`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-botmux-lark-session': binding.accessKey },
      body: JSON.stringify({ mode: 'user' }),
    });
    expect(await response.json()).toMatchObject({ ok: true, mode: 'user', credential: 'user-token:ou_follow_up_sender' });
  });

  it('does not report the committed follow-up as unconfirmed when its worker is suspended', async () => {
    const { s } = await runToFollowUp();
    const error = vi.spyOn(logger, 'error');
    sessionReply.mockClear();
    expect(workerPool.suspendWorker(s.ds, 'suspended_idle')).toBe(true);
    s.worker.emit('exit', 0, null);
    await Promise.resolve();
    expect(error.mock.calls.map(([line]) => String(line)).filter(line => line.includes('worker_retired_before_commit'))).toEqual([]);
    expect(sessionReply).not.toHaveBeenCalled();
  });

  it('keeps a follow-up queued behind the running turn from being suspended after its commit ACK', async () => {
    const s = scenario = startScenario();
    await s.boot();
    const openingCapability = await s.writeTurn(OPENING, caller('ou_opening_sender'));
    await s.relayRebind();
    s.ds.pendingSuspendReason = 'cli_install_changed'; s.ds.pendingSuspendGeneration = 1;

    // The CLI is still on the opening turn: the worker queues the follow-up.
    await s.queueFollowUp(s.deliverFollowUp());
    expect(workerPool.hasPendingOrdinaryImDelivery(s.ds)).toBe(false);
    expect(workerPool.hasUnacceptedCliInput(s.ds)).toBe(true);

    // The opening turn ends and the screen goes idle before the queue drains.
    await s.finishTurn(OPENING, openingCapability);
    await s.scope.run(s.binding, () => s.toDaemon({ type: 'screen_update', status: 'idle', content: '' }));
    await new Promise(resolve => setImmediate(resolve));
    expect(s.ds.worker).toBe(s.worker);
    expect(s.ds.pendingSuspendReason).toBe('cli_install_changed');

    // The backlog still needs this worker as its producer.
    const forged = s.scope.run(s.binding, () => s.ws.sessionEventMetadata({ type: 'cli_input_backlog', pending: false }));
    await s.post({ ...forged, sessionContract: { ...forged.sessionContract, producer: { workerId: 'retired-worker', generation: 0 } } });
    await new Promise(resolve => setImmediate(resolve));
    expect(workerPool.hasUnacceptedCliInput(s.ds)).toBe(true);
    expect(s.ds.worker).toBe(s.worker);

    // Once the worker reports its queue drained, the claim is held rather than
    // cashed in: the follow-up turn is now the live turn but has not reported
    // its terminal, so the queued suspend waits for that reply to settle instead
    // of stopping the CLI at the start of the turn (and dropping its answer).
    s.ws.pendingMessages.length = 0;
    await s.scope.run(s.binding, async () => { s.ws.publishCliInputBacklog(); await s.drain(); });
    await new Promise(resolve => setImmediate(resolve));
    expect(workerPool.hasUnacceptedCliInput(s.ds)).toBe(false);
    expect(s.ds.pendingSuspendReason).toBe('cli_install_changed');
    expect(s.ds.worker).toBe(s.worker);

    // The follow-up turn completes; its terminal re-runs the suspend checkpoint
    // and the now-settled claim is fulfilled.
    const followUpCapability = await s.writeTurn(FOLLOW_UP, caller('ou_follow_up_sender'), false);
    await s.finishTurn(FOLLOW_UP, followUpCapability);
    await new Promise(resolve => setImmediate(resolve));
    expect(s.ds.pendingSuspendReason).toBeUndefined();
  });

  // `botmux suspend` while a follow-up is on its way queues behind that input.
  // The worker may refuse it before admission: it never reaches the queue, so
  // no backlog report and no screen edge follows to cash the suspend in.
  it('carries out a suspend queued behind a follow-up once the worker has refused it', async () => {
    const s = scenario = startScenario();
    await s.boot();
    const openingCapability = await s.writeTurn(OPENING, caller('ou_opening_sender'));
    await s.finishTurn(OPENING, openingCapability);
    await s.scope.run(s.binding, () => s.toDaemon({ type: 'screen_update', status: 'idle', content: '' }));

    const delivered = s.deliverFollowUp();
    expect(workerPool.manualSuspendWaits(s.ds).waitingFor).toEqual(['input']);
    workerPool.queueManualSuspend(s.ds, workerPool.manualSuspendWaits(s.ds));
    // Refused before admission on both attempts: the delivery fails.
    for (let attempt = 0; attempt < 2; attempt++) {
      await s.receive(delivered, () => s.toDaemon({ type: 'turn_input_rejected', turnId: FOLLOW_UP, reason: 'busy', rejectedBeforeAdmission: true }));
    }
    await vi.waitFor(() => expect(workerPool.hasPendingOrdinaryImDelivery(s.ds)).toBe(false));
    await new Promise(resolve => setImmediate(resolve));
    expect(s.ds.worker).toBeNull();
    expect(s.ds.pendingSuspendReason).toBeUndefined();
  });

  it('warns when the current worker\'s turn origin or revocation is dropped, but not for a replaced worker', async () => {
    const s = scenario = startScenario();
    const warn = vi.spyOn(logger, 'warn');
    const dropped = () => warn.mock.calls.map(([line]) => String(line)).filter(line => line.includes('Dropped managed_turn_origin'));
    const unadmitted = 'om_never_admitted';
    await s.scope.run(s.binding, () => s.toDaemon({ type: 'managed_turn_origin', sessionId: SESSION, capability: 'unproven',
      trustedCaller: caller('ou_follow_up_sender'), identityTurnId: unadmitted, turnId: unadmitted }));
    await s.scope.run(s.binding, () => s.toDaemon({ type: 'managed_turn_origin_revoked', sessionId: SESSION, capability: 'unproven', turnId: unadmitted }));
    expect(dropped()).toEqual([
      expect.stringMatching(new RegExp(`^\\[${SESSION.slice(0, 8)}[^\\]]*\\] Dropped managed_turn_origin from current worker turn=${unadmitted} reason=execution_scope_missing$`)),
      expect.stringMatching(new RegExp(`Dropped managed_turn_origin_revoked from current worker turn=${unadmitted} reason=execution_scope_missing$`)),
    ]);
    expect(s.ds.managedTurnOrigin?.turnId).toBeUndefined();

    warn.mockClear();
    s.ds.worker = { ...s.worker, pid: 1 } as any;
    await s.scope.run(s.binding, () => s.toDaemon({ type: 'managed_turn_origin', sessionId: SESSION, capability: 'stale',
      trustedCaller: caller('ou_follow_up_sender'), identityTurnId: unadmitted, turnId: unadmitted }));
    expect(dropped()).toEqual([]);
  });
});
