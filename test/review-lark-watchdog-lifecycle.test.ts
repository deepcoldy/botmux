import * as Lark from '@larksuiteoapi/node-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLarkConnection, type LarkConnection } from '../src/im/lark/transport/connection.js';
import { getLarkConnectionHealth } from '../src/im/lark/transport/connection-health.js';
import type { createResilientWsClient } from '../src/im/lark/transport/resilient-ws-client.js';
import { logger } from '../src/utils/logger.js';
import { WebSocketServer } from './helpers/node-ws.js';
import type { AddressInfo } from 'node:net';

type Options = Parameters<typeof createResilientWsClient>[0];
type Hooks = NonNullable<Parameters<typeof createResilientWsClient>[1]>;
const generations: Array<{ options: Options; hooks: Hooks; client: Lark.WSClient }> = [];
vi.mock('../src/im/lark/transport/resilient-ws-client.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/im/lark/transport/resilient-ws-client.js')>();
  return {
    ...original,
    createResilientWsClient(options: Options, hooks: Hooks) {
      const client = original.createResilientWsClient(options, hooks);
      generations.push({ options, hooks, client });
      return client;
    },
  };
});

const appId = 'cli_0000000000000000';
const dispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.fatal });
const handles: LarkConnection[] = [];
const requests: Array<{ signal: AbortSignal; resolve: (value: unknown) => void }> = [];
const servers: InstanceType<typeof WebSocketServer>[] = [];

function connect(lifecycle: Parameters<typeof startLarkConnection>[4] = {}) {
  const handle = startLarkConnection(appId, 'synthetic-local-secret', dispatcher, 'feishu', lifecycle);
  handles.push(handle);
  return handle;
}

async function advance(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let index = 0; index < 16; index++) await Promise.resolve();
}

async function waitForIo(predicate: () => boolean) {
  for (let index = 0; index < 2000 && !predicate(); index++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(predicate()).toBe(true);
}

describe('independent watchdog lifecycle with the real SDK transport', () => {
  beforeEach(() => {
    generations.length = 0;
    requests.length = 0;
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(10_000);
    vi.stubEnv('BOTMUX_LARK_WS_RECONNECT_STALE_MS', '100');
    vi.stubEnv('BOTMUX_LARK_WS_INBOUND_STALE_MS', '1000');
    vi.stubEnv('BOTMUX_LARK_WS_MAX_REBUILDS', '100');
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.spyOn(Lark.defaultHttpInstance, 'request').mockImplementation(options => new Promise(resolve => {
      requests.push({ signal: (options as { signal: AbortSignal }).signal, resolve });
    }));
  });
  afterEach(async () => {
    for (const handle of handles.splice(0)) handle.close({ force: true });
    for (const generation of generations) generation.client.close({ force: true });
    for (const request of requests) request.resolve({ code: 514, data: {} });
    await advance();
    for (const server of servers.splice(0)) {
      for (const peer of server.clients) peer.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('aborts a retired discovery, ignores its late success, and releases all timers on leader loss', async () => {
    const onReady = vi.fn();
    const onReconnected = vi.fn();
    const handle = connect({ onReady, onReconnected });
    await advance();
    expect(requests).toHaveLength(1);
    await advance(100);
    expect(requests).toHaveLength(2);
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests[1].signal.aborted).toBe(false);
    const staleData = vi.fn();
    requests[0].resolve({ code: 0, get data() { staleData(); return {}; } });
    await advance();
    expect(staleData).not.toHaveBeenCalled();
    const before = getLarkConnectionHealth(appId);
    generations[0].options.onReady?.();
    generations[0].options.onReconnected?.();
    generations[0].options.onReconnecting?.();
    generations[0].options.onError?.(new Error('retired callback'));
    generations[0].hooks.onInbound?.();
    expect(getLarkConnectionHealth(appId)).toEqual(before);
    expect(onReady).not.toHaveBeenCalled();
    expect(onReconnected).not.toHaveBeenCalled();
    handle.close({ force: true });
    await advance();
    expect(requests[1].signal.aborted).toBe(true);
    expect(getLarkConnectionHealth(appId)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await advance(100_000);
    expect(requests).toHaveLength(2);
  });

  it('does not build a new generation when the restart observer revokes leadership', async () => {
    let handle!: LarkConnection;
    const onRestarting = vi.fn(() => handle.close({ force: true }));
    handle = connect({ onRestarting });
    await advance(100);
    expect(onRestarting).toHaveBeenCalledOnce();
    expect(generations).toHaveLength(1);
    expect(requests[0].signal.aborted).toBe(true);
    requests[0].resolve({ code: 514, data: {} });
    await advance(100_000);
    expect(generations).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(getLarkConnectionHealth(appId)).toBeUndefined();
  });

  it('keeps recovery active when a restart observer throws without retaining old SDK timers', async () => {
    const onRestarting = vi.fn(() => { throw new Error('synthetic observer failure'); });
    const handle = connect({ onRestarting });
    await advance();
    const initialTimerCount = vi.getTimerCount();
    await advance(300);
    expect(onRestarting).toHaveBeenCalledTimes(3);
    expect(generations).toHaveLength(4);
    expect(requests.slice(0, -1).every(request => request.signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(initialTimerCount);
    handle.close({ force: true });
    await advance();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closing an old handle cannot unregister the replacement subscription health', async () => {
    const old = connect();
    await advance();
    const replacement = connect();
    await advance();
    old.close({ force: true });
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests[1].signal.aborted).toBe(false);
    expect(getLarkConnectionHealth(appId)?.state).toBe('connecting');
    replacement.close({ force: true });
    await advance();
    expect(getLarkConnectionHealth(appId)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains real retry ownership during cooldown and bounds timers across a long outage', async () => {
    vi.stubEnv('BOTMUX_LARK_WS_MAX_REBUILDS', '1');
    vi.stubEnv('BOTMUX_LARK_WS_INBOUND_STALE_MS', '100000');
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => { throw new Error('unexpected process exit'); });
    const handle = connect();
    await advance(100);
    expect(generations).toHaveLength(2);
    const baselineTimers = vi.getTimerCount();
    await advance(35_000);
    expect(requests[1].signal.aborted).toBe(true);
    await advance(500);
    expect(generations).toHaveLength(2);
    expect(requests).toHaveLength(3);
    expect(requests[2].signal.aborted).toBe(false);
    await advance(64_500);
    expect(generations).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(baselineTimers);
    for (let cycle = 0; cycle < 10; cycle++) {
      await advance(100_000);
      expect(generations).toHaveLength(4 + cycle);
      expect(vi.getTimerCount()).toBe(baselineTimers);
    }
    expect(exit).not.toHaveBeenCalled();
    expect(requests.slice(0, -1).every(request => request.signal.aborted)).toBe(true);
    handle.close({ force: true });
    await advance();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a real inbound frame after throttling restores burst recovery and closes the connected socket', async () => {
    vi.stubEnv('BOTMUX_LARK_WS_MAX_REBUILDS', '1');
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    let frames = 0;
    server.on('connection', peer => peer.on('message', data => { frames++; peer.send(data); }));
    const handle = connect();
    await advance(1100);
    expect(generations).toHaveLength(3);
    await advance(400);
    requests[2].resolve({ code: 0, data: {
      URL: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/socket?device_id=1&service_id=1`,
      ClientConfig: { PingInterval: 30, ReconnectCount: -1, ReconnectInterval: 0.02, ReconnectNonce: 0 },
    } });
    await waitForIo(() => frames > 0 && getLarkConnectionHealth(appId)?.lastInboundAt === Date.now());
    expect(handle.getConnectionStatus().state).toBe('connected');
    for (const peer of server.clients) peer.terminate();
    await waitForIo(() => handle.getConnectionStatus().state === 'reconnecting');
    await advance(100);
    expect(generations).toHaveLength(4);
    expect(requests).toHaveLength(4);
    handle.close({ force: true });
    await advance();
    await waitForIo(() => server.clients.size === 0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
