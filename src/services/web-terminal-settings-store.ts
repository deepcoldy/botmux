import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export type WebTerminalInputMode = 'buffer' | 'live';

interface WebTerminalSettings {
  mobileInputMode?: WebTerminalInputMode;
}

function resolveSettingsFilePath(dataDir?: string): string {
  const dir = dataDir ?? process.env.SESSION_DATA_DIR ?? config.session.dataDir ?? resolveBotmuxDataDir();
  return join(dir, 'web-terminal-settings.json');
}

export function getWebTerminalInputMode(dataDir?: string): WebTerminalInputMode {
  try {
    const filePath = resolveSettingsFilePath(dataDir);
    if (!existsSync(filePath)) return 'buffer';
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as WebTerminalSettings;
    return parsed.mobileInputMode === 'live' ? 'live' : 'buffer';
  } catch {
    return 'buffer';
  }
}

export function setWebTerminalInputMode(mode: WebTerminalInputMode, dataDir?: string): void {
  const normalized: WebTerminalInputMode = mode === 'live' ? 'live' : 'buffer';
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
    if (existing.mobileInputMode === normalized) return;
    existing.mobileInputMode = normalized;
    atomicWriteFileSync(filePath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // Best-effort persistence
  }
}
