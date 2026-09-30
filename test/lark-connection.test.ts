import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Lark from '@larksuiteoapi/node-sdk';
import { startLarkConnection } from '../src/im/lark/transport/connection.js';
import { logger } from '../src/utils/logger.js';

let capturedWsClientOptions: Record<string, any> | undefined;
vi.mock('@larksuiteoapi/node-sdk', () => {
  class MockWSClient {
    constructor(options: Record<string, any>) {
      capturedWsClientOptions = options;
    }
    start = vi.fn(async () => {});
    getConnectionStatus = vi.fn(() => ({ state: 'connected', reconnectAttempts: 0 }));
  }
  return {
    EventDispatcher: class {},
    WSClient: MockWSClient,
    LoggerLevel: { info: 2, warn: 3 },
  };
});

// No registry, session, card, filesystem or PTY mocks: the connection accepts an
// already registered SDK dispatcher and needs no business bootstrap.
const eventDispatcher = new Lark.EventDispatcher({});
let tick: () => void;
let intervalMs: number | undefined;
const unref = vi.fn();

beforeEach(() => {
  capturedWsClientOptions = undefined;
  unref.mockClear();
  vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay) => {
    tick = () => callback();
    intervalMs = delay;
    // Only unref is used by the connection; probes are driven explicitly.
    return { unref } as unknown as NodeJS.Timeout;
  });
  vi.spyOn(logger, 'info').mockImplementation(() => {});
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// Drain the start().catch().finally() chain without advancing any real timer.
async function probeRecovery(): Promise<void> {
  tick();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('startLarkConnection — lifecycle', () => {
  it.each(['feishu', 'lark'] as const)('preserves %s connection options and passes the dispatcher unchanged', (brand) => {
    vi.stubEnv('DEBUG', '');
    const client = startLarkConnection('app-test', 'secret', eventDispatcher, brand);
    expect(client).toBeInstanceOf(Lark.WSClient);
    expect(capturedWsClientOptions).toMatchObject({
      appId: 'app-test',
      appSecret: 'secret',
      domain: brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
      loggerLevel: Lark.LoggerLevel.warn,
      wsConfig: { pingTimeout: 30 },
      handshakeTimeoutMs: 15_000,
    });
    expect(client.start).toHaveBeenCalledExactlyOnceWith({ eventDispatcher });
    expect(intervalMs).toBe(60_000);
    expect(unref).toHaveBeenCalledOnce();
  });

  it('defaults to Feishu, honors DEBUG and retains connection diagnostics', () => {
    vi.stubEnv('DEBUG', '1');
    startLarkConnection('app-test', 'secret', eventDispatcher);
    expect(capturedWsClientOptions?.domain).toBe('https://open.feishu.cn');
    expect(capturedWsClientOptions?.loggerLevel).toBe(Lark.LoggerLevel.info);
    capturedWsClientOptions?.onReconnecting();
    capturedWsClientOptions?.onReconnected();
    capturedWsClientOptions?.onError(new Error('offline'));
    expect(logger.warn).toHaveBeenCalledWith('[ws] app-test reconnecting…');
    expect(logger.info).toHaveBeenCalledWith('[ws] app-test reconnected');
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/^\[ws\] app-test connecting domain=https:\/\/open\.feishu\.cn proxy=.+ runtime=.+$/));
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/^\[ws\] app-test terminal error: offline \(proxy=.+ runtime=.+\)$/));
  });

  it.each(['connected', 'connecting', 'reconnecting', 'idle'] as const)('does not restart while the SDK is %s', async (state) => {
    const client = startLarkConnection('app-test', 'secret', eventDispatcher);
    vi.mocked(client.getConnectionStatus).mockReturnValue({ state, reconnectAttempts: 0 });
    await probeRecovery();
    expect(client.start).toHaveBeenCalledTimes(1);
  });

  it('restarts a failed connection with the same dispatcher and does not overlap pending recovery', async () => {
    const client = startLarkConnection('app-test', 'secret', eventDispatcher);
    vi.mocked(client.getConnectionStatus).mockReturnValue({ state: 'failed', reconnectAttempts: 3 });
    let finish!: () => void;
    vi.mocked(client.start).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await probeRecovery();
    expect(client.start).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^\[ws\] app-test connection failed \(reconnect exhausted, proxy=.+ runtime=.+\), restarting WSClient$/));
    expect(client.start).toHaveBeenLastCalledWith({ eventDispatcher });
    await probeRecovery();
    expect(client.start).toHaveBeenCalledTimes(2);
    vi.mocked(client.getConnectionStatus).mockReturnValue({ state: 'connected', reconnectAttempts: 0 });
    finish();
    await probeRecovery();
    await probeRecovery();
    expect(client.start).toHaveBeenCalledTimes(2);
    // A later terminal failure can start a new recovery round.
    vi.mocked(client.getConnectionStatus).mockReturnValue({ state: 'failed', reconnectAttempts: 3 });
    await probeRecovery();
    expect(client.start).toHaveBeenCalledTimes(3);
  });

  it('logs rejected recovery and allows another attempt on the next probe', async () => {
    const client = startLarkConnection('app-test', 'secret', eventDispatcher);
    vi.mocked(client.getConnectionStatus).mockReturnValue({ state: 'failed', reconnectAttempts: 3 });
    vi.mocked(client.start).mockRejectedValueOnce(new Error('network unavailable'));
    await probeRecovery();
    expect(logger.error).toHaveBeenCalledWith('[ws] app-test WSClient restart failed: network unavailable');
    await probeRecovery();
    expect(client.start).toHaveBeenCalledTimes(3);
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

      const agent = capturedWsClientOptions?.agent;
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

      const agent = capturedWsClientOptions?.agent;
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
