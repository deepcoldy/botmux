/**
 * Bounded fallback for the viewport busy-marker prompt-ready veto.
 *
 * `deferPromptReadyWhileBusy` / `scheduleBusyPatternIdleProbe` re-probe the
 * screen every few seconds with no upper bound. Under sustained host load a
 * stale busy glyph can linger in the probe region even after the CLI has
 * actually returned to its composer: the screen stops changing and the input
 * prompt is visible, but the busy pattern still matches, so prompt-ready is
 * withheld indefinitely and a queued turn is never re-driven.
 *
 * This gate is the safety bound. It releases readiness ONLY when every
 * condition below holds at once, so a CLI that is genuinely still working
 * (screen/transcript actively changing, or the structured session-state store
 * reporting busy) can never be misread as idle:
 *
 *  1. the CLI process is alive (unknown liveness does not block);
 *  2. the input composer / ready pattern is on screen (positive idle evidence,
 *     never a mere absence of the busy marker);
 *  3. the structured session-state store does NOT report active work — that
 *     signal is authoritative and is never overridden here;
 *  4. the CLI's own transcript does NOT leave the turn open. Claude Code draws
 *     its `❯` composer while working, and with `prefersReducedMotion` its
 *     spinner is static: a real turn waiting on the API (thinking, a slow
 *     first token, retry backoff) shows busy footer + composer on a frozen
 *     screen for well over `stableScreenMs`, exactly like a stale glyph;
 *  5. the defer episode has lasted at least `fallbackMs`;
 *  6. the screen revision has stayed unchanged for at least `stableScreenMs`,
 *     i.e. the screen is frozen rather than still streaming.
 *
 * A tick vetoed by 3 or 4 neither starts nor extends an episode: the bound
 * only measures time during which the screen glyph alone holds readiness back.
 *
 * The class is clock-agnostic: callers pass `now` and the observed screen
 * revision explicitly, so the timing logic is deterministic under a fake clock.
 */
export interface BusyReadyFallbackThresholds {
  /** Minimum wall-clock a busy-marker defer episode must last before the bound may release readiness. */
  fallbackMs: number;
  /** Minimum wall-clock the screen revision must remain unchanged before a lingering busy marker is treated as stale. */
  stableScreenMs: number;
}

export interface BusyProbeObservation {
  now: number;
  /** Monotonic backend screen revision (increments on every screen update). */
  screenRevision: number;
  /** True when the CLI input composer / ready pattern is rendered on the current screen. */
  readyPatternVisible: boolean;
  /** True while the structured session-state store reports active work. Never overridden by this gate. */
  sessionStateBusy: boolean;
  /** True while the CLI's transcript still leaves the current turn open. Never overridden by this gate. */
  transcriptTurnOpen: boolean;
  /** False only when the CLI process is known to be dead; undefined/true means alive-or-unknown. */
  cliAlive: boolean | undefined;
}

export class BusyReadyFallbackGate {
  private deferStartedAt: number | null = null;
  private lastRevision = -1;
  private lastRevisionChangeAt = 0;

  constructor(private readonly thresholds: () => BusyReadyFallbackThresholds) {}

  /** Record one still-deferred probe tick. Tracks the episode start and the last screen-revision change. */
  observe(o: BusyProbeObservation): void {
    if (vetoed(o)) return;
    if (this.deferStartedAt === null) {
      this.deferStartedAt = o.now;
      this.lastRevisionChangeAt = o.now;
    }
    if (o.screenRevision !== this.lastRevision) {
      this.lastRevision = o.screenRevision;
      this.lastRevisionChangeAt = o.now;
    }
  }

  /** Drop all episode state; the next observe() starts a fresh episode. */
  reset(): void {
    this.deferStartedAt = null;
    this.lastRevision = -1;
    this.lastRevisionChangeAt = 0;
  }

  /** True only when a busy marker is stale (composer visible, screen frozen, CLI alive) past the bounded window. */
  shouldForceReady(o: BusyProbeObservation): boolean {
    if (this.deferStartedAt === null) return false;
    // Structured busy, an open transcript turn and a dead/unknown-composer CLI are never force-released.
    if (vetoed(o) || o.cliAlive === false || !o.readyPatternVisible) return false;
    const { fallbackMs, stableScreenMs } = this.thresholds();
    if (o.now - this.deferStartedAt < fallbackMs) return false;
    // A screen that is still streaming (revision changed recently) means real work.
    if (o.now - this.lastRevisionChangeAt < stableScreenMs) return false;
    return true;
  }
}

function vetoed(o: BusyProbeObservation): boolean {
  return o.sessionStateBusy || o.transcriptTurnOpen;
}
