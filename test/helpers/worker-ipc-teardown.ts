import type { ChildProcess } from 'node:child_process';

/** Write errors of an IPC channel whose worker is going away. */
const IPC_WRITE_ERRORS = new Set(['EPIPE', 'ECONNRESET', 'ERR_IPC_CHANNEL_CLOSED']);
const retired = new WeakSet<ChildProcess>();

/**
 * Call when a test starts tearing a worker down, before it is killed.
 *
 * Node reports a failed `child.send()` asynchronously as an `'error'` event,
 * and an `'error'` event with no listener is an uncaught exception. The
 * daemon keeps a listener on every worker it forks; a test-spawned worker has
 * none. So a reply still in flight when the teardown SIGKILLs the worker — a
 * production handleWorkerMessage continuation answering a message the worker
 * sent just before it died — fails the whole run after every assertion passed.
 *
 * From this call on, exactly those late IPC write errors are dropped; any
 * other error is rethrown and stays an uncaught failure. The listener only
 * observes: kill, `exit` and reaping are untouched. Errors before teardown are
 * not covered on purpose — a worker that dies while the test still needs it
 * must keep failing loudly.
 */
export function retireWorkerIpc(child: ChildProcess): void {
  if (retired.has(child)) return;
  retired.add(child);
  child.on('error', error => {
    if (IPC_WRITE_ERRORS.has((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  });
}
