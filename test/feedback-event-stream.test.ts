import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import { openDatabaseSync } from '../src/services/sqlite-compat.js';

describe('feedback event stream', () => {
  it('reads insertion order rather than event timestamps, including writes from an already open connection', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-stream-'));
    const writer = await SkillFeedbackStore.open(directory);
    const reader = await SkillFeedbackStore.open(directory);
    const emit = (turn: string, time: string) => {
      writer.recordTurnTerminal({ botAppId: 'app', sessionId: 'session', turnId: turn, status: 'completed', completedAt: time });
      writer.recordTurnDelivery({ botAppId: 'app', sessionId: 'session', turnId: turn, platform: 'lark', platformAppId: 'app',
        platformMessageId: turn, content: 'answer', cardMode: 'card', status: 'delivered' });
    };
    try {
      emit('before-install', '2026-11-05T10:00:00Z');
      const first = await reader.readFeedbackEventsAfter({ after: 0, limit: 1 });
      expect(first).toHaveLength(1);
      emit('late-old-timestamp', '2026-11-04T10:00:00Z');
      emit('same-timestamp', '2026-11-04T10:00:00Z');
      const second = await reader.readFeedbackEventsAfter({ after: first[0].sequence, limit: 1 });
      expect(second).toHaveLength(1);
      expect(second[0].event.data.turnId).toBe('late-old-timestamp');
      const third = await reader.readFeedbackEventsAfter({ after: second[0].sequence, limit: 10 });
      expect(third.map(entry => entry.event.data.turnId)).toEqual(['same-timestamp']);
      expect(writer.schemaVersion()).toBe(8);
      expect(writer.integrityCheck()).toEqual({ integrity: 'ok', foreignKeys: [] });
      expect(await reader.readFeedbackEventsAfter({ after: third[0].sequence, limit: 10 })).toEqual([]);
    } finally { reader.close(); writer.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('rejects unsafe cursors and limits', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-stream-'));
    const store = await SkillFeedbackStore.open(directory);
    try {
      for (const input of [{ after: -1, limit: 10 }, { after: 0.5, limit: 10 }, { after: 0, limit: 0 }]) {
        expect(() => store.readFeedbackEventsAfter(input)).toThrow();
      }
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('rolls back event sequences with the producer transaction and preserves the stream on reopen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-stream-'));
    let store = await SkillFeedbackStore.open(directory);
    const database = await openDatabaseSync(store.path);
    try {
      store.readFeedbackEventsAfter({ after: 0, limit: 10 });
      const insert = database.prepare('INSERT INTO feedback_events VALUES(?,?,?,?,?,?)');
      const event = (eventId: string) => JSON.stringify({ eventId, type: 'feedback.revised', version: 1, time: '2026-01-01', data: {} });
      database.exec('BEGIN IMMEDIATE');
      insert.run('rolled-back', 'feedback.revised', 1, 'delivery', event('rolled-back'), '2026-01-01');
      database.exec('ROLLBACK');
      insert.run('committed', 'feedback.revised', 1, 'delivery', event('committed'), '2026-01-01');
      const committed = store.readFeedbackEventsAfter({ after: 0, limit: 10 });
      expect(committed.map(row => row.event.eventId)).toEqual(['committed']);
      store.close();
      store = await SkillFeedbackStore.open(directory);
      expect(store.readFeedbackEventsAfter({ after: 0, limit: 10 })).toEqual(committed);
    } finally { database.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
