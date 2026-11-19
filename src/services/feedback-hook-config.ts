import { isAbsolute } from 'node:path';
import type { FeedbackHookRegistration } from './feedback-extension-types.js';
import { feedbackExtensionId } from './feedback-extension-id.js';

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 4096) {
    throw new Error(`feedbackHook.${path}: invalid string`);
  }
  return value;
}

function positive(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`feedbackHook.${path}: invalid integer`);
  return value;
}

function identifiers(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`feedbackHook.${path}: expected nonempty array`);
  const result = value.map((entry, index) => {
    return feedbackExtensionId(entry, `feedbackHook.${path}[${index}]`);
  });
  if (new Set(result).size !== result.length) throw new Error(`feedbackHook.${path}: duplicate`);
  return result;
}

export function normalizeFeedbackHook(input: unknown): FeedbackHookRegistration {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('feedbackHook: expected object');
  const raw = input as Record<string, unknown>;
  const allowed = ['id', 'version', 'protocolVersion', 'hostId', 'command', 'cwd', 'allowedBotAppIds',
    'allowedChatIds', 'allowedActionIds', 'timeoutMs', 'concurrency', 'envRefs', 'enabled'];
  for (const field of Object.keys(raw)) {
    if (!allowed.includes(field)) throw new Error(`feedbackHook.${field}: unknown field`);
  }
  if (raw.protocolVersion !== 1) throw new Error('feedbackHook.protocolVersion: unsupported');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('feedbackHook.enabled: expected boolean');
  if (!Array.isArray(raw.command) || !raw.command.length) throw new Error('feedbackHook.command: expected argument array');
  const command = raw.command.map((entry, index) => {
    if (index === 0) return text(entry, 'command[0]');
    if (typeof entry !== 'string' || entry.includes('\0') || entry.length > 4096) throw new Error(`feedbackHook.command[${index}]: invalid argument`);
    return entry;
  });
  const cwd = text(raw.cwd, 'cwd');
  if (!isAbsolute(command[0]) || !isAbsolute(cwd)) throw new Error('feedbackHook.command/cwd: absolute paths required');
  const envRefs: Record<string, string> = {};
  if (raw.envRefs !== undefined) {
    if (!raw.envRefs || typeof raw.envRefs !== 'object' || Array.isArray(raw.envRefs)) throw new Error('feedbackHook.envRefs: expected object');
    for (const [name, value] of Object.entries(raw.envRefs)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /^(PATH|HOME|SHELL|BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|BUN_.+|BOTS_CONFIG|LARK_.+|SESSION_DATA_DIR|PYTHONPATH|PYTHONHOME|LD_.+|DYLD_.+|BOTMUX_.+|__OWNER_OPEN_ID)$/.test(name)) {
        throw new Error(`feedbackHook.envRefs.${name}: reserved environment variable`);
      }
      const reference = text(value, `envRefs.${name}`);
      if (!/^[a-zA-Z0-9_-]+$/.test(reference)) throw new Error(`feedbackHook.envRefs.${name}: invalid secret reference`);
      envRefs[name] = reference;
    }
  }
  return {
    id: identifiers([raw.id], 'id')[0], version: positive(raw.version, 'version'), protocolVersion: 1,
    hostId: identifiers([raw.hostId], 'hostId')[0], command, cwd,
    allowedBotAppIds: identifiers(raw.allowedBotAppIds, 'allowedBotAppIds'),
    allowedChatIds: identifiers(raw.allowedChatIds, 'allowedChatIds'),
    allowedActionIds: identifiers(raw.allowedActionIds, 'allowedActionIds'),
    timeoutMs: positive(raw.timeoutMs, 'timeoutMs'), concurrency: positive(raw.concurrency, 'concurrency'),
    envRefs, enabled: raw.enabled === true,
  };
}
