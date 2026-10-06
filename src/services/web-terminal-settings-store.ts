import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export type WebTerminalInputMode = 'buffer' | 'live';

export interface WebTerminalSettings {
  /** 全局/最近一次选择的模式，作为新会话的默认值 */
  lastInputMode?: WebTerminalInputMode;
  /** 兼容老版本单一键 */
  mobileInputMode?: WebTerminalInputMode;
  /** 按 sessionId 隔离的会话输入模式记录 */
  sessions?: Record<string, WebTerminalInputMode>;
}

export interface WebTerminalSettingsOptions {
  sessionId?: string;
  dataDir?: string;
}

const MAX_STORED_SESSIONS = 500;

export const MOBILE_INPUT_MODE_OSC_PREFIX = '\x1b]1989;mobile_input_mode;';
export const MOBILE_INPUT_MODE_OSC_SUFFIX = '\x07';

export function formatMobileInputModeOsc(mode: WebTerminalInputMode): string {
  return `${MOBILE_INPUT_MODE_OSC_PREFIX}${mode}${MOBILE_INPUT_MODE_OSC_SUFFIX}`;
}

export function parseMobileInputModeOsc(data: string): { mode: WebTerminalInputMode; cleaned: string } | null {
  const match = data.match(/\x1b\]1989;mobile_input_mode;(live|buffer)\x07/);
  if (!match) return null;
  return {
    mode: match[1] as WebTerminalInputMode,
    cleaned: data.replace(match[0], ''),
  };
}

export function resolveSettingsOptions(
  sessionIdOrOptions?: string | WebTerminalSettingsOptions,
  maybeDataDir?: string,
): { sessionId?: string; dataDir?: string } {
  if (typeof sessionIdOrOptions === 'object' && sessionIdOrOptions !== null) {
    return sessionIdOrOptions;
  }
  if (maybeDataDir !== undefined) {
    return { sessionId: sessionIdOrOptions, dataDir: maybeDataDir };
  }
  if (typeof sessionIdOrOptions === 'string') {
    if (sessionIdOrOptions.includes('/') || sessionIdOrOptions.includes('\\')) {
      return { dataDir: sessionIdOrOptions };
    }
    return { sessionId: sessionIdOrOptions };
  }
  return {};
}

function resolveSettingsFilePath(dataDir?: string): string {
  const dir = dataDir ?? config.session.dataDir;
  return join(dir, 'web-terminal-settings.json');
}

export function getWebTerminalInputMode(
  sessionIdOrOptions?: string | WebTerminalSettingsOptions,
  maybeDataDir?: string,
): WebTerminalInputMode {
  const { sessionId, dataDir } = resolveSettingsOptions(sessionIdOrOptions, maybeDataDir);
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
  sessionIdOrOptions?: string | WebTerminalSettingsOptions,
  maybeDataDir?: string,
): void {
  const normalized: WebTerminalInputMode = mode === 'live' ? 'live' : 'buffer';
  const { sessionId, dataDir } = resolveSettingsOptions(sessionIdOrOptions, maybeDataDir);
  try {
    const filePath = resolveSettingsFilePath(dataDir);
    mkdirSync(dirname(filePath), { recursive: true });
    let existing: WebTerminalSettings = {};
    if (existsSync(filePath)) {
      try {
        existing = JSON.parse(readFileSync(filePath, 'utf-8')) as WebTerminalSettings;
      } catch {
        existing = {};
      }
    }
    const currentForSession = sessionId && existing.sessions ? existing.sessions[sessionId] : undefined;
    const currentGlobal = existing.lastInputMode ?? existing.mobileInputMode;
    if (sessionId && currentForSession === normalized && currentGlobal === normalized) return;
    if (!sessionId && currentGlobal === normalized) return;

    existing.lastInputMode = normalized;
    existing.mobileInputMode = normalized;
    if (sessionId) {
      existing.sessions = existing.sessions ?? {};
      existing.sessions[sessionId] = normalized;
      const keys = Object.keys(existing.sessions);
      if (keys.length > MAX_STORED_SESSIONS) {
        const excess = keys.length - MAX_STORED_SESSIONS;
        for (let i = 0; i < excess; i++) {
          delete existing.sessions[keys[i]];
        }
      }
    }
    atomicWriteFileSync(filePath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // Best-effort persistence
  }
}
