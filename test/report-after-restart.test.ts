import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveTurnAuthority, sameTrustedPrincipal } from '../src/core/active-turn-authority.js';
import { createDispatchReportBinding } from '../src/core/dispatch-report-binding.js';
import { authorizeReportSessionRelayRequest, deliverReportSessionRelay } from '../src/core/report-session-relay.js';
import { SessionController } from '../src/core/session-controller.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';
import { findCodexRolloutByPid, findCodexRolloutSetByPid } from '../src/services/codex-transcript.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const NATIVE = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TURN = 'om_work_across_restart';
const APP = 'cli_restart_report';
const ROOT = 'om_dispatch_report';
const OLD_CAPABILITY = '11'.repeat(32);

function ownedRollout(root: string, id = NATIVE): number {
  const dir = join(root, 'sessions/2026/11/13');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-11-13T01-02-03-${id}.jsonl`);
  writeFileSync(file, '');
  const fd = openSync(file, 'r');
  cleanups.push(() => closeSync(fd));
  return fd;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'report-restart-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  ownedRollout(root);
  const ds: any = { session: { sessionId: 'session-report', status: 'active', cliId: 'codex' },
    larkAppId: APP, chatId: 'oc_report_group', scope: 'thread' };
  const store = new SessionContractStore(root, APP);
  cleanups.push(() => store.close());
  const controller = new SessionController(ds, store);
  const oldWorker = controller.bindWorker(1).worker;
  const launcher = controller.reserveBinding('launcher', oldWorker);
  controller.bindRuntime('launcher', oldWorker, { backend: 'tmux', physicalId: 'launcher:birth', proof: 'process_start' });
  const execution = controller.admitInput(TURN);
  const oldScope = new WorkerSessionEventScope(controller.ref, oldWorker);
  controller.ingest({ type: 'turn_execution_started', turnId: TURN,
    sessionContract: oldScope.envelope({ bindingId: 'launcher', runtime: launcher, execution }) }, oldWorker);
  const nativeIdentity = { backend: 'tmux', physicalId: `${process.pid}:${readProcessStartIdentity(process.pid)}`,
    nativeSessionId: NATIVE, proof: 'process_start' as const };
  const leaf = controller.reserveBinding('native-leaf', oldWorker);
  controller.bindRuntime('native-leaf', oldWorker, nativeIdentity, undefined, 'launcher');
  controller.workerLost(oldWorker);
  const bootstrap = controller.bindWorker(2);
  const scope = new WorkerSessionEventScope(controller.ref, bootstrap.worker);
  for (const state of bootstrap.executions ?? []) scope.noteAdmission(state);
  const binding = scope.beginRuntime();
  const env: any = { backend: { cliPid: process.pid }, workerSessionEventScope: scope,
    effectiveBackendType: 'tmux', codexRpcEngine: undefined,
    lastInitConfig: { cliId: 'codex', cliSessionId: 'foreign-configured-resume-id' },
    readProcessStartIdentity, findCodexRolloutByPid, findCodexRolloutSetByPid };
  const identity = loadWorkerFunction<(binding: any) => typeof nativeIdentity>('runtimeIdentityForContract', env);
  const observedExecutions = () => {
    const result: Array<{ runtime: typeof launcher; execution: typeof execution }> = [];
    for (const candidate of store.executions(controller.ref)) {
      if (candidate.runtime && store.authorizeExecutionObserver(controller.ref, bootstrap.worker, candidate.ref)) {
        result.push({ runtime: candidate.runtime, execution: candidate.ref });
      }
    }
    return result;
  };
  const bind = () => {
    controller.reserveBinding(binding.bindingId, bootstrap.worker);
    const runtime = controller.bindRuntime(binding.bindingId, bootstrap.worker, identity(binding));
    scope.assign(binding.bindingId, runtime.ref);
    for (const item of observedExecutions()) scope.rememberObservedExecution(binding.bindingId, item.runtime, item.execution);
    return runtime;
  };
  const caller = { requestLarkAppId: APP, requestUserOpenId: 'ou_owner', senderType: 'user' as const };
  const authority = new ActiveTurnAuthority();
  authority.reserve({ turnId: TURN, caller }); authority.markStarted({ turnId: TURN, caller });
  const wire: any[] = [];
  Object.assign(env, { activeTurnAuthority: authority, sessionId: ds.session.sessionId,
    currentBotmuxTurnId: TURN, parseDaemonIpcPort: () => undefined, randomBytes,
    writeCliPidMarker: vi.fn(), isWorkflowWorker: () => false,
    process: { env: {}, send: (message: any) => wire.push(message) } });
  for (const name of ['workerIpcPayload', 'send', 'publishSandboxRelayCapability']) env[name] = loadWorkerFunction(name, env);
  const worker = {};
  ds.worker = worker;
  const legacy = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleLegacyWorkerMessage', {
    ds, worker, t: 'report-restart', botCfg: {}, sessionCliId: () => 'codex',
    logger: { warn: vi.fn(), error: vi.fn() },
    currentGatewayCallerOpenId: () => undefined, currentTurnProcessIdentities: () => [],
    noteTurnDispatchAttempt: vi.fn(), ensureAutomaticTaskContinuationLease: vi.fn(), sameTrustedPrincipal, randomBytes,
  });
  const publish = async () => {
    scope.run(binding, () => env.publishSandboxRelayCapability());
    const message = wire.at(-1);
    const admission = controller.ingest(message, bootstrap.worker);
    if (admission.kind === 'current') await controller.run(admission, () => legacy(message));
    return admission;
  };
  const revoke = async () => {
    Object.assign(env, { unlinkManagedOriginCapabilityFiles: vi.fn(), log: vi.fn(), flushPending: async () => {} });
    env.completeManagedTurnOriginRevocation = loadWorkerFunction('completeManagedTurnOriginRevocation', env);
    const release = loadWorkerFunction<(reason: string, exact: { turnId: string }) => boolean>('releaseActiveTurnAuthority', env);
    scope.run(binding, () => release('turn_terminal', { turnId: TURN }));
    const message = wire.at(-1);
    const admission = controller.ingest(message, bootstrap.worker);
    if (admission.kind === 'current') await controller.run(admission, () => legacy(message));
    return admission;
  };
  const secret = 'fixture-only-binding';
  const registry = { [ROOT]: { reportBinding: createDispatchReportBinding(secret, {
    dispatchRoot: ROOT, targetLarkAppId: 'cli_lead', targetSessionId: 'lead-session',
    sourceName: 'report restart', issuedAt: '2026-11-13T00:00:00Z',
  }) } };
  const authorize = (capability = ds.managedTurnOrigin?.capability, turnId = TURN, attempt?: number) =>
    authorizeReportSessionRelayRequest({ raw: { sessionId: ds.session.sessionId, dispatchRoot: ROOT,
      content: 'same turn completed after restart', status: 'completed', originCapability: capability,
      originTurnId: turnId, ...(attempt === undefined ? {} : { originDispatchAttempt: attempt }) },
    trustedHost: false, session: { sessionId: ds.session.sessionId, larkAppId: APP, chatId: ds.chatId,
      receiver: false, scope: 'thread', rootMessageId: ROOT, liveOrigin: ds.managedTurnOrigin },
    selfLarkAppId: APP, bindingSecret: secret, registry });
  return { root, ds, store, controller, bootstrap, oldWorker, scope, binding, launcher, leaf, execution,
    env, identity, observedExecutions, bind, publish, revoke, authorize };
}

describe('same-turn report after a persistent Codex daemon restart', () => {
  it.each(['single-rollout', 'parent-and-subagent'] as const)('recovers live %s lineage, rotates authority, and relays completion', async mode => {
    const h = fixture();
    if (mode === 'parent-and-subagent') {
      ownedRollout(h.root, OTHER);
      h.env.lastInitConfig.cliSessionId = NATIVE;
    }
    expect(h.identity(h.binding).nativeSessionId).toBe(NATIVE);
    expect(h.bind().ref).toEqual(h.leaf);
    expect(h.observedExecutions())
      .toEqual([{ runtime: h.launcher, execution: h.execution }]);
    expect(await h.publish()).toMatchObject({ kind: 'current' });
    expect(h.ds.managedTurnOrigin).toMatchObject({ turnId: TURN, callerOpenId: 'ou_owner' });
    expect(h.ds.managedTurnOrigin.capability).not.toBe(OLD_CAPABILITY);
    const decision = h.authorize();
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error(decision.error);
    const fetchTarget = vi.fn(async (_path: string, _init: RequestInit) => new Response(JSON.stringify({ ok: true, triggerId: 'trigger-report' }), { status: 200 }));
    const postProjectUpdate = vi.fn(async () => ({ projectSynced: true }));
    const result = await deliverReportSessionRelay({ decision,
      triggerMeta: { requestId: 'report-1', receivedAt: '2026-11-13T00:01:00Z' }, fetchTarget, postProjectUpdate });
    expect(result).toMatchObject({ status: 200, body: { ok: true, projectSynced: true, triggerId: 'trigger-report' } });
    expect(fetchTarget).toHaveBeenCalledTimes(1);
    expect(fetchTarget.mock.calls[0]?.[0]).toBe('/api/trigger');
    expect(postProjectUpdate).toHaveBeenCalledWith({ larkAppId: 'cli_lead', sessionId: 'lead-session' });
    expect(h.store.executions(h.controller.ref, TURN)).toHaveLength(1);
  });

  it.each(['ambiguous-rollouts', 'other-owned-conversation', 'changed-process', 'changed-conversation', 'rpc-engine'] as const)('does not inherit an old execution with %s', async mode => {
    const h = fixture();
    if (mode === 'ambiguous-rollouts') ownedRollout(h.root, OTHER);
    if (mode === 'other-owned-conversation') {
      ownedRollout(h.root, OTHER);
      h.env.lastInitConfig.cliSessionId = OTHER;
    }
    if (mode === 'changed-process') h.env.readProcessStartIdentity = () => 'recycled-pid-birth';
    if (mode === 'changed-conversation') h.env.findCodexRolloutByPid = () => ({ cliSessionId: OTHER });
    if (mode === 'rpc-engine') h.env.codexRpcEngine = { appServerPid: process.pid };
    expect(h.bind().ref).not.toEqual(h.leaf);
    expect(h.observedExecutions()).toEqual([]);
    expect(await h.publish()).toMatchObject({ kind: 'reject' });
    expect(h.authorize(OLD_CAPABILITY)).toMatchObject({ ok: false, status: 403 });
  });

  it.each(['process-birth', 'backend', 'binding'] as const)('discards ownership proof when %s changes during the probe', mode => {
    const h = fixture();
    h.env.findCodexRolloutByPid = () => {
      if (mode === 'process-birth') h.env.readProcessStartIdentity = () => 'new-birth';
      if (mode === 'backend') h.env.backend = { cliPid: process.pid };
      if (mode === 'binding') h.scope.beginRuntime();
      return { cliSessionId: NATIVE };
    };
    expect(h.identity(h.binding)).toMatchObject({ proof: 'opaque' });
  });

  it('rejects forged or expired capabilities and terminal or retired-worker authority', async () => {
    const h = fixture(); h.bind(); await h.publish();
    expect(h.authorize()).toMatchObject({ ok: true });
    expect(h.authorize(OLD_CAPABILITY)).toMatchObject({ ok: false, status: 403 });
    // Tuple fields never supply authority; only the current rotating token does.
    expect(h.authorize('ff'.repeat(32), 'om_other_turn', 9)).toMatchObject({ ok: false, status: 403 });
    expect(h.authorize(OLD_CAPABILITY, TURN, 9)).toMatchObject({ ok: false, status: 403 });
    const origin = h.scope.origin(TURN)!;
    const stale = h.scope.envelope(origin);
    expect(h.controller.ingest({ type: 'managed_turn_origin', sessionId: h.ds.session.sessionId,
      capability: OLD_CAPABILITY, turnId: TURN, sessionContract: { ...stale, producer: h.oldWorker } }, h.oldWorker))
      .toMatchObject({ kind: 'reject' });
    const expired = h.ds.managedTurnOrigin.capability;
    expect(await h.revoke()).toMatchObject({ kind: 'current' });
    expect(h.authorize(expired)).toMatchObject({ ok: false, status: 403 });
    expect(h.ds.managedTurnOrigin.turnId).toBeUndefined();
    expect(h.controller.ingest({ type: 'turn_terminal', turnId: TURN, status: 'completed',
      sessionContract: h.scope.envelope(origin) }, h.bootstrap.worker))
      .toMatchObject({ kind: 'historical' });
    expect(h.store.execution(h.controller.ref, h.execution.executionId)?.phase).toBe('succeeded');
    expect(h.controller.ingest({ type: 'managed_turn_origin', sessionId: h.ds.session.sessionId,
      capability: '22'.repeat(32), turnId: TURN, sessionContract: { ...h.scope.envelope(origin), bindingId: h.binding.bindingId, scope: { runtime: h.leaf, execution: h.execution } } }, h.bootstrap.worker))
      .toMatchObject({ kind: 'reject' });
  });
});
