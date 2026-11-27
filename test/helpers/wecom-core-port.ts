/**
 * The loopback port of a WeCom core a test is about to start.
 *
 * Binding port 0, closing and handing the number on leaves a gap: until the
 * gateway's checkPort (managed-core.ts) and then the core bind it, any other
 * process may take the port, and the gateway refuses it as occupied. Under
 * concurrent vitest runs that happened. As in #3431, this fixture holds what it
 * hands out instead of assuming a released port stays free:
 *
 * - Ports come from a band below every OS ephemeral range (Linux default
 *   32768–60999, macOS 49152–65535) and away from botmux's fixed ports, so no
 *   `listen(0)` or outgoing connection anywhere on the machine is ever given
 *   one, nor a fixture that derives ports from an ephemeral one.
 * - Until releaseWecomCorePorts() the port stays bound on [::1], IPv6 only. The
 *   core binds 127.0.0.1 and checkPort also tries 0.0.0.0; an IPv6-only socket
 *   conflicts with neither, but another instance of this fixture (another
 *   worker, another vitest run) cannot bind [::1] there and moves on.
 * - A port is handed out only after the same exclusive binds checkPort makes
 *   succeeded with the holder in place, so a fixed-port service is skipped.
 *
 * Without IPv6 loopback, or where the holder conflicts with those binds, it
 * falls back to the band and the check alone.
 */
import { createServer, type Server } from 'node:net';

const BAND_START = 20_000;
const BAND_SIZE = 10_000;
const held: Server[] = [];
let holderUsable: boolean | undefined;

type Bound = { server: Server } | { code: string };

function bind(host: string, port: number, ipv6Only = false): Promise<Bound> {
  return new Promise(resolve => {
    const server = createServer(socket => socket.destroy());
    server.once('error', (error: NodeJS.ErrnoException) => resolve({ code: error.code ?? 'ERROR' }));
    server.listen({ host, port, exclusive: true, ...(ipv6Only ? { ipv6Only } : {}) }, () => resolve({ server }));
  });
}

function close(server: Server): Promise<void> {
  return new Promise(done => server.close(() => done()));
}

/** The binds checkPort makes before the gateway starts its core. */
async function coreSideFree(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '0.0.0.0']) {
    const bound = await bind(host, port);
    if (!('server' in bound)) return false;
    await close(bound.server);
  }
  return true;
}

export async function reserveWecomCorePort(): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = BAND_START + Math.floor(Math.random() * BAND_SIZE);
    let holder: Server | undefined;
    if (holderUsable !== false) {
      const bound = await bind('::1', port, true);
      if ('server' in bound) {
        holder = bound.server;
      } else if (bound.code === 'EADDRINUSE') {
        continue;
      } else {
        holderUsable = false;
      }
    }
    if (await coreSideFree(port)) {
      if (holder) {
        holderUsable = true;
        held.push(holder);
      }
      return port;
    }
    if (holder) {
      await close(holder);
      if (holderUsable === undefined && await coreSideFree(port)) {
        holderUsable = false;
        return port;
      }
    }
  }
  throw new Error('no free loopback port for a WeCom core test');
}

/** Call from afterEach: frees every port reserved since the last call. */
export async function releaseWecomCorePorts(): Promise<void> {
  await Promise.all(held.splice(0).map(close));
}
