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
  contentPolicy?: MessageListenerConfig['contentPolicy'];
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

function senderKinds(
  raw: unknown,
  excludeSenderOpenIds: string[] | undefined,
): Record<string, 'user' | 'bot'> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const allowed = excludeSenderOpenIds ? new Set(excludeSenderOpenIds) : undefined;
  const out: Record<string, 'user' | 'bot'> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || (allowed && !allowed.has(key))) continue;
    if (value === 'user' || value === 'bot') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  const excludeSenderKinds = senderKinds(rawSender.excludeSenderKinds, excludeSenderOpenIds);
  const includeSenderTypes = senderTypes(rawSender.includeSenderTypes);
  const excludeSenderTypes = senderTypes(rawSender.excludeSenderTypes);
  if (mode !== 'all_except_excluded') senderPolicy.mode = mode;
  if (includeSenderOpenIds) senderPolicy.includeSenderOpenIds = includeSenderOpenIds;
  if (excludeSenderOpenIds) senderPolicy.excludeSenderOpenIds = excludeSenderOpenIds;
  if (excludeSenderKinds) senderPolicy.excludeSenderKinds = excludeSenderKinds;
  if (includeSenderTypes) senderPolicy.includeSenderTypes = includeSenderTypes;
  if (excludeSenderTypes) senderPolicy.excludeSenderTypes = excludeSenderTypes;
  if (rawSender.excludeSelf === false) senderPolicy.excludeSelf = false;

  const rawMessage = entry.messagePolicy && typeof entry.messagePolicy === 'object' && !Array.isArray(entry.messagePolicy)
    ? entry.messagePolicy as Record<string, unknown>
    : {};
  const messagePolicy: MessageListenerConfig['messagePolicy'] = { scope: 'top_level' };
  const includeMsgTypes = stringList(rawMessage.includeMsgTypes);
  if (includeMsgTypes) messagePolicy.includeMsgTypes = includeMsgTypes;

  const rawContent = entry.contentPolicy && typeof entry.contentPolicy === 'object' && !Array.isArray(entry.contentPolicy)
    ? entry.contentPolicy as Record<string, unknown>
    : undefined;
  let contentPolicy: MessageListenerConfig['contentPolicy'];
  if (rawContent) {
    const includeKeywords = stringList(rawContent.includeKeywords);
    // V1 is keyword-substring only (no regexes on the daemon main loop — see
    // the contentPolicy type doc in bot-registry).
    if (includeKeywords) {
      contentPolicy = {
        includeKeywords,
        ...(rawContent.matchMode === 'all' ? { matchMode: 'all' as const } : {}),
      };
    }
  }

  return {
    enabled,
    ...(name ? { name } : {}),
    ...(replyCardTitle ? { replyCardTitle } : {}),
    ...(workingDir ? { workingDir } : {}),
    prompt,
    ...(Object.keys(senderPolicy).length > 0 ? { senderPolicy } : {}),
    messagePolicy,
    ...(contentPolicy ? { contentPolicy } : {}),
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

/**
 * Build the persisted config for a listener update, or `null` when the update
 * carries nothing worth keeping (→ delete the entry).
 *
 * A DISABLED listener with a non-empty prompt is a valid *draft*: it is
 * persisted with `enabled:false` so the operator can turn it on later without
 * retyping. Previously any disabled update was collapsed to `null` (deleted
 * outright), so a draft saved while the toggle was off vanished on the next
 * reload — the exact bug this fixes. Only a disabled update with a BLANK prompt
 * is a true clear (this is also what the DELETE route sends: `{enabled:false,
 * prompt:''}`). Enabled updates always carry a prompt
 * (validateMessageListenerUpdate guarantees it), so they always build a config.
 *
 * Runtime is unaffected by a persisted draft: findMessageListenerForChat and
 * enabledMessageListenerChatIds both require `enabled===true`, so an off draft
 * never matches messages — it only survives for the dashboard editor.
 */
export function messageListenerConfigFromUpdate(patch: MessageListenerUpdate): MessageListenerConfig | null {
  if (!patch.prompt.trim()) return null;
  return {
    enabled: patch.enabled,
    ...(patch.name ? { name: patch.name } : {}),
    ...(patch.replyCardTitle ? { replyCardTitle: patch.replyCardTitle } : {}),
    ...(patch.workingDir ? { workingDir: patch.workingDir } : {}),
    prompt: patch.prompt,
    ...(patch.senderPolicy && Object.keys(patch.senderPolicy).length > 0 ? { senderPolicy: patch.senderPolicy } : {}),
    ...(patch.messagePolicy ? { messagePolicy: { ...patch.messagePolicy, scope: 'top_level' } } : { messagePolicy: { scope: 'top_level' } }),
    ...(patch.contentPolicy ? { contentPolicy: patch.contentPolicy } : {}),
    replyPolicy: { mode: 'thread', sessionMode: 'per_message' },
  };
}

export async function updateMessageListenerConfig(
  larkAppId: string,
  chatId: string,
  patch: MessageListenerUpdate,
): Promise<{ ok: true; listener: MessageListenerConfig | null } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const validation = validateMessageListenerUpdate(patch);
  if (!validation.ok) return { ok: false, reason: validation.reason };

  // A disabled update with a non-empty prompt persists as an off DRAFT (kept for
  // the editor, never matched at runtime); only a blank-prompt disabled update
  // clears the entry. See messageListenerConfigFromUpdate.
  const normalized = messageListenerConfigFromUpdate(patch);

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
