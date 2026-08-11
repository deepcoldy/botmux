import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import type { FeedbackWebhookDestination } from '../src/services/feedback-outbox.js';

const dirs: string[] = [];
const destination = (id: string, eventTypes: Array<'turn.completed' | 'feedback.revised'> = ['turn.completed', 'feedback.revised']): FeedbackWebhookDestination => ({
  id, enabled: true, url: `https://${id}.example.test/hook`, eventTypes, secretRef: `secret-${id}`, timeoutMs: 1000,
});

async function store(): Promise<SkillFeedbackStore> {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-feedback-outbox-'));
  dirs.push(dir);
  return SkillFeedbackStore.open(dir);
}

function deliveryInput(destinations: FeedbackWebhookDestination[] = []) {
  return {
    botAppId: 'app', sessionId: 'session', turnId: 'turn', platform: 'lark', platformMessageId: 'msg', platformAppId: 'app',
    chatId: 'chat', content: 'TOP SECRET ANSWER', cardMode: 'feedback' as const, status: 'delivered' as const,
    webhookDestinations: destinations,
  };
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('feedback schema v5 durable event outbox', () => {
  it('migrates to v5 and atomically fans out a deterministic turn.completed event', async () => {
    const db = await store();
    db.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'turn', status: 'completed', completedAt: '2026-08-11T00:00:00.000Z' });
    db.recordTurnDelivery(deliveryInput([destination('one'), destination('disabled'), { ...destination('off'), enabled: false }]));

    expect(db.schemaVersion()).toBe(6);
    const events = db.listFeedbackEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('turn.completed');
    expect(JSON.stringify(events[0])).not.toContain('TOP SECRET ANSWER');
    const rows = db.listFeedbackOutbox();
    expect(rows.map(row => row.destinationId).sort()).toEqual(['disabled', 'one']);
    expect(rows.every(row => row.eventId === events[0].eventId)).toBe(true);
    expect(rows[0].destination.url).toMatch(/^https:/);
    expect(JSON.stringify(events)).not.toContain('secret-one');
    expect(db.integrityCheck()).toEqual({ integrity: 'ok', foreignKeys: [] });
    db.close();
  });

  it('emits stable feedback.revised events without answer bodies or secret material', async () => {
    const db = await store();
    db.recordTurnDelivery(deliveryInput([destination('feedback-only', ['feedback.revised'])]));
    const first = db.recordFeedback({ platform: 'lark', platformAppId: 'app', platformMessageId: 'msg', operatorSubjectId: 'operator', result: 'incorrect', semantic: 'negative', reasonKey: 'wrong', comment: 'brief reason', callbackKey: 'callback-1', webhookDestinations: [destination('feedback-only', ['feedback.revised'])] });
    const duplicate = db.recordFeedback({ platform: 'lark', platformAppId: 'app', platformMessageId: 'msg', operatorSubjectId: 'operator', result: 'incorrect', semantic: 'negative', reasonKey: 'wrong', comment: 'brief reason', callbackKey: 'callback-1', webhookDestinations: [destination('feedback-only', ['feedback.revised'])] });

    expect(duplicate.status).toBe('duplicate');
    const event = db.listFeedbackEvents().find(item => item.type === 'feedback.revised');
    expect(event?.data).toMatchObject({ feedbackId: first.feedback.feedbackId, revision: 1, verdictKey: 'incorrect', semantic: 'negative' });
    expect(JSON.stringify(event)).not.toContain('TOP SECRET ANSWER');
    expect(JSON.stringify(event)).not.toContain('secret-feedback-only');
    expect(db.listFeedbackOutbox()).toHaveLength(1);
    db.close();
  });

  it('freezes destination config and token-fences claims and settlement across restart', async () => {
    const db = await store();
    const dir = db.path.replace(/\/botmux-feedback\.sqlite$/, '');
    db.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: 'turn', status: 'completed', completedAt: '2026-08-11T00:00:00.000Z' });
    db.recordTurnDelivery(deliveryInput([destination('one')]));
    const original = db.listFeedbackOutbox()[0];
    const dueAt = Date.parse('2026-08-11T00:00:00.000Z');
    const claimed = db.claimFeedbackOutbox({ now: dueAt, limit: 1, claimToken: 'worker-a' })[0];
    expect(claimed.attempts).toBe(1);
    expect(db.claimFeedbackOutbox({ now: dueAt, limit: 1, claimToken: 'worker-b' })).toEqual([]);
    expect(db.settleFeedbackOutboxDelivered(claimed.outboxId, 'worker-b', 204, '2026-08-11T00:00:01.000Z')).toBe(false);
    expect(db.rescheduleFeedbackOutbox(claimed.outboxId, 'worker-a', { now: dueAt, nextAttemptAt: dueAt + 5000, error: 'temporary', httpStatus: 503 })).toBe(true);
    db.close();

    const reopened = await SkillFeedbackStore.open(dir);
    const persisted = reopened.listFeedbackOutbox()[0];
    expect(persisted.attempts).toBe(1);
    expect(persisted.nextAttemptAt).toBe(dueAt + 5000);
    expect(persisted.destination).toEqual(original.destination);
    expect(reopened.claimFeedbackOutbox({ now: dueAt + 4999, limit: 1, claimToken: 'worker-c' })).toEqual([]);
    reopened.claimFeedbackOutbox({ now: dueAt + 5000, limit: 1, claimToken: 'worker-c' });
    expect(reopened.resetExpiredFeedbackOutboxClaims(dueAt + 7000, 1000)).toBe(1);
    expect(reopened.listFeedbackOutbox()[0].status).toBe('pending');
    reopened.close();
  });
});
