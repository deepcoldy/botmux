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

function deltaContains(path: string, fromByte: number, marker: string): boolean {
  if (!existsSync(path)) return false;
  let size: number;
  try { size = statSync(path).size; } catch { return false; }
  if (size <= fromByte) return false;
  const len = size - fromByte;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, fromByte);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8').includes(marker);
}

async function waitForHistoryAppend(
  path: string, fromByte: number, marker: string, timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (deltaContains(path, fromByte, marker)) return true;
    await delay(100);
  }
  return false;
}

/** Build a JSON-escaped prefix of the content so substring-match against the
 *  raw history.jsonl file content (where text fields store \n as the two-char
 *  escape `\n`, not a literal newline) finds our line. The prefix length is
 *  chosen to be unique-enough even when two bots submit near-identical text. */
function historyMarker(content: string): string {
  const prefix = content.slice(0, 40);
  return JSON.stringify(prefix).slice(1, -1);  // strip surrounding quotes
}

export function createCodexAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'codex');
  return {
    id: 'codex',
    resolvedBin: bin,

    buildArgs() {
      // Codex manages its own session IDs internally — we cannot pass ours.
      // Resume is not supported; daemon always starts a fresh Codex session.
      return [
        '--dangerously-bypass-approvals-and-sandbox',
        '--no-alt-screen',
      ];
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
        if (await waitForHistoryAppend(HISTORY_PATH, baseByte, marker, 800)) return;
        if (!trySendEnter()) return { submitted: false };
      }
      if (await waitForHistoryAppend(HISTORY_PATH, baseByte, marker, 800)) return;
      return { submitted: false };
    },

    completionPattern: undefined,
    readyPattern: /›|\d+% left/,  // › for input box, or status bar pattern (e.g. "97% left")
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: false,   // --no-alt-screen disables alternate screen
  };
}

export const create = createCodexAdapter;
