import { describe, expect, it, vi } from 'vitest';
import { connect, createServer, Server, type Socket } from 'node:net';
import { startTerminalProxy, type TerminalProxyHandle } from '../src/core/terminal-proxy.js';

describe('terminal proxy response drain', () => {
  it('delivers the complete chunked response before closing a slow client', async () => {
    const body = '<html>' + 'x'.repeat(90_000) + '<script>ready()</script></html>';
    const response = Buffer.from(
      'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n'
      + 'Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n'
      + Buffer.byteLength(body).toString(16) + '\r\n' + body + '\r\n0\r\n\r\n',
    );
    const sockets = new Set<Socket>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let proxy: TerminalProxyHandle | undefined;
    const worker = createServer(socket => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('data', () => socket.end(response));
    });

    // Delay only the proxy's downstream writes. The real upstream can finish
    // while the browser still has response bytes queued, as on a slow link.
    const emit = Server.prototype.emit;
    const emitSpy = vi.spyOn(Server.prototype, 'emit').mockImplementation(function (
      this: Server, event: string | symbol, ...args: unknown[]
    ) {
      if (event === 'connection') {
        const socket = args[0] as Socket;
        if (socket.localPort === proxy?.port) {
          sockets.add(socket);
          const write = socket._write;
          const writev = socket._writev!;
          const later = (run: () => void) => {
            const timer = setTimeout(() => { timers.delete(timer); run(); }, 30);
            timers.add(timer);
          };
          socket._write = (chunk, encoding, callback) => later(() => write.call(socket, chunk, encoding, callback));
          socket._writev = (chunks, callback) => later(() => writev.call(socket, chunks, callback));
        }
      }
      return emit.call(this, event, ...args);
    });

    try {
      await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
      const workerPort = (worker.address() as { port: number }).port;
      proxy = await startTerminalProxy({ port: 0, host: '127.0.0.1', resolvePort: () => workerPort });
      const received = await new Promise<Buffer>((resolve, reject) => {
        const client = connect(proxy!.port, '127.0.0.1', () => {
          client.write('GET /s/session/?viewToken=view HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
        });
        sockets.add(client);
        const chunks: Buffer[] = [];
        const timeout = setTimeout(() => {
          client.destroy();
          reject(new Error('proxy did not finish and close the response'));
        }, 3_000);
        client.on('data', chunk => chunks.push(chunk));
        client.on('error', reject);
        client.on('close', () => {
          clearTimeout(timeout);
          resolve(Buffer.concat(chunks));
        });
      });
      // Includes both the final inline script and the chunked end marker.
      expect(received.equals(response)).toBe(true);
    } finally {
      emitSpy.mockRestore();
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await proxy?.close();
      await new Promise<void>(resolve => worker.close(() => resolve()));
    }
  });
});
