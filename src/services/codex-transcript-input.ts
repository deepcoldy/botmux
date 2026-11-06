import type { PtyHandle } from '../adapters/cli/types.js';
import { codexNativeComposerState } from './codex-terminal-session.js';
import { stripAnsiScreenText } from '../utils/idle-detector.js';
import { delay, scaleMs } from '../utils/timing.js';

/** Native full-screen pager chrome, not a mention in conversation/scrollback.
 * Codex 0.153.4 renders the spaced title in row zero and hints at the bottom.
 * Both normal transcript and backtrack preview share this surface. */
function transcriptFooter(viewport: string): string | undefined {
  const rows = stripAnsiScreenText(viewport).replace(/\r/g, '').trimEnd().split('\n');
  if (!/^\s*\/ T R A N S C R I P T(?:\s|\/|$)/.test(rows[0] ?? '')) return undefined;
  const footer = rows.at(-1) ?? '';
  const navigation = rows.at(-2) ?? '';
  if (!/to scroll/.test(navigation) || !/to quit/.test(footer) || !/to edit prev/.test(footer)) return undefined;
  return footer;
}

type InputState = ReturnType<NonNullable<PtyHandle['captureInputState']>>;
function capture(terminal: PtyHandle): InputState {
  try { return terminal.captureInputState?.() ?? null; } catch { return null; }
}

// A timed-out close may still arrive. Keep its debt for this exact process,
// including across writeInput calls; never enqueue another q behind it.
const closing = new WeakMap<PtyHandle, { pid: number | undefined }>();

/** Recover before the FIRST paste only. Never use Esc (enters backtrack) or
 * Ctrl+T (toggles the overlay back on). q requires the advertised close hint.
 * Snapshot-less transports cannot navigate a pager; they retain their ordinary
 * one-shot paste path. A supplied but unavailable snapshot fails closed. */
export async function prepareCodexTranscriptInput(terminal: PtyHandle): Promise<string | undefined> {
  if (!terminal.captureInputState) return undefined;
  let state = capture(terminal);
  if (!state) return 'Codex input state is unavailable; no message was written.';
  const pid = terminal.cliPid;
  if (closing.has(terminal) && closing.get(terminal)!.pid !== pid) closing.delete(terminal);
  const footer = transcriptFooter(state.viewport);
  if (footer !== undefined && !closing.has(terminal)) {
    if (!/^\s*q\s+to quit(?:\s|$)/.test(footer)) {
      return 'Codex transcript is open with an unsupported close binding; no message was written.';
    }
    closing.set(terminal, { pid });
    try { terminal.write('q'); } catch { /* Delivery may have occurred; observe only. */ }
  }
  const deadline = Date.now() + scaleMs(2000);
  do {
    if (terminal.cliPid !== pid) return 'Codex process changed while closing transcript; no message was written.';
    if (state && transcriptFooter(state.viewport) === undefined) {
      const composer = codexNativeComposerState(state);
      if (composer === 'empty') { closing.delete(terminal); return undefined; }
      if (composer === 'draft') return 'Codex has an existing draft; no message was written.';
    }
    if (!closing.has(terminal)) return 'Codex is not at an empty input box; no message was written.';
    await delay(50);
    state = capture(terminal);
  } while (Date.now() < deadline);
  return 'Codex transcript did not return to an empty input box; no message was written.';
}
