import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Lark from '@larksuiteoapi/node-sdk';
import { startLarkConnection } from '../src/im/lark/transport/connection.js';
import { getLarkConnectionHealth } from '../src/im/lark/transport/connection-health.js';
import { createResilientWsClient } from '../src/im/lark/transport/resilient-ws-client.js';
import { logger } from '../src/utils/logger.js';

type ClientOptions = Parameters<typeof createResilientWsClient>[0];
type Hooks = NonNullable<Parameters<typeof createResilientWsClient>[1]>;
let capturedWsClientOptions: ClientOptions | undefined;
const clients: Array<{
  options: ClientOptions; hooks: Hooks; start: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>;
  getConnectionStatus: () => { state: Lark.WSConnectionState; reconnectAttempts: number };
}> = [];
vi.mock('../src/im/lark/transport/resilient-ws-client.js', () => ({
  createResilientWsClient: (options: ClientOptions, hooks: Hooks) => {
    capturedWsClientOptions = options;
    const client = {
      options, hooks,
      start: vi.fn(async () => {}), close: vi.fn(),
      getConnectionStatus: () => ({ state: 'connecting' as Lark.WSConnectionState, reconnectAttempts: 0 }),
    };
    clients.push(client);
    return client;
  },
}));

const eventDispatcher = new Lark.EventDispatcher({});
let tick: () => void;
let now: number;
beforeEach(() => {
  now = 100;
  capturedWsClientOptions = undefined;
  clients.length = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(globalThis, 'setInterval').mockImplementation(callback => {
    tick = () => callback();
    return { unref() {} } as NodeJS.Timeout;
  });
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('startLarkConnection', () => {
  it.each(['feishu', 'lark'] as const)('preserves %s dial options and passes the dispatcher unchanged', brand => {
    vi.stubEnv('DEBUG', '');
    const handle = startLarkConnection('app-test', '', eventDispatcher, brand);
    expect(clients[0].options).toMatchObject({
      appId: 'app-test', domain: brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
      loggerLevel: Lark.LoggerLevel.warn, wsConfig: { pingTimeout: 30 }, handshakeTimeoutMs: 15_000,
    });
    expect(clients[0].start).toHaveBeenCalledExactlyOnceWith({ eventDispatcher });
    handle.close();
  });

  it('replaces a stalled reconnect, fences retired callbacks, and closes the current generation on leadership loss', () => {
    vi.stubEnv('BOTMUX_LARK_WS_RECONNECT_STALE_MS', '500');
    const onRestarting = vi.fn();
    const onReconnected = vi.fn();
    const handle = startLarkConnection('app-test', '', eventDispatcher, 'feishu', { onRestarting, onReconnected });
    const old = clients[0];
    old.hooks.onAttempt?.(1);
    old.options.onReady?.();
    old.hooks.onInbound?.();
    old.options.onReconnecting?.();
    old.getConnectionStatus = () => ({ state: 'reconnecting', reconnectAttempts: 1 });
    old.hooks.onAttempt?.(1);
    now += 499;
    tick();
    expect(clients).toHaveLength(1);
    now++;
    tick();
    expect(clients).toHaveLength(2);
    expect(onRestarting).toHaveBeenCalledOnce();
    expect(old.close).toHaveBeenCalledExactlyOnceWith({ force: true });
    expect(clients[1].start).toHaveBeenCalledExactlyOnceWith({ eventDispatcher });
    old.hooks.onInbound?.();
    old.options.onReconnected?.();
    expect(onReconnected).not.toHaveBeenCalled();
    clients[1].hooks.onAttempt?.(1);
    clients[1].options.onReady?.();
    expect(onReconnected).toHaveBeenCalledOnce();
    expect(getLarkConnectionHealth('app-test')).toMatchObject({ state: 'connected', attempts: 2, lastInboundAt: 100 });
    handle.close({ force: true });
    now += 500;
    tick();
    expect(clients).toHaveLength(2);
    expect(clients[1].close).toHaveBeenCalledOnce();
    expect(getLarkConnectionHealth('app-test')).toBeUndefined();
  });

  it('honors a subscription closed inside the rebuild notification', () => {
    vi.stubEnv('BOTMUX_LARK_WS_RECONNECT_STALE_MS', '500');
    const handle = startLarkConnection('app-test', '', eventDispatcher, 'feishu', {
      onRestarting: () => handle.close(),
    });
    now += 500;
    tick();
    now += 500;
    tick();
    expect(clients).toHaveLength(1);
    expect(getLarkConnectionHealth('app-test')).toBeUndefined();
  });

  it('bounds bootstrap and connected sockets that stop receiving frames; real pongs reset the rebuild budget', () => {
    vi.stubEnv('BOTMUX_LARK_WS_MAX_REBUILDS', '1');
    vi.stubEnv('BOTMUX_LARK_WS_INBOUND_STALE_MS', '500');
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => { throw new Error('fatal exit'); });
    const handle = startLarkConnection('app-test', '', eventDispatcher);
    now += 500;
    tick(); // no HTTP bootstrap result
    const second = clients[1];
    second.getConnectionStatus = () => ({ state: 'connected', reconnectAttempts: 0 });
    second.options.onReady?.();
    now += 499;
    second.hooks.onInbound?.();
    tick();
    now += 499;
    tick();
    expect(clients).toHaveLength(2);
    now++;
    tick(); // silent, but the inbound frame earned another rebuild
    expect(clients).toHaveLength(3);
    clients[2].getConnectionStatus = () => ({ state: 'failed', reconnectAttempts: 0 });
    expect(() => tick()).toThrow('fatal exit');
    expect(exit).toHaveBeenCalledWith(1);
    handle.close();
  });
});

const WS_PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'NPM_CONFIG_HTTPS_PROXY',
  'npm_config_https_proxy',
  'NPM_CONFIG_PROXY',
  'npm_config_proxy',
  'NPM_CONFIG_NO_PROXY',
  'npm_config_no_proxy',
] as const;

function withWsProxyEnv(values: Partial<Record<(typeof WS_PROXY_ENV_KEYS)[number], string>>, callback: () => void): void {
  const original = Object.fromEntries(
    WS_PROXY_ENV_KEYS.map(key => [key, process.env[key]]),
  );
  for (const key of WS_PROXY_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);

  try {
    callback();
  } finally {
    for (const key of WS_PROXY_ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('startLarkConnection — WebSocket proxy', () => {
  it('uses HTTPS proxy precedence for secure WebSocket URLs', () => {
    withWsProxyEnv({
      HTTPS_PROXY: 'http://upper-proxy:8118',
      https_proxy: 'http://lower-proxy:8118',
    }, () => {
      startLarkConnection('app-test', 'secret', eventDispatcher);

      const agent = capturedWsClientOptions?.agent as any;
      // Must be HttpsProxyAgent, not ProxyAgent: Bun's built-in ws reads the
      // proxy URL off `agent.proxy` (the HttpsProxyAgent shape) and silently
      // ignores a ProxyAgent, so an http proxy has to arrive as HttpsProxyAgent
      // for both runtimes. proxy-from-env prefers the lowercase https_proxy.
      expect(agent?.constructor?.name).toBe('HttpsProxyAgent');
      expect((agent as { proxy?: URL })?.proxy?.href).toBe('http://lower-proxy:8118/');
    });
  });

  it('honors NO_PROXY for the WebSocket destination', () => {
    withWsProxyEnv({
      HTTPS_PROXY: 'http://proxy.example:8118',
      NO_PROXY: '.feishu.cn',
    }, () => {
      startLarkConnection('app-test', 'secret', eventDispatcher);

      // The proxy is resolved once for the bot's own Open API domain
      // (open.feishu.cn); NO_PROXY=.feishu.cn matches it, so the connection is
      // direct and no agent is attached.
      expect(capturedWsClientOptions?.agent).toBeUndefined();
    });
  });

  it('supports an ALL_PROXY fallback such as SOCKS', () => {
    withWsProxyEnv({ ALL_PROXY: 'socks5://127.0.0.1:1080' }, () => {
      startLarkConnection('app-test', 'secret', eventDispatcher);

      const agent = capturedWsClientOptions?.agent as any;
      expect(agent?.getProxyForUrl('wss://msg-frontier.feishu.cn/ws', {})).toBe('socks5://127.0.0.1:1080');
    });
  });

  it('keeps the SDK default agent when no proxy is configured', () => {
    withWsProxyEnv({}, () => {
      startLarkConnection('app-test', 'secret', eventDispatcher);

      expect(capturedWsClientOptions?.agent).toBeUndefined();
    });
  });
});
