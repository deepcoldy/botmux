import { phaseForTool, normalizeToolName, isUserRejectionText } from './classify.js';
import { intentForToolInput, resultForToolOutput } from './intent.js';
import { readCompleteJsonlObjects } from './jsonl.js';
import { safePromptPreview } from './prompt.js';
import { safeCommandPreview, safeOutputPreview, safeTextPreview } from './safe-detail.js';
import type { AgentSay, InsightParseResult, InsightReaderOptions, RawInsightSpan, TurnContextPoint } from './types.js';

// Per-turn agent narration cap. Generous (conversation replay wants the agent's
// reasoning), still bounded — the scrubber also caps + redacts secrets.
const AGENT_SAY_MAX = 1500;

function tsMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function blocks(entry: any): any[] {
  const content = entry?.message?.content;
  return Array.isArray(content) ? content : [];
}

function isToolResultBlock(block: any): boolean {
  return block?.type === 'tool_result' && typeof block.tool_use_id === 'string';
}

function isUserPromptEvent(entry: any): boolean {
  const role = entry?.message?.role ?? entry?.type;
  if (role !== 'user') return false;
  const content = entry?.message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  const meaningful = content.filter((b: any) => b?.type !== 'tool_result');
  return meaningful.some((b: any) =>
    typeof b === 'string' ? b.trim().length > 0 :
      b?.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0);
}

function promptText(entry: any): string | undefined {
  const role = entry?.message?.role ?? entry?.type;
  if (role !== 'user') return undefined;
  const content = entry?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter((b: any) => b?.type !== 'tool_result')
    .map((b: any) => typeof b === 'string' ? b : b?.type === 'text' && typeof b.text === 'string' ? b.text : '')
    .filter((s: string) => s.trim().length > 0);
  return parts.length ? parts.join('\n') : undefined;
}

function compact(value: unknown, max = 160): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value); }
    catch { text = String(value); }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : undefined;
}

function inputObject(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input !== 'string') return undefined;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function filePathsFromInput(input: unknown): string[] | undefined {
  const obj = inputObject(input);
  const paths = [obj?.file_path, obj?.path]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return paths.length ? [...new Set(paths)] : undefined;
}

function patchTextFromInput(input: unknown): string | undefined {
  const obj = inputObject(input);
  for (const key of ['patch', 'diff', 'content']) {
    if (typeof obj?.[key] === 'string') return obj[key] as string;
  }
  return typeof input === 'string' && input.includes('*** Begin Patch') ? input : undefined;
}

function countLines(value: string): number {
  if (!value) return 0;
  return value.split(/\r\n|\r|\n/).length;
}

function editLineCountsFromInput(input: unknown): { added: number; removed: number } | undefined {
  const obj = inputObject(input);
  if (!obj) return undefined;
  const oldValue = ['old_string', 'oldStr', 'oldText', 'before', 'search']
    .map(key => obj[key])
    .find((v): v is string => typeof v === 'string');
  const newValue = ['new_string', 'newStr', 'newText', 'replacement', 'replace', 'after', 'content']
    .map(key => obj[key])
    .find((v): v is string => typeof v === 'string');
  if (oldValue === undefined && newValue === undefined) return undefined;
  const removed = oldValue === undefined ? 0 : countLines(oldValue);
  const added = newValue === undefined ? 0 : countLines(newValue);
  return added > 0 || removed > 0 ? { added, removed } : undefined;
}

function summarizeToolInput(tool: string, input: unknown): string | undefined {
  const phase = phaseForTool(tool);
  if (phase === 'run') return 'shell command';
  if (phase === 'edit') return 'file edit';
  if (phase === 'research') return 'read/search';
  if (phase === 'delegate') return 'agent task';
  return compact(input, 80) ? 'tool input' : undefined;
}

function summarizeToolOutput(result: any): string | undefined {
  if (result?.is_error === true) return 'tool error';
  if (result?.content === undefined) return undefined;
  return 'tool result';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function contextPointForUsage(turnIndex: number, msg: any): TurnContextPoint | undefined {
  const usage = msg?.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const inputTokens = num(usage.input_tokens);
  const outputTokens = num(usage.output_tokens);
  const cacheReadTokens = num(usage.cache_read_input_tokens);
  const cacheCreateTokens = num(usage.cache_creation_input_tokens);
  if (inputTokens + outputTokens + cacheReadTokens + cacheCreateTokens <= 0) return undefined;
  const contextTokens = inputTokens + cacheReadTokens + cacheCreateTokens;
  return {
    turnIndex: Math.max(turnIndex, 0),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    contextTokens,
    totalTokens: contextTokens + outputTokens,
    ...(typeof msg?.model === 'string' && msg.model ? { model: msg.model } : {}),
  };
}

export function parseClaudeInsight(path: string, opts: InsightReaderOptions = {}): InsightParseResult {
  const read = readCompleteJsonlObjects(path);
  const spans: RawInsightSpan[] = [];
  const pending = new Map<string, RawInsightSpan>();
  let firstEventMs: number | undefined;
  let currentTurn = -1;
  let compactions = 0;
  const turnPrompts: InsightParseResult['turnPrompts'] = [];
  const turnContext: TurnContextPoint[] = [];
  const sayBuf: string[][] = [];
  const seenUsageMessageIds = new Set<string>();

  for (const entry of read.entries) {
    const ms = tsMs(entry.timestamp);
    if (ms !== undefined) firstEventMs = firstEventMs === undefined ? ms : Math.min(firstEventMs, ms);
    if (entry?.type === 'system' && entry?.subtype === 'compact_boundary') compactions++;
    if (isUserPromptEvent(entry)) {
      currentTurn++;
      const preview = safePromptPreview(promptText(entry), opts.promptMax);
      if (preview) turnPrompts[currentTurn] = preview;
    }

    if (entry?.type === 'assistant') {
      const messageId = typeof entry?.message?.id === 'string' ? entry.message.id : '';
      if (!messageId || !seenUsageMessageIds.has(messageId)) {
        const point = contextPointForUsage(currentTurn, entry.message);
        if (point) {
          turnContext[point.turnIndex] = { ...(turnContext[point.turnIndex] ?? {}), ...point };
          if (messageId) seenUsageMessageIds.add(messageId);
        }
      }
    }

    for (const block of blocks(entry)) {
      if (entry?.type === 'assistant' && block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        (sayBuf[Math.max(currentTurn, 0)] ??= []).push(block.text);
      } else if (block?.type === 'tool_use' && typeof block.id === 'string') {
        const tool = normalizeToolName(block.name);
        const span: RawInsightSpan = {
          tool,
          phase: phaseForTool(tool),
          turnIndex: Math.max(currentTurn, 0),
          startMs: ms,
          status: 'running',
          inputSummary: summarizeToolInput(tool, block.input),
          intent: intentForToolInput(tool, block.input),
        };
        if (span.phase === 'run') {
          const command = safeCommandPreview(block.input);
          if (command) span.evidence = { command };
        }
        const filePaths = filePathsFromInput(block.input);
        if (filePaths) span.filePaths = filePaths;
        const patchText = patchTextFromInput(block.input);
        if (patchText) span.patchText = patchText;
        const lineCounts = editLineCountsFromInput(block.input);
        if (lineCounts) span.lineCounts = lineCounts;
        spans.push(span);
        pending.set(block.id, span);
      } else if (isToolResultBlock(block)) {
        const span = pending.get(block.tool_use_id);
        if (!span) continue;
        // tool_result content may be a string OR an array of {type:'text',text}
        // blocks — flatten the array form too, else a successful array result
        // looks empty and mislabels as 'no_output'.
        const output = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .map((c: any) => (typeof c === 'string' ? c : typeof c?.text === 'string' ? c.text : ''))
                .join('\n')
                .trim() || undefined
            : undefined;
        // A user rejecting a proposed tool use lands as is_error but is user
        // behaviour, not a tool/agent failure — don't let it count as a failure.
        const errored = block.is_error === true && !isUserRejectionText(output);
        span.status = errored ? 'error' : 'ok';
        span.outputSummary = summarizeToolOutput({ is_error: errored, content: block.content });
        span.result = resultForToolOutput(span, output, errored);
        if (span.phase === 'run') {
          const safeOutput = safeOutputPreview(block.content);
          if (safeOutput) span.evidence = { ...(span.evidence ?? {}), output: safeOutput };
        }
        if (ms !== undefined && span.startMs !== undefined) span.durationMs = Math.max(0, ms - span.startMs);
        pending.delete(block.tool_use_id);
      }
    }
  }

  const turnAgentSay: AgentSay[] = [];
  sayBuf.forEach((chunks, i) => {
    if (!chunks?.length) return;
    const p = safeTextPreview(chunks.join('\n\n'), AGENT_SAY_MAX);
    if (p) turnAgentSay[i] = { text: p.text, truncated: p.truncated };
  });

  return {
    spans,
    compactions,
    partial: read.partial,
    asOf: read.asOf,
    firstEventMs,
    turnPrompts,
    turnContext,
    turnAgentSay,
  };
}
