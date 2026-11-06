/**
 * Incremental reader for ebsd's BotMux-only OMP session protocol.
 *
 * Unlike the generic Oh My Pi bridge, ebsd ignores every assistant stop and
 * closes a turn only on `ebsd.botmux.turn_completed.v1`, which ebsd writes
 * after its hidden diagnosis finalizer has completed.
 */
import { existsSync, statSync } from 'node:fs';

import type { CodexBridgeEvent } from './codex-transcript.js';
import { iterateJsonlLines, readJsonlWindow } from './jsonl-cursor.js';
import { entryTimestampMs as timestampMs, messageContentText as messageText } from './pi-family-content.js';

const EBSD_TERMINAL_CUSTOM_TYPE = 'ebsd.botmux.turn_completed.v1';

export interface EbsdTranscriptState {
  generation?: number;
  fileId?: string;
}

export interface EbsdDrainResult {
  events: CodexBridgeEvent[];
  newOffset: number;
  pendingTail: string;
  state: EbsdTranscriptState;
}

function eventUuid(path: string, generation: number, lineStart: number): string {
  return `${path}:${generation}:${lineStart}`;
}

function terminalEvent(
  entry: Record<string, unknown>,
  path: string,
  generation: number,
  lineStart: number,
): CodexBridgeEvent | null {
  if (entry.type !== 'custom' || entry.customType !== EBSD_TERMINAL_CUSTOM_TYPE) return null;
  const data = entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)
    ? entry.data as Record<string, unknown>
    : undefined;
  const outcome = String(data?.outcome);
  const answer = typeof data?.answer === 'string' ? data.answer : undefined;
  const valid = data?.schema_version === 1
    && ['completed', 'failed', 'ambiguous'].includes(outcome)
    && answer !== undefined
    && (outcome !== 'completed' || !!answer.trim())
    && ['not_needed', 'forced', 'fallback'].includes(String(data.finalization))
    && ['completed', 'inconclusive', 'not_started'].includes(String(data.diagnosis_status))
    && (data.run_id === undefined || typeof data.run_id === 'string');
  if (!valid) {
    return {
      uuid: eventUuid(path, generation, lineStart),
      timestampMs: timestampMs(entry),
      kind: 'assistant_final',
      text: '',
      terminalStatus: 'failed',
      terminalErrorCode: 'ebsd_bridge_protocol_error',
    };
  }
  return {
    uuid: eventUuid(path, generation, lineStart),
    timestampMs: timestampMs(entry),
    kind: 'assistant_final',
    text: answer.trim(),
    ...(outcome === 'failed'
      ? { terminalStatus: 'failed' as const, terminalErrorCode: 'ebsd_turn_failed' }
      : outcome === 'ambiguous'
        ? { terminalStatus: 'ambiguous' as const, terminalErrorCode: 'ebsd_turn_ambiguous' }
        : {}),
  };
}

export function drainEbsdTranscript(
  path: string,
  fromOffset: number,
  previousState: EbsdTranscriptState = {},
): EbsdDrainResult {
  if (!existsSync(path)) {
    return { events: [], newOffset: fromOffset, pendingTail: '', state: previousState };
  }

  let size: number;
  let fileId: string;
  try {
    const stats = statSync(path);
    size = stats.size;
    fileId = `${stats.dev}:${stats.ino}`;
  } catch {
    return { events: [], newOffset: fromOffset, pendingTail: '', state: previousState };
  }

  const reset = size < fromOffset
    || (previousState.fileId !== undefined && previousState.fileId !== fileId);
  const generation = (previousState.generation ?? 0) + (reset ? 1 : 0);
  const state: EbsdTranscriptState = { generation, fileId };
  const start = reset ? 0 : fromOffset;
  const events: CodexBridgeEvent[] = [];
  const { completeText, pendingTail, newOffset } = readJsonlWindow(path, start, size);

  for (const { line, lineStart } of iterateJsonlLines(completeText, start)) {
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const terminal = terminalEvent(entry, path, generation, lineStart);
    if (terminal) {
      events.push(terminal);
      continue;
    }
    if (entry.type !== 'message') continue;
    const message = entry.message && typeof entry.message === 'object' && !Array.isArray(entry.message)
      ? entry.message as Record<string, unknown>
      : undefined;
    if (message?.role !== 'user') continue;
    const text = messageText(message.content);
    if (!text) continue;
    events.push({
      uuid: eventUuid(path, generation, lineStart),
      timestampMs: timestampMs(entry, message),
      kind: 'user',
      text,
    });
  }

  return { events, newOffset, pendingTail, state };
}
