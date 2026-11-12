// A semantic runtime rebind inside one live CLI (the relay resolving its real
// CLI pid, or the CLI reporting a new native session id) must not cost any
// turn its reply or its requesting user. Drives the real daemon IPC handlers,
// contract store, worker event scope, IPC send and runtime publication; the
// transcript bridge is the callback the spawn left behind, as in production.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as bots from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import { controllerForSession } from '../src/core/session-controller.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { admitSessionCommand } from '../src/services/session-command-gateway.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import { resolveDaemonCurrentActor } from '../src/core/current-actor-attestation.js';
import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { unsettledReplyHoldUntil } from '../src/core/idle-worker-sweeper.js';
import { logger } from '../src/utils/logger.js';
import { t } from '../src/i18n/index.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import type { DaemonSession } from '../src/core/types.js';

const APP = 'cli_runtime_rebind';
const SESSION = 'runtime-rebind-session';
const TURNS = ['om_turn_one', 'om_turn_two', 'om_turn_three'];
const caller = (openId: string) => ({ requestUserOpenId: openId, requestLarkAppId: APP, senderType: 'user' as const });

let dir: string;
let previousDataDir: string;
let controller: ReturnType<typeof controllerForSession>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runtime-rebind-'));
  previousDataDir = config.session.dataDir; config.session.dataDir = dir;
  workerPool.__testOnly_resetOrdinaryImDeliveries();
  vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);
  vi.spyOn(bots, 'getBot').mockReturnValue({
    config: { larkAppId: APP, larkAppSecret: 'secret', cliId: 'claude-code' },
    resolvedAllowedUsers: [], botOpenId: 'ou_bot', botName: 'RebindBot',
  } as any);
});

afterEach(() => {
  controller?.store.close(); controller = undefined;
  workerPool.__testOnly_resetOrdinaryImDeliveries();
  config.session.dataDir = previousDataDir;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

async function startWorker({ opening = true, cliPid = process.ppid, restart = false, wake = false }: { opening?: boolean; cliPid?: number; restart?: boolean; wake?: boolean } = {}) {
  const sessionReply = vi.fn(async () => 'om_reply');
  workerPool.initWorkerPool({
    sessionReply, getSessionWorkingDir: () => dir, getActiveCount: () => 1, closeSession: vi.fn(),
  } as any);
  const worker = new EventEmitter() as any;
  worker.killed = false; worker.connected = true; worker.pid = process.pid;
  worker.kill = vi.fn(); worker.stdout = new EventEmitter(); worker.stderr = new EventEmitter();
  const replyTargets = Object.fromEntries(TURNS.map(turnId => [turnId,
    { rootMessageId: turnId, senderOpenId: `ou_${turnId}`, updatedAt: new Date().toISOString() }]));
  const ds = {
    session: { sessionId: SESSION, chatId: 'oc_group', chatType: 'group', status: 'active', cliId: 'claude-code',
      createdAt: new Date().toISOString(), workerGeneration: 1, replyTargets },
    larkAppId: APP, chatId: 'oc_group', chatType: 'group', scope: 'chat',
    worker, workerGeneration: 1, workerPort: 0, workerToken: 'token',
    spawnedAt: Date.now(), cliVersion: '1', lastMessageAt: Date.now(), hasHistory: true,
  } as unknown as DaemonSession;

  // forkWorker's contract bootstrap: a cold start carries its opening turn on
  // init; a warm reattach gets every turn through ordinary IM delivery.
  controller = controllerForSession(ds, true)!;
  if (wake) {
    // A suspended session: the message that wakes it forks a worker whose CLI
    // resumes under the session's resume operation.
    const suspend = controller.beginControl('suspend').operation.operationId;
    controller.controlStarted(suspend); controller.controlResult(suspend, 'confirmed');
  }
  const resumeId = wake ? controller.prepareWorkerStart() : undefined;
  const contract = controller.bindWorker(1);
  // A resume or /restart spawns its CLI under the control operation.
  const restartId = restart ? controller.beginControl('restart').operation.operationId : resumeId;
  if (restart && restartId) controller.controlStarted(restartId);
  const openingExecution = opening ? controller.admitInput(TURNS[0]) : undefined;
  ds.initConfig = { type: 'init', sessionId: SESSION, cliId: 'claude-code', backendType: 'tmux', ...(opening ? { turnId: TURNS[0] } : {}), sessionContract: contract } as any;

  const scope = new WorkerSessionEventScope(controller.ref, contract.worker);
  const inFlight: Promise<unknown>[] = [];
  const reservations = new Map<string, (mayStart: boolean) => void>();
  const workerLog: string[] = [];
  // Behind the in-pane relay the launcher's PID is known first.
  const ws: any = {
    workerSessionEventScope: scope, sessionId: SESSION, backend: { cliPid },
    effectiveBackendType: 'tmux', codexRpcEngine: null, lastInitConfig: { cliId: 'claude-code', sessionId: SESSION },
    readProcessStartIdentity, findTraexRolloutSetByPid: () => undefined, findTraexRolloutByPid: () => undefined,
    log: (line: string) => { workerLog.push(line); },
    pendingMessages: [], pendingRawInputs: [], pendingAdoptMessages: [], cliSubmissionInFlight: null,
    submitFailureChains: { size: () => 0 }, publishedCliInputBacklog: 'false:',
    universalOutputHandoff: null, closeRequested: false, isWorkflowWorker: () => false,
    turnExecutionClock: { start: () => undefined, peek: () => undefined }, frozenTurnLinkRefMode: () => undefined,
    inputDeliveryEvidence: { start: () => undefined }, cliSpawnGeneration: 1, t,
    process: { send: (payload: unknown) => {
      inFlight.push(Promise.all(worker.listeners('message').map((listener: (value: unknown) => unknown) => listener(payload))));
    } },
  };
  for (const name of ['sessionEventMetadata', 'workerIpcPayload', 'cliInputBacklogKey', 'cliInputBacklog', 'publishCliInputBacklog',
    'send', 'observeContractNativeSession', 'publishRuntimeContract', 'runtimeIdentityForContract', 'markTurnExecutionStart']) {
    ws[name] = loadWorkerFunction(name, ws);
  }
  // The worker's process.on('message') entry: the command fence, then the
  // contract cases, run under the binding current at receipt.
  const toWorker: any[] = [];
  const onDaemonMessage = (message: any) => {
    const binding = scope.currentBinding();
    if (binding) {
      const admission = admitSessionCommand(message.type, message.sessionCommand, binding.runtime ?? binding.proposedRuntime);
      if (!admission.allowed) throw new Error(`worker rejected ${message.type}: ${admission.reason}`);
    }
    if (message.sessionCommand?.execution) scope.rememberExecution(message.sessionCommand.execution);
    const handle = () => {
      switch (message.type) {
        case 'runtime_contract_reserved': {
          const current = scope.currentBinding();
          if (current?.bindingId === message.bindingId) current.proposedRuntime = message.runtime;
          reservations.get(message.bindingId)?.(message.mayStart);
          break;
        }
        case 'execution_contract_assigned': {
          const current = scope.currentBinding();
          if (current?.bindingId === message.bindingId) scope.rememberExecution(message.execution, current);
          break;
        }
        case 'runtime_contract_assigned': {
          scope.assign(message.bindingId, message.runtime);
          for (const state of message.admissionStates ?? []) scope.noteAdmission(state);
          for (const execution of message.executions ?? []) scope.rememberExecution(execution);
          for (const observed of message.observedExecutions ?? []) scope.rememberObservedExecution(message.bindingId, observed.runtime, observed.execution);
          // The worker stops reading its transcript once the daemon retires its runtime.
          if (!message.mayExecute) ws.closeRequested = true;
          break;
        }
      }
    };
    return binding ? scope.run(binding, handle, message.sessionCommand?.execution, message.sessionCommand?.operationId) : handle();
  };
  worker.send = vi.fn((message: any, callback?: (error: Error | null) => void) => {
    toWorker.push(message); onDaemonMessage(message); callback?.(null); return true;
  });
  workerPool.__testOnly_setupWorkerHandlers(ds, worker, undefined, 1);
  const drain = async () => { while (inFlight.length) await Promise.all(inFlight.splice(0)); };
  const toDaemon = async (message: any) => { ws.send(message); await drain(); };

  // spawnCli: a fresh binding carrying the opening execution, reserved, then
  // published once the CLI is up. Everything the spawn starts -- the transcript
  // bridge among them -- keeps this async context for the CLI's lifetime.
  const spawnCli = async (execution?: typeof openingExecution, operationId?: string) => {
    const binding = scope.beginRuntime(operationId);
    if (execution) scope.rememberExecution(execution, binding);
    let observer!: (message: any) => Promise<void>;
    await scope.run(binding, async () => {
      const reserved = new Promise<boolean>(resolve => reservations.set(binding.bindingId, resolve));
      ws.send({ type: 'runtime_binding_started', bindingId: binding.bindingId, ...(operationId ? { operationId } : {}) });
      await drain();
      expect(await reserved).toBe(true);
      await ws.publishRuntimeContract(binding);
      await drain();
      observer = scope.bind(async (message: any) => { ws.send(message); await drain(); });
    }, execution);
    expect(binding.runtime).toBeDefined();
    return { binding, observer };
  };
  const { binding, observer: bridge } = await spawnCli(openingExecution, restartId);
  await bridge({ type: 'ready', port: 0, token: 'token' });
  await bridge({ type: 'prompt_ready' });
  // The worker reports the operation done at the CLI's first prompt.
  if (restartId) controller.controlResult(restartId, 'confirmed', binding.runtime);

  // flushPending for one turn: enter it, publish its authority, write it.
  let capabilitySequence = 0;
  const writeTurn = (turnId: string) => {
    scope.enterTurn(turnId);
    const capability = `capability-${++capabilitySequence}`;
    ws.send({ type: 'managed_turn_origin', sessionId: SESSION, capability, policyCapability: 'policy',
      trustedCaller: caller(`ou_${turnId}`), identityTurnId: turnId, turnId });
    ws.markTurnExecutionStart(turnId);
    ws.send({ type: 'turn_input_committed', turnId });
    return capability;
  };
  // A follow-up arrives through the daemon's ordinary IM delivery and is
  // written from the worker's message handler.
  const deliver = async (turnId: string) => {
    expect(workerPool.sendWorkerInput(ds, `question ${turnId}`, turnId, { trustedCaller: caller(`ou_${turnId}`) })).toBe(true);
    const delivered = toWorker.find(message => message.type === 'message' && message.turnId === turnId);
    expect(delivered?.sessionCommand?.execution).toMatchObject({ turnId });
    const capability = scope.run(scope.currentBinding()!, () => {
      ws.send({ type: 'turn_input_received', turnId });
      return writeTurn(turnId);
    }, delivered.sessionCommand.execution);
    await drain();
    return capability;
  };
  // The bridge settles the turn: the answer, then the terminal edge and the
  // authority revocation.
  const answer = async (turnId: string, capability: string, observer = bridge) => {
    await observer({ type: 'final_output', content: `answer for ${turnId}`, lastUuid: `uuid-${turnId}`, turnId });
    await observer({ type: 'managed_turn_origin_revoked', sessionId: SESSION, capability, turnId });
    await observer({ type: 'turn_terminal', sessionId: SESSION, turnId, status: 'completed' });
    await observer({ type: 'prompt_ready' });
  };
  const replies = () => sessionReply.mock.calls.map(([, content]) => String(content));
  return { controller, ds, ws, scope, binding, bridge, toWorker, workerLog, replies, spawnCli,
    writeOpeningTurn: () => scope.run(binding, async () => { const c = writeTurn(TURNS[0]); await drain(); return c; }, openingExecution),
    deliver, answer,
    // The relay timer rewires the ownership PID and re-attests it at once; the
    // CLI reports its session id later.
    relayResolvesRealCli: async () => {
      ws.backend = { cliPid: process.pid };
      await bridge({ type: 'local_process_attestation', backendType: 'tmux', credentialIsolated: false,
        cliPid: process.pid, cliProcStart: readProcessStartIdentity(process.pid) });
    },
    publishNativeSession: (nativeSessionId: string) => bridge({ type: 'cli_session_id', cliSessionId: nativeSessionId }),
    /** Worker code a callback the spawn started runs (the flush typing the
     *  opening turn, the transcript bridge). */
    inSpawnContext: (work: () => void) => scope.run(binding, async () => { work(); await drain(); }, openingExecution),
    /** A live screen callback: it runs under the binding current at the time. */
    inCurrentBinding: (work: () => void) => scope.run(scope.currentBinding()!, async () => { work(); await drain(); }) };
}

const answers = (...turnIds: string[]) => turnIds.map(turnId => expect.stringContaining(`answer for ${turnId}`));
const lostTurnWarnings = (warn: ReturnType<typeof vi.spyOn>) => warn.mock.calls.map(([line]) => String(line))
  .filter(line => /Dropped managed_turn_origin|not delivered|Worker user_notify/.test(line));

describe('turns around a semantic runtime rebind', () => {
  it('delivers both turns of a cold resume whose relay resolves the real CLI mid-turn', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const s = await startWorker();
    const first = await s.writeOpeningTurn();
    expect(s.ds.managedTurnOrigin).toMatchObject({ turnId: TURNS[0], callerOpenId: `ou_${TURNS[0]}` });

    await s.relayResolvesRealCli();
    await s.publishNativeSession('native-resumed');
    expect(s.scope.currentBinding()).not.toBe(s.binding);
    await s.answer(TURNS[0], first);
    expect(s.ds.managedTurnOrigin?.turnId).toBeUndefined();

    const second = await s.deliver(TURNS[1]);
    expect(s.ds.managedTurnOrigin).toMatchObject({ turnId: TURNS[1], callerOpenId: `ou_${TURNS[1]}` });
    await s.answer(TURNS[1], second);

    await vi.waitFor(() => expect(s.replies()).toEqual(answers(TURNS[0], TURNS[1])));
    expect(s.ds.managedTurnOrigin?.turnId).toBeUndefined();
    expect(lostTurnWarnings(warn)).toEqual([]);
  });

  it('delivers both turns after the resumed CLI reports a new native session id mid-turn', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const s = await startWorker({ cliPid: process.pid });
    await s.publishNativeSession('native-resume-target');
    expect(s.scope.currentBinding()).toBe(s.binding);
    const first = await s.writeOpeningTurn();

    await s.publishNativeSession('native-forked-by-resume');
    expect(s.scope.currentBinding()).not.toBe(s.binding);
    expect(s.controller.store.runtime(s.controller.ref)?.identity).toMatchObject({ nativeSessionId: 'native-forked-by-resume' });
    await s.answer(TURNS[0], first);

    const second = await s.deliver(TURNS[1]);
    expect(s.ds.managedTurnOrigin).toMatchObject({ turnId: TURNS[1], callerOpenId: `ou_${TURNS[1]}` });
    await s.answer(TURNS[1], second);

    await vi.waitFor(() => expect(s.replies()).toEqual(answers(TURNS[0], TURNS[1])));
    expect(lostTurnWarnings(warn)).toEqual([]);
  });

  it('delivers every follow-up of a warm session whose relay resolves the real CLI', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const s = await startWorker({ opening: false });
    const first = await s.deliver(TURNS[0]);
    await s.relayResolvesRealCli();
    await s.publishNativeSession('native-warm');
    await s.answer(TURNS[0], first);

    for (const turnId of TURNS.slice(1)) {
      const capability = await s.deliver(turnId);
      expect(s.ds.managedTurnOrigin).toMatchObject({ turnId, callerOpenId: `ou_${turnId}` });
      await s.answer(turnId, capability);
    }

    await vi.waitFor(() => expect(s.replies()).toEqual(answers(...TURNS)));
    expect(lostTurnWarnings(warn)).toEqual([]);
  });

  it.skipIf(process.platform !== 'linux')('serves the follow-up sender to actor current after the rebind', async () => {
    const s = await startWorker();
    const first = await s.writeOpeningTurn();
    await s.relayResolvesRealCli();
    await s.publishNativeSession('native-resumed');
    await s.answer(TURNS[0], first);
    const second = await s.deliver(TURNS[1]);

    const actor = await resolveDaemonCurrentActor({
      sessionId: SESSION, peer: { pid: process.pid, procStart: readProcessStartIdentity(process.pid)! },
      findSession: id => id === SESSION ? s.ds : undefined,
      resolveIdentity: async (_appId, openId) => ({ openId, type: 'user', email: `${openId}@example.test` }) as any,
    });
    expect(actor).toMatchObject({ ok: true, document: { status: 'verified', turnId: TURNS[1], actor: { email: `ou_${TURNS[1]}@example.test` } } });
    await s.answer(TURNS[1], second);
    await vi.waitFor(() => expect(s.replies()).toEqual(answers(TURNS[0], TURNS[1])));
  });

  // Stop and SessionStart hooks report the binding their CLI was spawned under.
  it('aims the spawn-time hooks of the live CLI at its current runtime', async () => {
    const s = await startWorker();
    await s.writeOpeningTurn();
    await s.relayResolvesRealCli();
    await s.publishNativeSession('native-resumed');
    const second = await s.deliver(TURNS[1]);
    const current = s.scope.currentBinding()!.runtime;

    for (const turnId of [TURNS[0], TURNS[1]]) {
      const stop = s.controller.nativeSignal(s.binding.bindingId, 'native-resumed', turnId);
      expect(stop).toMatchObject({ runtime: current, execution: { turnId } });
      expect(admitSessionCommand('turn_idle', stop, current)).toEqual({ allowed: true });
    }
    const ready = s.controller.nativeSignal(s.binding.bindingId, 'native-resumed');
    expect(ready).toMatchObject({ runtime: current });
    expect(admitSessionCommand('session_ready', ready, current)).toEqual({ allowed: true });
    await s.answer(TURNS[1], second);
    await vi.waitFor(() => expect(s.replies()).toEqual(answers(TURNS[1])));
  });

  it('keeps a resumed CLI running when the relay resolves it after the resume was confirmed', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const s = await startWorker({ opening: false, restart: true });
    expect(s.controller.allowsInput()).toBe(true);
    const first = await s.deliver(TURNS[0]);
    await s.relayResolvesRealCli();
    await s.publishNativeSession('native-resumed');

    const rebound = s.scope.currentBinding()!;
    expect(rebound).not.toBe(s.binding);
    expect(s.toWorker.filter(message => message.type === 'runtime_contract_assigned').at(-1))
      .toMatchObject({ bindingId: rebound.bindingId, mayExecute: true });
    expect(s.controller.currentRuntime()).toEqual(rebound.runtime);
    await s.answer(TURNS[0], first);
    const second = await s.deliver(TURNS[1]);
    await s.answer(TURNS[1], second);

    await vi.waitFor(() => expect(s.replies()).toEqual(answers(TURNS[0], TURNS[1])));
    expect(lostTurnWarnings(warn)).toEqual([]);
  });

  // A message wakes a suspended session; the resume is confirmed at the CLI's
  // first prompt (the ready gate's timeout fallback), and the resumed Claude
  // shows its native session id only once the waking message is written. The
  // relay had already resolved the real CLI, so the live runtime only adds that
  // id to its identity.
  it('answers the waking message when the woken CLI reports its native session after the resume was confirmed', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const s = await startWorker({ wake: true, cliPid: process.pid });
    expect(s.controller.allowsInput()).toBe(true);
    const first = await s.writeOpeningTurn();
    await s.publishNativeSession('native-woken');

    expect(s.scope.currentBinding()).toBe(s.binding);
    expect(s.toWorker.filter(message => message.type === 'runtime_contract_assigned').at(-1))
      .toMatchObject({ bindingId: s.binding.bindingId, mayExecute: true });
    expect(s.controller.currentRuntime()).toEqual(s.binding.runtime);
    const live = s.controller.store.runtime(s.controller.ref);
    expect(live).toMatchObject({ identity: { nativeSessionId: 'native-woken' } });
    expect(live?.phase).not.toBe('retiring');
    await s.answer(TURNS[0], first);
    await vi.waitFor(() => expect(s.replies()).toEqual(answers(TURNS[0])));

    const second = await s.deliver(TURNS[1]);
    expect(s.ds.managedTurnOrigin).toMatchObject({ turnId: TURNS[1], callerOpenId: `ou_${TURNS[1]}` });
    await s.answer(TURNS[1], second);
    await vi.waitFor(() => expect(s.replies()).toEqual(answers(TURNS[0], TURNS[1])));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(s.replies()).toHaveLength(2);
    expect(s.workerLog).not.toContainEqual(expect.stringContaining('Dropped final_output after close fence'));
    expect(lostTurnWarnings(warn)).toEqual([]);
  });

  // The pane's exit callback keeps the binding the CLI was spawned under.
  it('takes the idle exit of the relay-resolved CLI as the current runtime\'s exit', async () => {
    const s = await startWorker();
    const first = await s.writeOpeningTurn();
    await s.relayResolvesRealCli();
    await s.publishNativeSession('native-resumed');
    await s.answer(TURNS[0], first);
    await vi.waitFor(() => expect(s.replies()).toEqual(answers(TURNS[0])));
    expect(s.scope.currentBinding()).not.toBe(s.binding);
    const current = s.scope.currentBinding()!.runtime!;
    s.ds.cliReady = true;

    await s.bridge({ type: 'claude_exit', code: 0, signal: null });
    expect(s.controller.store.runtime(s.controller.ref, current.runtimeId)?.phase).toBe('stopped');
    expect(s.ds.cliReady).toBe(false);
  });

  // Scheduled tasks and background wakes start turns nobody submitted.
  it('delivers a turn the CLI starts on its own after the rebind', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const s = await startWorker();
    const first = await s.writeOpeningTurn();
    const selfStarted = async (turnId: string) => {
      await s.bridge({ type: 'final_output', content: `answer for ${turnId}`, lastUuid: `uuid-${turnId}`, turnId });
      await s.bridge({ type: 'turn_terminal', sessionId: SESSION, turnId, status: 'completed' });
    };
    await s.answer(TURNS[0], first);
    await selfStarted('local-wake-before');
    await s.relayResolvesRealCli();
    await s.publishNativeSession('native-resumed');
    await selfStarted('local-wake-after');

    await vi.waitFor(() => expect(s.replies()).toEqual(answers(TURNS[0], 'local-wake-before', 'local-wake-after')));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(s.replies()).toHaveLength(3);
    expect(lostTurnWarnings(warn)).toEqual([]);
  });
});

describe('the CLI input queue around a semantic runtime rebind', () => {
  let ipc: IpcServerHandle | undefined;
  beforeEach(() => { workerPool.__testOnly_setSuspendBackingVerifier(() => true); });
  afterEach(async () => {
    await ipc?.close(); ipc = undefined;
    workerPool.__testOnly_setSuspendBackingVerifier();
  });
  const postSuspend = async (): Promise<unknown> => {
    ipc ??= await startIpcServer({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`http://127.0.0.1:${ipc.port}/api/sessions/${SESSION}/suspend`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    return res.json();
  };

  // Production (2026-11-11): a message woke a dormant Claude session. The
  // write of that message, its settlement and the transcript bridge kept the
  // binding the spawn started them under; Claude's native session id, shown
  // after the write, re-bound the runtime to the real CLI pid. The worker's
  // "queue drained" report then carried the replaced runtime and was dropped,
  // while its "writing the waking message" report had been admitted, and the
  // worker reports a backlog only when it changes. A minute after the reply
  // was out, the screen idle, `botmux suspend` answered "queued" and the
  // suspend only ran when the next turn ended, twelve minutes later.
  it('lets botmux suspend take the idle session at once after the write settled under the replaced binding', async () => {
    const s = await startWorker();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => (id === SESSION ? s.ds : undefined));
    // The flush starts typing the waking message: the CLI has not taken it yet.
    s.ws.cliSubmissionInFlight = { item: { turnId: TURNS[0] }, generation: 1 };
    const first = await s.writeOpeningTurn();
    expect(workerPool.hasUnacceptedCliInput(s.ds)).toBe(true);

    await s.relayResolvesRealCli();
    await s.publishNativeSession('native-resumed');
    expect(s.scope.currentBinding()).not.toBe(s.binding);

    // The write settles in the flush that started it: the queue is drained.
    await s.inSpawnContext(() => { s.ws.cliSubmissionInFlight = null; s.ws.publishCliInputBacklog(); });
    await s.answer(TURNS[0], first);
    await vi.waitFor(() => expect(s.replies()).toEqual(answers(TURNS[0])));
    await vi.waitFor(() => expect(unsettledReplyHoldUntil(s.ds)).toBeUndefined());
    await s.inCurrentBinding(() => s.ws.send({ type: 'screen_update', status: 'idle', content: '' }));
    expect(s.ds.lastScreenStatus).toBe('idle');

    expect(workerPool.hasUnacceptedCliInput(s.ds)).toBe(false);
    expect(await postSuspend()).toEqual({ ok: true, sessionId: SESSION, suspended: true });
    expect(s.ds.worker).toBeNull();
    expect(s.ds.pendingSuspendReason).toBeUndefined();
  });

  // The turn that was running when the runtime moved keeps reporting under the
  // runtime it was submitted on. Its `working` frames must still reach the
  // daemon: they are what keeps a suspend from cutting the turn off before
  // its reply is out.
  it('queues botmux suspend behind the turn that was running when the runtime moved, and its reply goes out', async () => {
    const s = await startWorker();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => (id === SESSION ? s.ds : undefined));
    s.ws.cliSubmissionInFlight = { item: { turnId: TURNS[0] }, generation: 1 };
    const first = await s.writeOpeningTurn();
    await s.relayResolvesRealCli();
    await s.publishNativeSession('native-resumed');
    // The write settles: the CLI took the turn and is working on it.
    await s.inSpawnContext(() => {
      s.ws.send({ type: 'screen_update', status: 'working', content: '', turnId: TURNS[0] });
      s.ws.cliSubmissionInFlight = null; s.ws.publishCliInputBacklog();
    });
    await s.inCurrentBinding(() => s.ws.send({ type: 'screen_update', status: 'working', content: 'spinner', turnId: TURNS[0] }));
    expect(s.ds.lastScreenStatus).toBe('working');

    const body = await postSuspend() as { suspended: boolean; reason: string; waitingFor: string[] };
    expect(body).toMatchObject({ suspended: false, reason: 'deferred' });
    expect(body.waitingFor).toContain('turn');
    expect(s.ds.worker).not.toBeNull();

    await s.answer(TURNS[0], first);
    await s.inCurrentBinding(() => s.ws.send({ type: 'screen_update', status: 'idle', content: '' }));
    await vi.waitFor(() => expect(s.ds.worker).toBeNull());
    expect(s.replies()).toEqual(answers(TURNS[0]));
  });

  it('keeps a message the CLI has not taken protected across the rebind', async () => {
    const s = await startWorker();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(id => (id === SESSION ? s.ds : undefined));
    const first = await s.writeOpeningTurn();
    await s.relayResolvesRealCli();
    await s.publishNativeSession('native-resumed');
    await s.answer(TURNS[0], first);
    await vi.waitFor(() => expect(unsettledReplyHoldUntil(s.ds)).toBeUndefined());
    await s.inCurrentBinding(() => s.ws.send({ type: 'screen_update', status: 'idle', content: '' }));

    const worker = s.ds.worker;
    // A follow-up waits in the worker's queue; the spawn-era flush reports it.
    await s.inSpawnContext(() => { s.ws.pendingMessages.push({ turnId: TURNS[1], content: 'queued' }); s.ws.publishCliInputBacklog(); });
    expect(workerPool.hasUnacceptedCliInput(s.ds)).toBe(true);
    expect(await postSuspend()).toEqual({
      ok: true, sessionId: SESSION, suspended: false, reason: 'deferred', waitingFor: ['input'],
    });
    expect(s.ds.worker).toBe(worker);
    expect(s.ds.pendingSuspendReason).toBe('manual_suspend');
    // An idle edge before the CLI took it does not cash the suspend in.
    await s.inCurrentBinding(() => s.ws.send({ type: 'screen_update', status: 'idle', content: '' }));
    await new Promise(resolve => setImmediate(resolve));
    expect(s.ds.worker).toBe(worker);

    // The CLI takes it: the queued suspend is cashed in on that report.
    await s.inSpawnContext(() => { s.ws.pendingMessages.length = 0; s.ws.publishCliInputBacklog(); });
    await vi.waitFor(() => expect(s.ds.worker).toBeNull());
    expect(s.ds.pendingSuspendReason).toBeUndefined();
  });
});

describe('identity the live runtime of a woken session reports', () => {
  function wokenSession() {
    const ds = {
      session: { sessionId: SESSION, chatId: 'oc_group', chatType: 'group', status: 'active', cliId: 'claude-code',
        createdAt: new Date().toISOString(), workerGeneration: 1 },
      larkAppId: APP, chatId: 'oc_group', chatType: 'group', scope: 'chat', workerGeneration: 1,
    } as unknown as DaemonSession;
    controller = controllerForSession(ds, true)!;
    const suspend = controller.beginControl('suspend').operation.operationId;
    controller.controlStarted(suspend); controller.controlResult(suspend, 'confirmed');
    const resume = controller.prepareWorkerStart()!;
    const { worker } = controller.bindWorker(1);
    controller.reserveBinding('spawned', worker);
    const identity = { backend: 'tmux', physicalId: '4242:1', proof: 'process_start' } as const;
    controller.bindRuntime('spawned', worker, identity, resume);
    const report = () => controller.bindRuntime('spawned', worker, { ...identity, nativeSessionId: 'native-woken' }, resume);
    return { resume, report };
  }

  it('is recorded under the resume while the resume is still open', () => {
    const { resume, report } = wokenSession();
    expect(report().phase).not.toBe('retiring');
    expect(controller.operation(resume)?.phase).not.toBe('confirmed');
    expect(controller.store.runtime(controller.ref)?.identity?.nativeSessionId).toBe('native-woken');
  });

  it('does not keep a runtime the failed resume left behind', () => {
    const { resume, report } = wokenSession();
    controller.controlResult(resume, 'rejected');
    expect(report().phase).toBe('retiring');
  });
});

describe('callbacks of the live CLI after a semantic rebind', () => {
  it('stay current for the same physical CLI and lose authority after a respawn', () => {
    const scope = new WorkerSessionEventScope({ appId: APP, sessionId: SESSION }, { workerId: 'worker', generation: 1 });
    const spawned = scope.beginRuntime(); scope.assign(spawned.bindingId, { runtimeId: 'runtime-1', epoch: 1 });
    const rebound = scope.beginRuntime(undefined, spawned.physicalId); scope.assign(rebound.bindingId, { runtimeId: 'runtime-2', epoch: 2 });
    expect(scope.run(spawned, () => scope.isCurrentContext())).toBe(true);
    const respawned = scope.beginRuntime(); scope.assign(respawned.bindingId, { runtimeId: 'runtime-3', epoch: 3 });
    expect(scope.run(spawned, () => scope.isCurrentContext())).toBe(false);
    expect(scope.run(rebound, () => scope.isCurrentContext())).toBe(false);
  });
});

describe('replies that genuinely cannot be posted', () => {
  // A respawn is a different physical CLI: the old one's observers keep no
  // authority over the turns that remain.
  async function respawnMidTurn() {
    const s = await startWorker();
    const first = await s.writeOpeningTurn();
    await s.relayResolvesRealCli();
    const replacement = await s.spawnCli();
    expect(replacement.binding.physicalId).not.toBe(s.binding.physicalId);
    return { s, first, replacement };
  }

  it('warns and tells the group when the daemon refuses the live worker\'s final', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const { s, first } = await respawnMidTurn();
    await s.answer(TURNS[0], first);

    await vi.waitFor(() => expect(s.replies()).toEqual([expect.stringContaining('⚠️')]));
    expect(s.replies()[0]).not.toContain(`answer for ${TURNS[0]}`);
    expect(warn.mock.calls.map(([line]) => String(line))).toContainEqual(
      expect.stringMatching(new RegExp(`Final output from current worker not delivered turn=${TURNS[0]}`)));
    await s.answer(TURNS[0], first);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(s.replies()).toHaveLength(1);
  });

  it('keeps the group quiet while a restart retires the in-flight reply', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const { s, first } = await respawnMidTurn();
    s.controller.beginControl('restart');
    await s.answer(TURNS[0], first);

    await vi.waitFor(() => expect(warn.mock.calls.map(([line]) => String(line))).toContainEqual(
      expect.stringMatching(new RegExp(`Final output from current worker not delivered turn=${TURNS[0]}`))));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(s.replies()).toEqual([]);
  });

  // A replaced CLI's observer drops its copy; the live CLI's observer posts it.
  it('lets only the live CLI answer a turn written after a respawn', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const { s, replacement } = await respawnMidTurn();
    const second = await s.deliver(TURNS[1]);
    await s.answer(TURNS[1], second);

    expect(s.workerLog).toContainEqual(expect.stringContaining('Dropped final output with unproven execution origin'));
    await s.answer(TURNS[1], second, replacement.observer);
    await vi.waitFor(() => expect(s.replies()).toEqual(answers(TURNS[1])));
    expect(warn.mock.calls.map(([line]) => String(line))).not.toContainEqual(expect.stringContaining('Worker user_notify'));
  });
});
