/**
 * Incremental reader for Oh My Pi's append-only session JSONL.
 *
 * OMP can append a plugin continuation immediately after an apparently final
 * assistant `stop`. Therefore terminal assistant records remain provisional
 * until a decisive later record or the worker's guarded quiet-tick flush.
 */
import type { CodexBridgeEvent } from './codex-transcript.js';
import { beginJsonlDrain, iterateJsonlLines } from './jsonl-cursor.js';
import {
  contentHasToolCall as hasToolCall,
  entryTimestampMs as timestampMs,
  messageContentText,
} from './pi-family-content.js';

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

/** Canonical text projection for OMP message content. */
export function ompMessageText(content: unknown): string {
  return messageContentText(content);
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
  const step = beginJsonlDrain(path, fromOffset);
  if (step.kind === 'skip') {
    return step.reason === 'missing'
      ? { events: [], newOffset: step.newOffset, pendingTail: '', state: {} }
      : { events: [], newOffset: step.newOffset, pendingTail: '', state: cloneState(previousState) };
  }

  const start = step.start;
  let state = step.reset ? {} : cloneState(previousState);
  const events: CodexBridgeEvent[] = [];
  const { completeText, pendingTail, newOffset } = step.window;

  for (const { line, lineStart } of iterateJsonlLines(completeText, start)) {
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
      const text = ompMessageText(message.content);
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
      text: ompMessageText(message.content),
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
