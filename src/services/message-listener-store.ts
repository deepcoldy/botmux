import { getBot, type MessageListenerConfig } from '../bot-registry.js';
import { rmwBotEntry } from './config-store.js';

export type MessageListenerUpdate = {
  enabled: boolean;
  name?: string;
  replyCardTitle?: string;
  workingDir?: string;
  prompt: string;
  senderPolicy?: MessageListenerConfig['senderPolicy'];
  messagePolicy?: MessageListenerConfig['messagePolicy'];
};

function stringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .map(value => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function senderTypes(raw: unknown): Array<'user' | 'bot'> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .map(value => value === 'app' ? 'bot' : value)
    .filter((value): value is 'user' | 'bot' => value === 'user' || value === 'bot');
  return values.length > 0 ? [...new Set(values)] : undefined;
}

export function sanitizeMessageListenerUpdate(raw: unknown): MessageListenerUpdate | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const enabled = entry.enabled === true;
  const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : '';
  const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined;
  const replyCardTitle = typeof entry.replyCardTitle === 'string' && entry.replyCardTitle.trim()
    ? entry.replyCardTitle.trim()
    : undefined;
  const workingDir = typeof entry.workingDir === 'string' && entry.workingDir.trim() ? entry.workingDir.trim() : undefined;

  const rawSender = entry.senderPolicy && typeof entry.senderPolicy === 'object' && !Array.isArray(entry.senderPolicy)
    ? entry.senderPolicy as Record<string, unknown>
    : {};
  const senderPolicy: MessageListenerConfig['senderPolicy'] = {};
  const mode = rawSender.mode === 'include_only' ? 'include_only' : 'all_except_excluded';
  const includeSenderOpenIds = stringList(rawSender.includeSenderOpenIds);
  const excludeSenderOpenIds = stringList(rawSender.excludeSenderOpenIds);
  const includeSenderTypes = senderTypes(rawSender.includeSenderTypes);
  const excludeSenderTypes = senderTypes(rawSender.excludeSenderTypes);
  if (mode !== 'all_except_excluded') senderPolicy.mode = mode;
  if (includeSenderOpenIds) senderPolicy.includeSenderOpenIds = includeSenderOpenIds;
  if (excludeSenderOpenIds) senderPolicy.excludeSenderOpenIds = excludeSenderOpenIds;
  if (includeSenderTypes) senderPolicy.includeSenderTypes = includeSenderTypes;
  if (excludeSenderTypes) senderPolicy.excludeSenderTypes = excludeSenderTypes;
  if (rawSender.excludeSelf === false) senderPolicy.excludeSelf = false;

  const rawMessage = entry.messagePolicy && typeof entry.messagePolicy === 'object' && !Array.isArray(entry.messagePolicy)
    ? entry.messagePolicy as Record<string, unknown>
    : {};
  const messagePolicy: MessageListenerConfig['messagePolicy'] = { scope: 'top_level' };
  const includeMsgTypes = stringList(rawMessage.includeMsgTypes);
  if (includeMsgTypes) messagePolicy.includeMsgTypes = includeMsgTypes;

  return {
    enabled,
    ...(name ? { name } : {}),
    ...(replyCardTitle ? { replyCardTitle } : {}),
    ...(workingDir ? { workingDir } : {}),
    prompt,
    ...(Object.keys(senderPolicy).length > 0 ? { senderPolicy } : {}),
    messagePolicy,
  };
}

export function validateMessageListenerUpdate(update: MessageListenerUpdate | undefined): { ok: true } | { ok: false; reason: string } {
  if (!update) return { ok: false, reason: 'invalid_listener' };
  if (!update.enabled) return { ok: true };
  if (!update.prompt.trim()) return { ok: false, reason: 'prompt_required' };
  const mode = update.senderPolicy?.mode === 'include_only' ? 'include_only' : 'all_except_excluded';
  if (mode === 'include_only' && (update.senderPolicy?.includeSenderOpenIds?.length ?? 0) === 0) {
    return { ok: false, reason: 'sender_required' };
  }
  return { ok: true };
}

export function getMessageListenerConfig(larkAppId: string, chatId: string): MessageListenerConfig | null {
  try {
    return getBot(larkAppId).config.messageListeners?.[chatId] ?? null;
  } catch {
    return null;
  }
}

export async function updateMessageListenerConfig(
  larkAppId: string,
  chatId: string,
  patch: MessageListenerUpdate,
): Promise<{ ok: true; listener: MessageListenerConfig | null } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const normalized: MessageListenerConfig | null = patch.enabled ? {
    enabled: true,
    ...(patch.name ? { name: patch.name } : {}),
    ...(patch.replyCardTitle ? { replyCardTitle: patch.replyCardTitle } : {}),
    ...(patch.workingDir ? { workingDir: patch.workingDir } : {}),
    prompt: patch.prompt,
    ...(patch.senderPolicy && Object.keys(patch.senderPolicy).length > 0 ? { senderPolicy: patch.senderPolicy } : {}),
    ...(patch.messagePolicy ? { messagePolicy: { ...patch.messagePolicy, scope: 'top_level' } } : { messagePolicy: { scope: 'top_level' } }),
    replyPolicy: { mode: 'thread', sessionMode: 'per_message' },
  } : null;

  const validation = validateMessageListenerUpdate(patch);
  if (!validation.ok) return { ok: false, reason: validation.reason };

  const result = await rmwBotEntry<MessageListenerConfig | null>(larkAppId, (entry) => {
    if (!normalized) {
      if (entry.messageListeners && typeof entry.messageListeners === 'object') {
        delete entry.messageListeners[chatId];
        if (Object.keys(entry.messageListeners).length === 0) delete entry.messageListeners;
      }
      return { write: true, result: null };
    }
    if (!entry.messageListeners || typeof entry.messageListeners !== 'object' || Array.isArray(entry.messageListeners)) {
      entry.messageListeners = {};
    }
    entry.messageListeners[chatId] = normalized;
    return { write: true, result: normalized };
  });
  if (!result.ok) return { ok: false, reason: result.reason };

  if (!bot.config.messageListeners) bot.config.messageListeners = {};
  if (normalized) bot.config.messageListeners[chatId] = normalized;
  else {
    delete bot.config.messageListeners[chatId];
    if (Object.keys(bot.config.messageListeners).length === 0) bot.config.messageListeners = undefined;
  }

  return { ok: true, listener: result.result };
}
