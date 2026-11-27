import { isAbsolute } from 'node:path';
import type { FeedbackPolicy } from '../../../services/feedback-policy.js';
import type { FeedbackWebhookDestination } from '../../../services/feedback-outbox.js';
import { validateWecomMessageConfig } from './message-config.js';

export const PLATFORM_KEYS = [
  'summaryRange',
  'summaryMemory',
  'summaryMemoryPath',
  'chatFeedbackPolicies',
  'feedbackWebhooks',
] as const;

/** The `/summary` range when `summaryRange` leaves a bound unset: the Feishu defaults (bot-registry.ts). */
export const WECOM_SUMMARY_DEFAULT_LIMIT = 50;
export const WECOM_SUMMARY_DEFAULT_SINCE_HOURS = 24;

export interface WecomNativePlatformConfig {
  summaryRange?: { limit?: number; sinceHours?: number };
  summaryMemory?: boolean;
  summaryMemoryPath?: string;
  chatFeedbackPolicies?: Record<string, FeedbackPolicy | { enabled: false }>;
  feedbackWebhooks?: FeedbackWebhookDestination[];
}

const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('invalid_wecom_native_platform');
  }
  return v as Record<string, unknown>;
};
const text = (v: unknown, max = 16000): v is string => typeof v === 'string' && v.length <= max && !v.includes('\0');

export function validateWecomNativePlatformConfig(raw: unknown): WecomNativePlatformConfig {
  const input = object(raw);
  const output: Record<string, unknown> = {};
  for (const key of PLATFORM_KEYS) {
    if (key in input) {
      output[key] = structuredClone(input[key]);
    }
  }
  if ('summaryMemory' in output && typeof output.summaryMemory !== 'boolean') {
    throw new Error('invalid_wecom_summaryMemory');
  }
  if (output.summaryRange !== undefined) {
    const range = object(output.summaryRange);
    if (Object.keys(range).some(k => !['limit', 'sinceHours'].includes(k))
      || range.limit !== undefined
        && (!Number.isInteger(range.limit) || Number(range.limit) < 1 || Number(range.limit) > 1000)
      || range.sinceHours !== undefined
        && (typeof range.sinceHours !== 'number'
          || !Number.isFinite(range.sinceHours)
          || range.sinceHours <= 0
          || range.sinceHours > 8760)) {
      throw new Error('invalid_wecom_summary_range');
    }
  }
  if (output.summaryMemoryPath !== undefined
    && (!text(output.summaryMemoryPath, 1024)
      || !output.summaryMemoryPath
      || isAbsolute(output.summaryMemoryPath)
      || output.summaryMemoryPath.split(/[\\/]/).includes('..'))) {
    throw new Error('invalid_wecom_summary_path');
  }
  if (output.chatFeedbackPolicies !== undefined) {
    const chats = object(output.chatFeedbackPolicies);
    for (const [chat, policy] of Object.entries(chats)) {
      if (!chat || !text(chat, 256)) {
        throw new Error('invalid_wecom_feedback_chat');
      }
      chats[chat] = validateWecomMessageConfig({ feedback: policy }).feedback;
    }
  }
  if (output.feedbackWebhooks !== undefined) {
    if (!Array.isArray(output.feedbackWebhooks)) {
      throw new Error('invalid_wecom_feedback_webhooks');
    }
    const ids = new Set<string>();
    for (const raw of output.feedbackWebhooks) {
      const item = object(raw);
      let url: URL;
      try {
        url = new URL(String(item.url));
      } catch {
        throw new Error('invalid_wecom_feedback_webhook');
      }
      if (!text(item.id, 128)
        || !item.id
        || ids.has(item.id)
        || typeof item.enabled !== 'boolean'
        || url.protocol !== 'https:'
        || url.username
        || url.password
        || url.hash
        || !text(item.secretRef, 256)
        || !item.secretRef
        || !Array.isArray(item.eventTypes)
        || item.eventTypes.some(t => !['turn.completed', 'feedback.revised'].includes(String(t)))
        || item.timeoutMs !== undefined
          && (!Number.isInteger(item.timeoutMs) || Number(item.timeoutMs) < 100 || Number(item.timeoutMs) > 30000)) {
        throw new Error('invalid_wecom_feedback_webhook');
      }
      ids.add(item.id);
    }
  }
  return output as WecomNativePlatformConfig;
}
