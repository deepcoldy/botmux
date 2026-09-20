import type { CotEntry } from '../types.js';

const THINKING_MAX_CHARS = 2_000;
const TOOL_ARGS_MAX_CHARS = 600;
const TOOL_RESULT_MAX_CHARS = 1_200;

function bounded(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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

function itemId(item: Record<string, unknown>): string {
  return typeof item.id === 'string' && item.id.length > 0 ? item.id : '';
}

function toolCall(item: Record<string, unknown>): CotEntry | undefined {
  const id = itemId(item);
  if (!id) return undefined;
  switch (item.type) {
    case 'commandExecution':
      return { kind: 'tool_call', id, name: 'shell', args: json({ command: item.command }, TOOL_ARGS_MAX_CHARS) };
    case 'fileChange':
      return { kind: 'tool_call', id, name: 'file_change', args: json(item.changes ?? item.diff, TOOL_ARGS_MAX_CHARS) };
    case 'mcpToolCall':
      return {
        kind: 'tool_call',
        id,
        name: [item.server, item.tool].filter(value => typeof value === 'string' && value).join('.') || 'mcp_tool',
        args: json(item.arguments ?? item.args, TOOL_ARGS_MAX_CHARS),
      };
    case 'dynamicToolCall':
      return {
        kind: 'tool_call',
        id,
        name: bounded(item.tool ?? item.name, 120) || 'tool',
        args: json(item.arguments ?? item.args, TOOL_ARGS_MAX_CHARS),
      };
    case 'webSearch':
      return { kind: 'tool_call', id, name: 'web_search', args: json(item.query ?? item.action, TOOL_ARGS_MAX_CHARS) };
    case 'imageView':
      return { kind: 'tool_call', id, name: 'image_view', args: json(item.path ?? item, TOOL_ARGS_MAX_CHARS) };
    default:
      return undefined;
  }
}

function toolResult(item: Record<string, unknown>): CotEntry | undefined {
  const id = itemId(item);
  if (!id || !['commandExecution', 'mcpToolCall', 'dynamicToolCall'].includes(String(item.type))) {
    return undefined;
  }
  const result = bounded(
    typeof item.aggregatedOutput === 'string'
      ? item.aggregatedOutput
      : json(item.result ?? item.output ?? item.error, TOOL_RESULT_MAX_CHARS),
    TOOL_RESULT_MAX_CHARS,
  );
  return result ? { kind: 'tool_result', id, result } : undefined;
}

function completedReasoningText(item: Record<string, unknown>): string {
  const summary = Array.isArray(item.summary)
    ? item.summary
        .map(block => block && typeof block === 'object' ? bounded((block as Record<string, unknown>).text, THINKING_MAX_CHARS) : '')
        .filter(Boolean)
        .join('\n\n')
    : '';
  return bounded(summary || item.text, THINKING_MAX_CHARS);
}

/**
 * Converts Codex App Server's public progress events into Botmux's cosmetic
 * thinking timeline. It intentionally consumes summary/commentary text and
 * tool activity only; raw reasoning deltas are not forwarded.
 */
export class CodexAppCotCollector {
  private readonly reasoningSummary = new Map<string, string>();

  reset(): void {
    this.reasoningSummary.clear();
  }

  observe(method: string, params: Record<string, unknown>): CotEntry[] {
    if (method === 'item/reasoning/summaryTextDelta') {
      const id = typeof params.itemId === 'string' ? params.itemId : '';
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (id && delta) {
        this.reasoningSummary.set(id, appendBounded(this.reasoningSummary.get(id) ?? '', delta, THINKING_MAX_CHARS));
      }
      return [];
    }

    const item = params.item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;

    if (method === 'item/started') {
      const call = toolCall(record);
      return call ? [call] : [];
    }
    if (method !== 'item/completed') return [];

    if (record.type === 'reasoning') {
      const id = itemId(record);
      const text = bounded((id && this.reasoningSummary.get(id)) || completedReasoningText(record), THINKING_MAX_CHARS);
      if (id) this.reasoningSummary.delete(id);
      return text ? [{ kind: 'thinking', text }] : [];
    }
    if (record.type === 'agentMessage' && record.phase !== 'final_answer') {
      const text = bounded(record.text, THINKING_MAX_CHARS);
      return text ? [{ kind: 'thinking', text }] : [];
    }
    const result = toolResult(record);
    return result ? [result] : [];
  }
}

export interface CodexAppCotMarker {
  turnId: string;
  entries: CotEntry[];
}

/** Strictly validate the signed runner payload before it reaches Feishu. */
export function normalizeCodexAppCotMarker(payload: unknown): CodexAppCotMarker | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'turnId' && key !== 'entries')) return undefined;
  if (typeof record.turnId !== 'string' || record.turnId.length === 0 || record.turnId.length > 512) return undefined;
  if (!Array.isArray(record.entries) || record.entries.length === 0 || record.entries.length > 8) return undefined;
  const entries: CotEntry[] = [];
  for (const entry of record.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const value = entry as Record<string, unknown>;
    if (value.kind === 'thinking') {
      if (typeof value.text !== 'string' || !value.text || value.text.length > THINKING_MAX_CHARS
          || Object.keys(value).some(key => key !== 'kind' && key !== 'text')) return undefined;
      entries.push({ kind: 'thinking', text: value.text });
      continue;
    }
    if (value.kind === 'tool_call') {
      if (typeof value.id !== 'string' || !value.id || value.id.length > 512
          || typeof value.name !== 'string' || !value.name || value.name.length > 120
          || typeof value.args !== 'string' || value.args.length > TOOL_ARGS_MAX_CHARS
          || Object.keys(value).some(key => !['kind', 'id', 'name', 'args'].includes(key))) return undefined;
      entries.push({ kind: 'tool_call', id: value.id, name: value.name, args: value.args });
      continue;
    }
    if (value.kind === 'tool_result') {
      if (typeof value.id !== 'string' || !value.id || value.id.length > 512
          || typeof value.result !== 'string' || !value.result || value.result.length > TOOL_RESULT_MAX_CHARS
          || Object.keys(value).some(key => !['kind', 'id', 'result'].includes(key))) return undefined;
      entries.push({ kind: 'tool_result', id: value.id, result: value.result });
      continue;
    }
    return undefined;
  }
  return { turnId: record.turnId, entries };
}
