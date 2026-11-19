import type { PtyHandle } from '../adapters/cli/types.js';
import { codexNativeComposerState } from './codex-terminal-session.js';
import { stripAnsiScreenText } from '../utils/idle-detector.js';
import { delay, scaleMs } from '../utils/timing.js';

/** Native full-screen pager chrome, not a mention in conversation/scrollback.
 * Codex renders the spaced title in row zero and hints at the bottom.
 * The viewer advertises either `q to quit / esc to edit prev` (also used by
 * the older backtrack preview) or `q close / esc browse prompts`. */
function transcriptFooter(viewport: string): string | undefined {
  const rows = stripAnsiScreenText(viewport).replace(/\r/g, '').trimEnd().split('\n');
  if (!/^\s*\/ T R A N S C R I P T(?:\s|\/|$)/.test(rows[0] ?? '')) return undefined;
  const footer = rows.at(-1) ?? '';
  const navigation = rows.at(-2) ?? '';
  if (!/to scroll/.test(navigation)) return undefined;
  const modern = /^\s*q\s+close(?:\s|$)/.test(footer) && /esc browse prompts/.test(footer);
  const legacy = /to quit/.test(footer) && /to edit prev/.test(footer);
  if (!modern && !legacy) return undefined;
  return footer;
}

const CLOSE_BINDING = /^\s*q\s+(?:to quit|close)(?:\s|$)/;

/** The transcript pager is open and advertises the close key the pre-write
 * check presses before the first paste. */
export function codexTranscriptCloseable(viewport: string): boolean {
  const footer = transcriptFooter(viewport);
  return footer !== undefined && CLOSE_BINDING.test(footer);
}

type InputState = ReturnType<NonNullable<PtyHandle['captureInputState']>>;
function capture(terminal: PtyHandle): InputState {
  try { return terminal.captureInputState?.() ?? null; } catch { return null; }
}

// A timed-out close may still arrive. Keep its debt for this exact process,
// including across writeInput calls; never enqueue another q behind it.
const closing = new WeakMap<PtyHandle, { pid: number | undefined }>();

/** Upper bound for an input box that is still redrawing to become empty. */
const COMPOSER_SETTLE_MS = 5_000;
/** A draft seen after a redraw frame must hold this long to count as a draft. */
const DRAFT_PERSIST_MS = 500;
/** How long a settleCodexInputBox verdict covers the check of the write after it. */
const SETTLED_HANDOFF_MS = 1_000;

// settleCodexInputBox saw this exact process at an empty input box; the check
// of the write it was settling inherits that a redraw is still possible.
const settled = new WeakMap<PtyHandle, { pid: number | undefined; at: number }>();

/** Recover before the FIRST paste only. Never use Esc (enters backtrack) or
 * Ctrl+T (toggles the overlay back on). q requires the advertised close hint.
 * Snapshot-less transports cannot navigate a pager; they retain their ordinary
 * one-shot paste path. A supplied but unavailable snapshot fails closed.
 * An input box that is not yet empty (still redrawing) gets a bounded wait. */
export async function prepareCodexTranscriptInput(terminal: PtyHandle): Promise<string | undefined> {
  if (!terminal.captureInputState) return undefined;
  const handoff = settled.get(terminal);
  settled.delete(terminal);
  let state = capture(terminal);
  if (!state) return 'Codex input state is unavailable; no message was written.';
  const pid = terminal.cliPid;
  if (closing.has(terminal) && closing.get(terminal)!.pid !== pid) closing.delete(terminal);
  const footer = transcriptFooter(state.viewport);
  if (footer !== undefined && !closing.has(terminal)) {
    if (!CLOSE_BINDING.test(footer)) {
      return 'Codex transcript is open with an unsupported close binding; no message was written.';
    }
    closing.set(terminal, { pid });
    try { terminal.write('q'); } catch { /* Delivery may have occurred; observe only. */ }
  }
  const startedAt = Date.now();
  const closeDeadline = startedAt + scaleMs(2000);
  const settleDeadline = startedAt + scaleMs(COMPOSER_SETTLE_MS);
  // Startup and resize redraws drop the native footer for a while and can
  // flash a cursor-moved frame that reads as a draft. Once such a frame was
  // seen, a draft must persist before it counts; a draft seen first is final.
  let redrawing = !!handoff && handoff.pid === pid && startedAt - handoff.at < scaleMs(SETTLED_HANDOFF_MS);
  let draftSince: number | undefined;
  for (;;) {
    if (terminal.cliPid !== pid) {
      return closing.has(terminal)
        ? 'Codex process changed while closing transcript; no message was written.'
        : 'Codex process changed before its input box settled; no message was written.';
    }
    const now = Date.now();
    if (state && transcriptFooter(state.viewport) === undefined) {
      const composer = codexNativeComposerState(state);
      if (composer === 'empty') { closing.delete(terminal); return undefined; }
      // A close can expose a draft-looking redraw frame before the empty
      // composer settles. Observe within the existing deadline; never write
      // through a draft.
      if (composer === 'draft') {
        draftSince ??= now;
        if (!closing.has(terminal) && (!redrawing || now - draftSince >= scaleMs(DRAFT_PERSIST_MS))) {
          return 'Codex has an existing draft; no message was written.';
        }
      } else {
        draftSince = undefined;
        redrawing = true;
      }
    } else {
      draftSince = undefined;
      redrawing = true;
    }
    if (closing.has(terminal) ? now >= closeDeadline : now >= settleDeadline) break;
    await delay(50);
    state = capture(terminal);
  }
  if (!closing.has(terminal)) return 'Codex is not at an empty input box; no message was written.';
  if (state && transcriptFooter(state.viewport) === undefined
    && codexNativeComposerState(state) === 'draft') {
    return 'Codex has an existing draft; no message was written.';
  }
  return 'Codex transcript did not return to an empty input box; no message was written.';
}

/** prepareCodexTranscriptInput for an input that has not left the queue yet:
 * the same verdict, and the write that follows within a second treats a
 * draft-looking frame as part of the redraw this check waited through. */
export async function settleCodexInputBox(terminal: PtyHandle): Promise<string | undefined> {
  const refused = await prepareCodexTranscriptInput(terminal);
  if (!refused && terminal.captureInputState) settled.set(terminal, { pid: terminal.cliPid, at: Date.now() });
  return refused;
}
