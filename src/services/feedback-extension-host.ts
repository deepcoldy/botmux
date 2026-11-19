import { existsSync, readFileSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FeedbackExtensionStore } from './feedback-extension-store.js';
import { readFeedbackExtensionConfig, type FeedbackExtensionConfig } from './feedback-extension-config.js';
import { readFeedbackStorageConfig } from './feedback-storage-config.js';
import { getSkillFeedbackStore } from './skill-feedback-store.js';
import { reconcileFeedbackSurfaces } from './feedback-extension-runtime.js';
import { runFeedbackHook, type HookEvent } from './feedback-hook-runner.js';
import { getBotBrand, getBot } from '../bot-registry.js';
import { resolveFeedbackPolicyForDelivery } from './feedback-policy-resolver.js';
import { chatAppLink, threadAppLink } from '../im/lark/lark-hosts.js';
import { getMessageDetail, getMessageThreadId, getChatModeStrict, replyMessage, updateMessage } from '../im/lark/client.js';
import { normalizeCardActionData } from '../im/lark/card-action-data.js';
import { resolveCardOperatorUnionId } from '../im/lark/card-handler.js';
import { handleSkillFeedbackCardAction, renderFeedbackCard } from '../im/lark/skill-feedback-card.js';
import { surfaceFeedbackStore, renderFeedbackSurfaceState } from './feedback-surface-delivery.js';
import { feedbackMaintenanceActive, acquireFeedbackSendLease } from './feedback-maintenance.js';
import { resolveFeedbackPresentation } from './feedback-presentation.js';
import { normalizeFeedbackContext } from './feedback-context.js';
import { feedbackRefreshBudget, refreshFeedbackMessage } from './feedback-refresh.js';
import type { FeedbackHookRegistration } from './feedback-extension-types.js';

function configured(dataDir: string): boolean { return existsSync(join(dataDir, 'feedback-extensions.json')); }
async function removeInlineFeedback(dataDir: string, appId: string, messageId: string, signal?: AbortSignal): Promise<void> {
  const detail = await getMessageDetail(appId, messageId, { signal });
  const content = detail?.items?.[0]?.body?.content ?? detail?.body?.content;
  if (typeof content !== 'string') throw new Error('feedback_refresh_target_missing');
  const card = JSON.parse(content);
  if (!Array.isArray(card.body?.elements)) throw new Error('feedback_answer_card_invalid');
  card.body.elements = card.body.elements.filter((element: { element_id?: string }) => !element.element_id?.startsWith('botmux_feedback'));
  await updateMessage(appId, messageId, JSON.stringify(card), { beforeWrite: async () => {
    signal?.throwIfAborted();
    if (!configured(dataDir) && !getBot(appId).config.feedbackPresentation) throw new Error('feedback_presentation_disabled');
  } });
}
function hookDefinition(hook: FeedbackHookRegistration): Record<string, unknown> {
  const { enabled, version, ...definition } = hook;
  return definition;
}
export function pendingFeedbackHookAuthorized(config: FeedbackExtensionConfig, hookId: string, event: {
  type: string; bot: { appId: string }; scope: { chatId: string; subjectId?: unknown };
  feedback?: { buttonKey?: string }; action: { id: string } | null; answer?: { round?: number };
}): boolean {
  if (event.type === 'feedback.revised') return !!config.subscriptions?.some(subscription =>
    subscription.appId === event.bot.appId && subscription.chatId === event.scope.chatId
    && subscription.hookId === hookId && subscription.buttonKey === event.feedback?.buttonKey);
  if (!event.action || !config.actions.some(action => action.id === event.action!.id && action.hookId === hookId)) return false;
  const presentation = config.presentations[event.bot.appId];
  if (!presentation) return false;
  const effective = resolveFeedbackPresentation(presentation, { botAppId: event.bot.appId, chatId: event.scope.chatId,
    sourceMessageId: String(event.scope.subjectId ?? ''), round: event.answer?.round ?? 1 });
  return effective.matched && effective.actionIds.includes(event.action.id);
}
export async function sendFeedbackSurface(appId: string, input: {
  chatId: string; subjectId: string; card: Record<string, unknown>; operationId: string;
  beforeWrite?: () => Promise<void>;
}): Promise<string> {
  const detail = await getMessageDetail(appId, input.subjectId, { userCardContent: false });
  if ((detail?.items?.[0] ?? detail)?.chat_id !== input.chatId) throw new Error('feedback_surface_wrong_chat');
  const mode = await getChatModeStrict(appId, input.chatId);
  if (mode === 'unknown') throw new Error('feedback_surface_chat_mode_unknown');
  if (!input.beforeWrite) return replyMessage(appId, input.subjectId, JSON.stringify(input.card), 'interactive', mode === 'topic', input.operationId);
  return replyMessage(appId, input.subjectId, JSON.stringify(input.card), 'interactive', mode === 'topic', input.operationId,
    undefined, { beforeWrite: input.beforeWrite });
}
export async function tickFeedbackExtensions(dataDir: string, appId: string, lane: 'all' | 'surface' | 'background' = 'all'): Promise<void> {
  const botPresentation = getBot(appId).config.feedbackPresentation;
  if (!configured(dataDir) && !botPresentation) {
    if (existsSync(join(dataDir, 'feedback-extensions.sqlite')) && !feedbackMaintenanceActive(dataDir)) {
      const extensions = await FeedbackExtensionStore.open(dataDir);
      try { extensions.expire(Date.now()); } finally { extensions.close(); }
    }
    return;
  }
  if (feedbackMaintenanceActive(dataDir)) return;
  const config = await readFeedbackExtensionConfig(dataDir);
  if (!config.presentations[appId] && botPresentation) config.presentations[appId] = botPresentation;
  const extensions = await FeedbackExtensionStore.open(dataDir);
  try {
    extensions.expire(Date.now());
    const refreshBudget = feedbackRefreshBudget();
    const startedAt = extensions.activate(appId, new Date().toISOString());
    const storageConfig = await readFeedbackStorageConfig(dataDir);
    const source = await getSkillFeedbackStore(dataDir);
    if (lane !== 'background') await reconcileFeedbackSurfaces({
      appId, source, extensions, config, now: Date.now, startedAt,
      refreshBudget: lane === 'surface' ? { deadline: 0, remaining: 0 } : refreshBudget,
      sourceKey: `${storageConfig.instanceId}:${storageConfig.generation}`,
      send: async (subjectId, card, operationId, chatId, round, roundScope, topicId) => {
        let beforeWriteAttempts = 0;
        const beforeWrite = async () => {
          const attempt = beforeWriteAttempts++;
          const current = await readFeedbackExtensionConfig(dataDir);
          const bot = getBot(appId).config;
          const presentation = current.presentations[appId] ?? bot.feedbackPresentation;
          const effective = presentation && resolveFeedbackPresentation(presentation, { botAppId: appId, chatId, sourceMessageId: subjectId, round });
          const currentScope = effective?.roundScope === 'topic' && topicId !== chatId ? 'topic' : 'subject';
          if (currentScope !== roundScope) {
            // 网关重试时重跑本回调：首发可能已在飞书落地只是响应丢失，此时落
            // unknown 才能走 reconcileSurfaceReceipt 人工核对补绑；只有第一次
            // 尝试（确认尚未发出过）才直接 blocked。
            if (attempt === 0) throw new Error('feedback_presentation_scope_changed');
            throw new Error('feedback_presentation_scope_changed_during_retry');
          }
          if (!presentation || !effective?.matched
            || !resolveFeedbackPolicyForDelivery({ dataDir, larkAppId: appId, chatId, bot })) throw new Error('feedback_presentation_disabled');
        };
        const release = acquireFeedbackSendLease(dataDir);
        try { return await sendFeedbackSurface(appId, { subjectId, card, operationId, chatId, beforeWrite }); }
        finally { release(); }
      },
      answerUrl: async (messageId, chatId) => {
        const threadId = await getMessageThreadId(appId, messageId);
        return threadId ? threadAppLink(chatId, threadId, getBotBrand(appId)) : chatAppLink(chatId, getBotBrand(appId));
      },
      removeInline: (messageId, signal) => removeInlineFeedback(dataDir, appId, messageId, signal),
    });
    if (lane === 'surface') return;
    if (lane === 'background') {
      for (const messageId of extensions.inlineCleanups(appId)) {
        await refreshFeedbackMessage({ store: extensions, appId, messageId, kind: 'cleanup', budget: refreshBudget,
          run: signal => removeInlineFeedback(dataDir, appId, messageId, signal) });
      }
    }
    for (const dirty of extensions.dirtySurfaces(appId)) {
      if (refreshBudget.remaining <= 0 || Date.now() >= refreshBudget.deadline) break;
      if (!extensions.refreshDue(appId, dirty.messageId, 'dirty', Date.now())) continue;
      const binding = extensions.surface(appId, dirty.messageId);
      if (!binding) {
        await refreshFeedbackMessage({ store: extensions, appId, messageId: dirty.messageId, kind: 'dirty',
          revision: dirty.revision, budget: refreshBudget, run: async signal => {
          const original = await source.findDeliveryByPlatformMessage('lark', appId, dirty.messageId);
          signal.throwIfAborted();
          if (!original?.policy) throw new Error('feedback_refresh_target_missing');
          const detail = await getMessageDetail(appId, dirty.messageId, { signal });
          const content = detail?.items?.[0]?.body?.content ?? detail?.body?.content;
          if (typeof content !== 'string') throw new Error('feedback_refresh_target_missing');
          const card = renderFeedbackCard(JSON.parse(content), original.policy, dirty.state);
          await updateMessage(appId, dirty.messageId, JSON.stringify(card), { beforeWrite: async () => {
            signal.throwIfAborted();
            if (!configured(dataDir) && !getBot(appId).config.feedbackPresentation) throw new Error('feedback_presentation_disabled');
          } });
        } });
        continue;
      }
      await refreshFeedbackMessage({ store: extensions, appId, messageId: dirty.messageId, kind: 'dirty',
        revision: dirty.revision, budget: refreshBudget, run: async signal => {
          const delivery = await source.findDeliveryById(String(binding.deliveryId));
          signal.throwIfAborted();
          if (!delivery?.policy) throw new Error('feedback_refresh_target_missing');
          await updateMessage(appId, dirty.messageId, JSON.stringify(renderFeedbackSurfaceState(binding, delivery.policy, dirty.state)), {
            beforeWrite: async () => {
              signal.throwIfAborted();
              if (!configured(dataDir) && !getBot(appId).config.feedbackPresentation) throw new Error('feedback_presentation_disabled');
            },
          });
        } });
    }
    const currentConfig = await readFeedbackExtensionConfig(dataDir);
    // The bot-config presentation is functionally equivalent to one stored in
    // the extension file (it was already overlaid on `config` for surface
    // reconciliation above): the hook authorization fence must read the same
    // merged view, otherwise a card sent from a bot-config rule renders and
    // accepts clicks while every hook job is settled `blocked`.
    const currentBotPresentation = getBot(appId).config.feedbackPresentation;
    if (!currentConfig.presentations[appId] && currentBotPresentation) currentConfig.presentations[appId] = currentBotPresentation;
    const maximumTimeout = Math.max(1000, ...currentConfig.hooks.map(hook => hook.timeoutMs)) + 10000;
    const job = extensions.claim('hook', Date.now(), maximumTimeout, appId,
      Object.fromEntries(currentConfig.hooks.map(hook => [hook.id, hook.concurrency])));
    if (!job) return;
    const hookId = job.payload.hookId;
    const hook = currentConfig.hooks.find(item => item.id === hookId);
    const event = job.payload.event as HookEvent;
    if (!hook || job.payload.hookVersion !== hook.version || !hook.enabled
      || !pendingFeedbackHookAuthorized(currentConfig, hook.id, event as Parameters<typeof pendingFeedbackHookAuthorized>[2])) {
      const sameDefinition = !!hook && (job.payload.hookDefinition
        ? JSON.stringify(job.payload.hookDefinition) === JSON.stringify(hookDefinition(hook))
        : job.payload.hookVersion === hook.version);
      const recoverable = !!hook && sameDefinition && !hook.enabled
        && pendingFeedbackHookAuthorized(currentConfig, hook.id, event as Parameters<typeof pendingFeedbackHookAuthorized>[2]);
      extensions.settle(job.id, job.token!, 'blocked', { reason: 'hook_disabled_or_changed', recoverable });
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
  if (!configured(dataDir) && !existsSync(join(dataDir, 'feedback-extensions.sqlite'))) return undefined;
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
      }), renderCard: (policy, state) => renderFeedbackSurfaceState(binding, policy, state) });
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
    if (!action || !hook || !hook.allowedBotAppIds.includes(appId)
      || !hook.allowedChatIds.includes(String(binding.chatId)) || !hook.allowedActionIds.includes(action.id)) {
      return { toast: { type: 'error', content: '动作未启用或已撤销' } };
    }
    const jobId = createHash('sha256').update(JSON.stringify([appId, binding.chatId, binding.subjectId, action.id])).digest('hex');
    const actor = candidates[0];
    const previous = extensions.job(jobId);
    if (previous?.status === 'blocked' && (previous.result?.recoverable !== true
      || previous.payload.hookDefinition && JSON.stringify(previous.payload.hookDefinition) !== JSON.stringify(hookDefinition(hook)))) {
      return { toast: { type: 'error', content: '动作已撤销，不能重新执行' } };
    }
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
      action: { id: action.id }, feedback: null,
      context: binding.context === null ? null : normalizeFeedbackContext(binding.context) ?? null, contextRef: null,
    };
    extensions.requestAction({
      requestId: createHash('sha256').update(JSON.stringify([jobId, actor, messageId])).digest('hex'),
      paused: !hook.enabled,
      actor, job: { id: jobId, kind: 'hook', payload: { appId, hookId: hook.id, hookVersion: hook.version, hookDefinition: hookDefinition(hook), event } },
    });
    if (!hook.enabled) {
      return { toast: { type: 'error', content: '动作已暂停，重新启用后请再次点击' } };
    }
    const status = extensions.job(jobId)?.status;
    return { toast: { type: status === 'blocked' ? 'error' : 'info', content: status === 'blocked' ? '操作被阻止' : status === 'succeeded' ? '操作已完成' : status === 'unknown' ? '操作结果待核对，请勿重复执行' : '请求已记录' } };
  } finally { extensions.close(); }
}
