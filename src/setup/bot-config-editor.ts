import type { CliId } from '../adapters/cli/types.js';

export const CLI_ID_CHOICES: Record<string, CliId> = {
  '1': 'claude-code',
  '2': 'aiden',
  '3': 'coco',
  '4': 'codex',
  '5': 'gemini',
  '6': 'opencode',
};

export interface BotConfigEditInput {
  name?: string;
  larkAppId?: string;
  larkAppSecret?: string;
  cliChoice?: string;
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
    return Number.isInteger(idx) && idx >= 0 && idx < bots.length ? idx : undefined;
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

  const cliChoice = trimmed(input.cliChoice);
  if (cliChoice) {
    out.cliId = CLI_ID_CHOICES[cliChoice] ?? cliChoice;
  }

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

  return out as T;
}
