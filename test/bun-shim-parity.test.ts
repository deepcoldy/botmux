import { describe, expect, it, vi } from 'vitest';
import osDefault from 'node:os';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fenceHomeRootedEnv } from './helpers/fence-home-env.js';
import { homedir, userInfo } from 'node:os';

/**
 * Guards the `vi.*` / `it.*` helpers that `test/bun-test-shim.ts` fills in under
 * `bun test`.
 *
 * WHY THIS FILE EXISTS: the shim's whole risk is *semantic drift* — a fill that
 * returns without reproducing the real effect turns a loud failure into a silent
 * false green. This repo already paid for that once (an ad-hoc `vi.stubEnv` shim
 * made the suite green while it kept writing to the developer's real
 * `~/.botmux`). So each shimmed behaviour is asserted here rather than assumed.
 *
 * Deliberately runs under BOTH runners: under vitest these assertions describe
 * the reference semantics, and under `bun test` they check the shim reproduces
 * them. A change that makes the two diverge fails on one side.
 */

describe('vi shim parity (vitest reference / bun shim)', () => {
  it('stubEnv sets, stubEnv(undefined) deletes, unstubAllEnvs restores', () => {
    process.env.BOTMUX_SHIM_PARITY_PRESET = 'orig';
    delete process.env.BOTMUX_SHIM_PARITY_ABSENT;

    vi.stubEnv('BOTMUX_SHIM_PARITY_PRESET', 'changed');
    vi.stubEnv('BOTMUX_SHIM_PARITY_ABSENT', 'added');
    expect(process.env.BOTMUX_SHIM_PARITY_PRESET).toBe('changed');
    expect(process.env.BOTMUX_SHIM_PARITY_ABSENT).toBe('added');

    // Passing undefined REMOVES the key rather than setting the string
    // "undefined" — measured against vitest, and the reason the shim branches.
    vi.stubEnv('BOTMUX_SHIM_PARITY_PRESET', undefined as unknown as string);
    expect('BOTMUX_SHIM_PARITY_PRESET' in process.env).toBe(false);

    vi.unstubAllEnvs();
    expect(process.env.BOTMUX_SHIM_PARITY_PRESET).toBe('orig');
    // A key that did not exist before stubbing is removed again, not left set.
    expect('BOTMUX_SHIM_PARITY_ABSENT' in process.env).toBe(false);

    delete process.env.BOTMUX_SHIM_PARITY_PRESET;
  });

  it('stubGlobal replaces and unstubAllGlobals restores or deletes', () => {
    const g = globalThis as Record<string, unknown>;
    g.botmuxShimParityExisting = 'before';
    delete g.botmuxShimParityFresh;

    vi.stubGlobal('botmuxShimParityExisting', 'after');
    vi.stubGlobal('botmuxShimParityFresh', 'new');
    expect(g.botmuxShimParityExisting).toBe('after');
    expect(g.botmuxShimParityFresh).toBe('new');

    vi.unstubAllGlobals();
    expect(g.botmuxShimParityExisting).toBe('before');
    expect('botmuxShimParityFresh' in g).toBe(false);

    delete g.botmuxShimParityExisting;
  });

  it('waitFor resolves with the callback value once it stops throwing', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    try {
      const got = await vi.waitFor(
        () => { if (ticks < 3) throw new Error('not yet'); return ticks; },
        { timeout: 2_000, interval: 5 },
      );
      expect(got).toBeGreaterThanOrEqual(3);
    } finally {
      clearInterval(timer);
    }
  });

  it('waitFor surfaces the LAST failure on timeout, not a generic message', async () => {
    await expect(
      vi.waitFor(() => { throw new Error('distinctive-shim-parity-failure'); }, { timeout: 60, interval: 10 }),
    ).rejects.toThrow('distinctive-shim-parity-failure');
  });

  // Real timers have their own deadline boundary, and it broke independently of
  // the fake one: the sleep must be clamped to the REMAINING timeout, or the loop
  // oversleeps and then accepts a condition that only became true afterwards
  // (measured: interval 50 / timeout 30, condition at 40ms — vitest rejected at
  // ~33ms while an unclamped shim resolved).
  it('waitFor under real timers REJECTS a condition that arrives after the timeout', async () => {
    let ready = false;
    const timer = setTimeout(() => { ready = true; }, 40);
    try {
      await expect(
        vi.waitFor(
          () => { if (!ready) throw new Error('real-late-marker'); return 'too-late'; },
          { interval: 50, timeout: 30 },
        ),
      ).rejects.toThrow('real-late-marker');
    } finally {
      clearTimeout(timer);
    }
  });

  // Fake timers are a separate code path in the shim: vitest's waitFor pumps the
  // faked clock itself, so a naive real `setTimeout` sleep deadlocks there. These
  // four pin the boundary behaviour in both directions — the shim must neither
  // hang nor accept a condition that only becomes true after the deadline.
  it('waitFor under fake timers resolves when the condition arrives in time', async () => {
    vi.useFakeTimers();
    try {
      let ready = false;
      setTimeout(() => { ready = true; }, 50);
      const got = await vi.waitFor(
        () => { if (!ready) throw new Error('not yet'); return 'arrived'; },
        { interval: 10, timeout: 500 },
      );
      expect(got).toBe('arrived');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitFor under fake timers REJECTS a condition that only arrives after the timeout', async () => {
    vi.useFakeTimers();
    try {
      let ready = false;
      setTimeout(() => { ready = true; }, 120);
      await expect(
        vi.waitFor(
          () => { if (!ready) throw new Error('late-arrival-marker'); return 'too-late'; },
          { interval: 10, timeout: 100 },
        ),
      ).rejects.toThrow('late-arrival-marker');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitFor under fake timers still observes a condition arriving exactly at the timeout', async () => {
    vi.useFakeTimers();
    try {
      let ready = false;
      setTimeout(() => { ready = true; }, 100);
      const got = await vi.waitFor(
        () => { if (!ready) throw new Error('not yet'); return 'boundary'; },
        { interval: 10, timeout: 100 },
      );
      expect(got).toBe('boundary');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitFor under fake timers surfaces the last failure when never ready', async () => {
    vi.useFakeTimers();
    try {
      await expect(
        vi.waitFor(() => { throw new Error('fake-never-ready-marker'); }, { interval: 10, timeout: 60 }),
      ).rejects.toThrow('fake-never-ready-marker');
    } finally {
      vi.useRealTimers();
    }
  });

  it('runAllTimersAsync settles a timer callback that awaits', async () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      setTimeout(async () => { await Promise.resolve(); seen.push('fired'); }, 10);
      await vi.runAllTimersAsync();
      expect(seen).toEqual(['fired']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('advanceTimersByTimeAsync settles a timer callback that awaits', async () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      setTimeout(async () => { await Promise.resolve(); seen.push('fired'); }, 10);
      await vi.advanceTimersByTimeAsync(20);
      expect(seen).toEqual(['fired']);
    } finally {
      vi.useRealTimers();
    }
  });

  // NOTE: the hoisting helper is intentionally NOT asserted here, for two
  // reasons. (1) vitest's transform physically lifts that call to the top of the
  // module, above the imports — so merely writing it inside a test body makes the
  // file unparseable under vitest ("Expected a semicolon … after a statement").
  // (2) scripts/run-bun-tests.mjs matches the bare identifier to decide which
  // files the bun leg must skip, so even naming it in prose here would exclude
  // THIS file from the very leg it is meant to guard. It is unsupported under
  // bun, not shimmed — see the "DELIBERATELY NOT SHIMMED" list in
  // test/bun-test-shim.ts.
});

// The home fence has TWO override targets and TWO import forms; all four
// combinations must land inside the fenced home. `userInfo().homedir` does not go
// through `homedir()` (it leaked to the real `/root` before it was overridden),
// and the default export is a separate binding from the namespace — an earlier
// shape of the bun fence pointed `default` at the UNFENCED module. Assert the
// cross-product so neither route can regress silently on either runner.
describe('home fence parity (both override targets, both import forms)', () => {
  // Assert equality with the CURRENT fenced env, not inequality with one
  // machine's home path. `not.toBe('/root')` would pass on a GitHub runner
  // (`/home/runner`) or macOS (`/Users/...`) even if the fence were leaking
  // entirely — a false green wherever this repo's CI actually runs.
  const expectedHome = () => (process.platform === 'win32'
    ? process.env.USERPROFILE
    : process.env.HOME);

  it('homedir() and userInfo().homedir both equal the fenced HOME', () => {
    expect(expectedHome()).toBeTruthy();
    expect(homedir()).toBe(expectedHome());
    expect(userInfo().homedir).toBe(expectedHome());
  });

  // The assertion above only proves CONSISTENCY: both fences set `process.env.HOME`
  // AND redirect `homedir()`, so comparing the two to each other still passes if
  // the fence is removed entirely (measured — that mutation stayed green). Anchor
  // containment on something the fence cannot move: the OS temp root. Both fences
  // mint their disposable home under `tmpdir()`, and a leak to a real home
  // (`/root`, `/home/runner`, `/Users/...`) is not under it — on any platform,
  // which `not.toBe('/root')` could not claim.
  it('the fenced home lives under the OS temp root, not a real user home', () => {
    const home = homedir();
    const tmpRoot = realpathSync(tmpdir());
    expect(realpathSync(home).startsWith(tmpRoot)).toBe(true);
  });

  it('the default import sees the same fenced values as the named import', () => {
    expect(osDefault.homedir()).toBe(expectedHome());
    expect(osDefault.userInfo().homedir).toBe(expectedHome());
  });

  // The fence substitutes `homedir`, and must keep that field's ORIGINAL type:
  // `userInfo({ encoding: 'buffer' })` returns Buffers under Node (Bun 1.4 returns
  // strings for both overloads), so a hardcoded string produced a mixed
  // `username: Buffer, homedir: string` object no runtime ever returns. Compare the
  // two fields rather than asserting one concrete type, so this passes on either
  // runtime and still fails if the substitution changes the shape.
  it('userInfo({encoding:"buffer"}) keeps homedir the same type as username', () => {
    const info = userInfo({ encoding: 'buffer' }) as unknown as { homedir: unknown; username: unknown };
    expect(Buffer.isBuffer(info.homedir)).toBe(Buffer.isBuffer(info.username));
    // …and whatever the type, it still points at the fenced home.
    const asString = Buffer.isBuffer(info.homedir) ? info.homedir.toString() : String(info.homedir);
    expect(asString).toBe(expectedHome());
  });

  it('non-home fields of userInfo are left real', () => {
    expect(typeof userInfo().uid).toBe('number');
    expect(typeof userInfo().username).toBe('string');
  });
});

// `.sequential` is shimmed under bun as an IDENTITY, which is only correct because
// `bun test` runs tests sequentially by default. Assert that default directly, so
// a future Bun release that makes concurrency the default turns this red instead
// of letting the identity silently stop meaning what the caller asked for.
describe.sequential('sequential parity', () => {
  const order: string[] = [];

  it.sequential('first test yields, then finishes', async () => {
    order.push('first-start');
    await new Promise(resolve => setTimeout(resolve, 30));
    order.push('first-end');
    expect(order).toEqual(['first-start', 'first-end']);
  });

  it.sequential('second test starts only after the first fully finished', () => {
    order.push('second');
    // Interleaving would give ['first-start', 'second', …] instead.
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });
});

// Exact-path env overrides that bypass `homedir()`/`userInfo()` and lead to real
// writes (usage ledger, dashboard control audit, miramcp config + pidfile, the
// core-only state dir). A value inherited from the caller's shell would have the
// suite mutate live state, so both fences DELETE them. Asserting absence — rather
// than "points somewhere safe" — matches the chosen contract: `resolveBotConfigPath`
// fails closed on a set-but-missing path, so redirecting would change behaviour for
// every test that never set the variable.
//
// ⚠️ The test SEEDS the variables itself and calls the shared helper directly.
// Merely asserting they are unset after setup is a zero-input guard: in CI (and any
// clean shell) most of these are unset anyway, so deleting every `delete` from the
// helper still passed — measured: fence fully disabled + clean env = 21/21 green.
// Seeding is what gives the guard teeth on the machines that actually run it.
describe('exact-path env overrides are cleared by the shared fence', () => {
  const cleared = [
    'BOTS_CONFIG',
    'PM2_HOME',
    'PLUGIN_PM2_HOME',
    'BOTMUX_USAGE_DIR',
    'BOTMUX_DASHBOARD_CONTROL_AUDIT_PATH',
    'BOTMUX_CORE_STATE_DIR',
    'MIRAMCP_CONFIG_PATH',
    'MIRA_CONFIG_PATH',
    'MIRAMCP_PID_FILE',
  ] as const;

  it('deletes every one of them even when the caller had them set', () => {
    // Drive the helper against a THROWAWAY env object, not `process.env`. The
    // helper also rewrites the CLI homes (`CODEX_HOME`, `GROK_HOME`, …) and the
    // `XDG_*`/Windows profile dirs, so snapshotting only the nine keys asserted
    // here would leave any of those the caller had set pointing at the temp dir
    // this test then deletes — a dangling path for every later test in the
    // process. An isolated object sidesteps the whole restore problem.
    const env: NodeJS.ProcessEnv = {};
    for (const name of cleared) env[name] = `/root/.botmux/sentinel-${name}`;
    // A CLI home too, to prove the isolation covers the keys this test does not
    // assert on: it must be rewritten inside `env` and never touch process.env.
    env.CODEX_HOME = '/root/.codex';
    const before = process.env.CODEX_HOME;

    const fencedHome = mkdtempSync(join(tmpdir(), 'fence-env-parity-'));
    try {
      fenceHomeRootedEnv(fencedHome, env);
      expect(cleared.filter(name => env[name] !== undefined)).toEqual([]);
      // Redirected, not deleted — and inside the fence.
      expect(env.CODEX_HOME).toBe(join(fencedHome, '.codex'));
      // The live environment was not touched at all.
      expect(process.env.CODEX_HOME).toBe(before);
    } finally {
      rmSync(fencedHome, { recursive: true, force: true });
    }
  });

  it('and none of them is set inside the fenced run itself', () => {
    const stillSet = cleared.filter(name => process.env[name] !== undefined);
    expect(stillSet).toEqual([]);
  });
});

// `toHaveBeenCalledExactlyOnceWith` is shimmed under bun (vitest has it natively).
// Its meaning is a CONJUNCTION — called exactly once, AND with these arguments — so
// the guard has to cover the failing quadrants too: a shim that only compared
// arguments would pass for a mock called three times whose first call matched, and
// one that only counted calls would pass for a single wrong-argument call. The
// repository's two production users only exercise the passing case, so without these
// the count check could be deleted and CI would stay green.
describe('toHaveBeenCalledExactlyOnceWith parity', () => {
  it('passes when called exactly once with those arguments', () => {
    const fn = vi.fn();
    fn('a', 1);
    expect(fn).toHaveBeenCalledExactlyOnceWith('a', 1);
  });

  it('FAILS when called twice, even though the first call matches', () => {
    const fn = vi.fn();
    fn('a', 1);
    fn('a', 1);
    expect(() => expect(fn).toHaveBeenCalledExactlyOnceWith('a', 1)).toThrow();
  });

  it('FAILS when called once with different arguments', () => {
    const fn = vi.fn();
    fn('b', 2);
    expect(() => expect(fn).toHaveBeenCalledExactlyOnceWith('a', 1)).toThrow();
  });

  it('FAILS when never called at all', () => {
    const fn = vi.fn();
    expect(() => expect(fn).toHaveBeenCalledExactlyOnceWith('a', 1)).toThrow();
  });
});

// `it.runIf(cond)` must behave exactly like `skipIf(!cond)`: Bun ships skipIf but
// not runIf, and the shim inverts it. Asserting the ran/skipped split (rather
// than just "did not crash") is what makes the equivalence testable.
const runIfRan: string[] = [];

describe('it.runIf parity', () => {
  it.runIf(true)('runs when the condition is true', () => {
    runIfRan.push('true-branch');
    expect(true).toBe(true);
  });

  it.runIf(false)('is skipped when the condition is false', () => {
    runIfRan.push('false-branch');
    expect(true).toBe(true);
  });

  it('observes exactly the true branch having run', () => {
    expect(runIfRan).toEqual(['true-branch']);
  });
});

describe.runIf(false)('describe.runIf(false) skips the whole block', () => {
  it('must never run', () => {
    runIfRan.push('block-branch');
    expect(true).toBe(true);
  });
});
