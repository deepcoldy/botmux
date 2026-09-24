/**
 * Regression: a fixed-port http server bind must NOT crash on EADDRINUSE when
 * another process (e.g. a second botmux instance on a shared machine) already
 * holds the port. listenWithProbe mirrors core/terminal-proxy.ts: it probes
 * port+1.. up to maxProbe times and resolves with the actually-bound port, so
 * the dashboard IPC server (dashboard-ipc-server.ts) and the dashboard process
 * (dashboard.ts) step to a free port instead of emitting an unhandled 'error'
 * that tears the process down.
 *
 * Run: pnpm vitest run test/listen-with-probe.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, get, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { listenWithProbe, LISTEN_RELEASE_WEDGED_CODE } from '../src/utils/listen-with-probe.js';

const open: Server[] = [];
function mk(): Server { const s = createServer((_q, r) => r.end('ok')); open.push(s); return s; }
function rawListen(s: Server, port: number, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(port, host, () => { const a = s.address(); resolve(typeof a === 'object' && a ? a.port : 0); });
  });
}
afterEach(async () => { for (const s of open.splice(0)) await new Promise<void>(r => s.close(() => r())); });

/**
 * Reserve a port `p` such that `p + 1` is ALSO free right now, and return `p`
 * with nothing bound.
 *
 * WHY: every case here exercises "requested port busy → step to port+1", so it
 * needs a base port whose successor is available. Asking the OS for an ephemeral
 * port (`listen(0)`) only guarantees the port itself — on a shared runner the
 * neighbour can already be held by an unrelated process, and then
 * `rawListen(mk(), busy + 1)` rejects with EADDRINUSE and the case fails on its
 * own fixture. MEASURED on CI: `Failed to start server. Is port 33638 in use?`
 * raised from rawListen, reported as "rejects once maxProbe is exhausted"
 * failing — a fixture collision wearing the assertion's name.
 *
 * Probing both and retrying removes the assumption instead of widening a
 * tolerance: we only proceed once the OS has told us both are bindable.
 */
async function reserveAdjacentPair(attempts = 40): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const probe = createServer();
    const base = await new Promise<number>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const a = probe.address();
        resolve(typeof a === 'object' && a ? a.port : 0);
      });
    });
    // Hold `base` while testing the neighbour, so nothing can slip into `base`
    // between the two checks.
    const neighbourFree = await new Promise<boolean>((resolve) => {
      const nb = createServer();
      nb.once('error', () => resolve(false));
      nb.listen(base + 1, '127.0.0.1', () => nb.close(() => resolve(true)));
    });
    await new Promise<void>(r => probe.close(() => r()));
    if (neighbourFree) return base;
  }
  throw new Error('could not reserve a free adjacent port pair');
}

describe('listenWithProbe', () => {
  it('binds the requested port when it is free', async () => {
    const port = await listenWithProbe({ server: mk(), port: 0, host: '127.0.0.1' });
    expect(port).toBeGreaterThan(0);
  });

  it('skips ports rejected by caller-specific availability checks', async () => {
    const start = await reserveAdjacentPair();
    const logs: string[] = [];
    const bound = await listenWithProbe({
      server: mk(),
      port: start,
      host: '127.0.0.1',
      portAvailable: p => p !== start,
      log: m => logs.push(m),
    });
    expect(bound).toBe(start + 1);
    expect(logs.join('\n')).toContain(`${start} unavailable`);
  });

  it('probes to the next port without crashing when the requested port is busy', async () => {
    const busy = await rawListen(mk(), await reserveAdjacentPair());
    const logs: string[] = [];
    const bound = await listenWithProbe({ server: mk(), port: busy, host: '127.0.0.1', log: m => logs.push(m) });
    expect(bound).toBe(busy + 1);
    expect(logs.join('\n')).toContain(`${busy} in use`);
  });

  it('rejects (does not loop forever) once maxProbe is exhausted', async () => {
    const busy = await rawListen(mk(), await reserveAdjacentPair());
    await rawListen(mk(), busy + 1);            // occupy the single probe target too
    let err: NodeJS.ErrnoException | null = null;
    await listenWithProbe({ server: mk(), port: busy, host: '127.0.0.1', maxProbe: 1 })
      .catch(e => { err = e; });
    expect(err).not.toBeNull();
    expect(err!.code).toBe('EADDRINUSE');
  });

  it('releases a successfully-bound port that fails post-bind verification and steps up', async () => {
    // A wildcard bind can succeed at the OS level yet be shadowed on loopback
    // (someone else holds 127.0.0.1:port and wins loopback routing). verifyBound
    // runs AFTER listen; returning false must close that binding and re-probe.
    const start = await reserveAdjacentPair();

    const verified: number[] = [];
    const logs: string[] = [];
    const bound = await listenWithProbe({
      server: mk(),
      port: start,
      host: '0.0.0.0',
      // Reject the first port we land on, accept the next.
      verifyBound: (p) => { verified.push(p); return verified.length > 1; },
      log: m => logs.push(m),
    });
    expect(verified[0]).toBe(start);   // it really bound `start` before rejecting
    expect(bound).toBeGreaterThan(start); // then released it and stepped up to the next usable port
    expect(verified.at(-1)).toBe(bound);
    expect(logs.join('\n')).toContain(`${start}`);
  });

  it('skips a loopback-shadowed wildcard port and binds where loopback reaches us', async () => {
    // Realistic end-to-end: a "shadow" owns 127.0.0.1:sport and does NOT speak
    // our self-check. Our server binds wildcard + verifies via a loopback nonce
    // call. It must NOT settle on the shadowed port, and the port it DOES settle
    // on must be one where a loopback request reaches us.
    const NONCE = 'real-server-nonce-ok';
    const shadow = createServer((_q, r) => { r.writeHead(404); r.end('not-us'); });
    open.push(shadow);
    const sport = await rawListen(shadow, 0);   // shadow holds 127.0.0.1:sport

    const real = createServer((q, r) => {
      if (q.url === '/__selfcheck') { r.writeHead(200); r.end(NONCE); return; }
      r.writeHead(200); r.end('ok');
    });
    open.push(real);
    const selfCheck = (p: number) => new Promise<boolean>((resolve) => {
      const req = get({ host: '127.0.0.1', port: p, path: '/__selfcheck', agent: false }, (res) => {
        let b = ''; res.setEncoding('utf8'); res.on('data', c => { b += c; });
        res.on('end', () => resolve(res.statusCode === 200 && b === NONCE));
      });
      req.setTimeout(1500, () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });

    const bound = await listenWithProbe({ server: real, port: sport, host: '0.0.0.0', verifyBound: selfCheck });
    expect(bound).not.toBe(sport);                 // did not settle on the shadowed port
    expect(await selfCheck(bound)).toBe(true);     // loopback to the bound port reaches US
  });

  it('steps up even when a client is still parked on the rejected port', async () => {
    // Regression, 2026-09: the dashboard silently stopped binding 7891 — no
    // LISTEN, no step to 7892, not one log line. Cause: a stale process from an
    // older checkout kept dialing 127.0.0.1:7891; our listen() accepted it and
    // it then sat there without reading. server.close() only stops ACCEPTING —
    // it waits for every already-accepted socket to drain — and the probe's
    // tryNext() (the only thing that logs or steps) runs inside that callback.
    // One parked socket therefore wedged the entire probe, invisibly.
    //
    // MEASURED on this shape: close() alone never fires its callback on either
    // runtime (node 22 and bun both still pending at 10s); with
    // closeAllConnections() it fires in 0-1ms. Hence the 4s budget below —
    // generous for the fix, unreachable for the bug.
    const start = await reserveAdjacentPair();
    const parked: Socket[] = [];

    const verified: number[] = [];
    const bound = await listenWithProbe({
      server: mk(),
      port: start,
      host: '127.0.0.1',
      maxProbe: 3,
      verifyBound: async (p) => {
        verified.push(p);
        if (verified.length > 1) return true;
        // Land a real connection on the port we are about to reject, and leave
        // it open with an unanswered request — exactly what the stale process did.
        await new Promise<void>((resolve) => {
          const sock = connect(p, '127.0.0.1', () => {
            sock.write('GET /__selfcheck HTTP/1.1\r\nHost: x\r\n\r\n');
            parked.push(sock);
            resolve();
          });
          sock.on('error', () => resolve());
        });
        return false;
      },
    });

    try {
      expect(verified[0]).toBe(start);        // it really bound and rejected `start`
      expect(bound).toBeGreaterThan(start);   // …and still got past it
    } finally {
      for (const sock of parked) sock.destroy();
    }
  }, 4000);

  it('steps up past a parked client even when the http layer does not track it', async () => {
    // Second 2026-09 wedge: closeAllConnections() was already in place and the
    // dashboard STILL parked — one CLOSE-WAIT loopback socket the http layer never
    // closed, no LISTEN, 29 minutes of silence. Whatever the runtime's bookkeeping
    // misses, the probe must be able to tear down on its own: it keeps handles to
    // every socket accepted while probing and destroys them itself on release.
    // Simulate "the http layer can't see it" by making closeAllConnections a no-op.
    const start = await reserveAdjacentPair();
    const server = mk();
    (server as unknown as { closeAllConnections: () => void }).closeAllConnections = () => { /* runtime blind spot */ };
    const parked: Socket[] = [];

    const verified: number[] = [];
    const bound = await listenWithProbe({
      server,
      port: start,
      host: '127.0.0.1',
      maxProbe: 3,
      releaseTimeoutMs: 500,
      verifyBound: async (p) => {
        verified.push(p);
        if (verified.length > 1) return true;
        await new Promise<void>((resolve) => {
          const sock = connect(p, '127.0.0.1', () => {
            sock.write('GET /__selfcheck HTTP/1.1\r\nHost: x\r\n\r\n');
            parked.push(sock);
            resolve();
          });
          sock.on('error', () => resolve());
        });
        return false;
      },
    });

    try {
      expect(verified[0]).toBe(start);
      expect(bound).toBeGreaterThan(start);
    } finally {
      for (const sock of parked) sock.destroy();
    }
  }, 4000);

  it('retries an unconfirmed verification and keeps the port instead of releasing it', async () => {
    // "Nobody answered my self-check in time" is what a starved event loop looks
    // like from inside the process, not evidence of a shadow. Releasing a port we
    // own on that signal is the path that wedged the dashboard; the probe must
    // retry and, if still unconfirmed, keep the bind — loudly.
    const start = await reserveAdjacentPair();
    const logs: string[] = [];
    const verified: number[] = [];
    const bound = await listenWithProbe({
      server: mk(),
      port: start,
      host: '127.0.0.1',
      verifyRetries: 2,
      verifyRetryDelayMs: 10,
      verifyBound: (p) => { verified.push(p); return 'unconfirmed'; },
      log: m => logs.push(m),
    });
    expect(bound).toBe(start);                      // never stepped
    expect(verified).toEqual([start, start, start]); // 1 + 2 retries, all on the same port
    expect(logs.some(l => /unconfirmed.*retrying/.test(l))).toBe(true);
    expect(logs.some(l => /still unconfirmed.*keeping the bind/.test(l))).toBe(true);
  });

  it('accepts the port as soon as a retry confirms it', async () => {
    const start = await reserveAdjacentPair();
    let calls = 0;
    const bound = await listenWithProbe({
      server: mk(),
      port: start,
      host: '127.0.0.1',
      verifyRetryDelayMs: 10,
      verifyBound: () => (++calls < 2 ? 'unconfirmed' : true),
    });
    expect(bound).toBe(start);
    expect(calls).toBe(2);
  });

  it('treats a throwing verifier as unconfirmed, not as a shadow', async () => {
    // The old code released the port on a verifier exception ("verify-failed").
    // An exception means the check could not run; it says nothing about who owns
    // the port, so it must follow the unconfirmed path (retry, then keep).
    const start = await reserveAdjacentPair();
    const bound = await listenWithProbe({
      server: mk(),
      port: start,
      host: '127.0.0.1',
      verifyRetries: 1,
      verifyRetryDelayMs: 10,
      verifyBound: () => { throw new Error('probe exploded'); },
    });
    expect(bound).toBe(start);
  });

  it('gives up with ERR_LISTEN_RELEASE_WEDGED instead of hanging when close() never completes', async () => {
    // The failure the whole release path exists to make visible: server.close()
    // parks forever. Force it by stubbing close() to never call back. The probe
    // must reject with a distinct code within its bounded budget so the caller
    // (dashboard.ts) can log and exit for a supervisor restart.
    const start = await reserveAdjacentPair();
    const server = mk();
    const realClose = server.close.bind(server);
    (server as unknown as { close: (cb?: () => void) => Server }).close = () => server; // swallow the callback
    (server as unknown as { closeAllConnections: () => void }).closeAllConnections = () => { /* no-op */ };
    const logs: string[] = [];
    let err: NodeJS.ErrnoException | null = null;
    const startedAt = Date.now();
    await listenWithProbe({
      server,
      port: start,
      host: '127.0.0.1',
      releaseTimeoutMs: 100,
      verifyBound: () => false,           // definitive shadow → release
      log: m => logs.push(m),
    }).catch(e => { err = e; });
    const elapsed = Date.now() - startedAt;
    expect(err).not.toBeNull();
    expect(err!.code).toBe(LISTEN_RELEASE_WEDGED_CODE);
    expect(elapsed).toBeLessThan(2000);   // bounded: 2 × releaseTimeoutMs, not forever
    expect(logs.some(l => /release still pending/.test(l))).toBe(true);
    expect(logs.some(l => /release wedged/.test(l))).toBe(true);
    // Let afterEach actually close the listener we stubbed.
    (server as unknown as { close: typeof realClose }).close = realClose;
  });
});
