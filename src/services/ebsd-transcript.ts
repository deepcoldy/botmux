/**
 * Incremental reader for ebsd's BotMux-only OMP session protocol.
 *
 * Unlike the generic Oh My Pi bridge, ebsd ignores every assistant stop and
 * closes a turn only on `ebsd.botmux.turn_completed.v1`, which ebsd writes
 * after its hidden diagnosis finalizer has completed.
 */
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';

import type { CodexBridgeEvent } from './codex-transcript.js';

const EBSD_TERMINAL_CUSTOM_TYPE = 'ebsd.botmux.turn_completed.v1';

export type EbsdTranscriptState = Record<string, never>;

export interface EbsdDrainResult {
  events: CodexBridgeEvent[];
  newOffset: number;
  pendingTail: string;
  state: EbsdTranscriptState;
}

function messageText(content: unknown): string {
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

function terminalEvent(
  entry: Record<string, unknown>,
  path: string,
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
      uuid: `${path}:${lineStart}`,
      timestampMs: timestampMs(entry),
      kind: 'assistant_final',
      text: '',
      terminalStatus: 'failed',
      terminalErrorCode: 'ebsd_bridge_protocol_error',
    };
  }
  return {
    uuid: `${path}:${lineStart}`,
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
  _previousState: EbsdTranscriptState = {},
): EbsdDrainResult {
  if (!existsSync(path)) {
    return { events: [], newOffset: 0, pendingTail: '', state: {} };
  }

  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { events: [], newOffset: fromOffset, pendingTail: '', state: {} };
  }

  const start = size < fromOffset ? 0 : fromOffset;
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

    const terminal = terminalEvent(entry, path, lineStart);
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
      uuid: `${path}:${lineStart}`,
      timestampMs: timestampMs(entry, message),
      kind: 'user',
      text,
    });
  }

  return { events, newOffset, pendingTail, state: {} };
}
