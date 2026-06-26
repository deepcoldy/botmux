import type { Server } from 'node:http';

/**
 * Default upward-probe span on EADDRINUSE when a caller doesn't pass `maxProbe`.
 * The dashboard binds wildcard at config.dashboard.port and can walk this many
 * ports up, so config.dashboard.ipcBasePort is kept clear of
 * [port, port + DEFAULT_PROBE_SPAN] to stop the dashboard from ever landing on a
 * loopback-shadowed IPC port (see config.ts + test/dashboard-ipc-port-range.test.ts).
 */
export const DEFAULT_PROBE_SPAN = 20;

export interface ListenWithProbeOpts {
  server: Server;
  /** Preferred port to try first. */
  port: number;
  host: string;
  /** Max upward probes on EADDRINUSE before rejecting (default DEFAULT_PROBE_SPAN). */
  maxProbe?: number;
  /** Optional caller-specific availability gate before attempting a bind. */
  portAvailable?: (port: number) => boolean | Promise<boolean>;
  /**
   * Optional post-bind verification, run AFTER a successful listen with the
   * actually-bound port. Return false to REJECT the port: the server is closed
   * and the probe steps to port+1. This exists to catch a wildcard (0.0.0.0)
   * bind that succeeds at the OS level yet is shadowed on loopback — on macOS
   * another process holding 127.0.0.1:port coexists with the wildcard bind and
   * wins loopback routing, so clients dialing 127.0.0.1:port reach the shadow,
   * not us. A loopback self-check (does 127.0.0.1:port answer as ME?) detects
   * that and re-probes, independent of which port number collided.
   */
  verifyBound?: (port: number) => boolean | Promise<boolean>;
  log?: (msg: string) => void;
}

/**
 * Bind `server` to `port`, walking port+1, port+2 … up to `maxProbe` times when
 * the port is already in use, and resolve with the actually-bound port.
 *
 * Why this exists: several daemon/dashboard listeners (dashboard-ipc-server.ts,
 * dashboard.ts) historically did a single `server.listen(fixedPort)` with no
 * 'error' listener / no probe, so on a shared machine a second botmux instance
 * binding the same default port emitted an UNHANDLED 'error' that crashed the
 * whole process (the IPC bind even took the daemon down at startup). This
 * mirrors the already-proven probe in core/terminal-proxy.ts so those binds
 * self-heal to a free port; callers MUST advertise the returned (bound) port to
 * their consumers (the IPC port via the daemon descriptor, the dashboard port
 * via ~/.botmux/.dashboard-port) since it may differ from the requested one.
 */
export function listenWithProbe(opts: ListenWithProbeOpts): Promise<number> {
  const { server, host } = opts;
  const maxProbe = opts.maxProbe ?? DEFAULT_PROBE_SPAN;
  const portAvailable = opts.portAvailable;
  const verifyBound = opts.verifyBound;
  const log = opts.log ?? (() => { /* noop */ });

  return new Promise<number>((resolve, reject) => {
    let port = opts.port;
    let attempts = 0;
    let settled = false;

    // Single persistent handlers reused across every probe attempt. Passing a
    // callback to server.listen() would instead add a fresh one-time
    // 'listening' listener on each retry that is never removed on a failed
    // bind, leaking listeners (MaxListenersExceededWarning past 10 probes) and
    // firing every stale callback once a bind finally succeeds.
    const cleanup = () => {
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
    };
    const finalize = (bound: number) => {
      settled = true;
      cleanup();
      // Keep a permanent handler so a post-bind runtime error can't become an
      // unhandled 'error' event (which would crash the process).
      server.on('error', (e) => log(`server error: ${(e as Error).message}`));
      resolve(bound);
    };
    // Release the just-bound port and step upward. Used when verifyBound rejects
    // a port that listen() accepted (loopback shadow). The same http.Server can
    // re-listen after close(); since a shadowed loopback request reached the
    // OTHER process, our server has no in-flight verify connection to drain here.
    const releaseAndStep = (bound: number, reason: string) => {
      server.close(() => {
        if (settled) return;
        port = bound;
        if (!tryNext(reason)) rejectUnavailable();
      });
    };
    const onListening = () => {
      if (settled) return;
      const addr = server.address();
      const bound = typeof addr === 'object' && addr ? addr.port : port;
      if (!verifyBound) { finalize(bound); return; }
      Promise.resolve(verifyBound(bound)).then((ok) => {
        if (settled) return;
        if (ok) { finalize(bound); return; }
        releaseAndStep(bound, 'shadowed');
      }).catch(() => {
        if (settled) return;
        // Couldn't confirm we own the port — treat conservatively as unusable.
        releaseAndStep(bound, 'verify-failed');
      });
    };
    const rejectUnavailable = () => {
      const err = new Error(`No usable port found starting at ${opts.port}`) as NodeJS.ErrnoException;
      err.code = 'EADDRINUSE';
      settled = true;
      cleanup();
      reject(err);
    };
    const tryNext = (reason: string): boolean => {
      if (attempts >= maxProbe) return false;
      attempts++;
      log(`port ${port} ${reason}, trying ${port + 1}`);
      port++;
      setImmediate(attemptListen);
      return true;
    };
    const attemptListen = () => {
      if (settled) return;
      if (port !== 0 && portAvailable) {
        Promise.resolve(portAvailable(port)).then((ok) => {
          if (settled) return;
          if (!ok) {
            if (!tryNext('unavailable')) rejectUnavailable();
            return;
          }
          server.listen(port, host);
        }).catch((err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        });
        return;
      }
      server.listen(port, host);
    };
    const onError = (err: NodeJS.ErrnoException) => {
      if (settled) return;
      if (err.code === 'EADDRINUSE' && tryNext('in use')) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    };

    server.on('listening', onListening);
    server.on('error', onError);
    attemptListen();
  });
}
