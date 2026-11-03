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
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  if (!pid || pid <= 0) throw new Error('cannot prove CLI exit without a valid pid');
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const pollMs = opts.pollMs ?? 25;
  const deadline = scheduler.now() + timeoutMs;
  while (!scheduler.provablyGone(pid)) {
    if (scheduler.now() >= deadline) throw new Error(`CLI process ${pid} did not exit before purge`);
    await scheduler.wait(pollMs);
  }
}
