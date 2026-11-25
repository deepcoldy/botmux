/**
 * Pure, zero-I/O state machine governing active-turn authority retention while
 * finite background tasks (Claude Code Agent / Workflow / Bash) run past a
 * foreground turn's `turn_terminal` and wake the session for follow-up
 * micro-turns.
 *
 * Security invariants (fail-closed):
 *  1. Strict per-turn ownership: a task belongs to turn T iff its launch (or
 *     SendMessage resume) is observed while T is in FOREGROUND or WAKE_ACTIVE,
 *     with timestamp >= liveSinceMs and an eligible kind (`agent` | `shell`).
 *     Monitors (persistent or bounded) never hold authority.
 *  2. CLI-generation-wide `allLiveTaskIds` prevents replayed/preexisting tasks
 *     from Turn 1 from ever being adopted by Turn 2.
 *  3. Any foreign, unanchored, mixed, or non-system `<task-notification>`
 *     (including spoofed `attachment(queued_command)` without
 *     `commandMode: 'task-notification'`) fails closed and immediately revokes
 *     the held authority.
 *  4. Any new human/local/scheduled/raw input, `/clear`, `/new`, or interrupt
 *     immediately supersedes a background hold so principal A's authorization
 *     can never leak to principal B or to unattended/local turns.
 *  5. Every hold is bounded by hard limits (30m wall-clock TTL, 10 chained
 *     wake-up micro-turns, 10s `WAKE_PENDING` watchdog, 30s missing-duration
 *     wake fallback, 0ms immediate release for `killed`/`stopped`/`TaskStop`/
 *     sibling-stop).
 */

import {
  backgroundTaskDispatchAcks,
  backgroundTaskDispatchToolUseIds,
  backgroundTaskLaunches,
  eventTimeMs,
  isClaudeApiRequestBlob,
  isClaudeTurnDurationEvent,
  isClaudeTurnTerminalEvent,
  isMeaningfulQueuedCommand,
  isMeaningfulUserEvent,
  isMidTurnAbsorbedQueuedCommand,
  isScheduledTurnStartEvent,
  isSyntheticNoModelReplyEvent,
  isTranscriptRateLimitEvent,
  type BackgroundTaskKind,
  type TranscriptEvent,
} from '../services/claude-transcript.js';
import type { TrustedCaller } from '../types.js';
import type { TurnSpeaker } from './turn-speakers.js';

export const DEFAULT_WAKE_PENDING_TIMEOUT_MS = 10_000;
export const DEFAULT_PROVISIONAL_WAKE_END_TIMEOUT_MS = 2_000;
export const DEFAULT_MISSING_DURATION_WAKE_TIMEOUT_MS = 30_000;
export const DEFAULT_BACKGROUND_AUTHORITY_MAX_HOLD_MS = 30 * 60 * 1000;
export const DEFAULT_BACKGROUND_AUTHORITY_MAX_WAKES = 10;

export type BackgroundAuthorityPhase =
  | 'IDLE'
  | 'FOREGROUND'
  | 'HELD_WAITING_BG'
  | 'WAKE_PENDING'
  | 'WAKE_ACTIVE';

export interface HeldTurnIdentity {
  readonly turnId: string;
  readonly dispatchAttempt?: number;
}

export interface OwnedBackgroundTask {
  readonly taskId: string;
  readonly kind: 'agent' | 'shell';
  sinceMs?: number;
}

export type BackgroundAuthorityRevokeReason =
  | 'all_tasks_settled'
  | 'wake_turn_completed'
  | 'wake_turn_failed'
  | 'wake_turn_rate_limited'
  | 'wake_turn_interrupted'
  | 'wake_depth_exceeded'
  | 'wake_pending_timeout'
  | 'wake_pending_removed'
  | 'hold_ttl_exceeded'
  | 'foreign_task_notification'
  | 'queued_type_ahead_pending'
  | 'superseded_by_message'
  | 'superseded_by_raw_input'
  | 'superseded_by_local_turn'
  | 'superseded_by_scheduled'
  | 'superseded_by_clear'
  | 'superseded_by_interrupt'
  | 'foreground_turn_failed'
  | 'cli_reset';

export type BackgroundAuthorityTransition =
  | { readonly action: 'none' }
  | { readonly action: 'revoke'; readonly turn: HeldTurnIdentity; readonly reason: BackgroundAuthorityRevokeReason }
  | { readonly action: 'entered_idle_hold'; readonly turn: HeldTurnIdentity }
  | { readonly action: 'entered_wake_active'; readonly turn: HeldTurnIdentity };

export interface BackgroundTurnAuthorityOptions {
  /** Bounded watchdog for `WAKE_PENDING` (enqueue without dequeue/user). Default 10_000 ms. */
  wakePendingTimeoutMs?: number;
  /** Provisional wake-end bound for legacy marker-less Claude builds. Default 2_000 ms. */
  provisionalWakeEndTimeoutMs?: number;
  /** Bounded fallback if a modern build emits `end_turn` without `system/turn_duration`. Default 30_000 ms. */
  missingDurationMarkerWakeTimeoutMs?: number;
  /** Hard wall-clock TTL for any background authority hold. Default 30 min. */
  maxHoldDurationMs?: number;
  /** Hard cap on chained wake-up micro-turns per foreground turn. Default 10. */
  maxWakeCount?: number;
}

/** Finite completion tasks only. Monitors (persistent OR bounded) are excluded:
 *  they watch external streams and emit repeated status-less notifications. */
export function isAuthorityHoldEligibleTask(kind: BackgroundTaskKind): kind is 'agent' | 'shell' {
  return kind === 'agent' || kind === 'shell';
}

export interface AuthorityHoldTurnEligibilityInput {
  turnId?: string;
  identityTurnId?: string;
  dispatchAttempt?: number;
  adoptMode?: boolean;
  caller?: TrustedCaller;
  speakers?: readonly TurnSpeaker[];
  provenanceIncomplete?: true;
}

/** Strict fail-closed allowlist of single-human interactive IM turns eligible
 *  to hold authority across foreground `turn_terminal` while owned tasks run.
 *  Excludes `adoptMode`, durable delivery (`dispatchAttempt !== undefined`),
 *  cross-principal adopted or mixed-speaker envelopes, incomplete provenance,
 *  bot-sent / callerless / scheduled / trigger / local / maintenance turns. */
export function isAuthorityHoldEligibleTurn(input: AuthorityHoldTurnEligibilityInput): boolean {
  if (input.adoptMode === true) return false;
  if (input.dispatchAttempt !== undefined) return false;
  if (input.provenanceIncomplete === true) return false;
  const turnId = input.turnId;
  if (!turnId) return false;
  if (input.identityTurnId && input.identityTurnId !== turnId) return false;
  if (!(turnId.startsWith('om_') || turnId.startsWith('join_') || turnId.startsWith('cct_'))) return false;
  const caller = input.caller;
  if (!caller || caller.senderType !== 'user') return false;
  if (caller.source !== undefined) return false;
  if (!caller.requestUserOpenId) return false;
  if (input.speakers && input.speakers.length > 0) {
    const distinct = new Set<string>();
    for (const s of input.speakers) {
      if (s.openId !== caller.requestUserOpenId) return false;
      distinct.add(s.openId);
    }
    if (distinct.size > 1) return false;
  }
  return true;
}

/** Release reasons that are deferred while `BackgroundTurnAuthorityHold.holds()`
 *  is true for the exact active turn. Explicit `background_hold:*` revocations,
 *  resets, and teardown releases never match and always execute immediately. */
export function isDeferrableAuthorityReleaseReason(reason: string): boolean {
  return reason === 'turn_terminal'
    || reason === 'prompt_ready'
    || reason === 'structured_turn_retired';
}

export class BackgroundTurnAuthorityHold {
  private readonly wakePendingTimeoutMs: number;
  private readonly provisionalWakeEndTimeoutMs: number;
  private readonly missingDurationMarkerWakeTimeoutMs: number;
  private readonly maxHoldDurationMs: number;
  private readonly maxWakeCount: number;

  private currentPhase: BackgroundAuthorityPhase = 'IDLE';
  private currentOwner: HeldTurnIdentity | undefined;
  private readonly ownedLiveTasks = new Map<string, OwnedBackgroundTask>();
  private readonly allOwnedTaskIds = new Set<string>();
  private readonly pendingWakeTaskIds = new Set<string>();

  /** CLI-generation-wide live and settled tables, cleared only on `reset()`. */
  private readonly allLiveTaskIds = new Map<string, { sinceMs?: number }>();
  private readonly allSettledTaskIds = new Map<string, number | undefined>();

  private liveSinceMs = 0;
  private durationMarkerSeen = false;
  private foregroundProvisionalEndObserved = false;
  private holdStartedAtMs: number | undefined;
  private wakePendingSinceMs: number | undefined;
  private wakeAwaitingDurationMarkerAtMs: number | undefined;
  private wakeCount = 0;

  constructor(opts: BackgroundTurnAuthorityOptions = {}) {
    this.wakePendingTimeoutMs = opts.wakePendingTimeoutMs ?? DEFAULT_WAKE_PENDING_TIMEOUT_MS;
    this.provisionalWakeEndTimeoutMs = opts.provisionalWakeEndTimeoutMs ?? DEFAULT_PROVISIONAL_WAKE_END_TIMEOUT_MS;
    this.missingDurationMarkerWakeTimeoutMs = opts.missingDurationMarkerWakeTimeoutMs ?? DEFAULT_MISSING_DURATION_WAKE_TIMEOUT_MS;
    this.maxHoldDurationMs = opts.maxHoldDurationMs ?? DEFAULT_BACKGROUND_AUTHORITY_MAX_HOLD_MS;
    this.maxWakeCount = opts.maxWakeCount ?? DEFAULT_BACKGROUND_AUTHORITY_MAX_WAKES;
  }

  phase(): BackgroundAuthorityPhase {
    return this.currentPhase;
  }

  owner(): HeldTurnIdentity | undefined {
    return this.currentOwner ? { ...this.currentOwner } : undefined;
  }

  liveFloorMs(): number {
    return this.liveSinceMs;
  }

  /** Pure check (no state mutation). True when a deferrable authority release
   *  (`turn_terminal` / `prompt_ready` / `structured_turn_retired` / `stale_terminal`)
   *  must KEEP this exact turn's authority alive. */
  holds(turnId: string | undefined, dispatchAttempt?: number, nowMs = Date.now()): boolean {
    if (!this.matchesOwner(turnId, dispatchAttempt)) return false;
    if (this.currentPhase === 'IDLE') return false;
    if (this.currentPhase === 'FOREGROUND') return this.hasOwnedWork();
    if (this.holdStartedAtMs !== undefined && nowMs - this.holdStartedAtMs >= this.maxHoldDurationMs) {
      return false;
    }
    return true;
  }

  /** True iff foreground has ended and authority is only a revocable background lease. */
  isBackgroundHeld(): boolean {
    return this.currentPhase === 'HELD_WAITING_BG'
      || this.currentPhase === 'WAKE_PENDING'
      || this.currentPhase === 'WAKE_ACTIVE';
  }

  /** True iff CLI is idle between foreground and wake turns (safe to supersede). */
  isIdleWaiting(): boolean {
    return this.currentPhase === 'HELD_WAITING_BG' || this.currentPhase === 'WAKE_PENDING';
  }

  /** True iff a wake-up micro-turn is actively executing under the held authority. */
  isWakeActive(): boolean {
    return this.currentPhase === 'WAKE_ACTIVE';
  }

  /** True iff the current owner has any live owned task or unconsumed wake notice. */
  hasOwnedWork(): boolean {
    return this.ownedLiveTasks.size > 0 || this.pendingWakeTaskIds.size > 0;
  }

  /** Earliest active timer deadline in epoch ms, or `undefined` when no timer is needed. */
  nextDeadlineMs(): number | undefined {
    if (!this.isBackgroundHeld()) return undefined;
    let earliest: number | undefined;
    const consider = (ts: number | undefined): void => {
      if (ts === undefined) return;
      if (earliest === undefined || ts < earliest) earliest = ts;
    };
    if (this.holdStartedAtMs !== undefined) {
      consider(this.holdStartedAtMs + this.maxHoldDurationMs);
    }
    if (this.currentPhase === 'WAKE_PENDING' && this.wakePendingSinceMs !== undefined) {
      consider(this.wakePendingSinceMs + this.wakePendingTimeoutMs);
    }
    if (this.currentPhase === 'WAKE_ACTIVE' && this.wakeAwaitingDurationMarkerAtMs !== undefined) {
      const bound = this.durationMarkerSeen
        ? this.missingDurationMarkerWakeTimeoutMs
        : this.provisionalWakeEndTimeoutMs;
      consider(this.wakeAwaitingDurationMarkerAtMs + bound);
    }
    return earliest;
  }

  noteDurationMarkerObserved(): void {
    this.durationMarkerSeen = true;
  }

  resetDurationMarkerObserved(): void {
    this.durationMarkerSeen = false;
  }

  isDurationMarkerObserved(): boolean {
    return this.durationMarkerSeen;
  }

  isForegroundProvisionalEndObserved(): boolean {
    return this.foregroundProvisionalEndObserved;
  }

  /** Mark pre-existing live tasks on worker re-attach or transcript rotation so
   *  subsequent turns can never adopt them into `ownedLiveTasks`. */
  seedPreexistingLiveTasks(taskIds: Iterable<string>): void {
    for (const taskId of taskIds) {
      if (taskId && !this.allLiveTaskIds.has(taskId)) {
        this.allLiveTaskIds.set(taskId, {});
      }
    }
  }

  /** Record a historical settlement read during transcript rotation before
   *  `cutoffMs` so an already-stopped task does not stay stuck in
   *  `allLiveTaskIds` and block a later `SendMessage` resume from being owned. */
  recordHistoricalSettlement(taskId: string, atMs?: number): void {
    if (!taskId) return;
    this.recordGlobalSettlement(taskId, atMs);
  }

  onForegroundTurnStarted(input: AuthorityHoldTurnEligibilityInput): BackgroundAuthorityTransition {
    const eligible = isAuthorityHoldEligibleTurn(input);
    if (this.currentPhase === 'FOREGROUND' && this.matchesOwner(input.turnId, input.dispatchAttempt)) {
      if (!eligible) {
        this.clearTurnState();
      }
      return { action: 'none' };
    }
    const priorHeld = this.isBackgroundHeld() ? this.currentOwner : undefined;
    this.clearTurnState();
    if (eligible && input.turnId) {
      this.currentPhase = 'FOREGROUND';
      this.currentOwner = {
        turnId: input.turnId,
        ...(input.dispatchAttempt !== undefined ? { dispatchAttempt: input.dispatchAttempt } : {}),
      };
    }
    return priorHeld
      ? { action: 'revoke', turn: priorHeld, reason: 'superseded_by_message' }
      : { action: 'none' };
  }

  onTaskLaunched(
    launch: { taskId: string; kind: BackgroundTaskKind; atMs?: number; resumed?: boolean },
    _nowMs = Date.now(),
  ): BackgroundAuthorityTransition {
    if (!launch.taskId) return { action: 'none' };
    if (launch.atMs !== undefined && launch.atMs < this.liveSinceMs) return { action: 'none' };

    const existingLive = this.allLiveTaskIds.get(launch.taskId);
    if (existingLive) {
      if (launch.resumed && launch.atMs !== undefined
        && (existingLive.sinceMs === undefined || launch.atMs > existingLive.sinceMs)) {
        existingLive.sinceMs = launch.atMs;
        const owned = this.ownedLiveTasks.get(launch.taskId);
        if (owned) owned.sinceMs = launch.atMs;
      }
      return { action: 'none' };
    }

    if (this.allSettledTaskIds.has(launch.taskId)) {
      const stoppedAtMs = this.allSettledTaskIds.get(launch.taskId);
      if (!launch.resumed || launch.atMs === undefined || stoppedAtMs === undefined || launch.atMs <= stoppedAtMs) {
        return { action: 'none' };
      }
      this.allSettledTaskIds.delete(launch.taskId);
    }

    this.allLiveTaskIds.set(launch.taskId, {
      ...(launch.atMs !== undefined ? { sinceMs: launch.atMs } : {}),
    });

    if ((this.currentPhase === 'FOREGROUND' || this.currentPhase === 'WAKE_ACTIVE')
      && this.currentOwner
      && isAuthorityHoldEligibleTask(launch.kind)) {
      this.ownedLiveTasks.set(launch.taskId, {
        taskId: launch.taskId,
        kind: launch.kind,
        ...(launch.atMs !== undefined ? { sinceMs: launch.atMs } : {}),
      });
      this.allOwnedTaskIds.add(launch.taskId);
    }
    return { action: 'none' };
  }

  onTaskSettled(
    taskId: string,
    opts: { wakes: boolean; atMs?: number },
    nowMs = Date.now(),
  ): BackgroundAuthorityTransition {
    if (!taskId) return { action: 'none' };
    const stale = this.recordGlobalSettlement(taskId, opts.atMs);
    if (stale) return { action: 'none' };

    const wasOwnedLive = this.ownedLiveTasks.delete(taskId);
    const isOwned = wasOwnedLive || this.allOwnedTaskIds.has(taskId);

    if (isOwned && opts.wakes) {
      this.pendingWakeTaskIds.add(taskId);
    } else if (isOwned && !opts.wakes) {
      this.pendingWakeTaskIds.delete(taskId);
    }

    if (this.currentPhase === 'HELD_WAITING_BG') {
      if (this.ownedLiveTasks.size === 0) {
        if (this.pendingWakeTaskIds.size > 0) {
          this.currentPhase = 'WAKE_PENDING';
          this.wakePendingSinceMs = nowMs;
          return { action: 'none' };
        }
        return this.revokeHeld('all_tasks_settled');
      }
    } else if (this.currentPhase === 'WAKE_PENDING') {
      if (this.ownedLiveTasks.size === 0 && this.pendingWakeTaskIds.size === 0) {
        return this.revokeHeld('all_tasks_settled');
      }
    }
    return { action: 'none' };
  }

  onPendingWakeRemoved(taskIds: readonly string[], _nowMs = Date.now()): BackgroundAuthorityTransition {
    for (const id of taskIds) this.pendingWakeTaskIds.delete(id);
    if (this.currentPhase !== 'WAKE_PENDING') return { action: 'none' };
    if (this.pendingWakeTaskIds.size > 0) return { action: 'none' };
    if (this.ownedLiveTasks.size > 0 && this.currentOwner) {
      this.currentPhase = 'HELD_WAITING_BG';
      this.wakePendingSinceMs = undefined;
      return { action: 'entered_idle_hold', turn: { ...this.currentOwner } };
    }
    return this.revokeHeld('wake_pending_removed');
  }

  onWakeDelivered(
    input: {
      taskIds: readonly string[];
      opensTurn: boolean;
      terminalStatus: boolean;
      verifiedSystemWake: boolean;
      atMs?: number;
    },
    nowMs = Date.now(),
  ): BackgroundAuthorityTransition {
    if (input.terminalStatus && input.verifiedSystemWake) {
      for (const id of input.taskIds) {
        const stale = this.recordGlobalSettlement(id, input.atMs);
        if (!stale) this.ownedLiveTasks.delete(id);
      }
    }

    if (this.currentPhase === 'FOREGROUND') {
      if (input.opensTurn && !input.verifiedSystemWake && !this.durationMarkerSeen && this.foregroundProvisionalEndObserved) {
        this.clearTurnState();
        return { action: 'none' };
      }
      if (input.verifiedSystemWake) {
        for (const id of input.taskIds) this.pendingWakeTaskIds.delete(id);
      }
      return { action: 'none' };
    }

    if (!this.isBackgroundHeld() || !this.currentOwner) {
      return { action: 'none' };
    }

    // Fail closed if the notification is unverified, has no task IDs, or names
    // ANY task not owned by the currently-held foreground turn.
    const allOwned = input.taskIds.length > 0
      && input.taskIds.every(id => this.allOwnedTaskIds.has(id));
    if (!input.verifiedSystemWake || !allOwned) {
      return this.revokeHeld('foreign_task_notification');
    }

    for (const id of input.taskIds) this.pendingWakeTaskIds.delete(id);

    if (this.currentPhase === 'HELD_WAITING_BG' || this.currentPhase === 'WAKE_PENDING') {
      if (!input.opensTurn) {
        // Absorbed notice while idle — unexpected; fail closed if no work left.
        if (this.ownedLiveTasks.size === 0 && this.pendingWakeTaskIds.size === 0) {
          return this.revokeHeld('all_tasks_settled');
        }
        return { action: 'none' };
      }
      if (this.holdStartedAtMs !== undefined && nowMs - this.holdStartedAtMs >= this.maxHoldDurationMs) {
        return this.revokeHeld('hold_ttl_exceeded');
      }
      this.currentPhase = 'WAKE_ACTIVE';
      this.wakeCount++;
      this.wakePendingSinceMs = undefined;
      this.wakeAwaitingDurationMarkerAtMs = undefined;
      return { action: 'entered_wake_active', turn: { ...this.currentOwner } };
    }

    // Already WAKE_ACTIVE: same-turn absorbed notice or back-to-back delivered notice.
    this.wakeAwaitingDurationMarkerAtMs = undefined;
    return { action: 'none' };
  }

  onForegroundProvisionalEnd(): void {
    if (this.currentPhase === 'FOREGROUND') {
      this.foregroundProvisionalEndObserved = true;
    }
  }

  onForegroundTurnEnded(nowMs = Date.now()): BackgroundAuthorityTransition {
    if (this.currentPhase !== 'FOREGROUND' || !this.currentOwner) {
      return { action: 'none' };
    }
    if (this.ownedLiveTasks.size > 0) {
      this.currentPhase = 'HELD_WAITING_BG';
      this.holdStartedAtMs = nowMs;
      this.wakePendingSinceMs = undefined;
      this.wakeAwaitingDurationMarkerAtMs = undefined;
      return { action: 'entered_idle_hold', turn: { ...this.currentOwner } };
    }
    if (this.pendingWakeTaskIds.size > 0) {
      this.currentPhase = 'WAKE_PENDING';
      this.holdStartedAtMs = nowMs;
      this.wakePendingSinceMs = nowMs;
      this.wakeAwaitingDurationMarkerAtMs = undefined;
      return { action: 'entered_idle_hold', turn: { ...this.currentOwner } };
    }
    this.clearTurnState();
    return { action: 'none' };
  }

  /** Evaluated inside `emitTurnTerminal` before constructing the wire frame.
   *  Returns `true` iff `{ turnId, dispatchAttempt }` owns an active background
   *  hold that must remain alive past this foreground terminal. */
  onForegroundTurnTerminal(
    input: {
      turnId: string;
      dispatchAttempt?: number;
      status: 'completed' | 'failed' | 'cancelled' | 'ambiguous';
      hasQueuedTypeAhead?: boolean;
    },
    nowMs = Date.now(),
  ): boolean {
    if (!this.matchesOwner(input.turnId, input.dispatchAttempt)) return false;
    if (input.status !== 'completed' || input.hasQueuedTypeAhead === true) {
      this.clearTurnState();
      return false;
    }
    if (this.currentPhase === 'FOREGROUND') {
      this.onForegroundTurnEnded(nowMs);
    }
    if (!this.isBackgroundHeld()) return false;
    if (this.holdStartedAtMs !== undefined && nowMs - this.holdStartedAtMs >= this.maxHoldDurationMs) {
      this.clearTurnState();
      return false;
    }
    return true;
  }

  onWakeTurnProvisionalEnd(nowMs = Date.now()): BackgroundAuthorityTransition {
    if (this.currentPhase === 'WAKE_ACTIVE') {
      this.wakeAwaitingDurationMarkerAtMs = nowMs;
    }
    return { action: 'none' };
  }

  /** Clear provisional wake-end timer when a wake micro-turn continues with tool calls. */
  onWakeTurnActivity(): void {
    if (this.currentPhase === 'WAKE_ACTIVE') {
      this.wakeAwaitingDurationMarkerAtMs = undefined;
    }
  }

  onWakeTurnEnded(
    reason: 'completed' | 'failed' | 'rate_limited' | 'interrupted',
    nowMs = Date.now(),
  ): BackgroundAuthorityTransition {
    if (this.currentPhase !== 'WAKE_ACTIVE' || !this.currentOwner) {
      return { action: 'none' };
    }
    this.wakeAwaitingDurationMarkerAtMs = undefined;

    // An explicit human interrupt during a wake micro-turn always revokes the
    // held authority immediately, even if other background tasks remain live.
    if (reason === 'interrupted') {
      return this.revokeHeld('wake_turn_interrupted');
    }

    const hasMoreWork = this.ownedLiveTasks.size > 0 || this.pendingWakeTaskIds.size > 0;
    if (!hasMoreWork) {
      return this.revokeHeld(`wake_turn_${reason}`);
    }
    if (this.holdStartedAtMs !== undefined && nowMs - this.holdStartedAtMs >= this.maxHoldDurationMs) {
      return this.revokeHeld('hold_ttl_exceeded');
    }
    if (this.wakeCount >= this.maxWakeCount) {
      return this.revokeHeld('wake_depth_exceeded');
    }
    if (this.ownedLiveTasks.size > 0) {
      this.currentPhase = 'HELD_WAITING_BG';
      this.wakePendingSinceMs = undefined;
      return { action: 'entered_idle_hold', turn: { ...this.currentOwner } };
    }
    this.currentPhase = 'WAKE_PENDING';
    this.wakePendingSinceMs = nowMs;
    return { action: 'entered_idle_hold', turn: { ...this.currentOwner } };
  }

  onSuperseded(
    reason:
      | 'superseded_by_message'
      | 'superseded_by_raw_input'
      | 'superseded_by_local_turn'
      | 'superseded_by_scheduled'
      | 'superseded_by_clear'
      | 'superseded_by_interrupt',
  ): BackgroundAuthorityTransition {
    if (this.isBackgroundHeld()) {
      return this.revokeHeld(reason);
    }
    if (this.currentPhase === 'FOREGROUND'
      && (reason === 'superseded_by_clear'
        || reason === 'superseded_by_interrupt'
        || reason === 'superseded_by_scheduled'
        || reason === 'superseded_by_local_turn')) {
      this.clearTurnState();
    }
    return { action: 'none' };
  }

  onPromptReady(nowMs = Date.now()): BackgroundAuthorityTransition {
    const tick = this.onTick(nowMs);
    if (tick.action !== 'none') return tick;
    if (this.currentPhase === 'WAKE_ACTIVE'
      && this.wakeAwaitingDurationMarkerAtMs !== undefined
      && (!this.durationMarkerSeen
        || nowMs - this.wakeAwaitingDurationMarkerAtMs >= this.provisionalWakeEndTimeoutMs)) {
      return this.onWakeTurnEnded('completed', nowMs);
    }
    return { action: 'none' };
  }

  onTick(nowMs = Date.now()): BackgroundAuthorityTransition {
    if (!this.isBackgroundHeld() || !this.currentOwner) return { action: 'none' };
    if (this.holdStartedAtMs !== undefined && nowMs - this.holdStartedAtMs >= this.maxHoldDurationMs) {
      return this.revokeHeld('hold_ttl_exceeded');
    }
    if (this.currentPhase === 'WAKE_PENDING'
      && this.wakePendingSinceMs !== undefined
      && nowMs - this.wakePendingSinceMs >= this.wakePendingTimeoutMs) {
      this.pendingWakeTaskIds.clear();
      this.wakePendingSinceMs = undefined;
      if (this.ownedLiveTasks.size > 0) {
        this.currentPhase = 'HELD_WAITING_BG';
        return { action: 'entered_idle_hold', turn: { ...this.currentOwner } };
      }
      return this.revokeHeld('wake_pending_timeout');
    }
    if (this.currentPhase === 'WAKE_ACTIVE' && this.wakeAwaitingDurationMarkerAtMs !== undefined) {
      const bound = this.durationMarkerSeen
        ? this.missingDurationMarkerWakeTimeoutMs
        : this.provisionalWakeEndTimeoutMs;
      if (nowMs - this.wakeAwaitingDurationMarkerAtMs >= bound) {
        return this.onWakeTurnEnded('completed', nowMs);
      }
    }
    return { action: 'none' };
  }

  /** Clear turn-scoped state if the given released turn is the current owner.
   *  Preserves CLI-generation-wide `allLiveTaskIds` and `allSettledTaskIds`. */
  clearIfOwner(turnId: string | undefined, dispatchAttempt?: number): void {
    if (this.matchesOwner(turnId, dispatchAttempt)) {
      this.clearTurnState();
    }
  }

  /** Full reset for a new CLI process generation. */
  reset(liveSinceMs = 0): void {
    this.clearTurnState();
    this.allLiveTaskIds.clear();
    this.allSettledTaskIds.clear();
    this.liveSinceMs = liveSinceMs;
    this.durationMarkerSeen = false;
  }

  private matchesOwner(turnId: string | undefined, dispatchAttempt?: number): boolean {
    return !!this.currentOwner
      && !!turnId
      && this.currentOwner.turnId === turnId
      && this.currentOwner.dispatchAttempt === dispatchAttempt;
  }

  private recordGlobalSettlement(taskId: string, atMs: number | undefined): boolean {
    const running = this.allLiveTaskIds.get(taskId);
    if (running?.sinceMs !== undefined && atMs !== undefined && atMs < running.sinceMs) {
      const previous = this.allSettledTaskIds.get(taskId);
      this.allSettledTaskIds.set(
        taskId,
        previous !== undefined && previous > atMs ? previous : atMs,
      );
      return true;
    }
    this.allLiveTaskIds.delete(taskId);
    const previous = this.allSettledTaskIds.get(taskId);
    this.allSettledTaskIds.set(
      taskId,
      previous !== undefined && (atMs === undefined || previous > atMs) ? previous : atMs,
    );
    return false;
  }

  private revokeHeld(reason: BackgroundAuthorityRevokeReason): BackgroundAuthorityTransition {
    const turn = this.currentOwner;
    this.clearTurnState();
    return turn ? { action: 'revoke', turn, reason } : { action: 'none' };
  }

  private clearTurnState(): void {
    this.currentPhase = 'IDLE';
    this.currentOwner = undefined;
    this.ownedLiveTasks.clear();
    this.allOwnedTaskIds.clear();
    this.pendingWakeTaskIds.clear();
    this.foregroundProvisionalEndObserved = false;
    this.holdStartedAtMs = undefined;
    this.wakePendingSinceMs = undefined;
    this.wakeAwaitingDurationMarkerAtMs = undefined;
    this.wakeCount = 0;
  }
}

// ─── Transcript Event Helpers (Zero I/O) ────────────────────────────────────

const USER_INTERRUPT_PREFIX = '[Request interrupted by user';

function extractUserTextParts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts;
}

/** Self-contained Claude user-interrupt detector (no dependency on PR #3810). */
export function isClaudeUserInterruptTranscriptEvent(ev: TranscriptEvent | null | undefined): boolean {
  if (!ev || typeof ev !== 'object' || ev.isSidechain === true || isClaudeApiRequestBlob(ev)) return false;
  const role = ev.message?.role ?? ev.type;
  if (role !== 'user') return false;
  if (typeof (ev as { interruptedMessageId?: unknown }).interruptedMessageId === 'string') return true;
  for (const text of extractUserTextParts(ev.message?.content)) {
    if (text.trimStart().startsWith(USER_INTERRUPT_PREFIX)) return true;
  }
  return false;
}

const CLEAR_OR_NEW_COMMAND_RE = /<command-name>\s*\/(?:clear|new)\s*<\/command-name>/;

/** True for Claude Code's in-pane `/clear` or `/new` command records. */
export function isClaudeClearOrNewCommandEvent(ev: TranscriptEvent | null | undefined): boolean {
  if (!ev || typeof ev !== 'object' || ev.isSidechain === true || isClaudeApiRequestBlob(ev)) return false;
  const role = ev.message?.role ?? ev.type;
  if (role !== 'user') return false;
  for (const text of extractUserTextParts(ev.message?.content)) {
    if (CLEAR_OR_NEW_COMMAND_RE.test(text)) return true;
  }
  return false;
}

export interface ParsedTaskNotificationMeta {
  taskIds: string[];
  status?: string;
}

export function extractTaskNotificationMeta(text: string): ParsedTaskNotificationMeta {
  const taskIds = [...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)]
    .map(m => m[1]!.trim())
    .filter(Boolean);
  const statusMatch = /<status>([^<]+)<\/status>/.exec(text);
  const status = statusMatch ? statusMatch[1]!.trim().toLowerCase() : undefined;
  return { taskIds, ...(status ? { status } : {}) };
}

function userRoleTaskNotificationText(ev: TranscriptEvent): string | undefined {
  if (ev.type !== 'user') return undefined;
  const raw = ev.message?.content;
  const text = typeof raw === 'string'
    ? raw
    : Array.isArray(raw)
      ? ((raw.find((b: any) => b && b.type === 'text' && typeof b.text === 'string') as { text?: string } | undefined)?.text ?? '')
      : '';
  return text.trimStart().startsWith('<task-notification>') ? text : undefined;
}

function absorbedAttachmentTaskNotificationText(ev: TranscriptEvent): string | undefined {
  if (ev.type !== 'attachment' || ev.attachment?.type !== 'queued_command') return undefined;
  const prompt = ev.attachment.prompt;
  const text = typeof prompt === 'string'
    ? prompt
    : Array.isArray(prompt)
      ? extractUserTextParts(prompt).join('\n')
      : '';
  return text.trimStart().startsWith('<task-notification>') ? text : undefined;
}

/** Pairs legacy pre-`toolUseResult` `Agent`/`Task` dispatches with their
 *  `agentId:` launch-ack text without mutating `BackgroundTaskTracker`. */
export class LegacyAgentAckPairer {
  private readonly ackByToolUse = new Map<string, string>();
  private readonly awaitingAck = new Set<string>();

  observe(ev: TranscriptEvent): Array<{ taskId: string; kind: 'agent' }> {
    if (!ev || ev.isSidechain === true || isClaudeApiRequestBlob(ev)) return [];
    const launched: Array<{ taskId: string; kind: 'agent' }> = [];
    for (const toolUseId of backgroundTaskDispatchToolUseIds(ev)) {
      const agentId = this.ackByToolUse.get(toolUseId);
      if (agentId) launched.push({ taskId: agentId, kind: 'agent' });
      else this.awaitingAck.add(toolUseId);
    }
    for (const ack of backgroundTaskDispatchAcks(ev)) {
      this.ackByToolUse.set(ack.toolUseId, ack.agentId);
      if (this.awaitingAck.delete(ack.toolUseId)) {
        launched.push({ taskId: ack.agentId, kind: 'agent' });
      }
    }
    return launched;
  }

  reset(): void {
    this.ackByToolUse.clear();
    this.awaitingAck.clear();
  }
}

function pickHigherPriorityTransition(
  current: BackgroundAuthorityTransition,
  next: BackgroundAuthorityTransition,
): BackgroundAuthorityTransition {
  if (next.action === 'revoke') return next;
  if (current.action === 'revoke') return current;
  return next.action !== 'none' ? next : current;
}

/** Feed one Claude transcript event into `BackgroundTurnAuthorityHold` in exact
 *  JSONL order. Pure and side-effect-free beyond the hold & pairer objects. */
export function applyClaudeTranscriptEventToAuthorityHold(
  hold: BackgroundTurnAuthorityHold,
  ev: TranscriptEvent,
  pairer: LegacyAgentAckPairer,
  nowMs = Date.now(),
): BackgroundAuthorityTransition {
  if (!ev || typeof ev !== 'object' || ev.isSidechain === true || isClaudeApiRequestBlob(ev)) {
    return { action: 'none' };
  }

  const atMs = eventTimeMs(ev);

  // 1. Queue operations (`enqueue` settles with wakes=true only for completed/failed;
  //    `remove` drops pending wake; `dequeue` is a no-op).
  if (ev.type === 'queue-operation') {
    const content = typeof ev.content === 'string' ? ev.content : '';
    if (!content.trimStart().startsWith('<task-notification>')) return { action: 'none' };
    const meta = extractTaskNotificationMeta(content);
    if (ev.operation === 'enqueue') {
      if (!meta.status) return { action: 'none' };
      const wakes = meta.status === 'completed' || meta.status === 'failed';
      let result: BackgroundAuthorityTransition = { action: 'none' };
      for (const id of meta.taskIds) {
        result = pickHigherPriorityTransition(result, hold.onTaskSettled(id, { wakes, atMs }, nowMs));
      }
      return result;
    }
    if (ev.operation === 'remove') {
      return hold.onPendingWakeRemoved(meta.taskIds, nowMs);
    }
    return { action: 'none' };
  }

  // 2. Authoritative `system/turn_duration` boundary.
  if (isClaudeTurnDurationEvent(ev)) {
    hold.noteDurationMarkerObserved();
    if (hold.phase() === 'FOREGROUND') return hold.onForegroundTurnEnded(nowMs);
    if (hold.phase() === 'WAKE_ACTIVE') return hold.onWakeTurnEnded('completed', nowMs);
    return { action: 'none' };
  }

  // 3. In-pane `/clear` or `/new`.
  if (isClaudeClearOrNewCommandEvent(ev)) {
    return hold.onSuperseded('superseded_by_clear');
  }

  // 4. User interrupt (checked before `isMeaningfulUserEvent`).
  if (isClaudeUserInterruptTranscriptEvent(ev)) {
    if (hold.phase() === 'WAKE_ACTIVE') return hold.onWakeTurnEnded('interrupted', nowMs);
    if (hold.isBackgroundHeld() || hold.phase() === 'FOREGROUND') {
      return hold.onSuperseded('superseded_by_interrupt');
    }
    return { action: 'none' };
  }

  // 5. Built-in CronCreate scheduled fire.
  if (isScheduledTurnStartEvent(ev)) {
    if (hold.isBackgroundHeld()) return hold.onSuperseded('superseded_by_scheduled');
    if (hold.phase() === 'FOREGROUND' && (hold.hasOwnedWork() || hold.isForegroundProvisionalEndObserved())) {
      return hold.onSuperseded('superseded_by_scheduled');
    }
    return { action: 'none' };
  }

  // 6. Delivered `type: 'user'` `<task-notification>`.
  const deliveredUserNotice = userRoleTaskNotificationText(ev);
  if (deliveredUserNotice !== undefined) {
    const meta = extractTaskNotificationMeta(deliveredUserNotice);
    const verifiedSystemWake = ev.promptSource === 'system'
      && (ev.turnOrigin === undefined || ev.turnOrigin === 'task_notification')
      && atMs !== undefined
      && atMs >= hold.liveFloorMs();
    return hold.onWakeDelivered({
      taskIds: meta.taskIds,
      opensTurn: true,
      terminalStatus: meta.status !== undefined,
      verifiedSystemWake,
      atMs,
    }, nowMs);
  }

  // 7. Absorbed `attachment(queued_command)` `<task-notification>`.
  const absorbedNotice = absorbedAttachmentTaskNotificationText(ev);
  if (absorbedNotice !== undefined) {
    const meta = extractTaskNotificationMeta(absorbedNotice);
    const verifiedSystemWake = ev.attachment?.commandMode === 'task-notification'
      && atMs !== undefined
      && atMs >= hold.liveFloorMs();
    return hold.onWakeDelivered({
      taskIds: meta.taskIds,
      opensTurn: false,
      terminalStatus: meta.status !== undefined,
      verifiedSystemWake,
      atMs,
    }, nowMs);
  }

  // 8. Real user or queued prompt (supersedes held authority; closes marker-less foreground).
  if (isMeaningfulUserEvent(ev) || isMeaningfulQueuedCommand(ev) || isMidTurnAbsorbedQueuedCommand(ev)) {
    if (hold.isBackgroundHeld()) {
      return hold.onSuperseded('superseded_by_local_turn');
    }
    if (hold.phase() === 'FOREGROUND'
      && !hold.isDurationMarkerObserved()
      && hold.isForegroundProvisionalEndObserved()
      && !isMidTurnAbsorbedQueuedCommand(ev)) {
      return hold.onSuperseded('superseded_by_local_turn');
    }
    return { action: 'none' };
  }

  // 9. Background task launches (structured `toolUseResult` + legacy text-ack pairer).
  let transition: BackgroundAuthorityTransition = { action: 'none' };
  for (const launch of backgroundTaskLaunches(ev)) {
    transition = pickHigherPriorityTransition(
      transition,
      hold.onTaskLaunched({
        taskId: launch.taskId,
        kind: launch.kind,
        atMs,
        resumed: launch.resumed,
      }, nowMs),
    );
  }
  for (const legacy of pairer.observe(ev)) {
    transition = pickHigherPriorityTransition(
      transition,
      hold.onTaskLaunched({ taskId: legacy.taskId, kind: legacy.kind, atMs }, nowMs),
    );
  }

  // 10. `TaskStop` (`toolUseResult: { task_id, task_type }`) — settles immediately with wakes=false.
  const role = ev.message?.role ?? ev.type;
  const r = ev.toolUseResult as Record<string, unknown> | undefined;
  if (role === 'user' && r && typeof r === 'object' && !Array.isArray(r)
    && typeof r.task_id === 'string' && r.task_id && typeof r.task_type === 'string') {
    transition = pickHigherPriorityTransition(
      transition,
      hold.onTaskSettled(r.task_id, { wakes: false, atMs }, nowMs),
    );
  }

  // 11. Tool result continuation during WAKE_ACTIVE clears any provisional end timer.
  if (role === 'user' && hold.phase() === 'WAKE_ACTIVE') {
    hold.onWakeTurnActivity();
  }

  // 12. Assistant errors, rate limits, provisional terminals, and tool continuation.
  if (role === 'assistant') {
    if (isTranscriptRateLimitEvent(ev)) {
      if (hold.phase() === 'WAKE_ACTIVE') {
        return pickHigherPriorityTransition(transition, hold.onWakeTurnEnded('rate_limited', nowMs));
      }
      if (hold.phase() === 'FOREGROUND') {
        return pickHigherPriorityTransition(transition, hold.onSuperseded('superseded_by_interrupt'));
      }
      return transition;
    }
    if (ev.isApiErrorMessage === true || isSyntheticNoModelReplyEvent(ev)) {
      if (hold.phase() === 'WAKE_ACTIVE') {
        return pickHigherPriorityTransition(transition, hold.onWakeTurnEnded('failed', nowMs));
      }
      if (hold.phase() === 'FOREGROUND') {
        return pickHigherPriorityTransition(transition, hold.onSuperseded('superseded_by_interrupt'));
      }
      return transition;
    }
    if (isClaudeTurnTerminalEvent(ev)) {
      if (hold.phase() === 'FOREGROUND') hold.onForegroundProvisionalEnd();
      else if (hold.phase() === 'WAKE_ACTIVE') {
        transition = pickHigherPriorityTransition(transition, hold.onWakeTurnProvisionalEnd(nowMs));
      }
    } else if (hold.phase() === 'WAKE_ACTIVE') {
      hold.onWakeTurnActivity();
    }
  }

  return transition;
}
