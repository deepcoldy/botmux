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

export function isReadPhase(phase: InsightPhase): boolean {
  return phase === 'research';
}

export function isWritePhase(phase: InsightPhase): boolean {
  return phase === 'edit';
}

export function safeToolLabel(tool: string): string {
  return normalizeToolName(tool).replace(/[^\w:./-]+/g, '_').slice(0, 80) || 'unknown';
}
