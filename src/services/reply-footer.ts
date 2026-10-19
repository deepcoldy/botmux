/** Reply-footer display policy. Missing values preserve existing behavior. */
export const REPLY_FOOTER_KEYS = [
  'replyFooterEnabled', 'replyFooterBrand', 'replyFooterModel',
  'replyFooterUsage', 'replyFooterRecipients', 'replyFooterVoice',
] as const;
export type ReplyFooterKey = typeof REPLY_FOOTER_KEYS[number];
export type ReplyFooterPreferences = Partial<Record<ReplyFooterKey, boolean>>;

/** Only explicit booleans are accepted; unknown keys never cross IPC/env boundaries. */
export function normalizeReplyFooter(value: unknown): ReplyFooterPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return Object.fromEntries(REPLY_FOOTER_KEYS.flatMap(key =>
    typeof raw[key] === 'boolean' ? [[key, raw[key]]] : []));
}
