import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ExternalDurableCoordinationProviderError,
  ExternalDurableCoordinationStore,
} from '../src/services/external-durable-coordination-store.js';
import { initializeDurableCoordinationRuntime } from '../src/services/durable-coordination-runtime.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';

const fixture = resolve('test/fixtures/durable-coordination-provider.ts');

function providerCommand(extraArgs: string[] = []) {
  const { command, prefixArgs } = tsRunnerPrefix();
  return { command, args: [...prefixArgs, fixture, ...extraArgs] };
}

describe('external durable coordination provider', () => {
  it('handshakes and forwards coordination calls without a shell', async () => {
    const store = await ExternalDurableCoordinationStore.connect(providerCommand());
    expect(store.provider).toBe('fixture');
    await expect(store.acquireSessionLease({
      sessionKey: 'session-a',
      ownerId: 'worker-a',
      leaseDurationMs: 1000,
    })).resolves.toEqual({
      kind: 'acquired',
      lease: {
        sessionKey: 'session-a',
        ownerId: 'worker-a',
        epoch: 1,
        leaseUntil: 1234,
      },
    });
    await expect(store.readSession('missing')).resolves.toBeUndefined();
    await store.close();
  });

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
    await store.close();
  });

  it('rejects an incompatible contract version', async () => {
    await expect(ExternalDurableCoordinationStore.connect(providerCommand(['--bad-contract'])))
      .rejects.toThrow(/hello is incompatible/);
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
  it('keeps the default disabled and primary fail-closed', async () => {
    await expect(initializeDurableCoordinationRuntime({})).resolves.toBeUndefined();
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
