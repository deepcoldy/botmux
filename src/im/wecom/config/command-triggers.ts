import type { CommandTriggerConfig } from '../../../bot-registry.js';
import { createCliAdapterSync } from '../../../adapters/cli/registry.js';
import { normalizeCommandTriggers, normalizeTriggerCommand } from '../../../services/command-trigger-normalize.js';
import { validateCommandTriggerUpdate } from '../../../services/command-trigger-store.js';
import { reservedCommandKind } from '../../../services/command-trigger.js';

export function wecomTriggerPassthrough(cli: string, custom: readonly string[] = [], path?: string): Set<string> {
  const commands = new Set(custom);
  try {
    for (const command of createCliAdapterSync(cli as any, path).defaultPassthroughCommands ?? []) {
      commands.add(command);
    }
  } catch {
    /* unknown adapters fail at core validation */
  }
  return commands;
}

/** Same command/prompt validation as the shared editor, with native chat ids. */
export function validateWecomCommandTriggers(raw: unknown, passthrough: ReadonlySet<string>): CommandTriggerConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('wecom_invalid_command_triggers');
  }
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key => !['enabled', 'commands', 'chats', 'excludedChats'].includes(key))
    || typeof input.enabled !== 'boolean'
    || !Array.isArray(input.commands)
    || input.commands.some(entry => typeof entry !== 'string'
      && (!entry
        || typeof entry !== 'object'
        || Array.isArray(entry)
        || Object.keys(entry).some(key => !['cmd', 'prompt'].includes(key))))
    || ['chats', 'excludedChats'].some(key => input[key] !== undefined
      && (!Array.isArray(input[key])
        || (input[key] as unknown[]).some(id => typeof id !== 'string' || !id.trim() || /[\0\r\n]/.test(id))))) {
    throw new Error('wecom_invalid_command_triggers');
  }
  const validation = validateCommandTriggerUpdate(input, passthrough);
  if (!validation.ok) {
    throw new Error(`wecom_command_trigger_${validation.reason}`);
  }
  return normalizeCommandTriggers(input);
}

export function wecomCommandTriggerConflicts(commands: readonly string[], passthrough: ReadonlySet<string>) {
  return commands.map(input => {
    const cmd = normalizeTriggerCommand(input);
    return {
      input,
      valid: !!cmd,
      ...(cmd ? { cmd } : {}),
      kind: cmd ? reservedCommandKind(cmd, passthrough) : null,
    };
  });
}
