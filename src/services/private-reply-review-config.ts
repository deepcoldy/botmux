export type PrivateReplyReviewAudience = 'requester' | 'owners' | 'allowedUsers';
export type PrivateReplyReviewFallback = 'dm' | 'public' | 'drop';

export interface PrivateReplyReviewConfig {
  enabled: boolean;
  audience: PrivateReplyReviewAudience;
  fallback: PrivateReplyReviewFallback;
  expireHours: number;
}

export const DEFAULT_PRIVATE_REPLY_REVIEW: PrivateReplyReviewConfig = {
  enabled: false,
  audience: 'requester',
  fallback: 'dm',
  expireHours: 24,
};

export function normalizePrivateReplyReviewConfig(raw: unknown): PrivateReplyReviewConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const enabled = value.enabled === true;
  const audience: PrivateReplyReviewAudience =
    value.audience === 'owners' || value.audience === 'allowedUsers' || value.audience === 'requester'
      ? value.audience
      : DEFAULT_PRIVATE_REPLY_REVIEW.audience;
  const fallback: PrivateReplyReviewFallback =
    value.fallback === 'public' || value.fallback === 'drop' || value.fallback === 'dm'
      ? value.fallback
      : DEFAULT_PRIVATE_REPLY_REVIEW.fallback;
  const expireHours = typeof value.expireHours === 'number'
    && Number.isFinite(value.expireHours)
    && value.expireHours >= 1
    && value.expireHours <= 168
    ? Math.floor(value.expireHours)
    : DEFAULT_PRIVATE_REPLY_REVIEW.expireHours;
  if (!enabled && audience === DEFAULT_PRIVATE_REPLY_REVIEW.audience
    && fallback === DEFAULT_PRIVATE_REPLY_REVIEW.fallback
    && expireHours === DEFAULT_PRIVATE_REPLY_REVIEW.expireHours) {
    return undefined;
  }
  return { enabled, audience, fallback, expireHours };
}

export function resolvedPrivateReplyReviewConfig(raw: unknown): PrivateReplyReviewConfig {
  return normalizePrivateReplyReviewConfig(raw) ?? DEFAULT_PRIVATE_REPLY_REVIEW;
}
