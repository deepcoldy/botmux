/**
 * Bounded settlement for a set of tmux listener pids on one socket path.
 *
 * The anti-fork integration test boots a deliberately forked competing server,
 * so immediately after `new-session` the kernel census can briefly over-count:
 * a forked child still holds the listening socket fd while it is being torn
 * down. A single `expect(...).toEqual([A, B])` snapshot therefore flakes under
 * a loaded runner. This helper instead requires the pid set to equal the
 * expected set CONTINUOUSLY for a stability window:
 *
 *  - a short-lived extra listener that disappears converges and the test passes;
 *  - an extra listener that persists, or keeps reappearing, never builds a
 *    stability window and the test still fails, so anti-fork coverage is not
 *    weakened.
 *
 * Synchronous on purpose: the real-tmux integration test is not async and parks
 * with Atomics.wait. `readPids`, `sleep` and `now` are injectable so unit tests
 * can drive deterministic listener sequences without touching /proc.
 */
export interface ListenerSettleOptions {
  /** Total wall time allowed for convergence before giving up. */
  deadlineMs?: number;
  /** The pid set must equal the expected set for this long to count settled. */
  stableMs?: number;
  /** Poll interval between census reads. */
  pollMs?: number;
  /** Census reader; the integration test binds it to one socket path. */
  readPids: () => number[] | null;
  /** Blocking sleep between polls (defaults to an Atomics.wait park). */
  sleep?: (ms: number) => void;
  /** Clock source (defaults to Date.now). */
  now?: () => number;
}

export interface ListenerSettleResult {
  /** True only when the set matched expected continuously for stableMs. */
  settled: boolean;
  /** Final observed pid set, sorted ascending — for a precise failure diff. */
  pids: number[];
}

const defaultSleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export function waitForListenerSetToSettle(
  expected: readonly number[],
  options: ListenerSettleOptions,
): ListenerSettleResult {
  const {
    deadlineMs = 2_000,
    stableMs = 200,
    pollMs = 20,
    readPids,
    sleep = defaultSleep,
    now = () => Date.now(),
  } = options;
  const expectedKey = [...expected].sort((a, b) => a - b).join(',');
  const start = now();
  let lastPids: number[] = [];
  let stableSince: number | null = null;
  while (now() - start < deadlineMs) {
    const pids = [...(readPids() ?? [])].sort((a, b) => a - b);
    lastPids = pids;
    if (pids.join(',') === expectedKey) {
      if (stableSince === null) stableSince = now();
      else if (now() - stableSince >= stableMs) return { settled: true, pids };
    } else {
      // Any extra/missing pid, even one that later vanishes, restarts the
      // stability window so a flapping listener can never fake convergence.
      stableSince = null;
    }
    sleep(pollMs);
  }
  return { settled: false, pids: lastPids };
}
