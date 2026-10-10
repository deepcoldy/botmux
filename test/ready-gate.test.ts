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
 * …and that cap is a REAL deadline: because the aligned fallback lands in the
 * same tick as the hard cap, the gate's release starts a settle that
 * flushPending() would otherwise honour for up to READY_FLUSH_SETTLE_CAP_MS, so
 * a missing signal cost 90-96s instead of 90s. The hard-cap path cancels a
 * settle still pending at the cap (worker.ts cancelFirstFlushSettle); the
 * timeline models that as "the cap bounds every write".
 *
 * Run: pnpm vitest run test/ready-gate.test.ts
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadyGate, shouldArmReadyGate } from '../src/utils/ready-gate.js';
import { resolveReadySignalTimeoutMs, shouldReleaseFirstPromptTimeout } from '../src/utils/input-gate.js';
import { createGrokAdapter } from '../src/adapters/cli/grok.js';

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
const READY_FLUSH_SETTLE_MS = 1_000;
const READY_FLUSH_SETTLE_CAP_MS = 6_000;

/** src/worker.ts, read once — the two source-pinned assertions below bind their
 *  timelines to the real call sites instead of restating intent. */
const WORKER_SRC = readFileSync(join(__dirname, '..', 'src', 'worker.ts'), 'utf8');

/** The `forced` qualifier on the first-prompt gate release (worker.ts,
 *  `releaseFirstPromptTimeout`). Without it the release is unconditional, so the
 *  15s SOFT timeout opens an armed gate and a non-deferring adapter's first
 *  write lands at ~15s + settle instead of at its 45s fallback edge. */
const FIRST_PROMPT_GATE_RELEASE_GUARD = 'if (forced && readyGate.shouldHold())';

/** The real call-site window around `releaseReadyGate('first-prompt hard
 *  timeout')` — the guard + the release call, so a timeline can read the rule
 *  the code actually implements. */
function firstPromptGateReleaseCallSite(): string {
  const call = WORKER_SRC.indexOf("releaseReadyGate('first-prompt hard timeout')");
  if (call < 0) throw new Error('worker.ts no longer releases the ready gate on the first-prompt timeout');
  return WORKER_SRC.slice(Math.max(0, call - 400), call);
}

/** Model one spawn's first-prompt gate under fake timers, using the production
 *  decision functions the worker actually calls. Flush times are returned as the
 *  instant the held first prompt becomes writable:
 *    gate fallback/signal → settle (worst case: `settleMs`, since dsh-tui
 *    repaints) → flushPending().
 *  Before the gate releases nothing can be written, and the adapter's own
 *  deferral forbids the soft 15s flush.
 *
 *  The settle is bounded by the FIRST-PROMPT HARD CAP, exactly like the worker:
 *  `releaseFirstPromptTimeout` calls `cancelFirstFlushSettle()` at the cap, so a
 *  settle still in flight (started by the cap-aligned gate fallback in the same
 *  tick, or by a signal that landed just before the cap) cannot push the first
 *  write past it. `settlePendingAtCap` reports whether that cancel was actually
 *  exercised in this run — an assertion that the timeline is not vacuous. */
function runFirstPromptTimeline(opts: {
  /** The adapter deliberately opts into the cap-aligned gate fallback
   *  (CliAdapter.readyGateFallbackAlignedWithHardCap). */
  alignReadyGateFallbackWithHardCap: boolean;
  /** Feeds the independent soft-timeout decision (shouldReleaseFirstPromptTimeout). */
  deferFirstPromptTimeoutUntilReady: boolean;
  hasReadyPattern: boolean;
  signalAtMs?: number;
  /** How long the post-release settle runs for (default: the cap = never quiet). */
  settleMs?: number;
}): {
  fallbackMs: number;
  fallbackFiredAtMs?: number;
  writableAtMs: number;
  settlePendingAtCap: boolean;
  hardCapReleasedAtMs: number;
} {
  const settleMs = opts.settleMs ?? READY_FLUSH_SETTLE_CAP_MS;
  const gate = new ReadyGate();
  gate.arm();
  // Anchor the fake clock at 0 so every instant below is an offset from spawn.
  vi.setSystemTime(0);
  const fallbackMs = resolveReadySignalTimeoutMs({
    alignFallbackWithFirstPromptHardCap: opts.alignReadyGateFallbackWithHardCap,
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
  const settlePendingAtCap = releasedAtMs !== undefined
    && releasedAtMs <= FIRST_PROMPT_HARD_TIMEOUT_MS
    && releasedAtMs + settleMs > FIRST_PROMPT_HARD_TIMEOUT_MS;
  const writableAtMs = releasedAtMs === undefined
    ? Number.POSITIVE_INFINITY
    // The cap cancels the settle; anything released before it either finished
    // (releasedAt + settleMs ≤ cap) or is cut off at the cap.
    : Math.min(releasedAtMs + settleMs, FIRST_PROMPT_HARD_TIMEOUT_MS);
  return { fallbackMs, fallbackFiredAtMs: releasedAtMs, writableAtMs, settlePendingAtCap, hardCapReleasedAtMs };
}

describe('first-prompt fallback alignment', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('dsh-tui: a missing signal writes at exactly 90s, settle cancelled at the cap', () => {
    vi.useFakeTimers();
    const timeline = runFirstPromptTimeline({
      alignReadyGateFallbackWithHardCap: true,
      deferFirstPromptTimeoutUntilReady: true,
      hasReadyPattern: true,
    });
    // Aligned with the adapter's own hard cap instead of the legacy 45s.
    expect(timeline.fallbackMs).toBe(90_000);
    // The gate releases at the hard cap (not at 45s)…
    expect(timeline.fallbackFiredAtMs).toBe(90_000);
    // …and that release DOES start a settle which the cap then cancels: this is
    // the non-vacuous case (before the fix it produced 96s).
    expect(timeline.settlePendingAtCap).toBe(true);
    // The cap is the deadline: not "90s + up to READY_FLUSH_SETTLE_CAP_MS".
    expect(timeline.writableAtMs).toBe(90_000);
  });

  it('dsh-tui: a PTY that never goes quiet cannot push the write past 90s either', () => {
    vi.useFakeTimers();
    // Worst case (continuous repaint → the settle always runs its full cap) vs.
    // a quiet PTY (settle satisfied after READY_FLUSH_SETTLE_MS): both are cut
    // off by the cap, so neither can delay the first write.
    const chatty = runFirstPromptTimeline({
      alignReadyGateFallbackWithHardCap: true,
      deferFirstPromptTimeoutUntilReady: true,
      hasReadyPattern: true,
      settleMs: READY_FLUSH_SETTLE_CAP_MS,
    });
    const quiet = runFirstPromptTimeline({
      alignReadyGateFallbackWithHardCap: true,
      deferFirstPromptTimeoutUntilReady: true,
      hasReadyPattern: true,
      settleMs: READY_FLUSH_SETTLE_MS,
    });
    expect(chatty.writableAtMs).toBe(90_000);
    expect(quiet.writableAtMs).toBe(90_000);
    expect(chatty.settlePendingAtCap).toBe(true);
    expect(quiet.settlePendingAtCap).toBe(true);
  });

  it('dsh-tui: a real ready signal still releases the gate as soon as it lands', () => {
    vi.useFakeTimers();
    const timeline = runFirstPromptTimeline({
      alignReadyGateFallbackWithHardCap: true,
      deferFirstPromptTimeoutUntilReady: true,
      hasReadyPattern: true,
      signalAtMs: 13_600, // measured spawn → ❯ on a cold dsh-tui boot
    });
    expect(timeline.fallbackMs).toBe(90_000);
    expect(timeline.fallbackFiredAtMs).toBe(13_600);
    // Evidence lands long before the deferred soft timeout; the settle is the
    // only remaining hold, and the cap is never reached.
    expect(timeline.settlePendingAtCap).toBe(false);
    expect(timeline.writableAtMs).toBe(13_600 + READY_FLUSH_SETTLE_CAP_MS);
  });

  it('dsh-tui: evidence that lands just before the cap is still bounded by the cap', () => {
    vi.useFakeTimers();
    const timeline = runFirstPromptTimeline({
      alignReadyGateFallbackWithHardCap: true,
      deferFirstPromptTimeoutUntilReady: true,
      hasReadyPattern: true,
      signalAtMs: 88_000,
    });
    expect(timeline.fallbackFiredAtMs).toBe(88_000);
    // Its settle would have run to 94s; the cap cancels it at 90s.
    expect(timeline.settlePendingAtCap).toBe(true);
    expect(timeline.writableAtMs).toBe(90_000);
  });

  it('legacy adapters keep the 45s fallback (its signal is their only ready edge)', () => {
    vi.useFakeTimers();
    const timeline = runFirstPromptTimeline({
      alignReadyGateFallbackWithHardCap: false,
      deferFirstPromptTimeoutUntilReady: false,
      hasReadyPattern: true,
    });
    expect(timeline.fallbackMs).toBe(45_000);
    expect(timeline.fallbackFiredAtMs).toBe(45_000);
    // Nothing is pending at the 90s cap for them (45s + settle ≪ 90s).
    expect(timeline.settlePendingAtCap).toBe(false);
    expect(timeline.writableAtMs).toBe(45_000 + READY_FLUSH_SETTLE_CAP_MS);
  });

  it('a non-deferring adapter (claude-code) holds the gate through the 15s soft timeout: only the hard cap may open it', () => {
    // The gate exists to stop a startup selector's fake ❯ from eating the first
    // message. claude-code does NOT declare deferFirstPromptTimeoutUntilReady, so
    // its 15s soft timeout releases the QUEUE — but if it also opened the gate,
    // the write would move from master's ~45-51s (the READY_SIGNAL_TIMEOUT_MS
    // fallback, the gate's only release edge besides a real signal) to ~15-21s,
    // i.e. into a selector that may not have been passed yet.
    const callSite = firstPromptGateReleaseCallSite();
    // The code fact the timeline below is derived from: the release is qualified
    // by `forced` (asserted at the end, so a regression fails on the BEHAVIOUR
    // first and this line only confirms the source it came from).
    const softTimeoutReleasesGate = !callSite.includes(FIRST_PROMPT_GATE_RELEASE_GUARD);
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const gate = new ReadyGate();
    gate.arm();
    let gateReleasedAtMs = Number.POSITIVE_INFINITY;
    const release = (): void => { if (gate.receive()) gateReleasedAtMs = Date.now(); };

    // The 15s SOFT timeout (forced = false): the queue is released here, which is
    // master's semantics for an adapter without defer…
    const softTimeoutReleasedQueue = shouldReleaseFirstPromptTimeout({
      deferFirstPromptTimeoutUntilReady: false,
      hasReadyPattern: true,
      elapsedMs: FIRST_PROMPT_TIMEOUT_MS,
      hardTimeoutMs: FIRST_PROMPT_HARD_TIMEOUT_MS,
    });
    vi.advanceTimersByTime(FIRST_PROMPT_TIMEOUT_MS);
    if (softTimeoutReleasesGate) release(); // the regression this pins
    const gateOpenAtSoftTimeout = !gate.shouldHold();
    // …and the adapter's own cap is 75s away, so no settle is cancelled here
    // (worker.ts cancels only `if (forced)`), and both flushPending() and
    // markPromptReady() bail while the gate still holds → nothing is written.
    const writableAtSoftTimeout = gateOpenAtSoftTimeout;

    // 45s: the gate's own fallback (READY_SIGNAL_TIMEOUT_MS) — its release edge.
    const fallbackMs = resolveReadySignalTimeoutMs({
      alignFallbackWithFirstPromptHardCap: false,
      readySignalTimeoutMs: READY_SIGNAL_TIMEOUT_MS,
      firstPromptHardTimeoutMs: FIRST_PROMPT_HARD_TIMEOUT_MS,
    });
    vi.advanceTimersByTime(fallbackMs - FIRST_PROMPT_TIMEOUT_MS);
    if (gate.shouldHold()) release();
    // Post-release: the worker settles for PTY quiescence (quiet PTY, so the
    // 1s window is satisfied) and only then flushes.
    const writableAtMs = gateReleasedAtMs + READY_FLUSH_SETTLE_MS;

    expect(softTimeoutReleasedQueue).toBe(true);
    expect(fallbackMs).toBe(READY_SIGNAL_TIMEOUT_MS);
    expect(gateReleasedAtMs, 'the 15s soft timeout opened the ready gate').toBe(READY_SIGNAL_TIMEOUT_MS);
    expect(writableAtSoftTimeout, 'the first message reached the PTY while the gate was still armed').toBe(false);
    expect(writableAtMs, 'the first write moved off the 45s fallback edge').toBe(READY_SIGNAL_TIMEOUT_MS + READY_FLUSH_SETTLE_MS);
    expect(callSite, 'worker.ts must release the first-prompt gate at the hard cap only')
      .toContain(FIRST_PROMPT_GATE_RELEASE_GUARD);
  });

  it('a deferring adapter without a readyPattern is not aligned (release at 45s)', () => {
    vi.useFakeTimers();
    const timeline = runFirstPromptTimeline({
      alignReadyGateFallbackWithHardCap: false,
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

  it('grok keeps the 45s fallback: the 90s alignment is an explicit opt-in, not a shared-flags derivation', () => {
    const grok = createGrokAdapter();
    // Grok carries BOTH flags the old derivation keyed on…
    expect(grok.deferFirstPromptTimeoutUntilReady).toBe(true);
    expect(!!grok.readyPattern).toBe(true);
    // …so a flag-derived alignment silently moved its gate fallback from 45s to
    // 90s, delaying every first prompt by ~45s whenever its SessionStart signal
    // is missing. Counterfactual of that old derivation, on this same adapter:
    const legacyDerivedFallbackMs = grok.deferFirstPromptTimeoutUntilReady === true && !!grok.readyPattern
      ? Math.max(READY_SIGNAL_TIMEOUT_MS, FIRST_PROMPT_HARD_TIMEOUT_MS)
      : READY_SIGNAL_TIMEOUT_MS;
    expect(legacyDerivedFallbackMs).toBe(90_000);
    // It never opted in, so it keeps the shared fallback.
    expect(grok.readyGateFallbackAlignedWithHardCap).toBeUndefined();
    expect(resolveReadySignalTimeoutMs({
      alignFallbackWithFirstPromptHardCap: grok.readyGateFallbackAlignedWithHardCap === true,
      readySignalTimeoutMs: READY_SIGNAL_TIMEOUT_MS,
      firstPromptHardTimeoutMs: FIRST_PROMPT_HARD_TIMEOUT_MS,
    })).toBe(45_000);
  });

  it('the worker cancels a pending settle at the hard cap only, never at a soft timeout (source pin)', () => {
    // The timeline above models the contract ("the cap bounds every write");
    // this pins the real call site so a refactor cannot drop the cancellation
    // and silently restore the 90-96s window — nor make it unconditional, which
    // would strip the settle from the legacy soft-timeout release.
    const worker = readFileSync(join(__dirname, '..', 'src', 'worker.ts'), 'utf8');
    const hardCapRelease = worker.indexOf("releaseReadyGate('first-prompt hard timeout')");
    expect(hardCapRelease).toBeGreaterThan(-1);
    expect(worker.slice(hardCapRelease, hardCapRelease + 800)).toContain('if (forced) cancelFirstFlushSettle();');
  });
});
