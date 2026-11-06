import { createHash } from 'node:crypto';
import type { CompatibleFeedbackStore } from './feedback-storage-types.js';
import type { FeedbackExtensionConfig } from './feedback-extension-config.js';
import { FeedbackExtensionStore, type ExtensionJobInput } from './feedback-extension-store.js';
import { resolveFeedbackPresentation } from './feedback-presentation.js';
import { buildFeedbackSurface } from './feedback-template.js';
import { feedbackAnswerGroups } from './feedback-answer-binding.js';
import { logger } from '../utils/logger.js';
import { feedbackRefreshBudget, refreshFeedbackMessage, type FeedbackRefreshBudget } from './feedback-refresh.js';

function identity(parts: unknown[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }

export async function reconcileFeedbackSurfaces(input: {
  appId: string; sourceKey: string; source: CompatibleFeedbackStore; extensions: FeedbackExtensionStore;
  config: FeedbackExtensionConfig; now: () => number;
  startedAt?: string;
  send: (subjectId: string, card: Record<string, unknown>, operationId: string, chatId: string, round: number) => Promise<string>;
  answerUrl: (messageId: string, chatId: string) => string | Promise<string>;
  removeInline: (messageId: string, signal?: AbortSignal) => Promise<void>;
  refreshBudget?: FeedbackRefreshBudget;
}): Promise<void> {
  const { extensions, source } = input;
  extensions.expire(input.now());
  const refreshBudget = input.refreshBudget ?? feedbackRefreshBudget();
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
          const state = {
            feedbackId: data.feedbackId, result: data.verdictKey, reasonKey: data.reasonKey, comment: data.comment,
          };
          extensions.dirtySurface(input.appId, surface.messageId, state);
          if (surface.binding.mode === 'both') extensions.dirtySurface(input.appId, feedbackDelivery.platformMessageId, state);
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
        const sourceDeliveries = await source.listSubjectDeliveries(input.appId, eventDelivery.chatId, eventDelivery.topicRootId);
        const sourceBinding = extensions.subject(input.appId, eventDelivery.sessionId ?? '', eventDelivery.turnId ?? '');
        const subjectId = sourceBinding?.sourceMessageId ?? eventDelivery.topicRootId;
        if (subjectId === eventDelivery.chatId) {
          entries.push({ sequence: entry.sequence, eventId: event.eventId, jobs });
          continue;
        }
        const groups = feedbackAnswerGroups(sourceDeliveries.filter(delivery => {
          const binding = extensions.subject(input.appId, delivery.sessionId ?? '', delivery.turnId ?? '');
          return (binding?.sourceMessageId ?? delivery.topicRootId) === subjectId && (!binding || binding.answerKind === 'substantive');
        }));
        for (const group of groups) {
          try {
          const { delivery, id: answerId, round } = group;
          if (!delivery.policy || !delivery.chatId || !delivery.topicRootId
            || (input.startedAt && delivery.createdAt < input.startedAt)) continue;
          const rule = resolveFeedbackPresentation(presentation, { botAppId: input.appId, chatId: delivery.chatId,
            sourceMessageId: subjectId, round });
          const layers = [['default', presentation.default] as const,
            ...presentation.rules.filter(item => rule.ruleIds.includes(item.id)).map(item => [item.id, item] as const)];
          const effectiveAt = layers.map(([key, value]) => input.config.ruleEffectiveAt?.[JSON.stringify([
            input.appId, key, createHash('sha256').update(JSON.stringify(value)).digest('hex'),
          ])]).filter((value): value is string => !!value).sort().at(-1)
            ?? input.config.presentationEffectiveAt?.[input.appId];
          if (effectiveAt && (delivery.completedAt ?? delivery.createdAt) < effectiveAt) continue;
          if (rule.matched && rule.mode !== 'inline') {
            const template = input.config.templates.find(item => item.id === rule.templateId);
            if (!template) throw new Error('feedback_template_not_found');
            const actions = input.config.actions.filter(action => rule.actionIds.includes(action.id));
            const answerUrl = await input.answerUrl(delivery.platformMessageId, delivery.chatId);
            const card = buildFeedbackSurface({ template, policy: delivery.policy, round,
              answerUrl, preview: false, actions });
            jobs.push({ id: identity(['surface', answerId]), kind: 'surface', payload: {
              appId: input.appId, subjectId, topicId: delivery.topicRootId, chatId: delivery.chatId, answerId,
              deliveryId: delivery.deliveryId, answerMessageId: delivery.platformMessageId, messageIds: group.messageIds, round, card, actions,
              mode: rule.mode, templateId: template.id, template, answerUrl,
            } });
          }
          } catch (error) {
            const reason = error instanceof Error && /^feedback_[a-z_]+$/.test(error.message) ? error.message : 'feedback_surface_prepare_failed';
            extensions.audit(`surface:${group.id}`, reason, input.now());
            logger.warn(`[feedback-extension] skipped answer=${group.id} reason=${reason}`);
          }
        }
      }
    }
    entries.push({ sequence: entry.sequence, eventId: event.eventId, jobs });
  }
  if (entries.length) extensions.ingest(cursorKey, cursor, entries);
  for (const messageId of extensions.inlineCleanups(input.appId)) {
    await refreshFeedbackMessage({ store: extensions, appId: input.appId, messageId, kind: 'cleanup', budget: refreshBudget,
      run: signal => input.removeInline(messageId, signal) });
  }
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
    const messageId = await input.send(payload.subjectId, payload.card, job.id.slice(0, 32), String(job.payload.chatId), Number(job.payload.round));
    if (!extensions.completeSurface(job.id, job.token!, messageId, input.now())) return;
    if (payload.mode === 'separate') {
      await refreshFeedbackMessage({ store: extensions, appId: input.appId, messageId: payload.answerMessageId,
        kind: 'cleanup', budget: refreshBudget, run: signal => input.removeInline(payload.answerMessageId, signal) });
    }
  } catch {
    extensions.settle(job.id, job.token!, 'unknown', { reason: 'surface_delivery_unknown' }, input.now());
  }
}
