import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';

export const GROUP_CONTEXT_SETTINGS_STORE_FILE = 'group-context-settings.json';
const GROUP_CHAT_ID_PATTERN = /^oc_[a-zA-Z0-9_-]+$/;

export interface GroupContextSettings {
  enabled: boolean;
  maxContextChars: number;
  retentionDays: number;
  maxMessages: number;
}

const DEFAULT_GROUP_CONTEXT_SETTINGS: GroupContextSettings = {
  enabled: false,
  maxContextChars: 24_000,
  retentionDays: 30,
  maxMessages: 10_000,
};

interface GroupContextSettingsRegistry {
  schemaVersion: 1;
  configs: Record<string, GroupContextSettings>;
}

function storePath(dataDir: string): string {
  return join(dataDir, GROUP_CONTEXT_SETTINGS_STORE_FILE);
}

function emptyRegistry(): GroupContextSettingsRegistry {
  return { schemaVersion: 1, configs: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function validateSettings(value: unknown, label: string): asserts value is GroupContextSettings {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (typeof value.enabled !== 'boolean') throw new Error(`${label}.enabled must be a boolean`);
  if (!isIntegerInRange(value.maxContextChars, 1_000, 100_000)) {
    throw new Error(`${label}.maxContextChars must be an integer between 1000 and 100000`);
  }
  if (!isIntegerInRange(value.retentionDays, 1, 365)) {
    throw new Error(`${label}.retentionDays must be an integer between 1 and 365`);
  }
  if (!isIntegerInRange(value.maxMessages, 100, 100_000)) {
    throw new Error(`${label}.maxMessages must be an integer between 100 and 100000`);
  }
}

function readRegistry(path: string): GroupContextSettingsRegistry {
  if (!existsSync(path)) return emptyRegistry();
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${GROUP_CONTEXT_SETTINGS_STORE_FILE} must contain an object`);
  }
  if (parsed.schemaVersion !== 1 || !isRecord(parsed.configs)) {
    throw new Error(`${GROUP_CONTEXT_SETTINGS_STORE_FILE} has an unsupported schema`);
  }
  for (const [chatId, settings] of Object.entries(parsed.configs)) {
    if (!GROUP_CHAT_ID_PATTERN.test(chatId)) {
      throw new Error(`${GROUP_CONTEXT_SETTINGS_STORE_FILE} contains an invalid chat ID`);
    }
    validateSettings(settings, `configs.${chatId}`);
  }
  return parsed as unknown as GroupContextSettingsRegistry;
}

function writeRegistry(path: string, registry: GroupContextSettingsRegistry): void {
  atomicWriteFileSync(path, JSON.stringify(registry, null, 2), {
    mode: 0o600,
    followTargetSymlink: false,
  });
}

export function getGroupContextSettings(
  appId: string,
  chatId: string,
  dataDir: string = config.session.dataDir,
): GroupContextSettings {
  // Reserved for future caller-aware policy. The setting itself is deliberately
  // group-wide and appId must not imply per-app authorization or configuration.
  void appId;
  if (!GROUP_CHAT_ID_PATTERN.test(chatId)) return { ...DEFAULT_GROUP_CONTEXT_SETTINGS };
  const path = storePath(dataDir);
  try {
    const configs = readRegistry(path).configs;
    const settings = Object.hasOwn(configs, chatId) ? configs[chatId] : undefined;
    return { ...(settings ?? DEFAULT_GROUP_CONTEXT_SETTINGS) };
  } catch (error) {
    logger.warn(
      `[group-context-settings] failed to load ${path}; sharing disabled: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ...DEFAULT_GROUP_CONTEXT_SETTINGS };
  }
}

function validatePatch(patch: Partial<GroupContextSettings>): void {
  if (!isRecord(patch)) throw new Error('group context settings patch must be an object');
  const supported = new Set(['enabled', 'maxContextChars', 'retentionDays', 'maxMessages']);
  for (const key of Object.keys(patch)) {
    if (!supported.has(key)) throw new Error(`unsupported group context setting: ${key}`);
  }
  if (Object.hasOwn(patch, 'enabled') && typeof patch.enabled !== 'boolean') {
    throw new Error('enabled must be a boolean');
  }
  if (Object.hasOwn(patch, 'maxContextChars') && !isIntegerInRange(patch.maxContextChars, 1_000, 100_000)) {
    throw new Error('maxContextChars must be an integer between 1000 and 100000');
  }
  if (Object.hasOwn(patch, 'retentionDays') && !isIntegerInRange(patch.retentionDays, 1, 365)) {
    throw new Error('retentionDays must be an integer between 1 and 365');
  }
  if (Object.hasOwn(patch, 'maxMessages') && !isIntegerInRange(patch.maxMessages, 100, 100_000)) {
    throw new Error('maxMessages must be an integer between 100 and 100000');
  }
}

export async function setGroupContextSettings(
  chatId: string,
  patch: Partial<GroupContextSettings>,
  dataDir: string = config.session.dataDir,
): Promise<GroupContextSettings> {
  if (!GROUP_CHAT_ID_PATTERN.test(chatId)) throw new Error('invalid group chat ID');
  validatePatch(patch);
  const path = storePath(dataDir);
  let result!: GroupContextSettings;
  await withFileLock(path, async () => {
    const registry = readRegistry(path);
    result = {
      ...(registry.configs[chatId] ?? DEFAULT_GROUP_CONTEXT_SETTINGS),
      ...patch,
    };
    registry.configs[chatId] = result;
    writeRegistry(path, registry);
  });
  return { ...result };
}
