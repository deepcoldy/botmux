import type { CliId } from '../adapters/cli/types.js';

export const CLI_ID_CHOICES: Record<string, CliId> = {
  '1': 'claude-code',
  '2': 'aiden',
  '3': 'coco',
  '4': 'codex',
  '5': 'cursor',
  '6': 'gemini',
  '7': 'opencode',
};

const VALID_CLI_IDS: ReadonlySet<string> = new Set(Object.values(CLI_ID_CHOICES));

/**
 * 把 setup 里"CLI 适配器"那一格的原始输入解析成合法的 CliId.
 *   - 空 → undefined (调用方决定 "preserve current" 还是套默认 'claude-code')
 *   - "1".."6" → CLI_ID_CHOICES 映射
 *   - 已是合法 cliId 字面值 → 原样返回
 *   - 其它 → throw (typo 不该静默落盘成 cliId)
 */
export function resolveCliId(input: string | undefined): CliId | undefined {
  const raw = trimmed(input);
  if (!raw) return undefined;
  const mapped = CLI_ID_CHOICES[raw];
  if (mapped) return mapped;
  if (VALID_CLI_IDS.has(raw)) return raw as CliId;
  throw new Error(
    `Unknown CLI 适配器 "${raw}"。请输入序号 1-6 或合法 ID 之一: ${[...VALID_CLI_IDS].join(', ')}`,
  );
}

export interface BotConfigEditInput {
  name?: string;
  larkAppId?: string;
  larkAppSecret?: string;
  cliChoice?: string;
  cliPathOverride?: string;
  backendType?: string;
  workingDir?: string;
  allowedUsers?: string;
  projectScanDir?: string;
}

export interface RemoveBotConfigResult<T> {
  bots: T[];
  removed: T;
  index: number;
}

function trimmed(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

export function normalizeBotProcessName(input: string | undefined): string | undefined {
  const raw = trimmed(input);
  if (!raw) return undefined;
  const slug = raw
    .replace(/^botmux-/i, '')
    .replace(/[^\p{L}\p{N}_.-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return slug || undefined;
}

export function botProcessName(
  bot: { name?: unknown },
  index: number,
  prefix = 'botmux',
): string {
  const name = typeof bot.name === 'string' ? normalizeBotProcessName(bot.name) : undefined;
  return `${prefix}-${name ?? index}`;
}

export function normalizeBotConfig<T extends Record<string, any>>(bot: T): T {
  const out: Record<string, any> = { ...bot };
  if (typeof out.name !== 'string') return out as T;

  const name = normalizeBotProcessName(out.name);
  if (name) out.name = name;
  else delete out.name;
  return out as T;
}

export function parseBotConfigsJson<T extends Record<string, any> = Record<string, any>>(
  content: string,
  filePath = 'bots.json',
): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err: any) {
    throw new Error(`Failed to parse ${filePath}: ${err?.message ?? String(err)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON array of bot configs.`);
  }
  return parsed as T[];
}

export function assertUniqueBotProcessNames(
  bots: Array<{ name?: unknown }>,
  prefix = 'botmux',
): void {
  const seen = new Map<string, number>();
  const reserved = new Set([`${prefix}-dashboard`]);
  for (let i = 0; i < bots.length; i++) {
    const name = botProcessName(bots[i], i, prefix);
    if (reserved.has(name)) {
      throw new Error(`Bot PM2 process name "${name}" is reserved. Set a different "name" value.`);
    }
    const firstIndex = seen.get(name);
    if (firstIndex !== undefined) {
      throw new Error(
        `Duplicate bot PM2 process name "${name}" in bots.json entries ${firstIndex + 1} and ${i + 1}. ` +
        'Set unique "name" values or clear one before restarting.',
      );
    }
    seen.set(name, i);
  }
}

function applyOptionalString(
  out: Record<string, any>,
  key: string,
  raw: string | undefined,
): void {
  if (raw === undefined) return;
  const s = raw.trim();
  if (!s) return;
  if (s === '-') {
    delete out[key];
    return;
  }
  out[key] = s;
}

export function parseBotSelection(
  input: string,
  bots: Array<{ larkAppId?: string; name?: unknown }>,
): number | undefined {
  const raw = input.trim();
  if (!raw) return undefined;

  const pm2Match = /^botmux-(\d+)$/.exec(raw);
  if (pm2Match) {
    const idx = Number(pm2Match[1]);
    if (Number.isInteger(idx) && idx >= 0 && idx < bots.length && botProcessName(bots[idx], idx) === raw) {
      return idx;
    }
  }

  if (/^\d+$/.test(raw)) {
    const idx = Number(raw) - 1;
    return idx >= 0 && idx < bots.length ? idx : undefined;
  }

  const byAppId = bots.findIndex(b => b.larkAppId === raw);
  if (byAppId >= 0) return byAppId;

  const byProcessName = bots.findIndex((b, i) => botProcessName(b, i) === raw);
  return byProcessName >= 0 ? byProcessName : undefined;
}

export function removeBotConfig<T extends { larkAppId?: string; name?: unknown }>(
  bots: T[],
  selection: string,
): RemoveBotConfigResult<T> | undefined {
  const index = parseBotSelection(selection, bots);
  if (index === undefined) return undefined;

  const nextBots = bots.slice();
  const [removed] = nextBots.splice(index, 1);
  return { bots: nextBots, removed: removed as T, index };
}

export function applyBotConfigEdits<T extends Record<string, any>>(
  bot: T,
  input: BotConfigEditInput,
): T {
  const out: Record<string, any> = { ...bot };

  const appId = trimmed(input.larkAppId);
  if (appId) out.larkAppId = appId;

  const name = normalizeBotProcessName(input.name);
  if (input.name !== undefined) {
    if (input.name.trim() === '-') delete out.name;
    else if (name) out.name = name;
  }

  const appSecret = trimmed(input.larkAppSecret);
  if (appSecret) out.larkAppSecret = appSecret;

  const cliId = resolveCliId(input.cliChoice);
  if (cliId) out.cliId = cliId;

  applyOptionalString(out, 'cliPathOverride', input.cliPathOverride);

  if (input.backendType !== undefined) {
    const backendType = input.backendType.trim();
    if (backendType === '-') {
      delete out.backendType;
    } else if (backendType) {
      if (backendType !== 'pty' && backendType !== 'tmux') {
        throw new Error(`backendType must be "pty" or "tmux": ${backendType}`);
      }
      out.backendType = backendType;
    }
  }

  applyOptionalString(out, 'workingDir', input.workingDir);
  applyOptionalString(out, 'projectScanDir', input.projectScanDir);

  if (input.allowedUsers !== undefined) {
    const allowedUsers = input.allowedUsers.trim();
    if (allowedUsers === '-') {
      delete out.allowedUsers;
    } else if (allowedUsers) {
      out.allowedUsers = allowedUsers.split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  return normalizeBotConfig(out) as T;
}
