import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { FeedbackExtensionStore } from '../src/services/feedback-extension-store.js';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import { openDatabaseSync } from '../src/services/sqlite-compat.js';

describe('feedback extension durability', () => {
  it('skips schema writes on reopen and isolates main feedback store from a corrupt extension DB', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-extension-open-isolation-'));
    try {
      const stores = await Promise.all(Array.from({ length: 6 }, () => FeedbackExtensionStore.open(directory)));
      for (const store of stores) store.close();
      const dbPath = join(directory, 'feedback-extensions.sqlite');
      const raw = await openDatabaseSync(dbPath);
      raw.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      raw.close();
      const reopened = await FeedbackExtensionStore.open(directory);
      const walPath = `${dbPath}-wal`;
      expect(existsSync(walPath) ? statSync(walPath).size : 0).toBe(0);
      reopened.close();

      rmSync(dbPath, { force: true });
      rmSync(walPath, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      writeFileSync(dbPath, 'corrupt-extension-sqlite');
      const main = await SkillFeedbackStore.open(directory);
      try {
        const delivery = main.recordTurnDelivery({
          botAppId: 'app', sessionId: 'session', turnId: 'turn',
          platform: 'lark', platformAppId: 'app', platformMessageId: 'om_answer',
          content: 'answer', cardMode: 'card', status: 'delivered',
        });
        expect(delivery.context?.feedbackSubjectBinding).toBeNull();
      } finally { main.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('creates no extension database for unbound answers and freezes a later binding through the same main store', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-extension-lazy-'));
    const main = await SkillFeedbackStore.open(directory);
    try {
      const record = (turnId: string, platformMessageId: string) => main.recordTurnDelivery({
        botAppId: 'app', sessionId: 'session', turnId, platform: 'lark', platformAppId: 'app', platformMessageId,
        content: 'answer', cardMode: 'card', status: 'delivered', context: { teamId: 'team' },
      });
      expect(record('first', 'om_first').context).toEqual({ teamId: 'team', feedbackSubjectBinding: null });
      // The extension host treats an existing database as "extensions in use".
      expect(existsSync(join(directory, 'feedback-extensions.sqlite'))).toBe(false);
      const extensions = await FeedbackExtensionStore.open(directory);
      try {
        extensions.bindSubject('app', 'session', 'second', {
          sourceMessageId: 'om_question', answerKind: 'substantive', context: { category: 42 },
        });
      } finally { extensions.close(); }
      expect(record('second', 'om_second').context).toEqual({ teamId: 'team', feedbackSubjectBinding: {
        sourceMessageId: 'om_question', answerKind: 'substantive', context: { category: 42 },
      } });
    } finally { main.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('freezes the first action event across cards, actors, replay and pause recovery', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-event-snapshot-'));
    let store = await FeedbackExtensionStore.open(directory);
    try {
      const definition = { id: 'hook', command: ['script'] };
      const first = { appId: 'app', hookId: 'hook', hookVersion: 1, hookDefinition: definition,
        event: { context: { category: 42 }, surface: { messageId: 'surface-a' }, actor: { openId: 'first' } } };
      const second = { ...first, hookVersion: 2,
        event: { context: { category: 99 }, surface: { messageId: 'surface-b' }, actor: { openId: 'second' } } };
      store.requestAction({ requestId: 'first', actor: 'first', job: { id: 'job', kind: 'hook', payload: first } });
      store.requestAction({ requestId: 'second', actor: 'second', job: { id: 'job', kind: 'hook', payload: second } });
      expect(store.job('job')?.payload.event).toEqual(first.event);
      store.requestAction({ requestId: 'pause', actor: 'second', paused: true, job: { id: 'job', kind: 'hook', payload: second } });
      store.close();
      store = await FeedbackExtensionStore.open(directory);
      store.requestAction({ requestId: 'resume', actor: 'second', job: { id: 'job', kind: 'hook', payload: second } });
      expect(store.job('job')).toMatchObject({ status: 'pending', payload: { event: first.event, hookVersion: 2 } });
      store.requestAction({ requestId: 'first', actor: 'first', job: { id: 'job', kind: 'hook', payload: first } });
      expect(store.job('job')?.payload.event).toEqual(first.event);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('rolls back a paused request together with its callback registration on conflict', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-pause-transaction-'));
    const store = await FeedbackExtensionStore.open(directory);
    try {
      store.requestAction({ requestId: 'request', actor: 'first', job: { id: 'original', kind: 'hook', payload: {} } });
      expect(() => store.requestAction({ requestId: 'request', actor: 'other', paused: true,
        job: { id: 'paused', kind: 'hook', payload: { appId: 'app' } } })).toThrow('feedback_action_request_conflict');
      store.close();
      const reopened = await FeedbackExtensionStore.open(directory);
      expect(reopened.job('paused')).toBeUndefined();
      expect(reopened.job('original')?.status).toBe('pending');
      reopened.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('records a verified unknown surface receipt without sending another card', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-surface-reconcile-'));
    const store = await FeedbackExtensionStore.open(directory);
    try {
      store.ingest('source', 0, [{ sequence: 1, eventId: 'event', jobs: [{ id: 'job', kind: 'surface',
        payload: { appId: 'app', subjectId: 'question', deliveryId: 'answer', answerMessageId: 'message', mode: 'separate' } }] }]);
      store.claim('surface', 100, 100);
      store.expire(201);
      expect(store.reconcileSurfaceReceipt('job', 'surface', 'admin', 'verified provider receipt')).toBe(true);
      expect(store.surface('app', 'surface')).toMatchObject({ subjectId: 'question', deliveryId: 'answer' });
      expect(store.job('job')).toMatchObject({ status: 'succeeded', result: { messageId: 'surface' } });
      expect(store.claim('surface', 300, 100)).toBeUndefined();
      expect(store.reconcileSurfaceReceipt('job', 'other', 'admin', 'different')).toBe(false);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('retains feedback state while action status advances and marks the surface dirty', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-action-display-'));
    const store = await FeedbackExtensionStore.open(directory);
    try {
      store.bindSurface('app', 'surface', { deliveryId: 'delivery', subjectId: 'question' });
      store.dirtySurface('app', 'surface', { feedbackId: 'feedback', result: 'positive' });
      store.requestAction({ requestId: 'request', actor: 'user', job: { id: 'job', kind: 'hook',
        payload: { appId: 'app', event: { scope: { subjectId: 'question' }, surface: { messageId: 'surface' } } } } });
      const claim = store.claim('hook', 100, 1000)!;
      store.settle('job', claim.token!, 'succeeded', { publicMessage: 'Sent; awaiting acceptance' }, 200);
      expect(store.surface('app', 'surface')).toMatchObject({ feedbackState: { result: 'positive' }, actionStatus: 'Sent; awaiting acceptance' });
      const dirty = store.dirtySurfaces('app')[0];
      expect(dirty.state).toMatchObject({ result: 'positive' });
      store.clearDirtySurface('app', dirty.messageId, dirty.revision);
      expect(store.surface('app', 'surface')).toMatchObject({ feedbackState: { result: 'positive' } });
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('commits surface receipt and pending inline cleanup together, refusing expired ownership', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-receipt-'));
    const store = await FeedbackExtensionStore.open(directory);
    try {
      store.ingest('source', 0, [{ sequence: 1, eventId: 'event', jobs: [{ id: 'surface-job', kind: 'surface',
        payload: { appId: 'app', answerMessageId: 'answer', mode: 'separate' } }] }]);
      const claim = store.claim('surface', 100, 1000)!;
      expect(store.completeSurface(claim.id, claim.token!, 'surface', 1101)).toBe(false);
      expect(store.surface('app', 'surface')).toBeUndefined();
      expect(store.completeSurface(claim.id, claim.token!, 'surface', 200)).toBe(true);
      expect(store.job(claim.id)?.status).toBe('succeeded');
      expect(store.inlineCleanups('app')).toEqual(['answer']);
      store.clearInlineCleanup('app', 'answer');
      expect(store.inlineCleanups('app')).toEqual([]);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('pins subject metadata to the exact bot session and turn', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-extension-'));
    const store = await FeedbackExtensionStore.open(directory);
    try {
      store.bindSubject('app', 'session', 'turn', { sourceMessageId: 'om_question', answerKind: 'substantive' });
      expect(store.subject('app', 'session', 'turn')).toEqual({ sourceMessageId: 'om_question', answerKind: 'substantive' });
      expect(store.subject('other', 'session', 'turn')).toBeUndefined();
      expect(() => store.bindSubject('app', 'session', 'turn', { sourceMessageId: 'om_other', answerKind: 'substantive' })).toThrow();
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('preserves bounded context through reopen and rejects changes to the same binding', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-context-'));
    let store = await FeedbackExtensionStore.open(directory);
    try {
      const context = { kind: 'classification', category: 42, nested: { region: 'region-a' } };
      store.bindSubject('app', 'session', 'turn', { sourceMessageId: 'om_question', answerKind: 'substantive', context });
      context.nested.region = 'changed';
      store.close();
      store = await FeedbackExtensionStore.open(directory);
      expect(store.subject('app', 'session', 'turn')?.context).toEqual({
        category: 42, kind: 'classification', nested: { region: 'region-a' },
      });
      expect(() => store.bindSubject('app', 'session', 'turn', {
        sourceMessageId: 'om_question', answerKind: 'substantive',
        context: { nested: { region: 'region-a' }, category: 42, kind: 'classification' },
      })).not.toThrow();
      expect(() => store.bindSubject('app', 'session', 'turn', {
        sourceMessageId: 'om_question', answerKind: 'substantive', context: { category: 99 },
      })).toThrow('feedback_subject_binding_conflict');
      expect(store.subject('other', 'session', 'turn')).toBeUndefined();
      for (const invalid of [{ text: 'x'.repeat(8192) }, { number: Infinity }, { missing: undefined },
        { nested: new Date() }, ['not-an-object']]) {
        expect(() => store.bindSubject('app', 'session', 'invalid', {
          sourceMessageId: 'om_question', answerKind: 'substantive', context: invalid as any,
        })).toThrow();
      }
      let nested: Record<string, unknown> = {};
      for (let depth = 0; depth < 8; depth++) nested = { child: nested };
      expect(() => store.bindSubject('app', 'session', 'deep', {
        sourceMessageId: 'om_question', answerKind: 'substantive', context: nested,
      })).toThrow();
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('records manual evidence without re-executing unknown operations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'feedback-extension-'));
    const store = await FeedbackExtensionStore.open(directory);
    try {
      store.requestAction({ requestId: 'request', actor: 'user', job: { id: 'job', kind: 'hook', payload: {} } });
      store.claim('hook', 100, 100);
      store.expire(201);
      expect(() => store.reconcileUnknown('job', 'succeeded', 'admin', '')).toThrow();
      expect(store.reconcileUnknown('job', 'succeeded', 'admin', 'Provider receipt verified: example')).toBe(true);
      expect(store.job('job')).toMatchObject({ status: 'succeeded', result: { reconciled: true } });
      expect(store.claim('hook', 300, 100)).toBeUndefined();
      expect(store.reconcileUnknown('job', 'failed_before_effect', 'admin', 'contradictory')).toBe(false);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
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
