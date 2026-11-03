/**
 * Fallback for an OSC 7501 `working` hold that never ends.
 *
 * OSC 7501 has no heartbeat: once Claude Code reports `working`, the idle
 * detector waits for its terminal report and ignores the screen. If that report
 * is lost (or a child id never reports back), the session stays `working`
 * forever — prompt on screen, transcript long finished. The release here needs
 * every independent signal to agree: the transcript closed the turn with
 * nothing written since and no background task of it still running, OSC
 * itself has been silent, and the screen shows the idle prompt with no busy
 * marker. The screen is only the last check.
 */
import { isClaudeTurnTerminalEvent, type TranscriptEvent } from '../services/claude-transcript.js';

/** How long the transcript must have been closed AND OSC silent. Claude writes
 *  its terminal record and its OSC `idle` within about a second of each other. */
export const STALE_PROGRAM_STATUS_QUIET_MS = 60_000;
/** Re-check cadence while a closed turn's OSC hold persists. */
export const STALE_PROGRAM_STATUS_CHECK_MS = 15_000;

/** Main-thread conversation records — anything else (metadata, snapshots,
 *  queue bookkeeping, sidechains) neither opens nor closes the turn. */
function isMainThreadActivity(ev: TranscriptEvent): boolean {
  if (!ev || (ev as { isSidechain?: unknown }).isSidechain === true) return false;
  const role = ev.message?.role ?? ev.type;
  if (role === 'user' || role === 'assistant') return true;
  return ev.type === 'attachment' && ev.attachment?.type === 'queued_command';
}

/** Whether the latest main-thread record of a Claude transcript closed its turn. */
export class ClaudeTranscriptTurnEnd {
  private endedAtMs: number | undefined;

  /** Fold newly drained records, in transcript order. */
  observe(events: readonly TranscriptEvent[], now: number = Date.now()): void {
    for (const ev of events) {
      if (isClaudeTurnTerminalEvent(ev)) {
        this.endedAtMs ??= now;
      } else if (isMainThreadActivity(ev)) {
        this.endedAtMs = undefined;
      }
    }
  }

  /** Milliseconds since the transcript closed the turn; undefined while open. */
  endedForMs(now: number = Date.now()): number | undefined {
    return this.endedAtMs === undefined ? undefined : now - this.endedAtMs;
  }

  reset(): void {
    this.endedAtMs = undefined;
  }
}

export interface StaleProgramStatusEvidence {
  /** The detector holds a `working` record (not `blocked`). */
  heldWorking: boolean;
  /** Since the last OSC 7501 report. */
  programStatusQuietMs: number;
  /** Since the transcript closed the turn; undefined while it is open. */
  transcriptEndedForMs: number | undefined;
  /** Background tasks the transcript shows launched and not yet stopped. */
  backgroundTasksRunning: number;
}

/** `wait`: keep checking; `stop`: nothing to release; `check-screen`: every
 *  deterministic signal agrees — release if the screen shows the idle prompt. */
export function staleProgramStatusVerdict(e: StaleProgramStatusEvidence): 'stop' | 'wait' | 'check-screen' {
  if (!e.heldWorking || e.transcriptEndedForMs === undefined) return 'stop';
  // Claude Code keeps reporting `working` while background work it launched is
  // still running after the main turn ended. That hold is real, not a lost
  // terminal report; it ends with the tasks (and the card shows them).
  if (e.backgroundTasksRunning > 0) return 'wait';
  if (e.transcriptEndedForMs < STALE_PROGRAM_STATUS_QUIET_MS
    || e.programStatusQuietMs < STALE_PROGRAM_STATUS_QUIET_MS) return 'wait';
  return 'check-screen';
}
