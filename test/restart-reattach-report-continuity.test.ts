import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionController } from '../src/core/session-controller.js';
import { ActiveTurnAuthority, sameTrustedPrincipal } from '../src/core/active-turn-authority.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import {
  readCodexLiveSessionId,
  selectCodexLiveSessionIdFromPaths,
} from '../src/services/codex-transcript.js';
import {
  authorizeReportSessionRelayRequest,
  prepareAutomaticDispatchReport,
} from '../src/core/report-session-relay.js';
import { createDispatchReportBinding } from '../src/core/dispatch-report-binding.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure } from './helpers/worker-pool-function-harness.js';
import type { DaemonSession } from '../src/core/types.js';
import { sameWorker, type WorkerRef } from '../src/services/session-contract.js';

const fixtureConfig = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      session: {
        ...actual.config.session,
        get dataDir() { return fixtureConfig.dataDir || actual.config.session.dataDir; },
      },
    },
  };
});

const directories: string[] = [];
const handles: Array<{ close(): void }> = [];

function createFixture(nativeSessionId = '019a0000-0000-7000-8000-000000000001') {
  const data = mkdtempSync(join(tmpdir(), 'reattach-report-continuity-'));
  directories.push(data);
  fixtureConfig.dataDir = data;
  const appId = 'cli_executor_test';
  const coordinatorAppId = 'cli_coordinator_test';
  const ref = { appId, sessionId: 'session-executor-1' };
  const store = new SessionContractStore(data, appId);
  handles.push(store);
  const ds = {
    larkAppId: appId,
    chatId: 'oc_project_group',
    scope: 'thread',
    session: {
      sessionId: ref.sessionId,
      larkAppId: appId,
      chatId: 'oc_project_group',
      rootMessageId: 'om_dispatch_root_1',
      status: 'active',
    },
    cliReadyGeneration: 0,
  } as unknown as DaemonSession;
  const controller = new SessionController(ds, store);
  const worker1 = controller.bindWorker(1).worker;
  const runtime1 = controller.reserveBinding('w1-leaf', worker1);
  controller.bindRuntime('w1-leaf', worker1, {
    backend: 'tmux',
    physicalId: '222:leafStart1',
    nativeSessionId,
    proof: 'process_start',
  });
  const secret = 'test-report-binding-secret-0123456789abcdef';
  const binding = createDispatchReportBinding(secret, {
    dispatchRoot: 'om_dispatch_root_1',
    targetLarkAppId: coordinatorAppId,
    targetSessionId: 'session-coordinator-1',
    targetChatId: 'oc_project_group',
    targetScope: 'chat',
    sourceName: 'subtask-executor',
    issuedAt: '2026-11-12T08:00:00.000Z',
  });
  const registry = { om_dispatch_root_1: { reportBinding: binding } };
  const context = (producer: WorkerRef, sequence: number, scope: Record<string, unknown>, bindingId?: string) => ({
    version: 2 as const,
    session: ref,
    producer,
    ...(bindingId ? { bindingId } : {}),
    eventId: `${producer.workerId}:${sequence}`,
    sequence,
    scope,
  });
  return { data, appId, coordinatorAppId, ref, store, ds, controller, worker1, runtime1, secret, registry, context };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const handle of handles.splice(0)) {
    try { handle.close(); } catch { /* already closed */ }
  }
  for (const data of directories.splice(0)) {
    rmSync(data, { recursive: true, force: true });
  }
});

describe('runtimeIdentityForContract live open-fd identity for Codex and Grok', () => {
  it('derives Codex nativeSessionId from a unique owned rollout fd and disambiguates multi-fd subagent trees only via an active owned bridge turn', () => {
    const scope = new WorkerSessionEventScope({ appId: 'a', sessionId: 's' }, { workerId: 'w', generation: 2 });
    const parentSid = '019a0000-0000-7000-8000-111111111111';
    const subagentSid = '019a0000-0000-7000-8000-222222222222';
    const foreignSid = '019a0000-0000-7000-8000-999999999999';
    const env: Record<string, unknown> = {
      backend: { cliPid: 222 },
      codexRpcEngine: undefined,
      effectiveBackendType: 'tmux',
      lastInitConfig: { cliId: 'codex', cliSessionId: foreignSid },
      cliAdapter: {},
      workerSessionEventScope: scope,
      readProcessStartIdentity: () => 'leafStart1',
      findCodexRolloutSetByPid: () => new Set([parentSid]),
      findCodexRolloutByPid: () => ({ path: `/sessions/rollout-${parentSid}.jsonl`, cliSessionId: parentSid }),
      codexHistorySidIsOwned: (sid: string, owned: ReadonlySet<string>) => owned.has(sid.toLowerCase()),
      codexGenerationSessionIdFromRolloutPath: (p: string) => {
        const match = /rollout-([0-9a-f-]+)\.jsonl$/i.exec(p);
        return match?.[1];
      },
      codexBridgeRolloutPath: undefined,
      codexBridgeQueue: { peek: () => [] },
    };
    const readIdentity = loadWorkerFunction<(b: any) => any>('runtimeIdentityForContract', env);

    // 1. Single owned rollout fd: derives parentSid, never trusting lastInitConfig.cliSessionId.
    const single = scope.beginRuntime();
    expect(readIdentity(single)).toEqual({
      backend: 'tmux',
      physicalId: '222:leafStart1',
      proof: 'process_start',
      nativeSessionId: parentSid,
    });

    // 2. Parent + subagent rollouts open with NO active bridge turn: stays bare (never guesses).
    env.findCodexRolloutSetByPid = () => new Set([parentSid, subagentSid]);
    env.findCodexRolloutByPid = () => null;
    env.codexBridgeRolloutPath = `/sessions/rollout-${parentSid}.jsonl`;
    env.codexBridgeQueue = { peek: () => [] };
    expect(readIdentity(scope.beginRuntime())).toEqual({
      backend: 'tmux',
      physicalId: '222:leafStart1',
      proof: 'process_start',
    });

    // 3. Active restored bridge turn whose rollout is in the PID's owned set: disambiguates parentSid.
    env.codexBridgeQueue = { peek: () => [{ turnId: 'om_turn_1', started: true }] };
    expect(readIdentity(scope.beginRuntime())).toEqual({
      backend: 'tmux',
      physicalId: '222:leafStart1',
      proof: 'process_start',
      nativeSessionId: parentSid,
    });

    // 4. Bridge path pointing at an unowned foreign rollout: fails closed to bare identity.
    env.codexBridgeRolloutPath = `/sessions/rollout-${foreignSid}.jsonl`;
    expect(readIdentity(scope.beginRuntime())).toEqual({
      backend: 'tmux',
      physicalId: '222:leafStart1',
      proof: 'process_start',
    });

    // 5. PID recycled mid-probe (procStart changes): fails closed to opaque.
    env.findCodexRolloutSetByPid = () => new Set([parentSid]);
    env.findCodexRolloutByPid = () => ({ path: `/sessions/rollout-${parentSid}.jsonl`, cliSessionId: parentSid });
    env.readProcessStartIdentity = vi.fn().mockReturnValueOnce('leafStart1').mockReturnValueOnce('recycledStart');
    expect(readIdentity(scope.beginRuntime()).proof).toBe('opaque');
  });

  it('derives Grok nativeSessionId from open session fd without overwriting a bound conversation', () => {
    const scope = new WorkerSessionEventScope({ appId: 'a', sessionId: 's' }, { workerId: 'w', generation: 2 });
    const env: Record<string, unknown> = {
      backend: { cliPid: 333 },
      codexRpcEngine: undefined,
      effectiveBackendType: 'tmux',
      lastInitConfig: { cliId: 'grok' },
      cliAdapter: {},
      workerSessionEventScope: scope,
      readProcessStartIdentity: () => 'grokStart1',
      findGrokSessionByPid: () => ({ sessionId: 'grok-live-1', updatesPath: '/grok/grok-live-1/updates.jsonl' }),
    };
    const readIdentity = loadWorkerFunction<(b: any) => any>('runtimeIdentityForContract', env);
    expect(readIdentity(scope.beginRuntime())).toEqual({
      backend: 'tmux',
      physicalId: '333:grokStart1',
      proof: 'process_start',
      nativeSessionId: 'grok-live-1',
    });
    const bound = scope.beginRuntime();
    bound.identity = {
      backend: 'tmux',
      physicalId: '333:grokStart1',
      proof: 'process_start',
      nativeSessionId: 'grok-written-1',
    };
    expect(readIdentity(bound).nativeSessionId).toBe('grok-written-1');
  });
});

describe('mid-turn worker replacement across launcher-to-leaf continuation and report relay', () => {
  it('recovers the unresolved leaf runtime after a bare launcher binding, re-admits turn authority, and delivers completed report and zero-prompt final', () => {
    const s = createFixture('019a0000-0000-7000-8000-000000000001');
    const turnId = 'om_running_turn_1';
    const execution = s.controller.admitInput(turnId);
    expect(
      s.controller.ingest(
        {
          type: 'turn_execution_started',
          turnId,
          sessionContract: s.context(s.worker1, 1, { runtime: s.runtime1, execution }),
        },
        s.worker1,
      ),
    ).toMatchObject({ kind: 'current' });

    // Simulate daemon restart / worker replacement while the persistent pane stays alive.
    s.controller.workerLost(s.worker1);
    expect(s.store.runtime(s.ref, s.runtime1.runtimeId)?.phase).toBe('unresolved');
    expect(s.store.execution(s.ref, execution.executionId)?.phase).toBe('reconciling');

    const worker2 = s.controller.bindWorker(2).worker;
    // Step 1: Replacement worker initially binds the bare outer launcher PID before leaf unwrap.
    const launcherRef = s.controller.reserveBinding('w2-launcher', worker2);
    const launcherBound = s.controller.bindRuntime('w2-launcher', worker2, {
      backend: 'tmux',
      physicalId: '111:launcherStart1',
      proof: 'process_start',
    });
    expect(launcherBound.ref).toEqual(launcherRef);

    // Step 2: Replacement worker unwraps launcher -> real CLI leaf with matching PID + procStart + nativeSessionId.
    s.controller.reserveBinding('w2-leaf', worker2);
    const recovered = s.controller.bindRuntime(
      'w2-leaf',
      worker2,
      {
        backend: 'tmux',
        physicalId: '222:leafStart1',
        nativeSessionId: '019a0000-0000-7000-8000-000000000001',
        proof: 'process_start',
      },
      undefined,
      'w2-launcher',
    );
    expect(recovered.ref).toEqual(s.runtime1);
    expect(s.controller.currentRuntime()).toEqual(s.runtime1);

    // Step 3: Replacement worker re-publishes managed_turn_origin once runtime_contract_assigned supplies execution.
    const capability = 'cap-reattached-live-turn-1';
    const originAdmission = s.controller.ingest(
      {
        type: 'managed_turn_origin',
        sessionId: s.ref.sessionId,
        capability,
        turnId,
        sessionContract: s.context(worker2, 1, { runtime: recovered.ref, execution }, 'w2-leaf'),
      },
      worker2,
    );
    expect(originAdmission).toMatchObject({ kind: 'current' });

    // Step 4: `botmux report --status completed` is authorized with the restored live turn capability.
    const liveOrigin = { capability, turnId };
    const reportDecision = authorizeReportSessionRelayRequest({
      raw: {
        sessionId: s.ref.sessionId,
        dispatchRoot: 'om_dispatch_root_1',
        status: 'completed',
        content: 'Task completed after daemon restart',
        originCapability: capability,
        originTurnId: turnId,
      },
      trustedHost: true,
      session: {
        sessionId: s.ref.sessionId,
        larkAppId: s.appId,
        chatId: 'oc_project_group',
        promptInjection: 'none',
        receiver: false,
        scope: 'thread',
        rootMessageId: 'om_dispatch_root_1',
        liveOrigin,
      },
      selfLarkAppId: s.appId,
      registry: s.registry,
      bindingSecret: s.secret,
    });
    expect(reportDecision).toMatchObject({
      ok: true,
      target: { sessionId: 'session-coordinator-1', larkAppId: s.coordinatorAppId },
      dispatchRoot: 'om_dispatch_root_1',
      content: 'Task completed after daemon restart',
      projectUpdate: { status: 'completed' },
    });

    // Step 5: Zero-injection final_output and turn_terminal from the re-attached worker are admitted as `current`.
    const finalAdmission = s.controller.ingest(
      {
        type: 'final_output',
        sessionId: s.ref.sessionId,
        turnId,
        content: 'Zero-injection final answer',
        sessionContract: s.context(worker2, 2, { runtime: recovered.ref, execution }, 'w2-leaf'),
      },
      worker2,
    );
    expect(finalAdmission).toMatchObject({ kind: 'current' });
    const autoReport = prepareAutomaticDispatchReport({
      registry: s.registry,
      bindingSecret: s.secret,
      dispatchRoot: 'om_dispatch_root_1',
      sourceSessionId: s.ref.sessionId,
      sourceLarkAppId: s.appId,
      content: 'Zero-injection final answer',
    });
    expect(autoReport).toMatchObject({
      ok: true,
      target: { sessionId: 'session-coordinator-1', larkAppId: s.coordinatorAppId },
      content: 'Zero-injection final answer',
    });

    expect(
      s.controller.ingest(
        {
          type: 'turn_terminal',
          sessionId: s.ref.sessionId,
          turnId,
          status: 'completed',
          sessionContract: s.context(worker2, 3, { runtime: recovered.ref, execution }, 'w2-leaf'),
        },
        worker2,
      ),
    ).toMatchObject({ kind: 'current' });
    expect(s.store.execution(s.ref, execution.executionId)?.phase).toBe('succeeded');

    // Step 6: Once the turn ends and liveOrigin is revoked, stale/replayed reports fail closed.
    const postTerminalReport = authorizeReportSessionRelayRequest({
      raw: {
        sessionId: s.ref.sessionId,
        dispatchRoot: 'om_dispatch_root_1',
        status: 'completed',
        content: 'Late duplicate after turn end',
        originCapability: capability,
        originTurnId: turnId,
      },
      trustedHost: true,
      session: {
        sessionId: s.ref.sessionId,
        larkAppId: s.appId,
        chatId: 'oc_project_group',
        promptInjection: 'none',
        receiver: false,
        scope: 'thread',
        rootMessageId: 'om_dispatch_root_1',
        liveOrigin: undefined,
      },
      selfLarkAppId: s.appId,
      registry: s.registry,
      bindingSecret: s.secret,
    });
    expect(postTerminalReport.ok).toBe(false);
  });

  it('refuses runtime recovery when the leaf process start token changed (PID recycling / respawn) or a foreign proven runtime intervened', () => {
    const s = createFixture('019a0000-0000-7000-8000-000000000001');
    const turnId = 'om_running_turn_spoof';
    const execution = s.controller.admitInput(turnId);
    s.controller.ingest(
      {
        type: 'turn_execution_started',
        turnId,
        sessionContract: s.context(s.worker1, 1, { runtime: s.runtime1, execution }),
      },
      s.worker1,
    );
    s.controller.workerLost(s.worker1);

    const worker2 = s.controller.bindWorker(2).worker;
    s.controller.reserveBinding('w2-launcher', worker2);
    s.controller.bindRuntime('w2-launcher', worker2, {
      backend: 'tmux',
      physicalId: '111:launcherStart1',
      proof: 'process_start',
    });

    // Same PID 222 and same nativeSessionId, but different kernel process start token!
    s.controller.reserveBinding('w2-recycled-leaf', worker2);
    const recycled = s.controller.bindRuntime(
      'w2-recycled-leaf',
      worker2,
      {
        backend: 'tmux',
        physicalId: '222:recycledStart99',
        nativeSessionId: '019a0000-0000-7000-8000-000000000001',
        proof: 'process_start',
      },
      undefined,
      'w2-launcher',
    );
    expect(recycled.ref).not.toEqual(s.runtime1);
    expect(
      s.controller.ingest(
        {
          type: 'managed_turn_origin',
          sessionId: s.ref.sessionId,
          capability: 'cap-spoof',
          turnId,
          sessionContract: s.context(worker2, 1, { runtime: recycled.ref, execution }, 'w2-recycled-leaf'),
        },
        worker2,
      ),
    ).toEqual({ kind: 'reject', reason: 'execution_scope_unproven' });
  });

  it('keeps a new turn started on the continued launcher bound via continuation without falsely recovering the older runtime', () => {
    const s = createFixture('019a0000-0000-7000-8000-000000000001');
    const oldExec = s.controller.admitInput('om_old_turn');
    s.controller.ingest(
      {
        type: 'turn_execution_started',
        turnId: 'om_old_turn',
        sessionContract: s.context(s.worker1, 1, { runtime: s.runtime1, execution: oldExec }),
      },
      s.worker1,
    );
    s.controller.workerLost(s.worker1);

    const worker2 = s.controller.bindWorker(2).worker;
    const launcher = s.controller.reserveBinding('w2-launcher', worker2);
    s.controller.bindRuntime('w2-launcher', worker2, {
      backend: 'tmux',
      physicalId: '111:launcherStart1',
      proof: 'process_start',
    });
    const newExec = s.controller.admitInput('om_new_turn_on_launcher');
    s.store.bindQueuedExecution(s.ref, newExec, launcher);

    const leafReserved = s.controller.reserveBinding('w2-leaf', worker2);
    const leafBound = s.controller.bindRuntime(
      'w2-leaf',
      worker2,
      {
        backend: 'tmux',
        physicalId: '222:leafStart1',
        nativeSessionId: '019a0000-0000-7000-8000-000000000001',
        proof: 'process_start',
      },
      undefined,
      'w2-launcher',
    );
    expect(leafBound.ref).toEqual(leafReserved);
    expect(s.store.runtimeContinues(s.ref, launcher, leafBound.ref, worker2)).toBe(true);
  });
});

describe('same-worker multi-hop in-process runtime continuation (epoch 1 -> 2 -> 3)', () => {
  it('admits managed_turn_origin, final_output, turn_terminal, and origin revocation across in-process continuations, while rejecting post-respawn claims', () => {
    const data = mkdtempSync(join(tmpdir(), 'inproc-continuation-'));
    directories.push(data);
    fixtureConfig.dataDir = data;
    const appId = 'cli_inproc_test';
    const ref = { appId, sessionId: 'session-inproc-1' };
    const store = new SessionContractStore(data, appId);
    handles.push(store);
    const ds = {
      larkAppId: appId,
      chatId: 'oc_test',
      session: { sessionId: ref.sessionId, larkAppId: appId, status: 'active' },
      cliReadyGeneration: 0,
    } as unknown as DaemonSession;
    const controller = new SessionController(ds, store);
    const worker = controller.bindWorker(1).worker;

    // Epoch 1: initial launcher process_start.
    const r1 = controller.reserveBinding('b1-launcher', worker);
    controller.bindRuntime('b1-launcher', worker, {
      backend: 'tmux',
      physicalId: '100:launcherStart',
      proof: 'process_start',
    });

    // Epoch 2: unwrapped leaf process_start + initial conversation id.
    const r2 = controller.reserveBinding('b2-leaf', worker);
    controller.bindRuntime(
      'b2-leaf',
      worker,
      {
        backend: 'tmux',
        physicalId: '200:leafStart',
        nativeSessionId: 'conv-initial',
        proof: 'process_start',
      },
      undefined,
      'b1-launcher',
    );

    const turnId = 'om_inproc_turn_1';
    const execution = controller.admitInput(turnId);
    const ctx = (seq: number, scope: Record<string, unknown>, bindingId?: string) => ({
      version: 2 as const,
      session: ref,
      producer: worker,
      ...(bindingId ? { bindingId } : {}),
      eventId: `${worker.workerId}:${seq}`,
      sequence: seq,
      scope,
    });

    // Turn binds to epoch 2 (r2).
    expect(
      controller.ingest(
        {
          type: 'turn_execution_started',
          turnId,
          sessionContract: ctx(1, { runtime: r2, execution }, 'b2-leaf'),
        },
        worker,
      ),
    ).toMatchObject({ kind: 'current' });

    // Epoch 3: live CLI rotates/reveals real conversation id in-process (continues b2-leaf -> b3-real).
    const r3 = controller.reserveBinding('b3-real', worker);
    controller.bindRuntime(
      'b3-real',
      worker,
      {
        backend: 'tmux',
        physicalId: '200:leafStart',
        nativeSessionId: 'conv-real',
        proof: 'process_start',
      },
      undefined,
      'b2-leaf',
    );
    expect(controller.currentRuntime()).toEqual(r3);

    // Events emitted under active binding b3-real (or earlier b1-launcher) for `execution` (bound to r2) are admitted as `current`!
    expect(
      controller.ingest(
        {
          type: 'managed_turn_origin',
          sessionId: ref.sessionId,
          capability: 'cap-inproc-1',
          turnId,
          sessionContract: ctx(2, { runtime: r3, execution }, 'b3-real'),
        },
        worker,
      ),
    ).toMatchObject({ kind: 'current' });

    expect(
      controller.ingest(
        {
          type: 'final_output',
          sessionId: ref.sessionId,
          turnId,
          content: 'Answer after in-process continuation',
          sessionOutputOrigin: ctx(3, { runtime: r3, execution }, 'b3-real'),
          sessionContract: ctx(3, { runtime: r1, execution }, 'b1-launcher'),
        },
        worker,
      ),
    ).toMatchObject({ kind: 'current' });

    expect(
      controller.ingest(
        {
          type: 'managed_turn_origin_revoked',
          sessionId: ref.sessionId,
          capability: 'cap-inproc-1',
          turnId,
          sessionContract: ctx(4, { runtime: r3, execution }, 'b3-real'),
        },
        worker,
      ),
    ).toMatchObject({ kind: 'current' });

    // After a non-continued CLI respawn (epoch 4, no continuesBindingId), mutable authority for r2's turn is rejected.
    const r4 = controller.reserveBinding('b4-respawn', worker);
    controller.bindRuntime('b4-respawn', worker, {
      backend: 'tmux',
      physicalId: '400:respawnStart',
      nativeSessionId: 'conv-respawn',
      proof: 'process_start',
    });
    expect(
      controller.ingest(
        {
          type: 'managed_turn_origin',
          sessionId: ref.sessionId,
          capability: 'cap-stale-after-respawn',
          turnId,
          sessionContract: ctx(5, { runtime: r3, execution }, 'b3-real'),
        },
        worker,
      ),
    ).toEqual({ kind: 'reject', reason: 'stale_runtime_scope' });
    expect(
      controller.ingest(
        {
          type: 'managed_turn_origin',
          sessionId: ref.sessionId,
          capability: 'cap-wrong-runtime',
          turnId,
          sessionContract: ctx(6, { runtime: r4, execution }, 'b4-respawn'),
        },
        worker,
      ),
    ).toEqual({ kind: 'reject', reason: 'execution_scope_unproven' });
  });

  it('resolves WorkerSessionEventScope.origin cleanly across same-process binding continuations while failing closed across distinct processes', () => {
    const scope = new WorkerSessionEventScope({ appId: 'a', sessionId: 's' }, { workerId: 'w', generation: 1 });
    const b1 = scope.beginRuntime(undefined, 'phys-1');
    scope.assign(b1.bindingId, { runtimeId: 'r1', epoch: 1 });
    const exec = { executionId: 'e1', turnId: 'om_turn_1' };
    scope.rememberExecution(exec, b1);

    const b2 = scope.beginRuntime(undefined, 'phys-1');
    scope.assign(b2.bindingId, { runtimeId: 'r2', epoch: 2 });
    scope.rememberExecution(exec, b2);

    // Outside AsyncLocalStorage: same executionId + same physicalId picks current binding b2.
    expect(scope.origin('om_turn_1')).toEqual({
      bindingId: b2.bindingId,
      runtime: { runtimeId: 'r2', epoch: 2 },
      execution: exec,
    });

    // Recording the same turn on a DIFFERENT physicalId fails closed to undefined.
    const b3 = scope.beginRuntime(undefined, 'phys-2');
    scope.assign(b3.bindingId, { runtimeId: 'r3', epoch: 3 });
    scope.rememberExecution(exec, b3);
    expect(scope.origin('om_turn_1')).toBeUndefined();
  });
});

describe('readCodexLiveSessionId disambiguates parent rollout from open subagent rollouts', () => {
  it('returns the sole top-level conversation id when subagent rollouts are also open on the same PID, and fails closed on multi-user or unverified headers', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-live-sid-'));
    directories.push(root);
    const sessionsDir = join(root, 'sessions', '2026', '10', '27');
    mkdirSync(sessionsDir, { recursive: true });

    const parentSid = '01a17c40-ce9a-7681-bcf0-91913289bf82';
    const subSid1 = '01a18b8f-48ac-7000-8000-111111111111';
    const subSid2 = '01a18b8f-9447-7000-8000-222222222222';
    const secondUserSid = '01a19999-0000-7000-8000-333333333333';
    const pendingSid = '01a1aaaa-0000-7000-8000-444444444444';

    const parentPath = join(sessionsDir, `rollout-2026-10-27T15-26-24-${parentSid}.jsonl`);
    const subPath1 = join(sessionsDir, `rollout-2026-11-12T16-40-00-${subSid1}.jsonl`);
    const subPath2 = join(sessionsDir, `rollout-2026-11-12T16-41-00-${subSid2}.jsonl`);
    const secondUserPath = join(sessionsDir, `rollout-2026-11-12T16-42-00-${secondUserSid}.jsonl`);
    const pendingPath = join(sessionsDir, `rollout-2026-11-12T16-43-00-${pendingSid}.jsonl`);

    writeFileSync(
      parentPath,
      `${JSON.stringify({ timestamp: '2026-10-27T07:26:24.000Z', type: 'session_meta', payload: { id: parentSid, cwd: root } })}\n`,
    );
    writeFileSync(
      subPath1,
      `${JSON.stringify({
        timestamp: '2026-11-12T08:40:00.000Z',
        type: 'session_meta',
        payload: { id: subSid1, thread_source: 'subagent', parent_thread_id: parentSid, source: { subagent: 'review' } },
      })}\n`,
    );
    writeFileSync(
      subPath2,
      `${JSON.stringify({
        timestamp: '2026-11-12T08:41:00.000Z',
        type: 'session_meta',
        payload: { id: subSid2, source: { subagent: { thread_spawn: { parent_thread_id: parentSid } } } },
      })}\n`,
    );
    writeFileSync(
      secondUserPath,
      `${JSON.stringify({ timestamp: '2026-11-12T08:42:00.000Z', type: 'session_meta', payload: { id: secondUserSid, thread_source: 'user' } })}\n`,
    );
    // Incomplete first line (no trailing newline yet) simulates a mid-creation `/new` rollout.
    writeFileSync(pendingPath, '{"type":"session_meta"');

    const openFds: number[] = [];
    const closeAll = () => {
      for (const fd of openFds.splice(0)) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
    };
    try {
      openFds.push(openSync(parentPath, 'r'), openSync(subPath1, 'r'), openSync(subPath2, 'r'));
      expect(readCodexLiveSessionId(process.pid)).toBe(parentSid);

      // Opening a second top-level user rollout makes the PID ambiguous -> fail closed.
      const secondFd = openSync(secondUserPath, 'r');
      openFds.push(secondFd);
      expect(readCodexLiveSessionId(process.pid)).toBeUndefined();
      closeSync(secondFd);
      openFds.pop();

      // Opening an incomplete/unflushed rollout header also fails closed -> never guesses.
      const pendingFd = openSync(pendingPath, 'r');
      openFds.push(pendingFd);
      expect(readCodexLiveSessionId(process.pid)).toBeUndefined();
    } finally {
      closeAll();
    }

    // Mismatched session_meta.payload.id vs filename UUID fails closed.
    const mismatchPath = join(sessionsDir, `rollout-2026-11-12T16-44-00-${secondUserSid}.jsonl`);
    writeFileSync(
      mismatchPath,
      `${JSON.stringify({ timestamp: '2026-11-12T08:44:00.000Z', type: 'session_meta', payload: { id: parentSid } })}\n`,
    );
    expect(selectCodexLiveSessionIdFromPaths([mismatchPath])).toBeUndefined();
  });
});

describe('continued launcher-to-leaf turn continuity across daemon restart', () => {
  it('admits managed_turn_origin on the recovered active leaf runtime while rejecting historical-runtime or post-terminal origin claims', () => {
    const data = mkdtempSync(join(tmpdir(), 'reattach-launcher-leaf-'));
    directories.push(data);
    fixtureConfig.dataDir = data;
    const appId = 'cli_executor_test';
    const ref = { appId, sessionId: 'session-launcher-leaf-1' };
    const store = new SessionContractStore(data, appId);
    handles.push(store);
    const ds = {
      larkAppId: appId,
      chatId: 'oc_project_group',
      scope: 'thread',
      rootMessageId: 'om_dispatch_root_1',
      session: { sessionId: ref.sessionId, larkAppId: appId, status: 'active' },
    } as unknown as DaemonSession;
    const controller = new SessionController(ds, store);
    const worker1 = controller.bindWorker(1).worker;
    const launcher1 = controller.reserveBinding('w1-launcher', worker1);
    controller.bindRuntime('w1-launcher', worker1, {
      backend: 'tmux',
      physicalId: '111:launcherStart1',
      proof: 'process_start',
    });
    const turnId = 'om_opening_launcher_turn';
    const execution = controller.admitInput(turnId);
    expect(
      controller.ingest(
        {
          type: 'turn_execution_started',
          turnId,
          sessionContract: {
            version: 2,
            session: ref,
            producer: worker1,
            bindingId: 'w1-launcher',
            eventId: `${worker1.workerId}:1`,
            sequence: 1,
            scope: { runtime: launcher1, execution },
          },
        },
        worker1,
      ),
    ).toMatchObject({ kind: 'current' });

    // Worker 1 unwraps launcher -> leaf before daemon restart; execution.runtime remains launcher1.
    controller.reserveBinding('w1-leaf', worker1);
    const leaf1 = controller.bindRuntime(
      'w1-leaf',
      worker1,
      {
        backend: 'tmux',
        physicalId: '222:leafStart1',
        nativeSessionId: '019a0000-0000-7000-8000-000000000099',
        proof: 'process_start',
      },
      undefined,
      'w1-launcher',
    );

    // Daemon restarts mid-turn; worker 2 unwraps w2-launcher -> w2-leaf and recovers leaf1.ref as activeRuntime.
    controller.workerLost(worker1);
    const worker2 = controller.bindWorker(2).worker;
    controller.reserveBinding('w2-launcher', worker2);
    controller.bindRuntime('w2-launcher', worker2, {
      backend: 'tmux',
      physicalId: '111:launcherStart1',
      proof: 'process_start',
    });
    controller.reserveBinding('w2-leaf', worker2);
    const recoveredLeaf = controller.bindRuntime(
      'w2-leaf',
      worker2,
      {
        backend: 'tmux',
        physicalId: '222:leafStart1',
        nativeSessionId: '019a0000-0000-7000-8000-000000000099',
        proof: 'process_start',
      },
      undefined,
      'w2-launcher',
    );
    expect(recoveredLeaf.ref).toEqual(leaf1.ref);
    expect(store.authorizeExecutionObserver(ref, worker2, execution)).toBe(true);

    // Historical launcher1 runtime cannot grant managed_turn_origin (observer is terminal-only).
    expect(
      controller.ingest(
        {
          type: 'managed_turn_origin',
          sessionId: ref.sessionId,
          capability: 'cap-historical-launcher',
          turnId,
          sessionContract: {
            version: 2,
            session: ref,
            producer: worker2,
            eventId: `${worker2.workerId}:1`,
            sequence: 1,
            scope: { runtime: launcher1, execution },
          },
        },
        worker2,
      ),
    ).toEqual({ kind: 'reject', reason: 'runtime_producer_unproven' });

    // Recovered active leaf runtime DOES admit managed_turn_origin while the turn is still live!
    expect(
      controller.ingest(
        {
          type: 'managed_turn_origin',
          sessionId: ref.sessionId,
          capability: 'cap-active-leaf',
          turnId,
          sessionContract: {
            version: 2,
            session: ref,
            producer: worker2,
            bindingId: 'w2-leaf',
            eventId: `${worker2.workerId}:2`,
            sequence: 2,
            scope: { runtime: recoveredLeaf.ref, execution },
          },
        },
        worker2,
      ),
    ).toMatchObject({ kind: 'current' });

    // Once the historical execution settles via observer turn_terminal, even active leaf rejects new origin claims!
    expect(
      controller.ingest(
        {
          type: 'turn_terminal',
          sessionId: ref.sessionId,
          turnId,
          status: 'completed',
          sessionContract: {
            version: 2,
            session: ref,
            producer: worker2,
            eventId: `${worker2.workerId}:3`,
            sequence: 3,
            scope: { runtime: launcher1, execution },
          },
        },
        worker2,
      ),
    ).toMatchObject({ kind: 'historical' });
    expect(
      controller.ingest(
        {
          type: 'managed_turn_origin',
          sessionId: ref.sessionId,
          capability: 'cap-after-terminal',
          turnId,
          sessionContract: {
            version: 2,
            session: ref,
            producer: worker2,
            bindingId: 'w2-leaf',
            eventId: `${worker2.workerId}:4`,
            sequence: 4,
            scope: { runtime: recoveredLeaf.ref, execution },
          },
        },
        worker2,
      ),
    ).toEqual({ kind: 'reject', reason: 'execution_scope_unproven' });

    // An unauthorized worker generation cannot publish origin at all.
    const rogueWorker: WorkerRef = { workerId: 'rogue-worker', generation: 99 };
    expect(
      controller.ingest(
        {
          type: 'managed_turn_origin',
          sessionId: ref.sessionId,
          capability: 'cap-rogue',
          turnId,
          sessionContract: {
            version: 2,
            session: ref,
            producer: rogueWorker,
            eventId: `${rogueWorker.workerId}:1`,
            sequence: 1,
            scope: { runtime: recoveredLeaf.ref, execution },
          },
        },
        rogueWorker,
      ),
    ).toEqual({ kind: 'reject', reason: 'runtime_producer_unproven' });
  });

  it('re-publishes managed_turn_origin on runtime_contract_assigned only while local turn authority and relay capability remain live, failing closed after local stop/revocation', async () => {
    const scope = new WorkerSessionEventScope(
      { appId: 'cli_executor_test', sessionId: 'session-executor-1' },
      { workerId: 'w2', generation: 2 },
    );
    const b1 = scope.beginRuntime(undefined, '222:leafStart1');
    const authority = new ActiveTurnAuthority();
    const turnId = 'om_reattach_overlap_1';
    authority.reserve({ turnId, dispatchAttempt: 1 });
    authority.markStarted({ turnId, dispatchAttempt: 1 });

    const publishedContexts: Array<{ bindingId?: string; executionId?: string }> = [];
    const workerGlobals: Record<string, unknown> = {
      workerSessionEventScope: scope,
      activeTurnAuthority: authority,
      retiredTurnIds: new Set<string>(),
      currentBotmuxTurnId: turnId,
      currentBotmuxDispatchAttempt: 1,
      sandboxRelayCapability: { token: 'cap-initial-unassigned', turnId, dispatchAttempt: 1 },
      publishedOriginContractScope: undefined,
      pendingRuntimeReservations: new Map(),
      pendingMessages: [],
      closeRequested: false,
      backend: null,
      retiredRuntimeBackend: null,
      restoredObserverGrantWait: { decide: () => false },
      codexBridgeDrainAndMaybeEmit: () => {},
      log: () => {},
      flushPending: async () => {},
      clearTraexContinuationGrantWait: () => {},
      abandonTraexAutoModelContinuation: () => {},
      stopBridgeWatcher: () => {},
      stopScreenshotLoop: () => {},
      killCli: () => {},
      armRetiredRuntimeExit: () => {},
      publishSandboxRelayCapability: () => {
        const ctxBinding = scope.contextBinding() ?? scope.currentBinding();
        const exec = scope.executionForTurn(turnId, 1);
        publishedContexts.push({ bindingId: ctxBinding?.bindingId, executionId: exec?.executionId });
        workerGlobals.sandboxRelayCapability = {
          token: `cap-rotated-${publishedContexts.length}`,
          turnId,
          dispatchAttempt: 1,
        };
        workerGlobals.publishedOriginContractScope = ctxBinding && exec
          ? { bindingId: ctxBinding.bindingId, executionId: exec.executionId }
          : undefined;
        return true;
      },
    };
    const handleContractDaemonMessage = loadWorkerFunction<(raw: unknown) => Promise<void>>(
      'handleContractDaemonMessage',
      workerGlobals,
    );

    const exec = { executionId: 'exec-live-1', turnId, dispatchAttempt: 1 };
    const runtime1 = { runtimeId: 'rt-1', epoch: 1 };
    await handleContractDaemonMessage({
      type: 'runtime_contract_assigned',
      bindingId: b1.bindingId,
      runtime: runtime1,
      mayExecute: true,
      admissionStates: [{ ref: exec, phase: 'running' }],
      executions: [],
      observedExecutions: [{ runtime: runtime1, execution: exec }],
    });
    expect(publishedContexts).toEqual([{ bindingId: b1.bindingId, executionId: 'exec-live-1' }]);

    // Duplicate assignment on the same (bindingId, executionId) is idempotent.
    await handleContractDaemonMessage({
      type: 'runtime_contract_assigned',
      bindingId: b1.bindingId,
      runtime: runtime1,
      mayExecute: true,
      admissionStates: [{ ref: exec, phase: 'running' }],
      executions: [exec],
      observedExecutions: [],
    });
    expect(publishedContexts).toHaveLength(1);

    // Adversarial overlap: local `/stop`, `/new`, or `prompt_ready` revokes sandboxRelayCapability
    // and clears activeTurnAuthority BEFORE a delayed `runtime_contract_assigned` for binding b2
    // arrives carrying a stale `phase: 'running'` snapshot while `currentBotmuxTurnId` is still set.
    const b2 = scope.beginRuntime(undefined, '222:leafStart1');
    authority.clear();
    workerGlobals.sandboxRelayCapability = null;
    workerGlobals.publishedOriginContractScope = undefined;

    await handleContractDaemonMessage({
      type: 'runtime_contract_assigned',
      bindingId: b2.bindingId,
      runtime: { runtimeId: 'rt-2', epoch: 2 },
      mayExecute: true,
      admissionStates: [{ ref: exec, phase: 'running' }],
      executions: [exec],
      observedExecutions: [],
    });
    expect(publishedContexts).toHaveLength(1);
    expect(workerGlobals.sandboxRelayCapability).toBeNull();
  });
});

describe('runtime_contract_assigned re-publication fails closed on each stale-turn signal', () => {
  const turnId = 'om_reattach_guard_1';
  const exec = { executionId: 'exec-guard-1', turnId, dispatchAttempt: 1 };
  const runtime1 = { runtimeId: 'rt-guard-1', epoch: 1 };
  function harness() {
    const scope = new WorkerSessionEventScope(
      { appId: 'cli_executor_test', sessionId: 'session-executor-1' },
      { workerId: 'w2', generation: 2 },
    );
    const older = scope.beginRuntime(undefined, '222:leafStart1');
    const current = scope.beginRuntime(undefined, '222:leafStart1');
    const authority = new ActiveTurnAuthority();
    authority.reserve({ turnId, dispatchAttempt: 1 });
    authority.markStarted({ turnId, dispatchAttempt: 1 });
    const published: Array<string | undefined> = [];
    const globals: Record<string, unknown> = {
      workerSessionEventScope: scope,
      activeTurnAuthority: authority,
      retiredTurnIds: new Set<string>(),
      currentBotmuxTurnId: turnId,
      currentBotmuxDispatchAttempt: 1,
      sandboxRelayCapability: { token: 'cap-live', turnId, dispatchAttempt: 1 },
      publishedOriginContractScope: undefined,
      pendingRuntimeReservations: new Map(),
      pendingMessages: [],
      closeRequested: false,
      backend: null,
      retiredRuntimeBackend: null,
      restoredObserverGrantWait: { decide: () => false },
      codexBridgeDrainAndMaybeEmit: () => {},
      log: () => {},
      flushPending: async () => {},
      clearTraexContinuationGrantWait: () => {},
      abandonTraexAutoModelContinuation: () => {},
      stopBridgeWatcher: () => {},
      stopScreenshotLoop: () => {},
      killCli: () => {},
      armRetiredRuntimeExit: () => {},
      publishSandboxRelayCapability: () => { published.push(scope.contextBinding()?.bindingId); return true; },
    };
    const handle = loadWorkerFunction<(raw: unknown) => Promise<void>>('handleContractDaemonMessage', globals);
    const assigned = (overrides: Record<string, unknown> = {}) => ({
      type: 'runtime_contract_assigned',
      bindingId: current.bindingId,
      runtime: runtime1,
      mayExecute: true,
      admissionStates: [{ ref: exec, runtime: runtime1, phase: 'running' }],
      executions: [exec],
      ...overrides,
    });
    return { scope, older, current, authority, published, globals, handle, assigned };
  }

  it('re-publishes the live turn under the assigned current binding (control)', async () => {
    const h = harness();
    await h.handle(h.assigned());
    expect(h.published).toEqual([h.current.bindingId]);
  });

  it.each<[string, (h: ReturnType<typeof harness>) => Record<string, unknown> | void]>([
    ['the turn was retired locally', h => { (h.globals.retiredTurnIds as Set<string>).add(turnId); }],
    ['the relay capability belongs to another turn', h => {
      h.globals.sandboxRelayCapability = { token: 'cap-other', turnId: 'om_other_turn', dispatchAttempt: 1 };
    }],
    ['the relay capability belongs to another dispatch attempt', h => {
      h.globals.sandboxRelayCapability = { token: 'cap-retry', turnId, dispatchAttempt: 2 };
    }],
    ['local turn authority moved to another turn', h => {
      h.authority.clear();
      h.authority.reserve({ turnId: 'om_other_turn', dispatchAttempt: 1 });
    }],
    ['the host retired the assigned runtime', () => ({ mayExecute: false })],
    ['the assignment answers an older binding of the same process', h => ({
      bindingId: h.older.bindingId, runtime: { runtimeId: 'rt-guard-0', epoch: 0 },
    })],
    ['the host already settled the execution', () => ({
      admissionStates: [{ ref: exec, runtime: runtime1, phase: 'succeeded' }],
    })],
  ])('does not re-publish when %s', async (_name, arrange) => {
    const h = harness();
    const overrides = arrange(h) ?? {};
    await h.handle(h.assigned(overrides));
    expect(h.published).toEqual([]);
  });
});

describe('runtimeIdentityForContract header-verified Codex fd identity', () => {
  it('takes the sole top-level id from verified rollout headers when subagent rollouts are open, only if the PID owns it', () => {
    const scope = new WorkerSessionEventScope({ appId: 'a', sessionId: 's' }, { workerId: 'w', generation: 2 });
    const parentSid = '019a0000-0000-7000-8000-111111111111';
    const subagentSid = '019a0000-0000-7000-8000-222222222222';
    const foreignSid = '019a0000-0000-7000-8000-999999999999';
    const env: Record<string, unknown> = {
      backend: { cliPid: 222 },
      codexRpcEngine: undefined,
      effectiveBackendType: 'tmux',
      lastInitConfig: { cliId: 'codex' },
      cliAdapter: {},
      workerSessionEventScope: scope,
      readProcessStartIdentity: () => 'leafStart1',
      findCodexRolloutSetByPid: () => new Set([parentSid, subagentSid]),
      findCodexRolloutByPid: () => null,
      codexHistorySidIsOwned: (sid: string, owned: ReadonlySet<string>) => owned.has(sid.toLowerCase()),
      codexGenerationSessionIdFromRolloutPath: () => undefined,
      codexBridgeRolloutPath: undefined,
      codexBridgeQueue: { peek: () => [] },
      readCodexLiveSessionId: () => parentSid,
    };
    const readIdentity = loadWorkerFunction<(b: any) => any>('runtimeIdentityForContract', env);
    // No active bridge turn: the verified header alone identifies the parent conversation.
    expect(readIdentity(scope.beginRuntime())).toEqual({
      backend: 'tmux', physicalId: '222:leafStart1', proof: 'process_start', nativeSessionId: parentSid,
    });
    // A header id the PID does not hold among its rollouts is never adopted.
    env.readCodexLiveSessionId = () => foreignSid;
    expect(readIdentity(scope.beginRuntime())).toEqual({
      backend: 'tmux', physicalId: '222:leafStart1', proof: 'process_start',
    });
  });
});

describe('refreshActiveRuntimeContract', () => {
  it('re-reports only a changed, non-opaque identity of the current physical CLI', () => {
    const scope = new WorkerSessionEventScope({ appId: 'a', sessionId: 's' }, { workerId: 'w', generation: 2 });
    const launcher = { backend: 'tmux', physicalId: '111:launcherStart1', proof: 'process_start' };
    const leaf = { backend: 'tmux', physicalId: '222:leafStart1', proof: 'process_start' };
    let next: Record<string, unknown> = launcher;
    const published: string[] = [];
    const env: Record<string, unknown> = {
      workerSessionEventScope: scope,
      runtimeIdentityForContract: () => next,
      publishRuntimeContract: (binding: { bindingId: string }) => { published.push(binding.bindingId); return Promise.resolve(); },
    };
    const refresh = loadWorkerFunction<() => void>('refreshActiveRuntimeContract', env);
    const old = scope.beginRuntime(undefined, 'pane-old');
    const active = scope.beginRuntime(undefined, 'pane-live');
    // Nothing is re-reported before the first identity was published.
    refresh();
    active.identity = { ...launcher };
    // Same identity: no churn.
    refresh();
    // An opaque observation never replaces a process proof.
    next = { backend: 'tmux', physicalId: active.physicalId, proof: 'opaque' };
    refresh();
    // A callback still running for another process must not re-report the live one.
    next = leaf;
    scope.run(old, () => refresh());
    expect(published).toEqual([]);
    // The relay resolved the real CLI behind its launcher.
    refresh();
    expect(published).toEqual([active.bindingId]);
  });
});

describe('launcher-chain recovery guards', () => {
  const sid = '019a0000-0000-7000-8000-000000000001';
  const launcher = { backend: 'tmux', physicalId: '111:launcherStart1', proof: 'process_start' as const };
  const leaf = { backend: 'tmux', physicalId: '222:leafStart1', nativeSessionId: sid, proof: 'process_start' as const };
  function restartedMidTurn() {
    const s = createFixture(sid);
    const oldExec = s.controller.admitInput('om_old_running_turn');
    expect(s.controller.ingest({
      type: 'turn_execution_started',
      turnId: 'om_old_running_turn',
      sessionContract: s.context(s.worker1, 1, { runtime: s.runtime1, execution: oldExec }),
    }, s.worker1)).toMatchObject({ kind: 'current' });
    s.controller.workerLost(s.worker1);
    const worker2 = s.controller.bindWorker(2).worker;
    const outer = s.controller.reserveBinding('w2-launcher', worker2);
    s.controller.bindRuntime('w2-launcher', worker2, launcher);
    return { s, worker2, outer };
  }

  it('declines, without refusing the binding, to recover the old leaf while a new turn is open on an outer launcher of the chain', () => {
    const { s, worker2, outer } = restartedMidTurn();
    const newExec = s.controller.admitInput('om_new_turn_on_outer_launcher');
    s.store.bindQueuedExecution(s.ref, newExec, outer);
    // session-scope launcher -> wrapper -> real CLI: two in-process hops.
    s.controller.reserveBinding('w2-wrapper', worker2);
    const wrapper = s.controller.bindRuntime('w2-wrapper', worker2,
      { backend: 'tmux', physicalId: '333:wrapperStart1', proof: 'process_start' }, undefined, 'w2-launcher');
    expect(s.store.runtimeContinues(s.ref, outer, wrapper.ref, worker2)).toBe(true);
    const leafReserved = s.controller.reserveBinding('w2-leaf', worker2);
    const leafBound = s.controller.bindRuntime('w2-leaf', worker2, leaf, undefined, 'w2-wrapper');
    expect(leafBound.ref).toEqual(leafReserved);
    expect(leafBound.ref).not.toEqual(s.runtime1);
    expect(s.store.runtimeContinues(s.ref, outer, leafBound.ref, worker2)).toBe(true);
  });

  it('refuses recovery when another process of the same worker was bound in between, outside the continuation chain', () => {
    const { s, worker2 } = restartedMidTurn();
    s.controller.reserveBinding('w2-unrelated', worker2);
    s.controller.bindRuntime('w2-unrelated', worker2, { backend: 'tmux', physicalId: '444:unrelatedStart1', proof: 'process_start' });
    const leafReserved = s.controller.reserveBinding('w2-leaf', worker2);
    const leafBound = s.controller.bindRuntime('w2-leaf', worker2, leaf, undefined, 'w2-unrelated');
    expect(leafBound.ref).toEqual(leafReserved);
    expect(leafBound.ref).not.toEqual(s.runtime1);
  });
});

describe('re-publication through the real worker and daemon paths after a launcher-bound turn survives a restart', () => {
  it('re-signs the observed turn on the recovered leaf runtime once, and the daemon restores its managed origin', async () => {
    const data = mkdtempSync(join(tmpdir(), 'reattach-real-publish-'));
    directories.push(data);
    fixtureConfig.dataDir = data;
    const sid = '019a0000-0000-7000-8000-0000000000aa';
    const launcher = { backend: 'tmux', physicalId: '111:launcherStart1', proof: 'process_start' as const };
    const leaf = { backend: 'tmux', physicalId: '222:leafStart1', nativeSessionId: sid, proof: 'process_start' as const };
    const ds: any = { larkAppId: 'cli_real_publish', chatId: 'oc_chat',
      session: { sessionId: 's-real', larkAppId: 'cli_real_publish', status: 'active', cliId: 'codex' } };
    const store = new SessionContractStore(data, ds.larkAppId);
    handles.push(store);
    const controller = new SessionController(ds, store);
    // Worker 1 started the turn on the launcher binding, then resolved the leaf in process.
    const worker1 = controller.bindWorker(1).worker;
    const launcher1 = controller.reserveBinding('w1-launcher', worker1);
    controller.bindRuntime('w1-launcher', worker1, launcher);
    const turnId = 'om_launcher_bound_turn';
    const execution = controller.admitInput(turnId);
    expect(controller.ingest({ type: 'turn_execution_started', turnId, sessionContract: { version: 2, session: controller.ref,
      producer: worker1, bindingId: 'w1-launcher', eventId: `${worker1.workerId}:1`, sequence: 1,
      scope: { runtime: launcher1, execution } } } as any, worker1)).toMatchObject({ kind: 'current' });
    controller.reserveBinding('w1-leaf', worker1);
    const leaf1 = controller.bindRuntime('w1-leaf', worker1, leaf, undefined, 'w1-launcher');
    controller.workerLost(worker1);
    const worker2 = controller.bindWorker(2).worker;

    // Daemon side: the production runtime_binding / managed_turn_origin handlers.
    const toWorker: any[] = [];
    const daemonWorker: any = { pid: 90, connected: true, killed: false,
      send: (message: any, callback?: (error: null) => void) => { toWorker.push(message); callback?.(null); return true; } };
    ds.worker = daemonWorker;
    const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const hostEnv: any = { ds, worker: daemonWorker, sessionController: controller, contractWorker: worker2, botCfg: {},
      sessionCliId: () => 'codex', logger, t: 'real-publish', sameWorker, sameTrustedPrincipal,
      currentGatewayCallerOpenId: () => undefined, currentTurnProcessIdentities: () => ['222:leafStart1'],
      noteTurnDispatchAttempt: vi.fn(), ensureAutomaticTaskContinuationLease: vi.fn() };
    hostEnv.handleLegacyWorkerMessage = loadWorkerPoolClosure('handleLegacyWorkerMessage', hostEnv);
    const host = loadWorkerPoolClosure<(message: any) => Promise<void>>('handleWorkerMessage', hostEnv);
    hostEnv.handleWorkerMessage = host;

    // Worker 2 side: production send / metadata / publication / IPC handler.
    const scope = new WorkerSessionEventScope(controller.ref, worker2);
    const authority = new ActiveTurnAuthority();
    authority.reserve({ turnId });
    authority.markStarted({ turnId });
    const wire: any[] = [];
    const pending: Promise<void>[] = [];
    const env: Record<string, any> = {
      workerSessionEventScope: scope, activeTurnAuthority: authority, sessionId: 's-real', lastInitConfig: { cliId: 'codex' },
      currentBotmuxTurnId: turnId, currentBotmuxDispatchAttempt: undefined, retiredTurnIds: new Set<string>(),
      sandboxRelayCapability: { token: 'cap-restored-from-marker', turnId }, publishedOriginContractScope: undefined,
      writeCliPidMarker: vi.fn(), parseDaemonIpcPort: () => 7956, randomBytes, frozenTurnLinkRefMode: () => undefined,
      isWorkflowWorker: () => false, pendingRuntimeReservations: new Map(), pendingMessages: [], closeRequested: false,
      backend: null, retiredRuntimeBackend: null, restoredObserverGrantWait: { decide: () => false },
      codexBridgeDrainAndMaybeEmit: () => {}, log: () => {}, flushPending: async () => {},
      clearTraexContinuationGrantWait: () => {}, abandonTraexAutoModelContinuation: () => {},
      stopBridgeWatcher: () => {}, stopScreenshotLoop: () => {}, killCli: () => {}, armRetiredRuntimeExit: () => {},
      process: { env: {}, send: (message: any) => { wire.push(message); pending.push(host(message)); } },
    };
    for (const name of ['workerIpcPayload', 'send', 'publishSandboxRelayCapability']) env[name] = loadWorkerFunction(name, env);
    const handleContract = loadWorkerFunction<(raw: unknown) => Promise<void>>('handleContractDaemonMessage', env);
    const drain = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
    const register = async (identity: Record<string, unknown>, continuesBindingId?: string) => {
      const binding = scope.beginRuntime(undefined, 'pane-1');
      binding.identity = identity as any;
      await scope.run(binding, async () => {
        env.send({ type: 'runtime_binding_started', bindingId: binding.bindingId });
        await drain();
        env.send({ type: 'runtime_binding', bindingId: binding.bindingId, identity,
          ...(continuesBindingId ? { continuesBindingId } : {}) });
        await drain();
      });
      const assigned = toWorker.filter(message => message.type === 'runtime_contract_assigned' && message.bindingId === binding.bindingId).at(-1);
      expect(assigned).toBeDefined();
      return { binding, assigned };
    };

    const outer = await register(launcher);
    await handleContract(outer.assigned);
    await drain();
    const inner = await register(leaf, outer.binding.bindingId);
    expect(inner.assigned.runtime).toEqual(leaf1.ref);
    expect(inner.assigned.observedExecutions).toEqual([{ runtime: launcher1, execution }]);
    wire.length = 0;
    await handleContract(inner.assigned);
    await drain();
    const origins = wire.filter(message => message.type === 'managed_turn_origin');
    expect(origins).toHaveLength(1);
    expect(origins[0].sessionContract).toMatchObject({ bindingId: inner.binding.bindingId,
      scope: { runtime: leaf1.ref, execution } });
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(/Dropped managed_turn_origin/));
    expect(ds.managedTurnOrigin).toMatchObject({ turnId, capability: origins[0].capability });

    // A duplicate assignment for the same binding and execution does not rotate the capability again.
    await handleContract(inner.assigned);
    await drain();
    expect(wire.filter(message => message.type === 'managed_turn_origin')).toHaveLength(1);
  });
});
