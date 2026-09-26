import { existsSync, statSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { delay } from '../../utils/timing.js';
import { stripAnsiScreenText } from '../../utils/idle-detector.js';
import type { CliAdapter, PtyHandle, SubmitRecheckResult } from './types.js';
import { CLI_MODEL_CHOICES } from './model-choices.js';
import { discoverAntigravitySessions } from '../../services/resumable-session-discovery.js';
import { findAntigravityConversationId } from '../../services/antigravity-discovery.js';

/**
 * Adapter for Google Antigravity CLI (`agy`).
 *
 *  Binary: `agy` (default install path: `~/.local/bin/agy`).
 *  State dir: `~/.gemini/antigravity-cli/` (Antigravity reuses Gemini CLI's
 *  home, namespaced under that subdir).
 *
 *  Empirical findings (validated against agy 1.0.0 — May 2026 build):
 *
 *    - Boot flags from `agy --help`:
 *        --dangerously-skip-permissions  auto-approve tool calls
 *        --sandbox                       run in OS sandbox
 *        -i / --prompt-interactive       initial prompt baked into args
 *        --conversation <id>             resume by conversation UUID
 *        -c / --continue                 continue most recent conversation
 *        -p / --print                    one-shot non-interactive
 *      The earlier docs page omitted -i / --conversation; --help is the
 *      authoritative source.
 *
 *    - Submit log: `~/.gemini/antigravity-cli/history.jsonl` appends a
 *      line on every Enter:
 *        {"display":"<user input>","timestamp":<ms>,"workspace":"<cwd>"}
 *      Multi-line submits use a literal `\n` inside `display` (JSON-encoded).
 *      Same shape as Codex / CoCo history files → suitable for submit
 *      verification.
 *
 *    - Conversation transcript: `~/.gemini/antigravity-cli/brain/<id>/
 *      .system_generated/logs/transcript.jsonl` (line-delimited JSON, fields:
 *      step_index/source/type/status/created_at/content). Useful for an
 *      `/adopt` bridge later; not consumed for submit verification (the
 *      conversationId rotates per spawn and we don't capture it here).
 *
 *    - Bracketed paste (`\e[200~...\e[201~`) does NOT work: agy treats the
 *      markers as literal text. Use sendText + Enter directly.
 *
 *    - Multi-line: alt+Enter (M-Enter / `\x1b\r`) is documented as soft
 *      newline (along with ctrl+j / shift+enter). Verified — sending
 *      "line1" + M-Enter + "line2" + Enter produces ONE history line with
 *      `display:"line1\nline2"`.
 *
 *  Skills layout note: Antigravity loads SKILL.md only inside plugin
 *  bundles (`plugins/<plugin>/{plugin.json, skills/<name>/SKILL.md}`),
 *  not from a flat `skills/` dir. botmux's installer writes the flat
 *  layout, so `skillsDir` is intentionally undefined; routing guidance
 *  is injected via `systemHints` instead.
 */

const HISTORY_PATH = join(homedir(), '.gemini', 'antigravity-cli', 'history.jsonl');

function currentFileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

/** Build a JSON-escaped prefix marker for substring-matching against
 *  history.jsonl's raw bytes. Three things to keep aligned with agy's
 *  on-disk encoding:
 *
 *    1. Literal `\n` in user content becomes the two-char escape `\n`
 *       (handled by JSON.stringify already).
 *    2. agy is Go and its writer uses encoding/json's default
 *       SetEscapeHTML(true), so `<` / `>` / `&` land as `\u003c` /
 *       `\u003e` / `\u0026` on disk — JS's JSON.stringify does NOT
 *       emit those escapes, so we patch them in manually. Without this,
 *       botmux prompts (which always wrap user text in `<user_message>`
 *       and `<botmux_routing>` tags) would NEVER match and the worker
 *       would always show a spurious "submit not confirmed" warning,
 *       even though the model did receive the prompt.
 *    3. 40 chars is plenty unique even when several bots submit nearly
 *       identical opening lines.
 */
function historyMarker(content: string): string {
  const prefix = content.slice(0, 40);
  return JSON.stringify(prefix)
    .slice(1, -1)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function historyDeltaContains(path: string, fromByte: number, marker: string): boolean {
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
  const delta = buf.toString('utf8');
  // Each line is a self-contained JSON object; we only care that one of them
  // is a `display` field starting with our marker. Don't bother JSON.parse —
  // raw substring on the encoded form is sufficient and robust against
  // partial trailing writes.
  for (const line of delta.split('\n')) {
    if (!line.includes(`"display":"${marker}`)) continue;
    return true;
  }
  return false;
}

const HISTORY_POLL_MS = 100;

async function waitForHistoryAppend(
  path: string, fromByte: number, marker: string, timeoutMs: number,
): Promise<boolean> {
  // Count poll attempts, don't use Date.now()+budget. Under load the event
  // loop slips; a wall deadline expires while `delay()` callbacks are still
  // queued, so a history line that landed in-budget is missed and the
  // worker shows a false "submit not confirmed". Same number of delay(100)
  // waits as the unscaled timeout.
  const polls = Math.max(1, Math.round(timeoutMs / HISTORY_POLL_MS));
  for (let i = 0; i < polls; i++) {
    if (historyDeltaContains(path, fromByte, marker)) return true;
    await delay(HISTORY_POLL_MS);
  }
  return historyDeltaContains(path, fromByte, marker);
}

/** Cancellation can leave the transcript at a tool result forever. Accept only
 * the CLI's explicit interruption notice followed immediately by an EMPTY
 * composer and its ready footer at the end of the current viewport. Old notices
 * in scrollback, a newer prompt, or a running status must not release input. */
export function isAntigravityInterruptedScreen(screen: string): boolean {
  // tmux captureViewport preserves SGR colors and normalizes rows to CRLF;
  // the PTY renderer already returns plain LF rows. Accept both backends.
  const plain = stripAnsiScreenText(screen).replace(/\r\n/g, '\n');
  if (/esc to cancel/i.test(plain)) return false;
  // Walk rows once instead of matching nested whitespace repetitions against
  // a whole screen (which can backtrack exponentially on blank rows).
  const rows = plain.split('\n').map(row => row.trim());
  let end = rows.length;
  const skipBlankRows = (): void => {
    while (end > 0 && rows[end - 1] === '') end--;
  };
  const skipSeparators = (): void => {
    // PTY rawSnapshot's display cleanup replaces box-drawing rows with blanks;
    // tmux retains them. Both must preserve the same three semantic rows.
    while (end > 0 && /^[─━]*$/.test(rows[end - 1])) end--;
  };
  skipBlankRows();
  if (end === 0 || !/^\? for shortcuts(?:\s|$)/.test(rows[--end])) return false;
  skipSeparators();
  if (end === 0 || rows[--end] !== '>') return false;
  skipSeparators();
  if (end === 0) return false;
  return /^⎿[ \t]+Interrupted · What should Antigravity CLI do instead\?$/.test(rows[end - 1]);
}

export function isAntigravityTranscriptBusy(transcriptPath: string): boolean {
  if (!existsSync(transcriptPath)) return false;
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      const stats = fstatSync(fd);
      if (stats.size === 0) return false;

      // Expand until a lifecycle record is found. A complete checkpoint or
      // notification is not enough: the preceding tool call may be truncated
      // at this window's start and still needs a larger read.
      let chunkSize = Math.min(stats.size, 64 * 1024);

      while (chunkSize <= stats.size) {
        const buf = Buffer.alloc(chunkSize);
        readSync(fd, buf, 0, chunkSize, stats.size - chunkSize);
        const text = buf.toString('utf-8');
        const rawLines = text.split('\n');
        const candidateLines = stats.size > chunkSize ? rawLines.slice(1) : rawLines;
        for (let i = candidateLines.length - 1; i >= 0; i--) {
          const line = candidateLines[i].trim();
          if (!line) continue;
          let rec: any;
          try {
            rec = JSON.parse(line);
          } catch {
            continue;
          }

          const type = rec?.type;
          if (type === 'ERROR_MESSAGE' || type === 'ERROR') {
            return false;
          }
          if (type === 'SYSTEM_MESSAGE') {
            const content = String(rec?.content ?? '');
            if (/cancell?ed|interrupted|aborted/i.test(content)) {
              return false;
            }
            // Non-cancel notifications do not dictate lifecycle state.
            continue;
          }
          if (type === 'CHECKPOINT' || type === 'TASK_NOTIFICATION') {
            continue;
          }
          if (type === 'PLANNER_RESPONSE') {
            return Array.isArray(rec.tool_calls) && rec.tool_calls.length > 0;
          }
          if (type === 'GENERIC' || type === 'USER_INPUT') {
            return true;
          }
        }
        if (chunkSize >= stats.size || chunkSize >= 1024 * 1024) break;
        chunkSize = Math.min(stats.size, chunkSize * 4);
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  return false;
}

export function createAntigravityAdapter(pathOverride?: string): CliAdapter {
  // resolvedBin is lazy: setup constructs adapters only to read static
  // modelChoices and must not shell out (see resolveCommand); the binary path
  // is a spawn-time concern.
  const rawBin = pathOverride ?? 'agy';
  let cachedBin: string | undefined;
  return {
    id: 'antigravity',
    authPaths: ['~/.gemini/oauth_creds.json', '~/.gemini/antigravity-cli/antigravity-oauth-token'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },
    modelChoices: CLI_MODEL_CHOICES['antigravity'],

    buildArgs({ resume, resumeSessionId, disableCliBypass, model, reasoningEffort }) {
      const args = disableCliBypass ? [] : ['--dangerously-skip-permissions'];
      // Resume: only when we have agy's own conversation UUID. We never
      // map botmux's sessionId here because agy generates its own id at
      // spawn time and ignores any value we'd pass — `--conversation`
      // strictly looks up an existing one. Without a stored cliSessionId,
      // start fresh; do NOT use `-c/--continue` because "most recent" is
      // racy when multiple botmux sessions run in parallel.
      if (resume && resumeSessionId) {
        args.push('--conversation', resumeSessionId);
      }
      if (model && typeof model === 'string' && model.trim()) {
        args.push('--model', model.trim());
      }
      if (reasoningEffort && (reasoningEffort === 'low' || reasoningEffort === 'medium' || reasoningEffort === 'high')) {
        args.push('--effort', reasoningEffort);
      }
      // NOTE: we deliberately do NOT pass `-i` / `--prompt-interactive`.
      // Despite the flag's existence in `agy --help`, empirical testing
      // shows that:
      //   (a) -i prompts do NOT auto-submit (unlike Gemini's -i)
      //   (b) -i prompts do NOT appear in history.jsonl, so we can't even
      //       confirm submission through our usual marker channel
      //   (c) a follow-up Enter does not finish the deposit either
      // Treating -i as the initial-prompt channel would cause the worker
      // to skip stdin-injection (passesInitialPromptViaArgs=true), and
      // the user's first message would silently disappear. Instead, the
      // worker queues the prompt and writeInput delivers it after idle
      // — same pattern as cursor/aiden. */
      return args;
    },

    buildResumeCommand({ cliSessionId }) {
      // Antigravity's conversation id is opaque and not derivable from
      // botmux's sessionId. Without a captured cliSessionId we can't print
      // a precise one-liner, so let the closed-session card fall back to
      // its generic note. v1 does not capture cliSessionId — added in a
      // later iteration once we wire conversation-id discovery against
      // ~/.gemini/antigravity-cli/conversations/.
      if (!cliSessionId) return null;
      return `agy --conversation ${cliSessionId}`;
    },

    /** Import path: the submit log `~/.gemini/antigravity-cli/history.jsonl`
     *  records `{display, timestamp, workspace, conversationId}` per submit —
     *  enough to discover resumable conversations (deduped by conversationId). */
    listResumableSessions({ limit, exclude }) {
      return discoverAntigravitySessions(HISTORY_PATH, limit, exclude);
    },

    async writeInput(pty: PtyHandle, content: string) {
      // Two known constraints (verified empirically):
      //
      // 1. Bracketed paste (`\e[200~...\e[201~`) doesn't work — agy treats
      //    the markers as literal characters. So we type each line via
      //    `send-keys -l` (sendText) and use M-Enter (alt+Enter) between
      //    lines as the documented soft-newline. Trailing plain Enter is
      //    the unambiguous submit.
      //
      // 2. agy logs every submit to ~/.gemini/antigravity-cli/history.jsonl
      //    as `{"display":"...","timestamp":...,"workspace":"..."}` —
      //    same pattern as Codex/CoCo. We poll the delta past `baseByte`
      //    for our `display` prefix marker. If unseen after the in-band
      //    poll budget, return {submitted:false, recheck} so the worker
      //    can warn the user.
      const baseByte = currentFileSize(HISTORY_PATH);
      const marker = historyMarker(content);

      const trySendEnter = (): boolean => {
        try {
          if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
          else pty.write('\r');
          return true;
        } catch {
          // tmux session gone (CLI exited mid-write) — bail cleanly rather
          // than crashing the worker on an unhandled execFileSync error.
          return false;
        }
      };

      try {
        if (pty.sendText && pty.sendSpecialKeys) {
          const lines = content.split('\n');
          if (typeof pty.sendLines === 'function') {
            const BATCH_SIZE = 40;
            for (let i = 0; i < lines.length; i += BATCH_SIZE) {
              const chunk = lines.slice(i, i + BATCH_SIZE);
              pty.sendLines(chunk, 'M-Enter');
              if (i + BATCH_SIZE < lines.length) {
                pty.sendSpecialKeys('M-Enter');
              }
              await delay(10);
            }
          } else {
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].length > 0) pty.sendText(lines[i]);
              if (i < lines.length - 1) {
                pty.sendSpecialKeys('M-Enter');
              }
              await delay(10);
            }
          }
        } else {
          // Raw PTY fallback (no tmux): write text directly with ESC+\r
          // for soft newlines.
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            pty.write(lines[i]);
            if (i < lines.length - 1) pty.write('\x1b\r');
            await delay(10);
          }
        }
      } catch {
        return { submitted: false };
      }

      await delay(300);
      if (!trySendEnter()) return { submitted: false };

      // Single Enter only — do NOT retry it. agy's history.jsonl append can
      // lag well past a short per-attempt window (cold start, large initial
      // prompt, network-bound auth), and a retry Enter lands on the
      // already-submitted composer: the same prompt then gets submitted
      // multiple times. Poll history once for the full in-band budget; a
      // genuinely dropped Enter is recovered by the worker's deferred
      // recheck, not by a second Enter (same pattern as the grok adapter).
      if (await waitForHistoryAppend(HISTORY_PATH, baseByte, marker, 3_200)) {
        const cliSessionId = findAntigravityConversationId({ pid: pty.cliPid, cwd: pty.cliCwd });
        return cliSessionId ? { submitted: true, cliSessionId } : undefined;
      }

      // In-band budget exhausted. Hand the worker a recheck closure so a
      // slow agy (cold start, large initial prompt, network-bound auth)
      // can still resolve the warning before user-facing Lark notify.
      const recheck = (): SubmitRecheckResult => {
        if (!historyDeltaContains(HISTORY_PATH, baseByte, marker)) return false;
        const cliSessionId = findAntigravityConversationId({ pid: pty.cliPid, cwd: pty.cliCwd });
        return cliSessionId ? { submitted: true, cliSessionId } : true;
      };
      return { submitted: false, recheck };
    },

    completionPattern: undefined,
    readyPattern: /\? for shortcuts/,
    busyPattern: /esc to cancel/,
    isSessionBusy({ cliSessionId, getCurrentScreen }) {
      if (!cliSessionId) return false;
      const transcriptPath = join(homedir(), '.gemini', 'antigravity-cli', 'brain', cliSessionId, '.system_generated', 'logs', 'transcript.jsonl');
      if (!isAntigravityTranscriptBusy(transcriptPath)) return false;
      try {
        if (getCurrentScreen && isAntigravityInterruptedScreen(getCurrentScreen())) return false;
      } catch { /* Missing viewport is not evidence of cancellation. */ }
      return true;
    },
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,
  };
}

export const create = createAntigravityAdapter;
