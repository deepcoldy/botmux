import type { BotConfig } from '../../../bot-registry.js';
import { normalizeFeedbackPolicy, type FeedbackPolicy } from '../../../services/feedback-policy.js';
import { normalizeLongTaskReminderConfig } from '../../../services/long-task-reminder-policy.js';
import { normalizeSessionOwnerReminderConfig } from '../../../core/session-owner-reminder.js';
import { normalizeNoProgressNotifyPolicy } from '../../../services/no-progress-notify-policy.js';

/** Gateway-owned presentation. These keys never become synthetic Lark bot authority. */
export const WECOM_MESSAGE_CONFIG_KEYS = [
  'goalStatusCard', 'replyCardMode', 'disableStreamingCard', 'showReplyTiming', 'usageDisplay',
  'replyFooterEnabled', 'replyFooterBrand', 'replyFooterModel', 'replyFooterUsage',
  'replyFooterRecipients', 'brandLabel', 'replyCardActions',
  'longTaskReminder', 'sessionOwnerReminder', 'hiddenStreamingCardButtons', 'cotEnabled', 'replyCardShowTools', 'feedback', 'noProgressNotify',
] as const;
export type WecomMessageConfig = Pick<BotConfig, Exclude<typeof WECOM_MESSAGE_CONFIG_KEYS[number], 'feedback' | 'replyCardMode'>> & {
  replyCardMode?: 'legacy' | 'unified' | 'final-only';
  /** Reviewers are native WeCom userid values, never Lark open_id/email aliases. */
  feedback?: FeedbackPolicy | { enabled?: false };
};
const booleanKeys = new Set([
  'goalStatusCard',
  'disableStreamingCard',
  'showReplyTiming',
  'replyFooterEnabled',
  'replyFooterBrand',
  'replyFooterModel',
  'replyFooterUsage',
  'replyFooterRecipients',
  'replyCardActions',
  'cotEnabled',
  'replyCardShowTools',
]);
export const WECOM_OWNER_REMINDER_STATES = ['idle', 'dormant', 'pending_repo', 'limited', 'agent_attention'] as const;
const keySet = new Set<string>(WECOM_MESSAGE_CONFIG_KEYS);
/** The reply-card buttons a WeCom configuration hides; the gateway leaves them off its cards and refuses their clicks. */
const HIDDEN_CARD_BUTTONS: readonly string[] = ['stop', 'close', 'output', 'terminal', 'writeLink', 'compact'];
/**
 * Written by earlier versions only: the reply-draft button, retired with its
 * feature. A file that still lists it parses; the value is dropped, so no save
 * writes it back.
 */
const RETIRED_HIDDEN_CARD_BUTTONS: readonly string[] = ['substitute'];

function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('invalid_wecom_message_config');
  }
  return raw as Record<string, unknown>;
}

export function validateWecomMessageConfig(raw: unknown): WecomMessageConfig {
  const input = record(raw);
  if (Object.keys(input).some(key => !keySet.has(key))) {
    throw new Error('invalid_wecom_message_config');
  }
  const output = structuredClone(input);
  for (const [key, value] of Object.entries(input)) {
    if (booleanKeys.has(key) && typeof value !== 'boolean') {
      throw new Error(`invalid_wecom_message_${key}`);
    }
    if (key === 'replyCardMode' && !['legacy', 'unified', 'final-only'].includes(String(value))) {
      throw new Error('invalid_wecom_replyCardMode');
    }
    if (key === 'usageDisplay' && !['streaming', 'footer', 'off'].includes(String(value))) {
      throw new Error('invalid_wecom_usageDisplay');
    }
    if (key === 'brandLabel' && (typeof value !== 'string' || value.length > 2000 || value.includes('\0'))) {
      throw new Error('invalid_wecom_brandLabel');
    }
    if (key === 'hiddenStreamingCardButtons') {
      if (!Array.isArray(value)
        || value.some(name => !HIDDEN_CARD_BUTTONS.includes(name) && !RETIRED_HIDDEN_CARD_BUTTONS.includes(name))) {
        throw new Error('invalid_wecom_hidden_buttons');
      }
      output[key] = value.filter(name => !RETIRED_HIDDEN_CARD_BUTTONS.includes(name));
    }
    if (key === 'longTaskReminder' || key === 'sessionOwnerReminder') {
      const normalized = key === 'longTaskReminder'
        ? normalizeLongTaskReminderConfig(value)
        : normalizeSessionOwnerReminderConfig(value);
      if (key === 'sessionOwnerReminder'
        && Array.isArray((value as Record<string, unknown>).states)
        && ((value as Record<string, unknown>).states as unknown[])
          .some(state => !(WECOM_OWNER_REMINDER_STATES as readonly unknown[]).includes(state))) {
        throw new Error('unsupported_wecom_owner_reminder_state');
      }
      if (!normalized) {
        throw new Error(`invalid_wecom_${key}`);
      }
      output[key] = normalized;
    }
    if (key === 'noProgressNotify') {
      output[key] = normalizeNoProgressNotifyPolicy(value);
    }
    if (key === 'feedback') {
      const feedback = { ...record(value) };
      if (feedback.enabled === false) {
        output.feedback = { enabled: false };
        continue;
      }
      if (feedback.buttonAlign !== undefined && feedback.buttonAlign !== 'native') {
        throw new Error('unsupported_wecom_feedback_button_align');
      }
      delete feedback.buttonAlign;
      const reviewers = feedback.reviewers ?? [];
      if (!Array.isArray(reviewers)
        || reviewers.some(user => typeof user !== 'string' || !user.trim() || user.length > 256 || user === '*' || /[\s\0]/.test(user))) {
        throw new Error('invalid_wecom_feedback_reviewers');
      }
      // Reuse structural policy validation while retaining the native identity
      // namespace. The synthetic prefix is validation-only and never persisted.
      const normalized = normalizeFeedbackPolicy({ ...feedback, reviewers: reviewers.map(user => `ou_${user}`) });
      if (normalized.negativeFollowup.comment.required && !normalized.negativeFollowup.comment.enabled) {
        throw new Error('invalid_wecom_required_feedback_comment');
      }
      output.feedback = { ...normalized, reviewers: [...reviewers] };
    }
  }
  return output as WecomMessageConfig;
}

/** Safe effective UI defaults match gateway disclosure boundaries. */
export function effectiveWecomMessageConfig(raw: WecomMessageConfig | undefined): WecomMessageConfig {
  return {
    disableStreamingCard: true,
    cotEnabled: false,
    replyCardShowTools: false,
    replyCardActions: false,
    ...raw,
  };
}
/** Old configurations keep the existing acknowledgement/final-only behavior. */
export function wecomProgressEnabled(policy: WecomMessageConfig): boolean {
  return policy.disableStreamingCard === false && policy.replyCardMode !== 'final-only';
}
