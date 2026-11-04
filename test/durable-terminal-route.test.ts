import { describe, expect, it } from 'vitest';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import {
  createDurableTerminalRoutePublisher,
  createDurableTerminalRouteRegistry,
  durableTerminalRoutePort,
  durableTerminalRouteSessionKey,
  liveDurableTerminalRoute,
  parseDurableTerminalRoute,
} from '../src/services/durable-terminal-route.js';

describe('durable terminal route registry', () => {
  it('publishes through an explicit route port without changing the dashboard listener port', () => {
    expect(durableTerminalRoutePort({
      BOTMUX_TERMINAL_ROUTE_PORT: '11419',
      BOTMUX_DASHBOARD_PORT: '7891',
    })).toBe(11419);
    expect(durableTerminalRoutePort({ BOTMUX_DASHBOARD_PORT: '7891' })).toBe(7891);
    expect(durableTerminalRoutePort({
      BOTMUX_TERMINAL_ROUTE_PORT: 'invalid',
      BOTMUX_DASHBOARD_PORT: '7891',
    })).toBeUndefined();
    expect(durableTerminalRoutePort({ BOTMUX_TERMINAL_ROUTE_PORT: '65536' }))
      .toBeUndefined();
  });

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
    await expect(store.readAuxiliaryState(durableTerminalRouteSessionKey('session-1')))
      .resolves.toMatchObject({ value: { larkAppId: 'cli_test', sessionId: 'session-1' } });
    await expect(registry.resolveSession('session-1', 'pod-b')).resolves.toMatchObject({
      ownerInstanceId: 'pod-a',
      host: '10.0.0.8',
      port: 18080,
      expiresAt: 10_100,
    });
    // A replica never forwards to itself.
    await expect(registry.resolveSession('session-1', 'pod-a')).resolves.toBeUndefined();
    now = 10_101;
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
      stateKey: durableTerminalRouteSessionKey('session-1'),
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

  it('publishes only live, attributable rows and refreshes each route at most once per window', async () => {
    let now = 1_000;
    const published: string[] = [];
    const publisher = createDurableTerminalRoutePublisher({
      registry: {
        publish: async route => {
          published.push(route.sessionId);
          return { kind: 'published' } as never;
        },
      },
      listRows: () => rows,
      ownerInstanceId: 'pod-a',
      host: '10.0.0.8',
      port: 7891,
      refreshAfterMs: 15_000,
      now: () => now,
    });
    let rows: Record<string, unknown>[] = [
      { sessionId: 'live', larkAppId: 'cli_test', status: 'working', webPort: 40001, proxyPort: 10054 },
      { sessionId: 'dormant', larkAppId: 'cli_test', status: 'dormant', webPort: null, proxyPort: 10054 },
      { sessionId: 'closed', larkAppId: 'cli_test', status: 'closed', webPort: 40002, proxyPort: 10054 },
      { sessionId: 'no-app', larkAppId: '', status: 'working', webPort: 40003, proxyPort: 10054 },
    ];
    await publisher.publishDue();
    expect(published).toEqual(['live']);
    // Row updates and heartbeats inside the window do not rewrite the record.
    now += 14_999;
    await publisher.publishDue();
    expect(published).toEqual(['live']);
    now += 1;
    await publisher.publishDue();
    expect(published).toEqual(['live', 'live']);
    // A row that stops being live is forgotten, so it republishes immediately
    // once it is live again.
    rows = [{ ...rows[0], status: 'dormant', webPort: null }];
    await publisher.publishDue();
    rows = [{ sessionId: 'live', larkAppId: 'cli_test', status: 'working', webPort: 40009, proxyPort: 10054 }];
    await publisher.publishDue();
    expect(published).toEqual(['live', 'live', 'live']);
  });

  it('retries an occupied route on the next tick and reports store failures', async () => {
    const results = ['occupied', 'stale_lease', 'published'];
    const warnings: string[] = [];
    let calls = 0;
    const publisher = createDurableTerminalRoutePublisher({
      registry: { publish: async () => ({ kind: results[calls++] }) as never },
      listRows: () => [{ sessionId: 's', larkAppId: 'cli_test', status: 'working', webPort: 1, proxyPort: 2 }],
      ownerInstanceId: 'pod-a',
      host: '10.0.0.8',
      port: 7891,
      now: () => 0,
      onWarn: message => warnings.push(message),
    });
    await publisher.publishDue();
    await publisher.publishDue();
    await publisher.publishDue();
    await publisher.publishDue();
    expect(calls).toBe(3);
    expect(warnings).toEqual(['publish s failed: stale_lease']);
  });
});
