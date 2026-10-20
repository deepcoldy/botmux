import type { CotEntry } from '../types.js';
import { CODEX_APP_CONTROL_COT_PAYLOAD_MAX_BYTES } from '../utils/codex-app-control.js';

const THINKING_MAX_CHARS = 2_000;
const TOOL_ARGS_MAX_CHARS = 600;
const TOOL_RESULT_MAX_CHARS = 1_200;
const THINKING_MAX_BYTES = 2_200;
const TOOL_ARGS_MAX_BYTES = 600;
const TOOL_RESULT_MAX_BYTES = 1_200;
const TOOL_NAME_MAX_BYTES = 120;
const STREAM_CHUNK_TARGET_CHARS = 120;

function bounded(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function boundedUtf8(value: unknown, maxChars: number, maxBytes: number): string {
  const text = bounded(value, maxChars);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const ellipsis = '…';
  let result = '';
  let bytes = Buffer.byteLength(ellipsis, 'utf8');
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result}${ellipsis}`;
}

function appendBounded(current: string, delta: string, max: number): string {
  const text = `${current}${delta}`;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function json(value: unknown, max: number): string {
  if (value === undefined) return '';
  try {
    return bounded(typeof value === 'string' ? value : JSON.stringify(value), max);
  } catch {
    return '';
  }
}

function toolJson(value: unknown): string {
  return boundedUtf8(json(value, TOOL_ARGS_MAX_CHARS), TOOL_ARGS_MAX_CHARS, TOOL_ARGS_MAX_BYTES);
}

function itemId(item: Record<string, unknown>): string {
  return typeof item.id === 'string' && item.id.length > 0 ? item.id : '';
}

function fileChangeArgs(item: Record<string, unknown>): string {
  const paths = (Array.isArray(item.changes) ? item.changes : [])
    .map(change => change && typeof change === 'object' ? (change as Record<string, unknown>).path : undefined)
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
  if (paths.length === 0) return '';
  return toolJson({ path: paths.length === 1 ? paths[0] : `${paths.length} files: ${paths.join(', ')}` });
}

function toolCall(item: Record<string, unknown>): CotEntry | undefined {
  const id = itemId(item);
  if (!id) return undefined;
  switch (item.type) {
    case 'commandExecution':
      return { kind: 'tool_call', id, name: 'shell', args: toolJson({ command: item.command }) };
    case 'fileChange':
      return { kind: 'tool_call', id, name: 'apply_patch', args: fileChangeArgs(item) };
    case 'mcpToolCall':
      return {
        kind: 'tool_call',
        id,
        name: boundedUtf8(
          [item.server, item.tool].filter(value => typeof value === 'string' && value).join('.') || 'mcp_tool',
          120,
          TOOL_NAME_MAX_BYTES,
        ),
        args: toolJson(item.arguments ?? item.args),
      };
    case 'dynamicToolCall':
      return {
        kind: 'tool_call',
        id,
        name: boundedUtf8(item.tool ?? item.name, 120, TOOL_NAME_MAX_BYTES) || 'tool',
        args: toolJson(item.arguments ?? item.args),
      };
    case 'webSearch':
      return { kind: 'tool_call', id, name: 'web_search', args: toolJson(item.query ?? item.action) };
    case 'imageView':
      return { kind: 'tool_call', id, name: 'image_view', args: toolJson(item.path ?? item) };
    default:
      return undefined;
  }
}

function durationLabel(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '';
  return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function toolSucceeded(item: Record<string, unknown>): boolean {
  if (typeof item.success === 'boolean') return item.success;
  if (typeof item.exitCode === 'number') return item.exitCode === 0;
  return item.status !== 'failed' && item.status !== 'declined' && item.error == null;
}

function compactToolOutput(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : json(value, TOOL_RESULT_MAX_CHARS);
  if (!raw) return '';
  const lines = raw.split('\n');
  let compact = raw;
  if (lines.length > 12) {
    const omitted = lines.length - 9;
    compact = [...lines.slice(0, 6), `… (+${omitted} lines) …`, ...lines.slice(-3)].join('\n');
  }
  return boundedUtf8(compact, TOOL_RESULT_MAX_CHARS, TOOL_RESULT_MAX_BYTES);
}

function toolResult(item: Record<string, unknown>): CotEntry | undefined {
  const id = itemId(item);
  if (!id || !['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(String(item.type))) {
    return undefined;
  }
  const duration = durationLabel(item.durationMs);
  const status = `${toolSucceeded(item) ? '✓' : '✗'}${duration ? ` ${duration}` : ''}`;
  const output = compactToolOutput(
    item.aggregatedOutput ?? item.result ?? item.contentItems ?? item.output ?? item.error,
  );
  return {
    kind: 'tool_result',
    id,
    result: boundedUtf8(
      output ? `${status}\n${output}` : status,
      TOOL_RESULT_MAX_CHARS,
      TOOL_RESULT_MAX_BYTES,
    ),
  };
}

function completedReasoningText(item: Record<string, unknown>): string {
  const summary = Array.isArray(item.summary)
    ? item.summary
        .map(block => typeof block === 'string'
          ? bounded(block, THINKING_MAX_CHARS)
          : block && typeof block === 'object'
            ? bounded((block as Record<string, unknown>).text, THINKING_MAX_CHARS)
            : '')
        .filter(Boolean)
        .join('\n\n')
    : '';
  return boundedUtf8(summary || item.text, THINKING_MAX_CHARS, THINKING_MAX_BYTES);
}

interface TextStreamState {
  full: string;
  emitted: number;
}

function readyTextBoundary(text: string): number {
  const paragraph = text.lastIndexOf('\n');
  if (paragraph >= 0) return paragraph + 1;
  for (let index = text.length - 1; index >= 0; index--) {
    if ('。！？!?'.includes(text[index])) return index + 1;
    if (text[index] === '.' && (index + 1 === text.length || /\s/.test(text[index + 1]))) return index + 1;
  }
  if (text.length < STREAM_CHUNK_TARGET_CHARS) return 0;
  const space = text.lastIndexOf(' ', STREAM_CHUNK_TARGET_CHARS);
  return space > STREAM_CHUNK_TARGET_CHARS / 2 ? space + 1 : STREAM_CHUNK_TARGET_CHARS;
}

/**
 * Converts Codex App Server's public progress events into Botmux's cosmetic
 * thinking timeline. It intentionally consumes summary/commentary text and
 * tool activity only; raw reasoning deltas are not forwarded.
 */
export class CodexAppCotCollector {
  private readonly streams = new Map<string, TextStreamState>();
  private readonly messagePhases = new Map<string, unknown>();

  reset(): void {
    this.streams.clear();
    this.messagePhases.clear();
  }

  private appendStream(key: string, delta: string): TextStreamState {
    const state = this.streams.get(key) ?? { full: '', emitted: 0 };
    state.full = boundedUtf8(appendBounded(state.full, delta, THINKING_MAX_CHARS), THINKING_MAX_CHARS, THINKING_MAX_BYTES);
    this.streams.set(key, state);
    return state;
  }

  private completeStream(key: string, authoritativeText = ''): CotEntry[] {
    const state = this.streams.get(key) ?? { full: '', emitted: 0 };
    if (authoritativeText && authoritativeText.startsWith(state.full)) {
      state.full = boundedUtf8(authoritativeText, THINKING_MAX_CHARS, THINKING_MAX_BYTES);
    } else if (!state.full) {
      state.full = boundedUtf8(authoritativeText, THINKING_MAX_CHARS, THINKING_MAX_BYTES);
    }
    this.streams.delete(key);
    const text = state.full.slice(state.emitted).trim();
    return text ? [{ kind: 'thinking', text }] : [];
  }

  private streamReady(key: string, delta: string): CotEntry[] {
    const state = this.appendStream(key, delta);
    const pending = state.full.slice(state.emitted);
    const boundary = readyTextBoundary(pending);
    if (boundary === 0) return [];
    const text = pending.slice(0, boundary).trim();
    state.emitted += boundary;
    return text ? [{ kind: 'thinking', text }] : [];
  }

  observe(method: string, params: Record<string, unknown>): CotEntry[] {
    if (method === 'item/reasoning/summaryTextDelta') {
      const id = typeof params.itemId === 'string' ? params.itemId : '';
      const delta = typeof params.delta === 'string' ? params.delta : '';
      return id && delta ? this.streamReady(`reasoning:${id}`, delta) : [];
    }
    if (method === 'item/agentMessage/delta') {
      const id = typeof params.itemId === 'string' ? params.itemId : '';
      const delta = typeof params.delta === 'string' ? params.delta : '';
      return id && delta && this.messagePhases.get(id) === 'commentary'
        ? this.streamReady(`message:${id}`, delta)
        : [];
    }

    const item = params.item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;

    if (method === 'item/started') {
      if (record.type === 'agentMessage') this.messagePhases.set(itemId(record), record.phase);
      const call = toolCall(record);
      return call ? [call] : [];
    }
    if (method !== 'item/completed') return [];

    if (record.type === 'reasoning') {
      const id = itemId(record);
      return this.completeStream(`reasoning:${id}`, completedReasoningText(record));
    }
    if (record.type === 'agentMessage') {
      const id = itemId(record);
      this.messagePhases.delete(id);
      if (record.phase === 'commentary') {
        return this.completeStream(
          `message:${id}`,
          boundedUtf8(record.text, THINKING_MAX_CHARS, THINKING_MAX_BYTES),
        );
      }
      this.streams.delete(`message:${id}`);
      return [];
    }
    const result = toolResult(record);
    return result ? [result] : [];
  }
}

export interface CodexAppCotMarker {
  turnId: string;
  entries: CotEntry[];
}

function payloadBytes(payload: CodexAppCotMarker): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

function fitEntryTextToPayload(
  payload: CodexAppCotMarker,
  entry: CotEntry,
  key: 'text' | 'args' | 'result',
): boolean {
  const original = (entry as unknown as Record<string, unknown>)[key];
  if (typeof original !== 'string' || !original) return false;
  const characters = [...original];
  let low = 0;
  let high = characters.length;
  let best = '';
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = count === characters.length
      ? original
      : `${characters.slice(0, count).join('')}…`;
    (entry as unknown as Record<string, unknown>)[key] = candidate;
    if (payloadBytes(payload) <= CODEX_APP_CONTROL_COT_PAYLOAD_MAX_BYTES) {
      best = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  (entry as unknown as Record<string, unknown>)[key] = best;
  return Boolean(best);
}

/**
 * Final producer-side boundary: fit the exact JSON payload that will be signed,
 * including JSON escaping and the real turn id, to the worker's shared budget.
 */
export function prepareCodexAppCotMarker(turnId: string, entries: CotEntry[]): CodexAppCotMarker | undefined {
  const payload: CodexAppCotMarker = {
    turnId,
    entries: entries.map(entry => ({ ...entry })),
  };
  if (payloadBytes(payload) > CODEX_APP_CONTROL_COT_PAYLOAD_MAX_BYTES) {
    for (let index = payload.entries.length - 1; index >= 0; index--) {
      const entry = payload.entries[index];
      const key = entry.kind === 'thinking' ? 'text' : entry.kind === 'tool_call' ? 'args' : 'result';
      fitEntryTextToPayload(payload, entry, key);
      if (payloadBytes(payload) <= CODEX_APP_CONTROL_COT_PAYLOAD_MAX_BYTES) break;
    }
  }
  return normalizeCodexAppCotMarker(payload);
}

/** Strictly validate the signed runner payload before it reaches Feishu. */
export function normalizeCodexAppCotMarker(payload: unknown): CodexAppCotMarker | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'turnId' && key !== 'entries')) return undefined;
  if (typeof record.turnId !== 'string' || record.turnId.length === 0 || record.turnId.length > 512) return undefined;
  if (!Array.isArray(record.entries) || record.entries.length === 0 || record.entries.length > 8) return undefined;
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > CODEX_APP_CONTROL_COT_PAYLOAD_MAX_BYTES) return undefined;
  const entries: CotEntry[] = [];
  for (const entry of record.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const value = entry as Record<string, unknown>;
    if (value.kind === 'thinking') {
      if (typeof value.text !== 'string' || !value.text || value.text.length > THINKING_MAX_CHARS
          || Buffer.byteLength(value.text, 'utf8') > THINKING_MAX_BYTES
          || Object.keys(value).some(key => key !== 'kind' && key !== 'text')) return undefined;
      entries.push({ kind: 'thinking', text: value.text });
      continue;
    }
    if (value.kind === 'tool_call') {
      if (typeof value.id !== 'string' || !value.id || value.id.length > 512
          || typeof value.name !== 'string' || !value.name || value.name.length > 120
          || Buffer.byteLength(value.name, 'utf8') > TOOL_NAME_MAX_BYTES
          || typeof value.args !== 'string' || value.args.length > TOOL_ARGS_MAX_CHARS
          || Buffer.byteLength(value.args, 'utf8') > TOOL_ARGS_MAX_BYTES
          || Object.keys(value).some(key => !['kind', 'id', 'name', 'args'].includes(key))) return undefined;
      entries.push({ kind: 'tool_call', id: value.id, name: value.name, args: value.args });
      continue;
    }
    if (value.kind === 'tool_result') {
      if (typeof value.id !== 'string' || !value.id || value.id.length > 512
          || typeof value.result !== 'string' || !value.result || value.result.length > TOOL_RESULT_MAX_CHARS
          || Buffer.byteLength(value.result, 'utf8') > TOOL_RESULT_MAX_BYTES
          || Object.keys(value).some(key => !['kind', 'id', 'result'].includes(key))) return undefined;
      entries.push({ kind: 'tool_result', id: value.id, result: value.result });
      continue;
    }
    return undefined;
  }
  return { turnId: record.turnId, entries };
}
