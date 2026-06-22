import { phaseForTool, normalizeToolName } from './classify.js';
import { intentForCodexArguments, resultForToolOutput } from './intent.js';
import { readCompleteJsonlObjects } from './jsonl.js';
import { safePromptPreview } from './prompt.js';
import { safeCommandPreview, safeOutputPreview, safeTextPreview } from './safe-detail.js';
import type { AgentSay, InsightParseResult, InsightReaderOptions, RawInsightSpan, TurnContextPoint } from './types.js';

const AGENT_SAY_MAX = 1500;

function tsMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function compact(value: unknown, max = 160): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).replace(/\s+/g, ' ').trim();
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

function filePathsFromPatch(patch: string | undefined): string[] {
  if (!patch) return [];
  const paths: string[] = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch))) paths.push((m[1] ?? '').trim());
  return paths.filter(Boolean);
}

function filePathsFromInput(input: unknown): string[] | undefined {
  const obj = inputObject(input);
  const patch = patchTextFromInput(input);
  const paths = [
    obj?.file_path,
    obj?.path,
    ...filePathsFromPatch(patch),
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
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

function normalizeCodexTool(payload: any): string | null {
  if (payload?.type === 'custom_tool_call' && payload.name === 'apply_patch') return 'apply_patch';
  if (payload?.type !== 'function_call') return null;
  if (typeof payload.name === 'string' && payload.name) return normalizeToolName(payload.name);
  return 'function_call';
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map(outputText).filter(Boolean).join('\n');
  if (output && typeof output === 'object') {
    const any = output as any;
    if (typeof any.text === 'string') return any.text;
    if (typeof any.content === 'string') return any.content;
    try { return JSON.stringify(output); } catch { return String(output); }
  }
  return '';
}

function failedExit(output: string): number | null {
  // Match the real exit phrasings ("Process exited with code N", "exit code: N",
  // "exited N") but bound the gap to the number ([\s:=]{0,4}) so it can't skip
  // whole words to an unrelated number (the old [^\d-]* matched "exited from
  // menu. 1 file changed" → 1).
  const m = /(?:process\s+)?exit(?:ed)?(?:\s+with)?(?:\s+code)?[\s:=]{0,4}(-?\d+)/i.exec(output);
  if (!m) return null;
  const code = Number(m[1]);
  return Number.isFinite(code) && code !== 0 ? code : null;
}

function wallMs(output: string): number | undefined {
  const m = /Wall time:\s*([0-9.]+)s/i.exec(output);
  if (!m) return undefined;
  const seconds = Number(m[1]);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
}

function safeOutputSummary(output: string, errored: boolean): string | undefined {
  const code = failedExit(output);
  if (code !== null) return `exit ${code}`;
  if (errored) return 'tool error';
  return compact(output) ? 'tool result' : undefined;
}

function inputSummary(tool: string): string | undefined {
  const phase = phaseForTool(tool);
  if (phase === 'run') return 'shell command';
  if (phase === 'edit') return 'file edit';
  if (phase === 'research') return 'read/search';
  if (phase === 'delegate') return 'agent task';
  return undefined;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function pickNum(obj: any, keys: readonly string[]): number {
  if (!obj || typeof obj !== 'object') return 0;
  for (const key of keys) {
    const value = num(obj[key]);
    if (value) return value;
  }
  return 0;
}

function contextPointFromTokenCount(turnIndex: number, payload: any, model: string): TurnContextPoint | undefined {
  if (payload?.type !== 'token_count') return undefined;
  const usage = payload?.info?.total_token_usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const inputTokens = pickNum(usage, ['input_tokens', 'inputTokens']);
  const outputTokens = pickNum(usage, ['output_tokens', 'outputTokens']);
  const cacheReadTokens = pickNum(usage, ['cached_input_tokens', 'cachedInputTokens', 'cache_read_input_tokens', 'cacheReadInputTokens']);
  const cacheCreateTokens = pickNum(usage, ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_write_input_tokens', 'cacheWriteInputTokens']);
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
    ...(model ? { model } : {}),
  };
}

export function parseCodexInsight(path: string, opts: InsightReaderOptions = {}): InsightParseResult {
  const read = readCompleteJsonlObjects(path);
  const spans: RawInsightSpan[] = [];
  const byCall = new Map<string, RawInsightSpan>();
  let firstEventMs: number | undefined;
  let currentTurn = -1;
  let compactions = 0;
  const turnPrompts: InsightParseResult['turnPrompts'] = [];
  const turnContext: TurnContextPoint[] = [];
  const sayBuf: string[][] = [];
  let currentModel = '';

  for (const entry of read.entries) {
    const ms = tsMs(entry.timestamp);
    if (ms !== undefined) firstEventMs = firstEventMs === undefined ? ms : Math.min(firstEventMs, ms);
    const payload = entry?.payload ?? {};

    if (entry?.type === 'compacted' || payload.type === 'context_compacted') compactions++;
    const model = payload.model ?? payload.collaboration_mode?.settings?.model;
    if (typeof model === 'string' && model) currentModel = model;
    if (entry?.type === 'event_msg' && payload.type === 'user_message') {
      currentTurn++;
      const preview = safePromptPreview(typeof payload.message === 'string' ? payload.message : outputText(payload.message), opts.promptMax);
      if (preview) turnPrompts[currentTurn] = preview;
    }
    if (entry?.type === 'event_msg' && payload.type === 'token_count') {
      const point = contextPointFromTokenCount(currentTurn, payload, currentModel);
      if (point) turnContext[point.turnIndex] = { ...(turnContext[point.turnIndex] ?? {}), ...point };
    }
    if (entry?.type === 'event_msg' && payload.type === 'agent_message') {
      const msg = typeof payload.message === 'string' ? payload.message : outputText(payload.message);
      if (msg && msg.trim()) (sayBuf[Math.max(currentTurn, 0)] ??= []).push(msg);
    }

    const tool = entry?.type === 'response_item' ? normalizeCodexTool(payload) : null;
    if (tool) {
      const span: RawInsightSpan = {
        tool,
        phase: phaseForTool(tool),
        turnIndex: Math.max(currentTurn, 0),
        startMs: ms,
        status: 'running',
        inputSummary: inputSummary(tool),
        intent: intentForCodexArguments(tool, payload.arguments ?? payload.input),
      };
      if (span.phase === 'run') {
        const command = safeCommandPreview(payload.arguments ?? payload.input);
        if (command) span.evidence = { command };
      }
      const filePaths = filePathsFromInput(payload.arguments ?? payload.input);
      if (filePaths) span.filePaths = filePaths;
      const patchText = patchTextFromInput(payload.arguments ?? payload.input);
      if (patchText) span.patchText = patchText;
      const lineCounts = editLineCountsFromInput(payload.arguments ?? payload.input);
      if (lineCounts) span.lineCounts = lineCounts;
      spans.push(span);
      if (typeof payload.call_id === 'string') byCall.set(payload.call_id, span);
      continue;
    }

    if (entry?.type === 'response_item' && (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')) {
      const span = typeof payload.call_id === 'string' ? byCall.get(payload.call_id) : undefined;
      if (!span) continue;
      const out = outputText(payload.output);
      const code = failedExit(out);
      span.status = code !== null ? 'error' : 'ok';
      span.outputSummary = safeOutputSummary(out, code !== null);
      span.result = resultForToolOutput(span, out, code !== null, code ?? undefined);
      if (span.phase === 'run') {
        const safeOutput = safeOutputPreview(out);
        if (safeOutput) span.evidence = { ...(span.evidence ?? {}), output: safeOutput };
      }
      const parsedWallMs = wallMs(out);
      if (parsedWallMs !== undefined) span.durationMs = parsedWallMs;
      else if (ms !== undefined && span.startMs !== undefined) span.durationMs = Math.max(0, ms - span.startMs);
      if (typeof payload.call_id === 'string') byCall.delete(payload.call_id);
      continue;
    }

    if (entry?.type === 'event_msg' && payload.type === 'patch_apply_end') {
      const span = typeof payload.call_id === 'string' ? byCall.get(payload.call_id) : undefined;
      if (!span) continue;
      span.status = payload.success === false ? 'error' : 'ok';
      span.outputSummary = payload.success === false ? 'patch failed' : 'patch applied';
      span.result = resultForToolOutput(span, undefined, payload.success === false);
      if (ms !== undefined && span.startMs !== undefined) span.durationMs = Math.max(0, ms - span.startMs);
      byCall.delete(payload.call_id);
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
