/**
 * Suites build their browser session in beforeAll and release it in afterAll,
 * but afterAll only sees a session that beforeAll managed to return. A setup
 * step that throws half-way — Messenger never loading, openChat landing on a
 * restored topic — used to leave its Chromium running and its page holding
 * the chat lease it had just taken. CI (run 40170880120): the leaked page held
 * `dm:Claude` shared for good, every exclusive DM-mode case waited out its 25
 * minute lease timeout (six of them), and the live browser kept the runner
 * alive after the last case until the 320 minute step timeout.
 */

/**
 * Run `build` on `session`, which it fills in step by step; when a step
 * throws, `release` whatever was built, then rethrow the original error.
 */
export async function buildSession<S extends object>(
  session: Partial<S>,
  build: (session: Partial<S>) => Promise<void>,
  release: (session: Partial<S>) => Promise<void>,
): Promise<S> {
  try {
    await build(session);
    return session as S;
  } catch (error) {
    try {
      await release(session);
    } catch (releaseError) {
      console.error('[e2e] Releasing a half-built session failed:', releaseError);
    }
    throw error;
  }
}

/** Run every teardown step, even when an earlier one throws. */
export async function releaseAll(steps: ReadonlyArray<() => unknown>): Promise<void> {
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      console.error('[e2e] A session teardown step failed:', error);
    }
  }
}
