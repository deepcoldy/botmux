import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

/** Global submit log — Codex appends one JSON line here on every successful
 *  user submit across all sessions. Far better than the per-session rollout
 *  file, which Codex creates lazily at the first submit (chicken-and-egg:
 *  you can't use it to verify the *first* submit that we're trying to fix). */
const HISTORY_PATH = join(homedir(), '.codex', 'history.jsonl');

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function currentFileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

interface HistoryMatch {
  found: boolean;
  cliSessionId?: string;
}

function matchHistoryDelta(path: string, fromByte: number, marker: string): HistoryMatch {
  if (!existsSync(path)) return { found: false };
  let size: number;
  try { size = statSync(path).size; } catch { return { found: false }; }
  if (size <= fromByte) return { found: false };
  const len = size - fromByte;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, fromByte);
  } finally {
    closeSync(fd);
  }
  const delta = buf.toString('utf8');
  for (const line of delta.split('\n')) {
    if (!line.includes(marker)) continue;
    try {
      const parsed = JSON.parse(line);
      return {
        found: true,
        cliSessionId: typeof parsed.session_id === 'string' ? parsed.session_id : undefined,
      };
    } catch {
      return { found: true };
    }
  }
  return { found: false };
}

async function waitForHistoryAppend(
  path: string, fromByte: number, marker: string, timeoutMs: number,
): Promise<HistoryMatch> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = matchHistoryDelta(path, fromByte, marker);
    if (match.found) return match;
    await delay(100);
  }
  return { found: false };
}

/** Build a JSON-escaped prefix of the content so substring-match against the
 *  raw history.jsonl file content (where text fields store \n as the two-char
 *  escape `\n`, not a literal newline) finds our line. The prefix length is
 *  chosen to be unique-enough even when two bots submit near-identical text. */
function historyMarker(content: string): string {
  const prefix = content.slice(0, 40);
  return JSON.stringify(prefix).slice(1, -1);  // strip surrounding quotes
}

function latestCodexSessionForBotmuxSession(botmuxSessionId: string): string | undefined {
  if (!existsSync(HISTORY_PATH)) return undefined;
  try {
    const size = statSync(HISTORY_PATH).size;
    const fd = openSync(HISTORY_PATH, 'r');
    const buf = Buffer.alloc(size);
    try {
      readSync(fd, buf, 0, size, 0);
    } finally {
      closeSync(fd);
    }
    const marker = JSON.stringify(botmuxSessionId).slice(1, -1);
    const lines = buf.toString('utf8').trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes(marker)) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.session_id === 'string') return parsed.session_id;
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function createCodexAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'codex');
  return {
    id: 'codex',
    resolvedBin: bin,

    buildArgs({ sessionId, resume, resumeSessionId }) {
      const baseArgs = [
        '--dangerously-bypass-approvals-and-sandbox',
        '--no-alt-screen',
      ];
      if (!resume) return baseArgs;

      const codexSessionId = resumeSessionId ?? latestCodexSessionForBotmuxSession(sessionId);
      if (!codexSessionId) return baseArgs;
      return ['resume', ...baseArgs, codexSessionId];
    },

    async writeInput(pty: PtyHandle, content: string) {
      // Codex's TUI in --no-alt-screen mode does NOT handle bracketed paste:
      // wrapping content in \x1b[200~...\x1b[201~ via tmux paste-buffer
      // makes Codex exit cleanly (code 0) — it parses the ESC as an abort.
      // So we stick with the older `send-keys -l` raw-stream path that has
      // worked historically.
      //
      // Known limitation: Codex's input mode treats every \n as Enter, so a
      // multi-line burst submits one-line fragments until Codex's internal
      // paste-detection finally kicks in — visible as e.g. the tail of
      // "Session ID: <uuid>" stranded in the input box. The verification
      // loop below catches that case (the full content prefix never appears
      // in history.jsonl) and surfaces it via user_notify rather than
      // silently dropping the message.
      const trySendEnter = (): boolean => {
        try {
          if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
          else pty.write('\r');
          return true;
        } catch {
          // tmux session is gone (CLI exited mid-write) — bail out cleanly
          // rather than crashing the worker on an unhandled execFileSync error.
          return false;
        }
      };

      const baseByte = currentFileSize(HISTORY_PATH);
      const marker = historyMarker(content);

      try {
        if (pty.sendText) pty.sendText(content);
        else pty.write(content);
      } catch {
        return { submitted: false };
      }
      await delay(200);
      if (!trySendEnter()) return { submitted: false };

      for (let attempt = 0; attempt < 3; attempt++) {
        const match = await waitForHistoryAppend(HISTORY_PATH, baseByte, marker, 800);
        if (match.found) {
          return match.cliSessionId
            ? { submitted: true, cliSessionId: match.cliSessionId }
            : undefined;
        }
        if (!trySendEnter()) return { submitted: false };
      }
      const match = await waitForHistoryAppend(HISTORY_PATH, baseByte, marker, 800);
      if (match.found) {
        return match.cliSessionId
          ? { submitted: true, cliSessionId: match.cliSessionId }
          : undefined;
      }
      return { submitted: false };
    },

    completionPattern: undefined,
    readyPattern: /›|\d+% left/,  // › for input box, or status bar pattern (e.g. "97% left")
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: false,   // --no-alt-screen disables alternate screen
  };
}

export const create = createCodexAdapter;
