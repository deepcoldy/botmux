import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import { FeedbackExtensionStore } from '../src/services/feedback-extension-store.js';
import { reconcileFeedbackSurfaces } from '../src/services/feedback-extension-runtime.js';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';
import { normalizeFeedbackPresentation } from '../src/services/feedback-presentation.js';
import { defaultFeedbackTemplate } from '../src/services/feedback-template.js';
import { buildFeedbackElement } from '../src/im/lark/skill-feedback-card.js';

describe('feedback surface event reconciliation', () => {
  it('counts delivery order when terminal events arrive in reverse order and groups split answers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-order-'));
    const source = await SkillFeedbackStore.open(directory);
    const extensions = await FeedbackExtensionStore.open(directory);
    try {
      const policy = normalizeFeedbackPolicy({ enabled: true });
      for (const [turnId, messageId, createdAt] of [
        ['first', 'part-a', '2026-01-01T00:00:01Z'], ['first', 'part-b', '2026-01-01T00:00:02Z'],
        ['second', 'second', '2026-01-01T00:00:03Z'],
      ]) source.recordTurnDelivery({ botAppId: 'app', sessionId: 'session', turnId, platform: 'lark', platformAppId: 'app',
        platformMessageId: messageId, correlationDiscriminator: messageId, chatId: 'chat', topicRootId: 'question',
        createdAt, content: 'answer', cardMode: 'feedback', status: 'delivered', policy,
        baseCard: { schema: '2.0', body: { elements: [buildFeedbackElement(policy)] } } });
      source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'second', status: 'completed' });
      source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'first', status: 'completed' });
      let sends = 0;
      const dependencies = { appId: 'app', sourceKey: 'source', source, extensions,
        config: { version: 1, hostId: 'host', templates: [defaultFeedbackTemplate()], hooks: [], actions: [],
          presentations: { app: normalizeFeedbackPresentation({ default: { enabled: true, rounds: [1, 2] } }) } },
        now: Date.now, send: async () => `surface-${++sends}`, answerUrl: () => 'https://example.com', removeInline: async () => {} };
      await reconcileFeedbackSurfaces(dependencies);
      await reconcileFeedbackSurfaces(dependencies);
      expect(extensions.surface('app', 'surface-1')).toMatchObject({ round: 1, messageIds: ['part-a', 'part-b'] });
      expect(extensions.surface('app', 'surface-2')).toMatchObject({ round: 2, answerMessageId: 'second' });
      expect(sends).toBe(2);
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('does not replay historical feedback into a newly activated hook subscription', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-runtime-'));
    const source = await SkillFeedbackStore.open(directory);
    const extensions = await FeedbackExtensionStore.open(directory);
    try {
      const delivery = source.recordTurnDelivery({ botAppId: 'app', sessionId: 'session', turnId: 'one', platform: 'lark',
        platformAppId: 'app', platformMessageId: 'answer', chatId: 'chat', content: 'answer', cardMode: 'card', status: 'delivered' });
      expect(source.findDeliveryById(delivery.deliveryId)?.platformMessageId).toBe('answer');
      source.recordFeedback({ platform: 'lark', platformAppId: 'app', platformMessageId: 'answer', operatorSubjectId: 'operator', result: 'positive', callbackKey: 'old' });
      const future = '2099-01-01T00:00:00.000Z';
      await reconcileFeedbackSurfaces({ appId: 'app', sourceKey: 'source', source, extensions, startedAt: future,
        config: { version: 1, hostId: 'host', templates: [], hooks: [], actions: [], presentations: {}, subscriptions: [] },
        send: async () => { throw new Error('unexpected send'); }, answerUrl: () => 'https://example.com',
        removeInline: async () => {}, now: Date.now });
      expect(extensions.claim('hook', Date.now(), 1000)).toBeUndefined();
      expect(extensions.cursor('source:app')).toBeGreaterThan(0);
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('produces one separate feedback surface for the configured round and binds it to the answer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-runtime-'));
    const source = await SkillFeedbackStore.open(directory);
    const extensions = await FeedbackExtensionStore.open(directory);
    const policy = normalizeFeedbackPolicy({ enabled: true })!;
    const config = { version: 1, hostId: 'host', templates: [defaultFeedbackTemplate()], hooks: [], actions: [],
      presentations: { app: normalizeFeedbackPresentation({ default: { enabled: true, rounds: [1], templateId: 'default', mode: 'separate' } }) } };
    let sends = 0;
    const dependencies = { appId: 'app', sourceKey: 'source', source, extensions, config,
      send: async () => { sends++; return 'surface'; }, answerUrl: () => 'https://example.com/answer',
      removeInline: async () => {}, now: () => 1000 };
    try {
      for (const turn of ['one', 'two']) {
        source.recordTurnDelivery({ botAppId: 'app', sessionId: 'session', turnId: turn, platform: 'lark', platformAppId: 'app',
          chatId: 'chat', topicRootId: 'question', platformMessageId: turn, content: 'answer', status: 'delivered', cardMode: 'feedback', policy,
          baseCard: { schema: '2.0', body: { elements: [buildFeedbackElement(policy)] } } });
        source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: turn, status: 'completed' });
      }
      await reconcileFeedbackSurfaces(dependencies);
      await reconcileFeedbackSurfaces(dependencies);
      expect(sends).toBe(1);
      expect(extensions.surface('app', 'surface')).toMatchObject({ answerMessageId: 'one', subjectId: 'question', round: 1 });
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
