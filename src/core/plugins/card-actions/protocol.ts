import type { CardActionData } from '../../../im/lark/card-handler.js';
import {
  findDisallowedCardCallback,
  type InteractiveCardCallbackPolicy,
} from '../../card-callback-policy.js';

export const PLUGIN_CARD_ACTION_SCHEMA_VERSION = 1 as const;
export const PLUGIN_CARD_ACTION_REQUEST_MAX_BYTES = 256 * 1024;
export const PLUGIN_CARD_ACTION_RESPONSE_MAX_BYTES = 1024 * 1024;
export const PLUGIN_CARD_ACTION_TIMEOUT_MS = 30_000;
export const PLUGIN_CARD_ACTION_TOKEN_ENV = 'BOTMUX_PLUGIN_CARD_ACTION_TOKEN';
export const PLUGIN_CARD_ACTION_ENDPOINT_ENV = 'BOTMUX_PLUGIN_CARD_ACTION_ENDPOINT';

export interface PluginCardActionRequest {
  schemaVersion: typeof PLUGIN_CARD_ACTION_SCHEMA_VERSION;
  eventId: string | null;
  larkAppId: string;
  operator: Record<string, unknown> & {
    open_id?: string;
    union_id?: string;
  };
  context: Record<string, unknown> & {
    open_message_id?: string;
  };
  actionName: string;
  action: {
    name: string | null;
    value: Record<string, unknown>;
    option: unknown;
    formValue: Record<string, unknown>;
  };
}

export interface PluginCardActionToast {
  type: 'success' | 'info' | 'warning' | 'error';
  content: string;
}

export interface PluginCardActionAck {
  toast?: PluginCardActionToast;
  card?: {
    type: 'raw';
    data: Record<string, unknown>;
  };
}

const optionalNonEmptyString = (value: unknown): string | undefined => {
  return typeof value === 'string' && value.trim() ? value : undefined;
};

export const pluginCardActionEventId = (data: CardActionData): string | undefined => {
  return optionalNonEmptyString(data.event_id)
    ?? optionalNonEmptyString(data.uuid)
    ?? optionalNonEmptyString(data.header?.event_id)
    ?? optionalNonEmptyString(data.event?.event_id);
};

export const pluginCardActionName = (data: CardActionData): string | undefined => {
  const valueAction = data.action?.value?.action;
  if (typeof valueAction === 'string' && valueAction.trim()) return valueAction.trim();
  const name = data.action?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
};

export const buildPluginCardActionRequest = (
  data: CardActionData,
  larkAppId: string,
  actionName: string,
): PluginCardActionRequest => {
  const operator = { ...(data.operator ?? {}) };
  const context = { ...(data.context ?? {}) };
  const messageId = optionalNonEmptyString(context.open_message_id)
    ?? optionalNonEmptyString(data.open_message_id);
  if (messageId && !optionalNonEmptyString(context.open_message_id)) {
    context.open_message_id = messageId;
  }
  return {
    schemaVersion: PLUGIN_CARD_ACTION_SCHEMA_VERSION,
    eventId: pluginCardActionEventId(data) ?? null,
    larkAppId,
    operator,
    context,
    actionName,
    action: {
      name: typeof data.action?.name === 'string' ? data.action.name : null,
      value: data.action?.value ?? {},
      option: data.action?.option ?? null,
      formValue: data.action?.form_value ?? {},
    },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === 'object' && !Array.isArray(value);
};

const parseToast = (value: unknown): PluginCardActionToast => {
  if (!isRecord(value)) throw new Error('invalid_plugin_card_action_toast');
  const type = value.type;
  const content = value.content;
  if (
    type !== 'success'
    && type !== 'info'
    && type !== 'warning'
    && type !== 'error'
  ) {
    throw new Error('invalid_plugin_card_action_toast_type');
  }
  if (typeof content !== 'string' || !content.trim() || content.length > 5_000) {
    throw new Error('invalid_plugin_card_action_toast_content');
  }
  return { type, content };
};

export const parsePluginCardActionResponse = (
  value: unknown,
  options: { callbackPolicy?: InteractiveCardCallbackPolicy } = {},
): PluginCardActionAck | undefined => {
  if (!isRecord(value) || value.schemaVersion !== PLUGIN_CARD_ACTION_SCHEMA_VERSION) {
    throw new Error('invalid_plugin_card_action_response_schema');
  }
  if (value.ack === undefined || value.ack === null) return undefined;
  if (!isRecord(value.ack)) throw new Error('invalid_plugin_card_action_ack');
  const ack = value.ack;
  const hasToast = Object.hasOwn(ack, 'toast');
  const hasCard = Object.hasOwn(ack, 'card');
  const toast = hasToast ? parseToast(ack.toast) : undefined;
  if (hasCard && !isRecord(ack.card)) throw new Error('invalid_plugin_card_action_card');
  const card = hasCard ? ack.card as Record<string, unknown> : undefined;
  if (card && findDisallowedCardCallback(card, 'card', options.callbackPolicy)) {
    throw new Error('invalid_plugin_card_action_card_callback');
  }
  if (!toast && !card) return undefined;
  const result: PluginCardActionAck = {};
  if (toast) result.toast = toast;
  if (card) result.card = { type: 'raw', data: card };
  return result;
};
