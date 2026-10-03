import type { PtyHandle } from '../adapters/cli/types.js';
import { findCodexRolloutSetByPid } from './codex-transcript.js';
import { codexConfigPathForPid, ensureCodexStatusLineConfig, type CodexStatusLineSetup } from './codex-statusline-config.js';
import { stripAnsiScreenText } from '../utils/idle-detector.js';
import { detectCodexComposerState } from './codex-composer-state.js';

type Resolution =
  | { kind: 'legacy' }
  | { kind: 'terminal'; sessionId: string }
  | { kind: 'unavailable' };

// Scope evidence to a backend generation, never to CODEX_HOME or the daemon.
const bindings = new WeakMap<PtyHandle, { pid: number; sessionId: string }>();
const pending = new WeakMap<PtyHandle, Promise<Resolution>>();
const configured = new WeakMap<PtyHandle, { pid: number; setup: CodexStatusLineSetup }>();

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
  const prompt = /^(\s*)› (?:Ask Codex to do anything)?\s*$/.exec(line);
  if (!prompt || state.cursor.x !== (prompt[1]?.length ?? 0) + 2) return undefined;
  // Match native state rows, not words inside transcript prose or tool output.
  const below = lines.slice(state.cursor.y + 1);
  // Both layouts are native: an inline status/hints row, or a separate status
  // row followed by hints. Stay in the adjacent footer band, never scrollback.
  const footer = below.slice(0, 4).filter(row => row.trim());
  if (footer.length < 1 || footer.length > 2 || below.slice(4).some(row => row.trim())
    || /^\s*(?:(?:[^\w\s]\s+)?(?:Queued for capacity|Resuming session)\b|│\s*(?:model|directory):\s*loading\b)/im.test(lines.join('\n'))) return undefined;
  if (footer.length === 2 && !/^\s*(?:← for agents|\? for shortcuts|esc to interrupt|tab to queue)\b/.test(footer[1] ?? '')) return undefined;
  return footer.map(row => row.trim()).join('\n');
}

function statusLineSession(footer: string): string | undefined {
  // Codex's native `thread-id` status-line item (legacy alias `session-id`)
  // renders the full UUID as a separate segment. Read only the live footer:
  // UUIDs in scrollback, pasted drafts, and old /status cards are not evidence.
  const ids = footer.split(/\n|\s+·\s+/)
    // Busy spinners are plain braille characters, not ANSI escapes. Only strip
    // that known decoration at segment boundaries; /tmp/<uuid> is not an ID.
    .map(segment => segment.replace(/^[\s\u2800-\u28ff]+|[\s\u2800-\u28ff]+$/g, ''))
    .filter(segment =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment),
    );
  return ids.length === 1 ? ids[0]?.toLowerCase() : undefined;
}

/**
 * Older/embedded TUIs own their rollout fds. Shared-daemon TUIs do not, and
 * daemon fds include unrelated panes. Read the original TUI's live thread-id
 * footer without writing commands into the conversation. Refresh on every
 * submission to follow local thread switches. If identity cannot be proven,
 * callers must stop before writing the prompt and explain how to expose it.
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
    if (footer === undefined) return { kind: 'unavailable' };
    const footerSessionId = statusLineSession(footer);
    if (footerSessionId && terminal.cliPid === pid) {
      bindings.set(terminal, { pid, sessionId: footerSessionId });
      return { kind: 'terminal', sessionId: footerSessionId };
    }
  } catch { /* Closed pane or unsupported snapshot: keep the binding unproven. */ }
  return { kind: 'unavailable' };
}

/** One setup per backend generation; failures remain retryable. No TUI writes. */
export function prepareCodexTerminalStatusLine(terminal: PtyHandle): CodexStatusLineSetup | undefined {
  const pid = terminal.cliPid;
  if (!pid || terminal.expectedCodexSessionId) return undefined;
  try {
    const footer = emptyComposerFooter(terminal);
    if (footer === undefined || statusLineSession(footer)) return undefined;
    const previous = configured.get(terminal);
    if (previous?.pid === pid) return previous.setup;
    const path = codexConfigPathForPid(pid);
    const setup: CodexStatusLineSetup = path && terminal.cliPid === pid
      ? ensureCodexStatusLineConfig(path) : { kind: 'failed' };
    if (setup.kind !== 'failed') configured.set(terminal, { pid, setup });
    return setup;
  } catch { return { kind: 'failed' }; }
}
