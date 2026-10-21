import { describe, expect, it } from 'vitest';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import {
  createDurableTerminalRouteRegistry,
  durableTerminalRouteKey,
  durableTerminalRouteSessionKey,
  liveDurableTerminalRoute,
  parseDurableTerminalRoute,
} from '../src/services/durable-terminal-route.js';

describe('durable terminal route registry', () => {
  it('publishes a fenced literal-IP route and resolves it from another replica', async () => {
    let now = 100;
    const store = new SqliteDurableCoordinationStore(':memory:', { now: () => now });
    const registry = createDurableTerminalRouteRegistry({
      store,
      ownerId: 'route-owner-a',
      now: () => now,
      ttlMs: 10_000,
    });
    await expect(registry.publish({
      larkAppId: 'cli_test',
      sessionId: 'session-1',
      ownerInstanceId: 'pod-a',
      host: '10.0.0.8',
      port: 18080,
    })).resolves.toMatchObject({ kind: 'published' });
    await expect(registry.resolve('cli_test', 'session-1', 'pod-b')).resolves.toMatchObject({
      ownerInstanceId: 'pod-a',
      host: '10.0.0.8',
      port: 18080,
      expiresAt: 10_100,
    });
    await expect(store.readAuxiliaryState(durableTerminalRouteSessionKey('session-1')))
      .resolves.toMatchObject({ value: { larkAppId: 'cli_test', sessionId: 'session-1' } });
    await expect(registry.resolveSession('session-1', 'pod-b')).resolves.toMatchObject({
      ownerInstanceId: 'pod-a',
      host: '10.0.0.8',
      port: 18080,
    });
    await expect(registry.resolveSession('session-1', 'pod-a')).resolves.toBeUndefined();
    await expect(registry.resolve('cli_test', 'session-1', 'pod-a')).resolves.toBeUndefined();
    now = 10_101;
    await expect(registry.resolve('cli_test', 'session-1', 'pod-b')).resolves.toBeUndefined();
    await expect(registry.resolveSession('session-1', 'pod-b')).resolves.toBeUndefined();
  });

  it('resolves a fresh remote Session without a local application row', async () => {
    const store = new SqliteDurableCoordinationStore(':memory:');
    const registry = createDurableTerminalRouteRegistry({ store, ownerId: 'route-owner-a' });
    await registry.publish({
      larkAppId: 'cli_test',
      sessionId: 'fresh-session',
      ownerInstanceId: 'pod-a',
      host: '10.0.0.8',
      port: 7891,
    });
    await expect(registry.resolveSession('fresh-session', 'pod-b')).resolves.toMatchObject({
      larkAppId: 'cli_test',
      sessionId: 'fresh-session',
      ownerInstanceId: 'pod-a',
    });
  });

  it('fails closed for hostnames, identity drift and expired records', () => {
    expect(() => parseDurableTerminalRoute({
      version: 1,
      type: 'botmux.terminal-route',
      larkAppId: 'cli_test',
      sessionId: 'session-1',
      ownerInstanceId: 'pod-a',
      host: 'owner.internal',
      port: 7891,
      expiresAt: 100,
    })).toThrow(/literal IP/);
    expect(liveDurableTerminalRoute({
      stateKey: durableTerminalRouteKey('cli_test', 'session-1'),
      revision: 1,
      updatedAt: 10,
      value: {
        version: 1,
        type: 'botmux.terminal-route',
        larkAppId: 'cli_other',
        sessionId: 'session-1',
        ownerInstanceId: 'pod-a',
        host: '10.0.0.8',
        port: 7891,
        expiresAt: 100,
      },
    }, { larkAppId: 'cli_test', sessionId: 'session-1', now: 20 })).toBeUndefined();
  });
});
