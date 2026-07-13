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
import { listenWithProbe } from '../src/utils/listen-with-probe.js';

const open: Server[] = [];
function mk(): Server { const s = createServer((_q, r) => r.end('ok')); open.push(s); return s; }
function rawListen(s: Server, port: number, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(port, host, () => { const a = s.address(); resolve(typeof a === 'object' && a ? a.port : 0); });
  });
}
afterEach(async () => { for (const s of open.splice(0)) await new Promise<void>(r => s.close(() => r())); });

describe('listenWithProbe', () => {
  it('binds the requested port when it is free', async () => {
    const port = await listenWithProbe({ server: mk(), port: 0, host: '127.0.0.1' });
    expect(port).toBeGreaterThan(0);
  });

  it('skips ports rejected by caller-specific availability checks', async () => {
    const tmp = mk();
    const start = await rawListen(tmp, 0);
    await new Promise<void>(r => tmp.close(() => r()));
    open.splice(open.indexOf(tmp), 1);
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
    const busy = await rawListen(mk(), 0);
    const logs: string[] = [];
    const bound = await listenWithProbe({ server: mk(), port: busy, host: '127.0.0.1', log: m => logs.push(m) });
    expect(bound).toBe(busy + 1);
    expect(logs.join('\n')).toContain(`${busy} in use`);
  });

  it('rejects (does not loop forever) once maxProbe is exhausted', async () => {
    const busy = await rawListen(mk(), 0);
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
    const tmp = mk();
    const start = await rawListen(tmp, 0);
    await new Promise<void>(r => tmp.close(() => r()));
    open.splice(open.indexOf(tmp), 1);

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
});
