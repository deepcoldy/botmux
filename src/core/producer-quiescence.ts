import type { ChildProcess } from 'node:child_process';

/**
 * Producer-quiescence fences for graceful shutdown of the feedback turn-terminal
 * pipeline. Extracted from daemon shutdown so the concurrency-sensitive fence
 * logic is unit-testable against real forked child processes.
 *
 * Two independent fences must BOTH confirm quiescent (within a single shared
 * absolute deadline) before the turn-terminal queue admission may be closed:
 *   1. IPC-disconnect fence — every worker's IPC channel is closed, so no NEW
 *      terminal message can be delivered.
 *   2. Settlement fence — every in-flight async handler that will still enqueue
 *      a terminal (Codex App final settlement awaiting network delivery) has
 *      resolved.
 * The disconnect fence keys on the IPC `disconnect` event (fires as soon as the
 * channel closes) rather than `close` (which also waits for stdio — a grandchild
 * that inherited the pipe fds can delay `close` long past the real quiescence
 * point). Every wait is bounded by the shared absolute deadline and holds a
 * ref'd keepalive so a fire-and-forget shutdown handler cannot exit mid-wait.
 */

/** Minimal shape used by the fence — real ChildProcess plus test doubles. */
export interface ProducerHandle {
  connected?: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Await all promises, bounded by an absolute wall-clock deadline. Holds a ref'd
 * keepalive timer for the wait so the event loop is not judged idle (the queue's
 * own retry timers are unref'd and the SIGTERM handler is fire-and-forget).
 * Returns true iff every promise settled before the deadline.
 */
export async function waitAllWithin(
  promises: Array<Promise<unknown>>,
  deadlineMs: number,
  now: () => number = Date.now,
): Promise<boolean> {
  if (promises.length === 0) return true;
  const budget = Math.max(0, deadlineMs - now());
  if (budget === 0) return false;
  const keepalive = setInterval(() => { /* ref'd: hold the loop while awaiting */ }, 1000);
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), budget); });
    const outcome = await Promise.race([Promise.allSettled(promises).then(() => 'settled' as const), timeout]);
    if (timer) clearTimeout(timer);
    return outcome === 'settled';
  } finally {
    clearInterval(keepalive);
  }
}

/**
 * Build a promise that resolves when a worker can no longer deliver a queued
 * terminal message, and a snapshot of whether it is ALREADY quiet.
 *
 * A terminal reaches the daemon only over the worker's IPC channel. So the
 * worker is "quiet" (cannot deliver a new terminal) exactly when its IPC channel
 * is not open — `connected !== true`. This covers all three cases at once:
 *   - a live channelled worker (`connected === true`) is NOT quiet — a message
 *     may still be queued/in flight; we await its `disconnect`;
 *   - a channelled worker whose channel already closed (`connected === false`,
 *     e.g. it was just killed) IS quiet — no more messages can arrive; and
 *   - a worker that never had an IPC channel (`connected` undefined/false) has
 *     no terminal source at all, so it is quiet too.
 * The resolve signal for the not-yet-quiet case is `disconnect` (fires the
 * instant the channel closes — verified ~1ms after SIGTERM), NOT `close` (which
 * also waits for stdio a grandchild may hold open). `exit`/`close` are attached
 * as belt-and-suspenders for a channel-less child whose only signal is death.
 * Uses check → once → re-check so a worker that became quiet between the initial
 * read and attaching listeners does not hang.
 */
export function trackProducerQuiet(w: ProducerHandle): { alreadyQuiet: boolean; done?: Promise<void> } {
  const isQuiet = (): boolean => w.connected !== true;
  if (isQuiet()) return { alreadyQuiet: true };
  const done = new Promise<void>(resolve => {
    const settle = (): void => resolve();
    w.once('disconnect', settle);  // IPC channel closed → no more messages
    w.once('exit', settle);        // belt-and-suspenders (channel-less child)
    w.once('close', settle);       // belt-and-suspenders
    if (isQuiet()) settle();       // became quiet between the read and listener attach
  });
  return { alreadyQuiet: false, done };
}
