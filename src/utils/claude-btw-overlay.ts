/**
 * Relay Claude Code's `/btw` side answer back to the IM thread.
 *
 * Claude Code answers `/btw <question>` in a dismissible overlay that never
 * reaches the session transcript. While answering, the overlay footer is
 * `Esc to close`, prefixed by `⇧←/→ to browse · x to clear history · ` once
 * earlier questions are in the history; once finished it reads
 * `↑/↓ to scroll · c to copy · f to fork · Esc to close`, and pressing `c`
 * makes Claude Code emit the full Markdown answer as an OSC 52 clipboard
 * sequence.
 *
 * Completion is read from the rendered screen, line by line: Claude Code
 * repaints differentially, so footer words need not arrive contiguously in
 * the raw stream, and answer text or the echoed question may mention the
 * same shortcuts. The OSC 52 sequence is written in one piece and is taken
 * from the raw stream. Reading the rendered overlay is the fallback.
 *
 * The guard is armed only by botmux's own `/btw` passthrough.
 */

export type ClaudeBtwScreenAction = { kind: 'pass' } | { kind: 'copy' };

export type ClaudeBtwDataAction =
  | { kind: 'pass' }
  /** One-shot: the guard is disarmed, so the question travels with it. */
  | { kind: 'answer'; text: string; question: string };

type Phase = 'idle' | 'answering' | 'copying';

const OSC52_START = '\x1b]52;';
// Bound the buffered payload (base64 inflates text by 4/3).
const OSC52_MAX = 512 * 1024;
const OSC52_RE = /\x1b\]52;[^;\x07\x1b]*;([A-Za-z0-9+/=\r\n]*)(?:\x07|\x1b\\)/g;

export class ClaudeBtwCaptureGuard {
  private phase: Phase = 'idle';
  private answeringSeen = false;
  private _question = '';
  private questionKey = '';
  // Copying phase: a tail long enough to catch a split start marker, then
  // the payload from the marker on.
  private osc = '';

  arm(question: string): void {
    this.disarm();
    this.phase = 'answering';
    this._question = question;
    this.questionKey = question.replace(/\s+/g, '');
  }

  isArmed(): boolean {
    return this.phase !== 'idle';
  }

  get question(): string {
    return this._question;
  }

  isCopying(): boolean {
    return this.phase === 'copying';
  }

  /** The caller pressed `c`; from now on look for the clipboard sequence. */
  markCopyRequested(): void {
    if (this.phase !== 'answering') return;
    this.phase = 'copying';
    this.osc = '';
  }

  /** The copy yielded nothing and the overlay is still answering. */
  revertToAnswering(): void {
    if (this.phase === 'copying') this.phase = 'answering';
  }

  disarm(): void {
    this.phase = 'idle';
    this.answeringSeen = false;
    this._question = '';
    this.questionKey = '';
    this.osc = '';
  }

  /**
   * `copy` requires this question's overlay to have been seen answering and
   * to now show the finished footer, so a missing overlay (old CLI, command
   * error) can never send `c` into the composer.
   */
  inspectScreen(screen: string): ClaudeBtwScreenAction {
    if (this.phase !== 'answering') return { kind: 'pass' };
    const overlay = parseClaudeBtwOverlay(screen);
    if (!overlay || !this.isOwnQuestion(overlay.question)) return { kind: 'pass' };
    if (overlay.state === 'answering') {
      this.answeringSeen = true;
      return { kind: 'pass' };
    }
    return this.answeringSeen ? { kind: 'copy' } : { kind: 'pass' };
  }

  /** Inspect a raw PTY chunk for the OSC 52 copy (copying phase only). */
  inspectData(data: string): ClaudeBtwDataAction {
    if (this.phase !== 'copying') return { kind: 'pass' };
    const buf = this.osc + data;
    const start = buf.lastIndexOf(OSC52_START);
    if (start < 0) {
      this.osc = buf.slice(-(OSC52_START.length - 1));
      return { kind: 'pass' };
    }
    this.osc = buf.slice(start, start + OSC52_MAX);
    const text = extractOsc52Text(this.osc);
    if (text === undefined) return { kind: 'pass' };
    const question = this._question;
    this.disarm();
    return { kind: 'answer', text, question };
  }

  /**
   * What to do when `c` produced no OSC 52: deliver this question's finished
   * overlay text, wait again while it is still answering (up to `maxCopies`
   * presses), or give up.
   */
  copyFallback(
    overlay: ClaudeBtwOverlay | undefined,
    copies: number,
    maxCopies: number,
  ): { kind: 'deliver'; answer: string } | { kind: 'wait' } | { kind: 'give-up' } {
    if (!overlay || !this.isOwnQuestion(overlay.question)) return { kind: 'give-up' };
    if (overlay.state === 'done' && overlay.answer) return { kind: 'deliver', answer: overlay.answer };
    if (overlay.state === 'answering' && copies < maxCopies) return { kind: 'wait' };
    return { kind: 'give-up' };
  }

  /** The screen shows only the first visual row of a long question, and
   *  display snapshots may collapse spaces; compare whitespace-free prefixes.
   *  The on-screen question is never longer than the armed one. */
  private isOwnQuestion(onScreen: string): boolean {
    const key = onScreen.replace(/\s+/g, '');
    return key !== '' && this.questionKey.startsWith(key);
  }
}

/** Decode the last complete OSC 52 clipboard payload in `raw`, if any.
 *  Accepts BEL or ST endings, including tmux's DCS-wrapped form. */
export function extractOsc52Text(raw: string): string | undefined {
  let last: string | undefined;
  OSC52_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = OSC52_RE.exec(raw)); ) last = m[1];
  const b64 = last?.replace(/\s+/g, '');
  if (!b64) return undefined;
  return Buffer.from(b64, 'base64').toString('utf8').trim() || undefined;
}

/** The `/btw` question, or undefined for anything but `/btw <question>`. */
export function claudeBtwQuestion(content: string): string | undefined {
  const m = /^\s*\/btw\s+([\s\S]*\S)\s*$/.exec(content);
  return m ? m[1] : undefined;
}

export interface ClaudeBtwOverlay {
  state: 'answering' | 'done';
  question: string;
  answer: string;
}

const QUESTION_LINE_RE = /^(\s*)\/btw\s+(.*\S)\s*$/;
// Whole-line footers. Finished: `·`-separated key hints ending in
// `Esc to close`, one of them the copy shortcut ("Copied to clipboard" right
// after `c`). Answering: `Esc to close`, after the history hints once earlier
// questions exist; only those, so another overlay is not taken for ours.
const DONE_HINTS = String.raw`(?:(?!c to copy · |Copied to clipboard · )\S[^·\n]* · )*`;
const DONE_FOOTER_RE = new RegExp(String.raw`^(\s*)${DONE_HINTS}(?:c to copy|Copied to clipboard) · ${DONE_HINTS}Esc to close\s*$`);
const ANSWERING_FOOTER_RE = /^(\s*)(?:⇧←\/→ to browse · )?(?:x to clear history · )?Esc to close\s*$/;
const BORDER_RE = /^\s*▔{8,}\s*$/;

/**
 * Read the `/btw` overlay from a rendered screen. The question is the
 * shallowest-indented `/btw` line between the overlay border and the footer
 * (earlier questions share that depth; the lowest is current) and must sit
 * at the footer's depth — a `/btw` example inside an answer is deeper.
 */
export function parseClaudeBtwOverlay(screen: string): ClaudeBtwOverlay | undefined {
  const lines = screen.split('\n');
  let footerAt = lines.length - 1;
  let footer: RegExpExecArray | null = null;
  let done = false;
  for (; footerAt >= 0; footerAt--) {
    footer = DONE_FOOTER_RE.exec(lines[footerAt]);
    done = footer !== null;
    footer ??= ANSWERING_FOOTER_RE.exec(lines[footerAt]);
    if (footer) break;
  }
  if (!footer) return undefined;

  let questionAt = -1;
  let question: RegExpExecArray | null = null;
  for (let i = footerAt - 1; i >= 0 && !BORDER_RE.test(lines[i]); i--) {
    const m = QUESTION_LINE_RE.exec(lines[i]);
    // Strictly shallower wins; on a tie keep the lower line.
    if (m && (!question || m[1].length < question[1].length)) {
      question = m;
      questionAt = i;
    }
  }
  if (!question || question[1].length !== footer[1].length) return undefined;

  if (!done) return { state: 'answering', question: question[2], answer: '' };
  const answerIndent = question[1].length + 2;
  const answer = lines.slice(questionAt + 1, footerAt)
    .map(l => (l.slice(0, answerIndent).trim() === '' ? l.slice(answerIndent) : l.trimStart()).trimEnd())
    .join('\n')
    .trim();
  return { state: 'done', question: question[2], answer };
}

/** Whether `screen` still shows a `/btw` overlay (so Esc closes the overlay
 *  instead of interrupting the running turn). */
export function claudeBtwOverlayVisible(screen: string): boolean {
  return parseClaudeBtwOverlay(screen) !== undefined;
}
