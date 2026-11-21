// Run in a fresh Bun process, without test-runner exception handlers. All peers
// bind to loopback. The discovery POST's body never leaves this process.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Agent } from 'node:https';
import { type AddressInfo } from 'node:net';
import type { WebSocket } from 'ws';
import * as Lark from '@larksuiteoapi/node-sdk';
import { WebSocketServer } from '../helpers/node-ws.js';
import { createResilientWsClient } from '../../src/im/lark/transport/resilient-ws-client.js';

let phase: 'online' | 'handshake' | 'discovery' | 'restored' = 'online';
let handshakeCount = 0;
let tunnelCount = 0;
let tunnelClosed = false;
let discoveries = 0;
let reconnected = false;
const failures: string[] = [];
const ws = new WebSocketServer({ noServer: true });
const gateway = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    code: 0,
    data: {
      URL: `ws://127.0.0.1:${port}/socket?device_id=1&service_id=1`,
      ClientConfig: { PingInterval: 30, ReconnectCount: -1, ReconnectInterval: 0.02, ReconnectNonce: 0 },
    },
  }));
});
gateway.on('upgrade', (request, socket, head) => {
  if (phase === 'handshake') {
    handshakeCount++;
    phase = 'discovery';
    return; // Accept TCP and the upgrade request, never respond.
  }
  ws.handleUpgrade(request, socket, head, (peer: WebSocket) => {
    // Echo the SDK's real protobuf ping as a valid inbound control frame.
    peer.on('message', data => peer.send(data));
  });
});
gateway.on('connect', (_request, socket) => {
  socket.on('error', () => {});
  socket.once('end', () => { tunnelClosed = true; socket.end(); });
  socket.once('close', () => { tunnelClosed = true; });
  socket.resume();
  tunnelCount++;
  phase = 'restored'; // New requests succeed. This CONNECT remains unanswered.
});
await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
const { port } = gateway.address() as AddressInfo;
const origin = `http://127.0.0.1:${port}`;

// Only redirect the discovery URL. Preserve the SDK's actual Axios adapter,
// shorten its timeout, and use a real HTTP CONNECT proxy during the outage.
const httpInstance: Lark.HttpInstance = Object.create(Lark.defaultHttpInstance);
httpInstance.request = <T, R, D>(options: Lark.HttpRequestOptions<D>): Promise<R> => {
  const { signal, httpsAgent } = options as typeof options & { signal?: AbortSignal; httpsAgent?: Agent };
  discoveries++;
  const blocked = phase === 'discovery';
  // The SDK's default interceptor unwraps response.data for HttpInstance.
  return Lark.defaultHttpInstance.request<T, R>({
    method: 'post', data: {}, signal, httpsAgent,
    url: blocked ? 'https://127.0.0.2/callback/ws/endpoint' : origin + '/callback/ws/endpoint',
    proxy: blocked ? { protocol: 'http', host: '127.0.0.1', port } : false,
    timeout: blocked ? 100 : 5_000,
  }) as Promise<R>;
};
const client = createResilientWsClient({
  appId: 'cli_0000000000000000', appSecret: randomUUID(), httpInstance,
  handshakeTimeoutMs: 300, loggerLevel: Lark.LoggerLevel.error,
  onReady() {
    phase = 'handshake';
    for (const peer of ws.clients) peer.terminate();
  },
  onReconnected() { reconnected = true; },
}, {
  onAttemptFailed(_number, reason) { failures.push(reason); },
  onInbound() {
    if (!reconnected) return;
    assert.equal(client.getConnectionStatus().state, 'connected');
    assert.equal(handshakeCount, 1);
    assert.equal(tunnelCount, 1);
    assert.equal(tunnelClosed, true);
    assert.equal(discoveries, 4); // initial success, failed upgrade, stuck CONNECT, recovery
    assert.equal(failures.length, 2);
    console.log(JSON.stringify({ handshakeCount, tunnelCount, tunnelClosed, discoveries, failures, reconnected }));
    process.exit(0);
  },
}, { attemptTimeoutMs: 1_200, baseDelayMs: 5, maxDelayMs: 20 });

await client.start({ eventDispatcher: new Lark.EventDispatcher({}) });
setTimeout(() => {
  console.error('gateway probe timed out', { phase, handshakeCount, tunnelCount, discoveries, failures, state: client.getConnectionStatus().state });
  process.exit(1);
}, 8_000);
