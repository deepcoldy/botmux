import {
  findDisallowedCardCallback,
  type InteractiveCardCallbackPolicy,
} from '../../card-callback-policy.js';

export const PLUGIN_COMMAND_SCHEMA_VERSION = 1 as const;
export const PLUGIN_COMMAND_REQUEST_MAX_BYTES = 64 * 1024;
export const PLUGIN_COMMAND_RESPONSE_MAX_BYTES = 1024 * 1024;
export const PLUGIN_COMMAND_TIMEOUT_MS = 10_000;
export const PLUGIN_COMMAND_REPLY_TEXT_MAX = 4_000;
export const PLUGIN_COMMANDS_ENDPOINT_ENV = 'BOTMUX_PLUGIN_COMMANDS_ENDPOINT';

/** Host-computed authority of an identity in one chat. Plugins must treat it as
 * the only source of privilege — never derive it from command args or card values. */
export interface PluginHostPrivileges {
  canOperate: boolean;
  canTalk: boolean;
}

export interface PluginCommandRequest {
  schemaVersion: typeof PLUGIN_COMMAND_SCHEMA_VERSION;
  eventId: string;
  larkAppId: string;
  command: string;
  args: string;
  chat: {
    chatId: string;
    chatType: 'group' | 'p2p' | null;
    anchor: string;
  };
  sender: {
    openId: string | null;
    unionId: string | null;
  };
  privileges: PluginHostPrivileges;
  locale: string | null;
}

export type PluginCommandReply =
  | { kind: 'text'; text: string }
  | { kind: 'card'; card: Record<string, unknown> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Validate a plugin's answer to a slash command. Anything malformed throws so
 * the caller can isolate it as "plugin unavailable"; an absent `reply` means the
 * plugin chose to stay silent.
 */
export const parsePluginCommandResponse = (
  value: unknown,
  options: { callbackPolicy?: InteractiveCardCallbackPolicy } = {},
): PluginCommandReply | undefined => {
  if (!isRecord(value) || value.schemaVersion !== PLUGIN_COMMAND_SCHEMA_VERSION) {
    throw new Error('invalid_plugin_command_response_schema');
  }
  if (value.reply === undefined || value.reply === null) return undefined;
  if (!isRecord(value.reply)) throw new Error('invalid_plugin_command_reply');
  const reply = value.reply;
  const hasText = Object.hasOwn(reply, 'text');
  const hasCard = Object.hasOwn(reply, 'card');
  if (hasText === hasCard) throw new Error('invalid_plugin_command_reply_shape');
  if (hasText) {
    const text = reply.text;
    if (typeof text !== 'string' || !text.trim() || text.length > PLUGIN_COMMAND_REPLY_TEXT_MAX) {
      throw new Error('invalid_plugin_command_reply_text');
    }
    return { kind: 'text', text };
  }
  if (!isRecord(reply.card)) throw new Error('invalid_plugin_command_reply_card');
  if (findDisallowedCardCallback(reply.card, 'card', options.callbackPolicy)) {
    throw new Error('invalid_plugin_command_reply_card_callback');
  }
  return { kind: 'card', card: reply.card };
};
