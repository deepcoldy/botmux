// Exercise the production watchdog and the SDK's actual HTTPS bootstrap path.
// The local CONNECT proxy accepts every connection and never replies.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import * as Lark from '@larksuiteoapi/node-sdk';
import { startLarkConnection } from '../../src/im/lark/transport/connection.js';

const proxy = createServer();
let connects = 0;
let sockets = 0;
let maxSockets = 0;
proxy.on('connect', (_req, socket) => {
  socket.on('error', () => {});
  socket.on('end', () => socket.end());
  socket.on('close', () => { sockets--; });
  connects++;
  maxSockets = Math.max(maxSockets, ++sockets);
});
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const address = proxy.address() as AddressInfo;
const proxyUrl = `http://127.0.0.1:${address.port}`;
for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) process.env[key] = proxyUrl;
for (const key of ['NO_PROXY', 'no_proxy', 'npm_config_no_proxy']) delete process.env[key];
process.env.BOTMUX_LARK_WS_RECONNECT_STALE_MS = '600';
process.env.BOTMUX_LARK_WS_INBOUND_STALE_MS = '1200';
process.env.BOTMUX_LARK_WS_MAX_REBUILDS = '1';
const deadline = setTimeout(() => { console.error('watchdog probe did not finish'); process.exit(2); }, 8_000);
const connection = startLarkConnection('cli_0000000000000000', randomUUID(), new Lark.EventDispatcher({}));
await delay(3800);
connection.close({ force: true });
await delay(200);
// Bun can leave server.close() pending after every CONNECT tunnel socket has
// already emitted 'close'; closeAllConnections flushes that stale tracking.
proxy.closeAllConnections();
await new Promise<void>(resolve => proxy.close(() => resolve()));
clearTimeout(deadline);
console.log(JSON.stringify({ alive: true, connects, maxSockets, remainingSockets: sockets }));
