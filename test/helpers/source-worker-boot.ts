/**
 * Start the real source worker and learn when it has finished LOADING.
 *
 * A source worker runs as `node --import tsx src/worker.ts`, and its start-up is
 * dominated by tsx compiling the worker's module graph. tsx caches compiled
 * modules under os.tmpdir(), and the Bun leg gives every test file a fresh
 * TMPDIR (scripts/run-bun-tests.mjs), so the first worker of each file compiles
 * cold. On a loaded 4-vCPU CI runner that took 7–12s before the worker logged
 * its first line; with two pinned cores and four CPU hogs it is ~10s cold
 * against ~5s warm. A functional deadline that starts at spawn silently spends
 * most of itself on compilation and then fails as if the worker misbehaved.
 *
 * The bootstrap (./source-worker-bootstrap.ts) installs the production IPC
 * preload, imports the full worker and only then sends `worker_ipc_ready`.
 * Callers await `loaded` — bounded on its own — before sending `init`, so their
 * own deadlines measure worker behaviour, not module loading. This is the same
 * boundary the source fixtures of worker-codex-startup-readiness and
 * worker-traex-startup-readiness use.
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnNodeTsScript } from './ts-runner.js';

/** Upper bound for module loading alone; never part of a test's functional budget. */
export const SOURCE_WORKER_LOAD_TIMEOUT_MS = 30_000;

const BOOTSTRAP = fileURLToPath(new URL('./source-worker-bootstrap.ts', import.meta.url));

export interface LoadingSourceWorker {
  child: ChildProcess;
  /** Resolves once the full worker module has loaded and its IPC handler is
   *  installed; rejects if the worker exits first or loading exceeds the bound. */
  loaded: Promise<void>;
}

export function spawnLoadedSourceWorker(
  options: SpawnOptions,
  timeoutMs: number = SOURCE_WORKER_LOAD_TIMEOUT_MS,
): LoadingSourceWorker {
  const child = spawnNodeTsScript(BOOTSTRAP, [], options);
  const loaded = new Promise<void>((resolveLoaded, rejectLoaded) => {
    const onMessage = (message: unknown): void => {
      if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'worker_ipc_ready') finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`source worker exited while loading (code=${code}, signal=${signal})`));
    };
    const timer = setTimeout(
      () => finish(new Error(`source worker did not finish loading within ${timeoutMs}ms`)),
      timeoutMs,
    );
    function finish(error?: Error): void {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) rejectLoaded(error);
      else resolveLoaded();
    }
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
  // Callers await this; never let a rejection surface as unhandled meanwhile.
  loaded.catch(() => {});
  return { child, loaded };
}
