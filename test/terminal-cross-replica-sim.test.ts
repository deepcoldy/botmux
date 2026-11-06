/**
 * #2062 多副本模拟：两个「副本」共用同一个 SQLite 协调库文件，各自有真实的
 * Aggregator、终端路由 registry + publisher、Dashboard 前门和 daemon 终端代理，
 * 只把 dashboard.ts 的接线换成本文件里的同构接线。验证：
 *   ① 请求落到非 owner 副本时转发到 owner，非 owner 不冷启；
 *   ② 非 owner 上残留的休眠行不会抢走路由；
 *   ③ owner 不再有活 worker、路由过期后，落点副本按原路径本机冷启；
 *   ④ 单副本形态（不装 remote resolver）对休眠行直接本机冷启、从不读共享库。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Aggregator } from '../src/dashboard/aggregator.js';
import { createTerminalFrontProxy } from '../src/dashboard/terminal-front-proxy.js';
import { startTerminalProxy, type TerminalProxyHandle } from '../src/core/terminal-proxy.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import {
  createDurableTerminalRoutePublisher,
  createDurableTerminalRouteRegistry,
} from '../src/services/durable-terminal-route.js';

const SESSION = 'sess-cross';
const servers: Server[] = [];
const proxies: TerminalProxyHandle[] = [];
const stores: SqliteDurableCoordinationStore[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const proxy of proxies.splice(0)) await proxy.close();
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

async function worker(label: string): Promise<number> {
  return listen(createServer((_req, res) => res.writeHead(200).end(label)));
}

interface Replica {
  name: string;
  aggregator: Aggregator;
  frontPort: number;
  daemonProxyPort: number;
  coldStarts: () => number;
  publish: () => Promise<void>;
  remoteLookups: () => number;
}

async function replica(input: {
  name: string;
  dbPath?: string;
  clock?: () => number;
  /** Port the daemon proxy wakes the worker on (cold start). */
  coldWorkerPort?: number;
  /** Port of an already-live worker on this replica. */
  liveWorkerPort?: number;
}): Promise<Replica> {
  let coldStarts = 0;
  let remoteLookups = 0;
  const daemonProxy = await startTerminalProxy({
    port: 0,
    host: '127.0.0.1',
    resolvePort: id => (id === SESSION ? input.liveWorkerPort : undefined),
    ensureWorkerPort: async id => {
      coldStarts += 1;
      return id === SESSION ? input.coldWorkerPort : undefined;
    },
  });
  proxies.push(daemonProxy);
  const aggregator = new Aggregator();
  const store = input.dbPath
    ? new SqliteDurableCoordinationStore(input.dbPath, { now: input.clock })
    : undefined;
  if (store) stores.push(store);
  const registry = store
    ? createDurableTerminalRouteRegistry({
        store,
        ownerId: `terminal-route-dashboard:${input.name}`,
        now: input.clock,
        ttlMs: 5_000,
      })
    : undefined;
  // Same wiring as dashboard.ts: the remote hooks exist only in primary mode.
  const front = createTerminalFrontProxy({
    resolvePort: id => aggregator.terminalProxyPortOf(id),
    ...(registry
      ? {
          resolveRemoteTarget: async (id: string) => {
            remoteLookups += 1;
            const route = await registry.resolveSession(id, input.name);
            return route ? { host: route.host, port: route.port } : undefined;
          },
          isLocalTerminalLive: (id: string) => aggregator.hasLiveTerminalWorker(id),
        }
      : {}),
    resolveActor: () => null,
    control: {} as any,
  });
  const frontServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://front');
    if (!front.handleHttp(req, res, url)) res.writeHead(418).end('fell-through');
  });
  const frontPort = await listen(frontServer);
  const publisher = registry
    ? createDurableTerminalRoutePublisher({
        registry,
        listRows: () => aggregator.getSessions(),
        ownerInstanceId: input.name,
        host: '127.0.0.1',
        port: frontPort,
        ttlMs: 5_000,
        now: input.clock,
      })
    : undefined;
  return {
    name: input.name,
    aggregator,
    frontPort,
    daemonProxyPort: daemonProxy.port,
    coldStarts: () => coldStarts,
    publish: async () => { await publisher?.publishDue(); },
    remoteLookups: () => remoteLookups,
  };
}

async function get(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/s/${SESSION}/?viewToken=card-link`);
  return `${response.status}:${await response.text()}`;
}

function sharedDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-cross-replica-'));
  dirs.push(dir);
  return join(dir, 'coordination.db');
}

describe('#2062 multi-replica terminal routing simulation', () => {
  it('forwards to the live owner, ignores a stale dormant row, and cold-starts locally once the owner is gone', async () => {
    let clock = 1_000;
    const dbPath = sharedDb();
    const ownerWorker = await worker('owner-live-worker');
    const edgeColdWorker = await worker('edge-cold-started');
    const owner = await replica({ name: 'pod-a', dbPath, clock: () => clock, liveWorkerPort: ownerWorker });
    const edge = await replica({ name: 'pod-b', dbPath, clock: () => clock, coldWorkerPort: edgeColdWorker });

    owner.aggregator.hydrateSessions('cli_test', [{
      sessionId: SESSION, larkAppId: 'cli_test', status: 'working', webPort: ownerWorker,
      proxyPort: owner.daemonProxyPort,
    }]);
    await owner.publish();

    // ① A fresh Session the edge has never seen: forwarded to the owner.
    await expect(get(edge.frontPort)).resolves.toBe('200:owner-live-worker');
    expect(edge.coldStarts()).toBe(0);

    // ② The edge holds a stale dormant row for the same Session: the live
    // owner still wins, the edge does not cold-start a competing worker.
    edge.aggregator.hydrateSessions('cli_test', [{
      sessionId: SESSION, larkAppId: 'cli_test', status: 'dormant', webPort: null,
      proxyPort: edge.daemonProxyPort,
    }]);
    await expect(get(edge.frontPort)).resolves.toBe('200:owner-live-worker');
    expect(edge.coldStarts()).toBe(0);

    // The owner itself serves locally without touching the shared store.
    await expect(get(owner.frontPort)).resolves.toBe('200:owner-live-worker');
    expect(owner.remoteLookups()).toBe(0);

    // ③ The owner's worker goes away: it stops refreshing, the route expires,
    // and the edge falls back to the pre-#2062 local cold start.
    owner.aggregator.hydrateSessions('cli_test', [{
      sessionId: SESSION, larkAppId: 'cli_test', status: 'dormant', webPort: null,
      proxyPort: owner.daemonProxyPort,
    }]);
    await owner.publish();
    clock += 5_001;
    await expect(get(edge.frontPort)).resolves.toBe('200:edge-cold-started');
    expect(edge.coldStarts()).toBe(1);
  });

  it('single replica: a dormant row cold-starts through the local daemon proxy with no shared-store hooks', async () => {
    const coldWorker = await worker('single-cold-started');
    const single = await replica({ name: 'single', coldWorkerPort: coldWorker });
    single.aggregator.hydrateSessions('cli_test', [{
      sessionId: SESSION, larkAppId: 'cli_test', status: 'dormant', webPort: null,
      proxyPort: single.daemonProxyPort,
    }]);
    await expect(get(single.frontPort)).resolves.toBe('200:single-cold-started');
    expect(single.coldStarts()).toBe(1);
    expect(single.remoteLookups()).toBe(0);
  });
});
