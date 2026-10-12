import * as nativePty from 'node-pty';
import { read } from 'node:fs';
import type { Readable } from 'node:stream';

export type { IPty } from 'node-pty';

/** Preserve node-pty's process, writing, resizing and exit handling. Bun's
 * tty.ReadStream uses a file reader which destroys a nonblocking PTY on
 * EAGAIN, closing its master and sending SIGHUP to the child. Retry reads on
 * this stream instance only; do not patch tty/fs globals or shared dependencies.
 * node-pty 1.1 exposes its Unix reader as _socket and its master as fd. */
export const spawn: typeof nativePty.spawn = (file, args, options) => {
  const terminal = nativePty.spawn(file, args, options);
  if (!process.versions.bun || process.platform === 'win32') return terminal;
  const unix = terminal as nativePty.IPty & { _socket?: Readable; fd?: number };
  const socket = unix._socket;
  const fd = unix.fd;
  // Windows handles and mocked PTYs have no Unix reader/master.
  if (!socket || typeof fd !== 'number') return terminal;

  let retry: ReturnType<typeof setTimeout> | undefined;
  socket.once('close', () => { if (retry) clearTimeout(retry); });
  socket._read = (size: number) => {
    const buffer = Buffer.alloc(Math.min(size || 64 * 1024, 64 * 1024));
    const attempt = () => {
      retry = undefined;
      if (socket.destroyed) return;
      read(fd, buffer, 0, buffer.length, null, (error, bytesRead) => {
        if (socket.destroyed) return;
        if (error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK' || error?.code === 'EINTR') {
          // Yield instead of spinning while the terminal is idle. Backpressure
          // remains Readable's responsibility: it requests the next _read.
          retry = setTimeout(attempt, 20);
        } else if (error) {
          // node-pty already handles EIO on normal PTY termination. Keep its
          // original close/exit ordering and surface other errors as before.
          socket.destroy(error);
        } else {
          socket.push(bytesRead ? buffer.subarray(0, bytesRead) : null);
        }
      });
    };
    attempt();
  };
  return terminal;
};
