import * as nativePty from 'node-pty';
import { read, readSync } from 'node:fs';
import type { Readable } from 'node:stream';

export type { IPty } from 'node-pty';

/** Bun idle-retry delays (ms) used after nudgeRead, before falling back to 20ms. */
const FAST_RETRY_DELAYS = [1, 1, 2, 2, 4, 4, 8, 8, 16];
const readNudgers = new WeakMap<nativePty.IPty, () => void>();

/** Call right after writing input that the child will echo. Under Bun the
 * reader below polls an idle PTY every 20ms, which adds ~10ms on average to
 * every keystroke echo; this switches it to a short fast-poll window (1ms
 * backing off to 16ms over ~45ms). Node's libuv reader wakes on epoll and has
 * no such delay, so this is a no-op there, and callers that never nudge keep
 * the exact previous behaviour. */
export function nudgeRead(terminal: nativePty.IPty): void {
  readNudgers.get(terminal)?.();
}

/** Upper bound on one exit drain. A PTY whose child side has closed holds far
 * less (n_tty's 4KB plus its flip buffer); the cap only stops a drain that
 * another holder of the terminal keeps feeding. */
const EXIT_DRAIN_LIMIT = 1024 * 1024;

/** Read what the kernel still holds for the master. Never blocks: the master
 * is nonblocking, and once the child side has closed an empty PTY fails with
 * EIO instead of waiting. */
function drainMaster(fd: number, push: (chunk: Buffer) => unknown): void {
  const buffer = Buffer.alloc(64 * 1024);
  for (let total = 0; total < EXIT_DRAIN_LIMIT;) {
    let bytesRead: number;
    try { bytesRead = readSync(fd, buffer, 0, buffer.length, null); } catch { return; }
    if (!bytesRead) return;
    push(Buffer.from(buffer.subarray(0, bytesRead)));
    total += bytesRead;
  }
}

/** Preserve node-pty's process, writing, resizing and exit handling. Bun's
 * tty.ReadStream uses a file reader which destroys a nonblocking PTY on
 * EAGAIN, closing its master and sending SIGHUP to the child. Retry reads on
 * this stream instance only; do not patch tty/fs globals or shared dependencies.
 * node-pty 1.1 exposes its Unix reader as _socket and its master as fd. */
export const spawn: typeof nativePty.spawn = (file, args, options) => {
  const terminal = nativePty.spawn(file, args, options);
  if (process.platform === 'win32') return terminal;
  const unix = terminal as nativePty.IPty & { _socket?: Readable; fd?: number };
  const socket = unix._socket;
  const fd = unix.fd;
  // Mocked PTYs have no Unix reader/master.
  if (!socket || typeof fd !== 'number') return terminal;

  // Keep the child's last output when the reader ends at exit. The master is
  // still open at both points below, so read it dry before letting them through:
  // - libuv (Node) ends a tty stream once epoll reports POLLHUP and one read
  //   comes back short, without reading again; n_tty hands out at most 4KB
  //   per read, so more of the child's output can still be queued.
  // - node-pty destroys the reader 200ms after the child exits if it has not
  //   closed by then, which a stalled event loop reaches with output queued.
  let ended = false;
  let reading = false;
  let destroyAfterRead: (() => void) | undefined;
  const push = socket.push.bind(socket);
  const destroy = socket.destroy;
  socket.push = (chunk, encoding) => {
    if (chunk === null && !ended) { drainMaster(fd, push); ended = true; }
    return push(chunk, encoding);
  };
  socket.destroy = (...rest) => {
    if (!rest[0] && !ended && !socket.destroyed) {
      // A read in flight may already hold part of the tail: land it first.
      if (reading) { destroyAfterRead = () => socket.destroy(...rest); return socket; }
      drainMaster(fd, push);
    }
    return destroy.apply(socket, rest);
  };
  if (!process.versions.bun) return terminal;

  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryAttempt: (() => void) | undefined;
  let fastRetries = 0;
  socket.once('close', () => { if (retry) clearTimeout(retry); });
  readNudgers.set(terminal, () => {
    fastRetries = FAST_RETRY_DELAYS.length;
    // Waiting out an idle retry: read now. A read already in flight picks up
    // the fast delays when it comes back with EAGAIN.
    if (retry && retryAttempt) {
      clearTimeout(retry);
      retry = setTimeout(retryAttempt, 0);
    }
  });
  socket._read = (size: number) => {
    const buffer = Buffer.alloc(Math.min(size || 64 * 1024, 64 * 1024));
    const attempt = () => {
      retry = undefined;
      retryAttempt = undefined;
      if (socket.destroyed) return;
      reading = true;
      read(fd, buffer, 0, buffer.length, null, (error, bytesRead) => {
        reading = false;
        if (socket.destroyed) return;
        if (error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK' || error?.code === 'EINTR') {
          // Yield instead of spinning while the terminal is idle. Backpressure
          // remains Readable's responsibility: it requests the next _read.
          const delay = fastRetries > 0 ? FAST_RETRY_DELAYS[FAST_RETRY_DELAYS.length - fastRetries--] : 20;
          retryAttempt = attempt;
          retry = setTimeout(attempt, delay);
        } else if (error) {
          // node-pty already handles EIO on normal PTY termination. Keep its
          // original close/exit ordering and surface other errors as before.
          socket.destroy(error);
        } else {
          socket.push(bytesRead ? buffer.subarray(0, bytesRead) : null);
        }
        const pending = destroyAfterRead;
        destroyAfterRead = undefined;
        pending?.();
      });
    };
    attempt();
  };
  return terminal;
};
