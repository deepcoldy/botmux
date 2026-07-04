import type { Server as HttpServer } from 'node:http';
import type { WebSocketServer } from 'ws';

export interface ListenWebTerminalOpts {
  httpServer: HttpServer;
  wss: WebSocketServer;
  host: string;
  /** Try this port first; fall back to an OS-assigned random port if busy. */
  preferredPort?: number;
  log?: (msg: string) => void;
}

/**
 * Bind the per-session web-terminal HTTP server, recovering from a busy
 * `preferredPort` (e.g. a persisted webPort reused on worker re-fork that some
 * other process now holds) by retrying on an OS-assigned random port.
 *
 * CRITICAL — why the `wss.on('error')` below is load-bearing, not cosmetic:
 * `new WebSocketServer({ server })` makes the ws library proxy the HTTP server's
 * `'error'` event onto the WSS instance (ws ≥8: `addListeners` runs
 * `server.on('error', wss.emit.bind(wss, 'error'))` at construction time). That
 * proxy listener is registered BEFORE the HTTP server's own `'error'` handler
 * here. So on EADDRINUSE the proxy fires first and re-emits `'error'` on the
 * WSS; with no `'error'` listener on the WSS, Node throws an unhandled `'error'`
 * event and CRASHES the whole worker process — before the HTTP fallback below
 * ever runs, making the random-port recovery dead code. Note: ordering the HTTP
 * handler first does NOT help (verified) — the unhandled WSS error still fires.
 * The only fix is to give the WSS an `'error'` listener. Regression-tested in
 * test/web-terminal-listen.test.ts.
 */
export function listenWebTerminalWithFallback(opts: ListenWebTerminalOpts): Promise<number> {
  const { httpServer, wss, host, preferredPort } = opts;
  const log = opts.log ?? (() => { /* noop */ });

  return new Promise<number>((resolve, reject) => {
    // Defuse the ws→wss error proxy so a bind failure can't crash the process;
    // the httpServer 'error' handler below owns recovery / rejection.
    wss.on('error', (err: NodeJS.ErrnoException) => {
      log(`WSS server error: ${[err.code, err.message].filter(Boolean).join(' ')}`);
    });

    const currentPort = (): number => {
      const addr = httpServer.address();
      return typeof addr === 'object' && addr ? addr.port : 0;
    };

    const listenPort = preferredPort ?? 0;
    let fallbackAttempted = false;
    let settled = false;

    const settleResolve = (port: number) => {
      if (settled) return;
      settled = true;
      resolve(port);
    };
    const settleReject = (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const listen = (port: number, suffix = '') => {
      httpServer.listen(port, host, () => {
        const boundPort = currentPort();
        log(`HTTP listening on ${host}:${boundPort}${suffix}`);
        settleResolve(boundPort);
      });
    };

    // Register before listen(): bind failures are asynchronous 'error' events,
    // and the recovery handler must be present before the first listen attempt.
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      // This handler outlives the Promise (we never detach it). Once we've
      // resolved/rejected, a late 'error' must be inert — otherwise an
      // EADDRINUSE arriving after a no-fallback resolve would re-enter listen()
      // on an already-listening server (ERR_SERVER_ALREADY_LISTEN, thrown
      // synchronously from the emit → unhandled → crash). Defense in depth.
      if (settled) return;
      if (err.code === 'EADDRINUSE' && !fallbackAttempted) {
        fallbackAttempted = true;
        if (preferredPort) {
          log(`Preferred port ${preferredPort} in use (${err.code}), falling back to random`);
        } else {
          log(`Port ${listenPort} bind failed (${err.code}), retrying with random port`);
        }
        listen(0, ' (fallback)');
      } else {
        settleReject(err);
      }
    });

    listen(listenPort);
  });
}
