import type { PtyHandle } from '../adapters/cli/types.js';
import { findCodexRolloutSetByPid } from './codex-transcript.js';
import { stripAnsiScreenText } from '../utils/idle-detector.js';
import { detectCodexComposerState } from './codex-composer-state.js';

type Resolution =
  | { kind: 'legacy' }
  | { kind: 'terminal'; sessionId: string }
  | { kind: 'unavailable' };

// Scope evidence to a backend generation, never to CODEX_HOME or the daemon.
const bindings = new WeakMap<PtyHandle, { pid: number; sessionId: string }>();
const pending = new WeakMap<PtyHandle, Promise<Resolution>>();

export function codexTerminalSessionIsBound(terminal: PtyHandle, sessionId: string): boolean {
  const binding = bindings.get(terminal);
  return binding !== undefined && binding.pid === terminal.cliPid
    && binding.sessionId === sessionId.toLowerCase();
}

function emptyComposerFooter(terminal: PtyHandle): string | undefined {
  const state = terminal.captureInputState?.();
  if (!state) return undefined;
  const lines = stripAnsiScreenText(state.viewport).split(/\r?\n/);
  if (detectCodexComposerState({ ...state, viewport: lines.join('\n') }) !== 'empty') return undefined;
  const line = lines[state.cursor.y];
  if (line === undefined) return undefined;
  // Cursor position alone cannot distinguish a draft whose cursor is at Home.
  // Accept only an empty row or the known native placeholder, plus a live
  // initialized footer below it. Unknown placeholders fail closed.
  const prompt = /^(\s*)[›»] (?:Ask Codex to do anything)?\s*$/.exec(line);
  if (!prompt || state.cursor.x !== (prompt[1]?.length ?? 0) + 2) return undefined;
  // Match native state rows, not words inside transcript prose or tool output.
  const below = lines.slice(state.cursor.y + 1);
  // Both layouts are native: an inline status/hints row, or a separate status
  // row followed by hints. Stay in the adjacent footer band, never scrollback.
  const footer = below.slice(0, 4).filter(row => row.trim());
  if (footer.length < 1 || footer.length > 2 || below.slice(4).some(row => row.trim())
    || /^\s*(?:(?:[^\w\s]\s+)?(?:Queued for capacity|Resuming session)\b|│\s*(?:model|directory):\s*loading\b)/im.test(lines.join('\n'))) return undefined;
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

function statusLineSession(footer: string): string | undefined {
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
      const footerSessionId = statusLineSession(footer);
      if (footerSessionId && terminal.cliPid === pid) {
        bindings.set(terminal, { pid, sessionId: footerSessionId });
        return { kind: 'terminal', sessionId: footerSessionId };
      }
    }
  } catch { /* Closed pane or unsupported snapshot: keep the binding unproven. */ }
  return { kind: 'unavailable' };
}
