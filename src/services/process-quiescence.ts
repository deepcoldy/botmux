export interface QuiescenceScheduler {
  now(): number;
  wait(ms: number): Promise<void>;
  provablyGone(pid: number): boolean;
}

/** Wait until the exact process is provably gone before mutating files it may
 * still hold open. A timeout fails closed; callers must not continue purge. */
export async function waitForProcessQuiescence(
  pid: number | undefined,
  scheduler: QuiescenceScheduler,
  opts: { timeoutMs?: number; pollMs?: number; ownedPids?: readonly number[] } = {},
): Promise<void> {
  if (!pid || pid <= 0) throw new Error('cannot prove CLI exit without a valid pid');
  const owned = [...new Set([pid, ...(opts.ownedPids ?? [])].filter(candidate => candidate > 0))];
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const pollMs = opts.pollMs ?? 25;
  const deadline = scheduler.now() + timeoutMs;
  while (owned.some(candidate => !scheduler.provablyGone(candidate))) {
    if (scheduler.now() >= deadline) {
      const live = owned.filter(candidate => !scheduler.provablyGone(candidate));
      throw new Error(`CLI process scope did not exit before purge: ${live.join(',')}`);
    }
    await scheduler.wait(pollMs);
  }
}
