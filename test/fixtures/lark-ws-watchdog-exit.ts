// Exercise the production watchdog and the SDK's actual HTTPS bootstrap path.
// The local CONNECT proxy accepts every connection and never replies.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import * as Lark from '@larksuiteoapi/node-sdk';
import { startLarkConnection } from '../../src/im/lark/transport/connection.js';

const proxy = createServer();
let connects = 0;
proxy.on('connect', (_req, socket) => {
  socket.on('error', () => {});
  console.log(`proxy-connect=${++connects}`);
});
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const address = proxy.address() as AddressInfo;
const proxyUrl = `http://127.0.0.1:${address.port}`;
for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) process.env[key] = proxyUrl;
for (const key of ['NO_PROXY', 'no_proxy', 'npm_config_no_proxy']) delete process.env[key];
process.env.BOTMUX_LARK_WS_RECONNECT_STALE_MS = '600';
process.env.BOTMUX_LARK_WS_MAX_REBUILDS = '1';
startLarkConnection('cli_0000000000000000', randomUUID(), new Lark.EventDispatcher({}));
setTimeout(() => { console.error('watchdog left the process online'); process.exit(2); }, 8_000);
