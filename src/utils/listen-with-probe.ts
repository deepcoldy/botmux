import type { Server } from 'node:http';
import type { Socket } from 'node:net';

/**
 * Default upward-probe span on EADDRINUSE when a caller doesn't pass `maxProbe`.
 * The dashboard binds wildcard at config.dashboard.port and can walk this many
 * ports up, so config.dashboard.ipcBasePort is kept clear of
 * [port, port + DEFAULT_PROBE_SPAN] to stop the dashboard from ever landing on a
 * loopback-shadowed IPC port (see config.ts + test/dashboard-ipc-port-range.test.ts).
 */
export const DEFAULT_PROBE_SPAN = 20;

/** How many times an `'unconfirmed'` verifyBound answer is retried before the
 *  port is kept anyway (see ListenWithProbeOpts.verifyRetries). */
export const DEFAULT_VERIFY_RETRIES = 3;
export const DEFAULT_VERIFY_RETRY_DELAY_MS = 1_000;
/** Budget for `server.close()` to complete during a release before the probe
 *  forces tracked sockets shut; twice this and the probe gives up with
 *  ERR_LISTEN_RELEASE_WEDGED instead of hanging silently. */
export const DEFAULT_RELEASE_TIMEOUT_MS = 5_000;

export const LISTEN_RELEASE_WEDGED_CODE = 'ERR_LISTEN_RELEASE_WEDGED';

/**
 * Outcome of a post-bind ownership check.
 *  - `true`          — the bound port answers as us: keep it.
 *  - `false`         — something ELSE answered on loopback (a shadow): release
 *                      the port and step up. This is the definitive verdict.
 *  - `'unconfirmed'` — nobody answered in time / the connection failed. That is
 *                      NOT evidence of a shadow; it is what an overloaded event
 *                      loop looks like from the inside. Retried, then the port
 *                      is kept (listen() did succeed and the pre-bind loopback
 *                      probe found it free moments earlier).
 */
export type VerifyBoundResult = boolean | 'unconfirmed';

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
   * actually-bound port. This exists to catch a wildcard (0.0.0.0) bind that
   * succeeds at the OS level yet is shadowed on loopback — on macOS another
   * process holding 127.0.0.1:port coexists with the wildcard bind and wins
   * loopback routing, so clients dialing 127.0.0.1:port reach the shadow, not
   * us. A loopback self-check (does 127.0.0.1:port answer as ME?) detects that
   * and re-probes, independent of which port number collided.
   *
   * Return `false` ONLY on a definitive wrong answer; return `'unconfirmed'`
   * (or throw) when the check simply could not complete. See VerifyBoundResult
   * for why the two must not be conflated: releasing a port we actually own is
   * the path that wedged the dashboard in 2026-09.
   */
  verifyBound?: (port: number) => VerifyBoundResult | Promise<VerifyBoundResult>;
  /** Retries for an `'unconfirmed'` verifyBound (default DEFAULT_VERIFY_RETRIES). */
  verifyRetries?: number;
  verifyRetryDelayMs?: number;
  /** See DEFAULT_RELEASE_TIMEOUT_MS. */
  releaseTimeoutMs?: number;
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
 *
 * Failure discipline: this promise MUST settle. Every wait inside it (the bind,
 * the verification, the release) is bounded; the worst case is a rejection
 * with a code the caller can log and act on, never a silent hang. The dashboard
 * starts its platform tunnel only after this resolves, so "hangs silently" here
 * reads as "machine offline" on the platform with nothing in the logs.
 */
export function listenWithProbe(opts: ListenWithProbeOpts): Promise<number> {
  const { server, host } = opts;
  const maxProbe = opts.maxProbe ?? DEFAULT_PROBE_SPAN;
  const portAvailable = opts.portAvailable;
  const verifyBound = opts.verifyBound;
  const verifyRetries = opts.verifyRetries ?? DEFAULT_VERIFY_RETRIES;
  const verifyRetryDelayMs = opts.verifyRetryDelayMs ?? DEFAULT_VERIFY_RETRY_DELAY_MS;
  const releaseTimeoutMs = opts.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
  const log = opts.log ?? (() => { /* noop */ });

  return new Promise<number>((resolve, reject) => {
    let port = opts.port;
    let attempts = 0;
    let settled = false;

    // Every socket accepted while we are still probing. server.close() waits
    // for accepted sockets to drain and closeAllConnections() only covers the
    // ones the http layer already knows about; holding our own handles lets a
    // release destroy them directly, whatever the runtime tracks.
    const tracked = new Set<Socket>();
    const onConnection = (sock: Socket) => {
      tracked.add(sock);
      sock.once('close', () => tracked.delete(sock));
    };
    const destroyTracked = (): number => {
      const n = tracked.size;
      for (const sock of tracked) {
        try { sock.destroy(); } catch { /* already gone */ }
      }
      tracked.clear();
      return n;
    };

    // Single persistent handlers reused across every probe attempt. Passing a
    // callback to server.listen() would instead add a fresh one-time
    // 'listening' listener on each retry that is never removed on a failed
    // bind, leaking listeners (MaxListenersExceededWarning past 10 probes) and
    // firing every stale callback once a bind finally succeeds.
    const cleanup = () => {
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
      server.removeListener('connection', onConnection);
      tracked.clear(); // post-bind sockets are the server's business, not ours
    };
    const finalize = (bound: number) => {
      settled = true;
      cleanup();
      // Keep a permanent handler so a post-bind runtime error can't become an
      // unhandled 'error' event (which would crash the process).
      server.on('error', (e) => log(`server error: ${(e as Error).message}`));
      resolve(bound);
    };
    const fail = (err: NodeJS.ErrnoException) => {
      settled = true;
      cleanup();
      reject(err);
    };
    // Release the just-bound port and step upward. Used when verifyBound rejects
    // a port that listen() accepted (loopback shadow). The same http.Server can
    // re-listen after close().
    //
    // Tearing the accepted sockets down is load-bearing, not defensive.
    // server.close() only stops accepting; it waits for every already-accepted
    // socket to drain, and its callback is where tryNext() — the only thing that
    // logs or steps — runs. So one lingering socket wedges the whole probe
    // *silently*: no LISTEN, no step to port+1, not a single log line.
    //
    // That is not hypothetical. 2026-09, twice: first a stale dashboard from an
    // older checkout kept dialing 127.0.0.1:7891, our listen() accepted it, it
    // hung up without reading, and the socket parked in CLOSE-WAIT with no timer
    // armed. Then, with closeAllConnections() already in place, a dashboard
    // whose event loop was starved by a synchronous /proc sweep timed out its
    // own self-check, released 7891 and again never came back — one CLOSE-WAIT
    // loopback socket owned by the process, no LISTEN, 29 minutes of silence
    // until a manual restart. Hence three layers now: destroy the sockets we
    // tracked ourselves, ask the http layer to close the rest, and bound the
    // wait — a wedge becomes a logged rejection the caller can turn into a
    // restart, instead of an outage nobody can see.
    const releaseAndStep = (bound: number, reason: string) => {
      destroyTracked();
      server.closeAllConnections?.();
      let closed = false;
      const forceTimer = setTimeout(() => {
        if (closed || settled) return;
        const n = destroyTracked();
        server.closeAllConnections?.();
        log(`port ${bound} release still pending after ${releaseTimeoutMs}ms; forced ${n} tracked socket(s) closed`);
      }, releaseTimeoutMs);
      const giveUpTimer = setTimeout(() => {
        if (closed || settled) return;
        const err = new Error(
          `port ${bound} release wedged: server.close() did not complete within ${releaseTimeoutMs * 2}ms`
          + ` (reason: ${reason}); the process cannot re-listen — restart it`,
        ) as NodeJS.ErrnoException;
        err.code = LISTEN_RELEASE_WEDGED_CODE;
        log(err.message);
        fail(err);
      }, releaseTimeoutMs * 2);
      server.close(() => {
        closed = true;
        clearTimeout(forceTimer);
        clearTimeout(giveUpTimer);
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
      let unconfirmed = 0;
      const attemptVerify = () => {
        if (settled) return;
        Promise.resolve()
          .then(() => verifyBound(bound))
          // A verifier that throws could not complete its check; that is the
          // same information as 'unconfirmed', not a verdict against the port.
          .catch((): VerifyBoundResult => 'unconfirmed')
          .then((result) => {
            if (settled) return;
            if (result === true) { finalize(bound); return; }
            if (result === false) { releaseAndStep(bound, 'shadowed'); return; }
            unconfirmed++;
            if (unconfirmed <= verifyRetries) {
              log(`port ${bound} ownership unconfirmed (attempt ${unconfirmed}/${verifyRetries + 1}), retrying in ${verifyRetryDelayMs}ms`);
              setTimeout(attemptVerify, verifyRetryDelayMs);
              return;
            }
            // listen() succeeded and the pre-bind loopback probe found the port
            // free; "we could not hear ourselves" is far more often a starved
            // event loop than a shadow that also happens to be mute. Keeping the
            // port degrades to "loopback clients might reach a shadow" on macOS;
            // releasing it is the path that wedged the dashboard. Keep, loudly.
            log(`port ${bound} ownership still unconfirmed after ${unconfirmed} attempts; keeping the bind`);
            finalize(bound);
          });
      };
      attemptVerify();
    };
    const rejectUnavailable = () => {
      const err = new Error(`No usable port found starting at ${opts.port}`) as NodeJS.ErrnoException;
      err.code = 'EADDRINUSE';
      fail(err);
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
          fail(err);
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
      fail(err);
    };

    server.on('listening', onListening);
    server.on('error', onError);
    server.on('connection', onConnection);
    attemptListen();
  });
}
