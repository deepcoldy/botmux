/**
 * ready-gate.test.ts
 *
 * Ready-gate state machine — holds the FIRST prompt for Claude-family CLIs until
 * a SessionStart hook fires a "真就绪" signal (or a fallback timeout elapses), so
 * a cjadk-style startup selector's ❯ (which falsely matches readyPattern) can't
 * trip an early flush that the selector eats.
 *
 * Scenarios pinned (per the task brief): signal-first, signal-after, timeout
 * fallback, resume (re-arm), and the not-armed passthrough that guarantees every
 * other CLI / adopt pane behaves exactly as before.
 *
 * Plus the first-prompt fallback ALIGNMENT: for an adapter that defers the first
 * prompt to a real readyPattern (dsh-tui), the gate's own fallback must not fire
 * before that adapter's hard cap — otherwise the fallback becomes the effective
 * deadline and delivers the first prompt at ~45-51s into a TUI whose composer
 * may not be mounted. The timeline below runs the REAL decision functions
 * (resolveReadySignalTimeoutMs / ReadyGate / shouldReleaseFirstPromptTimeout)
 * under fake timers; the settle window models the worker's
 * READY_FLUSH_SETTLE_MS/CAP at its worst case (a TUI that repaints, so the
 * settle always runs to the cap).
 *
 * Run: pnpm vitest run test/ready-gate.test.ts
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { ReadyGate, shouldArmReadyGate } from '../src/utils/ready-gate.js';
import { resolveReadySignalTimeoutMs, shouldReleaseFirstPromptTimeout } from '../src/utils/input-gate.js';

describe('shouldArmReadyGate', () => {
  const base = {
    injectsReadyHook: true,
    readySignalAvailable: true,
    adoptMode: false,
    willReattachPersistent: false,
  };

  it('arms a fresh Claude-family spawn (hook will fire)', () => {
    expect(shouldArmReadyGate(base)).toBe(true);
  });

  it('does NOT arm a non-Claude CLI (no SessionStart hook injected)', () => {
    expect(shouldArmReadyGate({ ...base, injectsReadyHook: false })).toBe(false);
  });

  it('does NOT arm when hook/transport preflight says the signal cannot arrive', () => {
    expect(shouldArmReadyGate({ ...base, readySignalAvailable: false })).toBe(false);
  });

  it('does NOT arm adopt panes (pre-existing, never got our --settings)', () => {
    expect(shouldArmReadyGate({ ...base, adoptMode: true })).toBe(false);
  });

  it('THE REATTACH REGRESSION: does NOT arm a persistent-backend reattach', () => {
    // daemon restart re-attaches an already-running tmux/zellij/herdr/zmx Claude
    // WITHOUT re-running its bin/args → no new SessionStart hook fires. Arming
    // would hold the first post-recovery message until the fallback timeout.
    expect(shouldArmReadyGate({ ...base, willReattachPersistent: true })).toBe(false);
  });

  it('reattach exclusion wins even for an otherwise-eligible fresh-looking spawn', () => {
    expect(shouldArmReadyGate({
      injectsReadyHook: true,
      readySignalAvailable: true,
      adoptMode: false,
      willReattachPersistent: true,
    })).toBe(false);
  });

  it('KEEPS arming for aiden x claude: --settings is stripped but the SessionStart hook is installed globally', () => {
    // wrapperCli "aiden x claude" drops process-level --settings, yet the ready
    // hook is ALSO in ~/.claude/settings.json (hookInstall.sessionStartCommand),
    // which aiden's real Claude still reads → the signal fires → keep the gate.
    expect(shouldArmReadyGate(base)).toBe(true);
  });
});

describe('ReadyGate', () => {
  it('not armed → never holds, receive() reports no flush needed (other CLIs / adopt)', () => {
    const g = new ReadyGate();
    expect(g.isArmed).toBe(false);
    expect(g.shouldHold()).toBe(false);
    // A stray signal on an un-armed gate releases nothing (nothing was held).
    expect(g.receive()).toBe(false);
    expect(g.shouldHold()).toBe(false);
  });

  it('armed → holds until the signal arrives', () => {
    const g = new ReadyGate();
    g.arm();
    expect(g.isArmed).toBe(true);
    expect(g.shouldHold()).toBe(true);
  });

  it('signal arrives (hook) → release returns true once, then gate stays open', () => {
    const g = new ReadyGate();
    g.arm();
    expect(g.shouldHold()).toBe(true);
    expect(g.receive()).toBe(true);     // transition: holding → open ⇒ caller flushes
    expect(g.isReceived).toBe(true);
    expect(g.shouldHold()).toBe(false); // permanently open for this spawn
  });

  it('duplicate / late signal is idempotent (clear/compact source, or post-timeout fire)', () => {
    const g = new ReadyGate();
    g.arm();
    expect(g.receive()).toBe(true);
    // A second fire (e.g. SessionStart source=clear later in the session, or the
    // timeout firing after the real hook) must NOT trigger another flush.
    expect(g.receive()).toBe(false);
    expect(g.receive()).toBe(false);
    expect(g.shouldHold()).toBe(false);
  });

  it('timeout fallback before any signal → release returns true (flush held prompt)', () => {
    const g = new ReadyGate();
    g.arm();
    expect(g.shouldHold()).toBe(true);
    // Worker fallback timer calls receive() — same transition as the real hook.
    expect(g.receive()).toBe(true);
    expect(g.shouldHold()).toBe(false);
    // The real hook firing afterwards is then a no-op.
    expect(g.receive()).toBe(false);
  });

  it('resume re-arms via a fresh instance (worker recreates per spawn)', () => {
    // First spawn.
    let g = new ReadyGate();
    g.arm();
    expect(g.receive()).toBe(true);
    expect(g.shouldHold()).toBe(false);
    // Respawn / resume: worker assigns a brand-new gate, so the previous
    // received state can't leak and accidentally pass the next first prompt.
    g = new ReadyGate();
    g.arm();
    expect(g.shouldHold()).toBe(true);
    expect(g.isReceived).toBe(false);
  });

  it('arm() is idempotent and order-independent with receive()', () => {
    const g = new ReadyGate();
    g.arm();
    g.arm();
    expect(g.shouldHold()).toBe(true);
    expect(g.receive()).toBe(true);
  });
});

// The worker's real constants (src/worker.ts): the legacy fallback, the
// first-prompt soft timeout, the hard cap, and the worst-case settle.
const READY_SIGNAL_TIMEOUT_MS = 45_000;
const FIRST_PROMPT_TIMEOUT_MS = 15_000;
const FIRST_PROMPT_HARD_TIMEOUT_MS = 90_000;
const READY_FLUSH_SETTLE_CAP_MS = 6_000;

/** Model one spawn's first-prompt gate under fake timers, using the production
 *  decision functions the worker actually calls. Flush times are returned as the
 *  instant the held first prompt becomes writable:
 *    gate fallback/signal → settle (worst case: the cap, since dsh-tui repaints)
 *    → flushPending(). Before the gate releases nothing can be written, and the
 *    adapter's own deferral forbids the soft 15s flush. */
function runFirstPromptTimeline(opts: {
  deferFirstPromptTimeoutUntilReady: boolean;
  hasReadyPattern: boolean;
  signalAtMs?: number;
}): {
  fallbackMs: number;
  fallbackFiredAtMs?: number;
  writableAtMs: number;
  hardCapReleasedAtMs: number;
} {
  const gate = new ReadyGate();
  gate.arm();
  // Anchor the fake clock at 0 so every instant below is an offset from spawn.
  vi.setSystemTime(0);
  const fallbackMs = resolveReadySignalTimeoutMs({
    deferFirstPromptTimeoutUntilReady: opts.deferFirstPromptTimeoutUntilReady,
    hasReadyPattern: opts.hasReadyPattern,
    readySignalTimeoutMs: READY_SIGNAL_TIMEOUT_MS,
    firstPromptHardTimeoutMs: FIRST_PROMPT_HARD_TIMEOUT_MS,
  });
  let releasedAtMs: number | undefined;
  const release = (): void => { if (gate.receive()) releasedAtMs = Date.now(); };
  // The worker's first-prompt clock: for a deferring adapter the 15s soft timeout
  // re-arms to the hard cap, where a still-holding gate is released
  // (releaseFirstPromptTimeout → releaseReadyGate). Without a readyPattern the
  // soft timeout already releases the queue (gate still holds the write).
  const hardCapOwnsRelease = !shouldReleaseFirstPromptTimeout({
    deferFirstPromptTimeoutUntilReady: opts.deferFirstPromptTimeoutUntilReady,
    hasReadyPattern: opts.hasReadyPattern,
    elapsedMs: FIRST_PROMPT_TIMEOUT_MS,
    hardTimeoutMs: FIRST_PROMPT_HARD_TIMEOUT_MS,
  });
  let hardCapReleasedAtMs = 0;
  let now = 0;
  const at = (t: number): void => { if (t > now) { vi.advanceTimersByTime(t - now); now = t; } };
  const events: Array<{ atMs: number; run: () => void }> = [];
  if (opts.signalAtMs !== undefined) events.push({ atMs: opts.signalAtMs, run: release });
  events.push({ atMs: fallbackMs, run: () => { if (releasedAtMs === undefined) release(); } });
  if (hardCapOwnsRelease) {
    events.push({
      atMs: FIRST_PROMPT_HARD_TIMEOUT_MS,
      run: () => {
        if (!gate.shouldHold()) return;
        release();
        hardCapReleasedAtMs = Date.now();
      },
    });
  }
  for (const event of events.sort((a, b) => a.atMs - b.atMs)) {
    at(event.atMs);
    event.run();
  }
  const writableAtMs = releasedAtMs === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(releasedAtMs, hardCapReleasedAtMs) + READY_FLUSH_SETTLE_CAP_MS;
  return { fallbackMs, fallbackFiredAtMs: releasedAtMs, writableAtMs, hardCapReleasedAtMs };
}

describe('first-prompt fallback alignment', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('dsh-tui: nothing is written at 45-51s, the fallback waits for the 90s cap', () => {
    vi.useFakeTimers();
    const timeline = runFirstPromptTimeline({
      deferFirstPromptTimeoutUntilReady: true,
      hasReadyPattern: true,
    });
    // Aligned with the adapter's own hard cap instead of the legacy 45s.
    expect(timeline.fallbackMs).toBe(90_000);
    // The gate releases at the hard cap (not at 45s), so the type-ahead flush can
    // only happen after the settle that follows it.
    expect(timeline.fallbackFiredAtMs).toBe(90_000);
    expect(timeline.writableAtMs).toBeGreaterThanOrEqual(90_000);
    expect(timeline.writableAtMs).toBeLessThanOrEqual(96_000);
  });

  it('dsh-tui: a real ready signal still releases the gate as soon as it lands', () => {
    vi.useFakeTimers();
    const timeline = runFirstPromptTimeline({
      deferFirstPromptTimeoutUntilReady: true,
      hasReadyPattern: true,
      signalAtMs: 13_600, // measured spawn → ❯ on a cold dsh-tui boot
    });
    expect(timeline.fallbackMs).toBe(90_000);
    expect(timeline.fallbackFiredAtMs).toBe(13_600);
    // Evidence lands long before the deferred soft timeout; the settle is the
    // only remaining hold.
    expect(timeline.writableAtMs).toBe(13_600 + READY_FLUSH_SETTLE_CAP_MS);
  });

  it('legacy adapters keep the 45s fallback (its signal is their only ready edge)', () => {
    vi.useFakeTimers();
    const timeline = runFirstPromptTimeline({
      deferFirstPromptTimeoutUntilReady: false,
      hasReadyPattern: true,
    });
    expect(timeline.fallbackMs).toBe(45_000);
    expect(timeline.fallbackFiredAtMs).toBe(45_000);
    expect(timeline.writableAtMs).toBe(45_000 + READY_FLUSH_SETTLE_CAP_MS);
  });

  it('a deferring adapter without a readyPattern is not aligned (release at 45s)', () => {
    vi.useFakeTimers();
    const timeline = runFirstPromptTimeline({
      deferFirstPromptTimeoutUntilReady: true,
      hasReadyPattern: false,
    });
    // shouldReleaseFirstPromptTimeout returns true immediately without a
    // readyPattern, so the 15s soft timeout (not the gate) owns the release.
    expect(timeline.fallbackMs).toBe(45_000);
    expect(shouldReleaseFirstPromptTimeout({
      deferFirstPromptTimeoutUntilReady: true,
      hasReadyPattern: false,
      elapsedMs: FIRST_PROMPT_TIMEOUT_MS,
      hardTimeoutMs: FIRST_PROMPT_HARD_TIMEOUT_MS,
    })).toBe(true);
  });
});
