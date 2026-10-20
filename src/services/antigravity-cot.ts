/**
 * Antigravity CoT (thinking process) transcript reader.
 *
 * Antigravity writes conversation logs incrementally to:
 *   ~/.gemini/antigravity-cli/brain/<cliSessionId>/.system_generated/logs/transcript.jsonl
 *
 * Each line is a self-contained JSON object:
 *   - type:"USER_INPUT" (user prompt start)
 *   - type:"PLANNER_RESPONSE" (thinking, commentary text, tool_calls)
 *   - type:"GENERIC" or tool name (tool output / result)
 *
 * This reader runs for the session, streaming thinking, mid-turn text, tool calls
 * and tool results into the native Feishu CoT bubble (message_cot).
 */
import { existsSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scanJsonlFromOffset } from './jsonl-cursor.js';
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
  transcriptPath: string;
  offset: number;
  timer: NodeJS.Timeout;
  watcher: FSWatcher | null;
  pendingTools: Array<{ id: string; name: string }>;
  onEntries: (entries: readonly AntigravityCotEntry[]) => void;
}

const readers = new Map<string, ReaderState>();

function readNewTranscriptLines(state: ReaderState): void {
  if (!existsSync(state.transcriptPath)) return;
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
  transcriptPath?: string;
  brainDir?: string;
  mode?: 'baseline-existing' | 'fresh';
  pollIntervalMs?: number;
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

  const transcriptPath = opts?.transcriptPath
    ?? join(
      opts?.brainDir ?? join(homedir(), '.gemini', 'antigravity-cli', 'brain'),
      cliSessionId,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );

  let initialOffset = 0;
  if (opts?.mode !== 'fresh' && existsSync(transcriptPath)) {
    try {
      initialOffset = statSync(transcriptPath).size;
    } catch {
      initialOffset = 0;
    }
  }

  let watcher: FSWatcher | null = null;
  if (existsSync(transcriptPath)) {
    try {
      watcher = watch(transcriptPath, () => {
        const current = readers.get(cliSessionId);
        if (current) readNewTranscriptLines(current);
      });
      watcher.on('error', () => {
        try { watcher?.close(); } catch { /* ignore */ }
        watcher = null;
      });
    } catch {
      watcher = null;
    }
  }

  const pollInterval = opts?.pollIntervalMs ?? POLL_INTERVAL_MS;
  const timer = setInterval(() => {
    const current = readers.get(cliSessionId);
    if (current) readNewTranscriptLines(current);
  }, pollInterval);
  timer.unref?.();

  const state: ReaderState = {
    cliSessionId,
    transcriptPath,
    offset: initialOffset,
    timer,
    watcher,
    pendingTools: [],
    onEntries,
  };

  readers.set(cliSessionId, state);

  // If starting in fresh mode, perform initial read immediately
  if (opts?.mode === 'fresh') {
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
