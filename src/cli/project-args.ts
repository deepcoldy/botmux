import type { ProjectCoordinatorAction } from '../services/project-coordinator.js';

export type ProjectCliResult =
  | { ok: true; help: true }
  | { ok: true; help: false; sessionId?: string; json: boolean; action: ProjectCoordinatorAction }
  | { ok: false; error: string };

function values(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === flag) {
      if (args[i + 1] !== undefined) out.push(args[++i]!);
    } else if (token.startsWith(`${flag}=`)) {
      out.push(token.slice(flag.length + 1));
    }
  }
  return out;
}

function one(args: readonly string[], flag: string): string | undefined {
  return values(args, flag)[0];
}

function has(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function parseProgress(raw: string | undefined): number | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  if (!/^\d{1,3}$/.test(raw)) return 'invalid';
  const value = Number(raw);
  return value <= 100 ? value : 'invalid';
}

export function parseProjectArgs(subcommand: string, args: readonly string[]): ProjectCliResult {
  if (args.includes('--help') || args.includes('-h')
    || subcommand === 'help' || subcommand === '--help' || subcommand === '-h' || !subcommand) {
    return { ok: true, help: true };
  }
  const allowedByCommand: Record<string, Set<string>> = {
    init: new Set(['--title', '--goal', '--phase', '--focus', '--remaining', '--session-id', '--json']),
    status: new Set(['--session-id', '--json']),
    update: new Set(['--goal', '--phase', '--focus', '--progress', '--remaining', '--blocker', '--clear-blockers', '--milestone', '--next-milestone', '--session-id', '--json']),
    close: new Set(['--milestone', '--session-id', '--json']),
    resume: new Set(['--phase', '--focus', '--session-id', '--json']),
  };
  const allowed = allowedByCommand[subcommand];
  if (!allowed) return { ok: false, error: `未知 project 子命令: ${subcommand}` };
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (!token.startsWith('-')) return { ok: false, error: `不支持位置参数: ${token}` };
    const flag = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
    if (!allowed.has(flag)) return { ok: false, error: `未知选项: ${flag}` };
    if ((flag === '--json' || flag === '--clear-blockers')) {
      if (token.includes('=')) return { ok: false, error: `${flag} 不接受值` };
      continue;
    }
    const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : args[++i];
    if (value === undefined || !value.trim() || value.startsWith('--')) {
      return { ok: false, error: `${flag} 需要一个值` };
    }
  }
  const sessionId = one(args, '--session-id');
  const json = has(args, '--json');
  if (subcommand === 'init') {
    const title = one(args, '--title')?.trim();
    const goal = one(args, '--goal')?.trim();
    if (!title || !goal) return { ok: false, error: 'project init 需要 --title 和 --goal' };
    return { ok: true, help: false, sessionId, json, action: {
      action: 'init', title, goal,
      phase: one(args, '--phase'), focus: one(args, '--focus'), remaining: one(args, '--remaining'),
    } };
  }
  if (subcommand === 'status') return { ok: true, help: false, sessionId, json, action: { action: 'status' } };
  if (subcommand === 'update') {
    const progress = parseProgress(one(args, '--progress'));
    if (progress === 'invalid') return { ok: false, error: '--progress 必须是 0-100 的整数' };
    const action: ProjectCoordinatorAction = {
      action: 'update', goal: one(args, '--goal'), phase: one(args, '--phase'), focus: one(args, '--focus'),
      progress, remaining: one(args, '--remaining'), blocker: one(args, '--blocker'),
      clearBlockers: has(args, '--clear-blockers'), milestone: one(args, '--milestone'),
      nextMilestone: one(args, '--next-milestone'),
    };
    const changed = Object.entries(action).some(([key, value]) => key !== 'action' && value !== undefined && value !== false);
    if (!changed) return { ok: false, error: 'project update 至少需要一个更新选项' };
    return { ok: true, help: false, sessionId, json, action };
  }
  if (subcommand === 'close') return { ok: true, help: false, sessionId, json, action: { action: 'close', milestone: one(args, '--milestone') } };
  return { ok: true, help: false, sessionId, json, action: { action: 'resume', phase: one(args, '--phase'), focus: one(args, '--focus') } };
}
