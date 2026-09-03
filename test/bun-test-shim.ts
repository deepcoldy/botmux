import { describe as bunDescribe, expect, it as bunIt, jest, mock, setSystemTime } from 'bun:test';
import { vi } from 'vitest';

/**
 * Fills in the `vi.*` helpers `bun test` does not implement, for the subset
 * whose vitest semantics can be reproduced exactly.
 *
 * ⚠️ READ BEFORE ADDING ANYTHING HERE. A shim that makes a call *return* without
 * reproducing its *effect* converts a loud failure into a silent false green,
 * which is strictly worse than the red it replaced. This repo has already paid
 * for that once: `vi.stubEnv` threw under `bun test` (a red that correctly said
 * "this run is not isolated"), an ad-hoc shim set the env var and let the suite
 * go green — but Bun snapshots `os.homedir()` before any JS runs, so the tests
 * kept writing to the developer's REAL home and overwrote a live
 * `~/.botmux/config.json`. The env half of `stubEnv` is only safe here because
 * `test/bun-test-fence.ts` overrides `node:os` itself; the shim alone would not
 * make an unfenced run safe.
 *
 * KNOWN BUN DEFECTS that cannot be shimmed from here (documented so the resulting
 * red is legible rather than mysterious):
 *   `expect(promise).resolves.toSatisfy(fn)` — Bun calls the predicate with `{}`
 *     instead of the resolved value. Measured: the SYNC form
 *     `expect([1,2]).toSatisfy(fn)` receives the array correctly, so the defect is
 *     in the `resolves` chain, not in `toSatisfy`. One file relies on it
 *     (`test/remote-shutdown-detach.test.ts`, which fails with
 *     `results.every is not a function`). Overriding a matcher cannot fix how the
 *     runner threads the awaited value into it.
 *   An `it.each` row that is a BARE EMPTY ARRAY (`it.each([null, [], 'x'])`) spreads
 *     to ZERO arguments under `bun test`. A callback that declares a parameter then
 *     looks like it wants a `done` callback, so the runner waits for one and the case
 *     dies at the timeout — measured: 180s on a body that is fully synchronous and
 *     cannot hang, which makes it read as a hang rather than as bad data. vitest
 *     passes the empty array through as the single argument instead.
 *     NOT shimmed by CHOICE, not by impossibility: wrapping `.each` to rewrite a bare
 *     `[]` row into `[[]]` before the runner sees it does work (measured: the hang goes
 *     away and multi-element, tuple-wrapped and bare-value rows all still arrive
 *     unchanged). It is rejected because it would also rewrite a table whose rows are
 *     ALL bare `[]` — vitest calls those with ZERO arguments (measured), and a wrap that
 *     silently changed that would be exactly the kind of quiet mismatch this file
 *     refuses below. WRITE `[[]]` instead — unambiguous under both runners, and visible
 *     to the reader. Repo-wide recurrence is caught by the AST scan in
 *     `test/bun-runner-selectors.test.ts` (`test/bun-shim-parity.test.ts` pins the
 *     delivery semantics, but only for its own rows).
 *
 * DELIBERATELY NOT SHIMMED — these are module-system semantics, not missing
 * functions, and any fake would silently not-mock while reporting success:
 *   `vi.doMock` / `vi.doUnmock`  — re-point a module mid-file
 *   `vi.resetModules`            — clear the module registry
 *   `importOriginal` / `importActual` — the `vi.mock` factory's callback arg that
 *                                  yields the real module (runner-supplied, so
 *                                  no fill can provide it)
 *   `inject`                     — vitest's globalSetup→test value channel. A
 *                                  NAMED EXPORT of the `vitest` module that
 *                                  `bun:test` does not have, so the static import
 *                                  fails before any mock can apply (measured).
 *   `vi.hoisted`                 — vitest's transform physically LIFTS the
 *                                  callback above the static imports. A runtime
 *                                  fill can only run it when the module body gets
 *                                  there, i.e. after the imports, so a fixture
 *                                  reading a global at import time sees nothing
 *                                  (measured). Order, not a missing function.
 * Files using them stay red under `bun test` and keep running under vitest until
 * they are rewritten to use dependency injection. See `package.json:test:bun`.
 */

const anyVi = vi as unknown as Record<string, unknown>;

/** Install only when Bun lacks it, so a future Bun release wins automatically. */
function fill(name: string, impl: unknown): void {
  if (typeof anyVi[name] !== 'function') anyVi[name] = impl;
}

// ---------------------------------------------------------------------------
// Env stubbing. Semantics measured against vitest (not assumed):
//   stubEnv(k, 'v')      → sets
//   stubEnv(k, undefined) → DELETES the key (`k in process.env === false`)
//   unstubAllEnvs()      → restores pre-stub values; keys that did not exist
//                          before are removed again
// ---------------------------------------------------------------------------
const savedEnv = new Map<string, string | undefined>();

fill('stubEnv', (key: string, value: string | undefined) => {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return vi;
});

fill('unstubAllEnvs', () => {
  for (const [key, original] of savedEnv) {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  savedEnv.clear();
  return vi;
});

// ---------------------------------------------------------------------------
// Global stubbing — same restore-or-delete rule as the env pair, on globalThis.
// ---------------------------------------------------------------------------
const savedGlobals = new Map<string, { existed: boolean; value: unknown }>();

fill('stubGlobal', (key: string, value: unknown) => {
  if (!savedGlobals.has(key)) {
    savedGlobals.set(key, {
      existed: key in (globalThis as Record<string, unknown>),
      value: (globalThis as Record<string, unknown>)[key],
    });
  }
  (globalThis as Record<string, unknown>)[key] = value;
  return vi;
});

fill('unstubAllGlobals', () => {
  for (const [key, saved] of savedGlobals) {
    if (saved.existed) (globalThis as Record<string, unknown>)[key] = saved.value;
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals.clear();
  return vi;
});

// ---------------------------------------------------------------------------
// Pass-throughs to a real Bun/jest implementation under a different name.
// ---------------------------------------------------------------------------

// Type-only helper in vitest — the runtime value is the argument itself.
fill('mocked', <T>(item: T): T => item);

fill('setSystemTime', (time?: string | number | Date) => {
  setSystemTime(time === undefined ? undefined : new Date(time));
  return vi;
});

// Bun implements the sync variant; vitest's async form awaits pending
// microtasks between ticks so timer callbacks that resolve promises settle.
fill('advanceTimersByTimeAsync', async (ms: number) => {
  jest.advanceTimersByTime(ms);
  await Promise.resolve();
  return vi;
});

// Same sync-to-async relationship as advanceTimersByTimeAsync. Bun has the sync
// `runAllTimers`; the async variants additionally drain the microtask queue so a
// timer callback that awaits can finish before the assertion runs.
fill('runAllTimersAsync', async () => {
  jest.runAllTimers();
  await Promise.resolve();
  return vi;
});

// ---------------------------------------------------------------------------
// `clearAllTimers` when fake timers were never installed.
//
// ⚠️ This one is an OVERRIDE, not a `fill`: Bun DOES define
// `vi.clearAllTimers`, so `fill` would skip it — and Bun's implementation
// THROWS `Fake timers are not active. Call useFakeTimers() first.` when no fake
// timers are installed. vitest treats the same call as a no-op.
//
// MEASURED, the two runners on one 4-line file (`vi.clearAllTimers()` with no
// `useFakeTimers`, and again after `useRealTimers`):
//     vitest   → 2 passed
//     bun test → 2 failed
//
// This is not a theoretical gap: an unconditional `vi.clearAllTimers()` in an
// `afterEach` is the single largest cause of the bun-test leg being red — 50 of
// its failures in one CI run, e.g. test/recall-frozen-cards.test.ts:189, where
// the test body itself passed and only the teardown threw.
//
// We track installation ourselves because neither runner exposes "are fake
// timers active?". Erring toward CALLING through is deliberate: if our flag ever
// disagrees with reality, a spurious call throws loudly (visible) rather than a
// skipped clear leaking timers into the next test (silent cross-test pollution).
let fakeTimersInstalled = false;
const realUseFakeTimers = anyVi.useFakeTimers as ((...a: unknown[]) => unknown) | undefined;
const realUseRealTimers = anyVi.useRealTimers as ((...a: unknown[]) => unknown) | undefined;
if (typeof realUseFakeTimers === 'function') {
  anyVi.useFakeTimers = (...args: unknown[]) => {
    const r = realUseFakeTimers(...args);
    fakeTimersInstalled = true;
    return r === undefined ? vi : r;
  };
}
if (typeof realUseRealTimers === 'function') {
  anyVi.useRealTimers = (...args: unknown[]) => {
    const r = realUseRealTimers(...args);
    fakeTimersInstalled = false;
    return r === undefined ? vi : r;
  };
}
const realClearAllTimers = anyVi.clearAllTimers as ((...a: unknown[]) => unknown) | undefined;
anyVi.clearAllTimers = (...args: unknown[]) => {
  // No fake timers installed ⇒ there is nothing to clear, which is exactly what
  // vitest does. Swallowing here cannot hide a real failure: the only thing
  // Bun's version would have done is throw.
  if (!fakeTimersInstalled) return vi;
  const r = realClearAllTimers?.(...args);
  return r === undefined ? vi : r;
};

// Per-file config. `bun test` takes the timeout as a CLI flag, so there is no
// runtime knob to forward this to — and scripts/run-bun-tests.mjs already passes
// a `--timeout` at least as large as anything a file asks for, so accepting
// `testTimeout` as a no-op cannot turn a red into a green (a generous timeout only
// lets a slow test finish).
//
// A blanket no-op would NOT be safe though: any OTHER option silently would not
// apply, and the file would still go green. Accept exactly the key we have
// verified is harmless and throw on anything else, so a future `vi.setConfig({
// retry: 3 })` fails loudly here instead of quietly doing nothing.
fill('setConfig', (config?: Record<string, unknown>) => {
  for (const key of Object.keys(config ?? {})) {
    if (key !== 'testTimeout') {
      throw new Error(
        `[bun-test-shim] vi.setConfig({ ${key} }) is not supported under bun test. `
        + 'Only testTimeout is accepted (the runner passes a matching --timeout). '
        + 'Add explicit support in test/bun-test-shim.ts rather than letting it no-op.',
      );
    }
  }
  return vi;
});

// ---------------------------------------------------------------------------
// `it.runIf` / `describe.runIf` — Bun ships `skipIf` but not `runIf` (measured:
// `skipIf` and `each` are present, `runIf` is not). `runIf(cond)` is exactly
// `skipIf(!cond)`, so this is a mechanical inversion with no semantic guesswork —
// unlike the module-registry APIs above, there is nothing here to get subtly
// wrong. Without it, 16 `it.runIf` + 5 `describe.runIf` files fail at collection
// time with `it.runIf is not a function` (the whole mojo-* cluster).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// `expect(fn).toHaveBeenCalledExactlyOnceWith(...)` — vitest has it, Bun does not
// (measured). Its meaning is the conjunction of two matchers Bun DOES have, so this
// is a mechanical composition rather than a reimplementation: called exactly once,
// AND that one call had these arguments. Asserting both halves is what keeps it
// honest — a shim that only checked arguments would pass for a mock called three
// times whose first call matched.
// ---------------------------------------------------------------------------
const expectWithExtend = expect as unknown as {
  extend?: (matchers: Record<string, unknown>) => void;
};
if (typeof expectWithExtend.extend === 'function') {
  expectWithExtend.extend({
    toHaveBeenCalledExactlyOnceWith(received: unknown, ...expected: unknown[]) {
      const mock = (received as { mock?: { calls?: unknown[][] } })?.mock;
      if (!mock || !Array.isArray(mock.calls)) {
        return { pass: false, message: () => 'expected a mock function' };
      }
      const calls = mock.calls;
      if (calls.length !== 1) {
        return { pass: false, message: () => `expected exactly 1 call, received ${calls.length}` };
      }
      // Reuse the runner's own deep equality so the comparison semantics match
      // `toHaveBeenCalledWith` instead of inventing a second notion of equality.
      try {
        expect(calls[0]).toEqual(expected);
        return { pass: true, message: () => 'called exactly once with the expected arguments' };
      } catch {
        return {
          pass: false,
          message: () => `called once, but with ${JSON.stringify(calls[0])} instead of ${JSON.stringify(expected)}`,
        };
      }
    },
  });
}

/**
 * `it.sequential` / `describe.sequential` — vitest's opt-out of concurrent
 * execution. `bun test` already runs tests sequentially by default (measured: an
 * async test fully finishes before the next one starts, `ORDER=a-start,a-end,b`),
 * so requesting sequential execution is a no-op there and the modifier can be an
 * identity pass-through. Note this is only safe BECAUSE of that default: Bun does
 * expose a working `.concurrent`, and if a future release made concurrency the
 * default this identity would silently stop meaning what the caller asked for.
 */
function addSequential(target: unknown): void {
  const fn = target as Record<string, unknown>;
  if (typeof fn !== 'function' && typeof fn !== 'object') return;
  let missing = false;
  try { missing = typeof fn.sequential !== 'function'; } catch { missing = true; }
  if (!missing) return;
  Object.defineProperty(fn, 'sequential', {
    configurable: true,
    writable: true,
    value: fn,
  });
}

function addRunIf(target: unknown): void {
  const fn = target as { runIf?: unknown; skipIf?: (cond: boolean) => unknown };
  if (typeof fn?.skipIf !== 'function') return;
  let missing = false;
  try { missing = typeof fn.runIf !== 'function'; } catch { missing = true; }
  if (!missing) return;
  Object.defineProperty(fn, 'runIf', {
    configurable: true,
    writable: true,
    value: (condition: boolean) => fn.skipIf!(!condition),
  });
}

addRunIf(bunIt);
addRunIf(bunDescribe);
addSequential(bunIt);
addSequential(bunDescribe);

// Mirrors vitest's default 1000ms timeout / 50ms interval and its behaviour of
// surfacing the LAST failure, not a generic timeout message.
//
// ⚠️ FAKE TIMERS: vitest's waitFor ADVANCES fake timers by `interval` on each
// poll. A naive `await new Promise(r => setTimeout(r, interval))` deadlocks
// instead — once timers are faked nothing moves the clock, so the sleep never
// resolves and the test dies on its own timeout (measured: vitest passes the same
// probe while the naive shim hung to the 20s cap).
//
// There is no reliable way to ASK Bun whether timers are currently faked —
// measured: `jest.now()` returns a number either way, and `setTimeout` keeps its
// name and carries no `.mock` marker. So don't ask: TRY to advance, and treat the
// "Fake timers are not active" throw as the signal to fall back to a real sleep.
// The poll-count bound matters because a faked `Date.now()` need not advance, so
// a wall-clock deadline alone could never expire.
// ---------------------------------------------------------------------------

/**
 * Advance a faked clock. Returns false when timers are real (nothing to pump).
 *
 * Only "fake timers are not active" is treated as the real-timers signal; any
 * other error is rethrown rather than silently reinterpreted as "timers are real"
 * (which would send the caller down the wrong branch).
 *
 * ⚠️ KNOWN DIVERGENCE, not fixable from here: if a fired timer CALLBACK throws,
 * vitest surfaces that error out of `waitFor`, but Bun's
 * `jest.advanceTimersByTime` does not propagate it at all — measured directly:
 * with a `setTimeout(() => { throw … })` pending, the advance call returns
 * normally ("no-throw") and Bun reports the callback error through its own
 * uncaught-error channel instead. So `waitFor` here rejects with the CONDITION's
 * last error while vitest rejects with the timer's. A shim cannot invent an
 * exception the runtime never delivers; the fix belongs in Bun. Documented rather
 * than papered over, since the failure mode is a confusing diagnostic (wrong
 * error text), not a silent pass.
 */
function tryAdvanceFakeTimers(ms: number): boolean {
  try {
    jest.advanceTimersByTime(ms);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/fake timers are not active/i.test(message)) return false;
    throw err;
  }
}

fill('waitFor', async <T>(
  callback: () => T | Promise<T>,
  options?: number | { timeout?: number; interval?: number },
): Promise<T> => {
  const timeout = typeof options === 'number' ? options : options?.timeout ?? 1000;
  const interval = typeof options === 'number' ? 50 : options?.interval ?? 50;
  const step = Math.max(1, interval);
  const deadline = Date.now() + timeout;
  // Track how far the FAKE clock has been pumped. A faked `Date.now()` need not
  // advance, so this is the only honest elapsed measure on that path — and it has
  // to be a hard bound, not a generous one: with slack, a condition that only
  // becomes true AFTER the timeout still got accepted on a later poll, so a
  // caller expecting a rejection saw a resolve instead (measured against vitest).
  let fakeElapsed = 0;
  let lastError: unknown;

  for (;;) {
    try {
      return await callback();
    } catch (err) {
      lastError = err;
    }
    // Advancing returns false when timers are real (nothing to pump).
    const faked = tryAdvanceFakeTimers(step);
    if (faked) {
      fakeElapsed += step;
      // Stop as soon as the pumped time reaches the timeout. The probe above
      // already ran for this tick, so the condition still gets its observation at
      // exactly `timeout` — but never beyond it.
      if (fakeElapsed >= timeout) {
        try {
          return await callback();
        } catch (err) {
          throw err ?? lastError;
        }
      }
      // Let the just-fired timers' continuations settle before probing again.
      await Promise.resolve();
    } else {
      // Real timers: the caller's timeout is wall-clock, so clamp the sleep to
      // what is LEFT rather than always sleeping a full interval. Oversleeping
      // past the deadline and then probing again accepted conditions that only
      // became true after the timeout — measured: with interval 50 / timeout 30,
      // a condition arriving at 40ms resolved here while vitest rejected at ~33ms.
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw lastError ?? new Error(`vi.waitFor timed out after ${timeout}ms`);
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(step, remaining)));
      // The sleep above ends at or before the deadline; one final probe at the
      // boundary matches vitest's inclusive last observation, and anything later
      // must not be observed at all.
      if (Date.now() >= deadline) {
        try {
          return await callback();
        } catch (err) {
          throw err ?? lastError;
        }
      }
    }
  }
});

// NOTE: no automatic per-test unstub here, deliberately. vitest only clears
// stubs between tests when `unstubEnvs`/`unstubGlobals` are enabled in config,
// and this repo's vitest.config.ts sets neither — so stubs persist across tests
// within a file, and at least one file relies on that by stubbing in
// `beforeAll` (test/fs-policy-bwrap.e2e.test.ts). Adding an `afterEach` reset
// here would make the shim STRICTER than the runner it emulates and turn those
// files red.
//
// ⚠️ The tradeoff is real and differs from vitest: `bun test` runs every file in
// ONE process (measured — two files report the same `process.pid` and share one
// fence dir), whereas vitest forks a worker per file. So a file that stubs an env
// var and never restores it CAN leak into a later file in the same `bun test`
// invocation, where under vitest it could not. Files are still fenced as a group
// (test/bun-test-fence.ts redirects HOME for the whole process, so nothing
// reaches the real home either way); what leaks is only test-visible state
// between files. Matching vitest's per-file isolation would need a reset keyed to
// file boundaries, which bun:test does not currently expose. Prefer fixing a
// leaky file over adding a blanket reset that breaks the `beforeAll` pattern.

// `expect(...).toMatchObject` etc. already exist in Bun; assert the pieces this
// shim depends on are really present so a Bun upgrade that moves them fails
// here with a clear message instead of deep inside an unrelated test.
if (typeof mock.module !== 'function') {
  throw new Error('bun:test mock.module is unavailable — test/bun-test-fence.ts cannot fence node:os');
}
if (typeof expect !== 'function') {
  throw new Error('bun:test expect is unavailable');
}
