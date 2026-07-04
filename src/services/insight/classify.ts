import type { InsightPhase } from './types.js';

function toolId(tool: string): string {
  return tool.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_');
}

export function normalizeToolName(value: unknown): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : 'unknown';
  if (raw === 'apply_patch') return 'apply_patch';
  if (/^shell$/i.test(raw)) return 'Bash';
  return raw.slice(0, 80);
}

export function phaseForTool(tool: string): InsightPhase {
  const id = toolId(tool);
  // Planning / bookkeeping tools (the todo list) are neither file reads nor
  // file writes. Without this guard `TodoWrite` matches `write` → edit and
  // `TodoRead` matches `read` → research, which silently pollutes the
  // read/write ratio and can fire a bogus "修改多于阅读" suggestion.
  if (id.includes('todo')) return 'discuss';
  if (
    id.includes('read') ||
    id.includes('grep') ||
    id.includes('glob') ||
    id.includes('search') ||
    id.includes('list') ||
    id === 'ls'
  ) return 'research';
  if (
    id.includes('edit') ||
    id.includes('write') ||
    id.includes('patch') ||
    id.includes('apply_patch') ||
    id.includes('notebookedit')
  ) return 'edit';
  if (
    id.includes('bash') ||
    id.includes('shell') ||
    id.includes('exec') ||
    id.includes('command') ||
    id.includes('write_stdin')
  ) return 'run';
  if (id.includes('task') || id.includes('agent') || id.includes('workflow')) return 'delegate';
  return 'discuss';
}

// Tools that block on a human reply (question prompts, plan approval). Their
// wall-clock duration is mostly user idle time, not agent work, so it must not
// count toward work-time aggregation or slow-span detection — otherwise a user
// who answers a question 78 minutes later shows up as 78 minutes of "discuss".
const INTERACTIVE_WAIT_TOOLS = new Set(['askuserquestion', 'exitplanmode']);
export function isInteractiveWaitTool(tool: string): boolean {
  return INTERACTIVE_WAIT_TOOLS.has(toolId(tool));
}

// A user *declining* a proposed tool use (rejecting an edit, dismissing a
// question) is delivered as an is_error tool_result, but it is NOT a tool or
// agent failure — it is user behaviour. Counting it inflates failedSpans /
// failByTool and the failure-friction suggestions. Detect Claude Code's
// canonical rejection strings so these can be excluded from failure stats while
// genuine errors (InputValidationError, file-not-read, exit codes…) still count.
export function isUserRejectionText(text: string | undefined | null): boolean {
  if (!text) return false;
  return /the user doesn.?t want to proceed with this tool use|tool use was rejected/i.test(text);
}

export function isReadPhase(phase: InsightPhase): boolean {
  return phase === 'research';
}

export function isWritePhase(phase: InsightPhase): boolean {
  return phase === 'edit';
}

export function safeToolLabel(tool: string): string {
  return normalizeToolName(tool).replace(/[^\w:./-]+/g, '_').slice(0, 80) || 'unknown';
}
