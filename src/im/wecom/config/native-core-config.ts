export const WECOM_NATIVE_CORE_KEYS = [
  'p2pOpen',
  'autoGrantRequestCards',
  'grantRequestToOwnerDm',
  'grantDefaultDurationMs',
  'messageQuotaDefaultLimit',
  'canTalkDaemonCommands',
  'writableTerminalLinkInCard',
  'trustSameOwnerBots',
  'botToBotSameDir',
  'quotaFallbackBot',
] as const;

/**
 * The commands a talk-only user may run, and the ones allowed when the list is
 * not configured (bridge/inbound.ts).
 */
export const WECOM_TALK_COMMANDS = ['/status', '/stop', '/restart'] as const;
export const WECOM_DEFAULT_TALK_COMMANDS: readonly string[] = ['/status', '/stop'];

/**
 * Upper bound of the task quota one grant carries. Earlier versions accepted
 * up to 1000000: such a value still parses (the connection starts and the
 * policy revision it is part of does not move), and grants take this bound.
 * A Dashboard save may keep such a value but never write a new one above it.
 */
export const WECOM_MESSAGE_QUOTA_MAX = 1000;
const LEGACY_MESSAGE_QUOTA_MAX = 1000000;

/** The task quota a new grant carries under `limit` (the configured value, or the default 100). */
export function wecomEffectiveMessageQuota(limit: number | undefined): number {
  return Math.min(limit ?? 100, WECOM_MESSAGE_QUOTA_MAX);
}

export interface WecomNativeCoreConfig {
  p2pOpen?: boolean;
  autoGrantRequestCards?: boolean;
  grantRequestToOwnerDm?: boolean;
  grantDefaultDurationMs?: number;
  messageQuotaDefaultLimit?: number;
  canTalkDaemonCommands?: string[];
  writableTerminalLinkInCard?: boolean;
  /** Same-host connections that pass the peer trust rule are trusted (config/peer-trust.ts). Unset = on. */
  trustSameOwnerBots?: boolean;
  /** A new session may start in a trusted peer's directory. Unset = on. */
  botToBotSameDir?: boolean;
  quotaFallbackBot?: {
    enabled: boolean;
    /** The configuration id (wecomConfigId) of another WeCom connection on this host. */
    peerId?: string;
    kinds: ('usage' | 'rate')[];
    message?: string;
  };
}

export function validateWecomNativeCoreConfig(raw: unknown): WecomNativeCoreConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('wecom_invalid_native_configuration');
  }
  const x = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of WECOM_NATIVE_CORE_KEYS) {
    const value = x[key];
    if (value === undefined) {
      continue;
    }
    if ([
      'p2pOpen',
      'autoGrantRequestCards',
      'grantRequestToOwnerDm',
      'writableTerminalLinkInCard',
      'trustSameOwnerBots',
      'botToBotSameDir',
    ].includes(key)) {
      if (typeof value !== 'boolean') {
        throw new Error('wecom_invalid_native_configuration');
      }
    } else if (key === 'canTalkDaemonCommands') {
      if (!Array.isArray(value)
        || value.length > 100
        || value.some(v => typeof v !== 'string' || !v || v.length > 200 || /[\x00-\x20]/.test(v))) {
        throw new Error('wecom_invalid_native_configuration');
      }
      if (value.some(v => !(WECOM_TALK_COMMANDS as readonly string[]).includes(v))) {
        throw new Error('wecom_invalid_talk_commands');
      }
    } else if (key === 'grantDefaultDurationMs' || key === 'messageQuotaDefaultLimit') {
      if (!Number.isSafeInteger(value)
        || (value as number) < 1
        || (value as number) > (key === 'grantDefaultDurationMs' ? 30 * 86400000 : LEGACY_MESSAGE_QUOTA_MAX)) {
        throw new Error('wecom_invalid_native_configuration');
      }
    } else if (key === 'quotaFallbackBot') {
      const q = value as any;
      if (!q
        || typeof q !== 'object'
        || typeof q.enabled !== 'boolean'
        || Object.keys(q).some(k => !['enabled', 'peerId', 'kinds', 'message'].includes(k))
        || q.peerId !== undefined && (typeof q.peerId !== 'string' || !/^[a-f0-9]{64}$/.test(q.peerId))
        || !Array.isArray(q.kinds)
        || q.kinds.some((k: unknown) => k !== 'usage' && k !== 'rate')
        || q.message !== undefined && (typeof q.message !== 'string' || q.message.length > 2000)) {
        throw new Error('wecom_invalid_quota_fallback');
      }
    }
    out[key] = value;
  }
  return out as WecomNativeCoreConfig;
}
