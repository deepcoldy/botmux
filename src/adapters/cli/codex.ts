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

    buildArgs({ sessionId, resume, resumeSessionId, workingDir, model, disableCliBypass }) {
      const baseArgs = [
        ...(!disableCliBypass ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
        '--no-alt-screen',
      ];
      if (model && model.trim()) {
        // Codex 接受 `--model <id>` / `-m <id>`，写全名最稳，错的会在 codex 自己启动时报。
        baseArgs.push('--model', model.trim());
      }
      // Codex app-server can keep its own cwd at $HOME; -C pins fresh agent roots.
      const freshArgs = workingDir
        ? [...baseArgs, '-C', workingDir]
        : baseArgs;
      if (!resume) return freshArgs;

      const codexSessionId = resumeSessionId ?? latestCodexSessionForBotmuxSession(sessionId);
      if (!codexSessionId) return freshArgs;
      return ['resume', ...baseArgs, codexSessionId];
    },

    buildResumeCommand({ sessionId, cliSessionId }) {
      // Codex's `resume` is a subcommand (not a flag) and takes Codex's own
      // UUID, not the botmux sessionId. Prefer the persisted cliSessionId;
      // fall back to scanning ~/.codex/history.jsonl for the most recent
      // codex session id that referenced this botmux session.
      const sid = cliSessionId ?? latestCodexSessionForBotmuxSession(sessionId);
      if (!sid) return null;
      return `codex resume ${sid}`;
    },

    async writeInput(pty: PtyHandle, content: string) {
      // Codex's input mode treats every literal \n as Enter. The old path
      // (`send-keys -l` with the whole multi-line blob) therefore submitted
      // each line as its own turn — a single Lark message fragmented into
      // several user messages / "Queued follow-up inputs" in the TUI, and a
      // literal \t in the content also leaked through as a Tab keystroke.
      //
      // Fix: bracketed paste, same as coco.ts. tmux `load-buffer` +
      // `paste-buffer -d -p` wraps the content in \x1b[200~...\x1b[201~ when
      // the pane has bracketed paste on (Codex enables it), so embedded \n
      // stay content and only the trailing Enter after the delay submits.
      // The old "Codex exits on bracketed paste (parses ESC as abort)" note
      // was true for a much earlier build; verified on codex 0.134.0 that a
      // bracketed paste lands the whole multi-line message in the composer
      // un-submitted, with the process staying alive and \t absorbed cleanly.
      //
      // The history.jsonl verification loop below is unchanged: it polls for
      // the submitted prefix and, if it never appears, surfaces the failure
      // via the worker's deferred recheck + Lark warning rather than silently
      // dropping the message.
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
        if (pty.pasteText) {
          // tmux mode: load-buffer + paste-buffer -d -p. The `-p` flag emits
          // bracketed-paste markers when the pane has them on (Codex default);
          // `-d` deletes the buffer after so it doesn't accumulate.
          pty.pasteText(content);
        } else {
          // Non-tmux fallback (raw PTY): wrap the markers ourselves.
          pty.write('\x1b[200~' + content + '\x1b[201~');
        }
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
      // In-band budget exhausted. Hand the worker a recheck closure: a
      // slow-startup Codex (or one whose first turn is delayed by a heavy
      // initial prompt) may still append our marker after the retries gave
      // up, and the worker re-scans on a delay before warning the user.
      const recheck = (): boolean => matchHistoryDelta(HISTORY_PATH, baseByte, marker).found;
      return { submitted: false, recheck };
    },

    completionPattern: undefined,
    readyPattern: /›|\d+% left/,  // › for input box, or status bar pattern (e.g. "97% left")
    systemHints: BOTMUX_SHELL_HINTS,
    // Codex 0.134.0+ accepts a message while the current turn is still running:
    // it parks it ("Messages to be submitted after next tool call") via an
    // active-turn STEER, not a deferred next-turn submit. Two rollout shapes
    // result (both verified empirically on codex-cli 0.134.0):
    //   - turn with no tool_call: the queued user event is written when the turn
    //     ends → interleaved user1 → asstFinal1 → user2 → asstFinal2.
    //   - turn with a tool_call: the queued input is steered into the SAME turn
    //     and codex emits ONE merged final → user1 → user2 → assistant_final.
    // CodexBridgeQueue handles both via HOL-block-drop (a user event arriving
    // while the collecting turn has no finalText discards that turn), so the
    // merge case attributes the combined reply to the last steered turn instead
    // of wedging the queue. The submit log history.jsonl IS written at submit
    // time even for a parked message, so writeInput's verification confirms the
    // submit immediately and never spuriously reports a mid-turn send failure.
    supportsTypeAhead: true,
    altScreen: false,   // --no-alt-screen disables alternate screen
    modelChoices: ['gpt-5', 'gpt-5-codex', 'o3', 'o3-mini'],
  };
}

export const create = createCodexAdapter;
