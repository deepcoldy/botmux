/**
 * Daemon-side CLI quota fallback policy.
 *
 * The configured target is a stable Lark application id.  The receiver-scoped
 * open_id used in the actual <at> tag is resolved only at send time from live
 * chat membership; config must never persist or copy an app-scoped open_id.
 */

export type QuotaFallbackKind = 'usage' | 'rate';

export const DEFAULT_QUOTA_FALLBACK_MESSAGE =
  '主 Bot 当前额度已耗尽，请接手本会话并结合上下文继续处理。';
export const MAX_QUOTA_FALLBACK_MESSAGE_LENGTH = 1_000;

export interface QuotaFallbackBotConfig {
  enabled: true;
  targetAppId: string;
  kinds: QuotaFallbackKind[];
  message: string;
}

export type QuotaFallbackConfigNormalization =
  | { config: QuotaFallbackBotConfig; error?: undefined }
  | { config?: undefined; error?: string };

const LARK_APP_ID_RE = /^cli_[A-Za-z0-9]+$/;
const NATIVE_AT_TAG_RE = /<\/?at(?:\s|>|$)/i;

/**
 * Normalize the optional bots.json block. Invalid enabled blocks are disabled
 * as one unit (and surfaced to the caller as an error) rather than partially
 * applying a potentially surprising handoff policy.
 */
export function normalizeQuotaFallbackBotConfig(
  raw: unknown,
  sourceAppId: string,
): QuotaFallbackConfigNormalization {
  if (raw === undefined || raw === null) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'quotaFallbackBot must be an object' };
  }

  const value = raw as Record<string, unknown>;
  // Explicit opt-in only. A disabled block is inert even if it retains draft
  // values for a later edit.
  if (value.enabled !== true) return {};

  const targetAppId = typeof value.targetAppId === 'string'
    ? value.targetAppId.trim()
    : '';
  if (!LARK_APP_ID_RE.test(targetAppId)) {
    return { error: 'quotaFallbackBot.targetAppId must be a valid cli_ application id' };
  }
  if (targetAppId === sourceAppId) {
    return { error: 'quotaFallbackBot.targetAppId must not point to the current bot' };
  }

  let kinds: QuotaFallbackKind[] = ['usage', 'rate'];
  if (value.kinds !== undefined) {
    if (!Array.isArray(value.kinds)) {
      return { error: 'quotaFallbackBot.kinds must be an array containing usage and/or rate' };
    }
    const normalized: QuotaFallbackKind[] = [];
    for (const kind of value.kinds) {
      if (kind !== 'usage' && kind !== 'rate') {
        return { error: 'quotaFallbackBot.kinds accepts only usage and rate' };
      }
      if (!normalized.includes(kind)) normalized.push(kind);
    }
    if (normalized.length === 0) {
      return { error: 'quotaFallbackBot.kinds must contain at least one limit kind' };
    }
    kinds = normalized;
  }

  const message = value.message === undefined
    ? DEFAULT_QUOTA_FALLBACK_MESSAGE
    : typeof value.message === 'string'
      ? value.message.trim()
      : '';
  if (!message) return { error: 'quotaFallbackBot.message must be a non-blank string' };
  if (message.length > MAX_QUOTA_FALLBACK_MESSAGE_LENGTH) {
    return { error: `quotaFallbackBot.message must be at most ${MAX_QUOTA_FALLBACK_MESSAGE_LENGTH} characters` };
  }
  // The daemon owns the one real mention it prepends. Config text cannot add a
  // second native mention or smuggle an arbitrary receiver-scoped open_id.
  if (NATIVE_AT_TAG_RE.test(message)) {
    return { error: 'quotaFallbackBot.message must not contain native <at> tags' };
  }

  return { config: { enabled: true, targetAppId, kinds, message } };
}

export type QuotaFallbackTurnOrigin = 'human' | 'bot' | 'unknown';

/**
 * Resolve the exact turn's sender from the durable reply-target record. Only a
 * positively identified human may start an automatic handoff. This conservative
 * gate makes bot-origin, synthetic, restored and pruned turns stop after one hop.
 */
export function quotaFallbackTurnOrigin(
  session: {
    replyTargets?: Record<string, {
      senderOpenId?: string;
      participants?: Array<{ openId?: string; isBot?: boolean }>;
      participantsIncomplete?: boolean;
    }>;
  },
  turnId: string | undefined,
): QuotaFallbackTurnOrigin {
  if (!turnId) return 'unknown';
  const target = session.replyTargets?.[turnId];
  if (!target?.senderOpenId || target.participantsIncomplete) return 'unknown';
  const sender = target.participants?.find(p => p.openId === target.senderOpenId);
  if (sender?.isBot === true) return 'bot';
  if (sender?.isBot === false) return 'human';
  return 'unknown';
}

export type QuotaFallbackTargetResolution =
  | { ok: true; openId: string; name?: string; source: 'local-peer' | 'team' }
  | {
      ok: false;
      reason:
        | 'self_target'
        | 'local_resolution_failed'
        | 'untrusted_target'
        | 'ambiguous_target'
        | 'target_not_in_chat'
        | 'live_membership_unavailable';
      detail?: string;
    };

export interface QuotaFallbackTargetDeps {
  isLocalConfigured(appId: string): boolean;
  resolveLocal(
    receiverAppId: string,
    chatId: string,
    targetAppId: string,
  ): Promise<{ ok: true; openId: string } | { ok: false; detail?: string }>;
  listTrustedTeamBots(): Promise<Array<{ larkAppId: string; botName: string }>>;
  listLiveChatBots(
    receiverAppId: string,
    chatId: string,
  ): Promise<Array<{ openId: string; displayName: string }>>;
}

/**
 * Bind a stable target app id to one live, receiver-scoped mention handle.
 * Local peers use the existing authorization-grade app-id resolver. Remote
 * targets must be present in the trusted team directory and bind by a globally
 * unique team name to exactly one current live chat row.
 */
export async function resolveQuotaFallbackTarget(
  sourceAppId: string,
  chatId: string,
  targetAppId: string,
  deps: QuotaFallbackTargetDeps,
): Promise<QuotaFallbackTargetResolution> {
  if (sourceAppId === targetAppId) return { ok: false, reason: 'self_target' };

  if (deps.isLocalConfigured(targetAppId)) {
    try {
      const resolved = await deps.resolveLocal(sourceAppId, chatId, targetAppId);
      if (!resolved.ok) {
        return { ok: false, reason: 'local_resolution_failed', detail: resolved.detail };
      }
      if (!resolved.openId.startsWith('ou_')) {
        return { ok: false, reason: 'local_resolution_failed', detail: 'resolved handle is not an open_id' };
      }
      return { ok: true, openId: resolved.openId, source: 'local-peer' };
    } catch (error) {
      return {
        ok: false,
        reason: 'local_resolution_failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  let directory: Array<{ larkAppId: string; botName: string }>;
  try {
    directory = await deps.listTrustedTeamBots();
  } catch (error) {
    return {
      ok: false,
      reason: 'untrusted_target',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const targetRows = directory.filter(row => row.larkAppId === targetAppId);
  if (targetRows.length === 0) return { ok: false, reason: 'untrusted_target' };
  const targetNames = [...new Set(targetRows.map(row => row.botName.trim()).filter(Boolean))];
  if (targetNames.length !== 1) return { ok: false, reason: 'ambiguous_target' };
  const targetName = targetNames[0];
  if (directory.some(row => row.larkAppId !== targetAppId && row.botName.trim() === targetName)) {
    return { ok: false, reason: 'ambiguous_target' };
  }

  let live: Array<{ openId: string; displayName: string }>;
  try {
    live = await deps.listLiveChatBots(sourceAppId, chatId);
  } catch (error) {
    return {
      ok: false,
      reason: 'live_membership_unavailable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const matches = live.filter(row => row.displayName.trim() === targetName);
  if (matches.length === 0) return { ok: false, reason: 'target_not_in_chat' };
  if (matches.length !== 1 || !matches[0].openId.startsWith('ou_')) {
    return { ok: false, reason: 'ambiguous_target' };
  }
  return { ok: true, openId: matches[0].openId, name: targetName, source: 'team' };
}
