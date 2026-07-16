// test/terminal-proxy.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { parseTarget, startTerminalProxy, type TerminalProxyHandle } from '../src/core/terminal-proxy.js';

let proxy: TerminalProxyHandle | null = null;
let upstream: Server | null = null;
let upstreamWss: WebSocketServer | null = null;

afterEach(async () => {
  if (proxy) await proxy.close();
  proxy = null;
  if (upstreamWss) upstreamWss.close();
  upstreamWss = null;
  if (upstream) await new Promise<void>(r => upstream!.close(() => r()));
  upstream = null;
});

/** Spin up a fake worker: HTTP echoes the path it received; WS echoes messages + reports path. */
async function startFakeWorker(): Promise<number> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`worker-saw:${req.url}`);
  });
  upstreamWss = new WebSocketServer({ server: upstream });
  upstreamWss.on('connection', (ws, req) => {
    ws.send(`hello-path:${req.url}`);
    ws.on('message', (data) => ws.send(`echo:${data.toString()}`));
  });
  await new Promise<void>(r => upstream!.listen(0, '127.0.0.1', () => r()));
  return (upstream!.address() as { port: number }).port;
}

describe('parseTarget', () => {
  it('extracts sessionId and defaults rest to /', () => {
    expect(parseTarget('/s/abc')).toEqual({ sessionId: 'abc', rest: '/' });
  });
  it('handles trailing slash', () => {
    expect(parseTarget('/s/abc/')).toEqual({ sessionId: 'abc', rest: '/' });
  });
  it('preserves query when no path segment', () => {
    expect(parseTarget('/s/abc?token=x')).toEqual({ sessionId: 'abc', rest: '/?token=x' });
  });
  it('preserves trailing-slash + query', () => {
    expect(parseTarget('/s/abc/?token=x')).toEqual({ sessionId: 'abc', rest: '/?token=x' });
  });
  it('preserves sub-path', () => {
    expect(parseTarget('/s/abc/sub/path')).toEqual({ sessionId: 'abc', rest: '/sub/path' });
  });
  it('returns null for non-/s/ paths', () => {
    expect(parseTarget('/')).toBeNull();
    expect(parseTarget('/api/sessions')).toBeNull();
    expect(parseTarget('/s/')).toBeNull();
  });
  it('normalizes a leading fragment to a rooted path', () => {
    expect(parseTarget('/s/abc#frag')).toEqual({ sessionId: 'abc', rest: '/#frag' });
  });
});

describe('terminal proxy — HTTP', () => {
  it('strips /s/{id} prefix and forwards to the resolved worker port', async () => {
    const workerPort = await startFakeWorker();
    proxy = await startTerminalProxy({ port: 0, host: '127.0.0.1', resolvePort: () => workerPort });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/s/sess1/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('worker-saw:/');
  });

  it('preserves the token query string through the proxy', async () => {
    const workerPort = await startFakeWorker();
    proxy = await startTerminalProxy({ port: 0, host: '127.0.0.1', resolvePort: () => workerPort });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/s/sess1?token=secret`);
    expect(await res.text()).toBe('worker-saw:/?token=secret');
  });

  it('preserves the independent read-only view capability through the proxy', async () => {
    const workerPort = await startFakeWorker();
    proxy = await startTerminalProxy({ port: 0, host: '127.0.0.1', resolvePort: () => workerPort });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/s/sess1?viewToken=view-cap`);
    expect(await res.text()).toBe('worker-saw:/?viewToken=view-cap');
  });

  it('routes by sessionId via resolvePort', async () => {
    const workerPort = await startFakeWorker();
    const seen: string[] = [];
    proxy = await startTerminalProxy({
      port: 0,
      host: '127.0.0.1',
      resolvePort: (sid) => { seen.push(sid); return sid === 'known' ? workerPort : undefined; },
    });

    const ok = await fetch(`http://127.0.0.1:${proxy.port}/s/known/`);
    expect(ok.status).toBe(200);
    const bad = await fetch(`http://127.0.0.1:${proxy.port}/s/missing/`);
    expect(bad.status).toBe(502);
    expect(seen).toContain('known');
    expect(seen).toContain('missing');
  });

  it('returns 404 for non-session paths', async () => {
    proxy = await startTerminalProxy({ port: 0, host: '127.0.0.1', resolvePort: () => undefined });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/favicon.ico`);
    expect(res.status).toBe(404);
  });

  it('auto-increments to the next free port when the preferred port is taken', async () => {
    const blocker = createServer();
    await new Promise<void>(r => blocker.listen(0, '127.0.0.1', () => r()));
    const taken = (blocker.address() as { port: number }).port;
    try {
      const workerPort = await startFakeWorker();
      proxy = await startTerminalProxy({ port: taken, host: '127.0.0.1', resolvePort: () => workerPort });
      expect(proxy.port).toBeGreaterThan(taken);
      const res = await fetch(`http://127.0.0.1:${proxy.port}/s/sess1/`);
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>(r => blocker.close(() => r()));
    }
  });

  it('rejects when probing is disabled and the port is taken (maxProbe: 0)', async () => {
    const blocker = createServer();
    await new Promise<void>(r => blocker.listen(0, '127.0.0.1', () => r()));
    const taken = (blocker.address() as { port: number }).port;
    try {
      await expect(
        startTerminalProxy({ port: taken, host: '127.0.0.1', maxProbe: 0, resolvePort: () => undefined }),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>(r => blocker.close(() => r()));
    }
  });
});

describe('terminal proxy — WebSocket', () => {
  it('proxies a WS upgrade to the worker with prefix stripped + view capability preserved', async () => {
    const workerPort = await startFakeWorker();
    proxy = await startTerminalProxy({ port: 0, host: '127.0.0.1', resolvePort: () => workerPort });

    const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/s/sess1/?viewToken=abc`);
    const messages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send('ping'));
      ws.on('message', (data) => {
        messages.push(data.toString());
        if (messages.length === 2) resolve();
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('ws timeout')), 3000);
    });
    ws.close();

    expect(messages[0]).toBe('hello-path:/?viewToken=abc');
    expect(messages[1]).toBe('echo:ping');
  });

  it('relays a non-101 upstream response and closes (framing headers stripped)', async () => {
    upstream = createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    upstream.on('upgrade', (_req, sock) => {
      sock.write('HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nContent-Length: 9\r\n\r\nrejected!');
      sock.end();
    });
    await new Promise<void>(r => upstream!.listen(0, '127.0.0.1', () => r()));
    const workerPort = (upstream!.address() as { port: number }).port;
    proxy = await startTerminalProxy({ port: 0, host: '127.0.0.1', resolvePort: () => workerPort });

    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(proxy!.port, '127.0.0.1', () => {
        sock.write(
          'GET /s/sess1/ HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let buf = '';
      sock.on('data', d => { buf += d.toString(); });
      sock.on('close', () => resolve(buf));
      sock.on('error', reject);
      setTimeout(() => resolve(buf), 2500);
    });

    expect(raw).toContain('400 Bad Request');
    expect(raw).toContain('rejected!');
    expect(raw.toLowerCase()).toContain('connection: close');
    expect(raw.toLowerCase()).not.toContain('content-length');
  });

  it('destroys the socket when the session is unknown', async () => {
    proxy = await startTerminalProxy({ port: 0, host: '127.0.0.1', resolvePort: () => undefined });
    const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/s/missing/`);
    await new Promise<void>((resolve) => {
      ws.on('error', () => resolve());
      ws.on('close', () => resolve());
      setTimeout(resolve, 2000);
    });
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });
});

describe('terminal proxy — on-demand wake (ensureWorkerPort)', () => {
  it('wakes a worker via ensureWorkerPort when no live worker is registered', async () => {
    const workerPort = await startFakeWorker();
    let woke = 0;
    proxy = await startTerminalProxy({
      port: 0, host: '127.0.0.1',
      resolvePort: () => undefined,                       // nothing live
      ensureWorkerPort: async (sid) => { woke++; return sid === 'sleeping' ? workerPort : undefined; },
    });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/s/sleeping/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('worker-saw:/');
    expect(woke).toBe(1);
  });

  it('does NOT call ensureWorkerPort when a live worker exists (fast path)', async () => {
    const workerPort = await startFakeWorker();
    let woke = 0;
    proxy = await startTerminalProxy({
      port: 0, host: '127.0.0.1',
      resolvePort: () => workerPort,
      ensureWorkerPort: async () => { woke++; return undefined; },
    });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/s/sess1/`);
    expect(res.status).toBe(200);
    expect(woke).toBe(0);
  });

  it('returns 502 when neither a live worker nor a wake is possible', async () => {
    proxy = await startTerminalProxy({
      port: 0, host: '127.0.0.1',
      resolvePort: () => undefined,
      ensureWorkerPort: async () => undefined,
    });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/s/gone/`);
    expect(res.status).toBe(502);
  });

  it('collapses an ensureWorkerPort error to 502 (not a crash)', async () => {
    proxy = await startTerminalProxy({
      port: 0, host: '127.0.0.1',
      resolvePort: () => undefined,
      ensureWorkerPort: async () => { throw new Error('boom'); },
    });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/s/x/`);
    expect(res.status).toBe(502);
  });

  it('wakes a worker for a WS upgrade too', async () => {
    const workerPort = await startFakeWorker();
    proxy = await startTerminalProxy({
      port: 0, host: '127.0.0.1',
      resolvePort: () => undefined,
      ensureWorkerPort: async () => workerPort,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/s/sleeping/?token=abc`);
    const messages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send('ping'));
      ws.on('message', (data) => { messages.push(data.toString()); if (messages.length === 2) resolve(); });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('ws timeout')), 3000);
    });
    ws.close();
    expect(messages[0]).toBe('hello-path:/?token=abc');
    expect(messages[1]).toBe('echo:ping');
  });
});
