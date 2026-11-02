/**
 * Last-chance cleanup for test resources that outlive a test by design — a
 * persistent tmux pane with a scratch overlay under it, a fixture mount — when
 * the test process ends before its own `finally` runs: the run is interrupted
 * (SIGINT / SIGTERM, which is how vitest tears a pool worker down on abort) or
 * the process exits with work still registered.
 *
 * Callbacks run SYNCHRONOUSLY, once, newest first, each isolated from the
 * others' failures. A signal is re-raised with the default action afterwards,
 * so the process still terminates exactly as it would have.
 *
 * Boundaries — what this does NOT catch:
 *  - SIGKILL cannot be intercepted;
 *  - the callbacks are JS: they run only once the event loop is free. A worker
 *    blocked in a synchronous child (spawnSync with a long timeout) handles the
 *    signal only after that child returns — and vitest's pool stop() sends
 *    SIGKILL 500 ms after SIGTERM, so in that window nothing runs at all;
 *  - under `bun test` a test file's process never emits 'exit' (Bun 1.4.x):
 *    there only the signal path applies.
 * A run ended in any of those ways leaves what it left before. Run mount-heavy
 * work through test/helpers/private-mount-ns.ts (namespaced, dies with the
 * process) where the test can afford it.
 */
const pending = new Set<() => void>();
let installed = false;

function runAll(): void {
  for (const fn of [...pending].reverse()) {
    pending.delete(fn);
    try { fn(); } catch { /* best effort: never block the others */ }
  }
}

function install(): void {
  if (installed) return;
  installed = true;
  process.once('exit', runAll);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const onSignal = (): void => {
      runAll();
      process.removeListener(signal, onSignal);
      // Someone else handles this signal too (and got this delivery): leave
      // the outcome to them. Otherwise restore the default: terminate.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}

/** Register `fn`; call the returned function once the test cleaned up itself. */
export function onTestProcessExit(fn: () => void): () => void {
  install();
  pending.add(fn);
  return () => { pending.delete(fn); };
}
