import type { CotEntry } from '../types.js';
import { boundSubjectForTransport, COT_SUBJECT_MAX_CHARS, subjectFromInputObject } from './cot-subject.js';

export const DSH_COT_LIMITS = {
  textChars: 16_000,
  toolArgsChars: 600,
  toolResultChars: 800,
  toolNameChars: 120,
  maxEntries: 32,
  payloadBytes: 256 * 1024,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function cotEntriesFromAssistantMessage(message: unknown): CotEntry[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  const content = message.content;
  const hasToolCall = content.some(block => isRecord(block) && block.type === 'tool-call');
  const entries: CotEntry[] = [];
  let text = '';
  const flushText = () => {
    if (text.trim()) entries.push({ kind: 'text', text: truncate(text, DSH_COT_LIMITS.textChars) });
    text = '';
  };
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && hasToolCall) {
      if (typeof block.text === 'string') text += block.text;
      continue;
    }
    flushText();
    if (isRecord(block) && block.type === 'reasoning' && nonEmptyString(block.text)) {
      entries.push({ kind: 'thinking', text: truncate(block.text.trim(), DSH_COT_LIMITS.textChars) });
    }
  }
  flushText();
  return entries;
}

function toolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    // Non-JSON arguments still render as args, but have no structured subject.
    return undefined;
  }
}

export function cotEntryFromToolCall(data: unknown): CotEntry | undefined {
  if (!isRecord(data) || !nonEmptyString(data.callId)) return undefined;
  const name = nonEmptyString(data.name) ? data.name : 'tool';
  const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments) ?? '';
  const subject = boundSubjectForTransport(subjectFromInputObject(toolInput(data.arguments)));
  return {
    kind: 'tool_call', id: data.callId,
    name: truncate(name, DSH_COT_LIMITS.toolNameChars),
    args: truncate(args, DSH_COT_LIMITS.toolArgsChars),
    ...(subject ? { subject } : {}),
  };
}

export function cotEntryFromToolResult(data: unknown): CotEntry | undefined {
  if (!isRecord(data) || !isRecord(data.message)) return undefined;
  const message = data.message;
  const id = (isRecord(message.source) ? message.source.callId : undefined) ?? message.toolCallId;
  if (!nonEmptyString(id)) return undefined;
  const parts: string[] = [];
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      if (block.type === 'tool-result' && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (isRecord(nested) && nested.type === 'text' && typeof nested.text === 'string') parts.push(nested.text);
        }
      }
    }
  }
  return { kind: 'tool_result', id, result: truncate(parts.join('\n'), DSH_COT_LIMITS.toolResultChars) };
}

/** Validate the entire cosmetic frame before admitting any entries. */
export function normalizeDshCotMarker(cliId: string | undefined, payload: unknown): CotEntry[] | undefined {
  if (cliId !== 'dsh') return undefined;
  if (!isPlainObject(payload) || Object.keys(payload).some(key => key !== 'entries')) return undefined;
  if (!Array.isArray(payload.entries) || payload.entries.length === 0 || payload.entries.length > DSH_COT_LIMITS.maxEntries) return undefined;
  const entries: CotEntry[] = [];
  for (const value of payload.entries) {
    if (!isPlainObject(value)) return undefined;
    if (value.kind === 'thinking' || value.kind === 'text') {
      if (!nonEmptyString(value.text) || value.text.length > DSH_COT_LIMITS.textChars + 1
          || Object.keys(value).some(key => key !== 'kind' && key !== 'text')) return undefined;
      entries.push({ kind: value.kind, text: value.text });
      continue;
    }
    if (value.kind === 'tool_call') {
      if (!nonEmptyString(value.id) || !nonEmptyString(value.name) || value.name.length > DSH_COT_LIMITS.toolNameChars + 1
          || typeof value.args !== 'string' || value.args.length > DSH_COT_LIMITS.toolArgsChars + 1
          || ('subject' in value && (typeof value.subject !== 'string' || value.subject.length > COT_SUBJECT_MAX_CHARS + 1))
          || Object.keys(value).some(key => !['kind', 'id', 'name', 'args', 'subject'].includes(key))) return undefined;
      entries.push({
        kind: 'tool_call', id: value.id, name: value.name, args: value.args,
        ...(typeof value.subject === 'string' ? { subject: value.subject } : {}),
      });
      continue;
    }
    if (value.kind === 'tool_result') {
      if (!nonEmptyString(value.id) || typeof value.result !== 'string' || value.result.length > DSH_COT_LIMITS.toolResultChars + 1
          || Object.keys(value).some(key => !['kind', 'id', 'result'].includes(key))) return undefined;
      entries.push({ kind: 'tool_result', id: value.id, result: value.result });
      continue;
    }
    return undefined;
  }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > DSH_COT_LIMITS.payloadBytes) return undefined;
  return entries;
}
