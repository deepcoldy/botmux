import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { validateDag } from '../src/workflows/v3/dag.js';
import { readWait, resolveWait } from '../src/workflows/v3/human-gate.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { writeV3HostSuccessArtifacts } from '../src/workflows/v3/host-execution.js';
import { readAndValidateManifest, ManifestValidationError } from '../src/workflows/v3/manifest.js';
import {
  latestAttemptIdFor,
  nextAttemptIdFor,
  runWorkflow,
  type V3RuntimeDeps,
} from '../src/workflows/v3/runtime.js';
import type { HostExecutorRegistry } from '../src/workflows/hostExecutors/registry.js';
import type { ProviderReconciler } from '../src/workflows/shared/provider-reconciler.js';

function dag(runId: string) {
  return validateDag({
    runId,
    nodes: [{
      id: 'send',
      type: 'host',
      executor: 'feishu-send',
      input: {
        larkAppId: { $ref: 'context.larkAppId' },
        chatId: { $ref: 'context.chatId' },
        content: 'hello ${params.name}',
      },
      depends: [],
      inputs: [],
      humanGate: { prompt: 'Send this message?' },
    }],
  });
}

const validateManifest: V3RuntimeDeps['validateManifest'] = async (manifestPath, outputDir) => {
  try {
    return { ok: true, manifest: await readAndValidateManifest(manifestPath, outputDir) };
  } catch (err) {
    return { ok: false, problems: err instanceof ManifestValidationError ? err.problems : [String(err)] };
  }
};

function fakeRegistry(invoke: (input: any, key: string) => Promise<any>): HostExecutorRegistry {
  return new Map([['feishu-send', {
    parseInput(value: unknown) {
      const v = value as any;
      if (!v || typeof v.larkAppId !== 'string' || typeof v.chatId !== 'string' || typeof v.content !== 'string') {
        throw new Error('invalid fake send input');
      }
      return { larkAppId: v.larkAppId, chatId: v.chatId, content: v.content };
    },
    executor: {
      provider: 'feishu-im',
      idempotencyTtlMs: 3_600_000,
      canonicalInput: (input: any) => input,
      invoke,
    },
  }]]);
}

function deps(hostExecutors: HostExecutorRegistry, hostReconcilers = new Map<string, ProviderReconciler>()): V3RuntimeDeps {
  return {
    runNode: async () => { throw new Error('host DAG must never spawn a goal worker'); },
    validateManifest,
    resolveBotSnapshot: () => { throw new Error('host DAG must not resolve a bot'); },
    hostExecutors,
    hostReconcilers,
  };
}

const runtimeData = {
  params: { name: 'Ada' },
  context: { larkAppId: 'cli_test', chatId: 'oc_test' },
};

const approveGate: NonNullable<V3RuntimeDeps['resolveGate']> = async () => ({
  resolution: 'approved', by: 'ou_user', selected: 'approve',
});

describe('v3 host runtime', () => {
  it('freezes before gate and invokes only after approval, without worker dispatch/fence', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-runtime-'));
    try {
      const invoke = vi.fn(async (_input: unknown, _key: string) => ({
        output: { messageId: 'om_1' }, externalRefs: { messageId: 'om_1' },
      }));
      const workflow = dag('host-happy');
      const first = await runWorkflow(workflow, deps(fakeRegistry(invoke)), {
        baseDir: base, gateMode: 'suspend', resolvedWorkflowData: runtimeData,
      });
      expect(first.reason).toBe('awaitingGate');
      expect(invoke).not.toHaveBeenCalled();
      const runDir = join(base, 'host-happy');
      const wait = readWait(runDir, 'send#001-host-001-gate')!;
      expect(wait.prompt).toContain('Frozen input hash');
      expect(wait.prompt).toContain('hello Ada');
      expect(wait.hostApproval?.inputHash).toMatch(/^sha256:/);

      resolveWait(runDir, wait.waitId, 'approved', 'ou_user', 'approve');
      appendEvent(join(runDir, 'journal.ndjson'), {
        type: 'gateResolved', nodeId: 'send', instanceId: 'send#001', waitId: wait.waitId,
        resolution: 'approved', by: 'ou_user', selected: 'approve', hostApproval: wait.hostApproval,
      });
      const second = await runWorkflow(workflow, deps(fakeRegistry(invoke)), {
        baseDir: base, gateMode: 'suspend', resolvedWorkflowData: runtimeData,
      });
      expect(second).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      expect(invoke).toHaveBeenCalledTimes(1);
      const events = readJournal(join(runDir, 'journal.ndjson'));
      const types = events.map((event) => event.type);
      expect(types.indexOf('hostInputPrepared')).toBeLessThan(types.indexOf('gateDispatched'));
      expect(types.indexOf('gateResolved')).toBeLessThan(types.indexOf('hostEffectIntent'));
      expect(types.indexOf('hostEffectIntent')).toBeLessThan(types.indexOf('nodeSucceeded'));
      expect(events.some((event) => event.type === 'nodeDispatched')).toBe(false);
      expect(events.some((event) => event.type === 'nodeWorkerFenceArmed')).toBe(false);
      const result = JSON.parse(readFileSync(
        join(runDir, 'send#001', 'attempts', '001', 'work', 'result.json'), 'utf-8',
      ));
      expect(result.output).toEqual({ messageId: 'om_1' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('provider crash after intent reconciles with the same input/key', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-reconcile-'));
    try {
      let invokedKey = '';
      const invoke = vi.fn(async (_input: unknown, key: string) => {
        invokedKey = key;
        throw new Error('connection reset after submit');
      });
      const submit = vi.fn(async (key: string, input: unknown) => ({
        ok: true as const,
        externalRefs: { messageId: 'om_recovered' },
        evidence: { key, input },
      }));
      const reconciler: ProviderReconciler = {
        provider: 'feishu-im',
        requiresEffectInput: true,
        canonicalInput: (input) => input,
        idempotentSubmit: submit,
      };
      const resolveGate: NonNullable<V3RuntimeDeps['resolveGate']> = async () => ({
        resolution: 'approved', by: 'ou_user', selected: 'approve',
      });
      const outcome = await runWorkflow(
        dag('host-reconcile'),
        { ...deps(fakeRegistry(invoke), new Map([['feishu-im', reconciler]])), resolveGate },
        { baseDir: base, gateMode: 'blocking', resolvedWorkflowData: runtimeData },
      );
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0]![0]).toBe(invokedKey);
      const intents = readJournal(join(base, 'host-reconcile', 'journal.ndjson'))
        .filter((event) => event.type === 'hostEffectIntent');
      expect(intents).toHaveLength(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('treats a read-only lookup miss as uncertain instead of re-invoking the executor', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-lookup-miss-'));
    try {
      const invoke = vi.fn(async () => {
        throw new Error('crash after provider may have accepted request');
      });
      const lookup = vi.fn(async () => ({ found: false as const }));
      const reconciler: ProviderReconciler = {
        provider: 'feishu-im',
        requiresEffectInput: true,
        canonicalInput: (input) => input,
        readOnlyLookup: lookup,
      };
      const outcome = await runWorkflow(
        dag('host-lookup-miss'),
        {
          ...deps(fakeRegistry(invoke), new Map([['feishu-im', reconciler]])),
          resolveGate: approveGate,
        },
        { baseDir: base, gateMode: 'blocking', resolvedWorkflowData: runtimeData },
      );
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'blocked' });
      expect(invoke).toHaveBeenCalledOnce();
      expect(lookup).toHaveBeenCalledOnce();
      expect(readJournal(join(base, 'host-lookup-miss', 'journal.ndjson'))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'hostEffectUncertain',
            errorCode: 'HOST_EFFECT_LOOKUP_MISS_UNCERTAIN',
          }),
        ]),
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('settles the authored node when input preparation fails before any gate dispatch', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-prepare-fail-'));
    try {
      const invoke = vi.fn(async () => ({ output: {}, externalRefs: {} }));
      await expect(runWorkflow(dag('host-prepare-fail'), deps(fakeRegistry(invoke)), {
        baseDir: base,
        gateMode: 'suspend',
        resolvedWorkflowData: { params: {}, context: {} },
      })).resolves.toMatchObject({ reason: 'terminal', runStatus: 'failed' });
      expect(invoke).not.toHaveBeenCalled();
      const events = readJournal(join(base, 'host-prepare-fail', 'journal.ndjson'));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'nodeFailed',
          nodeId: 'send',
          errorCode: 'HOST_INPUT_PREPARE_FAILED',
        }),
      ]));
      expect(events.some((event) => event.type === 'gateDispatched')).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('blocks a malformed crash-left sidecar, then retries through fresh attempt 002', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-crash-left-invalid-'));
    try {
      const runId = 'host-crash-left-invalid';
      const runDir = join(base, runId);
      const attemptDir = join(runDir, 'send#001', 'attempts', '001');
      mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(attemptDir, 'host-input.json'), '{"partial":', { mode: 0o600 });
      const registry = fakeRegistry(async () => ({ output: {}, externalRefs: {} }));

      await expect(runWorkflow(dag(runId), deps(registry), {
        baseDir: base,
        gateMode: 'suspend',
        resolvedWorkflowData: runtimeData,
      })).resolves.toMatchObject({ reason: 'terminal', runStatus: 'blocked' });
      const journalPath = join(runDir, 'journal.ndjson');
      const blockedEvents = readJournal(journalPath);
      const previousAttemptId = latestAttemptIdFor(blockedEvents, 'send#001');
      const nextAttemptId = nextAttemptIdFor(blockedEvents, 'send#001');
      expect(previousAttemptId).toBe('send#001/attempts/001');
      expect(nextAttemptId).toBe('send#001/attempts/002');
      expect(blockedEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'nodeBlocked',
          attemptId: previousAttemptId,
          errorCode: 'HOST_INPUT_UNRECOVERABLE',
        }),
      ]));

      appendEvent(journalPath, {
        type: 'nodeRetryRequested',
        nodeId: 'send',
        instanceId: 'send#001',
        previousAttemptId: previousAttemptId!,
        nextAttemptId,
        reason: 'blockedRetry',
        previousErrorClass: 'resultInvalid',
        previousErrorCode: 'HOST_INPUT_UNRECOVERABLE',
        resetGate: true,
      });
      await expect(runWorkflow(dag(runId), deps(registry), {
        baseDir: base,
        gateMode: 'suspend',
        resolvedWorkflowData: runtimeData,
      })).resolves.toMatchObject({
        reason: 'awaitingGate',
        pendingWaits: [expect.objectContaining({ waitId: 'send#001-host-002-gate' })],
      });
      expect(readFileSync(
        join(runDir, 'send#001', 'attempts', '002', 'host-input.json'),
        'utf-8',
      )).toContain('hello Ada');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('blocks without invoking when the frozen input is tampered after approval', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-tamper-'));
    try {
      const invoke = vi.fn(async () => ({
        output: { messageId: 'must-not-send' }, externalRefs: { messageId: 'must-not-send' },
      }));
      const workflow = dag('host-tamper');
      await runWorkflow(workflow, deps(fakeRegistry(invoke)), {
        baseDir: base, gateMode: 'suspend', resolvedWorkflowData: runtimeData,
      });
      const runDir = join(base, 'host-tamper');
      const wait = readWait(runDir, 'send#001-host-001-gate')!;
      resolveWait(runDir, wait.waitId, 'approved', 'ou_user', 'approve');
      appendEvent(join(runDir, 'journal.ndjson'), {
        type: 'gateResolved', nodeId: 'send', instanceId: 'send#001', waitId: wait.waitId,
        resolution: 'approved', by: 'ou_user', selected: 'approve', hostApproval: wait.hostApproval,
      });
      writeFileSync(
        join(runDir, 'send#001', 'attempts', '001', 'host-input.json'),
        '{"tampered":true}\n',
      );

      await expect(runWorkflow(workflow, deps(fakeRegistry(invoke)), {
        baseDir: base, gateMode: 'suspend', resolvedWorkflowData: runtimeData,
      })).resolves.toMatchObject({ reason: 'terminal', runStatus: 'blocked' });
      expect(invoke).not.toHaveBeenCalled();
      expect(readJournal(join(runDir, 'journal.ndjson'))).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'nodeBlocked',
          nodeId: 'send',
          errorCode: 'HOST_INPUT_UNRECOVERABLE',
        }),
      ]));

      appendEvent(join(runDir, 'journal.ndjson'), {
        type: 'nodeRetryRequested',
        nodeId: 'send',
        instanceId: 'send#001',
        previousAttemptId: 'send#001/attempts/001',
        nextAttemptId: 'send#001/attempts/002',
        reason: 'blockedRetry',
        previousErrorClass: 'resultInvalid',
        previousErrorCode: 'HOST_INPUT_UNRECOVERABLE',
        resetGate: true,
      });
      const retry = await runWorkflow(workflow, deps(fakeRegistry(invoke)), {
        baseDir: base, gateMode: 'suspend', resolvedWorkflowData: runtimeData,
      });
      expect(retry).toMatchObject({
        reason: 'awaitingGate',
        pendingWaits: [expect.objectContaining({ waitId: 'send#001-host-002-gate' })],
      });
      const retryWait = readWait(runDir, 'send#001-host-002-gate')!;
      expect(retryWait.status).toBe('pending');
      resolveWait(runDir, retryWait.waitId, 'approved', 'ou_user', 'approve');
      appendEvent(join(runDir, 'journal.ndjson'), {
        type: 'gateResolved',
        nodeId: 'send',
        instanceId: 'send#001',
        waitId: retryWait.waitId,
        resolution: 'approved',
        by: 'ou_user',
        selected: 'approve',
        hostApproval: retryWait.hostApproval,
      });
      await expect(runWorkflow(workflow, deps(fakeRegistry(invoke)), {
        baseDir: base, gateMode: 'suspend', resolvedWorkflowData: runtimeData,
      })).resolves.toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rechecks a time-sensitive frozen input before intent and retries through a fresh gate', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-preflight-stale-'));
    try {
      const invoke = vi.fn(async () => ({
        output: { messageId: 'om_fresh' }, externalRefs: { messageId: 'om_fresh' },
      }));
      const registry = fakeRegistry(invoke);
      registry.get('feishu-send')!.executor.validateBeforeIntent = (_input, nowMs) =>
        nowMs >= 2_000
          ? {
              ok: false,
              errorCode: 'HOST_SCHEDULE_APPROVAL_STALE',
              message: 'approved schedule is stale',
            }
          : { ok: true };
      const workflow = dag('host-preflight-stale');
      await runWorkflow(workflow, deps(registry), {
        baseDir: base, gateMode: 'suspend', resolvedWorkflowData: runtimeData,
      });
      const runDir = join(base, 'host-preflight-stale');
      const wait = readWait(runDir, 'send#001-host-001-gate')!;
      resolveWait(runDir, wait.waitId, 'approved', 'ou_user', 'approve');
      appendEvent(join(runDir, 'journal.ndjson'), {
        type: 'gateResolved', nodeId: 'send', instanceId: 'send#001', waitId: wait.waitId,
        resolution: 'approved', by: 'ou_user', selected: 'approve', hostApproval: wait.hostApproval,
      });

      await expect(runWorkflow(workflow, { ...deps(registry), now: () => 2_000 }, {
        baseDir: base, gateMode: 'suspend', resolvedWorkflowData: runtimeData,
      })).resolves.toMatchObject({ reason: 'terminal', runStatus: 'blocked' });
      expect(invoke).not.toHaveBeenCalled();
      const events = readJournal(join(runDir, 'journal.ndjson'));
      expect(events.some((event) => event.type === 'hostEffectIntent')).toBe(false);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'nodeBlocked',
          errorCode: 'HOST_SCHEDULE_APPROVAL_STALE',
        }),
      ]));

      appendEvent(join(runDir, 'journal.ndjson'), {
        type: 'nodeRetryRequested',
        nodeId: 'send',
        instanceId: 'send#001',
        previousAttemptId: 'send#001/attempts/001',
        nextAttemptId: 'send#001/attempts/002',
        reason: 'blockedRetry',
        previousErrorClass: 'resultInvalid',
        previousErrorCode: 'HOST_SCHEDULE_APPROVAL_STALE',
        resetGate: true,
      });
      await expect(runWorkflow(workflow, { ...deps(registry), now: () => 0 }, {
        baseDir: base, gateMode: 'suspend', resolvedWorkflowData: runtimeData,
      })).resolves.toMatchObject({
        reason: 'awaitingGate',
        pendingWaits: [expect.objectContaining({ waitId: 'send#001-host-002-gate' })],
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('never invokes a host provider when cancellation wins before intent', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-cancel-before-'));
    try {
      const invoke = vi.fn(async () => ({ output: {}, externalRefs: {} }));
      const controller = new AbortController();
      controller.abort('cancel before host preparation');
      await expect(runWorkflow(dag('host-cancel-before'), deps(fakeRegistry(invoke)), {
        baseDir: base,
        gateMode: 'blocking',
        resolvedWorkflowData: runtimeData,
        cancelSignal: controller.signal,
      })).resolves.toMatchObject({ reason: 'terminal', runStatus: 'cancelled' });
      expect(invoke).not.toHaveBeenCalled();
      const events = readJournal(join(base, 'host-cancel-before', 'journal.ndjson'));
      expect(events.some((event) => event.type === 'hostEffectIntent')).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('reconciles an intent with the same key before completing cancellation', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-cancel-reconcile-'));
    try {
      const controller = new AbortController();
      let firstKey = '';
      const invoke = vi.fn(async (_input: unknown, key: string) => {
        firstKey = key;
        controller.abort('cancel after durable intent');
        throw new Error('response lost after submit');
      });
      const submit = vi.fn(async (key: string) => ({
        ok: true as const,
        externalRefs: { messageId: 'om_applied' },
      }));
      const reconciler: ProviderReconciler = {
        provider: 'feishu-im',
        requiresEffectInput: true,
        canonicalInput: (input) => input,
        idempotentSubmit: submit,
      };
      const outcome = await runWorkflow(
        dag('host-cancel-reconcile'),
        {
          ...deps(fakeRegistry(invoke), new Map([['feishu-im', reconciler]])),
          resolveGate: approveGate,
        },
        {
          baseDir: base,
          gateMode: 'blocking',
          resolvedWorkflowData: runtimeData,
          cancelSignal: controller.signal,
        },
      );
      expect(outcome).toMatchObject({
        reason: 'terminal', runStatus: 'cancelled', uncertainHostEffects: undefined,
      });
      expect(submit).toHaveBeenCalledOnce();
      expect(submit.mock.calls[0]![0]).toBe(firstKey);
      const events = readJournal(join(base, 'host-cancel-reconcile', 'journal.ndjson'));
      expect(events.findIndex((event) => event.type === 'nodeSucceeded'))
        .toBeLessThan(events.findIndex((event) => event.type === 'runCancelled'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('does not let a never-settling original provider promise pin cancellation forever', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-cancel-hung-'));
    try {
      const controller = new AbortController();
      const invoke = vi.fn(async () => {
        setTimeout(() => controller.abort('cancel hung provider'), 10);
        return await new Promise<never>(() => {});
      });
      const submit = vi.fn(async () => ({
        ok: true as const,
        externalRefs: { messageId: 'om_reconciled' },
      }));
      const reconciler: ProviderReconciler = {
        provider: 'feishu-im',
        requiresEffectInput: true,
        canonicalInput: (input) => input,
        idempotentSubmit: submit,
      };
      const outcome = await runWorkflow(
        dag('host-cancel-hung'),
        {
          ...deps(fakeRegistry(invoke), new Map([['feishu-im', reconciler]])),
          resolveGate: approveGate,
        },
        {
          baseDir: base,
          gateMode: 'blocking',
          resolvedWorkflowData: runtimeData,
          cancelSignal: controller.signal,
        },
      );
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'cancelled' });
      expect(submit).toHaveBeenCalledOnce();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('clears the referenced original-provider deadline once reconciliation closes the effect', async () => {
    vi.useFakeTimers();
    const base = mkdtempSync(join(tmpdir(), 'v3-host-deadline-detach-'));
    try {
      const controller = new AbortController();
      const invoke = vi.fn(async () => {
        controller.abort('cancel while original SDK response is hung');
        return await new Promise<never>(() => {});
      });
      const reconciler: ProviderReconciler = {
        provider: 'feishu-im',
        requiresEffectInput: true,
        canonicalInput: (input) => input,
        idempotentSubmit: async () => ({
          ok: true as const,
          externalRefs: { messageId: 'om_reconciled' },
        }),
      };
      const outcome = await runWorkflow(
        dag('host-deadline-detach'),
        {
          ...deps(fakeRegistry(invoke), new Map([['feishu-im', reconciler]])),
          resolveGate: approveGate,
        },
        {
          baseDir: base,
          gateMode: 'blocking',
          resolvedWorkflowData: runtimeData,
          cancelSignal: controller.signal,
          hostResponseWaitMs: 60_000,
        },
      );
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'cancelled' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('detaches a never-settling SDK response and reconciles the open intent without cancellation', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-hung-reconcile-'));
    try {
      const invoke = vi.fn(async () => await new Promise<never>(() => {}));
      const submit = vi.fn(async () => ({
        ok: true as const,
        externalRefs: { messageId: 'om_reconciled' },
      }));
      const reconciler: ProviderReconciler = {
        provider: 'feishu-im',
        requiresEffectInput: true,
        canonicalInput: (input) => input,
        idempotentSubmit: submit,
      };
      const outcome = await runWorkflow(
        dag('host-hung-reconcile'),
        {
          ...deps(fakeRegistry(invoke), new Map([['feishu-im', reconciler]])),
          resolveGate: approveGate,
        },
        {
          baseDir: base,
          gateMode: 'blocking',
          resolvedWorkflowData: runtimeData,
          hostResponseWaitMs: 10,
        },
      );
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      expect(invoke).toHaveBeenCalledOnce();
      expect(submit).toHaveBeenCalledOnce();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('durably backs off retryable reconciliation instead of hot-looping the provider', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-reconcile-backoff-'));
    try {
      const invoke = vi.fn(async () => {
        throw new Error('response lost after provider submit');
      });
      const submit = vi.fn()
        .mockResolvedValueOnce({
          ok: false as const,
          errorClass: 'retryable' as const,
          errorCode: 'RATE_LIMITED',
          errorMessage: 'retry later',
        })
        .mockResolvedValueOnce({
          ok: true as const,
          externalRefs: { messageId: 'om_after_backoff' },
        });
      const reconciler: ProviderReconciler = {
        provider: 'feishu-im',
        requiresEffectInput: true,
        canonicalInput: (input) => input,
        idempotentSubmit: submit,
      };
      let now = Date.now();
      const outcome = await runWorkflow(
        dag('host-reconcile-backoff'),
        {
          ...deps(fakeRegistry(invoke), new Map([['feishu-im', reconciler]])),
          resolveGate: approveGate,
          // Advance the evidence clock between scheduler ticks so this test
          // observes one durable defer without waiting for the full backoff.
          now: () => (now += 10_000),
        },
        { baseDir: base, gateMode: 'blocking', resolvedWorkflowData: runtimeData },
      );
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
      expect(submit).toHaveBeenCalledTimes(2);
      const events = readJournal(join(base, 'host-reconcile-backoff', 'journal.ndjson'));
      expect(events.filter((event) => event.type === 'hostEffectRetryDeferred')).toEqual([
        expect.objectContaining({ retryCount: 1, errorCode: 'RATE_LIMITED' }),
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('bounds retryable provider recovery and becomes uncertain after ten deferrals', async () => {
    vi.useFakeTimers();
    const base = mkdtempSync(join(tmpdir(), 'v3-host-retry-budget-'));
    try {
      const invoke = vi.fn(async () => { throw new Error('response lost'); });
      const submit = vi.fn(async () => ({
        ok: false as const,
        errorClass: 'retryable' as const,
        errorCode: 'RATE_LIMITED',
        errorMessage: 'retry later',
      }));
      const reconciler: ProviderReconciler = {
        provider: 'feishu-im',
        requiresEffectInput: true,
        canonicalInput: (input) => input,
        idempotentSubmit: submit,
      };
      let evidenceNow = Date.now() + 10_000;
      const running = runWorkflow(
        dag('host-retry-budget'),
        {
          ...deps(fakeRegistry(invoke), new Map([['feishu-im', reconciler]])),
          resolveGate: approveGate,
          now: () => (evidenceNow += 70_000),
        },
        { baseDir: base, gateMode: 'blocking', resolvedWorkflowData: runtimeData },
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(running).resolves.toMatchObject({ reason: 'terminal', runStatus: 'blocked' });
      const events = readJournal(join(base, 'host-retry-budget', 'journal.ndjson'));
      expect(events.filter((event) => event.type === 'hostEffectRetryDeferred')).toHaveLength(10);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'hostEffectUncertain',
          errorCode: 'HOST_EFFECT_RETRY_BUDGET_EXHAUSTED',
        }),
      ]));
      expect(submit).toHaveBeenCalledTimes(11);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('does not let a persisted retry deadline delay a later cancellation', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-defer-cancel-'));
    try {
      const controller = new AbortController();
      const invoke = vi.fn(async () => {
        throw new Error('response lost');
      });
      const submit = vi.fn(async () => ({
        ok: false as const,
        errorClass: 'retryable' as const,
        errorCode: 'RATE_LIMITED',
        errorMessage: 'retry later',
      }));
      const reconciler: ProviderReconciler = {
        provider: 'feishu-im',
        requiresEffectInput: true,
        canonicalInput: (input) => input,
        idempotentSubmit: submit,
      };
      const evidenceNow = Date.now() + 10_000;
      const journalPath = join(base, 'host-defer-cancel', 'journal.ndjson');
      const running = runWorkflow(
        dag('host-defer-cancel'),
        {
          ...deps(fakeRegistry(invoke), new Map([['feishu-im', reconciler]])),
          resolveGate: approveGate,
          now: () => evidenceNow,
        },
        {
          baseDir: base,
          gateMode: 'blocking',
          resolvedWorkflowData: runtimeData,
          cancelSignal: controller.signal,
        },
      );
      await vi.waitFor(() => {
        expect(readJournal(journalPath).some((event) =>
          event.type === 'hostEffectRetryDeferred')).toBe(true);
      });
      controller.abort('cancel during durable provider backoff');
      const outcome = await running;
      expect(outcome).toMatchObject({
        reason: 'terminal',
        runStatus: 'cancelled',
        uncertainHostEffects: [expect.objectContaining({
          errorCode: 'HOST_EFFECT_CANCELLED_DURING_RECOVERY',
        })],
      });
      expect(submit).toHaveBeenCalledOnce();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('turns a rollback/overflow retry clock into explicit uncertainty', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-retry-clock-'));
    try {
      const invoke = vi.fn(async () => {
        throw new Error('response lost');
      });
      const submit = vi.fn(async () => ({
        ok: false as const,
        errorClass: 'retryable' as const,
        errorCode: 'RATE_LIMITED',
        errorMessage: 'retry later',
      }));
      const reconciler: ProviderReconciler = {
        provider: 'feishu-im',
        requiresEffectInput: true,
        canonicalInput: (input) => input,
        idempotentSubmit: submit,
      };
      const validNow = Date.now() + 10_000;
      let clockReads = 0;
      const outcome = await runWorkflow(
        dag('host-retry-clock'),
        {
          ...deps(fakeRegistry(invoke), new Map([['feishu-im', reconciler]])),
          resolveGate: approveGate,
          // startHost preflight, backoff check and TTL evidence are valid;
          // only the durable retry timestamp observes the rollback.
          now: () => (++clockReads < 4 ? validNow : 0),
        },
        { baseDir: base, gateMode: 'blocking', resolvedWorkflowData: runtimeData },
      );
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'blocked' });
      expect(readJournal(join(base, 'host-retry-clock', 'journal.ndjson'))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'hostEffectUncertain',
            errorCode: 'HOST_EFFECT_CLOCK_INVALID',
          }),
        ]),
      );
      expect(readJournal(join(base, 'host-retry-clock', 'journal.ndjson'))
        .some((event) => event.type === 'hostEffectRetryDeferred')).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('does not wedge when the clock rolls back after a retry deadline is durable', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-deferred-clock-'));
    try {
      const invoke = vi.fn(async () => { throw new Error('response lost'); });
      const submit = vi.fn(async () => ({
        ok: false as const,
        errorClass: 'retryable' as const,
        errorCode: 'RATE_LIMITED',
        errorMessage: 'retry later',
      }));
      const reconciler: ProviderReconciler = {
        provider: 'feishu-im',
        requiresEffectInput: true,
        canonicalInput: (input) => input,
        idempotentSubmit: submit,
      };
      let evidenceNow = Date.now() + 10_000;
      const journalPath = join(base, 'host-deferred-clock', 'journal.ndjson');
      const running = runWorkflow(
        dag('host-deferred-clock'),
        {
          ...deps(fakeRegistry(invoke), new Map([['feishu-im', reconciler]])),
          resolveGate: approveGate,
          now: () => evidenceNow,
        },
        { baseDir: base, gateMode: 'blocking', resolvedWorkflowData: runtimeData },
      );
      await vi.waitFor(() => {
        expect(readJournal(journalPath).some((event) =>
          event.type === 'hostEffectRetryDeferred')).toBe(true);
      });
      evidenceNow = 0;
      await expect(running).resolves.toMatchObject({ reason: 'terminal', runStatus: 'blocked' });
      expect(readJournal(journalPath)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'hostEffectUncertain',
          errorCode: 'HOST_EFFECT_CLOCK_INVALID',
        }),
      ]));
      expect(submit).toHaveBeenCalledOnce();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('bounds a hung reconciler and reports uncertainty when cancellation is already durable', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-reconcile-timeout-'));
    try {
      const controller = new AbortController();
      const invoke = vi.fn(async () => {
        controller.abort('cancel after ambiguous provider response');
        throw new Error('response lost');
      });
      const lookup = vi.fn(async () => await new Promise<never>(() => {}));
      const reconciler: ProviderReconciler = {
        provider: 'feishu-im',
        requiresEffectInput: true,
        canonicalInput: (input) => input,
        readOnlyLookup: lookup,
      };
      const outcome = await runWorkflow(
        dag('host-reconcile-timeout'),
        {
          ...deps(fakeRegistry(invoke), new Map([['feishu-im', reconciler]])),
          resolveGate: approveGate,
        },
        {
          baseDir: base,
          gateMode: 'blocking',
          resolvedWorkflowData: runtimeData,
          cancelSignal: controller.signal,
          hostResponseWaitMs: 10,
        },
      );
      expect(outcome).toMatchObject({
        reason: 'terminal',
        runStatus: 'cancelled',
        uncertainHostEffects: [expect.objectContaining({
          errorCode: 'HOST_EFFECT_CANCELLED_DURING_RECOVERY',
        })],
      });
      expect(lookup).toHaveBeenCalledOnce();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('reports an uncertain external effect when cancellation outlives provider TTL', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-cancel-ttl-'));
    try {
      const controller = new AbortController();
      const invoke = vi.fn(async () => {
        controller.abort('cancel after submit with lost response');
        throw new Error('response lost');
      });
      const submit = vi.fn(async () => ({ ok: true as const, externalRefs: {} }));
      const reconciler: ProviderReconciler = {
        provider: 'feishu-im',
        requiresEffectInput: true,
        canonicalInput: (input) => input,
        idempotentSubmit: submit,
      };
      const outcome = await runWorkflow(
        dag('host-cancel-ttl'),
        {
          ...deps(fakeRegistry(invoke), new Map([['feishu-im', reconciler]])),
          resolveGate: approveGate,
          now: () => Number.MAX_SAFE_INTEGER,
        },
        {
          baseDir: base,
          gateMode: 'blocking',
          resolvedWorkflowData: runtimeData,
          cancelSignal: controller.signal,
        },
      );
      expect(outcome).toMatchObject({
        reason: 'terminal',
        runStatus: 'cancelled',
        uncertainHostEffects: [expect.objectContaining({
          nodeId: 'send',
          executor: 'feishu-send',
          errorCode: 'HOST_EFFECT_TTL_EXPIRED',
        })],
      });
      expect(submit).not.toHaveBeenCalled();
      const events = readJournal(join(base, 'host-cancel-ttl', 'journal.ndjson'));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'hostEffectUncertain', reason: 'ttlExpired' }),
        expect.objectContaining({
          type: 'runCancelled',
          uncertainHostEffects: [expect.objectContaining({ nodeId: 'send' })],
        }),
      ]));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('turns a partial post-effect result artifact into uncertainty so cancellation converges', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-partial-result-cancel-'));
    try {
      const controller = new AbortController();
      const runId = 'host-partial-result-cancel';
      const attemptDir = join(base, runId, 'send#001', 'attempts', '001');
      const invoke = vi.fn(async () => {
        const workDir = join(attemptDir, 'work');
        mkdirSync(workDir, { recursive: true, mode: 0o700 });
        // Simulate the old direct-to-canonical writer crashing mid-result,
        // after the provider accepted the effect but before manifest publish.
        writeFileSync(join(workDir, 'result.json'), '{"schemaVersion":1', { mode: 0o600 });
        controller.abort('cancel after provider success and local artifact crash');
        throw new Error('process crashed before result/manifest close proof');
      });
      const submit = vi.fn(async () => ({
        ok: true as const,
        externalRefs: { messageId: 'om_already_sent' },
      }));
      const reconciler: ProviderReconciler = {
        provider: 'feishu-im',
        requiresEffectInput: true,
        canonicalInput: (input) => input,
        idempotentSubmit: submit,
      };
      const outcome = await runWorkflow(
        dag(runId),
        {
          ...deps(fakeRegistry(invoke), new Map([['feishu-im', reconciler]])),
          resolveGate: approveGate,
        },
        {
          baseDir: base,
          gateMode: 'blocking',
          resolvedWorkflowData: runtimeData,
          cancelSignal: controller.signal,
        },
      );
      expect(outcome).toMatchObject({
        reason: 'terminal',
        runStatus: 'cancelled',
        uncertainHostEffects: [expect.objectContaining({
          nodeId: 'send',
          errorCode: 'HOST_EFFECT_OUTPUT_UNRECOVERABLE',
        })],
      });
      expect(invoke).toHaveBeenCalledOnce();
      expect(submit).toHaveBeenCalledOnce();
      expect(readJournal(join(base, runId, 'journal.ndjson'))).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'hostEffectUncertain',
          reason: 'outputUnrecoverable',
          errorCode: 'HOST_EFFECT_OUTPUT_UNRECOVERABLE',
        }),
        expect.objectContaining({ type: 'runCancelled' }),
      ]));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('does not accept a generic or mismatched result manifest as host close proof', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-host-result-bind-'));
    try {
      const attemptDir = join(base, 'host-result-bind', 'send#001', 'attempts', '001');
      const invoke = vi.fn(async () => {
        writeV3HostSuccessArtifacts({
          runDir: join(base, 'host-result-bind'),
          attemptDir,
          runId: 'host-result-bind',
          nodeId: 'send',
          instanceId: 'send#001',
          attemptId: 'send#001/attempts/001',
          executor: 'feishu-send',
          provider: 'feishu-im',
          idempotencyKey: 'wf3_wrong',
          inputHash: `sha256:${'0'.repeat(64)}`,
          approvalDigest: `sha256:${'0'.repeat(64)}`,
          output: { messageId: 'om_unknown' },
          externalRefs: { messageId: 'om_unknown' },
        });
        throw new Error('crash before journal close');
      });
      const outcome = await runWorkflow(
        dag('host-result-bind'),
        { ...deps(fakeRegistry(invoke)), resolveGate: approveGate },
        { baseDir: base, gateMode: 'blocking', resolvedWorkflowData: runtimeData },
      );
      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'blocked' });
      const events = readJournal(join(base, 'host-result-bind', 'journal.ndjson'));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'hostEffectUncertain',
          reason: 'outputUnrecoverable',
          errorCode: 'HOST_EFFECT_OUTPUT_UNRECOVERABLE',
        }),
      ]));
      expect(events.some((event) => event.type === 'nodeSucceeded')).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
