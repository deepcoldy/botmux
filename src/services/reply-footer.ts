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

/** Host-injected snapshot for env-only sends; malformed input uses defaults. */
export function parseReplyFooterEnv(value: string | undefined): ReplyFooterPreferences {
  try { return normalizeReplyFooter(JSON.parse(value ?? '{}')); }
  catch { return {}; }
}

/** One effective policy for every footer block, including actions and custom cards. */
export function resolveReplyFooterPolicy(preferences: ReplyFooterPreferences = {}) {
  const enabled = preferences.replyFooterEnabled !== false;
  return {
    enabled,
    brand: enabled && preferences.replyFooterBrand !== false,
    model: enabled && preferences.replyFooterModel !== false,
    usage: enabled && preferences.replyFooterUsage !== false,
    recipients: enabled && preferences.replyFooterRecipients !== false,
    voice: enabled && preferences.replyFooterVoice !== false,
  };
}
