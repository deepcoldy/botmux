import type { FrozenSessionReplyTarget } from '../types.js';

export function validateFrozenReplyTarget(target: unknown, chatId: string): FrozenSessionReplyTarget {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error('REPLY_TARGET_INVALID');
  }
  const value = target as Record<string, unknown>;
  if (value.mode === 'plain' && value.chatId === chatId && /^oc_[A-Za-z0-9_-]+$/.test(chatId)) {
    return { mode: 'plain', chatId };
  }
  if ((value.mode === 'thread' || value.mode === 'quote')
    && typeof value.rootMessageId === 'string' && /^om_[A-Za-z0-9_-]+$/.test(value.rootMessageId)) {
    return { mode: value.mode, rootMessageId: value.rootMessageId };
  }
  throw new Error('REPLY_TARGET_INVALID');
}
