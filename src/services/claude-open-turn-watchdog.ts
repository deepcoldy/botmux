/**
 * Bounded open-turn hold & fallback state machine for Claude Code transcripts.
 *
 * Why this exists (#3702 / #3636 Class B):
 * Claude Code's composer (`❯`) remains visible while working, and botmux's
 * injected `statusLine` (plus foreground Bash / narrow viewports) suppresses
 * the `· esc to interrupt` footer segment. Without OSC 7501 (e.g. Herdr,
 * reattached tmux, PTY), screen-idle quiescence (2s) or repeated Herdr
 * `agent wait` `done` edges fire mid-turn while Claude is awaiting an API
 * first token or running tools. Letting the 2s settle pop the head turn
 * prematurely releases active turn authority (causing mid-turn `botmux send`
 * 403s) and orphans the real final assistant text into a suppressed
 * `local-headless-*` turn.
 *
 * Why two clocks are required:
 * Claude Code's injected `statusLine` refreshes every 60s, emitting PTY bytes
 * even when a CLI is wedged. A single quiet clock reset by PTY output would
 * never expire on a wedged session:
 *  - Clock 1 (`quietMs`): resets on transcript progress OR PTY/screen output.
 *  - Clock 2 (`maxNoProgressMs`): resets ONLY on transcript `activitySeq`
 *    progress (or an authoritative busy hold such as OSC 7501 `working`,
 *    visible busy footer, pending background agents, or a non-composer screen
 *    like a permission dialog).
 *
 * Pure and clock-injectable (no fs / IPC / timers) so unit tests can drive
 * every tier and race deterministically with fake clocks.
 */

export type ClaudeOpenTurnTier =
  | 'user_stop'
  | 'unmarked_partial'
  | 'bare_open'
  | 'in_flight_model'
  | 'active_tool';

export interface ClaudeOpenTurnQueueEvidence {
  /** Monotonic intra-turn transcript progress counter. */
  activitySeq: number;
  /** Number of tool_use ids not yet paired with a tool_result. */
  unmatchedToolUseCount: number;
  /** True after main-thread `api-request` until assistant/error/interrupt. */
  apiRequestInFlight: boolean;
  /** True after `tool_result`, intra-turn attachment, `pause_turn`, or mid-turn compaction. */
  awaitingPostToolAssistant: boolean;
  /** True when the turn has accumulated at least one visible assistant text block. */
  hasVisibleAssistantText: boolean;
  /** True if this transcript generation has emitted any main-thread `api-request` record. */
  apiRequestObservedInGeneration: boolean;
}

export interface ClaudeOpenTurnObservation extends ClaudeOpenTurnQueueEvidence {
  /** `${bridgeTranscriptGeneration}:${turnId}:${dispatchAttempt ?? ''}`, or undefined when no open turn. */
  turnKey: string | undefined;
  /** Durable turns (`dispatchAttempt !== undefined`) are never popped unobserved. */
  durable: boolean;
  /** `UserPromptSubmit` hook confirmed this turn was submitted (helps pre-2.1.304 builds without `api-request`). */
  userPromptSubmitObserved: boolean;
  /** Worker delivered an explicit stop (`interrupt_turn` or `term_action` `ctrlc`). */
  userStopRequested: boolean;
  /** Worker PTY output generation snapshot. */
  ptyOutputGeneration: number;
  /** Backend authoritative screen revision counter. */
  screenRevision: number;
  /** False only when an authoritative non-empty screen positively hides the composer (e.g. permission dialog). */
  readyPatternVisible: boolean;
  /** True when an authoritative viewport shows the CLI busy marker. */
  busyPatternVisible: boolean;
  /** True while OSC 7501 holds `working` or `blocked`. */
  programStatusHeldBusy: boolean;
  /** True while background subagents launched by the current turn are still running. */
  pendingBackgroundAgents: boolean;
  /** True while the 2s flush-lag settle timer is actively polling. */
  idleSettleInFlight: boolean;
  /** Process liveness probe (`false` = dead, `true` = alive, `undefined` = unknown). */
  cliAlive: boolean | undefined;
  /** Monotonic/epoch timestamp in ms. */
  nowMs: number;
}

export interface ClaudeOpenTurnTierBounds {
  quietMs: number;
  maxNoProgressMs: number;
}

export interface ClaudeOpenTurnWatchdogConfig {
  /** Test-only override for `bare_open` and `unmarked_partial` quietMs. */
  bareQuietMs?: number;
  /** Test-only override for `in_flight_model` and `active_tool` quietMs. */
  inflightQuietMs?: number;
  /** Test-only override for `user_stop` quietMs. */
  userStopQuietMs?: number;
}

export type ClaudeOpenTurnEvaluateAction =
  | 'disarm'
  | 'wait'
  | 'release-dead'
  | 'release-timeout';

export type ClaudeOpenTurnWatchdogPhase = 'idle' | 'holding' | 'awaiting-marker-redrive';

/** Default poll cadence for the worker's open-turn watchdog timer. */
export const CLAUDE_OPEN_TURN_POLL_MS = 1_000;

/** Safety timer (ms) when a previously held turn reaches `awaitingDurationMarker`
 *  on a transcript proven to write `system/turn_duration` (p99 lag ~4.2s). */
export const CLAUDE_AWAITING_MARKER_REDRIVE_SAFETY_MS = 6_000;

export const CLAUDE_OPEN_TURN_DEFAULT_BOUNDS = {
  user_stop: { quietMs: 3_000, maxNoProgressMs: 10_000 },
  unmarked_partial: { quietMs: 4_000, maxNoProgressMs: 15_000 },
  bare_open: { quietMs: 15_000, maxNoProgressMs: 60_000 },
  bare_open_with_submit_hook: { quietMs: 25_000, maxNoProgressMs: 60_000 },
  in_flight_model: { quietMs: 120_000, maxNoProgressMs: 240_000 },
  active_tool: { quietMs: 300_000, maxNoProgressMs: 600_000 },
} as const;

export function parsePositiveMsEnv(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function classifyClaudeOpenTurnTier(
  obs: Pick<
    ClaudeOpenTurnObservation,
    | 'userStopRequested'
    | 'unmatchedToolUseCount'
    | 'apiRequestInFlight'
    | 'awaitingPostToolAssistant'
    | 'hasVisibleAssistantText'
  >,
): ClaudeOpenTurnTier {
  if (obs.userStopRequested) return 'user_stop';
  if (obs.unmatchedToolUseCount > 0) return 'active_tool';
  if (obs.apiRequestInFlight || obs.awaitingPostToolAssistant) return 'in_flight_model';
  if (obs.hasVisibleAssistantText) return 'unmarked_partial';
  return 'bare_open';
}

export function boundsForClaudeOpenTurn(
  obs: Pick<
    ClaudeOpenTurnObservation,
    | 'userStopRequested'
    | 'unmatchedToolUseCount'
    | 'apiRequestInFlight'
    | 'awaitingPostToolAssistant'
    | 'hasVisibleAssistantText'
    | 'userPromptSubmitObserved'
    | 'apiRequestObservedInGeneration'
  >,
  config: ClaudeOpenTurnWatchdogConfig = {},
): { tier: ClaudeOpenTurnTier; bounds: ClaudeOpenTurnTierBounds } {
  const tier = classifyClaudeOpenTurnTier(obs);
  const overrideBounds = (overrideQuietMs: number): ClaudeOpenTurnTierBounds => ({
    quietMs: overrideQuietMs,
    maxNoProgressMs: Math.max(overrideQuietMs * 2, overrideQuietMs),
  });
  switch (tier) {
    case 'user_stop':
      return {
        tier,
        bounds: config.userStopQuietMs !== undefined
          ? overrideBounds(config.userStopQuietMs)
          : { ...CLAUDE_OPEN_TURN_DEFAULT_BOUNDS.user_stop },
      };
    case 'active_tool':
      return {
        tier,
        bounds: config.inflightQuietMs !== undefined
          ? overrideBounds(config.inflightQuietMs)
          : { ...CLAUDE_OPEN_TURN_DEFAULT_BOUNDS.active_tool },
      };
    case 'in_flight_model':
      return {
        tier,
        bounds: config.inflightQuietMs !== undefined
          ? overrideBounds(config.inflightQuietMs)
          : { ...CLAUDE_OPEN_TURN_DEFAULT_BOUNDS.in_flight_model },
      };
    case 'unmarked_partial':
      return {
        tier,
        bounds: config.bareQuietMs !== undefined
          ? overrideBounds(config.bareQuietMs)
          : { ...CLAUDE_OPEN_TURN_DEFAULT_BOUNDS.unmarked_partial },
      };
    case 'bare_open':
      if (config.bareQuietMs !== undefined) {
        return { tier, bounds: overrideBounds(config.bareQuietMs) };
      }
      if (obs.userPromptSubmitObserved && !obs.apiRequestObservedInGeneration) {
        return { tier, bounds: { ...CLAUDE_OPEN_TURN_DEFAULT_BOUNDS.bare_open_with_submit_hook } };
      }
      return { tier, bounds: { ...CLAUDE_OPEN_TURN_DEFAULT_BOUNDS.bare_open } };
  }
}

interface HoldingEpisode {
  turnKey: string;
  durable: boolean;
  evidenceSource: string;
  lastActivitySeq: number;
  lastPtyGen: number;
  lastScreenRev: number;
  lastQuietResetAtMs: number;
  noProgressSinceMs: number;
  userStopRequested: boolean;
}

export class ClaudeOpenTurnWatchdog {
  private phase: ClaudeOpenTurnWatchdogPhase = 'idle';
  private episode: HoldingEpisode | null = null;
  private awaitingMarkerTurnKey: string | undefined;
  private awaitingMarkerEvidenceSource: string | undefined;
  /** User-stop key recorded even if the stop arrived before the first idle hold. */
  private stoppedTurnKey: string | undefined;
  private readonly config: ClaudeOpenTurnWatchdogConfig;

  constructor(config: ClaudeOpenTurnWatchdogConfig = {}) {
    this.config = config;
  }

  getPhase(): ClaudeOpenTurnWatchdogPhase {
    return this.phase;
  }

  isActive(): boolean {
    return this.phase !== 'idle';
  }

  boundTurnKey(): string | undefined {
    if (this.phase === 'holding') return this.episode?.turnKey;
    if (this.phase === 'awaiting-marker-redrive') return this.awaitingMarkerTurnKey;
    return undefined;
  }

  savedEvidenceSource(): string {
    if (this.phase === 'holding') return this.episode?.evidenceSource ?? 'screen';
    if (this.phase === 'awaiting-marker-redrive') return this.awaitingMarkerEvidenceSource ?? 'screen';
    return 'screen';
  }

  isHoldingFor(turnKey: string | undefined): boolean {
    return this.phase === 'holding' && !!turnKey && this.episode?.turnKey === turnKey;
  }

  isAwaitingMarkerRedriveFor(turnKey: string | undefined): boolean {
    return this.phase === 'awaiting-marker-redrive' && !!turnKey && this.awaitingMarkerTurnKey === turnKey;
  }

  /** Record an explicit user stop (`ctrlc` / `interrupt_turn`) for the active open turn.
   *  On the first `false -> true` transition for a held episode, re-anchor both
   *  clocks to `nowMs` so the CLI gets the full `user_stop` grace window to flush
   *  its `[Request interrupted by user]` record before fallback release fires. */
  noteUserStop(turnKey: string | undefined, nowMs: number = Date.now()): void {
    if (!turnKey) return;
    this.stoppedTurnKey = turnKey;
    if (this.phase === 'holding' && this.episode?.turnKey === turnKey && !this.episode.userStopRequested) {
      this.episode.userStopRequested = true;
      this.episode.lastQuietResetAtMs = nowMs;
      this.episode.noProgressSinceMs = nowMs;
    }
  }

  isUserStopRequestedFor(turnKey: string | undefined): boolean {
    if (!turnKey) return false;
    return this.stoppedTurnKey === turnKey
      || (this.phase === 'holding' && this.episode?.turnKey === turnKey && this.episode.userStopRequested);
  }

  /** Begin or reinforce an open-turn hold at an idle/Herdr-done boundary.
   *  Repeated calls for the same turnKey NEVER extend Clock 2 and only refresh
   *  Clock 1 if transcript/PTY/screen progress actually occurred (prevents Herdr
   *  `working -> done` flapping from deferring timeout indefinitely). */
  hold(obs: ClaudeOpenTurnObservation, evidenceSource: string): void {
    if (!obs.turnKey) return;
    const stopFlag = obs.userStopRequested || this.stoppedTurnKey === obs.turnKey;
    if (this.phase === 'holding' && this.episode && this.episode.turnKey === obs.turnKey) {
      this.episode.durable = obs.durable;
      this.episode.userStopRequested = this.episode.userStopRequested || stopFlag;
      if (obs.activitySeq !== this.episode.lastActivitySeq) {
        this.episode.lastActivitySeq = obs.activitySeq;
        this.episode.lastPtyGen = obs.ptyOutputGeneration;
        this.episode.lastScreenRev = obs.screenRevision;
        this.episode.lastQuietResetAtMs = obs.nowMs;
        this.episode.noProgressSinceMs = obs.nowMs;
      } else if (
        obs.ptyOutputGeneration !== this.episode.lastPtyGen
        || obs.screenRevision !== this.episode.lastScreenRev
      ) {
        this.episode.lastPtyGen = obs.ptyOutputGeneration;
        this.episode.lastScreenRev = obs.screenRevision;
        this.episode.lastQuietResetAtMs = obs.nowMs;
      }
      return;
    }
    this.phase = 'holding';
    this.awaitingMarkerTurnKey = undefined;
    this.awaitingMarkerEvidenceSource = undefined;
    this.episode = {
      turnKey: obs.turnKey,
      durable: obs.durable,
      evidenceSource,
      lastActivitySeq: obs.activitySeq,
      lastPtyGen: obs.ptyOutputGeneration,
      lastScreenRev: obs.screenRevision,
      lastQuietResetAtMs: obs.nowMs,
      noProgressSinceMs: obs.nowMs,
      userStopRequested: stopFlag,
    };
  }

  /** Called right after `bridgeIngest()` while the same turn stays open:
   *  advances both clocks if transcript `activitySeq` moved. */
  noteIngestProgress(obs: ClaudeOpenTurnObservation): void {
    if (this.phase !== 'holding' || !this.episode || obs.turnKey !== this.episode.turnKey) return;
    this.episode.durable = obs.durable;
    if (obs.userStopRequested || this.stoppedTurnKey === obs.turnKey) {
      this.episode.userStopRequested = true;
    }
    if (obs.activitySeq !== this.episode.lastActivitySeq) {
      this.episode.lastActivitySeq = obs.activitySeq;
      this.episode.lastPtyGen = obs.ptyOutputGeneration;
      this.episode.lastScreenRev = obs.screenRevision;
      this.episode.lastQuietResetAtMs = obs.nowMs;
      this.episode.noProgressSinceMs = obs.nowMs;
    }
  }

  /** Transition from `holding` to `awaiting-marker-redrive` once `end_turn`
   *  arrives and the turn enters `awaitingDurationMarker`. */
  enterAwaitingMarkerRedrive(turnKey: string, evidenceSource?: string): void {
    const saved = evidenceSource ?? this.episode?.evidenceSource ?? this.awaitingMarkerEvidenceSource ?? 'screen';
    this.phase = 'awaiting-marker-redrive';
    this.episode = null;
    this.awaitingMarkerTurnKey = turnKey;
    this.awaitingMarkerEvidenceSource = saved;
  }

  /** Evaluate whether the held episode should keep waiting, disarm, or release. */
  evaluate(obs: ClaudeOpenTurnObservation): ClaudeOpenTurnEvaluateAction {
    if (this.phase !== 'holding' || !this.episode) return 'disarm';
    if (!obs.turnKey || obs.turnKey !== this.episode.turnKey) {
      this.reset();
      return 'disarm';
    }
    if (obs.cliAlive === false) {
      return 'release-dead';
    }
    if (obs.durable || this.episode.durable) {
      return 'wait';
    }
    if ((obs.userStopRequested || this.stoppedTurnKey === obs.turnKey) && !this.episode.userStopRequested) {
      this.episode.userStopRequested = true;
      this.episode.lastQuietResetAtMs = obs.nowMs;
      this.episode.noProgressSinceMs = obs.nowMs;
    }
    const effectiveUserStop = obs.userStopRequested || this.episode.userStopRequested;
    // Authoritative busy hold (OSC 7501 working/blocked, visible busy footer,
    // pending background subagents, or non-composer screen like permission/AskUser):
    // never time out an actively busy or interactively blocked CLI. When the
    // user explicitly requested a stop (`ctrlc` / `interrupt_turn`), do not let
    // lingering background agents or stale OSC 7501 starve the bounded user_stop
    // fallback forever.
    const authoritativeHold = obs.busyPatternVisible
      || !obs.readyPatternVisible
      || (!effectiveUserStop && (obs.programStatusHeldBusy || obs.pendingBackgroundAgents));
    if (authoritativeHold) {
      this.episode.lastActivitySeq = obs.activitySeq;
      this.episode.lastPtyGen = obs.ptyOutputGeneration;
      this.episode.lastScreenRev = obs.screenRevision;
      this.episode.lastQuietResetAtMs = obs.nowMs;
      this.episode.noProgressSinceMs = obs.nowMs;
      return 'wait';
    }
    // Transcript progress resets BOTH Clock 1 (quiet) and Clock 2 (hard cap).
    if (obs.activitySeq !== this.episode.lastActivitySeq) {
      this.episode.lastActivitySeq = obs.activitySeq;
      this.episode.lastPtyGen = obs.ptyOutputGeneration;
      this.episode.lastScreenRev = obs.screenRevision;
      this.episode.lastQuietResetAtMs = obs.nowMs;
      this.episode.noProgressSinceMs = obs.nowMs;
      return 'wait';
    }
    // PTY/screen repaint resets Clock 1 ONLY — never Clock 2 (defeats 60s statusLine repaint loop).
    if (
      obs.ptyOutputGeneration !== this.episode.lastPtyGen
      || obs.screenRevision !== this.episode.lastScreenRev
    ) {
      this.episode.lastPtyGen = obs.ptyOutputGeneration;
      this.episode.lastScreenRev = obs.screenRevision;
      this.episode.lastQuietResetAtMs = obs.nowMs;
    }
    if (obs.idleSettleInFlight) {
      return 'wait';
    }
    const effectiveObs = {
      ...obs,
      userStopRequested: obs.userStopRequested || this.episode.userStopRequested,
    };
    const { bounds } = boundsForClaudeOpenTurn(effectiveObs, this.config);
    const quietElapsed = obs.nowMs - this.episode.lastQuietResetAtMs;
    const noProgressElapsed = obs.nowMs - this.episode.noProgressSinceMs;
    if (quietElapsed >= bounds.quietMs || noProgressElapsed >= bounds.maxNoProgressMs) {
      return 'release-timeout';
    }
    return 'wait';
  }

  /** Clear all state (turn closed, generation rotated, CLI exited, or released). */
  reset(): void {
    this.phase = 'idle';
    this.episode = null;
    this.awaitingMarkerTurnKey = undefined;
    this.awaitingMarkerEvidenceSource = undefined;
    this.stoppedTurnKey = undefined;
  }
}
