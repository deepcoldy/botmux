import { stripAnsiForLog } from '../utils/crash-log.js';

export const DEFAULT_IDLE_SUSPEND_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1_000;

export const MAINTENANCE_SUSPEND_IDLE_USAGE = [
  '用法:',
  '  botmux maintenance suspend-idle [--older-than 7d] --dry-run [--bot <appId>] [--json]',
  '  botmux maintenance suspend-idle [--older-than 7d] --yes [--bot <appId>] [--json]',
  '',
  '说明:',
  '  --dry-run                只读取 daemon 权威状态并列出候选，不修改会话',
  '  --yes                    执行休眠；会话保持 active，下条消息冷恢复',
  '  --older-than <duration>  最后活动时间阈值，支持 ms/s/m/h/d/w（默认 7d）',
  '  --bot <appId>            只处理指定 Bot；默认处理所有在线 Bot daemon',
  '  --json                   输出机器可读 JSON',
].join('\n');

export interface MaintenanceSuspendIdleArgs {
  action: 'suspend-idle';
  execute: boolean;
  olderThanMs: number;
  botAppId?: string;
  json: boolean;
}

export interface IdleSuspendApiCandidate {
  sessionId: string;
  larkAppId: string;
  title: string;
  lastActivityAt: number;
  idleForMs: number;
  workerPid?: number;
  backendType: string;
  backendTarget?: string;
  processTypes: string[];
  backingReleased?: boolean;
  workerRetirementRequested?: boolean;
}

export type MaintenanceCommandParseResult =
  | { ok: true; command: MaintenanceSuspendIdleArgs }
  | { ok: true; help: true }
  | { ok: false; error: string };

export function parseIdleDurationMs(raw: string): number | undefined {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const units: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 60 * 60_000,
    d: 24 * 60 * 60_000,
    w: 7 * 24 * 60 * 60_000,
  };
  const duration = value * units[match[2]!.toLowerCase()]!;
  return Number.isSafeInteger(duration) && duration > 0 ? duration : undefined;
}

function inlineValue(arg: string, name: string): string | undefined {
  return arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined;
}

function validBotAppId(value: string): boolean {
  return value.length <= 256 && !/[\x00-\x20\x7f-\x9f]/.test(value);
}

export function parseMaintenanceCommandArgs(args: string[]): MaintenanceCommandParseResult {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    return { ok: true, help: true };
  }
  if (args[0] !== 'suspend-idle') {
    return { ok: false, error: `未知 maintenance 子命令: ${args[0]}` };
  }

  let dryRun = false;
  let yes = false;
  let json = false;
  let olderThanMs = DEFAULT_IDLE_SUSPEND_OLDER_THAN_MS;
  let botAppId: string | undefined;
  const seen = new Set<string>();
  const mark = (name: string): string | undefined => {
    if (seen.has(name)) return `参数重复: ${name}`;
    seen.add(name);
    return undefined;
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') return { ok: true, help: true };
    if (arg === '--dry-run' || arg === '--yes' || arg === '--json') {
      const duplicate = mark(arg);
      if (duplicate) return { ok: false, error: duplicate };
      if (arg === '--dry-run') dryRun = true;
      else if (arg === '--yes') yes = true;
      else json = true;
      continue;
    }

    const olderInline = inlineValue(arg, '--older-than');
    if (arg === '--older-than' || olderInline !== undefined) {
      const duplicate = mark('--older-than');
      if (duplicate) return { ok: false, error: duplicate };
      const value = olderInline ?? args[++i];
      if (!value || value.startsWith('--')) return { ok: false, error: '--older-than 缺少时长' };
      const parsed = parseIdleDurationMs(value);
      if (parsed === undefined) {
        return { ok: false, error: `无效的 --older-than: ${value}（支持 ms/s/m/h/d/w）` };
      }
      olderThanMs = parsed;
      continue;
    }

    const botInline = inlineValue(arg, '--bot');
    if (arg === '--bot' || botInline !== undefined) {
      const duplicate = mark('--bot');
      if (duplicate) return { ok: false, error: duplicate };
      const value = (botInline ?? args[++i])?.trim();
      if (!value || value.startsWith('--')) return { ok: false, error: '--bot 缺少 appId' };
      if (!validBotAppId(value)) return { ok: false, error: `无效的 --bot appId: ${value}` };
      botAppId = value;
      continue;
    }

    return { ok: false, error: `未知参数: ${arg}` };
  }

  if (dryRun === yes) {
    return { ok: false, error: '必须且只能指定 --dry-run 或 --yes' };
  }
  return {
    ok: true,
    command: {
      action: 'suspend-idle',
      execute: yes,
      olderThanMs,
      ...(botAppId ? { botAppId } : {}),
      json,
    },
  };
}

/** Render user-derived session metadata without allowing ANSI/control injection. */
export function safeIdleSuspendCliText(value: string, fallback = '-'): string {
  const normalized = stripAnsiForLog(value)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return fallback;
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`;
}

export function formatIdleSuspendCandidate(
  candidate: IdleSuspendApiCandidate,
  botName: string,
): string {
  const title = safeIdleSuspendCliText(candidate.title, '(untitled)');
  const safeBot = safeIdleSuspendCliText(botName);
  const backend = candidate.backendTarget
    ? `${safeIdleSuspendCliText(candidate.backendType)}:${safeIdleSuspendCliText(candidate.backendTarget)}`
    : safeIdleSuspendCliText(candidate.backendType);
  const processes = candidate.processTypes.map(value => safeIdleSuspendCliText(value)).join(', ');
  const verified = candidate.backingReleased === true
    ? `  backingReleased=true  workerRetirementRequested=${candidate.workerRetirementRequested === true}`
    : '';
  let lastActivity = 'unknown';
  if (Number.isFinite(candidate.lastActivityAt)) {
    try { lastActivity = new Date(candidate.lastActivityAt).toISOString(); } catch { /* invalid range */ }
  }
  return `${safeIdleSuspendCliText(candidate.sessionId)}  bot=${safeBot}  title=${title}  `
    + `lastActivity=${lastActivity}  `
    + `workerPid=${candidate.workerPid ?? '-'}  backend=${backend}  releases=[${processes}]${verified}`;
}
