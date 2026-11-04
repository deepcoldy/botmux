import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { FeedbackExtensionStore } from '../src/services/feedback-extension-store.js';

describe('feedback extension durability', () => {
  it('requires a one-use confirmation token before retrying a confirmed pre-effect failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-extension-'));
    const store = await FeedbackExtensionStore.open(directory);
    try {
      store.requestAction({ requestId: 'first', actor: 'user', job: { id: 'job', kind: 'hook', payload: {} } });
      const claim = store.claim('hook', 100, 1000)!;
      store.settle('job', claim.token!, 'failed_before_effect', {}, 200);
      const retryToken = String(store.job('job')?.result?.retryToken);
      expect(store.retryBeforeEffect('job', 'wrong', 'second', 'user')).toBe(false);
      expect(store.retryBeforeEffect('job', retryToken, 'second', 'user')).toBe(true);
      expect(store.retryBeforeEffect('job', retryToken, 'second', 'user')).toBe(false);
      expect(store.claim('hook', 300, 1000)?.id).toBe('job');
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('assigns one round to each logical answer and keeps its source-message binding across replay', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-extension-'));
    const store = await FeedbackExtensionStore.open(directory);
    try {
      const identity = { appId: 'app', chatId: 'chat', subjectId: 'question' };
      expect(store.recordAnswer({ ...identity, answerId: 'first', deliveryId: 'delivery1' })).toBe(1);
      expect(store.recordAnswer({ ...identity, answerId: 'first', deliveryId: 'delivery1' })).toBe(1);
      expect(store.recordAnswer({ ...identity, answerId: 'second', deliveryId: 'delivery2' })).toBe(2);
      expect(() => store.recordAnswer({ ...identity, answerId: 'first', deliveryId: 'other-delivery' })).toThrow();
      store.bindSurface('app', 'card', { deliveryId: 'delivery1', answerId: 'first', subjectId: 'question' });
      expect(store.surface('app', 'card')).toEqual({ deliveryId: 'delivery1', answerId: 'first', subjectId: 'question' });
      expect(store.surface('other-app', 'card')).toBeUndefined();
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('atomically persists an event, jobs and its cursor, and rejects stale consumers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-extension-'));
    const store = await FeedbackExtensionStore.open(directory);
    try {
      store.ingest('source', 0, [{ sequence: 1, eventId: 'event', jobs: [{ id: 'job', kind: 'hook', payload: { value: 1 } }] }]);
      expect(store.cursor('source')).toBe(1);
      expect(store.job('job')).toMatchObject({ status: 'pending', payload: { value: 1 } });
      expect(() => store.ingest('source', 0, [{ sequence: 2, eventId: 'other', jobs: [] }])).toThrow('cursor_conflict');
      expect(store.cursor('source')).toBe(1);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('does not restart an expired running external operation and fences late completion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-extension-'));
    let store = await FeedbackExtensionStore.open(directory);
    try {
      store.ingest('source', 0, [{ sequence: 1, eventId: 'event', jobs: [{ id: 'job', kind: 'hook', payload: {} }] }]);
      const claim = store.claim('hook', 100, 1000)!;
      expect(store.claim('hook', 100, 1000)).toBeUndefined();
      expect(store.settle('job', 'wrong-token', 'succeeded', {})).toBe(false);
      expect(store.settle('job', claim.token!, 'succeeded', {}, 1101)).toBe(false);
      store.close();
      store = await FeedbackExtensionStore.open(directory);
      store.expire(1101);
      expect(store.job('job')?.status).toBe('unknown');
      expect(store.claim('hook', 1200, 1000)).toBeUndefined();
      expect(store.settle('job', claim.token!, 'succeeded', {})).toBe(false);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('preserves problem-level idempotency across different users and database connections', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-extension-'));
    const first = await FeedbackExtensionStore.open(directory);
    const second = await FeedbackExtensionStore.open(directory);
    try {
      first.requestAction({ requestId: 'click1', actor: 'alice', job: { id: 'subject-action', kind: 'hook', payload: { original: true } } });
      second.requestAction({ requestId: 'click2', actor: 'bob', job: { id: 'subject-action', kind: 'hook', payload: { original: false } } });
      expect(second.job('subject-action')?.payload).toEqual({ original: true });
      expect(second.actionRequests('subject-action')).toHaveLength(2);
      expect(first.claim('hook', 1, 100)?.id).toBe('subject-action');
      expect(second.claim('hook', 1, 100)).toBeUndefined();
    } finally { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
