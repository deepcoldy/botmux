import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent } from 'proxy-agent';
import WebSocket from 'ws';

const mockWarn = vi.fn();
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: (...a: unknown[]) => mockWarn(...a), error: vi.fn(), isDebug: () => false },
}));

import {
  createLarkWsAgent,
  describeLarkWsProxy,
  describeWsRuntime,
  larkWsAgentFor,
  resolveLarkWsProxy,
} from '../src/im/lark/ws-proxy-agent.js';

const DOMAIN = 'https://open.feishu.cn';
const PROXY_ENV_KEYS = [
  'npm_config_https_proxy', 'NPM_CONFIG_HTTPS_PROXY',
  'https_proxy', 'HTTPS_PROXY',
  'npm_config_proxy', 'NPM_CONFIG_PROXY',
  'all_proxy', 'ALL_PROXY',
  'npm_config_no_proxy', 'NPM_CONFIG_NO_PROXY',
  'no_proxy', 'NO_PROXY',
  'wss_proxy', 'WSS_PROXY',
] as const;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of PROXY_ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  mockWarn.mockClear();
});
afterEach(() => {
  for (const k of PROXY_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveLarkWsProxy', () => {
  it('is direct when no proxy env is set', () => {
    expect(resolveLarkWsProxy(DOMAIN)).toEqual({ kind: 'direct' });
    expect(createLarkWsAgent(DOMAIN)).toBeUndefined();
  });

  it.each(['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'npm_config_https_proxy'])(
    'reads %s as an HTTP proxy', (key) => {
      process.env[key] = 'http://127.0.0.1:1';
      expect(resolveLarkWsProxy(DOMAIN)).toEqual({ kind: 'http', proxyUrl: 'http://127.0.0.1:1' });
    },
  );

  it('accepts a bare host as the Open API domain', () => {
    process.env.https_proxy = 'http://127.0.0.1:1';
    expect(resolveLarkWsProxy('open.larksuite.com').kind).toBe('http');
  });

  it('evaluates no_proxy against the Open API host', () => {
    process.env.https_proxy = 'http://127.0.0.1:1';
    process.env.no_proxy = 'open.feishu.cn';
    expect(resolveLarkWsProxy(DOMAIN)).toEqual({ kind: 'direct' });
    expect(createLarkWsAgent(DOMAIN)).toBeUndefined();
  });

  it('honours NO_PROXY domain suffixes', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    process.env.NO_PROXY = '.feishu.cn';
    expect(resolveLarkWsProxy(DOMAIN).kind).toBe('direct');
  });

  it('keeps the proxy when no_proxy does not match', () => {
    process.env.https_proxy = 'http://127.0.0.1:1';
    process.env.no_proxy = 'open.larksuite.com,localhost';
    expect(resolveLarkWsProxy(DOMAIN).kind).toBe('http');
  });

  it('ignores WSS_PROXY: the socket follows the HTTPS bootstrap semantics', () => {
    process.env.WSS_PROXY = 'http://127.0.0.1:2';
    expect(resolveLarkWsProxy(DOMAIN)).toEqual({ kind: 'direct' });
  });

  it('classifies socks proxies as other', () => {
    process.env.https_proxy = 'socks5://127.0.0.1:1080';
    expect(resolveLarkWsProxy(DOMAIN)).toEqual({ kind: 'other', proxyUrl: 'socks5://127.0.0.1:1080' });
  });
});

describe('larkWsAgentFor', () => {
  it('returns an HttpsProxyAgent whose proxy field carries the configured URL', () => {
    process.env.https_proxy = 'http://user:pw@127.0.0.1:1';
    const agent = createLarkWsAgent(DOMAIN);
    expect(agent).toBeInstanceOf(HttpsProxyAgent);
    // Bun's built-in ws reads exactly this field; Node's ws calls agent.connect().
    expect((agent as HttpsProxyAgent<string>).proxy.href).toBe('http://user:pw@127.0.0.1:1/');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('keeps the legacy ProxyAgent for non-HTTP proxies and warns only on Bun', () => {
    process.env.https_proxy = 'socks5://127.0.0.1:1080';
    const agent = createLarkWsAgent(DOMAIN);
    expect(agent).toBeInstanceOf(ProxyAgent);
    const onBun = Boolean((process.versions as Record<string, string | undefined>).bun);
    expect(mockWarn).toHaveBeenCalledTimes(onBun ? 1 : 0);
    if (onBun) expect(String(mockWarn.mock.calls[0][0])).toContain('socks5://127.0.0.1:1080');
  });

  it('is a no-op for a direct resolution', () => {
    expect(larkWsAgentFor({ kind: 'direct' })).toBeUndefined();
  });
});

describe('describeLarkWsProxy', () => {
  it('strips userinfo and path', () => {
    expect(describeLarkWsProxy({ kind: 'http', proxyUrl: 'http://u:p@h:8118/x' })).toBe('http://h:8118');
  });
  it('renders direct', () => {
    expect(describeLarkWsProxy({ kind: 'direct' })).toBe('direct');
  });
  it('names the runtime', () => {
    expect(describeWsRuntime()).toMatch(/^(bun \d|node v\d)/);
  });
});

/** Minimal CONNECT-capturing proxy: records the request line of every
 *  connection, then closes it so the client fails fast. */
function startFakeProxy(): Promise<{ server: Server; port: number; lines: string[]; connections: number; firstLine: Promise<string> }> {
  const state = { lines: [] as string[], connections: 0 };
  let resolveFirst!: (line: string) => void;
  const firstLine = new Promise<string>((resolve) => { resolveFirst = resolve; });
  const server = createServer((socket) => {
    state.connections += 1;
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      const eol = buf.indexOf('\r\n');
      if (eol === -1) return;
      const line = buf.slice(0, eol);
      state.lines.push(line);
      resolveFirst(line);
      socket.destroy();
    });
    socket.on('error', () => { /* client side closes abruptly; expected */ });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        port,
        get lines() { return state.lines; },
        get connections() { return state.connections; },
        firstLine,
      });
    });
  });
}

describe('integration: the runtime ws implementation tunnels through the agent', () => {
  it('sends CONNECT <hostname>:443 to the configured HTTP proxy', async () => {
    const proxy = await startFakeProxy();
    process.env.https_proxy = `http://127.0.0.1:${proxy.port}`;
    try {
      const agent = createLarkWsAgent(DOMAIN);
      expect(agent).toBeDefined();
      const ws = new WebSocket('wss://open.feishu.cn/callback/ws/endpoint', { agent } as WebSocket.ClientOptions);
      ws.on('error', () => { /* proxy drops the tunnel; the request line is what we assert */ });
      const line = await Promise.race([
        proxy.firstLine,
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('proxy saw no CONNECT within 5s')), 5_000)),
      ]);
      ws.terminate();
      // Hostname, not an IP literal — corporate proxies refuse the latter.
      expect(line).toMatch(/^CONNECT open\.feishu\.cn:443 HTTP\/1\.[01]$/);
    } finally {
      await new Promise<void>((resolve) => proxy.server.close(() => resolve()));
    }
  });
});
