import type { PtyHandle, SessionRenameSurface } from '../adapters/cli/types.js';
import { findCodexRolloutSetByPid } from './codex-transcript.js';
import { stripAnsiScreenText } from '../utils/idle-detector.js';
import { detectCodexComposerState } from './codex-composer-state.js';
import { composerTextKey } from '../utils/composer-text-key.js';
import { detectCodexChoiceModal } from '../utils/codex-choice-modal.js';

export const CODEX_ACTIVE_BUSY_PATTERN = /Working[^\r\n]{0,160}esc to interrupt/i;

type Resolution =
  | { kind: 'legacy' }
  | { kind: 'terminal'; sessionId: string }
  | { kind: 'unavailable' };

// Scope evidence to a backend generation, never to CODEX_HOME or the daemon.
const bindings = new WeakMap<PtyHandle, { pid: number; sessionId: string }>();
const pending = new WeakMap<PtyHandle, Promise<Resolution>>();

/** Called only after an exact history match containing this write's random
 * marker. Pin the proof to the submitting backend and its original process;
 * a delayed receipt from a replaced process must not bind its successor. */
export function bindCodexSessionFromCorrelatedInput(
  terminal: PtyHandle, pid: number, sessionId: string,
): boolean {
  if (terminal.cliPid !== pid) return false;
  bindings.set(terminal, { pid, sessionId: sessionId.toLowerCase() });
  return true;
}

export function codexTerminalSessionIsBound(terminal: PtyHandle, sessionId: string): boolean {
  const binding = bindings.get(terminal);
  return binding !== undefined && binding.pid === terminal.cliPid
    && binding.sessionId === sessionId.toLowerCase();
}

/** Display-only composer hints embedded in codex-cli 0.146.1. Keep this exact
 * inventory out of startup/rename classification; only the normal delivery
 * guard opts in after its other dialog and draft checks. */
const CODEX_0146_COMPOSER_HINTS: ReadonlySet<string> = new Set([
  'Explain this codebase',
  'Summarize recent commits',
  'Implement {feature}',
  'Find and fix a bug in @filename',
  'Write tests for @filename',
  'Improve documentation in @filename',
  'Run /review on my current changes',
  'Use /skills to list available skills',
  'Check recently modified functions for compatibility',
  'How many files have been modified?',
  'Will this algorithm scale well?',
]);

type CodexNativeComposerOptions = { allowCodex0146Hints?: boolean };

export function codexEmptyComposerFooter(
  state: ReturnType<NonNullable<PtyHandle['captureInputState']>> | undefined,
  opts: CodexNativeComposerOptions = {},
): string | undefined {
  if (!state) return undefined;
  const lines = stripAnsiScreenText(state.viewport).split(/\r?\n/);
  if (detectCodexComposerState({ ...state, viewport: lines.join('\n') }) !== 'empty') return undefined;
  const line = lines[state.cursor.y];
  if (line === undefined) return undefined;
  // Cursor position alone cannot distinguish a draft whose cursor is at Home.
  // Accept only an empty row or the known native placeholder, plus a live
  // initialized footer below it. Unknown placeholders fail closed.
  const prompt = /^(\s*)[›»] (.*)$/.exec(line);
  if (!prompt) return undefined;
  const ghostText = prompt[2]!.trimEnd();
  const nativeGhostText = ghostText === '' || ghostText === 'Ask Codex to do anything'
    || (opts.allowCodex0146Hints === true && CODEX_0146_COMPOSER_HINTS.has(ghostText));
  if (!nativeGhostText || state.cursor.x !== (prompt[1]?.length ?? 0) + 2) return undefined;
  // Match native state rows, not words inside transcript prose or tool output.
  const below = lines.slice(state.cursor.y + 1);
  // Both layouts are native: an inline status/hints row, or a separate status
  // row followed by hints. Stay in the adjacent footer band, never scrollback.
  const footer = below.slice(0, 4).filter(row => row.trim());
  // Busy/loading evidence is meaningful only next to the live composer. The
  // same words can remain in scrollback after capacity recovers (or appear in
  // ordinary transcript prose); scanning the whole viewport would then make a
  // healthy empty composer fail closed forever.
  const composerNeighborhood = lines.slice(
    Math.max(0, state.cursor.y - 3),
    Math.min(lines.length, state.cursor.y + 5),
  ).join('\n');
  if (footer.length < 1 || footer.length > 2 || below.slice(4).some(row => row.trim())
    || /^\s*(?:(?:[^\w\s]\s+)?(?:Queued for capacity|Resuming session)\b|│\s*(?:model|directory):\s*loading\b)/im.test(composerNeighborhood)) return undefined;
  return codexNativeFooterRows(footer);
}

/** Positive, fail-closed evidence for unattended writes into Codex.
 *
 * Cursor position catches the common draft case while the exact native
 * placeholder + bounded footer check catches a draft whose cursor was moved
 * back to Home, stale scrollback prompts, pickers, and startup/loading screens.
 */
export function codexNativeComposerState(
  state: ReturnType<NonNullable<PtyHandle['captureInputState']>> | undefined,
  opts: CodexNativeComposerOptions = {},
): 'empty' | 'draft' | 'unknown' {
  const coarse = detectCodexComposerState(state);
  if (coarse !== 'empty') return coarse;
  return codexEmptyComposerFooter(state, opts) !== undefined ? 'empty' : 'unknown';
}

function emptyComposerFooter(terminal: PtyHandle): string | undefined {
  return codexEmptyComposerFooter(terminal.captureInputState?.());
}

/** Validate the native one/two-row footer after the caller bounds its location. */
export function codexNativeFooterRows(footer: string[]): string | undefined {
  if (footer.length < 1 || footer.length > 2) return undefined;
  // The second footer row is the native hints/warning row. A warning-only row
  // is native too: when hints are hidden the warning is the only thing left in
  // that row. Codex degrades the notice by width: `\u26a0 N warnings \u00b7 f2
  // to view` -> `\u26a0 N \u00b7 f2` -> `\u26a0 N`, so accept the shared
  // `\u26a0 N` prefix (the optional \uFE0F covers the emoji-presentation
  // glyph). This gates the row shape only; it never feeds ID extraction.
  if (footer.length === 2
    && !/^\s*(?:\u2190 for agents|\? for shortcuts|esc to interrupt|tab to queue)\b/.test(footer[1] ?? '')
    && !/^\s*\u26a0(?:\ufe0f)?\s*\d+\b/.test(footer[1] ?? '')) return undefined;
  return footer.map(row => row.trim()).join('\n');
}

/** Codex's native rename text dialog owns Enter even though it renders a › row. */
function codexRenameDialogVisible(viewport: string): boolean {
  const rows = viewport.trimEnd().split(/\r?\n/);
  if (!/^\s*enter submit\s*\|\s*esc back\s*$/.test(rows.at(-1) ?? '')) return false;
  return rows.slice(-8).some(row => /^\s*Rename thread\s*$/.test(row));
}

/**
 * Where a native Codex `/rename <title>` stands after its Enter.
 * `settled` only describes an empty composer; the worker separately requires
 * this thread's durable receipt. Known busy/dialog/draft surfaces are
 * `occupied` and outrank that receipt; an unrecognised footer stays `unknown`
 * so a matching receipt can still settle a future native layout.
 */
export function codexSessionRenameSurface(
  evidence: { viewport: string; cursor?: { x: number; y: number } },
  command: string,
): SessionRenameSurface {
  const viewport = stripAnsiScreenText(evidence.viewport);
  if (detectCodexChoiceModal(viewport) || codexRenameDialogVisible(viewport)) return 'occupied';
  const rows = viewport.split(/\r?\n/);
  let composer = rows.length - 1;
  while (composer >= 0 && !/^\s*[›»](?:\s|$)/.test(rows[composer]!)) composer--;
  if (composer < 0) {
    return CODEX_ACTIVE_BUSY_PATTERN.test(rows.slice(-6).join('\n')) ? 'occupied' : 'unknown';
  }
  const neighborhood = rows.slice(Math.max(0, composer - 4), composer + 5).join('\n');
  if (CODEX_ACTIVE_BUSY_PATTERN.test(neighborhood)) return 'occupied';
  const cursor = evidence.cursor
    ?? { x: (/^\s*/.exec(rows[composer]!)?.[0].length ?? 0) + 2, y: composer };
  const nativeState = codexNativeComposerState({ viewport, cursor });
  if (nativeState === 'empty') return 'settled';
  const wanted = composerTextKey(command);
  for (let end = composer + 1; end < rows.length; end++) {
    if (codexNativeFooterRows(rows.slice(end).filter(row => row.trim())) === undefined) continue;
    const body = [rows[composer]!.replace(/^\s*[›»]/, ''), ...rows.slice(composer + 1, end)].join('');
    return composerTextKey(body) === wanted ? 'unsubmitted' : 'occupied';
  }
  return nativeState === 'draft' ? 'occupied' : 'unknown';
}

// A complete Codex thread UUID (the `thread-id` / legacy `session-id` item).
const THREAD_ID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// The ID must OPEN its segment and be a standalone whitespace-delimited
// token: only leading whitespace / braille spinners may precede it (stripped
// above), and the very next character after the id must be whitespace or the
// segment end. This anchoring keeps a cwd segment such as `/tmp/<uuid>` from
// impersonating the thread id -- there the UUID does not start the segment --
// and rejects glued path/file/colon suffixes (`<id>.json`, `<id>/sub`,
// `<id>:x`) even though those punctuation marks are not word characters. A
// space-separated suffix is allowed because the TUI right-aligns notices after
// the id on the same segment using space padding, not ` \u00b7 `: busy
// spinners and the `\u26a0 N warnings \u00b7 f2 to view` notice.
const THREAD_ID_OPENING_SEGMENT = new RegExp(`^(${THREAD_ID_PATTERN})(?:\\s([\\s\\S]*))?$`, 'i');
const THREAD_ID_ANYWHERE = new RegExp(THREAD_ID_PATTERN, 'i');

/** Parse one complete native thread-id segment from an already bounded footer. */
export function codexFooterSessionId(footer: string): string | undefined {
  // Read only the live footer: UUIDs in scrollback, pasted drafts, and old
  // /status cards are not evidence.
  const ids = footer
    .split(/\n|\s+\u00b7\s+/)
    // Busy spinners are plain braille characters, not ANSI escapes. Strip that
    // known decoration at segment boundaries; a /tmp/<uuid> prefix is kept.
    .map(segment => segment.replace(/^[\s\u2800-\u28ff]+|[\s\u2800-\u28ff]+$/g, ''))
    .flatMap((segment): string[] => {
      const match = THREAD_ID_OPENING_SEGMENT.exec(segment);
      if (!match) return [];
      const [, id, remainder] = match;
      // A second UUID inside the trailing decoration is ambiguous (one thread
      // never renders two ids) -- drop the segment instead of guessing.
      if (THREAD_ID_ANYWHERE.test(remainder ?? '')) return [];
      return [id!.toLowerCase()];
    });
  return ids.length === 1 ? ids[0] : undefined;
}

/**
 * Older/embedded TUIs own their rollout fds. Shared-daemon TUIs do not, and
 * daemon fds include unrelated panes. Read the original TUI's live thread-id
 * footer without writing commands into the conversation. Refresh on every
 * submission to follow local thread switches. Available footer IDs supplement
 * the PID/rollout ownership evidence used for submission confirmation.
 */
export function refreshCodexTerminalSession(terminal: PtyHandle): Promise<Resolution> {
  const inFlight = pending.get(terminal);
  if (inFlight) return inFlight;
  const task = refresh(terminal).finally(() => pending.delete(terminal));
  pending.set(terminal, task);
  return task;
}

async function refresh(terminal: PtyHandle): Promise<Resolution> {
  bindings.delete(terminal);
  const pid = terminal.cliPid;
  if (!pid || terminal.expectedCodexSessionId) return { kind: 'legacy' };
  const owned = findCodexRolloutSetByPid(pid);
  if (owned === undefined || owned.size > 0 || !terminal.captureInputState) return { kind: 'legacy' };
  try {
    const footer = emptyComposerFooter(terminal);
    if (footer !== undefined) {
      const footerSessionId = codexFooterSessionId(footer);
      if (footerSessionId && terminal.cliPid === pid) {
        bindings.set(terminal, { pid, sessionId: footerSessionId });
        return { kind: 'terminal', sessionId: footerSessionId };
      }
    }
  } catch { /* Closed pane or unsupported snapshot: keep the binding unproven. */ }
  return { kind: 'unavailable' };
}
