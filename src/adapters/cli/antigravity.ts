import { detectModelsViaExec } from './model-catalog-json.js';
import { parseAntigravityModels } from './antigravity-models.js';
import { existsSync, statSync, openSync, readSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCommand } from './registry.js';
import { statuslineHookCommand } from '../hook-command.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { delay, scaleMs } from '../../utils/timing.js';
import { wrapBracketedPaste } from './tui-input.js';
import { stripAnsiScreenText } from '../../utils/idle-detector.js';
import type { CliUsageLimitState } from '../../utils/cli-usage-limit.js';
import type { CliAdapter, PtyHandle, SubmitRecheckResult, StructuredBridgeSpec } from './types.js';
import { CLI_MODEL_CHOICES } from './model-choices.js';
import { discoverAntigravitySessions } from '../../services/resumable-session-discovery.js';
import { findAntigravityConversationId, findAntigravityConversationIdByPid } from '../../services/antigravity-discovery.js';
import { AntigravitySessionLog, forkAntigravitySession } from '../../services/antigravity-session-fork.js';
import {
  drainAntigravityTranscript,
  antigravityFullTranscriptPath,
  antigravityTranscriptPath,
  resolveAntigravityTranscriptPath,
  type AntigravityTranscriptState,
} from '../../services/antigravity-transcript.js';

/**
 * Adapter for Google Antigravity CLI (`agy`).
 *
 *  Binary: `agy` (default install path: `~/.local/bin/agy`).
 *  State dir: `~/.gemini/antigravity-cli/` (Antigravity reuses the ~/.gemini
 *  home that Gemini CLI used, namespaced under that subdir).
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
 *      .system_generated/logs/transcript_full.jsonl` (line-delimited JSON,
 *      fields: step_index/source/type/status/created_at/content), next to a
 *      compact `transcript.jsonl` that cuts long fields (see
 *      services/antigravity-transcript.ts). Not consumed for submit
 *      verification (the conversationId rotates per spawn and we don't
 *      capture it here).
 *
 *    - Bracketed paste (`\e[200~...\e[201~`) does NOT work: agy treats the
 *      markers as literal text. Use sendText + Enter directly.
 *
 *    - Multi-line: alt+Enter (M-Enter / `\x1b\r`) is documented as soft
 *      newline (along with ctrl+j / shift+enter). Verified — sending
 *      "line1" + M-Enter + "line2" + Enter produces ONE history line with
 *      `display:"line1\nline2"`.
 *
 *  Skills: agy 1.5.x discovers global skills from `~/.gemini/config/skills/
 *  <name>/SKILL.md` (listed under "Available skills" in its system prompt,
 *  verified on 1.5.12; 1.0.0 only loaded plugin bundles). That is `skillsDir`,
 *  so the built-in catalog — botmux-ask included — reaches agy sessions the
 *  same way as codex/opencode (prompt mode by default, files in global mode).
 *
 *  Questions to the user (agy 1.5.12):
 *    - `ask_question` (main agent and subagents) is taken over by a
 *      PreToolUse hook in `~/.gemini/config/hooks.json` (hook-installer
 *      `antigravity-hooks`, core/ask-hook/antigravity.ts): a Lark question
 *      card, the answer back as the hook's deny reason; the picker never
 *      opens. botmux-ask stays installed as the fallback for when the hook
 *      cannot take it (it fails open to agy's own picker).
 *    - agy's own pickers that can still come up — the question picker
 *      (hook unavailable) and the tool permission dialog — are the
 *      `antigravity` stuck-page family: queued input and raw passthrough
 *      commands are held off them (utils/antigravity-blocking-page.ts).
 *    - A plan artifact with RequestFeedback does not block the composer: agy
 *      only shows "N artifact · /artifact to review" in its footer, and the
 *      next message reaches the model.
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

/** Only the four native permission placeholders prove an empty composer.
 * Allow terminal line wrapping (including a split inside a word), but never
 * accept an arbitrary draft just because it ends with the shortcut hint. */
const COMPOSER_PLACEHOLDERS = [
  'Auto mode: edits & safe commands auto-approved (shift+tab to cycle)',
  'Accept-edits mode: file edits auto-approved (shift+tab to cycle)',
  'Plan mode: research & plan only (shift+tab to cycle)',
  'Best-of-N mode: fork into parallel arms and pick a winner (shift+tab to cycle)',
];
const wrappedPlaceholder = (text: string): string => text.split(' ').map(word =>
  [...word].map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(?:[ \t]*\\r?\\n[ \t]*)?'),
).join('[ \t\\r\\n]+');
const EMPTY_COMPOSER_ROW = new RegExp(`(?:>|> (?:${COMPOSER_PLACEHOLDERS.map(wrappedPlaceholder).join('|')}))`);

function isEmptyComposerRow(row: string): boolean {
  return new RegExp(`^${EMPTY_COMPOSER_ROW.source}$`).test(row);
}

// Native agy errors end at an empty composer without the normal shortcuts
// footer. Error ID anchors this to the CLI's error layout, rather than any
// bare `>` in tool output, a draft or a permission menu.
const ERROR_COMPOSER_PATTERN = new RegExp(`(?:^|\\n)[ \\t]*Error ID:[ \\t]*[a-zA-Z0-9][a-zA-Z0-9-]*[ \\t]*\\r?\\n[─━ \\t\\r\\n]*${EMPTY_COMPOSER_ROW.source}[ \\t]*(?:\\r?\\n[─━ \\t]*)*$`);

/** An agy task footer is positive work evidence; unrelated PTY/syslog output
 * alone is not proof that a native quota refusal recovered. */
export function isAntigravityWorkingScreen(screen: string): boolean {
  return /(?:^|\n)[ \t]*esc to cancel(?:\s|$)/i.test(stripAnsiScreenText(screen));
}

/** Preserve provenance only for the CLI's own quota/error/composer layout,
 * not generic quota-shaped text in model/tool output. */
export function annotateAntigravityUsageLimit(screen: string, state: CliUsageLimitState): CliUsageLimitState {
  const plain = stripAnsiScreenText(screen).replace(/\r\n/g, '\n');
  const match = ERROR_COMPOSER_PATTERN.exec(plain);
  if (!match || /esc to cancel/i.test(plain)) return state;
  const rows = plain.slice(0, match.index).trimEnd().split('\n');
  for (let i = rows.length - 1; i >= Math.max(0, rows.length - 8); i--) {
    const row = rows[i]!;
    if (/^⚠(?:️)?[ \t]*Individual quota reached\./.test(row)) {
      return { ...state, source: 'antigravity-error-composer' };
    }
    if (/^[ \t]*(?:⚠|Error ID:|>|●)/.test(row)) return state;
  }
  return state;
}

export const ANTIGRAVITY_QUOTA_HISTORY_LIMIT = 32;

/** 保留最近首次见到的原生拒绝，重复帧既不改截止时间，也不改变淘汰顺序 */
export function rememberAntigravityQuota(
  history: readonly CliUsageLimitState[] | undefined,
  state: CliUsageLimitState,
): readonly CliUsageLimitState[] | undefined {
  const key = state.relativeResetKey;
  if (state.source !== 'antigravity-error-composer' || !key || history?.some(entry => entry.relativeResetKey === key)) {
    return history;
  }
  return [...(history?.slice(1 - ANTIGRAVITY_QUOTA_HISTORY_LIMIT) ?? []), state];
}

/** Walk the tail of a viewport (ready footer → separators → composer) and
 *  decide whether agy is parked at an EMPTY composer with its ready footer —
 *  i.e. the live TUI is demonstrably waiting for input. Returns the index of
 *  the row immediately above the composer block, or undefined when the tail does not
 *  match. One walk shared by the interruption and generic idle-composer
 *  classifiers. */
function readyComposerRowAbove(plain: string): number | undefined {
  const rows = plain.split('\n').map(row => row.trim());
  let end = rows.length;
  const skipBlankRows = (): void => {
    while (end > 0 && rows[end - 1] === '') end--;
  };
  const skipSeparators = (): void => {
    // PTY rawSnapshot's display cleanup replaces box-drawing rows with blanks;
    // the /^[─━]*$/ form matches those emptied rows too.
    while (end > 0 && /^[─━]*$/.test(rows[end - 1])) end--;
  };
  skipBlankRows();
  if (end === 0 || !/^\? for shortcuts(?:\s|$)/.test(rows[--end])) return undefined;
  skipSeparators();
  const composerEnd = end;
  // A wrapped placeholder ends above the separator; walk back only within
  // that composer block, without consuming earlier output or a draft prompt.
  while (end > 0 && !rows[end - 1]!.startsWith('>') && !/^[─━]*$/.test(rows[end - 1]!)) end--;
  if (end === 0 || !isEmptyComposerRow(rows.slice(--end, composerEnd).join('\n'))) return undefined;
  skipSeparators();
  return end - 1;
}

/** 正常输入框及快捷键页脚证明旧额度错误已退出；原生错误输入框没有此页脚。
 * 只检查当前视口尾部，不能用历史里的输入框证明当前状态。 */
export function isAntigravityReadyComposerScreen(screen: string): boolean {
  const plain = stripAnsiScreenText(screen).replace(/\r\n/g, '\n');
  return !isAntigravityWorkingScreen(plain) && readyComposerRowAbove(plain) !== undefined;
}

/** The normal composer still accepts /btw while agy's main turn is running. */
export function hasAntigravitySideQuestionComposer(screen: string): boolean {
  const plain = stripAnsiScreenText(screen).replace(/\r\n/g, '\n')
    .replace(/^([ \t]*)esc to cancel(?=\s|$)/gim, '$1? for shortcuts');
  return readyComposerRowAbove(plain) !== undefined
    && !/^[ \t]*┃.*Enter\/Esc to cancel/im.test(plain);
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
  const rowAbove = readyComposerRowAbove(plain);
  if (rowAbove === undefined || rowAbove < 0) return false;
  return /^⎿[ \t]+Interrupted · What should Antigravity CLI do instead\?$/.test(plain.split('\n').map(row => row.trim())[rowAbove]);
}

/** The live viewport ends at an empty composer + ready footer, with no
 *  in-flight generation marker — regardless of whether an explicit
 *  "Interrupted" notice was rendered. A resumed conversation (e.g. after
 *  /close) can be parked at a fresh prompt while its transcript.jsonl still
 *  ends in a dangling USER_INPUT / PLANNER_RESPONSE(tool_calls) record from
 *  the killed turn; the transcript-only heuristic would then read "busy"
 *  forever and never release queued input. A ready composer alone cannot distinguish
 *  that stale tail from a live turn accepting type-ahead. */
export function isAntigravityIdleComposerScreen(screen: string): boolean {
  const plain = stripAnsiScreenText(screen).replace(/\r\n/g, '\n');
  if (/esc to cancel/i.test(plain)) return false;
  return readyComposerRowAbove(plain) !== undefined || ERROR_COMPOSER_PATTERN.test(plain);
}

/** Lifecycle readers need the freshest record, not the richest content. Agy
 * writes compact first and full 0–3ms later, so compact is authoritative for
 * turn progress; full is only a fallback for builds/files without compact. */
function resolveAntigravityBusyTranscriptPath(conversationId: string): string | null {
  const compact = antigravityTranscriptPath(conversationId);
  if (compact && existsSync(compact)) return compact;
  const full = antigravityFullTranscriptPath(conversationId);
  return full && existsSync(full) ? full : null;
}

/** Compact keeps the first/last ~2KiB of long values. A short head+tail thus
 * identifies the same record across compact/full without embedding file
 * locations, while distinguishing same-timestamp inputs and tool calls. */
function antigravityFingerprintValue(value: unknown): unknown {
  if (value === undefined) return null;
  let normalized = value;
  if (typeof value === 'string') {
    try { normalized = JSON.parse(value); } catch { /* ordinary text */ }
  }
  const text = typeof normalized === 'string' ? normalized : JSON.stringify(normalized);
  if (text === undefined) return null;
  return [text.slice(0, 64), text.length > 64 ? text.slice(-64) : ''];
}

function antigravityRecordFingerprint(
  rec: any,
  type: string,
  transcriptPath: string,
  inode: number,
  lineStart: number,
): string {
  if (Number.isSafeInteger(rec.step_index)) {
    return JSON.stringify([rec.step_index, type, rec.status, rec.created_at]);
  }
  const hasContentIdentity = rec.content !== undefined || Array.isArray(rec.tool_calls);
  if (rec.created_at === undefined || rec.created_at === null || rec.created_at === '') {
    if (!hasContentIdentity) {
      // No stable fields at all: position is the only safe identity. Repeated
      // empty records cannot be dismissed as though they were the old one.
      return JSON.stringify([transcriptPath, inode, lineStart, type, rec.status]);
    }
  }
  const toolCalls = Array.isArray(rec.tool_calls)
    ? rec.tool_calls.map((call: any) => [
      call?.id ?? null,
      call?.name ?? call?.function?.name ?? null,
      antigravityFingerprintValue(call?.args ?? call?.function?.arguments),
    ])
    : null;
  return JSON.stringify([
    type,
    rec.status ?? null,
    rec.created_at ?? null,
    rec.source ?? null,
    antigravityFingerprintValue(rec.content),
    toolCalls,
  ]);
}

interface AntigravityBusyObservation {
  /** Undefined only for an explicit final/cancel/error or no lifecycle record. */
  step?: string;
  /** Explicit final/cancel/error. An empty file is NOT closed evidence. */
  closed: boolean;
  /** Read from the same fd as the record, so rotation cannot pair a record
   * from one file generation with the freshness of another. */
  mtimeMs: number;
}

function antigravityReadBusyStep(transcriptPath: string): AntigravityBusyObservation | undefined {
  if (!existsSync(transcriptPath)) return undefined;
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      const stats = fstatSync(fd);
      if (stats.size === 0) return { closed: false, mtimeMs: stats.mtimeMs };

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
        let lineStart = stats.size;
        let firstTailRecord = true;
        for (let i = candidateLines.length - 1; i >= 0; i--) {
          lineStart -= Buffer.byteLength(candidateLines[i]) + (i < candidateLines.length - 1 ? 1 : 0);
          const line = candidateLines[i].trim();
          if (!line) continue;
          let rec: any;
          try {
            rec = JSON.parse(line);
          } catch {
            // A non-empty malformed physical tail can be a compact-first write
            // in progress. Never roll back to an older final and call it idle.
            if (firstTailRecord) {
              return { step: JSON.stringify(['unparsed', transcriptPath, stats.ino, lineStart, stats.size]), closed: false, mtimeMs: stats.mtimeMs };
            }
            continue;
          }
          firstTailRecord = false;

          const type = rec?.type;
          if (type === 'ERROR_MESSAGE' || type === 'ERROR') {
            return { closed: true, mtimeMs: stats.mtimeMs };
          }
          if (type === 'SYSTEM_MESSAGE') {
            const content = String(rec?.content ?? '');
            // A task callback may quote "Tool execution was canceled" while
            // sibling tools still run. Only a turn-level notice ends the turn.
            const payload = (content.match(/(?:^|\n)<SYSTEM_MESSAGE>\r?\n([^\n]*)/)?.[1] ?? content).trim();
            if (/^(?:(?:the )?user |(?:the )?(?:turn|request) (?:was )?)?(?:cancell?ed|interrupted|aborted)\b/i.test(payload)
              || /^\[Notice\] All your subagents and background tasks have been stopped due to server restart\./.test(payload)) {
              return { closed: true, mtimeMs: stats.mtimeMs };
            }
            // Non-cancel notifications do not dictate lifecycle state.
            continue;
          }
          if (type === 'CHECKPOINT' || type === 'TASK_NOTIFICATION') {
            continue;
          }
          if (type === 'PLANNER_RESPONSE' && !(Array.isArray(rec.tool_calls) && rec.tool_calls.length)) {
            return { closed: true, mtimeMs: stats.mtimeMs };
          }
          if (type === 'PLANNER_RESPONSE' || type === 'GENERIC' || type === 'USER_INPUT') {
            return { step: antigravityRecordFingerprint(rec, type, transcriptPath, stats.ino, lineStart), closed: false, mtimeMs: stats.mtimeMs };
          }
        }
        if (chunkSize >= stats.size || chunkSize >= 1024 * 1024) break;
        chunkSize = Math.min(stats.size, chunkSize * 4);
      }
      return { closed: false, mtimeMs: stats.mtimeMs };
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** Merge lifecycle freshness in both directions. Agy normally writes compact
 * first, but a failed compact write must not hide a full-only new step either.
 * Empty/no-lifecycle files never outrank evidence from their sibling. Equal-
 * freshness disagreement with any busy side stays busy and cannot be released
 * by a composer until the two views agree again. */
function antigravityConversationBusyStep(conversationId: string): { step?: string; ambiguous: boolean } {
  const observations = [antigravityTranscriptPath(conversationId), antigravityFullTranscriptPath(conversationId)]
    .map(path => path ? antigravityReadBusyStep(path) : undefined)
    .filter((observation): observation is AntigravityBusyObservation => observation !== undefined);
  let latest: AntigravityBusyObservation | undefined;
  let ambiguous = false;
  for (const observation of observations) {
    if (observation.step === undefined && !observation.closed) continue;
    if (!latest) {
      latest = observation;
      continue;
    }
    if (latest.step !== undefined && latest.step === observation.step) continue;
    if (observation.mtimeMs > latest.mtimeMs) {
      latest = observation;
      ambiguous = false;
      continue;
    }
    if (observation.mtimeMs < latest.mtimeMs) continue;
    if (observation.step !== undefined || latest.step !== undefined) {
      latest = {
        step: JSON.stringify(['conflict', latest.step, observation.step]),
        closed: false,
        mtimeMs: observation.mtimeMs,
      };
      ambiguous = true;
    }
  }
  return { step: latest?.step, ambiguous };
}

function antigravityBusyStep(transcriptPath: string): string | undefined {
  return antigravityReadBusyStep(transcriptPath)?.step;
}

export function isAntigravityTranscriptBusy(transcriptPath: string): boolean {
  return antigravityBusyStep(transcriptPath) !== undefined;
}

/** Whether the transcript (read from its start, up to 1 MiB) records a
 *  USER_INPUT. Only asked of a transcript created after a submit, where the
 *  first record is that submit's USER_INPUT. */
function antigravityTranscriptHasUserInput(transcriptPath: string): boolean {
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      const size = Math.min(fstatSync(fd).size, 1024 * 1024);
      if (size === 0) return false;
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, 0);
      return buf.toString('utf-8').split('\n').some(line => {
        if (!line.includes('USER_INPUT')) return false;
        try { return JSON.parse(line)?.type === 'USER_INPUT'; } catch { return false; }
      });
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Antigravity brain transcript for zero-prompt and adopted sessions. The transcript is
 *  created lazily after the first submit, so a file born after spawn is the live turn
 *  (`birth-aware`). Its provisional trailing final lives in driver state that the worker
 *  commits on the steady-state ingest tick only. Locates the full log first and the compact
 *  log only when no full log exists (the worker moves a compact bind over at a turn
 *  boundary once the full log appears). */
export const antigravityBridgeSpec: StructuredBridgeSpec = {
  drain: (path, offset, ctx) => drainAntigravityTranscript(
    path,
    offset,
    (ctx.state as AntigravityTranscriptState | undefined) ?? {},
    {
      flushTrailingFinal: ctx.flushTrailingFinal,
      retirePendingTurns: ctx.retirePendingTurns,
      adoptMode: ctx.adoptMode,
    },
  ),
  stateCommit: 'ingest',
  locate: {
    bySessionId: sessionId => resolveAntigravityTranscriptPath(sessionId) ?? undefined,
    byPid: pid => {
      const conversationId = findAntigravityConversationIdByPid(pid);
      return conversationId ? resolveAntigravityTranscriptPath(conversationId) ?? undefined : undefined;
    },
  },
  spawn: { sessionId: 'cli', baseline: 'birth-aware' },
};

function antigravityVersionAtLeast(
  version: string | undefined,
  minMajor: number,
  minMinor: number,
  minPatch: number,
): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(version?.trim() ?? '');
  if (!match) return false;
  const [major = 0, minor = 0, patch = 0] = match.slice(1, 4).map(Number);
  return major > minMajor
    || (major === minMajor && (minor > minMinor || (minor === minMinor && patch >= minPatch)));
}

/** Only release versions with the verified paste contract opt into the fast path. */
function supportsAntigravityBracketedPaste(version: string | undefined): boolean {
  return antigravityVersionAtLeast(version, 1, 5, 4);
}

/** Verified release baseline supporting ephemeral `--settings` JSON with
 *  `statusLine.stack_with_default: true` and quota buckets on stdin
 *  (`stack_with_default` landed in 1.0.6, statusLine quota in 1.0.8 / 1.1.12,
 *  and `--settings` is documented in 1.5.8+ and verified live on 1.5.12).
 *  Older or unknown versions skip `--settings` so they never fail on an
 *  unknown flag or hide the `? for shortcuts` ready footer. */
export function supportsAntigravityStatusline(version: string | undefined): boolean {
  return antigravityVersionAtLeast(version, 1, 5, 8);
}

/** 找回被进程级 `--settings` 遮蔽的用户 Antigravity statusLine 命令。
 *  读取 `~/.gemini/antigravity-cli/settings.json` 中的 `statusLine`：
 *  仅当未显式禁用（`enabled !== false`）、未指定非 command 类型、且 `command` 非空时返回。
 *  纯函数、fail-open：文件缺失或损坏返回 `{}`。 */
export function resolveShadowedAntigravityStatusLine(
  opts?: { userSettingsPath?: string },
): { command?: string } {
  const settingsPath = opts?.userSettingsPath ?? join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, 'utf-8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const sl = (parsed as Record<string, unknown>).statusLine;
  if (!sl || typeof sl !== 'object' || Array.isArray(sl)) return {};
  const o = sl as Record<string, unknown>;
  if (o.enabled === false) return {};
  if (o.type !== undefined && o.type !== 'command') return {};
  if (typeof o.command !== 'string' || o.command.trim() === '') return {};
  return { command: o.command };
}

export function createAntigravityAdapter(pathOverride?: string): CliAdapter {
  // resolvedBin is lazy: setup constructs adapters only to read static
  // modelChoices and must not shell out (see resolveCommand); the binary path
  // is a spawn-time concern.
  const rawBin = pathOverride ?? 'agy';
  let cachedBin: string | undefined;
  let sessionLog: AntigravitySessionLog | undefined;
  let awaitNativeStreamLog = false;
  let bracketedPasteSupported = false;
  let knownCliSessionId: string | undefined;
  let lastConfirmedSubmitAtMs = 0;
  let preSubmitTranscriptSize: number | null = null;
  // The submitted conversation had no transcript yet, so everything agy later
  // writes there is post-submit (see transcriptCreatedAfterSubmit in writeInput).
  let submitTranscriptCreatedAfter = false;
  // Only a newly launched --conversation process can inherit unfinished work
  // from a dead predecessor. A reattached process can still be doing that work.
  let coldResumeTail: { conversationId: string; step: string } | undefined;
  const activeSessionId = (pty: Pick<PtyHandle, 'cliPid' | 'cliCwd'>): string | undefined => {
    const fromLog = sessionLog?.read().currentId;
    if (fromLog) return fromLog;
    // On a fresh launch (`!resume && !reattach`), agy creates no conversation
    // until the first prompt is submitted, while startup `ListConversations`
    // opens historical/sibling conversation `.db` files in parallel. Once agy
    // is actively writing `--log-file`, wait for its authoritative
    // `Streaming conversation <uuid>` line instead of probing transient startup fds.
    if (awaitNativeStreamLog && sessionLog?.hasLogFile()) return undefined;
    // Managed sessions (`buildArgs` wired `--log-file`) must never fall back to
    // workspace summaries when `cliPid` is unset — that hijacks a concurrent or
    // historical conversation sharing the same working directory.
    const cwd = sessionLog ? undefined : pty.cliCwd;
    if (!pty.cliPid && !cwd) return undefined;
    return findAntigravityConversationId({ pid: pty.cliPid, cwd }) ?? undefined;
  };
  const recordConfirmedSubmit = (
    pty: Pick<PtyHandle, 'cliPid' | 'cliCwd'>,
    preSize: number | null,
    transcriptCreatedAfter: boolean,
  ): string | undefined => {
    const cliSessionId = activeSessionId(pty);
    lastConfirmedSubmitAtMs = Date.now();
    preSubmitTranscriptSize = preSize;
    submitTranscriptCreatedAfter = transcriptCreatedAfter;
    if (cliSessionId) knownCliSessionId = cliSessionId;
    return cliSessionId;
  };
  return {
    id: 'antigravity',
    mcpGateway: {
      configPath: '~/.gemini/config/mcp_config.json',
      format: 'antigravity-json',
    },
    bridgeSpec: antigravityBridgeSpec,
    // Whole ~/.gemini (oauth + antigravity-cli brain transcripts + history):
    // a directory-level readWrite bind under the sandbox so the host daemon
    // drains the same transcript the CLI writes. The worker pre-creates the
    // dir at spawn (bwrap cannot bind a missing source).
    authPaths: ['~/.gemini'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },
    modelChoices: CLI_MODEL_CHOICES['antigravity'],
    /** Discover account-visible models without starting a conversation. */
    async detectModels(options) {
      return detectModelsViaExec(this.resolvedBin, ['models'], parseAntigravityModels, {
        ...(options?.env ?? process.env), AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
      });
    },

    buildArgs({ sessionId, resume, resumeSessionId, disableCliBypass, model, reasoningEffort, cliVersion, reattach }) {
      bracketedPasteSupported = reattach === false && supportsAntigravityBracketedPaste(cliVersion);
      awaitNativeStreamLog = !resume && !reattach;
      const args = disableCliBypass ? [] : ['--dangerously-skip-permissions'];
      sessionLog = new AntigravitySessionLog(sessionId);
      args.push('--log-file', sessionLog.path);
      // Resume: only when we have agy's own conversation UUID. We never
      // map botmux's sessionId here because agy generates its own id at
      // spawn time and ignores any value we'd pass — `--conversation`
      // strictly looks up an existing one. Without a stored cliSessionId,
      // start fresh; do NOT use `-c/--continue` because "most recent" is
      // racy when multiple botmux sessions run in parallel.
      coldResumeTail = undefined;
      if (resume && resumeSessionId) {
        const observation = !reattach ? antigravityConversationBusyStep(resumeSessionId) : undefined;
        if (observation?.step !== undefined && !observation.ambiguous) {
          coldResumeTail = { conversationId: resumeSessionId, step: observation.step };
        }
        knownCliSessionId = resumeSessionId;
        args.push('--conversation', resumeSessionId);
      } else {
        knownCliSessionId = undefined;
      }
      if (model && typeof model === 'string' && model.trim()) {
        args.push('--model', model.trim());
      }
      if (reasoningEffort && (reasoningEffort === 'low' || reasoningEffort === 'medium' || reasoningEffort === 'high')) {
        args.push('--effort', reasoningEffort);
      }
      // statusLine（agy >= 1.5.8）：通过进程级 --settings 临时注入，不修改用户
      // ~/.gemini/antigravity-cli/settings.json；stack_with_default=true 保留
      // 默认底部栏（保证 `? for shortcuts` readyPattern 与 idle 判定不受影响）。
      // 用户原有的自定义 statusLine.command 由 worker 通过 BOTMUX_STATUSLINE_CHAIN 透传。
      if (supportsAntigravityStatusline(cliVersion)) {
        args.push('--settings', JSON.stringify({
          statusLine: {
            type: 'command',
            enabled: true,
            command: statuslineHookCommand(),
            stack_with_default: true,
          },
        }));
      }
      // agy 1.5.4 supports -i, but its startup prompt bypasses history.jsonl.
      // Keep the same verified stdin submit path for initial and later turns.
      return args;
    },

    resolveActiveSessionId: activeSessionId,

    forkSessionAfterReady(opts) {
      if (!sessionLog) throw new Error('Antigravity fork has no process-scoped native log');
      return forkAntigravitySession({
        sourceId: opts.sourceSessionId,
        log: sessionLog,
        sendCommand: () => opts.sendCommand('/fork'),
        isCurrent: opts.isCurrent,
        isReady: () => isAntigravityIdleComposerScreen(opts.captureScreen()),
      });
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
      if (bracketedPasteSupported) {
        // ESC can terminate a paste frame and turn payload into live keys.
        if (content.includes('\x1b')) return { submitted: false, failureReason: 'antigravity_paste_control_character' };
        content = content.replace(/\r\n?/g, '\n');
      }
      // agy 1.5.4 accepts complete bracketed-paste frames. Older/unknown
      // versions retain the original M-Enter soft-newline contract. A write
      // acknowledgement is not submission evidence: both paths still use the
      // post-write history delta and never replay an unconfirmed input.
      const baseByte = currentFileSize(HISTORY_PATH);
      const marker = historyMarker(content);
      const initialCid = activeSessionId(pty) ?? knownCliSessionId;
      const initialTranscriptPath = initialCid ? resolveAntigravityTranscriptPath(initialCid) : null;
      const preSize = initialTranscriptPath ? currentFileSize(initialTranscriptPath) : null;
      // No transcript exists yet for the conversation this input lands in: a
      // known id whose brain file agy creates lazily (e.g. right after /new),
      // or a fresh launch whose native log has not streamed any conversation
      // (activeSessionId withholds an id only in that state). Any USER_INPUT
      // that later appears there is this submit's.
      const transcriptCreatedAfterSubmit = !initialTranscriptPath
        && (!!initialCid || (awaitNativeStreamLog && !!sessionLog?.hasLogFile()));

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

      if (bracketedPasteSupported) {
        try {
          if (pty.submitBracketedPaste) pty.submitBracketedPaste(content);
          else pty.write(wrapBracketedPaste(content) + '\r');
        } catch { /* The input may have landed; confirm it without replaying. */ }
      } else {
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
      }

      // Single Enter only — do NOT retry it. agy's history.jsonl append can
      // lag well past a short per-attempt window (cold start, large initial
      // prompt, network-bound auth), and a retry Enter lands on the
      // already-submitted composer: the same prompt then gets submitted
      // multiple times. Poll history once for the full in-band budget; a
      // genuinely dropped Enter is recovered by the worker's deferred
      // recheck, not by a second Enter (same pattern as the grok adapter).
      if (await waitForHistoryAppend(HISTORY_PATH, baseByte, marker, 3_200)) {
        const cliSessionId = recordConfirmedSubmit(pty, preSize, transcriptCreatedAfterSubmit);
        return cliSessionId ? { submitted: true, cliSessionId } : undefined;
      }

      // In-band budget exhausted. Hand the worker a recheck closure so a
      // slow agy (cold start, large initial prompt, network-bound auth)
      // can still resolve the warning before user-facing Lark notify.
      const recheck = (): SubmitRecheckResult => {
        if (!historyDeltaContains(HISTORY_PATH, baseByte, marker)) return false;
        const cliSessionId = recordConfirmedSubmit(pty, preSize, transcriptCreatedAfterSubmit);
        return cliSessionId ? { submitted: true, cliSessionId } : true;
      };
      return { submitted: false, recheck };
    },

    completionPattern: undefined,
    readyPattern: new RegExp(`\\? for shortcuts|${ERROR_COMPOSER_PATTERN.source}`),
    busyPattern: /esc to cancel/,
    // agy records Enter in history.jsonl immediately while a turn is running:
    // Queue mode parks the message until turn end (Auto-flush), while
    // Queued Messages = send-immediately forwards it into the active
    // conversation without cancelling the in-flight tool. Without
    // --dangerously-skip-permissions (disableCliBypass: true), agy can block on
    // a permission dialog where Enter approves and digit keys jump options, so
    // runtimePtyInputPolicy suppresses type-ahead for restricted bots. Selection
    // pickers that do come up (the question picker when the ask hook could not
    // take it, the permission dialog) take digit keys + Enter: the
    // `antigravity` stuck-page family holds queued input and busy raw
    // passthrough commands (/effort, /compact, /model, …) off them.
    supportsTypeAhead: true,
    stuckPageFamily: 'antigravity',
    isSessionBusy({ cliSessionId, getCurrentScreen, isCliProcessAlive }) {
      if (isCliProcessAlive?.() === false) return false;
      if (cliSessionId) knownCliSessionId = cliSessionId;
      const effectiveCid = cliSessionId ?? knownCliSessionId;
      if (lastConfirmedSubmitAtMs > 0) {
        const elapsed = Date.now() - lastConfirmedSubmitAtMs;
        const graceTranscriptPath = effectiveCid ? resolveAntigravityBusyTranscriptPath(effectiveCid) : null;
        if (graceTranscriptPath && preSubmitTranscriptSize === null) {
          // A transcript created after the submit holds only this input's
          // records. Its USER_INPUT — even of a turn that already finished
          // before this first probe — proves agy took the input, so it must
          // not become the "pre-submit" baseline and hold a finished turn busy.
          if (isAntigravityTranscriptBusy(graceTranscriptPath)
            || (submitTranscriptCreatedAfter && antigravityTranscriptHasUserInput(graceTranscriptPath))) {
            lastConfirmedSubmitAtMs = 0;
          } else if (!submitTranscriptCreatedAfter) {
            preSubmitTranscriptSize = currentFileSize(graceTranscriptPath);
          }
        }
        if (lastConfirmedSubmitAtMs > 0) {
          if (graceTranscriptPath && preSubmitTranscriptSize !== null && currentFileSize(graceTranscriptPath) > preSubmitTranscriptSize) {
            lastConfirmedSubmitAtMs = 0;
          } else if (elapsed >= scaleMs(10_000)) {
            lastConfirmedSubmitAtMs = 0;
          } else {
            try {
              const screen = getCurrentScreen?.();
              if (screen) {
                const plain = stripAnsiScreenText(screen).replace(/\r\n/g, '\n');
                if (isAntigravityInterruptedScreen(screen) || ERROR_COMPOSER_PATTERN.test(plain)) {
                  lastConfirmedSubmitAtMs = 0;
                  return false;
                }
              }
            } catch { /* Missing viewport is not evidence of cancellation. */ }
            return true;
          }
        }
      }
      if (!effectiveCid) return false;
      const observation = antigravityConversationBusyStep(effectiveCid);
      if (observation.ambiguous) return true;
      const step = observation.step;
      if (step === undefined) return false;
      try {
        const screen = getCurrentScreen?.();
        const plain = screen ? stripAnsiScreenText(screen).replace(/\r\n/g, '\n') : '';
        if (screen && (isAntigravityInterruptedScreen(screen) || ERROR_COMPOSER_PATTERN.test(plain))) return false;
        // The composer also accepts type-ahead between live tool calls. Only
        // use it to dismiss work already present before a cold resume.
        if (screen && coldResumeTail?.conversationId === effectiveCid && coldResumeTail.step === step
          && isAntigravityIdleComposerScreen(screen)) return false;
      } catch { /* Missing viewport is not evidence of cancellation. */ }
      return true;
    },
    systemHints: BOTMUX_SHELL_HINTS,
    skillsDir: '~/.gemini/config/skills',
    hookInstall: { configPath: '~/.gemini/config/hooks.json', format: 'antigravity-hooks' },
    // The hook takes ask_question over, but falls back to agy's own picker
    // when it cannot (agy without hooks, an unparseable hooks.json, botmux
    // moved): keep the botmux-ask skill as the fallback, like TRAE does next
    // to its native question bridge.
    asksViaHook: false,
    altScreen: true,
  };
}
