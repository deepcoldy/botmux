/**
 * Since bun 1.4.4, an 'error' on a server-side ws socket with no listener is an
 * uncaughtException (bad UTF-8, unmasked or oversize frames all raise one), and
 * the worker exits the whole session for it. worker.ts has no seam around its
 * web-terminal connection handler, so this guards the source shape: the listener
 * must be attached before the handler's first early return.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

describe('worker web-terminal sockets', () => {
  it('get an error listener before the connection handler can return', () => {
    const start = workerSource.indexOf("wss.on('connection', (ws, req: IncomingMessage) => {");
    expect(start).toBeGreaterThan(-1);
    const handler = workerSource.slice(start);
    const listener = handler.search(/\bws\.on\('error'/);
    expect(listener).toBeGreaterThan(-1);
    expect(listener).toBeLessThan(handler.indexOf('return;'));
  });

  it('are watched by the dead-peer heartbeat once registered', () => {
    const start = workerSource.indexOf("wss.on('connection', (ws, req: IncomingMessage) => {");
    const handler = workerSource.slice(start, workerSource.indexOf('listenWebTerminalWithFallback(', start));
    expect(handler).toMatch(/wsClients\.add\(ws\);\s*heartbeat\.watch\(ws\);/);
  });
});
