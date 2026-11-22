/**
 * Lets Claude Code write its away summary for a turn (the「本轮回顾」panel,
 * core/turn-recap-state.ts) by telling it, once the turn is over, that its
 * terminal lost focus — the condition Claude Code waits for and that a botmux
 * pane never produces on its own (no tmux client is focused on it).
 *
 * Claude Code (2.1.325–2.1.330, read from its bundle and measured) enables
 * DECSET 1004 focus reporting, keeps a terminal focus state, and only when that
 * state is `blurred` at 3 minutes (min(3 min, 0.8 × prompt-cache TTL)) after a
 * turn ended does it fork the conversation once to write an away summary into
 * its transcript. A focus-in report, a key press or a paste sets the state back
 * to `focused`, which cancels a pending summary.
 *
 * The blurred state has side effects while it lasts, so it is kept to the idle
 * stretch after a turn:
 *   - no next-input suggestion is generated or shown: the focus-out goes in
 *     only after the turn's suggestion was read off the screen (or did not come);
 *   - the user counts as away (push notifications are no longer suppressed as
 *     "user present"), and animations tick at half rate.
 * So focus is reported back as soon as anything else happens: input for the CLI,
 * someone opening the web terminal, the CLI starting a turn of its own, the
 * summary being written, or the summary window passing without one.
 *
 * Writes go to the pane like typed bytes (`ESC [ O` / `ESC [ I`). They are only
 * made for a CLI known to read them as focus reports (see awaySummaryFocusRefusal):
 * one that does not would show `[O` in its input box.
 */
import { cliVersionAtLeast } from '../core/program-status-gate.js';
import type { PromptCacheKeepaliveRefusal } from '../core/unattended-input-refusal.js';

export const FOCUS_OUT = '\x1b[O';
export const FOCUS_IN = '\x1b[I';

/** Lowest Claude Code release whose focus handling and away summary were
 * checked (2.1.325–2.1.330). */
export const AWAY_SUMMARY_FOCUS_MIN_VERSION = '2.1.325';

/** How long to wait for the turn's next-input suggestion before the
 * focus-out: Claude Code does not generate or show one while unfocused. It
 * normally appears 1–3 s after the turn ends. */
export const AWAY_SUMMARY_SUGGESTION_WAIT_MS = 20_000;
/** Retry interval while the CLI is not quietly idle at an empty input box yet. */
export const AWAY_SUMMARY_RETRY_MS = 1_000;
/** Give up on a turn whose moment never came: Claude Code decides 3 minutes
 * after the turn ended, and the focus-out must land well before that. */
export const AWAY_SUMMARY_GIVE_UP_MS = 2 * 60_000;
/** Focus is reported back if no summary was written by then (Claude Code
 * skipped it: see the PR for the conditions). */
export const AWAY_SUMMARY_BLUR_MAX_MS = 5 * 60_000;

/** Daemon messages that put input into the CLI (or act on it like input):
 * focus is reported back before they are handled. */
const INPUT_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'message', 'raw_input', 'tui_keys', 'tui_text_input', 'inject_command',
  'prompt_submitted', 'rename_session', 'term_action', 'interrupt_turn',
  'coco_drive_picker', 'codex_cli_effort',
]);

/** Refusals that are a person's state on screen (a draft, a dialog): Claude
 * Code would not write a summary over a draft, and nothing is written while a
 * choice waits. Anything else may pass within the retry window. */
const SETTLED_REFUSALS: ReadonlySet<PromptCacheKeepaliveRefusal> = new Set([
  'composer_not_empty', 'action_prompt_open', 'tui_prompt_open',
]);

export interface AwaySummaryFocusLaunch {
  cliId?: string;
  cliVersion?: string;
  adoptMode?: boolean;
  backendType?: string;
}

/** Why this CLI session cannot take focus reports from botmux, or undefined.
 * Claude Code itself only: Relay 3.28 (a fork) writes its away summary from
 * `/recap` alone, and other CLIs have none. Adopted panes belong to a person's
 * own terminal; only pty and tmux panes take the bytes as written. */
export function awaySummaryFocusRefusal(launch: AwaySummaryFocusLaunch): string | undefined {
  if (launch.cliId !== 'claude-code') return 'not Claude Code';
  if (launch.adoptMode) return 'adopted pane';
  if (launch.backendType !== 'tmux' && launch.backendType !== 'pty') return `${launch.backendType ?? 'unknown'} backend`;
  if (!cliVersionAtLeast(launch.cliVersion, AWAY_SUMMARY_FOCUS_MIN_VERSION)) {
    return `version ${JSON.stringify(launch.cliVersion?.split('\n')[0] ?? 'unknown')} < ${AWAY_SUMMARY_FOCUS_MIN_VERSION}`;
  }
  return undefined;
}


export interface AwaySummaryFocusDeps {
  now(): number;
  setTimer(run: () => void, ms: number): () => void;
  /** Why the focus-out must not be written now (the unattended-input gate:
   * prompt ready, nothing queued, an empty input box, no dialog); undefined = it may. */
  refusal(): PromptCacheKeepaliveRefusal | undefined;
  /** The turn whose input the CLI was last given. */
  currentTurnId(): string | undefined;
  /** The same turn after folded type-ahead attribution: a completed B folded
   *  into screen-owning A owns the recap even though currentTurnId remains A. */
  recapTurnId?(): string | undefined;
  /** Someone has the web terminal open: they are not away. */
  watched(): boolean;
  /** Writes the bytes to the CLI's terminal; false when they could not be. */
  write(bytes: string): boolean;
  log(message: string): void;
}

function label(turnId: string): string {
  return turnId.slice(0, 16);
}

export class AwaySummaryFocus {
  private waiting?: { turnId: string; since: number; cancel?: () => void };
  private blurred?: { turnId: string; cancel: () => void };
  /** The latest turn whose next-input suggestion was reported. */
  private suggested?: string;

  constructor(private readonly deps: AwaySummaryFocusDeps) {}

  /** Whether botmux has reported the terminal unfocused and not back yet. */
  get isBlurred(): boolean {
    return !!this.blurred;
  }

  /** A recap is being waited on or the terminal is blurred for it. Keepalive
   *  must wait for this stretch rather than consume the one-shot request. */
  get isActive(): boolean {
    return !!this.waiting || !!this.blurred;
  }

  /** The daemon asks for an away summary of `turn` (its last card settled and
   * the bot has the switch on). */
  request(turnId: string): void {
    if (this.waiting?.turnId === turnId || this.blurred?.turnId === turnId) return;
    this.cancelWait();
    this.waiting = { turnId, since: this.deps.now() };
    this.attempt();
  }

  /** The turn's next-input suggestion was read off the screen and reported. */
  noteSuggestion(turnId: string): void {
    this.suggested = turnId;
    if (this.waiting?.turnId === turnId) this.attempt();
  }

  /** A daemon message is about to be handled: input for the CLI first gets
   * focus back. */
  beforeDaemonMessage(type: string): void {
    if (INPUT_MESSAGE_TYPES.has(type)) this.restore(type);
  }

  /** The recap observer accepted a summary for a specific turn. Only that
   *  attribution may finish a request: an older turn's late away_summary is
   *  not evidence about this one. */
  noteRecap(recap: { turnId: string } | undefined): void {
    if (!recap) return;
    if (this.waiting?.turnId === recap.turnId) {
      this.deps.log(`[away-summary] ${label(recap.turnId)}: skipped, the summary is already written`);
      this.cancelWait();
    }
    if (this.blurred?.turnId === recap.turnId) this.restore('summary written');
  }

  /** The bridge proved that the CLI went busy from idle: a new local/scheduled
   *  turn, not a late record from the turn whose recap is being awaited. */
  noteCliTurnStarted(): void {
    if (this.waiting) {
      this.deps.log(`[away-summary] ${label(this.waiting.turnId)}: skipped, the CLI started a newer turn`);
    }
    this.restore('the CLI started a turn');
  }

  /** Reports focus back (when botmux had reported it away) and drops any
   * pending focus-out. */
  restore(reason: string): void {
    this.cancelWait();
    const blurred = this.blurred;
    if (!blurred) return;
    this.blurred = undefined;
    blurred.cancel();
    const written = this.deps.write(FOCUS_IN);
    this.deps.log(`[away-summary] focus reported back for ${label(blurred.turnId)} (${reason})${written ? '' : ': write failed'}`);
  }

  /** The CLI is gone or replaced: its focus state went with it. Nothing is written. */
  reset(): void {
    this.cancelWait();
    this.blurred?.cancel();
    this.blurred = undefined;
    this.suggested = undefined;
  }

  private cancelWait(): void {
    this.waiting?.cancel?.();
    this.waiting = undefined;
  }

  private schedule(ms: number): void {
    const waiting = this.waiting;
    if (!waiting) return;
    waiting.cancel?.();
    waiting.cancel = this.deps.setTimer(() => {
      if (this.waiting !== waiting) return;
      waiting.cancel = undefined;
      this.attempt();
    }, ms);
  }

  private attempt(): void {
    const waiting = this.waiting;
    if (!waiting) return;
    const { turnId } = waiting;
    const current = this.deps.recapTurnId ? this.deps.recapTurnId() : this.deps.currentTurnId();
    if (current !== undefined && current !== turnId) {
      this.deps.log(`[away-summary] ${label(turnId)}: skipped, a newer turn has the CLI`);
      this.cancelWait();
      return;
    }
    const elapsed = this.deps.now() - waiting.since;
    if (elapsed >= AWAY_SUMMARY_GIVE_UP_MS) {
      this.deps.log(`[away-summary] ${label(turnId)}: skipped, the CLI never sat idle at an empty input box`);
      this.cancelWait();
      return;
    }
    if (this.suggested !== turnId && elapsed < AWAY_SUMMARY_SUGGESTION_WAIT_MS) {
      this.schedule(AWAY_SUMMARY_SUGGESTION_WAIT_MS - elapsed);
      return;
    }
    const refusal = this.deps.watched() ? 'web terminal open' : this.deps.refusal();
    if (refusal && SETTLED_REFUSALS.has(refusal as PromptCacheKeepaliveRefusal)) {
      this.deps.log(`[away-summary] ${label(turnId)}: skipped (${refusal})`);
      this.cancelWait();
      return;
    }
    if (refusal) {
      this.schedule(AWAY_SUMMARY_RETRY_MS);
      return;
    }
    this.cancelWait();
    if (!this.deps.write(FOCUS_OUT)) {
      this.deps.log(`[away-summary] ${label(turnId)}: focus-out write failed`);
      return;
    }
    const blurred = { turnId, cancel: () => {} };
    blurred.cancel = this.deps.setTimer(() => {
      if (this.blurred === blurred) this.restore('no summary in time');
    }, AWAY_SUMMARY_BLUR_MAX_MS);
    this.blurred = blurred;
    this.deps.log(`[away-summary] ${label(turnId)}: terminal reported unfocused`);
  }
}
