import { createHash } from 'node:crypto';
import type { CompatibleFeedbackStore } from './feedback-storage-types.js';
import type { FeedbackExtensionConfig } from './feedback-extension-config.js';
import { FeedbackExtensionStore, type ExtensionJobInput } from './feedback-extension-store.js';
import { resolveFeedbackPresentation } from './feedback-presentation.js';
import { buildFeedbackSurface } from './feedback-template.js';
import { feedbackAnswerGroups } from './feedback-answer-binding.js';

function identity(parts: unknown[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }

export async function reconcileFeedbackSurfaces(input: {
  appId: string; sourceKey: string; source: CompatibleFeedbackStore; extensions: FeedbackExtensionStore;
  config: FeedbackExtensionConfig; now: () => number;
  startedAt?: string;
  send: (subjectId: string, card: Record<string, unknown>, operationId: string) => Promise<string>;
  answerUrl: (messageId: string, chatId: string) => string;
  removeInline: (messageId: string) => Promise<void>;
}): Promise<void> {
  const { extensions, source } = input;
  const cursorKey = `${input.sourceKey}:${input.appId}`;
  const cursor = extensions.cursor(cursorKey);
  const events = await source.readFeedbackEventsAfter({ after: cursor, limit: 100 });
  const entries: Array<{ sequence: number; eventId: string; jobs: ExtensionJobInput[] }> = [];
  for (const entry of events) {
    const event = entry.event;
    const data = event.data;
    const jobs: ExtensionJobInput[] = [];
    if (event.type === 'feedback.revised' && typeof data.deliveryId === 'string'
      && (!input.startedAt || event.time >= input.startedAt)) {
      const feedbackDelivery = await source.findDeliveryById(data.deliveryId);
      if (feedbackDelivery?.botAppId === input.appId) {
        for (const surface of extensions.surfacesForDelivery(input.appId, feedbackDelivery.deliveryId)) {
          extensions.dirtySurface(input.appId, surface.messageId, {
            feedbackId: data.feedbackId, result: data.verdictKey, reasonKey: data.reasonKey, comment: data.comment,
          });
        }
      }
      for (const subscription of input.config.subscriptions ?? []) {
        if (feedbackDelivery?.botAppId !== input.appId || subscription.appId !== input.appId
          || subscription.chatId !== feedbackDelivery.chatId || subscription.buttonKey !== data.verdictKey) continue;
        const hook = input.config.hooks.find(item => item.id === subscription.hookId);
        if (!hook?.enabled) continue;
        const executionId = identity(['feedback-hook', event.eventId, subscription.id]);
        jobs.push({ id: executionId, kind: 'hook', payload: { appId: input.appId, hookId: hook.id, hookVersion: hook.version, event: {
          schemaVersion: 1, type: 'feedback.revised', eventId: event.eventId, executionId, idempotencyKey: executionId,
          occurredAt: event.time, bot: { appId: input.appId }, scope: { chatId: feedbackDelivery.chatId }, action: null,
          answer: { deliveryId: feedbackDelivery.deliveryId, messageIds: [feedbackDelivery.platformMessageId] },
          feedback: { feedbackId: data.feedbackId, revision: data.revision, buttonKey: data.verdictKey, semantic: data.semantic },
          actor: { subjectId: data.operatorSubjectId, appId: input.appId }, contextRef: null,
        } } });
      }
    }
    if (event.type === 'turn.completed' && data.botAppId === input.appId && data.status === 'completed'
      && typeof data.platformMessageId === 'string') {
      const eventDelivery = await source.findDeliveryByPlatformMessage('lark', input.appId, data.platformMessageId);
      const presentation = input.config.presentations[input.appId];
      if (eventDelivery?.chatId && eventDelivery.topicRootId && presentation) {
        const groups = feedbackAnswerGroups(await source.listSubjectDeliveries(input.appId, eventDelivery.chatId, eventDelivery.topicRootId));
        for (const group of groups) {
          const { delivery, id: answerId, round } = group;
          if (!delivery.policy || !delivery.chatId || !delivery.topicRootId
            || (input.startedAt && delivery.createdAt < input.startedAt)) continue;
          const effectiveAt = input.config.presentationEffectiveAt?.[input.appId];
          if (effectiveAt && (delivery.completedAt ?? delivery.createdAt) < effectiveAt) continue;
          const rule = resolveFeedbackPresentation(presentation, { botAppId: input.appId, chatId: delivery.chatId,
            sourceMessageId: delivery.topicRootId, round });
          if (rule.matched && rule.mode !== 'inline') {
            const template = input.config.templates.find(item => item.id === rule.templateId);
            if (!template) throw new Error('feedback_template_not_found');
            const actions = input.config.actions.filter(action => rule.actionIds.includes(action.id));
            const card = buildFeedbackSurface({ template, policy: delivery.policy, round,
              answerUrl: input.answerUrl(delivery.platformMessageId, delivery.chatId), preview: false, actions });
            jobs.push({ id: identity(['surface', answerId]), kind: 'surface', payload: {
              appId: input.appId, subjectId: delivery.topicRootId, chatId: delivery.chatId, answerId,
              deliveryId: delivery.deliveryId, answerMessageId: delivery.platformMessageId, messageIds: group.messageIds, round, card, actions,
              mode: rule.mode, templateId: template.id, template,
            } });
          }
        }
      }
    }
    entries.push({ sequence: entry.sequence, eventId: event.eventId, jobs });
  }
  if (entries.length) extensions.ingest(cursorKey, cursor, entries);
  extensions.expire(input.now());
  const job = extensions.claim('surface', input.now(), 60000, input.appId);
  if (!job) return;
  const payload = job.payload as {
    appId: string; subjectId: string; answerMessageId: string; card: Record<string, unknown>; mode: string;
  };
  if (payload.appId !== input.appId) {
    extensions.settle(job.id, job.token!, 'blocked', { reason: 'surface_bot_mismatch' }, input.now());
    return;
  }
  const current = input.config.presentations[input.appId];
  if (!current || !resolveFeedbackPresentation(current, {
    botAppId: input.appId, chatId: String(job.payload.chatId), sourceMessageId: payload.subjectId, round: Number(job.payload.round),
  }).matched) {
    extensions.settle(job.id, job.token!, 'blocked', { reason: 'presentation_disabled' }, input.now());
    return;
  }
  try {
    const messageId = await input.send(payload.subjectId, payload.card, job.id.slice(0, 32));
    extensions.bindSurface(input.appId, messageId, job.payload);
    extensions.settle(job.id, job.token!, 'succeeded', { messageId }, input.now());
    if (payload.mode === 'separate') await input.removeInline(payload.answerMessageId);
  } catch {
    extensions.settle(job.id, job.token!, 'unknown', { reason: 'surface_delivery_unknown' }, input.now());
  }
}
