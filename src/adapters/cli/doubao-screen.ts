/**
 * Doubao TUI screen evidence, kept free of adapter/registry imports so the
 * submit-failure diagnosis can read the composer too.
 */
import { busyProbeRegion } from '../../utils/busy-probe.js';
import { stripAnsiScreenText } from '../../utils/idle-detector.js';

/**
 * Busy footer drawn directly above the composer while a turn runs:
 * `✦ Responding… (3s • esc to interrupt)` / `◈ Running tool… (8s • esc to interrupt)`.
 * The leading glyph animates and the counter ticks every second, so only the
 * static `esc to interrupt)` tail is anchored. It disappears when the turn ends
 * (replaced by `Worked for Ns` in the transcript). Verified on doubao 2.31.0;
 * 2.37.2 still renders `(<n>s • esc to interrupt)` while a turn or send runs.
 */
export const DOUBAO_BUSY_FOOTER = /esc to interrupt\)/;

/**
 * Doubao's own send queue. Enter moves the composer text into it and clears
 * the composer; the queue is pumped only while no turn runs, so input that
 * arrives during a turn is drawn under the composer as
 * `1 queued · <prompt> · Ctrl+Q manage` (`Queue paused · …` once a send was
 * refused) and reaches assignment.md only when the running work ends.
 * Verified against the 2.37.2 TUI source (entry-cli-router).
 */
export const DOUBAO_QUEUE_LINE = /^\s*(?:Queue paused · )?\d+ queued · /m;

const DOUBAO_COMPOSER_RULE = /^\s*─{8,}\s*$/;
const DOUBAO_COMPOSER_PLACEHOLDER = /^(?:Ask Doubao to do anything|Enter newline · Ctrl\+S send)$/;

export type DoubaoComposerState = 'empty' | 'draft' | 'unknown';

/**
 * What the composer box holds on an authoritative screen. The box is the
 * `❯ ` row directly under a horizontal rule (2.37: `❯ <text>`, continuation
 * rows indented, a 4+ line paste collapsed to `[Pasted text #N +M lines]`);
 * an empty composer renders its placeholder there. `unknown` when no such row
 * is on screen (startup, a panel covering the conversation).
 */
export function doubaoComposerState(screen: string): DoubaoComposerState {
  const lines = stripAnsiScreenText(screen).split(/\r?\n/);
  for (let i = lines.length - 1; i > 0; i--) {
    const row = /^\s*❯\s?(.*)$/.exec(lines[i]!);
    if (!row || !DOUBAO_COMPOSER_RULE.test(lines[i - 1]!)) continue;
    const text = row[1]!.trim();
    return !text || DOUBAO_COMPOSER_PLACEHOLDER.test(text) ? 'empty' : 'draft';
  }
  return 'unknown';
}

/** Doubao is visibly still holding input it already took: a turn is running
 *  (busy footer) or its own send queue is drawn. Either way it writes the
 *  native user record by itself once that work ends — an unstarted head is
 *  not yet evidence of a lost turn. Read from the screen tail, like the busy
 *  probe, so quoted footer text in the conversation does not count. */
export function doubaoScreenHoldsSubmittedInput(screen: string): boolean {
  const region = busyProbeRegion(screen);
  return DOUBAO_BUSY_FOOTER.test(region) || DOUBAO_QUEUE_LINE.test(region);
}

/** Doubao holds no pending input: empty composer, no running turn, nothing in
 *  its own send queue. A refused draft that is no longer on screen can then
 *  only have been cleared or replaced by hand. */
export function doubaoScreenShowsNoPendingInput(screen: string): boolean {
  return doubaoComposerState(screen) === 'empty' && !doubaoScreenHoldsSubmittedInput(screen);
}
