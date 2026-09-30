import type { IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';

// Test entry point only. Keep the real handshake, signature checks and worker
// connection handler; advance time only while the post-upgrade handler runs.
// Unlike estimating a TTL from HTTP latency, this always crosses the intended
// boundary, regardless of CI load. Unmarked requests retain the real clock.
const emit = WebSocketServer.prototype.emit;
WebSocketServer.prototype.emit = function (event: string | symbol, ...args: unknown[]): boolean {
  const req = event === 'connection' ? args[1] as IncomingMessage : undefined;
  const rawNow = req?.headers['x-botmux-test-recheck-now'];
  if (typeof rawNow !== 'string') return Reflect.apply(emit, this, [event, ...args]);
  const now = Number(rawNow);
  if (!Number.isSafeInteger(now)) throw new Error('Invalid re-check clock');
  const realNow = Date.now;
  Date.now = () => now;
  try {
    return Reflect.apply(emit, this, [event, ...args]);
  } finally {
    Date.now = realNow;
  }
};

await import('../../src/worker.js');
