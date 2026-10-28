import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FeedbackAnalyticsService } from '../src/services/feedback-analytics.js';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-analytics-')); dirs.push(dataDir);
  const store = await SkillFeedbackStore.open(dataDir);
  const base = { botAppId: 'app-a', sessionId: 'session-a', platform: 'lark', platformAppId: 'app-a', chatId: 'chat-a', topicRootId: 'topic-a', cliId: 'codex', cliVersion: '1', model: 'gpt-5', skillName: 'review', skillVersion: '2', workflowId: 'wf-a', taskId: 'task-a', cardMode: 'feedback' as const, status: 'delivered' as const };
  const first = store.recordTurnDelivery({ ...base, turnId: 'turn-1', platformMessageId: 'msg-1', content: 'secret answer one', contentRef: 'lark://msg-1', createdAt: '2026-08-10T10:00:00.000Z' });
  store.recordTurnDelivery({ ...base, turnId: 'turn-2', platformMessageId: 'msg-2', content: 'secret answer two', createdAt: '2026-08-10T11:00:00.000Z' });
  store.recordFeedback({ platform: 'lark', platformAppId: 'app-a', platformMessageId: 'msg-1', operatorSubjectId: 'operator-secret', result: 'up', semantic: 'positive', callbackKey: 'cb-1' });
  store.recordFeedback({ platform: 'lark', platformAppId: 'app-a', platformMessageId: 'msg-1', operatorSubjectId: 'operator-secret', result: 'down', semantic: 'negative', reasonKey: 'wrong', comment: 'private comment', callbackKey: 'cb-2' });
  store.close();
  return { dataDir };
}

describe('FeedbackAnalyticsService', () => {
  it('uses latest revisions and distinguishes delivered from rated denominators', async () => {
    const { dataDir } = await fixture();
    const service = new FeedbackAnalyticsService(dataDir);
    const summary = service.summary({ from: '2026-08-10T00:00:00.000Z', to: '2026-08-11T00:00:00.000Z' });
    expect(summary).toMatchObject({ delivered: 2, ratedDeliveries: 1, ratings: 1, positive: 0, negative: 1, ratingCoverage: 0.5, positiveRate: 0 });
    service.close();
  });

  it('applies typed parameterized filters and rejects unbounded ranges', async () => {
    const { dataDir } = await fixture();
    const service = new FeedbackAnalyticsService(dataDir);
    const range = { from: '2026-08-10T00:00:00.000Z', to: '2026-08-11T00:00:00.000Z' };
    expect(service.summary({ ...range, botAppId: 'app-a', chatId: 'chat-a', topicRootId: 'topic-a', semantic: 'negative', verdictKey: 'down', reasonKey: 'wrong', model: 'gpt-5', cliId: 'codex', cliVersion: '1', skillName: 'review', skillVersion: '2', workflowId: 'wf-a', taskId: 'task-a', status: 'delivered' })).toMatchObject({ delivered: 2, ratings: 1 });
    expect(service.summary({ ...range, botAppId: "app-a' OR 1=1 --" })).toMatchObject({ delivered: 0, ratings: 0 });
    expect(() => service.summary({ from: '2020-01-01T00:00:00.000Z', to: '2026-08-11T00:00:00.000Z' })).toThrow('feedback_analytics_range_too_large');
    expect(() => service.summary({ from: 'bad', to: '2026-08-11T00:00:00.000Z' })).toThrow('feedback_analytics_invalid_range');
    service.close();
  });

  it('returns semantic trends, reasons, and stable redacted cursor pages', async () => {
    const { dataDir } = await fixture();
    const service = new FeedbackAnalyticsService(dataDir);
    const range = { from: '2026-08-10T00:00:00.000Z', to: '2026-08-11T00:00:00.000Z' };
    expect(service.trend(range)).toEqual([{ bucket: '2026-08-10', positive: 0, negative: 1, progress: 0, ratings: 1 }]);
    expect(service.reasons(range)).toEqual([{ reasonKey: 'wrong', count: 1 }]);
    const first = service.deliveries(range, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = service.deliveries(range, { limit: 1, cursor: first.nextCursor });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].deliveryId).not.toBe(first.items[0].deliveryId);
    const serialized = JSON.stringify([...first.items, ...second.items]);
    expect(serialized).not.toContain('secret answer');
    expect(serialized).not.toContain('operator-secret');
    expect(serialized).not.toContain('private comment');
    expect(serialized).not.toContain('baseCard');
    expect(first.items[0]).toEqual(expect.objectContaining({ contentHash: expect.stringMatching(/^sha256:/), platformMessageId: expect.any(String), botAppId: 'app-a' }));
    service.close();
  });

  it('filters every metric by delivery time and bot, including late webhook failures of both event types', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-cohort-')); dirs.push(dataDir);
    const store = await SkillFeedbackStore.open(dataDir);
    const destination = { id: 'hook', enabled: true, url: 'https://example.test/hook', eventTypes: ['turn.completed', 'feedback.revised'] as Array<'turn.completed' | 'feedback.revised'>, secretRef: 'test' };
    const inputs = [
      ['before', 'app-a', '2026-08-09T23:59:59.999Z'],
      ['inside', 'app-a', '2026-08-10T00:00:00.000Z'],
      ['end', 'app-a', '2026-08-11T00:00:00.000Z'],
      ['other', 'app-b', '2026-08-10T10:00:00.000Z'],
    ];
    for (const [turnId, botAppId, createdAt] of inputs) {
      store.recordTurnTerminal({ botAppId: botAppId!, sessionId: 's', turnId: turnId!, status: 'completed', completedAt: '2026-08-12T00:00:00.000Z' });
      store.recordTurnDelivery({ botAppId: botAppId!, sessionId: 's', turnId: turnId!, platform: 'lark', platformAppId: botAppId!, platformMessageId: turnId!, content: 'answer', createdAt, cardMode: 'feedback', status: 'delivered', webhookDestinations: [destination] });
      store.recordFeedback({ platform: 'lark', platformAppId: botAppId!, platformMessageId: turnId!, operatorSubjectId: 'rater', result: 'down', semantic: 'negative', reasonKey: 'wrong', callbackKey: turnId! });
    }
    const now = Date.now() + 86400000;
    const outbox = store.claimFeedbackOutbox({ now, limit: 100, claimToken: 'test' });
    expect(outbox).toHaveLength(8);
    for (const item of outbox) store.rescheduleFeedbackOutbox(item.outboxId, 'test', { now, nextAttemptAt: now, error: 'permanent', permanent: true });
    store.close();
    const service = new FeedbackAnalyticsService(dataDir);
    try {
      const filters = { from: '2026-08-10T00:00:00.000Z', to: '2026-08-11T00:00:00.000Z', botAppId: 'app-a' };
      expect(service.summary(filters)).toMatchObject({ delivered: 1, ratedDeliveries: 1, ratings: 1, negative: 1, ratingCoverage: 1, outboxFailures: 2 });
      expect(service.trend(filters)).toEqual([{ bucket: '2026-08-10', positive: 0, negative: 1, progress: 0, ratings: 1 }]);
      expect(service.reasons(filters)).toEqual([{ reasonKey: 'wrong', count: 1 }]);
      expect(service.deliveries(filters).items.map(item => item.turnId)).toEqual(['inside']);
      expect(service.summary({ ...filters, botAppId: undefined })).toMatchObject({ delivered: 2, outboxFailures: 4 });
    } finally { service.close(); }
  });
});
