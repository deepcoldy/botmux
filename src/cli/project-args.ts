import type { ProjectCoordinatorAction } from '../services/project-coordinator.js';

export type ProjectCliResult =
  | { ok: true; help: true }
  | { ok: true; help: false; sessionId?: string; json: boolean; workstream: Record<string, unknown> }
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
  if (subcommand === 'workstream') {
    const command = args[0];
    const allowedByAction: Record<string, readonly string[]> = {
      inspect: ['--root', '--source-session', '--source-app', '--grant'],
      attach: ['--root', '--source-session', '--source-app', '--title', '--purpose', '--revision', '--grant'],
      rename: ['--root', '--title'],
      update: ['--root', '--status', '--content', '--progress', '--remaining', '--milestone', '--revision'],
      status: ['--root'],
      grant: [],
      notifications: ['--mode'],
    };
    if (!command || !allowedByAction[command]) return { ok: false, error: 'workstream 子命令: inspect|attach|rename|update|status|grant' };
    const rest = args.slice(1);
    const allowed = new Set([...allowedByAction[command]!, '--session-id', '--json']);
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i]!;
      const flag = token.split('=')[0]!;
      if (!allowed.has(flag)) return { ok: false, error: `未知选项: ${token}` };
      if (flag === '--json') continue;
      const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : rest[++i];
      if (!value?.trim() || value.startsWith('--')) return { ok: false, error: `${flag} 需要一个值` };
    }
    const root = one(rest, '--root');
    if (!['grant', 'status', 'notifications'].includes(command) && !root) return { ok: false, error: '--root 必填' };
    if (command === 'notifications' && !['ignore', 'notify'].includes(one(rest, '--mode') ?? '')) {
      return { ok: false, error: '--mode 必须是 ignore 或 notify' };
    }
    if (root && !/^om_[A-Za-z0-9_-]{1,128}$/.test(root)) return { ok: false, error: '--root 必须是话题根消息 ID' };
    if ((command === 'inspect' || command === 'attach') && (!one(rest, '--source-session') || !one(rest, '--source-app'))) {
      return { ok: false, error: '--source-session 和 --source-app 必填' };
    }
    const title = one(rest, '--title')?.trim();
    if (command === 'rename' && (!title || ['子任务', '子项目'].includes(title) || Array.from(title).length > 24)) {
      return { ok: false, error: '--title 必须具体、非空且不超过 24 字' };
    }
    const status = one(rest, '--status');
    if (command === 'update' && !['pending', 'in_progress', 'blocked', 'completed', 'failed'].includes(status ?? '')) {
      return { ok: false, error: '--status 必须是合法任务状态' };
    }
    const progress = parseProgress(one(rest, '--progress'));
    if (progress === 'invalid') return { ok: false, error: '--progress 必须是 0-100 的整数' };
    const revision = one(rest, '--revision');
    if (revision && !/^[1-9]\d{0,9}$/.test(revision)) return { ok: false, error: '--revision 必须是正整数' };
    return { ok: true, help: false, sessionId: one(rest, '--session-id'), json: has(rest, '--json'),
      workstream: {
        action: command, rootMessageId: root, sourceSessionId: one(rest, '--source-session'),
        sourceLarkAppId: one(rest, '--source-app'), title, purpose: one(rest, '--purpose'),
        grant: one(rest, '--grant'), status, progress,
        content: one(rest, '--content'), remaining: one(rest, '--remaining'), milestone: one(rest, '--milestone'),
        expectedRevision: revision ? Number(revision) : undefined,
        mode: one(rest, '--mode'),
      },
    };
  }
  const allowedByCommand: Record<string, Set<string>> = {
    init: new Set(['--title', '--goal', '--phase', '--focus', '--remaining', '--session-id', '--json']),
    status: new Set(['--session-id', '--json']),
    update: new Set(['--goal', '--phase', '--focus', '--progress', '--remaining', '--blocker', '--clear-blockers', '--milestone', '--next-milestone', '--clear-next-milestone', '--session-id', '--json']),
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
    if ((flag === '--json' || flag === '--clear-blockers' || flag === '--clear-next-milestone')) {
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
      nextMilestone: has(args, '--clear-next-milestone') ? '' : one(args, '--next-milestone'),
    };
    const changed = Object.entries(action).some(([key, value]) => key !== 'action' && value !== undefined && value !== false);
    if (!changed) return { ok: false, error: 'project update 至少需要一个更新选项' };
    return { ok: true, help: false, sessionId, json, action };
  }
  if (subcommand === 'close') return { ok: true, help: false, sessionId, json, action: { action: 'close', milestone: one(args, '--milestone') } };
  return { ok: true, help: false, sessionId, json, action: { action: 'resume', phase: one(args, '--phase'), focus: one(args, '--focus') } };
}
