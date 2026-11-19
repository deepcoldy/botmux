/**
 * A turn that is executing when the daemon restarts keeps running in its CLI.
 * Its proven identity material lived only in the old daemon's memory, so the
 * re-attached worker's tools were refused with `identity_material_unavailable`
 * for the rest of the turn. The new daemon restores that material once the
 * re-attached worker republishes the turn's origin and the session contract
 * proves the turn is still open on that runtime.
 *
 * Real worker publication (send / sessionEventMetadata /
 * publishSandboxRelayCapability / handleContractDaemonMessage) against the
 * real daemon handlers (handleWorkerMessage / handleLegacyWorkerMessage) and
 * the daemon's restore entry, over a contract store reopened as a restarted
 * daemon would.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveTurnAuthority, sameTrustedPrincipal } from '../src/core/active-turn-authority.js';
import { recallProvenIdentityContent, rememberProvenIdentityContent } from '../src/core/cli-identity.js';
import { isHumanInboundTurnId, pickTurnReplyTarget } from '../src/core/reply-target.js';
import { prepareScheduledRecoveryRun } from '../src/core/scheduled-send.js';
import { parseScheduledTurnId } from '../src/core/scheduled-turn-provenance.js';
import { SessionController } from '../src/core/session-controller.js';
import { trackTurnIdentityPublication } from '../src/core/turn-cli-identity.js';
import { identityDecisionTurnIsLive } from '../src/core/worker-pool.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { sameWorker, type WorkerRef } from '../src/services/session-contract.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';

const directories: string[] = [];
const handles: Array<{ close(): void }> = [];
afterEach(() => {
  for (const handle of handles.splice(0)) try { handle.close(); } catch { /* already closed */ }
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const daemonSource = ts.createSourceFile('daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const daemonFunctions = ['prepareTurnCliIdentity', 'restoreTurnCliIdentity'].map(name => {
  const node = daemonSource.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!node) throw new Error(`Missing daemon function: ${name}`);
  return ts.transpileModule(node.getText(daemonSource), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}).join('\n');

const appId = 'cli_restart_identity';
const sessionId = 'session-restart-identity';
const person = 'ou_trigger_person';
const scheduleRunAs = 'ou_schedule_run_as';
const interactiveTurn = 'om_in_flight_turn';
const scheduledTurn = 'schedule:daily_report:720d6b52-3df7-4343-9d76-9597688e8cb3';
const cli = { backend: 'tmux', physicalId: '222:cliStart', nativeSessionId: '703fc6a9-0000-4000-8000-000000000001', proof: 'process_start' as const };

function bytedcliBody(openId: string): string {
  return `BOTMUX_IDENTITY_OPEN_ID='${openId}'`;
}

/** Daemon 1 runs `turnId` on the CLI and dies (optionally after the turn ended);
 *  daemon 2 reopens the same contract store and re-attaches the surviving CLI. */
function restartedWorld(turnId: string, opts: { endedBeforeRestart?: boolean } = {}) {
  const data = mkdtempSync(join(tmpdir(), 'restart-turn-identity-')); directories.push(data);
  const ref = { appId, sessionId };
  const persistedSession = { sessionId, larkAppId: appId, chatId: 'oc_chat', status: 'active',
    replyTargets: { [interactiveTurn]: { senderOpenId: person } } };

  const store1 = new SessionContractStore(data, appId);
  const controller1 = new SessionController({ larkAppId: appId, chatId: 'oc_chat', session: structuredClone(persistedSession) } as any, store1);
  const worker1 = controller1.bindWorker(1).worker;
  const runtime1 = controller1.reserveBinding('w1-cli', worker1);
  controller1.bindRuntime('w1-cli', worker1, cli);
  const execution = controller1.admitInput(turnId);
  const event = (type: string, sequence: number, extra: Record<string, unknown> = {}) => ({ type, turnId, ...extra,
    sessionContract: { version: 2, session: ref, producer: worker1, bindingId: 'w1-cli', eventId: `${worker1.workerId}:${sequence}`,
      sequence, scope: { runtime: runtime1, execution } } }) as any;
  expect(controller1.ingest(event('turn_execution_started', 1), worker1)).toMatchObject({ kind: 'current' });
  if (opts.endedBeforeRestart) {
    expect(controller1.ingest(event('turn_terminal', 2, { sessionId, status: 'completed' }), worker1)).toMatchObject({ kind: 'current' });
  }
  store1.close();

  const store = new SessionContractStore(data, appId); handles.push(store);
  const ds: any = { larkAppId: appId, chatId: 'oc_chat', session: structuredClone(persistedSession),
    reportedIdentityModel: { model: 'proven', sandboxEngaged: false, loopbackShared: true, workerPid: 90, workerGeneration: 2, reportedAt: 0 } };
  const controller = new SessionController(ds, store);
  const worker2 = controller.bindWorker(2).worker;

  const daemon: Record<string, any> = {
    config: { session: { dataDir: data } },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    triggerUserAuthEnabledFor: () => true,
    identityStorageModelForDaemonSession: (session: any) => session.reportedIdentityModel?.model ?? 'single',
    parseScheduledTurnId, isHumanInboundTurnId, identityDecisionTurnIsLive, trackTurnIdentityPublication, prepareScheduledRecoveryRun,
    scheduleAuthorityStore: { getRecord: () => undefined },
    scheduler: { admitManualRunTurn: () => false },
    sessionStore: { updateSession: vi.fn() },
    refreshTurnCliIdentity: vi.fn(async (session: any, id: string) => {
      const sender = pickTurnReplyTarget(session.session, id)?.senderOpenId;
      if (sender) rememberProvenIdentityContent(data, sessionId, id, 'bytedcli', bytedcliBody(sender));
      session.lastPublishedIdentityModel = 'proven';
    }),
    prepareScheduledTurnCliIdentity: vi.fn(async (session: any, id: string) => {
      rememberProvenIdentityContent(data, sessionId, id, 'bytedcli', bytedcliBody(scheduleRunAs));
      session.lastPublishedIdentityModel = 'proven';
    }),
  };
  const { restoreTurnCliIdentity } = new Function('deps',
    `with (deps) { ${daemonFunctions}; return { prepareTurnCliIdentity, restoreTurnCliIdentity }; }`)(daemon);
  const restores: Promise<void>[] = [];

  const toWorker: any[] = [];
  const daemonWorker: any = { pid: 90, connected: true, killed: false,
    send: (message: any, callback?: (error: null) => void) => { toWorker.push(message); callback?.(null); return true; } };
  ds.worker = daemonWorker;
  const hostEnv: any = { ds, worker: daemonWorker, sessionController: controller, contractWorker: worker2, botCfg: {},
    sessionCliId: () => 'claude-code', logger: daemon.logger, t: 'restart-identity', sameWorker, sameTrustedPrincipal,
    currentGatewayCallerOpenId: () => undefined, currentTurnProcessIdentities: () => ['222:cliStart'],
    noteTurnDispatchAttempt: vi.fn(), ensureAutomaticTaskContinuationLease: vi.fn(),
    cb: { onManagedTurnOrigin: (session: any, id: string) => { restores.push(restoreTurnCliIdentity(session, id)); } } };
  hostEnv.handleLegacyWorkerMessage = loadWorkerPoolClosure('handleLegacyWorkerMessage', hostEnv);
  const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', hostEnv);
  hostEnv.handleWorkerMessage = host;

  const pending: Promise<void>[] = [];
  const drain = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
    await Promise.all(restores.splice(0));
  };
  /** The successor worker, holding the turn it took back from the CLI PID marker. */
  const reattachedWorker = (producer: WorkerRef, markerTurnId: string, deliver: (message: any) => Promise<void>) => {
    const scope = new WorkerSessionEventScope(ref, producer);
    const authority = new ActiveTurnAuthority();
    const caller = turnId === interactiveTurn
      ? { requestLarkAppId: appId, requestUserOpenId: person, senderType: 'user' as const } : undefined;
    authority.reserve({ turnId: markerTurnId, ...(caller ? { caller } : {}) });
    authority.markStarted({ turnId: markerTurnId, ...(caller ? { caller } : {}) });
    const wire: any[] = [];
    const env: Record<string, any> = {
      workerSessionEventScope: scope, activeTurnAuthority: authority, sessionId, lastInitConfig: { cliId: 'claude-code' },
      currentBotmuxTurnId: markerTurnId, currentBotmuxDispatchAttempt: undefined, retiredTurnIds: new Set<string>(),
      sandboxRelayCapability: { token: 'cap-from-marker', turnId: markerTurnId }, publishedOriginContractScope: undefined,
      writeCliPidMarker: vi.fn(), parseDaemonIpcPort: () => 7956, randomBytes, frozenTurnLinkRefMode: () => undefined,
      isWorkflowWorker: () => false, pendingRuntimeReservations: new Map(), pendingMessages: [], closeRequested: false,
      backend: null, retiredRuntimeBackend: null, restoredObserverGrantWait: { decide: () => false },
      codexBridgeDrainAndMaybeEmit: () => {}, log: () => {}, flushPending: async () => {},
      clearTraexContinuationGrantWait: () => {}, abandonTraexAutoModelContinuation: () => {},
      stopBridgeWatcher: () => {}, stopScreenshotLoop: () => {}, killCli: () => {}, armRetiredRuntimeExit: () => {},
      process: { env: {}, send: (message: any) => { wire.push(message); pending.push(deliver(message)); } },
    };
    for (const name of ['workerIpcPayload', 'send', 'publishSandboxRelayCapability']) env[name] = loadWorkerFunction(name, env);
    const handleContract = loadWorkerFunction<(raw: unknown) => Promise<void>>('handleContractDaemonMessage', env);
    /** Bind the surviving CLI and apply the daemon's runtime assignment. */
    const reattach = async () => {
      const binding = scope.beginRuntime(undefined, 'pane-1');
      binding.identity = cli as any;
      await scope.run(binding, async () => {
        env.send({ type: 'runtime_binding_started', bindingId: binding.bindingId }); await drain();
        env.send({ type: 'runtime_binding', bindingId: binding.bindingId, identity: cli }); await drain();
      });
      const assigned = toWorker.filter(message => message.type === 'runtime_contract_assigned' && message.bindingId === binding.bindingId).at(-1);
      expect(assigned).toBeDefined();
      await handleContract(assigned); await drain();
      return { binding, assigned };
    };
    return { env, scope, wire, reattach };
  };
  const successor = reattachedWorker(worker2, turnId, host);
  const material = (id: string) => recallProvenIdentityContent(data, sessionId, id, 'bytedcli');
  return { ds, store, controller, execution, runtime1, worker2, daemon, host, drain, successor, reattachedWorker, material };
}

describe('a turn executing across a daemon restart regains its identity on re-attach', () => {
  it('restores the trigger person of an in-flight interactive turn', async () => {
    const w = restartedWorld(interactiveTurn);
    expect(w.material(interactiveTurn)).toBeUndefined();
    await w.successor.reattach();
    expect(w.successor.wire.filter(message => message.type === 'managed_turn_origin')).toHaveLength(1);
    expect(w.ds.managedTurnOrigin).toMatchObject({ turnId: interactiveTurn, callerOpenId: person });
    expect(w.daemon.refreshTurnCliIdentity).toHaveBeenCalledTimes(1);
    expect(w.daemon.refreshTurnCliIdentity).toHaveBeenCalledWith(w.ds, interactiveTurn);
    expect(w.daemon.prepareScheduledTurnCliIdentity).not.toHaveBeenCalled();
    expect(w.material(interactiveTurn)).toBe(bytedcliBody(person));

    // A later rotation of the same turn's capability finds the daemon's own publication and does not prepare again.
    w.successor.scope.run(w.successor.scope.currentBinding()!, () => w.successor.env.publishSandboxRelayCapability(), w.execution);
    await w.drain();
    expect(w.successor.wire.filter(message => message.type === 'managed_turn_origin')).toHaveLength(2);
    expect(w.daemon.refreshTurnCliIdentity).toHaveBeenCalledTimes(1);
  });

  it('restores the run identity of an in-flight scheduled turn from its schedule authority entry', async () => {
    const w = restartedWorld(scheduledTurn);
    await w.successor.reattach();
    expect(w.ds.managedTurnOrigin).toMatchObject({ turnId: scheduledTurn });
    expect(w.daemon.prepareScheduledTurnCliIdentity).toHaveBeenCalledWith(w.ds, scheduledTurn);
    expect(w.daemon.refreshTurnCliIdentity).not.toHaveBeenCalled();
    expect(w.material(scheduledTurn)).toBe(bytedcliBody(scheduleRunAs));
  });

  it('leaves a turn that ended before the restart without identity, even when the marker still names it', async () => {
    const w = restartedWorld(interactiveTurn, { endedBeforeRestart: true });
    const { binding } = await w.successor.reattach();
    w.successor.scope.run(binding, () => w.successor.env.publishSandboxRelayCapability(), w.execution);
    await w.drain();
    expect(w.store.execution(w.controller.ref, w.execution.executionId)?.phase).toBe('succeeded');
    expect(w.daemon.refreshTurnCliIdentity).not.toHaveBeenCalled();
    expect(w.material(interactiveTurn)).toBeUndefined();
  });

  it('refuses an origin for a turn the daemon never admitted', async () => {
    const w = restartedWorld(interactiveTurn);
    const forgedTurn = 'om_forged_turn';
    const forged = w.reattachedWorker(w.worker2, forgedTurn, w.host);
    const { binding } = await w.successor.reattach();
    const forgedExecution = { executionId: 'forged-execution', turnId: forgedTurn };
    forged.scope.rememberExecution(forgedExecution, binding);
    w.daemon.refreshTurnCliIdentity.mockClear();
    w.ds.lastPublishedIdentityModel = undefined;
    forged.scope.run(binding, () => forged.env.publishSandboxRelayCapability(), forgedExecution);
    await w.drain();
    expect(w.ds.managedTurnOrigin?.turnId).not.toBe(forgedTurn);
    expect(w.daemon.refreshTurnCliIdentity).not.toHaveBeenCalled();
    expect(w.material(forgedTurn)).toBeUndefined();
  });

  it('refuses an origin for the in-flight turn from a worker generation that does not own the session', async () => {
    const w = restartedWorld(interactiveTurn);
    const foreign = w.reattachedWorker({ workerId: 'foreign-worker', generation: 99 }, interactiveTurn, w.host);
    const binding = foreign.scope.beginRuntime(undefined, 'pane-1');
    binding.identity = cli as any;
    foreign.scope.assign(binding.bindingId, w.runtime1);
    foreign.scope.rememberExecution(w.execution, binding);
    foreign.scope.run(binding, () => foreign.env.publishSandboxRelayCapability(), w.execution);
    await w.drain();
    expect(w.ds.managedTurnOrigin).toBeUndefined();
    expect(w.daemon.refreshTurnCliIdentity).not.toHaveBeenCalled();
    expect(w.material(interactiveTurn)).toBeUndefined();
  });
});
