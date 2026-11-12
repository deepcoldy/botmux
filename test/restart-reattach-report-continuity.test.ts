import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionController } from '../src/core/session-controller.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
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
import type { DaemonSession } from '../src/core/types.js';
import type { WorkerRef } from '../src/services/session-contract.js';

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
