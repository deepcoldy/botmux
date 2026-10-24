import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  type DurableCoordinationProviderMethod,
  validateDurableCoordinationProviderResult,
} from '../src/services/durable-coordination-provider-protocol.js';
import type {
  DurableJson,
  SessionLease,
} from '../src/services/durable-coordination.js';
import {
  ExternalDurableCoordinationProviderError,
  ExternalDurableCoordinationStore,
} from '../src/services/external-durable-coordination-store.js';
import { initializeDurableCoordinationRuntime } from '../src/services/durable-coordination-runtime.js';
import { resolveDaemonEnv } from '../src/cli/daemon-lifecycle-env.js';
import { killFixturePid, waitForPidFile } from './helpers/pid-file.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const fixture = resolve('test/fixtures/durable-coordination-provider.ts');
const validAttemptingControlRecord = {
  operationId: 'fixture-control',
  sessionKey: 'session-a',
  payload: { action: 'close' },
  createdAt: 1,
  state: 'attempting',
  originEpoch: 1,
  attempts: 1,
  updatedAt: 2,
} as const;

function providerCommand(extraArgs: string[] = []) {
  const { command, prefixArgs } = tsRunnerPrefix();
  return { command, args: [...prefixArgs, fixture, ...extraArgs] };
}

describe('external durable coordination provider', () => {
  it('handshakes and forwards coordination calls without a shell', async () => {
    const store = await ExternalDurableCoordinationStore.connect(providerCommand());
    expect(store.provider).toBe('fixture');
    const acquisition = await store.acquireSessionLease({
      sessionKey: 'session-a',
      ownerId: 'worker-a',
      leaseDurationMs: 1000,
    });
    expect(acquisition).toEqual({
      kind: 'acquired',
      lease: {
        sessionKey: 'session-a',
        ownerId: 'worker-a',
        epoch: 1,
        leaseUntil: 1234,
      },
    });
    if (acquisition.kind !== 'acquired') throw new Error('expected fixture lease');
    const lease: SessionLease = acquisition.lease;
    await expect(store.enqueueInboxWithLease({
      lease,
      event: {
        eventId: 'event-a',
        partitionKey: 'partition-a',
        payload: { value: 1 },
        visibleAt: 1,
        createdAt: 1,
      },
    })).resolves.toEqual({ kind: 'inserted' });
    const operation = {
      operationId: 'fixture-control',
      sessionKey: 'session-a',
      payload: { action: 'close' },
      createdAt: 1,
    } as const;
    await expect(store.enqueueControlOperation({ lease, operation }))
      .resolves.toEqual({ kind: 'inserted' });
    const begun = await store.beginControlOperationAttempt({
      lease,
      operationId: operation.operationId,
    });
    expect(begun).toMatchObject({
      kind: 'applied',
      record: { operationId: 'fixture-control', state: 'attempting' },
      attempt: { operationId: 'fixture-control', attempt: 1 },
    });
    if (begun.kind !== 'applied') throw new Error('expected fixture control attempt');
    await expect(store.completeControlOperationAttempt({
      attempt: begun.attempt,
      result: { status: 'closed' },
    })).resolves.toMatchObject({ kind: 'applied', record: { state: 'completed' } });
    await expect(store.retryControlOperationAttempt({
      attempt: begun.attempt,
      error: 'not dispatched',
    })).resolves.toMatchObject({ kind: 'applied', record: { state: 'pending' } });
    await expect(store.markControlOperationAmbiguous({
      attempt: begun.attempt,
      error: 'outcome unknown',
    })).resolves.toMatchObject({ kind: 'applied', record: { state: 'ambiguous' } });
    await expect(store.reconcileControlOperation({
      lease,
      operationId: operation.operationId,
      expectedAttempt: 1,
      outcome: {
        kind: 'completed',
        result: { status: 'closed' },
        evidence: { source: 'fixture' },
      },
    })).resolves.toMatchObject({ kind: 'applied', record: { state: 'completed' } });
    await expect(store.readControlOperation('fixture-control'))
      .resolves.toMatchObject({ operationId: 'fixture-control', state: 'completed' });
    await expect(store.readSession('missing')).resolves.toBeUndefined();
    await expect(store.listSessions({ limit: 100 })).resolves.toEqual({
      records: [{
        sessionKey: 'session-a',
        revision: 1,
        value: { status: 'active' },
        updatedAt: 2,
      }],
    });
    await expect(store.readAuxiliaryState('missing')).resolves.toBeUndefined();
    await expect(store.writeAuxiliaryState({
      lease,
      expectedRevision: null,
      value: { type: 'recalls' },
    })).resolves.toMatchObject({
      kind: 'written',
      record: { stateKey: 'session-a', revision: 1, value: { type: 'recalls' } },
    });
    await expect(store.readControlOperation('missing-control')).resolves.toBeUndefined();
    await store.close();
  });

  it.each([
    ['enqueueControlOperation', { kind: 'applied' }],
    ['beginControlOperationAttempt', {
      kind: 'applied',
      record: validAttemptingControlRecord,
      attempt: { operationId: 'fixture-control' },
    }],
    ['completeControlOperationAttempt', { kind: 'applied', record: {} }],
    ['retryControlOperationAttempt', { kind: 'applied', record: {} }],
    ['markControlOperationAmbiguous', { kind: 'applied', record: {} }],
    ['reconcileControlOperation', { kind: 'applied', record: {} }],
    ['readControlOperation', { operationId: '', state: 'completed' }],
    ['listSessions', { records: [{ revision: 'wrong' }] }],
    ['readAuxiliaryState', { revision: 'wrong' }],
    ['writeAuxiliaryState', { kind: 'written', record: { revision: 'wrong' } }],
  ] satisfies Array<[DurableCoordinationProviderMethod, DurableJson]>)(
    'fails closed on a malformed %s result',
    (method, result) => {
      expect(() => validateDurableCoordinationProviderResult(method, result))
        .toThrow(new RegExp(`invalid ${method} result`));
    },
  );

  it('preserves provider error code and retryability', async () => {
    const store = await ExternalDurableCoordinationStore.connect(providerCommand());
    await expect(store.readSession('provider-error')).rejects.toMatchObject({
      name: 'ExternalDurableCoordinationProviderError',
      code: 'fixture_failure',
      retryable: true,
    } satisfies Partial<ExternalDurableCoordinationProviderError>);
    await store.close();
  });

  it('fails closed on a malformed method result', async () => {
    const store = await ExternalDurableCoordinationStore.connect(providerCommand());
    await expect(store.readSession('invalid-result'))
      .rejects.toThrow(/invalid readSession result/);
    await expect(store.listSessions({ limit: 999 }))
      .rejects.toThrow(/invalid listSessions result/);
    await expect(store.readAuxiliaryState('invalid-result'))
      .rejects.toThrow(/invalid readAuxiliaryState result/);
    await store.close();
  });

  it('rejects an incompatible contract version', async () => {
    await expect(ExternalDurableCoordinationStore.connect(providerCommand(['--bad-contract'])))
      .rejects.toThrow(/hello is incompatible/);
  });

  it('fails the store instead of crashing when the provider stops reading its stdin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-coordination-stdin-closed-'));
    const pidPath = join(dir, 'pid');
    const escaped: unknown[] = [];
    const onUncaught = (error: unknown) => escaped.push(error);
    process.on('uncaughtException', onUncaught);
    let pid: number | undefined;
    try {
      const store = await ExternalDurableCoordinationStore.connect({
        ...providerCommand(['--close-stdin-after-hello']),
        env: { ...process.env, DURABLE_FIXTURE_PID_PATH: pidPath },
      });
      pid = await waitForPidFile(pidPath);

      // The provider closed its stdin before answering hello, so this request
      // hits a pipe nobody reads: EPIPE. The write callback fails the request,
      // but the stream also emits 'error'; without a listener that is thrown at
      // process level, and the daemon has no uncaughtException trap. Bun only
      // reports EPIPE for writes the pipe buffer cannot absorb, so the request
      // is made larger than that.
      await expect(store.readSession('x'.repeat(256 * 1024))).rejects.toThrow();
      // Nothing reaches the provider any more: later calls fail with that cause
      // instead of writing into a dead pipe, and the provider is reaped.
      await vi.waitFor(() => expect(store.readSession('missing')).rejects.toThrow(/stdin error/));
      const alivePid = pid;
      await vi.waitFor(() => {
        expect(() => process.kill(alivePid, 0)).toThrow();
      }, { timeout: 5_000 });
      expect(escaped).toEqual([]);
      store.terminate();
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      if (pid !== undefined) killFixturePid(pid);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when a request times out', async () => {
    const store = await ExternalDurableCoordinationStore.connect({
      ...providerCommand(['--slow']),
      requestTimeoutMs: 100,
    });
    await expect(store.readSession('missing')).rejects.toThrow(/timed out/);
    store.terminate();
  });
});

describe('durable coordination runtime configuration', () => {
  it.each([
    undefined,
    '',
    '   ',
  ])('treats an absent or blank coordination mode as disabled (%#)', async mode => {
    await expect(initializeDurableCoordinationRuntime({
      ...(mode === undefined ? {} : { BOTMUX_COORDINATION_MODE: mode }),
    })).resolves.toBeUndefined();
  });

  it('accepts the lifecycle default environment as disabled', async () => {
    await expect(initializeDurableCoordinationRuntime(resolveDaemonEnv({})))
      .resolves.toBeUndefined();
  });

  it('rejects unsupported non-empty coordination modes and keeps primary fail-closed', async () => {
    await expect(initializeDurableCoordinationRuntime({ BOTMUX_COORDINATION_MODE: 'unexpected' }))
      .rejects.toThrow(/must be disabled, shadow, or primary/);
    await expect(initializeDurableCoordinationRuntime({ BOTMUX_COORDINATION_MODE: 'primary' }))
      .rejects.toThrow(/primary is unavailable/);
  });

  it('starts a shadow provider from an absolute executable plus JSON args', async () => {
    const { command, args } = providerCommand();
    const runtime = await initializeDurableCoordinationRuntime({
      ...process.env,
      BOTMUX_COORDINATION_MODE: 'shadow',
      BOTMUX_COORDINATION_PROVIDER_BIN: command,
      BOTMUX_COORDINATION_PROVIDER_ARGS_JSON: JSON.stringify(args),
    });
    expect(runtime?.mode).toBe('shadow');
    expect(runtime?.provider).toBe('fixture');
    await runtime?.close();
  });

  it('starts primary only when the fully-wired daemon explicitly opts in', async () => {
    const { command, args } = providerCommand();
    const runtime = await initializeDurableCoordinationRuntime({
      ...process.env,
      BOTMUX_COORDINATION_MODE: 'primary',
      BOTMUX_COORDINATION_PROVIDER_BIN: command,
      BOTMUX_COORDINATION_PROVIDER_ARGS_JSON: JSON.stringify(args),
    }, { allowPrimary: true });
    expect(runtime?.mode).toBe('primary');
    await runtime?.close();
  });

  it('rejects relative provider executables before spawn', async () => {
    await expect(initializeDurableCoordinationRuntime({
      BOTMUX_COORDINATION_MODE: 'shadow',
      BOTMUX_COORDINATION_PROVIDER_BIN: './provider',
    })).rejects.toThrow(/absolute executable path/);
  });
});
