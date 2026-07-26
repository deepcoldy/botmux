import type { BackendType } from '../adapters/backend/types.js';

/**
 * Codex App turn liveness, driven by the app-server runner's explicit turn
 * activity markers.  This deliberately reports "no observable progress"
 * rather than failure: a long-running tool may recover and emit activity
 * later, at which point the stalled projection clears without replaying work.
 */

export const CODEX_APP_NO_PROGRESS_TIMEOUT_MS = 90_000;

const PERSISTENT_BACKEND_TYPES: ReadonlySet<BackendType> = new Set(['tmux', 'herdr', 'zellij']);

/**
 * Decide whether an existing persistent pane needs a synthetic observation.
 * This deliberately does not depend on pipe mode: Zellij reattaches through
 * its own PTY (`isPipeMode=false`) but preserves the same running CLI.
 */
export function shouldBeginCodexAppReattachObservation(input: {
  cliId?: string;
  backendType: BackendType;
  isReattach: boolean;
}): boolean {
  return input.cliId === 'codex-app'
    && input.isReattach
    && PERSISTENT_BACKEND_TYPES.has(input.backendType);
}

export interface CodexAppLivenessPoll {
  active: boolean;
  stalled: boolean;
  /** True only on the working -> stalled edge. */
  newlyStalled: boolean;
  /** True at most once for one submitted turn, even if it later recovers. */
  shouldNotify: boolean;
  turnId?: string;
}

export interface CodexAppActivityApplyResult {
  accepted: boolean;
  phase?: 'submitted' | 'progress' | 'completed';
  /** A previously rejected inter-turn prompt became authoritative. */
  shouldReplayPrompt?: boolean;
}

export interface CodexAppStateApplyResult {
  accepted: boolean;
  busy?: boolean;
  tracksTurn?: boolean;
  /** Signed idle arrived after the tracker's explicit queue drained. */
  shouldPublishReady?: boolean;
  atMs?: number;
}

/**
 * Signed runner state is the Codex App ready authority. Terminal prompt bytes
 * remain useful as a recovery hint, but PTY/tmux/Herdr/Zellij delivery can be
 * delayed or lost and must never publish idle ahead of the signed final queue.
 */
export class CodexAppReadyAuthority {
  private signedIdle = false;
  private latePromptRecoveryArmed = false;

  reset(): void {
    this.signedIdle = false;
    this.latePromptRecoveryArmed = false;
  }

  beginWork(): void {
    this.signedIdle = false;
    this.latePromptRecoveryArmed = false;
  }

  /** Returns true only for an authenticated runner's idle boundary. */
  noteSignedState(busy: boolean): boolean {
    this.latePromptRecoveryArmed = false;
    this.signedIdle = !busy;
    return this.signedIdle;
  }

  canPublishPromptReady(): boolean {
    return this.signedIdle;
  }

  /** Arm only after the worker cancels the exact local submit slot. */
  armLatePromptRecovery(): void {
    this.signedIdle = false;
    this.latePromptRecoveryArmed = true;
  }

  /**
   * Consume one late terminal prompt after the cancelled slot left no tracked
   * work. New work, authenticated activity/state, or reset clears the arm.
   */
  consumeLatePromptRecovery(trackerEmpty: boolean): boolean {
    if (!trackerEmpty || !this.latePromptRecoveryArmed) return false;
    this.latePromptRecoveryArmed = false;
    return true;
  }
}

/** Apply a state payload from an already authenticated runner connection. */
export function applyTrustedCodexAppStateMarker(
  tracker: CodexAppTurnLiveness,
  authority: CodexAppReadyAuthority,
  payload: unknown,
  receivedAtMs = Date.now(),
): CodexAppStateApplyResult {
  if (!payload || typeof payload !== 'object') return { accepted: false };
  const marker = payload as Record<string, unknown>;
  if (typeof marker.busy !== 'boolean') return { accepted: false };
  const runnerAtMs = typeof marker.atMs === 'number' && Number.isFinite(marker.atMs)
    ? Math.min(marker.atMs, receivedAtMs)
    : receivedAtMs;
  if (marker.busy) {
    authority.noteSignedState(true);
    // Goal auto-continuations are native work but do not own a Botmux dispatch
    // slot. Tracking them as a synthetic user turn would leave an extra slot
    // after a later Lark message steers the same native turn and completes.
    const tracksTurn = marker.tracksTurn !== false;
    if (tracksTurn) tracker.noteSubmitted(runnerAtMs);
    else tracker.discardReattachObservation();
    return { accepted: true, busy: true, tracksTurn, shouldPublishReady: false, atMs: runnerAtMs };
  }
  authority.noteSignedState(false);
  return {
    accepted: true,
    busy: false,
    shouldPublishReady: tracker.notePrompt(runnerAtMs),
    atMs: runnerAtMs,
  };
}

interface ActiveTurn {
  handle: number;
  turnId?: string;
  lastActivityAtMs: number;
  stalled: boolean;
  notified: boolean;
  reattachObservation: boolean;
}

export class CodexAppTurnLiveness {
  private readonly turns: ActiveTurn[] = [];
  private nextHandle = 1;
  private promptDeferred = false;

  constructor(private readonly timeoutMs = CODEX_APP_NO_PROGRESS_TIMEOUT_MS) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Codex App liveness timeout must be a positive finite number');
    }
  }

  /**
   * Queue one Botmux input immediately before its control line is submitted.
   * Codex App's runner is serial, so only the head turn owns activity/stall
   * state; queued turns get a fresh clock when the head completes.
   */
  begin(turnId?: string, nowMs = Date.now()): number {
    // A prompt deferred for an earlier queue has no authority over a new queue.
    if (this.turns.length === 0) this.promptDeferred = false;
    const handle = this.nextHandle++;
    this.turns.push({
      handle,
      turnId,
      lastActivityAtMs: nowMs,
      stalled: false,
      notified: false,
      reattachObservation: false,
    });
    return handle;
  }

  /** Observe an authenticated runner whose in-memory turn state survived reattach. */
  beginReattachObservation(nowMs = Date.now()): number | undefined {
    if (this.turns.length > 0) return undefined;
    const handle = this.nextHandle++;
    this.turns.push({
      handle,
      lastActivityAtMs: nowMs,
      stalled: false,
      notified: false,
      reattachObservation: true,
    });
    return handle;
  }

  /** Drop only the synthetic reconnect slot when signed state identifies work
   * as a native Goal continuation rather than a Botmux-owned turn. */
  discardReattachObservation(): void {
    if (!this.turns[0]?.reattachObservation) return;
    this.turns.shift();
    this.promptDeferred = false;
  }

  /**
   * Record runner/app-server activity. Activity after a stall makes the turn
   * working again, but the same turn will not notify the user a second time.
   */
  noteActivity(nowMs = Date.now()): void {
    const active = this.turns[0];
    if (!active) return;
    // Real work for the head turn supersedes a prompt rendered in the narrow
    // inter-turn gap before its chunked control line finished arriving.
    this.promptDeferred = false;
    // Signed socket records can be buffered behind other process work. Never
    // let an older runner timestamp move the worker's clock backwards.
    active.lastActivityAtMs = Math.max(active.lastActivityAtMs, nowMs);
    active.stalled = false;
  }

  /**
   * A signed submitted record can be the first event after worker reattach.
   * Recover an explicit slot when no local flush state survived the restart.
   */
  noteSubmitted(nowMs = Date.now()): void {
    if (this.turns.length === 0) this.begin(undefined, nowMs);
    else if (this.turns[0].reattachObservation) this.turns[0].reattachObservation = false;
    this.noteActivity(nowMs);
  }

  /** Complete only the runner's current turn and activate the next queued one. */
  completeCurrent(nowMs = Date.now()): boolean {
    if (this.turns.length === 0) return false;
    this.turns.shift();
    const next = this.turns[0];
    if (!next) return this.consumeDeferredPrompt();
    // Time spent waiting behind the previous turn is not lack of progress for
    // this turn. Its own timeout begins when it becomes runner-current.
    next.lastActivityAtMs = Math.max(next.lastActivityAtMs, nowMs);
    next.stalled = false;
    return false;
  }

  /** Remove the exact control-line submission that failed, preserving peers. */
  cancelExact(handle: number, nowMs = Date.now()): {
    cancelled: boolean;
    shouldReplayPrompt: boolean;
  } {
    const index = this.turns.findIndex(turn => turn.handle === handle);
    if (index < 0) return { cancelled: false, shouldReplayPrompt: false };
    const wasCurrent = index === 0;
    this.turns.splice(index, 1);
    if (wasCurrent && this.turns[0]) {
      this.turns[0].lastActivityAtMs = Math.max(this.turns[0].lastActivityAtMs, nowMs);
      this.turns[0].stalled = false;
    }
    return { cancelled: true, shouldReplayPrompt: this.consumeDeferredPrompt() };
  }

  /** Backwards-compatible shorthand for callers that only need replay state. */
  cancel(handle: number, nowMs = Date.now()): boolean {
    return this.cancelExact(handle, nowMs).shouldReplayPrompt;
  }

  /**
   * A prompt is authoritative only for the synthetic reattach observation.
   * Returns whether no explicit/queued turn remains, so the worker can reject
   * a transient inter-turn prompt instead of publishing prompt_ready / idle.
   */
  notePrompt(nowMs = Date.now()): boolean {
    if (this.turns[0]?.reattachObservation) this.completeCurrent(nowMs);
    if (this.turns.length === 0) {
      this.promptDeferred = false;
      return true;
    }
    this.promptDeferred = true;
    return false;
  }

  hasActiveTurn(): boolean {
    return this.turns.length > 0;
  }

  /** Drop every queued turn on CLI exit, kill, or worker reinitialization. */
  clear(): void {
    this.turns.length = 0;
    this.promptDeferred = false;
  }

  poll(nowMs = Date.now()): CodexAppLivenessPoll {
    const active = this.turns[0];
    if (!active) return { active: false, stalled: false, newlyStalled: false, shouldNotify: false };

    const timedOut = nowMs - active.lastActivityAtMs >= this.timeoutMs;
    const newlyStalled = timedOut && !active.stalled;
    if (newlyStalled) active.stalled = true;

    const shouldNotify = newlyStalled && !active.notified;
    if (shouldNotify) active.notified = true;

    return {
      active: true,
      stalled: active.stalled,
      newlyStalled,
      shouldNotify,
      turnId: active.turnId,
    };
  }

  private consumeDeferredPrompt(): boolean {
    if (this.turns.length > 0 || !this.promptDeferred) return false;
    this.promptDeferred = false;
    return true;
  }
}

/**
 * One flush may cancel a queued liveness slot because writeInput throws or
 * it returns submitted=false. Preserve the deferred real prompt across that
 * async boundary, but replay it only after every peer slot has drained.
 */
export class CodexAppFlushPromptReplay {
  private replayRequested = false;

  cancelSubmission(
    tracker: CodexAppTurnLiveness,
    authority: CodexAppReadyAuthority,
    handle: number | undefined,
    nowMs = Date.now(),
  ): void {
    if (handle === undefined) return;
    const cancelled = tracker.cancelExact(handle, nowMs);
    if (!cancelled.cancelled) return;
    authority.armLatePromptRecovery();
    if (cancelled.shouldReplayPrompt) this.replayRequested = true;
  }

  consumeAfterFlush(tracker: CodexAppTurnLiveness): boolean {
    const shouldReplay = this.replayRequested && !tracker.hasActiveTurn();
    this.replayRequested = false;
    return shouldReplay;
  }
}

/** Apply an activity payload whose signed socket connection was authenticated. */
export function applyTrustedCodexAppActivityMarker(
  tracker: CodexAppTurnLiveness,
  payload: unknown,
  receivedAtMs = Date.now(),
): CodexAppActivityApplyResult {
  if (!payload || typeof payload !== 'object') return { accepted: false };
  const marker = payload as Record<string, unknown>;
  const phase = marker.phase;
  if (phase !== 'submitted' && phase !== 'progress' && phase !== 'completed') {
    return { accepted: false };
  }
  const runnerAtMs = typeof marker.atMs === 'number' && Number.isFinite(marker.atMs)
    ? marker.atMs
    : receivedAtMs;
  // Runner and worker share one host clock. A marker may arrive late, but it
  // may never push the activity clock into the future and suppress stalls.
  const atMs = Math.min(runnerAtMs, receivedAtMs);
  if (phase === 'completed') {
    return {
      accepted: true,
      phase,
      shouldReplayPrompt: tracker.completeCurrent(atMs),
    };
  }
  if (phase === 'submitted') tracker.noteSubmitted(atMs);
  else tracker.noteActivity(atMs);
  return { accepted: true, phase };
}
