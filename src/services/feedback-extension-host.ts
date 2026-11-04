import { existsSync, readFileSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FeedbackExtensionStore } from './feedback-extension-store.js';
import { readFeedbackExtensionConfig } from './feedback-extension-config.js';
import { readFeedbackStorageConfig } from './feedback-storage-config.js';
import { getSkillFeedbackStore } from './skill-feedback-store.js';
import { reconcileFeedbackSurfaces } from './feedback-extension-runtime.js';
import { runFeedbackHook, type HookEvent } from './feedback-hook-runner.js';
import { getBotBrand, getBot } from '../bot-registry.js';
import { resolveFeedbackPolicyForDelivery } from './feedback-policy-resolver.js';
import { chatAppLink, threadAppLink } from '../im/lark/lark-hosts.js';
import { getMessageDetail, getMessageThreadId, replyMessage, updateMessage } from '../im/lark/client.js';
import { normalizeCardActionData } from '../im/lark/card-action-data.js';
import { resolveCardOperatorUnionId } from '../im/lark/card-handler.js';
import { handleSkillFeedbackCardAction, renderFeedbackCard } from '../im/lark/skill-feedback-card.js';
import { surfaceFeedbackStore } from './feedback-surface-delivery.js';
import { feedbackMaintenanceActive, acquireFeedbackSendLease } from './feedback-maintenance.js';

function configured(dataDir: string): boolean { return existsSync(join(dataDir, 'feedback-extensions.json')); }
export async function tickFeedbackExtensions(dataDir: string, appId: string): Promise<void> {
  if (!configured(dataDir)) return;
  if (feedbackMaintenanceActive(dataDir)) return;
  const config = await readFeedbackExtensionConfig(dataDir);
  if (!config.presentations[appId] && !config.subscriptions?.some(item => item.appId === appId)) return;
  const extensions = await FeedbackExtensionStore.open(dataDir);
  try {
    const startedAt = extensions.activate(appId, new Date().toISOString());
    const storageConfig = await readFeedbackStorageConfig(dataDir);
    const source = await getSkillFeedbackStore(dataDir);
    await reconcileFeedbackSurfaces({
      appId, source, extensions, config, now: Date.now, startedAt,
      sourceKey: `${storageConfig.instanceId}:${storageConfig.generation}`,
      send: async (subjectId, card, operationId) => {
        const current = await readFeedbackExtensionConfig(dataDir);
        if (!current.presentations[appId]) throw new Error('feedback_presentation_disabled');
        const release = acquireFeedbackSendLease(dataDir);
        try { return await replyMessage(appId, subjectId, JSON.stringify(card), 'interactive', true, operationId); }
        finally { release(); }
      },
      answerUrl: async (messageId, chatId) => {
        const threadId = await getMessageThreadId(appId, messageId);
        return threadId ? threadAppLink(chatId, threadId, getBotBrand(appId)) : chatAppLink(chatId, getBotBrand(appId));
      },
      removeInline: async messageId => {
        const detail = await getMessageDetail(appId, messageId);
        const content = detail?.items?.[0]?.body?.content ?? detail?.body?.content;
        if (typeof content !== 'string') throw new Error('feedback_answer_unavailable');
        const card = JSON.parse(content);
        if (!Array.isArray(card.body?.elements)) throw new Error('feedback_answer_card_invalid');
        card.body.elements = card.body.elements.filter((element: { element_id?: string }) => !element.element_id?.startsWith('botmux_feedback'));
        await updateMessage(appId, messageId, JSON.stringify(card));
      },
    });
    for (const dirty of extensions.dirtySurfaces(appId)) {
      const binding = extensions.surface(appId, dirty.messageId);
      if (!binding) continue;
      const delivery = await source.findDeliveryById(String(binding.deliveryId));
      if (!delivery?.policy) continue;
      try {
        await updateMessage(appId, dirty.messageId, JSON.stringify(renderFeedbackCard(binding.card as Record<string, unknown>, delivery.policy, dirty.state)));
        extensions.clearDirtySurface(appId, dirty.messageId, dirty.revision);
      } catch {}
    }
    const currentConfig = await readFeedbackExtensionConfig(dataDir);
    const maximumTimeout = Math.max(1000, ...currentConfig.hooks.map(hook => hook.timeoutMs)) + 10000;
    const job = extensions.claim('hook', Date.now(), maximumTimeout, appId,
      Object.fromEntries(currentConfig.hooks.map(hook => [hook.id, hook.concurrency])));
    if (!job) return;
    const hookId = job.payload.hookId;
    const hook = currentConfig.hooks.find(item => item.id === hookId);
    if (!hook || job.payload.hookVersion !== hook.version || !hook.enabled) {
      extensions.settle(job.id, job.token!, 'blocked', { reason: 'hook_disabled_or_changed' });
      return;
    }
    const env: Record<string, string> = {};
    try {
      for (const [name, reference] of Object.entries(hook.envRefs)) {
        const path = join(dataDir, 'feedback-hook-secrets', reference);
        const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const info = fstatSync(descriptor);
          if (!info.isFile() || info.nlink !== 1 || info.size > 8192) throw new Error('unsafe_secret');
          env[name] = readFileSync(descriptor, 'utf8');
        } finally { closeSync(descriptor); }
      }
    } catch {
      extensions.settle(job.id, job.token!, 'failed_before_effect', { reason: 'hook_secret_unavailable' });
      return;
    }
    const outcome = await runFeedbackHook({ hook, event: job.payload.event as HookEvent, hostId: config.hostId, env });
    extensions.settle(job.id, job.token!, outcome.outcome, { ...outcome });
  } finally { extensions.close(); }
}

export async function handleFeedbackExtensionCard(input: unknown, appId: string, dataDir: string): Promise<any | undefined> {
  if (!configured(dataDir)) return undefined;
  const data = normalizeCardActionData(input);
  const messageId = data.context?.open_message_id;
  if (!messageId) return undefined;
  const extensions = await FeedbackExtensionStore.open(dataDir);
  try {
    const binding = extensions.surface(appId, messageId);
    if (!binding) return undefined;
    const source = await getSkillFeedbackStore(dataDir);
    if (data.action?.value?.action !== 'feedback_custom_action') {
      return handleSkillFeedbackCardAction(input, appId, { store: surfaceFeedbackStore(source, {
        appId, surfaceMessageId: messageId, answerMessageId: String(binding.answerMessageId), card: binding.card as Record<string, unknown>,
      }) });
    }
    const identity = await resolveCardOperatorUnionId(data, appId);
    const delivery = await source.findDeliveryByPlatformMessage('lark', appId, String(binding.answerMessageId));
    if (!delivery?.policy) return { toast: { type: 'error', content: '反馈目标已失效' } };
    let currentPolicy;
    try { currentPolicy = resolveFeedbackPolicyForDelivery({ dataDir, larkAppId: appId, chatId: String(binding.chatId), bot: getBot(appId).config }); }
    catch { return { toast: { type: 'error', content: '当前反馈配置不可用' } }; }
    if (!currentPolicy) return { toast: { type: 'error', content: '反馈功能已关闭' } };
    const candidates = [identity.openId?.startsWith('ou_') ? identity.openId : undefined,
      identity.unionId?.startsWith('on_') ? identity.unionId : undefined].filter((value): value is string => !!value);
    const allowed = delivery.policy.audience === 'everyone' ? candidates.length > 0
      : delivery.policy.audience === 'reviewers' ? candidates.some(value => delivery.policy!.reviewers.includes(value))
        : candidates.includes(delivery.requesterSubjectId ?? '');
    if (!allowed) return { toast: { type: 'error', content: '无权执行此动作' } };
    const actionId = data.action?.value?.action_id;
    const actions = binding.actions as Array<{ id: string; hookId: string }>;
    const action = actions.find(item => item.id === actionId);
    const config = await readFeedbackExtensionConfig(dataDir);
    const hook = config.hooks.find(item => item.id === action?.hookId);
    if (!action || !hook?.enabled || !hook.allowedBotAppIds.includes(appId)
      || !hook.allowedChatIds.includes(String(binding.chatId)) || !hook.allowedActionIds.includes(action.id)) {
      return { toast: { type: 'error', content: '动作未启用或已撤销' } };
    }
    const jobId = createHash('sha256').update(JSON.stringify([appId, binding.chatId, binding.subjectId, action.id])).digest('hex');
    const actor = candidates[0];
    const previous = extensions.job(jobId);
    if (previous?.status === 'failed_before_effect') {
      const retryToken = String(previous.result?.retryToken ?? '');
      if (data.action?.value?.retry_token === retryToken && retryToken) {
        extensions.retryBeforeEffect(jobId, retryToken, `${jobId}:${retryToken}`, actor);
      } else {
        const card = structuredClone(binding.card) as { body: { elements: any[] } };
        card.body.elements.push({ tag: 'button', text: { tag: 'plain_text', content: '确认重新请求（上次未执行）' },
          behaviors: [{ type: 'callback', value: { action: 'feedback_custom_action', action_id: action.id, retry_token: retryToken } }] });
        return { toast: { type: 'info', content: '上次未执行，请确认后重试' }, card: { type: 'raw', data: card } };
      }
    }
    const event: HookEvent = {
      schemaVersion: 1, eventId: jobId, executionId: jobId, idempotencyKey: jobId, type: 'action.requested',
      occurredAt: new Date().toISOString(), bot: { appId },
      scope: { chatId: String(binding.chatId), topicId: binding.subjectId, subjectId: binding.subjectId, sourceMessageId: binding.subjectId },
      answer: { answerGroupId: binding.answerId, deliveryId: binding.deliveryId, messageIds: binding.messageIds ?? [binding.answerMessageId], round: binding.round },
      surface: { messageId, templateId: binding.templateId }, actor: { openId: actor, appId },
      action: { id: action.id }, feedback: null, contextRef: null,
    };
    extensions.requestAction({
      requestId: createHash('sha256').update(JSON.stringify([jobId, actor, messageId])).digest('hex'),
      actor, job: { id: jobId, kind: 'hook', payload: { appId, hookId: hook.id, hookVersion: hook.version, event } },
    });
    const status = extensions.job(jobId)?.status;
    return { toast: { type: 'info', content: status === 'succeeded' ? '操作已完成' : status === 'unknown' ? '操作结果待核对，请勿重复执行' : '请求已记录' } };
  } finally { extensions.close(); }
}
