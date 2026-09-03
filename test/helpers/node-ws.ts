import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type WS from 'ws';

/**
 * The Node `ws` implementation, loaded by filesystem path.
 *
 * Bun aliases the `ws` specifier to its native WebSocket (browser API: no
 * `headers` option, Origin is `null`). Tests that assert Cookie / Origin /
 * custom upgrade headers need the real CJS client, on both runners.
 */
const require = createRequire(import.meta.url);
const wsPkgDir = dirname(require.resolve('ws/package.json'));
const ws = require(join(wsPkgDir, 'index.js')) as typeof WS & {
  WebSocketServer: typeof WS.WebSocketServer;
};

export const WebSocket = ws;
export const WebSocketServer = ws.WebSocketServer;
