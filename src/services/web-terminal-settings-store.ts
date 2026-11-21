import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import {
  normalizeQuickCommands,
  type QuickCommand,
  type QuickCommandProfile,
  type QuickCommandsReplyStatus,
} from '../core/web-terminal-quick-commands.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

export type WebTerminalInputMode = 'buffer' | 'live';

export interface WebTerminalSettings {
  /** 全局/最近一次选择的模式，作为新会话的默认值 */
  lastInputMode?: WebTerminalInputMode;
  /** 兼容老版本单一键 */
  mobileInputMode?: WebTerminalInputMode;
  /** 按 sessionId 隔离的会话输入模式记录 */
  sessions?: Record<string, WebTerminalInputMode>;
  /** 手机终端的快捷指令：先按 Bot（larkAppId）、再按 CLI 家族分开存；缺省表示用内置默认 */
  quickCommands?: Record<string, Partial<Record<QuickCommandProfile, QuickCommand[]>>>;
}

export interface WebTerminalSettingsOptions {
  sessionId?: string;
  dataDir?: string;
}

/**
 * 一份快捷指令列表归谁。同一台机器可能托管属于不同人的 Bot，它们共用这个设置文件；
 * 对某个会话有写权限的人不能顺带改写或读到别的 Bot 的菜单，所以先按 Bot 隔开。
 * botId 只能来自 worker 自己的初始化配置，不能来自客户端。
 */
export interface QuickCommandScope {
  botId: string;
  profile: QuickCommandProfile;
}

const MAX_STORED_SESSIONS = 500;

export const MOBILE_INPUT_MODE_OSC_PREFIX = '\x1b]1989;mobile_input_mode;';
export const MOBILE_INPUT_MODE_OSC_SUFFIX = '\x07';
export const MOBILE_INPUT_MODE_OSC_PATTERN = '\\x1b\\]1989;mobile_input_mode;(live|buffer)\\x07';
export const MOBILE_INPUT_MODE_OSC_REGEX = new RegExp(MOBILE_INPUT_MODE_OSC_PATTERN);

export function formatMobileInputModeOsc(mode: WebTerminalInputMode): string {
  return `${MOBILE_INPUT_MODE_OSC_PREFIX}${mode}${MOBILE_INPUT_MODE_OSC_SUFFIX}`;
}

export function parseMobileInputModeOsc(data: string): { mode: WebTerminalInputMode; cleaned: string } | null {
  const match = data.match(MOBILE_INPUT_MODE_OSC_REGEX);
  if (!match) return null;
  return {
    mode: match[1] as WebTerminalInputMode,
    cleaned: data.replace(match[0], ''),
  };
}

export function resolveSettingsOptions(
  optionsOrSessionId?: string | WebTerminalSettingsOptions,
): { sessionId?: string; dataDir?: string } {
  if (typeof optionsOrSessionId === 'string') {
    return { sessionId: optionsOrSessionId };
  }
  if (typeof optionsOrSessionId === 'object' && optionsOrSessionId !== null) {
    return optionsOrSessionId;
  }
  return {};
}

function resolveSettingsFilePath(dataDir?: string): string {
  const dir = dataDir ?? config.session.dataDir;
  return join(dir, 'web-terminal-settings.json');
}

export function getWebTerminalInputMode(
  optionsOrSessionId?: string | WebTerminalSettingsOptions,
): WebTerminalInputMode {
  const { sessionId, dataDir } = resolveSettingsOptions(optionsOrSessionId);
  try {
    const filePath = resolveSettingsFilePath(dataDir);
    if (!existsSync(filePath)) return 'buffer';
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as WebTerminalSettings;
    if (sessionId && parsed.sessions && parsed.sessions[sessionId]) {
      return parsed.sessions[sessionId] === 'live' ? 'live' : 'buffer';
    }
    const fallback = parsed.lastInputMode ?? parsed.mobileInputMode;
    return fallback === 'live' ? 'live' : 'buffer';
  } catch {
    return 'buffer';
  }
}

export function setWebTerminalInputMode(
  mode: WebTerminalInputMode,
  optionsOrSessionId?: string | WebTerminalSettingsOptions,
): void {
  const normalized: WebTerminalInputMode = mode === 'live' ? 'live' : 'buffer';
  const { sessionId, dataDir } = resolveSettingsOptions(optionsOrSessionId);
  try {
    updateSettings(dataDir, (existing) => {
      const currentForSession = sessionId && existing.sessions ? existing.sessions[sessionId] : undefined;
      const currentGlobal = existing.lastInputMode ?? existing.mobileInputMode;
      if (sessionId && currentForSession === normalized && currentGlobal === normalized) return false;
      if (!sessionId && currentGlobal === normalized) return false;

      existing.lastInputMode = normalized;
      existing.mobileInputMode = normalized;
      if (sessionId) {
        existing.sessions = existing.sessions ?? {};
        // 先 delete 再赋值，使当前 key 移动到键序末尾，维持真正的 LRU 淘汰顺序
        delete existing.sessions[sessionId];
        existing.sessions[sessionId] = normalized;
        const keys = Object.keys(existing.sessions);
        if (keys.length > MAX_STORED_SESSIONS) {
          const excess = keys.length - MAX_STORED_SESSIONS;
          for (let i = 0; i < excess; i++) {
            delete existing.sessions[keys[i]];
          }
        }
      }
      return true;
    });
  } catch {
    // Best-effort persistence
  }
}

function readSettings(filePath: string): WebTerminalSettings {
  if (!existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as WebTerminalSettings) : {};
  } catch {
    return {};
  }
}

/**
 * 改写设置文件。这台机器上所有 Bot 的会话 worker 共用这一个文件，读、改、写必须在同一把跨进程锁里，
 * 否则两个进程同时保存时后写的会把先写的整份盖掉。update 返回 false 表示不用写。
 * 文件在但读不出来（比如被手改坏了）时，先把原文件留一份副本再覆盖，别把别的 Bot 的设置一起冲掉。
 */
function updateSettings<T>(
  dataDir: string | undefined,
  update: (settings: WebTerminalSettings) => T,
): T {
  const filePath = resolveSettingsFilePath(dataDir);
  mkdirSync(dirname(filePath), { recursive: true });
  return withFileLockSync(filePath, () => {
    let raw: string | null = null;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    let settings: WebTerminalSettings = {};
    let unreadable = false;
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as WebTerminalSettings;
        else unreadable = true;
      } catch {
        unreadable = true;
      }
    }
    const result = update(settings);
    if (result !== false) {
      if (unreadable) copyFileSync(filePath, `${filePath}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}`);
      atomicWriteFileSync(filePath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    }
    return result;
  });
}

function quickCommandsIn(settings: WebTerminalSettings, scope: QuickCommandScope): QuickCommand[] | null {
  return normalizeQuickCommands(ownField(ownField(settings.quickCommands, scope.botId), scope.profile));
}

function putQuickCommands(
  settings: WebTerminalSettings,
  scope: QuickCommandScope,
  commands: QuickCommand[] | null,
): void {
  const all: Record<string, unknown> = { ...plainRecord(settings.quickCommands) };
  const perBot: Record<string, unknown> = { ...plainRecord(ownField(all, scope.botId)) };
  const normalized = commands === null ? null : normalizeQuickCommands(commands);
  if (normalized) perBot[scope.profile] = normalized;
  else delete perBot[scope.profile];
  if (Object.keys(perBot).length) all[scope.botId] = perBot;
  else delete all[scope.botId];
  if (Object.keys(all).length) settings.quickCommands = all as WebTerminalSettings['quickCommands'];
  else delete settings.quickCommands;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function ownField(value: unknown, key: string): unknown {
  const record = plainRecord(value);
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** 读用户保存过的快捷指令；没存过（或文件损坏）返回 null，由调用方用内置默认。 */
export function getWebTerminalQuickCommands(
  scope: QuickCommandScope,
  options?: WebTerminalSettingsOptions,
): QuickCommand[] | null {
  if (!scope.botId) return null;
  try {
    return quickCommandsIn(readSettings(resolveSettingsFilePath(options?.dataDir)), scope);
  } catch {
    return null;
  }
}

/**
 * 保存快捷指令；传 null 删掉这一套，回到内置默认。空数组会被原样保存（用户删光了）。
 * 返回是否写盘成功。
 */
export function setWebTerminalQuickCommands(
  scope: QuickCommandScope,
  commands: QuickCommand[] | null,
  options?: WebTerminalSettingsOptions,
): boolean {
  if (!scope.botId) return false;
  try {
    updateSettings(options?.dataDir, (settings) => putQuickCommands(settings, scope, commands));
    return true;
  } catch {
    return false;
  }
}

/**
 * 终端页的保存：只有服务端当前的列表还是页面修改前看到的那份（base，null = 内置默认）才写入，
 * 否则返回 conflict，免得一个旧页面的整表保存盖掉别的页面刚存的修改。无论结果如何都带回服务端
 * 此刻的列表，页面以它为准。
 */
export function saveWebTerminalQuickCommands(
  scope: QuickCommandScope,
  base: QuickCommand[] | null,
  commands: QuickCommand[] | null,
  options?: WebTerminalSettingsOptions,
): { status: QuickCommandsReplyStatus; commands: QuickCommand[] | null } {
  if (!scope.botId) return { status: 'error', commands: null };
  const normalizedBase = base === null ? null : normalizeQuickCommands(base);
  try {
    return updateSettings(options?.dataDir, (settings) => {
      const current = quickCommandsIn(settings, scope);
      if (JSON.stringify(current) !== JSON.stringify(normalizedBase)) return false;
      putQuickCommands(settings, scope, commands);
      return true;
    })
      ? { status: 'ok', commands: getWebTerminalQuickCommands(scope, options) }
      : { status: 'conflict', commands: getWebTerminalQuickCommands(scope, options) };
  } catch {
    return { status: 'error', commands: getWebTerminalQuickCommands(scope, options) };
  }
}
