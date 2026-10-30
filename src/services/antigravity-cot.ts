/**
 * Antigravity CoT (thinking process) transcript reader.
 *
 * Antigravity writes conversation logs incrementally to:
 *   ~/.gemini/antigravity-cli/brain/<cliSessionId>/.system_generated/logs/transcript_full.jsonl
 * next to a compact transcript.jsonl that cuts long thinking / content to its
 * head and tail (see antigravity-transcript.ts). The reader follows the full
 * log, falls back to the compact one when no full log exists, and moves a
 * compact read over to the full log (same record, mapped offset) once agy has
 * created it.
 *
 * Each line is a self-contained JSON object:
 *   - type:"USER_INPUT" (user prompt start)
 *   - type:"PLANNER_RESPONSE" (thinking, commentary text, tool_calls)
 *   - type:"GENERIC" or tool name (tool output / result)
 *
 * This reader runs for the session, streaming thinking, mid-turn text, tool calls
 * and tool results into the native Feishu CoT bubble (message_cot).
 */
import { closeSync, constants, existsSync, fstatSync, openSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanJsonlBackwardFd, scanJsonlFromFd, scanJsonlFromOffset } from './jsonl-cursor.js';
import { antigravityRuntimeSignature, readLatestAntigravityRuntime } from './antigravity-usage.js';
import {
  antigravityFullSiblingPath,
  mapAntigravityCompactOffsetToFull,
  resolveAntigravityTranscriptPath,
} from './antigravity-transcript.js';
import { boundSubjectForTransport, subjectFromInputObject } from './cot-subject.js';

export const COT_TOOL_ARGS_MAX_CHARS = 600;
export const COT_TOOL_RESULT_MAX_CHARS = 800;
const POLL_INTERVAL_MS = 1_000;

export type AntigravityCotEntry =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | {
    kind: 'tool_call';
    id: string;
    name: string;
    args: string;
    subject?: string;
  }
  | { kind: 'tool_result'; id: string; result: string };

function truncateForCot(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function extractAntigravityCotEntriesFromRecord(
  d: any,
  pendingTools: Array<{ id: string; name: string }>,
): AntigravityCotEntry[] {
  if (!d || typeof d !== 'object') return [];
  const entries: AntigravityCotEntry[] = [];

  // User input lines never enter the thinking process; reset any pending tools
  if (d.type === 'USER_INPUT' || d.source === 'USER_EXPLICIT') {
    pendingTools.length = 0;
    return entries;
  }

  // Explicitly ignore internal system messages and checkpoints:
  // they must NEVER leak into the thinking bubble and must NEVER consume pendingTools.
  if (
    d.source === 'SYSTEM' ||
    d.type === 'SYSTEM_MESSAGE' ||
    d.type === 'CHECKPOINT' ||
    d.type === 'TASK_NOTIFICATION'
  ) {
    return entries;
  }

  if (d.type === 'PLANNER_RESPONSE') {
    if (typeof d.thinking === 'string' && d.thinking.trim().length > 0) {
      entries.push({ kind: 'thinking', text: d.thinking });
    }
    if (typeof d.content === 'string' && d.content.trim().length > 0) {
      entries.push({ kind: 'text', text: d.content });
    }
    if (Array.isArray(d.tool_calls)) {
      d.tool_calls.forEach((tc: any, idx: number) => {
        if (!tc || typeof tc !== 'object') return;
        const toolName = typeof tc.name === 'string' && tc.name ? tc.name : 'tool';
        const id = tc.id || `call_${d.step_index ?? 'step'}_${idx}`;
        pendingTools.push({ id, name: toolName });
        let argsStr = '';
        if (typeof tc.args === 'string') {
          argsStr = tc.args;
        } else if (tc.args !== undefined) {
          try { argsStr = JSON.stringify(tc.args); } catch { /* ignore */ }
        }
        const rawSubject = tc.args ? subjectFromInputObject(tc.args) : '';
        const subject = rawSubject ? boundSubjectForTransport(rawSubject) : undefined;
        entries.push({
          kind: 'tool_call',
          id,
          name: toolName,
          args: truncateForCot(argsStr, COT_TOOL_ARGS_MAX_CHARS),
          ...(subject ? { subject } : {}),
        });
      });
    }
    return entries;
  }

  // Tool execution results: strictly GENERIC (from MODEL or unlabelled) with non-empty content
  if (
    (d.source === 'MODEL' || !d.source) &&
    d.type === 'GENERIC' &&
    typeof d.content === 'string' &&
    d.content.length > 0
  ) {
    const pt = pendingTools.shift();
    const id = pt ? pt.id : `res_${d.step_index ?? Date.now()}`;
    entries.push({
      kind: 'tool_result',
      id,
      result: truncateForCot(d.content, COT_TOOL_RESULT_MAX_CHARS),
    });
    return entries;
  }

  return entries;
}

interface ReaderState {
  cliSessionId: string;
  /** Caller-pinned transcript (opts.transcriptPath): read as-is, never moved. */
  pinned: boolean;
  brainDir: string;
  /** Log currently read; undefined until one exists on disk. */
  transcriptPath?: string;
  /** Byte offset in `transcriptPath`. */
  offset: number;
  /** Last failed compact→full mapping (offset + full size), not retried until
   *  one of them moves. */
  upgradeAttemptKey?: string;
  timer: NodeJS.Timeout;
  watcher: FSWatcher | null;
  pendingTools: Array<{ id: string; name: string }>;
  onEntries: (entries: readonly AntigravityCotEntry[]) => void;
  onRuntime?: (runtime: { model: string }) => void;
  runtimeSignature?: string;
}

const readers = new Map<string, ReaderState>();

function watchTranscript(state: ReaderState): void {
  if (state.watcher) {
    try { state.watcher.close(); } catch { /* ignore */ }
    state.watcher = null;
  }
  if (!state.transcriptPath) return;
  try {
    const watcher = watch(state.transcriptPath, () => {
      const current = readers.get(state.cliSessionId);
      if (current) readNewTranscriptLines(current);
    });
    watcher.on('error', () => {
      try { watcher.close(); } catch { /* ignore */ }
      if (state.watcher === watcher) state.watcher = null;
    });
    state.watcher = watcher;
  } catch {
    state.watcher = null;
  }
}

/** Bind the log to read (full first; a log created after the reader started is
 *  read from byte 0), or move a compact read over to the full log at the
 *  equivalent offset. Returns false while no log exists yet. */
function bindTranscript(state: ReaderState): boolean {
  if (state.pinned) return !!state.transcriptPath && existsSync(state.transcriptPath);
  if (!state.transcriptPath) {
    const path = resolveAntigravityTranscriptPath(state.cliSessionId, { brainDir: state.brainDir });
    if (!path) return false;
    state.transcriptPath = path;
    watchTranscript(state);
    return true;
  }
  const fullPath = antigravityFullSiblingPath(state.transcriptPath);
  if (fullPath && existsSync(fullPath)) {
    let fullSize = -1;
    try { fullSize = statSync(fullPath).size; } catch { /* retried below */ }
    const attemptKey = `${state.offset}:${fullSize}`;
    if (fullSize >= 0 && attemptKey !== state.upgradeAttemptKey) {
      state.upgradeAttemptKey = attemptKey;
      const mapped = mapAntigravityCompactOffsetToFull(state.transcriptPath, state.offset, fullPath);
      if (mapped !== undefined) {
        state.transcriptPath = fullPath;
        state.offset = mapped;
        state.upgradeAttemptKey = undefined;
        watchTranscript(state);
      }
    }
  }
  return existsSync(state.transcriptPath);
}

function readNewTranscriptLines(state: ReaderState): void {
  // Identity is useful even when thinking is disabled or no log bytes arrived.
  // Reuse this reader's lifetime and exact native session, not a global setting.
  if (state.onRuntime) {
    try {
      const opts = { conversationsDir: join(dirname(state.brainDir), 'conversations') };
      const signature = antigravityRuntimeSignature(state.cliSessionId, opts);
      if (!signature || signature !== state.runtimeSignature) {
        const runtime = readLatestAntigravityRuntime(state.cliSessionId, opts);
        if (runtime.model) {
          state.onRuntime({ model: runtime.model });
          // Failed/unknown reads and failed delivery stay retryable without a
          // file change. Unchanged successful snapshots need no SQLite open.
          state.runtimeSignature = signature;
        }
      }
    } catch { /* cosmetic model reporting must not stop tool progress */ }
  }
  if (!bindTranscript(state) || !state.transcriptPath) return;
  try {
    const st = statSync(state.transcriptPath);
    if (st.size <= state.offset) return;

    const scanned = scanJsonlFromOffset(state.transcriptPath, state.offset, {
      onLine: (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const record = JSON.parse(trimmed);
          const entries = extractAntigravityCotEntriesFromRecord(record, state.pendingTools);
          if (entries.length > 0) {
            state.onEntries(entries);
          }
        } catch {
          // Half-written or malformed JSON line; skip
        }
      },
    });

    if (scanned) {
      state.offset = scanned.newOffset;
    }
  } catch {
    // Ignore read / stat race
  }
}

export interface StartAntigravityCotOptions {
  /** Read exactly this file (tests); otherwise the conversation's logs under
   *  `brainDir` are resolved full-first. */
  transcriptPath?: string;
  brainDir?: string;
  mode?: 'baseline-existing' | 'fresh';
  pollIntervalMs?: number;
  /** Observed native model, independent of the thinking-display switch. */
  onRuntime?: (runtime: { model: string }) => void;
}

/** Pending tools reset at USER_INPUT. Locate that boundary backwards, then
 * replay only the latest turn's correlation state, not the whole conversation.
 * Use one regular-file fd for both passes and retain an incomplete EOF line. */
function restorePendingTools(path: string, endOffset: number, pendingTools: Array<{ id: string; name: string }>): number {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return endOffset;
    const end = Math.min(endOffset, st.size);
    let completeEnd = end;
    let turnStart = 0;
    scanJsonlBackwardFd(fd, {
      endOffset: end,
      onLine: (line, start) => {
        if (start + line.length === end) { completeEnd = start; return; }
        if (!line.includes('"USER_INPUT"') && !line.includes('"USER_EXPLICIT"')) return;
        try {
          const record = JSON.parse(line.toString('utf8'));
          if (record.type === 'USER_INPUT' || record.source === 'USER_EXPLICIT') { turnStart = start; return true; }
        } catch { /* malformed old record is not an input boundary */ }
      },
    });
    const primed = scanJsonlFromFd(fd, turnStart, {
      endOffset: completeEnd,
      onLine: line => {
        try { extractAntigravityCotEntriesFromRecord(JSON.parse(line), pendingTools); } catch { /* malformed record */ }
      },
    });
    return primed?.newOffset ?? completeEnd;
  } catch { return endOffset; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Start monitoring Antigravity transcript for CoT events.
 *
 * If `mode === 'baseline-existing'` (default), existing content in the transcript
 * is skipped so historical turns are not replayed to Lark.
 */
export function startAntigravityCot(
  cliSessionId: string,
  onEntries: (entries: readonly AntigravityCotEntry[]) => void,
  opts?: StartAntigravityCotOptions,
): boolean {
  if (!cliSessionId || !/^[a-zA-Z0-9._-]+$/.test(cliSessionId)) return false;
  if (readers.has(cliSessionId)) return true;

  const brainDir = opts?.brainDir ?? join(homedir(), '.gemini', 'antigravity-cli', 'brain');
  const transcriptPath = opts?.transcriptPath
    ?? resolveAntigravityTranscriptPath(cliSessionId, { brainDir })
    ?? undefined;

  let initialOffset = 0;
  if (opts?.mode !== 'fresh' && transcriptPath && existsSync(transcriptPath)) {
    try {
      initialOffset = statSync(transcriptPath).size;
    } catch {
      initialOffset = 0;
    }
  }

  // Restore correlation for a tool that started before this reader attached,
  // without replaying any old thinking or tool-call display entries.
  const pendingTools: Array<{ id: string; name: string }> = [];
  if (initialOffset > 0 && transcriptPath) {
    initialOffset = restorePendingTools(transcriptPath, initialOffset, pendingTools);
  }

  const pollInterval = opts?.pollIntervalMs ?? POLL_INTERVAL_MS;
  const timer = setInterval(() => {
    const current = readers.get(cliSessionId);
    if (current) readNewTranscriptLines(current);
  }, pollInterval);
  timer.unref?.();

  const state: ReaderState = {
    cliSessionId,
    pinned: opts?.transcriptPath !== undefined,
    brainDir,
    ...(transcriptPath ? { transcriptPath } : {}),
    offset: initialOffset,
    timer,
    watcher: null,
    pendingTools,
    onEntries,
    onRuntime: opts?.onRuntime,
  };

  readers.set(cliSessionId, state);
  if (transcriptPath && existsSync(transcriptPath)) watchTranscript(state);

  // Seed runtime immediately on resume too; the EOF cursor still skips history.
  if (opts?.mode === 'fresh' || opts?.onRuntime) {
    readNewTranscriptLines(state);
  }

  return true;
}

export function stopAntigravityCot(cliSessionId: string): void {
  const state = readers.get(cliSessionId);
  if (!state) return;
  readers.delete(cliSessionId);
  try { clearInterval(state.timer); } catch { /* ignore */ }
  if (state.watcher) {
    try { state.watcher.close(); } catch { /* ignore */ }
  }
}

export function stopAllAntigravityCot(): void {
  for (const cid of Array.from(readers.keys())) {
    stopAntigravityCot(cid);
  }
}
