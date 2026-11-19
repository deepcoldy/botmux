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
  it('retries a transient failed URL preparation rather than retaining its rejected batch cache', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-url-retry-'));
    const source = await SkillFeedbackStore.open(directory);
    let extensions = await FeedbackExtensionStore.open(directory);
    try {
      for (const turnId of ['first', 'second']) {
        extensions.bindSubject('app', 'session', turnId, { sourceMessageId: `question-${turnId}`, answerKind: 'substantive' });
        source.recordTurnDelivery({ botAppId: 'app', sessionId: 'session', turnId, platform: 'lark',
          platformAppId: 'app', platformMessageId: turnId, chatId: 'chat', topicRootId: 'topic',
          content: 'answer', cardMode: 'feedback', status: 'delivered', policy: normalizeFeedbackPolicy({ enabled: true }) });
        source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId, status: 'completed' });
      }
      let firstReads = 0, secondReads = 0, sends = 0;
      const dependencies = { appId: 'app', sourceKey: 'source', source, now: Date.now,
        send: async () => `surface-${++sends}`, answerUrl: (messageId: string) => {
          if (messageId === 'first' && ++firstReads === 1) throw new Error('transient lookup failure');
          if (messageId === 'second') secondReads++;
          return 'https://example.com/answer';
        }, removeInline: async () => {},
        config: { version: 1, hostId: 'host', templates: [defaultFeedbackTemplate()], hooks: [], actions: [],
          presentations: { app: normalizeFeedbackPresentation({ default: { enabled: true, rounds: [1] } }) } } };
      await reconcileFeedbackSurfaces({ ...dependencies, extensions });
      expect(firstReads).toBe(2);
      expect(secondReads).toBe(1);
      expect(extensions.jobsForApp('app').map(job => job.payload.answerMessageId).sort()).toEqual(['first', 'second']);
      extensions.close();
      extensions = await FeedbackExtensionStore.open(directory);
      await reconcileFeedbackSurfaces({ ...dependencies, extensions });
      expect(sends).toBe(2);
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it.each([8, 16])('prepares each answer once in a backlog of %s independent subjects', async count => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-backlog-'));
    const source = await SkillFeedbackStore.open(directory);
    const extensions = await FeedbackExtensionStore.open(directory);
    try {
      const policy = normalizeFeedbackPolicy({ enabled: true });
      for (let index = 0; index < count; index++) {
        const turnId = `turn-${index}`;
        extensions.bindSubject('app', 'session', turnId, { sourceMessageId: `question-${index}`, answerKind: 'substantive' });
        source.recordTurnDelivery({ botAppId: 'app', sessionId: 'session', turnId, platform: 'lark',
          platformAppId: 'app', platformMessageId: `answer-${index}`, chatId: 'chat', topicRootId: 'topic',
          content: 'answer', cardMode: 'feedback', status: 'delivered', policy });
        source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId, status: 'completed' });
      }
      const bindings = vi.spyOn(extensions, 'subject');
      const reads = vi.spyOn(source, 'listSubjectDeliveries');
      const ingests = vi.spyOn(extensions, 'ingest');
      let urlCalls = 0, sends = 0;
      const dependencies = { appId: 'app', sourceKey: 'source', source, extensions, now: Date.now,
        send: async () => `surface-${++sends}`, answerUrl: () => { urlCalls++; return 'https://example.com/answer'; },
        removeInline: async () => {},
        config: { version: 1, hostId: 'host', templates: [defaultFeedbackTemplate()], hooks: [], actions: [],
          presentations: { app: normalizeFeedbackPresentation({ default: { enabled: true, rounds: [1] } }) } },
      };
      await reconcileFeedbackSurfaces(dependencies);
      expect(urlCalls).toBe(count);
      expect(bindings.mock.calls.length).toBeLessThanOrEqual(count * 2);
      expect(reads.mock.calls.length).toBe(1);
      expect(ingests.mock.calls[0][2].flatMap(entry => entry.jobs)).toHaveLength(count);
      const next = `turn-${count}`;
      extensions.bindSubject('app', 'session', next, { sourceMessageId: `question-${count}`, answerKind: 'substantive' });
      source.recordTurnDelivery({ botAppId: 'app', sessionId: 'session', turnId: next, platform: 'lark',
        platformAppId: 'app', platformMessageId: 'next-answer', chatId: 'chat', topicRootId: 'topic',
        content: 'next', cardMode: 'feedback', status: 'delivered', policy });
      source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: next, status: 'completed' });
      await reconcileFeedbackSurfaces(dependencies);
      expect(urlCalls).toBe(count + 1);
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it.each([true, false])('records the actual block reason for a queued scope change (enabled=%s)', async enabled => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-claim-scope-'));
    const source = await SkillFeedbackStore.open(directory);
    const extensions = await FeedbackExtensionStore.open(directory);
    try {
      extensions.ingest('source:app', 0, [{ sequence: 1, eventId: 'old', jobs: [{ id: 'job', kind: 'surface',
        payload: { appId: 'app', chatId: 'chat', topicId: 'topic', subjectId: 'question', round: 1, roundScope: 'subject' } }] }]);
      await reconcileFeedbackSurfaces({ appId: 'app', sourceKey: 'source', source, extensions, now: Date.now,
        send: async () => { throw new Error('must not send stale job'); }, answerUrl: () => 'https://example.com',
        removeInline: async () => {},
        config: { version: 1, hostId: 'host', templates: [defaultFeedbackTemplate()], hooks: [], actions: [],
          presentations: { app: normalizeFeedbackPresentation({ default: { enabled, rounds: [1], roundScope: 'topic' } }) } } });
      expect(extensions.job('job')).toMatchObject({ status: 'blocked', result: {
        reason: enabled ? 'presentation_scope_changed' : 'presentation_disabled',
      } });
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('treats a legacy queued surface without roundScope in its payload as subject scope', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-legacy-scope-'));
    const source = await SkillFeedbackStore.open(directory);
    const extensions = await FeedbackExtensionStore.open(directory);
    try {
      extensions.ingest('source:app', 0, [{ sequence: 1, eventId: 'old', jobs: [{ id: 'legacy-job', kind: 'surface',
        payload: { appId: 'app', chatId: 'chat', topicId: 'topic', subjectId: 'question', round: 1, mode: 'separate',
          answerMessageId: 'answer', card: {} } }] }]);
      let sends = 0;
      await reconcileFeedbackSurfaces({ appId: 'app', sourceKey: 'source', source, extensions, now: Date.now,
        send: async () => { sends++; return 'legacy-surface'; }, answerUrl: () => 'https://example.com',
        removeInline: async () => {},
        config: { version: 1, hostId: 'host', templates: [defaultFeedbackTemplate()], hooks: [], actions: [],
          presentations: { app: normalizeFeedbackPresentation({ default: { enabled: true, rounds: [1] } }) } } });
      expect(sends).toBe(1);
      expect(extensions.job('legacy-job')?.status).toBe('succeeded');
      expect(extensions.surface('app', 'legacy-surface')?.answerMessageId).toBe('answer');
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it.each([true, false])('keeps unfinished answers ahead of later answers in native topic scope (bound=%s)', async bound => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-topic-pending-'));
    const source = await SkillFeedbackStore.open(directory);
    const extensions = await FeedbackExtensionStore.open(directory);
    try {
      for (const turnId of ['unfinished', 'completed']) {
        if (bound) extensions.bindSubject('app', 'session', turnId, { sourceMessageId: `question-${turnId}`, answerKind: 'substantive' });
        source.recordTurnDelivery({ botAppId: 'app', sessionId: 'session', turnId, platform: 'lark',
          platformAppId: 'app', platformMessageId: turnId, chatId: 'chat', topicRootId: 'topic',
          content: 'answer', cardMode: 'feedback', status: 'delivered', policy: normalizeFeedbackPolicy({ enabled: true }) });
      }
      source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'completed', status: 'completed' });
      let sends = 0;
      const dependencies = { appId: 'app', sourceKey: 'source', source, extensions, now: Date.now,
        send: async () => `surface-${++sends}`, answerUrl: () => 'https://example.com', removeInline: async () => {},
        config: { version: 1, hostId: 'host', templates: [defaultFeedbackTemplate()], hooks: [], actions: [],
          presentations: { app: normalizeFeedbackPresentation({ default: { enabled: true, rounds: [1], roundScope: 'topic' } }) } } };
      await reconcileFeedbackSurfaces(dependencies);
      expect(sends).toBe(0);
      source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'unfinished', status: 'completed' });
      await reconcileFeedbackSurfaces(dependencies);
      expect(sends).toBe(1);
      expect(extensions.surface('app', 'surface-1')).toMatchObject({ answerMessageId: 'unfinished', round: 1 });
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it.each([false, true])('does not block independent subjects behind an unfinished answer (ordinary=%s)', async ordinary => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-independent-subject-'));
    const source = await SkillFeedbackStore.open(directory);
    const extensions = await FeedbackExtensionStore.open(directory);
    try {
      for (const [turnId, sourceMessageId] of [['unfinished', 'question-a'], ['completed', 'question-b']]) {
        extensions.bindSubject('app', 'session', turnId, { sourceMessageId, answerKind: 'substantive' });
        source.recordTurnDelivery({ botAppId: 'app', sessionId: 'session', turnId, platform: 'lark',
          platformAppId: 'app', platformMessageId: turnId, chatId: 'chat', topicRootId: ordinary ? 'chat' : 'topic',
          content: 'answer', cardMode: 'feedback', status: 'delivered', policy: normalizeFeedbackPolicy({ enabled: true }) });
      }
      source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'completed', status: 'completed' });
      const subjects: string[] = [];
      await reconcileFeedbackSurfaces({ appId: 'app', sourceKey: 'source', source, extensions, now: Date.now,
        send: async subject => { subjects.push(subject); return 'surface'; }, answerUrl: () => 'https://example.com',
        removeInline: async () => {},
        config: { version: 1, hostId: 'host', templates: [defaultFeedbackTemplate()], hooks: [], actions: [],
          presentations: { app: normalizeFeedbackPresentation({ default: { enabled: true, rounds: [1],
            ...(ordinary ? { roundScope: 'topic' } : {}) } }) } } });
      expect(subjects).toEqual(['question-b']);
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('uses each answer rule counting scope when a question overrides its topic default', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-mixed-scope-'));
    const source = await SkillFeedbackStore.open(directory);
    const extensions = await FeedbackExtensionStore.open(directory);
    const policy = normalizeFeedbackPolicy({ enabled: true });
    try {
      for (const [turnId, sourceMessageId] of [['first', 'question'], ['second', 'followup-question']]) {
        extensions.bindSubject('app', 'session', turnId, { sourceMessageId, answerKind: 'substantive' });
        source.recordTurnDelivery({ botAppId: 'app', sessionId: 'session', turnId, platform: 'lark',
          platformAppId: 'app', platformMessageId: turnId, chatId: 'chat', topicRootId: 'question',
          content: 'answer', cardMode: 'feedback', status: 'delivered', policy });
        source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId, status: 'completed' });
      }
      let sends = 0;
        const dependencies = { appId: 'app', sourceKey: 'source', source, extensions, now: Date.now,
        send: async () => `surface-${++sends}`, answerUrl: () => 'https://example.com/answer', removeInline: async () => {},
        config: { version: 1, hostId: 'host', templates: [defaultFeedbackTemplate()], hooks: [], actions: [],
          presentations: { app: normalizeFeedbackPresentation({ default: { enabled: true, rounds: [1, 2], roundScope: 'topic' },
            rules: [{ id: 'question', match: { chatId: 'chat', sourceMessageId: 'followup-question' }, roundScope: 'subject' }] }) } },
      };
      await reconcileFeedbackSurfaces(dependencies);
      await reconcileFeedbackSurfaces(dependencies);
      expect(sends).toBe(2);
      expect(extensions.surface('app', 'surface-2')).toMatchObject({
        answerMessageId: 'second', subjectId: 'followup-question', round: 1,
      });
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
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
      const context = { kind: 'classification', category: 42 };
      extensions.bindSubject('app', 'session', 'turn', { sourceMessageId: 'om_question', answerKind: 'substantive', context });
      await recordRelayedTurnDelivery({ ds, body: { messageId: 'om_answer', content: 'answer',
        policy: { enabled: true, audience: 'everyone' }, requesterSubjectId: 'ou_intruder' },
        store: source, feedback: { policy, requesterSubjectId: 'ou_requester' } } as any);
      const delivery = source.findDeliveryByPlatformMessage('lark', 'app', 'om_answer')!;
      expect(delivery).toMatchObject({ cardMode: 'card', policy: { audience: 'requester' }, requesterSubjectId: 'ou_requester' });
      expect(delivery.context?.feedbackSubjectBinding).toEqual({
        sourceMessageId: 'om_question', answerKind: 'substantive', context,
      });
      source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'turn', status: 'completed' });
      const sent: string[] = [];
      await reconcileFeedbackSurfaces({ appId: 'app', sourceKey: 'source', source, extensions,
        config: { version: 1, hostId: 'host', templates: [defaultFeedbackTemplate()], hooks: [], actions: [],
          presentations: { app: normalizeFeedbackPresentation({ default: { enabled: true, rounds: [1] } }) } },
        now: Date.now, send: async subject => { sent.push(subject); return 'om_surface'; },
        answerUrl: () => 'https://example.com/answer', removeInline: async () => {} });
      expect(sent).toEqual(['om_question']);
      expect(extensions.surface('app', 'om_surface')).toMatchObject({
        subjectId: 'om_question', answerMessageId: 'om_answer', context,
      });
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it.each(['substantive', 'clarification'] as const)(
    'still routes a %s answer by a binding made after the answer was recorded in the same turn, without its context',
    async answerKind => {
      const directory = mkdtempSync(join(tmpdir(), 'feedback-runtime-bind-after-answer-'));
      const source = await SkillFeedbackStore.open(directory);
      const extensions = await FeedbackExtensionStore.open(directory);
      const policy = normalizeFeedbackPolicy({ enabled: true, audience: 'requester' })!;
      try {
        // `botmux send` records the final answer mid-turn; the skill binds afterwards.
        const delivery = source.recordTurnDelivery({
          botAppId: 'app', sessionId: 'session', turnId: 'turn',
          platform: 'lark', platformAppId: 'app', platformMessageId: 'om_answer',
          chatId: 'oc_chat', topicRootId: 'om_topic_root', content: 'answer',
          cardMode: 'feedback', status: 'delivered', policy, requesterSubjectId: 'ou_requester',
        });
        expect(delivery.context?.feedbackSubjectBinding).toBeNull();
        extensions.bindSubject('app', 'session', 'turn', {
          sourceMessageId: 'om_question', answerKind, context: { category: 42 },
        });
        source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'turn', status: 'completed' });
        const sent: string[] = [];
        await reconcileFeedbackSurfaces({
          appId: 'app', sourceKey: 'source', source, extensions,
          config: { version: 1, hostId: 'host', templates: [defaultFeedbackTemplate()], hooks: [], actions: [],
            presentations: { app: { default: { enabled: true, rounds: [1], mode: 'separate' }, rules: [] } } },
          now: Date.now, send: async subject => { sent.push(subject); return 'om_surface'; },
          answerUrl: () => 'https://example.com/answer', removeInline: async () => {},
        });
        if (answerKind === 'clarification') {
          expect(sent).toEqual([]);
        } else {
          expect(sent).toEqual(['om_question']);
          expect(extensions.surface('app', 'om_surface')).toMatchObject({ subjectId: 'om_question', context: null });
        }
      } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
    },
  );
  it('falls back to the subject binding for a historical delivery without a snapshot while keeping context null', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-runtime-legacy-delivery-'));
    const source = await SkillFeedbackStore.open(directory);
    const extensions = await FeedbackExtensionStore.open(directory);
    const policy = normalizeFeedbackPolicy({ enabled: true, audience: 'requester' })!;
    try {
      extensions.bindSubject('app', 'session', 'legacy-turn', {
        sourceMessageId: 'om_question', answerKind: 'substantive', context: { category: 42 },
      });
      const delivery = source.recordTurnDelivery({
        botAppId: 'app', sessionId: 'session', turnId: 'legacy-turn',
        platform: 'lark', platformAppId: 'app', platformMessageId: 'om_answer',
        chatId: 'oc_chat', topicRootId: 'om_topic_root', content: 'answer',
        cardMode: 'feedback', status: 'delivered', policy, requesterSubjectId: 'ou_requester',
      });
      (source as any).db.prepare('UPDATE deliveries SET context_json=? WHERE delivery_id=?')
        .run(JSON.stringify({ teamId: 'team' }), delivery.deliveryId);
      source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'legacy-turn', status: 'completed' });
      const sent: string[] = [];
      await reconcileFeedbackSurfaces({
        appId: 'app', sourceKey: 'source', source, extensions,
        config: { version: 1, hostId: 'host', templates: [defaultFeedbackTemplate()], hooks: [], actions: [],
          presentations: { app: { default: { enabled: true, rounds: [1], mode: 'separate' }, rules: [] } } },
        now: Date.now, send: async subject => { sent.push(subject); return 'om_surface'; },
        answerUrl: () => 'https://example.com/answer', removeInline: async () => {},
      });
      expect(sent).toEqual(['om_question']);
      expect(extensions.surface('app', 'om_surface')).toMatchObject({
        subjectId: 'om_question', answerMessageId: 'om_answer', context: null,
      });
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
  it('uses the frozen delivery context for a feedback subscription after reopening', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-subscription-context-'));
    const source = await SkillFeedbackStore.open(directory);
    let extensions = await FeedbackExtensionStore.open(directory);
    try {
      extensions.bindSubject('app', 'session', 'one', {
        sourceMessageId: 'question', answerKind: 'substantive', context: { category: 42 },
      });
      const delivery = source.recordTurnDelivery({ botAppId: 'app', sessionId: 'session', turnId: 'one',
        platform: 'lark', platformAppId: 'app', platformMessageId: 'answer', chatId: 'chat',
        content: 'answer', cardMode: 'card', status: 'delivered' });
      extensions.bindSurface('app', 'surface', { deliveryId: delivery.deliveryId, context: { category: 42 } });
      extensions.close();
      extensions = await FeedbackExtensionStore.open(directory);
      source.recordFeedback({ platform: 'lark', platformAppId: 'app', platformMessageId: 'answer',
        operatorSubjectId: 'operator', result: 'positive', callbackKey: 'new' });
      await reconcileFeedbackSurfaces({ appId: 'app', sourceKey: 'source', source, extensions,
        config: { version: 1, hostId: 'host', templates: [], actions: [], presentations: {},
          hooks: [{ id: 'hook', enabled: true } as any],
          subscriptions: [{ id: 'subscription', appId: 'app', chatId: 'chat', buttonKey: 'positive', hookId: 'hook' }] },
        send: async () => { throw new Error('unexpected send'); }, answerUrl: () => 'https://example.com',
        removeInline: async () => {}, now: Date.now });
      expect((extensions.jobsForApp('app')[0]?.payload.event as any).context).toEqual({ category: 42 });
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it.each([false, true])('keeps historical queued-surface null context without backfill (delivery snapshot=%s)', async hasSnapshot => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-subscription-no-backfill-'));
    const source = await SkillFeedbackStore.open(directory);
    const extensions = await FeedbackExtensionStore.open(directory);
    try {
      if (hasSnapshot) extensions.bindSubject('app', 'session', 'one', {
        sourceMessageId: 'question', answerKind: 'substantive', context: { category: 42 },
      });
      const delivery = source.recordTurnDelivery({ botAppId: 'app', sessionId: 'session', turnId: 'one',
        platform: 'lark', platformAppId: 'app', platformMessageId: 'answer', chatId: 'chat',
        content: 'answer', cardMode: 'card', status: 'delivered' });
      source.recordFeedback({ platform: 'lark', platformAppId: 'app', platformMessageId: 'answer',
        operatorSubjectId: 'operator', result: 'positive', callbackKey: 'old' });
      if (!hasSnapshot) extensions.bindSubject('app', 'session', 'one', {
        sourceMessageId: 'question', answerKind: 'substantive', context: { category: 99 },
      });
      extensions.ingest('pending', 0, [{ sequence: 1, eventId: 'pending', jobs: [{
        id: 'pending-surface', kind: 'surface', payload: { appId: 'app', deliveryId: delivery.deliveryId,
          context: null, round: 1, chatId: 'chat', subjectId: 'question' },
      }] }]);
      await reconcileFeedbackSurfaces({ appId: 'app', sourceKey: 'source', source, extensions,
        config: { version: 1, hostId: 'host', templates: [], actions: [], presentations: {},
          hooks: [{ id: 'hook', enabled: true } as any],
          subscriptions: [{ id: 'subscription', appId: 'app', chatId: 'chat', buttonKey: 'positive', hookId: 'hook' }] },
        send: async () => { throw new Error('unexpected send'); }, answerUrl: () => 'https://example.com',
        removeInline: async () => {}, now: Date.now });
      const job = extensions.jobsForApp('app').find(item => item.kind === 'hook')!;
      expect((job.payload.event as any).context).toBeNull();
      expect(delivery.context?.feedbackSubjectBinding).toEqual(hasSnapshot
        ? { sourceMessageId: 'question', answerKind: 'substantive', context: { category: 42 } } : null);
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it.each(['subject', 'topic'] as const)('counts %s scope across followup bindings and keeps topics and chats isolated', async roundScope => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-runtime-'));
    const source = await SkillFeedbackStore.open(directory);
    let extensions = await FeedbackExtensionStore.open(directory);
    const policy = normalizeFeedbackPolicy({ enabled: true })!;
    const config = { version: 1, hostId: 'host', templates: [defaultFeedbackTemplate()], hooks: [], actions: [],
      presentations: { app: normalizeFeedbackPresentation({ default: { enabled: false }, rules: [{
        id: 'target', match: { chatId: 'chat' }, enabled: true, rounds: [1], roundScope, templateId: 'default', mode: 'separate',
      }] }) } };
    let sends = 0;
    const dependencies = { appId: 'app', sourceKey: 'source', source, extensions, config,
      send: async () => `surface-${++sends}`, answerUrl: () => 'https://example.com/answer',
      removeInline: async () => {}, now: () => 1000 };
    try {
      for (const [turn, chatId, topicRootId] of [
        ['clarify', 'chat', 'question'], ['one', 'chat', 'question'], ['two', 'chat', 'question'],
        ['new-topic', 'chat', 'another-question'], ['other-chat', 'elsewhere', 'other-question'],
      ]) {
        extensions.bindSubject('app', 'session', turn, {
          sourceMessageId: turn === 'two' ? 'followup-question' : topicRootId,
          answerKind: turn === 'clarify' ? 'clarification' : 'substantive',
        });
        source.recordTurnDelivery({ botAppId: 'app', sessionId: 'session', turnId: turn, platform: 'lark', platformAppId: 'app',
          chatId, topicRootId, platformMessageId: turn, content: 'answer', status: 'delivered', cardMode: 'feedback', policy,
          baseCard: { schema: '2.0', body: { elements: [buildFeedbackElement(policy)] } } });
        source.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: turn, status: 'completed' });
      }
      for (let iteration = 0; iteration < 4; iteration++) await reconcileFeedbackSurfaces(dependencies);
      expect(sends).toBe(roundScope === 'topic' ? 2 : 3);
      expect(extensions.surface('app', 'surface-1')).toMatchObject({ answerMessageId: 'one', subjectId: 'question', round: 1 });
      expect(extensions.surface('app', roundScope === 'topic' ? 'surface-2' : 'surface-3')).toMatchObject({
        answerMessageId: 'new-topic', subjectId: 'another-question', round: 1,
      });
      extensions.close();
      extensions = await FeedbackExtensionStore.open(directory);
      const reopened = { ...dependencies, extensions };
      await Promise.all([reconcileFeedbackSurfaces(reopened), reconcileFeedbackSurfaces(reopened)]);
      expect(sends).toBe(roundScope === 'topic' ? 2 : 3);
    } finally { extensions.close(); source.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
