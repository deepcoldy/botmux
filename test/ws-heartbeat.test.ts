/**
 * Dead-peer reaping for server-side WebSockets. Bun 1.4.4 dropped the implicit
 * 120s idle timeout its ws server used to apply, so the web terminal and the
 * host terminal now rely on startWsHeartbeat to notice a peer that vanished
 * without a FIN. Runs against the real ws server under both vitest (npm ws) and
 * bun test (Bun's built-in ws port).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { startWsHeartbeat, type WsHeartbeat } from '../src/utils/ws-heartbeat.js';

const INTERVAL_MS = 100;

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function startServer(heartbeat: WsHeartbeat): Promise<{ port: number; serverSockets: Promise<WebSocket> }> {
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const serverSockets = new Promise<WebSocket>((resolve) => {
    wss.on('connection', (ws) => {
      ws.on('error', () => { /* raw test peers may misbehave */ });
      heartbeat.watch(ws);
      resolve(ws);
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(r => wss.close(() => r()));
    httpServer.closeAllConnections();
    await new Promise<void>(r => httpServer.close(() => r()));
  });
  const addr = httpServer.address();
  return { port: typeof addr === 'object' && addr ? addr.port : 0, serverSockets };
}

/** Completes the WebSocket handshake, then never answers anything: a peer that vanished without a FIN. */
function silentPeer(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write([
        'GET / HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '', '',
      ].join('\r\n'));
    });
    sock.once('error', reject);
    sock.once('data', (chunk) => {
      if (chunk.toString('latin1').startsWith('HTTP/1.1 101')) resolve(sock);
      else reject(new Error(`handshake failed: ${chunk.toString('latin1').split('\r\n')[0]}`));
    });
    cleanups.push(() => { sock.destroy(); });
  });
}

function closedWithin(ws: WebSocket, ms: number): Promise<boolean> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    ws.once('close', () => { clearTimeout(timer); resolve(true); });
  });
}

describe('startWsHeartbeat', () => {
  it('terminates a peer that never answers the ping', async () => {
    const heartbeat = startWsHeartbeat(INTERVAL_MS);
    cleanups.push(() => heartbeat.stop());
    const { port, serverSockets } = await startServer(heartbeat);
    await silentPeer(port);
    const serverWs = await serverSockets;

    expect(await closedWithin(serverWs, INTERVAL_MS * 10)).toBe(true);
  });

  it('keeps a peer that answers pings, even when it never sends a message', async () => {
    const heartbeat = startWsHeartbeat(INTERVAL_MS);
    cleanups.push(() => heartbeat.stop());
    const { port, serverSockets } = await startServer(heartbeat);
    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    cleanups.push(() => { client.terminate(); });
    let pings = 0;
    client.on('ping', () => { pings += 1; });
    const serverWs = await serverSockets;

    expect(await closedWithin(serverWs, INTERVAL_MS * 6)).toBe(false);
    expect(pings).toBeGreaterThanOrEqual(2);
    expect(serverWs.readyState).toBe(WebSocket.OPEN);
  });

  it('stops pinging and reaping after stop()', async () => {
    const heartbeat = startWsHeartbeat(INTERVAL_MS);
    const { port, serverSockets } = await startServer(heartbeat);
    await silentPeer(port);
    const serverWs = await serverSockets;
    heartbeat.stop();

    expect(await closedWithin(serverWs, INTERVAL_MS * 4)).toBe(false);
  });
});
