import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFeedbackExtensionConfig } from './feedback-extension-config.js';
import { resolveFeedbackPolicyForDelivery } from './feedback-policy-resolver.js';
import { materializeFeedbackPolicyForDelivery } from './feedback-reviewer-delivery.js';
import { getBot, type BotConfig } from '../bot-registry.js';
import { resolveAllowedUsersWithMap } from '../im/lark/client.js';
import type { FeedbackPolicy } from './feedback-policy.js';

export async function feedbackPolicyForRelayedDelivery(input: {
  dataDir: string; appId: string; chatId: string; callerOpenId?: string;
}): Promise<{ policy: FeedbackPolicy; requesterSubjectId?: string } | undefined> {
  let bot: BotConfig;
  try { bot = getBot(input.appId).config; }
  catch {
    if (!existsSync(join(input.dataDir, 'feedback-extensions.json'))) return undefined;
    throw new Error('feedback_relay_bot_unavailable');
  }
  if (!existsSync(join(input.dataDir, 'feedback-extensions.json')) && !bot.feedbackPresentation) return undefined;
  const extension = await readFeedbackExtensionConfig(input.dataDir);
  const presentation = extension.presentations[input.appId] ?? bot.feedbackPresentation;
  if (!presentation || (!presentation.default.enabled && !presentation.rules.some(rule => rule.enabled))) return undefined;
  const policy = resolveFeedbackPolicyForDelivery({
    dataDir: input.dataDir, larkAppId: input.appId, chatId: input.chatId, bot,
  });
  if (!policy) return undefined;
  const requesterSubjectId = input.callerOpenId?.startsWith('ou_') ? input.callerOpenId : undefined;
  if (policy.audience === 'requester' && !requesterSubjectId) return undefined;
  const materialized = await materializeFeedbackPolicyForDelivery({
    policy, dataDir: input.dataDir, larkAppId: input.appId, resolveAllowedUsersWithMap,
  });
  return materialized ? { policy: materialized, requesterSubjectId } : undefined;
}
