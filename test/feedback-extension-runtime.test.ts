import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import { FeedbackExtensionStore } from '../src/services/feedback-extension-store.js';
import { reconcileFeedbackSurfaces } from '../src/services/feedback-extension-runtime.js';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';
import { normalizeFeedbackPresentation } from '../src/services/feedback-presentation.js';
import { defaultFeedbackTemplate } from '../src/services/feedback-template.js';
import { buildFeedbackElement } from '../src/im/lark/skill-feedback-card.js';
import { recordRelayedTurnDelivery } from '../src/core/relayed-turn-delivery.js';

describe('feedback surface event reconciliation', () => {
  it('marks both presentation surfaces dirty when a feedback revision is persisted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-both-'));
    const source = await SkillFeedbackStore.open(directory);
    const extensions = await FeedbackExtensionStore.open(directory);
    try {
      const policy = normalizeFeedbackPolicy({ enabled: true });
      const delivery = source.recordTurnDelivery({ botAppId: 'app', sessionId: 'session', turnId: 'turn', platform: 'lark',
        platformAppId: 'app', platformMessageId: 'answer', chatId: 'chat', topicRootId: 'question', content: 'answer',
        cardMode: 'feedback', status: 'delivered', policy });
      extensions.bindSurface('app', 'surface', { deliveryId: delivery.deliveryId, mode: 'both', answerMessageId: 'answer' });
      source.recordFeedback({ platform: 'lark', platformAppId: 'app', platformMessageId: 'answer', operatorSubjectId: 'ou_user',
        result: 'conclusive_usable', callbackKey: 'click' });
      await reconcileFeedbackSurfaces({ appId: 'app', sourceKey: 'source', source, extensions,
        config: { version: 1, hostId: 'host', templates: [], hooks: [], actions: [], presentations: {} },
        now: Date.now, send: async () => { throw new Error('unexpected send'); }, answerUrl: () => 'https://example.com', removeInline: async () => {} });
      expect(extensions.dirtySurfaces('app').map(item => item.messageId).sort()).toEqual(['answer', 'surface']);
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('keeps a successful receipt when inline cleanup fails and completes cleanup after configuration is disabled', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-disabled-cleanup-'));
    const source = await SkillFeedbackStore.open(directory);
    const extensions = await FeedbackExtensionStore.open(directory);
    try {
      extensions.ingest('source:app', 0, [{ sequence: 1, eventId: 'event', jobs: [{ id: 'job', kind: 'surface',
        payload: { appId: 'app', answerMessageId: 'answer', subjectId: 'question', mode: 'separate' } }] }]);
      const claim = extensions.claim('surface', 100, 1000)!;
      extensions.completeSurface('job', claim.token!, 'surface', 200);
      const cleaned: string[] = [];
      await reconcileFeedbackSurfaces({ appId: 'app', sourceKey: 'source', source, extensions,
        config: { version: 2, hostId: 'host', templates: [], hooks: [], actions: [], presentations: {} },
        now: () => 300, send: async () => { throw new Error('must not send'); }, answerUrl: () => 'https://example.com',
        removeInline: async messageId => { cleaned.push(messageId); } });
      expect(cleaned).toEqual(['answer']);
      expect(extensions.job('job')?.status).toBe('succeeded');
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('retries inline cleanup after a successful send without sending another surface', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-cleanup-'));
    const source = await SkillFeedbackStore.open(directory);
    let extensions = await FeedbackExtensionStore.open(directory);
    const clock = vi.spyOn(Date, 'now');
    let now = Date.now();
    clock.mockImplementation(() => now);
    try {
      const policy = normalizeFeedbackPolicy({ enabled: true });
      source.recordTurnDelivery({ botAppId: 'app', sessionId: 'session', turnId: 'turn', platform: 'lark',
        platformAppId: 'app', platformMessageId: 'answer', chatId: 'chat', topicRootId: 'question',
        content: 'answer', cardMode: 'feedback', status: 'delivered', policy,
        baseCard: { schema: '2.0', body: { elements: [buildFeedbackElement(policy)] } } });
      source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'turn', status: 'completed' });
      let sends = 0;
      let cleanupAttempts = 0;
      const dependencies = {
        appId: 'app', sourceKey: 'source', source,
        config: { version: 1, hostId: 'host', templates: [defaultFeedbackTemplate()], hooks: [], actions: [],
          presentations: { app: normalizeFeedbackPresentation({ default: { enabled: true, mode: 'separate' } }) } },
        now: Date.now, send: async () => { sends++; return 'surface'; }, answerUrl: () => 'https://example.com',
        removeInline: async () => { if (++cleanupAttempts === 1) throw new Error('temporary patch failure'); },
      };
      await reconcileFeedbackSurfaces({ ...dependencies, extensions });
      expect(extensions.inlineCleanups('app')).toEqual(['answer']);
      extensions.close();
      extensions = await FeedbackExtensionStore.open(directory);
      await reconcileFeedbackSurfaces({ ...dependencies, extensions });
      expect(cleanupAttempts).toBe(1);
      now += 6000;
      await reconcileFeedbackSurfaces({ ...dependencies, extensions });
      expect(sends).toBe(1);
      expect(cleanupAttempts).toBe(2);
      expect(extensions.inlineCleanups('app')).toEqual([]);
    } finally { clock.mockRestore(); extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('keeps a host-frozen feedback policy for a relayed answer and uses an explicit ordinary-chat question', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-relay-'));
    const source = await SkillFeedbackStore.open(directory);
    const extensions = await FeedbackExtensionStore.open(directory);
    const policy = normalizeFeedbackPolicy({ enabled: true, audience: 'requester' });
    try {
      const ds = { larkAppId: 'app', chatId: 'oc_chat', session: { sessionId: 'session', rootMessageId: 'oc_chat', status: 'active',
        cliId: 'claude-code' }, managedTurnOrigin: { turnId: 'turn', callerOpenId: 'ou_requester', capability: 'cap' } } as any;
      extensions.bindSubject('app', 'session', 'turn', { sourceMessageId: 'om_question', answerKind: 'substantive' });
      await recordRelayedTurnDelivery({ ds, body: { messageId: 'om_answer', content: 'answer',
        policy: { enabled: true, audience: 'everyone' }, requesterSubjectId: 'ou_intruder' },
        store: source, feedback: { policy, requesterSubjectId: 'ou_requester' } } as any);
      const delivery = source.findDeliveryByPlatformMessage('lark', 'app', 'om_answer')!;
      expect(delivery).toMatchObject({ cardMode: 'card', policy: { audience: 'requester' }, requesterSubjectId: 'ou_requester' });
      source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'turn', status: 'completed' });
      const sent: string[] = [];
      await reconcileFeedbackSurfaces({ appId: 'app', sourceKey: 'source', source, extensions,
        config: { version: 1, hostId: 'host', templates: [defaultFeedbackTemplate()], hooks: [], actions: [],
          presentations: { app: normalizeFeedbackPresentation({ default: { enabled: true, rounds: [1] } }) } },
        now: Date.now, send: async subject => { sent.push(subject); return 'om_surface'; },
        answerUrl: () => 'https://example.com/answer', removeInline: async () => {} });
      expect(sent).toEqual(['om_question']);
      expect(extensions.surface('app', 'om_surface')).toMatchObject({ subjectId: 'om_question', answerMessageId: 'om_answer' });
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('does not use a chat ID as an unbound question message', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-unbound-chat-'));
    const source = await SkillFeedbackStore.open(directory);
    const extensions = await FeedbackExtensionStore.open(directory);
    try {
      const policy = normalizeFeedbackPolicy({ enabled: true });
      source.recordTurnDelivery({ botAppId: 'app', sessionId: 'session', turnId: 'turn', platform: 'lark', platformAppId: 'app',
        platformMessageId: 'om_answer', chatId: 'oc_chat', topicRootId: 'oc_chat', content: 'answer', cardMode: 'feedback',
        status: 'delivered', policy, baseCard: { schema: '2.0', body: { elements: [buildFeedbackElement(policy)] } } });
      source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'turn', status: 'completed' });
      const sent: string[] = [];
      await reconcileFeedbackSurfaces({ appId: 'app', sourceKey: 'source', source, extensions,
        config: { version: 1, hostId: 'host', templates: [defaultFeedbackTemplate()], hooks: [], actions: [],
          presentations: { app: normalizeFeedbackPresentation({ default: { enabled: true } }) } },
        now: Date.now, send: async subject => { sent.push(subject); return 'om_surface'; },
        answerUrl: () => 'https://example.com', removeInline: async () => {} });
      expect(sent).toEqual([]);
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
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
