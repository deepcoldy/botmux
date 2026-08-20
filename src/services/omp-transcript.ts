/**
 * Incremental reader for Oh My Pi's append-only session JSONL.
 *
 * OMP can append a plugin continuation immediately after an apparently final
 * assistant `stop`. Therefore terminal assistant records remain provisional
 * until a decisive later record or the worker's guarded quiet-tick flush.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';

import type { CodexBridgeEvent } from './codex-transcript.js';

export interface OmpProvisionalFinal {
  event: CodexBridgeEvent;
  /** Session-tree entry that supplied the provisional assistant terminal. */
  entryId?: string;
  /** Candidate plus metadata descendants, used to recognize same-lineage work. */
  lineageIds: string[];
}

export interface OmpTranscriptState {
  provisionalFinal?: OmpProvisionalFinal;
}

export interface OmpDrainResult {
  events: CodexBridgeEvent[];
  newOffset: number;
  pendingTail: string;
  state: OmpTranscriptState;
}

export interface OmpDrainOptions {
  /** Worker-only: release a file-tail candidate after its guarded quiet probe. */
  flushTrailingFinal?: boolean;
}

type OmpTerminalStopReason = 'stop' | 'length' | 'error' | 'aborted';

function visibleText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if ((item as { type?: unknown }).type === 'text'
      && typeof (item as { text?: unknown }).text === 'string') {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.join('\n').trim();
}

function hasToolCall(content: unknown): boolean {
  return Array.isArray(content) && content.some(item =>
    !!item
    && typeof item === 'object'
    && (item as { type?: unknown }).type === 'toolCall');
}

function terminalOutcome(stopReason: OmpTerminalStopReason): Pick<
  CodexBridgeEvent,
  'terminalStatus' | 'terminalErrorCode'
> {
  switch (stopReason) {
    case 'stop':
    case 'length':
      return {};
    case 'error':
      return { terminalStatus: 'failed', terminalErrorCode: 'omp_turn_error' };
    case 'aborted':
      return { terminalStatus: 'ambiguous', terminalErrorCode: 'omp_turn_aborted' };
  }
}

function timestampMs(entry: Record<string, unknown>, message?: Record<string, unknown>): number {
  if (typeof entry.timestamp === 'string') {
    const parsed = Date.parse(entry.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof message?.timestamp === 'number' && Number.isFinite(message.timestamp)) {
    return message.timestamp;
  }
  return Date.now();
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isExplicitContinuation(entry: Record<string, unknown>, message?: Record<string, unknown>): boolean {
  const customType = stringField(entry.customType) ?? stringField(message?.customType);
  return customType === 'prewalk-continue';
}

function candidateTracksParent(
  candidate: OmpProvisionalFinal,
  parentId: string | undefined,
): boolean {
  return !!parentId && candidate.lineageIds.includes(parentId);
}

function addMetadataDescendant(
  candidate: OmpProvisionalFinal,
  entryId: string | undefined,
  parentId: string | undefined,
): OmpProvisionalFinal {
  if (!entryId || !candidateTracksParent(candidate, parentId)
    || candidate.lineageIds.includes(entryId)) return candidate;
  return { ...candidate, lineageIds: [...candidate.lineageIds, entryId] };
}

function cloneState(state: OmpTranscriptState | undefined): OmpTranscriptState {
  const candidate = state?.provisionalFinal;
  return candidate
    ? { provisionalFinal: { ...candidate, event: { ...candidate.event }, lineageIds: [...candidate.lineageIds] } }
    : {};
}

/**
 * Drain only complete JSONL lines. The returned byte offset never includes a
 * partial tail, so the worker can use offset equality as its quiet-cycle clock.
 */
export function drainOmpTranscript(
  path: string,
  fromOffset: number,
  previousState: OmpTranscriptState = {},
  options: OmpDrainOptions = {},
): OmpDrainResult {
  if (!existsSync(path)) {
    return { events: [], newOffset: 0, pendingTail: '', state: {} };
  }

  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { events: [], newOffset: fromOffset, pendingTail: '', state: cloneState(previousState) };
  }

  const truncated = size < fromOffset;
  const start = truncated ? 0 : fromOffset;
  let state = truncated ? {} : cloneState(previousState);
  const events: CodexBridgeEvent[] = [];

  let completeText = '';
  let pendingTail = '';
  let newOffset = start;
  if (size > start) {
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buffer, 0, length, start);
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    completeText = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
    pendingTail = lastNewline >= 0 ? text.slice(lastNewline + 1) : text;
    newOffset = start + Buffer.byteLength(completeText, 'utf8');
  }

  let cursor = start;
  for (const line of completeText.split('\n')) {
    if (line.length === 0) {
      cursor += 1;
      continue;
    }
    const lineStart = cursor;
    cursor += Buffer.byteLength(line, 'utf8') + 1;

    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const entryId = stringField(entry.id);
    const parentId = stringField(entry.parentId);
    const message = entry.message && typeof entry.message === 'object' && !Array.isArray(entry.message)
      ? entry.message as Record<string, unknown>
      : undefined;
    const role = stringField(message?.role);
    let candidate = state.provisionalFinal;

    if (entry.type !== 'message') {
      if (candidate && candidateTracksParent(candidate, parentId)) {
        if (isExplicitContinuation(entry)) {
          state = {};
        } else {
          // Title/model/compaction/custom metadata cannot settle a candidate,
          // but retaining its id keeps later child activity lineage-aware.
          state = { provisionalFinal: addMetadataDescendant(candidate, entryId, parentId) };
        }
      }
      continue;
    }
    if (!message) continue;

    if (role === 'user') {
      const steering = message.steering === true;
      if (candidate) {
        if (steering) {
          // OMP folded this user message into the active loop. The old stop was
          // intermediate; CodexBridgeQueue will HOL-drop it when this user starts.
          state = {};
        } else {
          // An ordinary next user proves the prior loop ended. Emit its terminal
          // before the new user so FIFO non-steered turns remain interleaved.
          events.push(candidate.event);
          state = {};
        }
      }
      const text = visibleText(message.content);
      if (text) {
        events.push({
          uuid: `${path}:${lineStart}`,
          timestampMs: timestampMs(entry, message),
          kind: 'user',
          text,
        });
      }
      continue;
    }

    const sameLineage = !!candidate && candidateTracksParent(candidate, parentId);
    if (sameLineage && (role === 'assistant' || role === 'toolResult'
      || role === 'bashExecution' || role === 'pythonExecution'
      || isExplicitContinuation(entry, message))) {
      state = {};
      candidate = undefined;
    }

    if (role !== 'assistant') continue;
    const stopReason = stringField(entry.stopReason) ?? stringField(message.stopReason);
    const isHardTerminal = stopReason === 'error' || stopReason === 'aborted';
    const isTextTerminal = (stopReason === 'stop' || stopReason === 'length')
      && !hasToolCall(message.content);
    if (!isHardTerminal && !isTextTerminal) continue;

    const event: CodexBridgeEvent = {
      uuid: `${path}:${lineStart}`,
      timestampMs: timestampMs(entry, message),
      kind: 'assistant_final',
      text: visibleText(message.content),
      ...terminalOutcome(stopReason as OmpTerminalStopReason),
    };
    state = {
      provisionalFinal: {
        event,
        entryId,
        lineageIds: entryId ? [entryId] : [],
      },
    };
  }

  if (options.flushTrailingFinal && state.provisionalFinal) {
    events.push(state.provisionalFinal.event);
    state = {};
  }

  return { events, newOffset, pendingTail, state };
}
