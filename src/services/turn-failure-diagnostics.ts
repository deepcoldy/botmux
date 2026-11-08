/**
 * What a failed turn leaves for whoever has to explain it: the provider's own
 * error text (Claude's API-error record, a structured bridge's error summary,
 * a StopFailure hook's message) and the bottom of the CLI's screen when the
 * turn ended. Every CLI may lack either; absent stays absent.
 *
 * Both are masked first (maskFailureText: credential shapes, headers, URL
 * query values, home-directory user names) and bounded after, so a cut never
 * leaves half a key unmasked. Applied on the worker before the IPC and again
 * on the daemon when it keeps them: the daemon does not trust an older or
 * foreign worker to have done it.
 *
 * Masking reads a bounded window, not the whole text: some backends' screen
 * is the whole session (riff/mojo's output stream, zmx's history, a remote
 * runner's snapshot of up to 4 MB), and masking all of it on every failed
 * turn would cost time in proportion to the session's output.
 */
import { stuckScreenTail } from '../core/stuck-page-catalog.js';
import { maskFailureText } from '../workflows/v3/draft-failure.js';

export const TURN_FAILURE_DETAIL_MAX_CHARS = 2_000;
export const TURN_FAILURE_SCREEN_MAX_LINES = 40;
export const TURN_FAILURE_SCREEN_MAX_CHARS = 4_000;
/** The raw text masking reads: the screen's last this-many characters, the
 *  error's first. What is kept is a small part of it, so the cut is far from
 *  the kept part — a credential labelled rows above the kept rows is read
 *  together with the rows it wrapped onto. */
export const TURN_FAILURE_SCAN_MAX_CHARS = 128 * 1024;

export interface TurnFailureDiagnostics {
  /** The provider's raw error text, masked and clipped. */
  errorDetail?: string;
  /** The last screen rows, masked and clipped. */
  screenTail?: string;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function turnFailureErrorDetail(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  // The head is kept: a value the window cuts still has its label before it.
  const window = text.length > TURN_FAILURE_SCAN_MAX_CHARS ? text.slice(0, TURN_FAILURE_SCAN_MAX_CHARS) : text;
  const masked = maskFailureText(window).trim();
  return masked ? clip(masked, TURN_FAILURE_DETAIL_MAX_CHARS) : undefined;
}

export function turnFailureScreenTail(screen: unknown): string | undefined {
  if (typeof screen !== 'string' || !screen) return undefined;
  // Mask the window before taking its tail: a token wrapped across the tail's
  // first row would otherwise lose the label that marks it as one.
  // A cut window's first row is partial — its label may be before the cut —
  // and a screen dense with escapes can bring it into the kept rows: drop it,
  // as readFileTail does for a log's tail. A cursor-addressed stream may have
  // no newline at all: there the partial piece ends at the first blank or
  // escape, where no unquoted value goes on.
  const cut = screen.length > TURN_FAILURE_SCAN_MAX_CHARS;
  const tailWindow = cut ? screen.slice(-TURN_FAILURE_SCAN_MAX_CHARS) : screen;
  const newline = tailWindow.indexOf('\n');
  const boundary = newline >= 0 ? newline + 1 : tailWindow.search(/[\s\x1b]/);
  const window = !cut ? tailWindow : boundary >= 0 ? tailWindow.slice(boundary) : '';
  const plain = stuckScreenTail(window, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const tail = stuckScreenTail(maskFailureText(plain), TURN_FAILURE_SCREEN_MAX_LINES, TURN_FAILURE_SCREEN_MAX_CHARS);
  return tail.trim() ? tail : undefined;
}

/** Only the fields that have content. */
export function turnFailureDiagnostics(input: { errorDetail?: unknown; screen?: unknown }): TurnFailureDiagnostics {
  const errorDetail = turnFailureErrorDetail(input.errorDetail);
  const screenTail = turnFailureScreenTail(input.screen);
  return {
    ...(errorDetail ? { errorDetail } : {}),
    ...(screenTail ? { screenTail } : {}),
  };
}
