import { basename, extname } from 'node:path';
import { phaseForTool } from './classify.js';
import type { RawInsightSpan, SafeSpanIntent, SafeSpanResult } from './types.js';

function safeSubject(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value.replace(/[^\w@./:-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean || /(?:token|secret|password|passwd|pwd|key)=/i.test(clean)) return undefined;
  return clean.slice(0, 80);
}

function safeBaseName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const base = basename(value.trim());
  if (!base || base === '.' || base === '..') return undefined;
  const ext = extname(base);
  if (ext && base.length > 80) return `*${ext.slice(0, 20)}`;
  return safeSubject(base);
}

function shellWords(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) && out.length < 8) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out.filter(Boolean);
}

function commandFromInput(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'script']) {
    if (typeof obj[key] === 'string') return obj[key] as string;
  }
  return undefined;
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function subjectForPackageCommand(pm: string, words: string[]): SafeSpanIntent {
  const second = words[1];
  const third = words[2];
  if (second === 'test' || second === 'vitest' || second === 'jest') return { kind: 'test', subject: `${pm} ${second}` };
  if (second === 'lint') return { kind: 'lint', subject: `${pm} lint` };
  if (second === 'build') return { kind: 'run_script', subject: `${pm} build`, detail: 'build' };
  if (second === 'exec' && (third === 'tsc' || third === 'vue-tsc')) return { kind: 'typecheck', subject: `${pm} exec ${third}` };
  if ((second === 'run' || second === 'run-script') && third) {
    const script = safeSubject(third);
    if (!script) return { kind: 'run_script', subject: `${pm} run` };
    if (/test|spec|vitest|jest/i.test(script)) return { kind: 'test', subject: `${pm} run ${script}` };
    if (/lint/i.test(script)) return { kind: 'lint', subject: `${pm} run ${script}` };
    if (/type|tsc|check/i.test(script)) return { kind: 'typecheck', subject: `${pm} run ${script}` };
    return { kind: 'run_script', subject: `${pm} run ${script}`, detail: script };
  }
  return { kind: 'run_script', subject: pm };
}

function intentForCommand(command: string | undefined): SafeSpanIntent {
  const words = shellWords(command ?? '');
  const cmd = words[0]?.split('/').pop() ?? '';
  if (!cmd) return { kind: 'unknown' };
  if (['pnpm', 'npm', 'yarn', 'bun'].includes(cmd)) return subjectForPackageCommand(cmd, words);
  if (cmd === 'npx' && (words[1] === 'tsc' || words[1] === 'vue-tsc')) return { kind: 'typecheck', subject: 'npx tsc' };
  if (cmd === 'tsc' || cmd === 'vue-tsc') return { kind: 'typecheck', subject: cmd };
  if (cmd === 'eslint') return { kind: 'lint', subject: 'eslint' };
  if (cmd === 'vitest' || cmd === 'jest' || cmd === 'pytest') return { kind: 'test', subject: cmd };
  if (cmd === 'go' && words[1] === 'test') return { kind: 'test', subject: 'go test' };
  if (cmd === 'cargo' && words[1] === 'test') return { kind: 'test', subject: 'cargo test' };
  if (cmd === 'git') {
    const sub = safeSubject(words[1]);
    return { kind: 'git', subject: sub ? `git ${sub}` : 'git' };
  }
  if (cmd === 'rg' || cmd === 'grep') return { kind: 'search', subject: cmd };
  return { kind: 'unknown' };
}

export function intentForToolInput(tool: string, input: unknown): SafeSpanIntent {
  const phase = phaseForTool(tool);
  if (phase === 'run') return intentForCommand(commandFromInput(input));
  if (phase === 'research') return {
    kind: tool.toLowerCase().includes('read') ? 'read_file' : 'search',
    subject: safeBaseName(parseJsonObject(input)?.file_path ?? parseJsonObject(input)?.path),
  };
  if (phase === 'edit') return {
    kind: tool.toLowerCase().includes('write') ? 'write_file' : 'edit_file',
    subject: safeBaseName(parseJsonObject(input)?.file_path ?? parseJsonObject(input)?.path) ?? (tool === 'apply_patch' ? 'patch' : undefined),
  };
  if (phase === 'delegate') return { kind: 'delegate', subject: 'agent task' };
  return { kind: 'unknown' };
}

export function intentForCodexArguments(tool: string, args: unknown): SafeSpanIntent {
  const parsed = parseJsonObject(args);
  return intentForToolInput(tool, parsed ?? args);
}

export function resultForToolOutput(span: RawInsightSpan, output: string | undefined, errored: boolean, exitCode?: number): SafeSpanResult {
  if (!errored && exitCode === undefined) return { category: output ? 'ok' : 'no_output' };
  const out = output ?? '';
  if (/timed?\s*out|timeout/i.test(out)) return { category: 'timeout', ...(exitCode !== undefined ? { exitCode } : {}) };
  if (span.intent?.kind === 'test') return { category: 'test_failed', ...(exitCode !== undefined ? { exitCode } : {}) };
  if (span.intent?.kind === 'typecheck') return { category: 'typecheck_failed', ...(exitCode !== undefined ? { exitCode } : {}) };
  if (span.intent?.kind === 'lint') return { category: 'lint_failed', ...(exitCode !== undefined ? { exitCode } : {}) };
  if (span.phase === 'run') return { category: 'command_failed', ...(exitCode !== undefined ? { exitCode } : {}) };
  return { category: 'tool_error', ...(exitCode !== undefined ? { exitCode } : {}) };
}
