/**
 * Pure, zero-I/O state tracker for TRAE native continuations (e.g. background
 * subagent callbacks that wake the main agent after a prior turn's terminal
 * with no new Botmux user input).
 *
 * Distinguishes two states that both have `!isPromptReady`, no
 * `ActiveTurnAuthority`, and an empty `queuedTypeAheadTurns` queue:
 *   1. Post-terminal composer-recovery window — the previous turn just ended
 *      and the PTY composer has not been re-observed yet (`isActive() === false`).
 *      Pending independent turns must still hold for the idle/composer edge so
 *      they are not mis-attributed and do not bypass `reselectPerTurn`,
 *      `preflightLoadCheck`, or quota selection.
 *   2. Active native continuation — TRAE is demonstrably executing a native
 *      wakeup turn (`isActive() === true`), proven by either:
 *        - a live rollout `task_started` whose `root_turn_id` points to a prior
 *          root turn (or an unowned root `task_started` with no Botmux turn or
 *          write in flight) that has not yet received `task_complete` /
 *          `turn_aborted`; or
 *        - a fresh OSC 7501 `working` transition that arrived while the CLI was
 *          already confirmed prompt-ready (`wasPromptReady === true`) with no
 *          Botmux turn or operation in flight, and while `IdleDetector` still
 *          actively holds `working`.
 */

const MAX_ACTIVE_TRANSCRIPT_CONTINUATIONS = 64;

export interface TraexNativeTurnLifecycleEvent {
  readonly kind: 'started' | 'ended';
  readonly turnId: string;
  readonly rootTurnId?: string;
}

export interface TraexNativeContinuationTranscriptContext {
  /** Native turn ids already owned by a turn in `codexBridgeQueue`. */
  readonly ownedNativeTurnIds?: ReadonlySet<string>;
  /** Whether `codexBridgeQueue` has any open (non-terminal) Botmux turn. */
  readonly hasOpenBotmuxTurn?: boolean;
  /** Whether a Botmux-initiated flush or PTY submission is currently in flight. */
  readonly botmuxWriteInFlight?: boolean;
}

export interface TraexNativeContinuationProgramStatusInput {
  readonly state: string;
  /** Prompt readiness immediately BEFORE `IdleDetector.observeProgramStatus()` handled this event. */
  readonly wasPromptReady: boolean;
  /** Whether `IdleDetector` holds `working` AFTER observing this event. */
  readonly programStatusHeldWorking: boolean;
  /** Whether a Botmux turn already owns the CLI (`activeTurnAuthority` or `queuedTypeAheadTurns`). */
  readonly hasBotmuxTurnOwner: boolean;
  /** Whether startup or a Botmux-owned write/command/rename/restart is in flight. */
  readonly botmuxOperationInFlight: boolean;
}

export interface TraexNativeContinuationObservation {
  /** True iff `isActive()` transitioned from `false` to `true` on this update. */
  readonly becameActive: boolean;
  /** True iff at least one tracked transcript continuation closed on this update. */
  readonly closedTranscriptContinuation: boolean;
}

export class TraexNativeContinuationTracker {
  /** Open native continuation `turnId -> rootTurnId` observed in live rollout drains. */
  private readonly activeTranscriptTurns = new Map<string, string | undefined>();
  /** Post-idle OSC 7501 `working` latch (never armed from a `!wasPromptReady` post-terminal window). */
  private programStatusNativeWorking = false;

  observeTranscriptLifecycle(
    events: readonly TraexNativeTurnLifecycleEvent[],
    ctx: TraexNativeContinuationTranscriptContext = {},
    programStatusHeldWorking = false,
  ): TraexNativeContinuationObservation {
    const wasActive = this.isActive(programStatusHeldWorking);
    let closedTranscriptContinuation = false;

    for (const ev of events) {
      if (!ev.turnId) continue;
      if (ev.kind === 'started') {
        const isNestedContinuation = !!ev.rootTurnId && ev.rootTurnId !== ev.turnId;
        const isUnownedRootTurn = !isNestedContinuation
          && !ctx.ownedNativeTurnIds?.has(ev.turnId)
          && !ctx.hasOpenBotmuxTurn
          && !ctx.botmuxWriteInFlight;
        if (isNestedContinuation || isUnownedRootTurn) {
          this.activeTranscriptTurns.delete(ev.turnId);
          this.activeTranscriptTurns.set(ev.turnId, ev.rootTurnId);
          while (this.activeTranscriptTurns.size > MAX_ACTIVE_TRANSCRIPT_CONTINUATIONS) {
            const oldest = this.activeTranscriptTurns.keys().next().value;
            if (oldest === undefined) break;
            this.activeTranscriptTurns.delete(oldest);
          }
        }
      } else {
        if (this.activeTranscriptTurns.delete(ev.turnId)) {
          closedTranscriptContinuation = true;
        }
        // Any nested turn that began *before* its parent root turn closed does
        // not outlive that root turn's terminal. A subagent wakeup whose
        // `task_started` arrives *after* the root turn's `task_complete` runs
        // later in the sequence and stays tracked until its own terminal.
        for (const [openTurnId, openRootTurnId] of [...this.activeTranscriptTurns.entries()]) {
          if (openRootTurnId === ev.turnId) {
            this.activeTranscriptTurns.delete(openTurnId);
            closedTranscriptContinuation = true;
          }
        }
        // OSC 7501 `working` is process-wide evidence with no turn id, so a
        // rollout terminal for THIS turn cannot prove the working state belongs
        // to it: an OSC-only sibling continuation (whose `task_started` has not
        // flushed yet) may still be running under that same working hold. Clear
        // the latch only once the detector no longer holds working; while it
        // does, the latch stays armed until an explicit non-working OSC report,
        // prompt-ready, turn retirement, or reset resolves it.
        if (!programStatusHeldWorking) {
          this.programStatusNativeWorking = false;
        }
      }
    }

    const nowActive = this.isActive(programStatusHeldWorking);
    return {
      becameActive: !wasActive && nowActive,
      closedTranscriptContinuation,
    };
  }

  observeProgramStatus(
    input: TraexNativeContinuationProgramStatusInput,
  ): TraexNativeContinuationObservation {
    const wasActive = this.isActive(input.programStatusHeldWorking);
    if (input.state !== 'working' || !input.programStatusHeldWorking) {
      this.programStatusNativeWorking = false;
      return { becameActive: false, closedTranscriptContinuation: false };
    }
    if (input.wasPromptReady && !input.hasBotmuxTurnOwner && !input.botmuxOperationInFlight) {
      this.programStatusNativeWorking = true;
    }
    const nowActive = this.isActive(input.programStatusHeldWorking);
    return {
      becameActive: !wasActive && nowActive,
      closedTranscriptContinuation: false,
    };
  }

  /** Whether live rollout records prove an open TRAE native continuation turn. */
  hasTranscriptContinuation(): boolean {
    return this.activeTranscriptTurns.size > 0;
  }

  /** Whether positive transcript or post-idle OSC 7501 evidence proves TRAE is
   *  currently executing a native continuation turn. */
  isActive(programStatusHeldWorking: boolean): boolean {
    return this.activeTranscriptTurns.size > 0
      || (this.programStatusNativeWorking && programStatusHeldWorking);
  }

  /** Clear the OSC 7501 latch when a Botmux turn retires without discarding an
   *  exact transcript continuation that already started after its terminal. */
  noteBotmuxTurnRetired(): void {
    this.programStatusNativeWorking = false;
  }

  /** Confirmed idle prompt retires every open native continuation marker. */
  notePromptReady(): void {
    this.activeTranscriptTurns.clear();
    this.programStatusNativeWorking = false;
  }

  /** Full teardown / respawn / bridge detach reset. */
  reset(): void {
    this.activeTranscriptTurns.clear();
    this.programStatusNativeWorking = false;
  }
}
