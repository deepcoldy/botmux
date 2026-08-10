import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SkillFeedbackStore', () => {
  it('persists runtime-neutral entities and only the response hash across restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-'));
    dirs.push(dataDir);
    const first = await SkillFeedbackStore.open(dataDir);
    const response = first.createResponse({ interactionId: 'int_1', content: 'secret answer' });
    const delivery = first.createDelivery({
      responseId: response.responseId,
      platform: 'lark',
      platformAppId: 'app_a',
      platformMessageId: 'om_answer',
      level: 'L2',
      context: { runtime: 'codex', model: 'gpt', session: 'sid', turn: 'turn' },
    });
    first.close();

    const reopened = await SkillFeedbackStore.open(dataDir);
    expect(reopened.findDeliveryByPlatformMessage('lark', 'app_a', 'om_answer')).toMatchObject({
      deliveryId: delivery.deliveryId,
      responseId: response.responseId,
      level: 'L2',
    });
    expect(reopened.getResponse(response.responseId)).toMatchObject({
      responseId: response.responseId,
      contentHash: expect.stringMatching(/^sha256:/),
    });
    expect(JSON.stringify(reopened.getResponse(response.responseId))).not.toContain('secret answer');
    expect(reopened.pragmas()).toMatchObject({ journalMode: 'wal', foreignKeys: 1, busyTimeout: 5000 });
    expect(reopened.schemaVersion()).toBe(1);
    reopened.close();
  });

  it('is idempotent and race-safe across SQLite connections without orphan responses', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-'));
    dirs.push(dataDir);
    const [a, b] = await Promise.all([SkillFeedbackStore.open(dataDir), SkillFeedbackStore.open(dataDir)]);
    const interactionId = 'lark:app_a:sid:turn';
    const [ra, rb] = await Promise.all([
      Promise.resolve().then(() => a.createResponse({ interactionId, content: 'same answer' })),
      Promise.resolve().then(() => b.createResponse({ interactionId, content: 'same answer' })),
    ]);
    expect(ra.responseId).toBe(rb.responseId);
    const [da, db] = await Promise.all([
      Promise.resolve().then(() => a.createDelivery({ responseId: ra.responseId, platform: 'lark', platformAppId: 'app_a', platformMessageId: 'om_same' })),
      Promise.resolve().then(() => b.createDelivery({ responseId: rb.responseId, platform: 'lark', platformAppId: 'app_a', platformMessageId: 'om_same' })),
    ]);
    expect(da).toMatchObject({ deliveryId: db.deliveryId, responseId: ra.responseId });
    expect(a.debugCounts()).toEqual({ responses: 1, deliveries: 1 });
    a.close();
    b.close();
  });

  it('rejects unknown newer schemas without destructive migration', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-'));
    dirs.push(dataDir);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dataDir, 'botmux-feedback.sqlite'));
    db.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES (\'keep\'); PRAGMA user_version=2;');
    db.close();
    await expect(SkillFeedbackStore.open(dataDir)).rejects.toThrow('skill_feedback_schema_newer:2');
    const verify = new DatabaseSync(join(dataDir, 'botmux-feedback.sqlite'));
    expect((verify.prepare('SELECT value FROM sentinel').get() as any).value).toBe('keep');
    verify.close();
  });

  it('deduplicates identical callbacks and appends immutable revisions when choice changes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-'));
    dirs.push(dataDir);
    const store = await SkillFeedbackStore.open(dataDir);
    const response = store.createResponse({ interactionId: 'int_1', content: 'answer' });
    store.createDelivery({ responseId: response.responseId, platform: 'lark', platformAppId: 'app_a', platformMessageId: 'om_answer', level: 'L1' });

    const first = store.recordFeedback({
      platform: 'lark', platformAppId: 'app_a', platformMessageId: 'om_answer', operatorSubjectId: 'on_user',
      result: 'usable', callbackKey: 'cb_same',
    });
    const duplicate = store.recordFeedback({
      platform: 'lark', platformAppId: 'app_a', platformMessageId: 'om_answer', operatorSubjectId: 'on_user',
      result: 'usable', callbackKey: 'cb_same',
    });
    const revised = store.recordFeedback({
      platform: 'lark', platformAppId: 'app_a', platformMessageId: 'om_answer', operatorSubjectId: 'on_user',
      result: 'wrong', reasonKey: 'factual', callbackKey: 'cb_changed',
    });

    expect(first.status).toBe('accepted');
    expect(duplicate).toMatchObject({ status: 'duplicate', feedbackId: first.feedback.feedbackId });
    expect(revised).toMatchObject({ status: 'revised', feedback: { revision: 2, supersedesFeedbackId: first.feedback.feedbackId } });
    expect(store.listFeedbackRevisions(first.feedback.deliveryId, 'on_user')).toHaveLength(2);
    store.close();
  });

  it('scopes identical platform message ids by app identity', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-'));
    dirs.push(dataDir);
    const store = await SkillFeedbackStore.open(dataDir);
    const response = store.createResponse({ interactionId: 'int_apps', content: 'answer' });
    store.createDelivery({ responseId: response.responseId, platform: 'lark', platformAppId: 'app_a', platformMessageId: 'om_same' });
    store.createDelivery({ responseId: response.responseId, platform: 'lark', platformAppId: 'app_b', platformMessageId: 'om_same' });
    expect(store.findDeliveryByPlatformMessage('lark', 'app_a', 'om_same')?.platformAppId).toBe('app_a');
    expect(store.findDeliveryByPlatformMessage('lark', 'app_b', 'om_same')?.platformAppId).toBe('app_b');
    store.close();
  });

  it('rejects a callback-key collision across app-scoped deliveries', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-'));
    dirs.push(dataDir);
    const store = await SkillFeedbackStore.open(dataDir);
    const response = store.createResponse({ interactionId: 'int_collision', content: 'answer' });
    store.createDelivery({ responseId: response.responseId, platform: 'lark', platformAppId: 'app_a', platformMessageId: 'om_same' });
    store.createDelivery({ responseId: response.responseId, platform: 'lark', platformAppId: 'app_b', platformMessageId: 'om_same' });
    store.recordFeedback({ platform: 'lark', platformAppId: 'app_a', platformMessageId: 'om_same', operatorSubjectId: 'on_user', result: 'usable', callbackKey: 'forced_collision' });
    expect(() => store.recordFeedback({ platform: 'lark', platformAppId: 'app_b', platformMessageId: 'om_same', operatorSubjectId: 'on_user', result: 'usable', callbackKey: 'forced_collision' }))
      .toThrow('feedback_callback_key_conflict');
    store.close();
  });
});
