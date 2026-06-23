import { phaseForTool, normalizeToolName } from './classify.js';
import { intentForToolInput, resultForToolOutput } from './intent.js';
import { readCompleteJsonlObjects } from './jsonl.js';
import { safePromptPreview } from './prompt.js';
import { safeCommandPreview, safeOutputPreview } from './safe-detail.js';
import type { InsightParseResult, InsightReaderOptions, RawInsightSpan } from './types.js';

function tsMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function unquoteValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  let out = value.trim();
  for (let i = 0; i < 2; i++) {
    if (!/^".*"$/.test(out)) break;
    try {
      const parsed = JSON.parse(out);
      if (typeof parsed !== 'string') return parsed;
      out = parsed;
    } catch {
      break;
    }
  }
  return out;
}

function cleanArgs(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    out[key] = unquoteValue(value);
  }
  return out;
}

function toolLabel(name: unknown): string {
  const id = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (id === 'run_command') return 'Bash';
  if (id === 'view_file') return 'Read';
  if (id === 'list_dir' || id === 'list_directory') return 'LS';
  if (id === 'grep_search') return 'Grep';
  if (id === 'search_web') return 'WebSearch';
  if (id === 'edit_file' || id === 'replace_file' || id === 'str_replace') return 'Edit';
  if (id === 'write_file') return 'Write';
  if (id === 'manage_task') return 'Task';
  return normalizeToolName(name);
}

function normalizedInput(tool: string, args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args) return undefined;
  const input: Record<string, unknown> = { ...args };
  if (typeof args.CommandLine === 'string') input.command = args.CommandLine;
  const path = args.AbsolutePath ?? args.FilePath ?? args.DirectoryPath ?? args.SearchPath;
  if (typeof path === 'string') input.path = path.replace(/^file:\/\//, '');
  if (typeof args.Query === 'string') input.query = args.Query;
  if (tool === 'Bash' && typeof input.command === 'string') return { command: input.command };
  return input;
}

function inputSummary(tool: string): string | undefined {
  const phase = phaseForTool(tool);
  if (phase === 'run') return 'shell command';
  if (phase === 'edit') return 'file edit';
  if (phase === 'research') return 'read/search';
  if (phase === 'delegate') return 'agent task';
  return undefined;
}

function filePathsFromInput(input: Record<string, unknown> | undefined): string[] | undefined {
  if (!input) return undefined;
  const paths = [input.path, input.file_path, input.AbsolutePath, input.FilePath, input.DirectoryPath, input.SearchPath]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map(p => p.replace(/^file:\/\//, ''));
  return paths.length ? [...new Set(paths)] : undefined;
}

function filePathFromContent(content: string): string[] {
  const paths: string[] = [];
  const fileUri = /File Path:\s*`file:\/\/([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = fileUri.exec(content))) {
    if (match[1]) paths.push(match[1]);
  }
  const jsonFile = /"File"\s*:\s*"([^"]+)"/g;
  while ((match = jsonFile.exec(content))) {
    if (match[1]) paths.push(match[1]);
  }
  return [...new Set(paths)];
}

function extractPrompt(content: unknown): string | undefined {
  if (typeof content !== 'string') return undefined;
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(content);
  return (match?.[1] ?? content).trim();
}

function completedMs(content: string): number | undefined {
  const created = /Created At:\s*([^\n]+?)\s+Completed At:/i.exec(content)?.[1];
  const completed = /Completed At:\s*([^\n]+?)(?:\s+(?:The|Output:|\{|\w+:)|$)/i.exec(content)?.[1];
  if (!created || !completed) return undefined;
  const start = Date.parse(created.trim());
  const end = Date.parse(completed.trim());
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
}

function failedExit(output: string): number | undefined {
  // Match the real exit phrasings ("Process exited with code N", "Exit Code: N",
  // "exited N") but bound the gap to the number ([\s:=]{0,4}) so it can't skip
  // whole words to an unrelated number (the old [^\d-]* did).
  const m = /(?:process\s+)?exit(?:ed)?(?:\s+with)?(?:\s+code)?[\s:=]{0,4}(-?\d+)/i.exec(output);
  if (!m) return undefined;
  const code = Number(m[1]);
  return Number.isFinite(code) && code !== 0 ? code : undefined;
}

function isErrorResult(entry: any, output: string): boolean {
  if (entry?.status && entry.status !== 'DONE') return true;
  if (/completed successfully/i.test(output)) return false;
  if (failedExit(output) !== undefined) return true;
  return /\b(error|failed|timed out|timeout)\b/i.test(output) && !/No results found/i.test(output);
}

function resultTypeForTool(tool: string): string {
  if (tool === 'Bash') return 'RUN_COMMAND';
  if (tool === 'Read') return 'VIEW_FILE';
  if (tool === 'LS') return 'LIST_DIRECTORY';
  if (tool === 'Grep') return 'GREP_SEARCH';
  if (tool === 'WebSearch') return 'SEARCH_WEB';
  if (tool === 'Task') return 'GENERIC';
  return tool.toUpperCase();
}

function matchingPendingIndex(pending: RawInsightSpan[], type: string): number {
  const idx = pending.findIndex(span => resultTypeForTool(span.tool) === type);
  return idx >= 0 ? idx : 0;
}

export function parseAntigravityInsight(path: string, opts: InsightReaderOptions = {}): InsightParseResult {
  const read = readCompleteJsonlObjects(path);
  const spans: RawInsightSpan[] = [];
  const pending: RawInsightSpan[] = [];
  const turnPrompts: InsightParseResult['turnPrompts'] = [];
  let currentTurn = -1;
  let firstEventMs: number | undefined;

  for (const entry of read.entries) {
    const ms = tsMs(entry?.created_at);
    if (ms !== undefined) firstEventMs = firstEventMs === undefined ? ms : Math.min(firstEventMs, ms);
    if (entry?.source === 'USER_EXPLICIT' && entry?.type === 'USER_INPUT') {
      currentTurn++;
      const preview = safePromptPreview(extractPrompt(entry.content), opts.promptMax);
      if (preview) turnPrompts[currentTurn] = preview;
      continue;
    }

    if (entry?.type === 'PLANNER_RESPONSE' && Array.isArray(entry.tool_calls)) {
      for (const call of entry.tool_calls) {
        const tool = toolLabel(call?.name);
        const args = cleanArgs(call?.args);
        const input = normalizedInput(tool, args);
        const span: RawInsightSpan = {
          tool,
          phase: phaseForTool(tool),
          turnIndex: Math.max(currentTurn, 0),
          startMs: ms,
          status: 'running',
          inputSummary: inputSummary(tool),
          intent: intentForToolInput(tool, input),
        };
        if (span.phase === 'run') {
          const command = safeCommandPreview(input);
          if (command) span.evidence = { command };
        }
        const filePaths = filePathsFromInput(input);
        if (filePaths) span.filePaths = filePaths;
        spans.push(span);
        pending.push(span);
      }
      continue;
    }

    if (entry?.source !== 'MODEL' || entry?.type === 'PLANNER_RESPONSE' || typeof entry?.type !== 'string') continue;
    if (pending.length === 0) continue;
    const idx = matchingPendingIndex(pending, entry.type);
    const span = pending.splice(idx, 1)[0];
    if (!span) continue;
    const output = typeof entry.content === 'string' ? entry.content : '';
    const exitCode = failedExit(output);
    const errored = isErrorResult(entry, output);
    span.status = errored ? 'error' : 'ok';
    span.outputSummary = errored && exitCode !== undefined ? `exit ${exitCode}` : errored ? 'tool error' : 'tool result';
    span.result = resultForToolOutput(span, output, errored, exitCode);
    const duration = completedMs(output);
    if (duration !== undefined) span.durationMs = duration;
    else if (ms !== undefined && span.startMs !== undefined) span.durationMs = Math.max(0, ms - span.startMs);
    const contentPaths = filePathFromContent(output);
    if (contentPaths.length > 0) span.filePaths = [...new Set([...(span.filePaths ?? []), ...contentPaths])];
    if (span.phase === 'run') {
      const safeOutput = safeOutputPreview(output);
      if (safeOutput) span.evidence = { ...(span.evidence ?? {}), output: safeOutput };
    }
  }

  for (const span of pending) {
    span.status = 'ok';
    span.result = { category: 'unknown' };
  }

  return {
    spans,
    compactions: 0,
    partial: read.partial,
    asOf: read.asOf,
    firstEventMs,
    turnPrompts,
  };
}
