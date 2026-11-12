import { createHash } from 'node:crypto';
import type { CompatibleFeedbackStore } from './feedback-storage-types.js';
import type { FeedbackExtensionConfig } from './feedback-extension-config.js';
import { FeedbackExtensionStore, type ExtensionJobInput } from './feedback-extension-store.js';
import { resolveFeedbackPresentation } from './feedback-presentation.js';
import { buildFeedbackSurface } from './feedback-template.js';
import { feedbackAnswerGroups } from './feedback-answer-binding.js';
import { logger } from '../utils/logger.js';
import { feedbackRefreshBudget, refreshFeedbackMessage, type FeedbackRefreshBudget } from './feedback-refresh.js';
import type { FeedbackSubjectBinding } from './feedback-context.js';

function identity(parts: unknown[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }

export async function reconcileFeedbackSurfaces(input: {
  appId: string; sourceKey: string; source: CompatibleFeedbackStore; extensions: FeedbackExtensionStore;
  config: FeedbackExtensionConfig; now: () => number;
  startedAt?: string;
  send: (subjectId: string, card: Record<string, unknown>, operationId: string, chatId: string, round: number,
    roundScope: 'subject' | 'topic', topicId: string) => Promise<string>;
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
  type Delivery = NonNullable<Awaited<ReturnType<CompatibleFeedbackStore['findDeliveryById']>>>;
  type AnswerGroups = ReturnType<typeof feedbackAnswerGroups>;
  const topics = new Map<string, Promise<{
    groups: AnswerGroups; subjects: Map<string, string>;
    contexts: Map<string, Record<string, unknown> | undefined>;
    topicRounds: Map<string, number>; subjectRounds: Map<string, number>;
  }>>();
  const answerUrls = new Map<string, Promise<string>>();
  const preparedJobs = new Set<string>();
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
        const binding = feedbackDelivery.context?.feedbackSubjectBinding as FeedbackSubjectBinding | null | undefined;
        const surfaceContext = extensions.surfaceContextForDelivery(input.appId, feedbackDelivery.deliveryId);
        const context = surfaceContext === undefined ? binding?.context ?? null : surfaceContext;
        const executionId = identity(['feedback-hook', event.eventId, subscription.id]);
        jobs.push({ id: executionId, kind: 'hook', payload: { appId: input.appId, hookId: hook.id, hookVersion: hook.version, event: {
          schemaVersion: 1, type: 'feedback.revised', eventId: event.eventId, executionId, idempotencyKey: executionId,
          occurredAt: event.time, bot: { appId: input.appId }, scope: { chatId: feedbackDelivery.chatId }, action: null,
          answer: { deliveryId: feedbackDelivery.deliveryId, messageIds: [feedbackDelivery.platformMessageId] },
          feedback: { feedbackId: data.feedbackId, revision: data.revision, buttonKey: data.verdictKey, semantic: data.semantic },
          actor: { subjectId: data.operatorSubjectId, appId: input.appId }, context, contextRef: null,
        } } });
      }
    }
    if (event.type === 'turn.completed' && data.botAppId === input.appId && data.status === 'completed'
      && typeof data.platformMessageId === 'string') {
      const eventDelivery = await source.findDeliveryByPlatformMessage('lark', input.appId, data.platformMessageId);
      const presentation = input.config.presentations[input.appId];
      if (eventDelivery?.chatId && eventDelivery.topicRootId && presentation) {
        const topicKey = JSON.stringify([eventDelivery.chatId, eventDelivery.topicRootId]);
        if (!topics.has(topicKey)) {
          topics.set(topicKey, (async () => {
            const sourceDeliveries = await source.listSubjectDeliveries(input.appId, eventDelivery.chatId!, eventDelivery.topicRootId!);
            const substantive: Delivery[] = [];
            const bySubject = new Map<string, Delivery[]>();
            const subjects = new Map<string, string>();
            const contexts = new Map<string, Record<string, unknown> | undefined>();
            for (const delivery of sourceDeliveries) {
              // The snapshot freezes only the context. Question and answer kind still
              // follow the turn's binding as before: a binding never changes once
              // written, so the two differ only when the same turn binds after its
              // answer was recorded, which must keep working.
              const snapshot = delivery.context?.feedbackSubjectBinding as FeedbackSubjectBinding | null | undefined;
              const binding = snapshot ?? extensions.subject(input.appId, delivery.sessionId ?? '', delivery.turnId ?? '');
              if (binding && binding.answerKind !== 'substantive') continue;
              const subject = binding?.sourceMessageId ?? delivery.topicRootId;
              if (!subject) continue;
              substantive.push(delivery);
              subjects.set(delivery.deliveryId, subject);
              contexts.set(delivery.deliveryId, snapshot?.context);
              const subjectDeliveries = bySubject.get(subject) ?? [];
              subjectDeliveries.push(delivery);
              bySubject.set(subject, subjectDeliveries);
            }
            const topicGroups = feedbackAnswerGroups(substantive);
            const groups = new Map(topicGroups.map(group => [group.id, group]));
            const subjectRounds = new Map<string, number>();
            for (const deliveries of bySubject.values()) {
              for (const group of feedbackAnswerGroups(deliveries)) {
                groups.set(group.id, group);
                subjectRounds.set(group.id, group.round);
              }
            }
            return { groups: [...groups.values()], subjects, contexts,
              topicRounds: new Map(topicGroups.map(group => [group.id, group.round])), subjectRounds };
          })());
        }
        const candidates = await topics.get(topicKey)!;
        for (const group of candidates.groups) {
          try {
          const { delivery, id: answerId } = group;
          const jobId = identity(['surface', answerId]);
          if (preparedJobs.has(jobId) || extensions.job(jobId)) continue;
          if (!delivery.policy || !delivery.chatId || !delivery.topicRootId
            || (input.startedAt && delivery.createdAt < input.startedAt)) continue;
          const answerSubjectId = candidates.subjects.get(delivery.deliveryId)!;
          if (answerSubjectId === delivery.chatId) continue;
          const topicRounds = resolveFeedbackPresentation(presentation, { botAppId: input.appId,
            chatId: delivery.chatId, sourceMessageId: answerSubjectId, round: 1 }).roundScope === 'topic'
            && delivery.topicRootId !== delivery.chatId;
          const round = (topicRounds ? candidates.topicRounds : candidates.subjectRounds).get(answerId);
          if (round === undefined) continue;
          const rule = resolveFeedbackPresentation(presentation, { botAppId: input.appId, chatId: delivery.chatId,
            sourceMessageId: answerSubjectId, round });
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
            const urlKey = JSON.stringify([delivery.chatId, delivery.platformMessageId]);
            if (!answerUrls.has(urlKey)) {
              answerUrls.set(urlKey, Promise.resolve().then(() => input.answerUrl(delivery.platformMessageId, delivery.chatId!))
                .catch(error => { answerUrls.delete(urlKey); throw error; }));
            }
            const answerUrl = await answerUrls.get(urlKey)!;
            const card = buildFeedbackSurface({ template, policy: delivery.policy, round,
              answerUrl, preview: false, actions });
            jobs.push({ id: jobId, kind: 'surface', payload: {
              appId: input.appId, subjectId: answerSubjectId, topicId: delivery.topicRootId, chatId: delivery.chatId, answerId,
              deliveryId: delivery.deliveryId, answerMessageId: delivery.platformMessageId, messageIds: group.messageIds, round, card, actions,
              context: candidates.contexts.get(delivery.deliveryId) ?? null,
              roundScope: topicRounds ? 'topic' : 'subject',
              mode: rule.mode, templateId: template.id, template, answerUrl,
            } });
            preparedJobs.add(jobId);
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
  const effective = current && resolveFeedbackPresentation(current, {
    botAppId: input.appId, chatId: String(job.payload.chatId), sourceMessageId: payload.subjectId, round: Number(job.payload.round),
  });
  const preparedScope = job.payload.roundScope === 'topic' ? 'topic' : 'subject';
  const currentScope = effective?.roundScope === 'topic' && job.payload.topicId !== job.payload.chatId ? 'topic' : 'subject';
  if (!effective?.matched || preparedScope !== currentScope) {
    extensions.settle(job.id, job.token!, 'blocked', {
      reason: effective?.matched ? 'presentation_scope_changed' : 'presentation_disabled',
    }, input.now());
    return;
  }
  try {
    const messageId = await input.send(payload.subjectId, payload.card, job.id.slice(0, 32), String(job.payload.chatId),
      Number(job.payload.round), preparedScope, String(job.payload.topicId ?? job.payload.chatId));
    if (!extensions.completeSurface(job.id, job.token!, messageId, input.now())) return;
    if (payload.mode === 'separate') {
      await refreshFeedbackMessage({ store: extensions, appId: input.appId, messageId: payload.answerMessageId,
        kind: 'cleanup', budget: refreshBudget, run: signal => input.removeInline(payload.answerMessageId, signal) });
    }
  } catch (error) {
    const staleScope = error instanceof Error && error.message === 'feedback_presentation_scope_changed';
    extensions.settle(job.id, job.token!, staleScope ? 'blocked' : 'unknown',
      { reason: staleScope ? 'presentation_scope_changed' : 'surface_delivery_unknown' }, input.now());
  }
}
