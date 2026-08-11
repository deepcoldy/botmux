import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function createV2Fixture(dataDir: string): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(dataDir, 'botmux-feedback.sqlite'));
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE interactions(interaction_id TEXT PRIMARY KEY, context_json TEXT, created_at TEXT NOT NULL);
    CREATE TABLE skill_runs(skill_run_id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL REFERENCES interactions(interaction_id), skill_ref TEXT NOT NULL, context_json TEXT, created_at TEXT NOT NULL);
    CREATE TABLE responses(response_id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL REFERENCES interactions(interaction_id), skill_run_id TEXT REFERENCES skill_runs(skill_run_id), content_hash TEXT NOT NULL, content_ref TEXT, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX responses_identity ON responses(interaction_id, content_hash);
    CREATE TABLE deliveries(delivery_id TEXT PRIMARY KEY, response_id TEXT NOT NULL REFERENCES responses(response_id), platform TEXT NOT NULL, platform_message_id TEXT NOT NULL, platform_app_id TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'L1' CHECK(level IN ('L0','L1','L2')), policy_snapshot_json TEXT, base_card_json TEXT, requester_subject_id TEXT, context_json TEXT, created_at TEXT NOT NULL, UNIQUE(platform,platform_app_id,platform_message_id));
    CREATE TABLE feedback_revisions(feedback_id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES deliveries(delivery_id), operator_subject_id TEXT NOT NULL, revision INTEGER NOT NULL, result TEXT NOT NULL, reason_key TEXT, comment_text TEXT, callback_key TEXT NOT NULL UNIQUE, supersedes_feedback_id TEXT REFERENCES feedback_revisions(feedback_id), created_at TEXT NOT NULL, UNIQUE(delivery_id,operator_subject_id,revision));
    INSERT INTO interactions VALUES('int_old','{}','2026-01-01T00:00:00.000Z');
    INSERT INTO responses VALUES('resp_old','int_old',NULL,'sha256:old','ref://old','2026-01-01T00:00:00.000Z');
    INSERT INTO deliveries VALUES('del_old','resp_old','lark','om_old','app_old','L1','{"enabled":true}','{"schema":"2.0"}','on_old','{"runtime":"legacy"}','2026-01-01T00:00:00.000Z');
    INSERT INTO feedback_revisions VALUES('fb_old','del_old','on_old',1,'helpful',NULL,NULL,'cb_old',NULL,'2026-01-01T00:01:00.000Z');
    PRAGMA user_version=2;
  `);
  db.close();
}

describe('SkillFeedbackStore v3 migration', () => {
  it('migrates the feedback store to schema v6 with analytics indexes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-v6-'));
    dirs.push(dataDir);
    const store = await SkillFeedbackStore.open(dataDir);
    expect(store.schemaVersion()).toBe(6);
    store.close();
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dataDir, 'botmux-feedback.sqlite'));
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map(row => row.name);
    expect(indexes).toEqual(expect.arrayContaining([
      'deliveries_analytics_created',
      'deliveries_analytics_bot_created',
      'deliveries_analytics_chat_created',
      'deliveries_analytics_topic_created',
      'deliveries_analytics_status_completed',
      'feedback_revisions_analytics_latest',
      'feedback_revisions_analytics_semantic_created',
      'feedback_outbox_analytics_status_created',
    ]));
    db.close();
  });

  it('transactionally migrates a copy of v2 while preserving old cards and feedback', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-v2-source-'));
    const migratedDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-v3-copy-'));
    dirs.push(fixtureDir, migratedDir);
    await createV2Fixture(fixtureDir);
    copyFileSync(join(fixtureDir, 'botmux-feedback.sqlite'), join(migratedDir, 'botmux-feedback.sqlite'));

    const store = await SkillFeedbackStore.open(migratedDir);
    expect(store.schemaVersion()).toBe(6);
    const old = store.findDeliveryByPlatformMessage('lark', 'app_old', 'om_old');
    expect(old).toMatchObject({
      deliveryId: 'del_old', responseId: 'resp_old', requesterSubjectId: 'on_old',
      policy: expect.objectContaining({ enabled: true }), baseCard: { schema: '2.0' },
    });
    expect(store.listFeedbackRevisions('del_old', 'on_old')).toHaveLength(1);
    expect(store.integrityCheck()).toEqual({ integrity: 'ok', foreignKeys: [] });
    store.close();
  });

  it('round-trips typed correlation metadata without storing the answer body', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-v3-'));
    dirs.push(dataDir);
    const store = await SkillFeedbackStore.open(dataDir);
    const input = {
      botAppId: 'app_a', sessionId: 'sid_1', turnId: 'turn_1', nativeSessionId: 'native_1',
      platform: 'lark' as const, platformMessageId: 'om_1', platformAppId: 'app_a', chatId: 'oc_1', topicRootId: 'om_root',
      dispatchAttempt: 2, content: 'private final answer', contentRef: 'lark://om_1', scope: 'thread' as const,
      workflowId: 'wf_1', taskId: 'task_1', parentTaskId: 'parent_1', cliId: 'codex-app', cliVersion: '1.2.3',
      model: 'gpt-5', reasoningEffort: 'high', skillName: 'review', skillVersion: '3', cardMode: 'feedback' as const,
      status: 'delivered' as const, durationMs: 1234, usage: { inputTokens: 10, outputTokens: 20 },
      createdAt: '2026-08-11T01:02:03.000Z', completedAt: '2026-08-11T01:02:04.234Z',
    };
    const first = store.recordTurnDelivery(input);
    const second = store.recordTurnDelivery(input);
    expect(second.deliveryId).toBe(first.deliveryId);
    const stored = store.findDeliveryByPlatformMessage('lark', 'app_a', 'om_1');
    expect(stored).toMatchObject({
      ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'content')),
      deliveryId: first.deliveryId,
      contentHash: expect.stringMatching(/^sha256:/),
    });
    expect(stored).not.toHaveProperty('content');
    expect(JSON.stringify(stored)).not.toContain('private final answer');
    expect(store.debugCounts()).toEqual({ responses: 1, deliveries: 1 });
    store.close();
  });

  it('uses deterministic correlation ids and refuses platform-message rebinding', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-feedback-v3-bind-'));
    dirs.push(dataDir);
    const store = await SkillFeedbackStore.open(dataDir);
    const base = {
      botAppId: 'app_a', sessionId: 'sid', turnId: 'turn', nativeSessionId: 'native',
      platform: 'lark' as const, platformAppId: 'app_a', dispatchAttempt: 1,
      content: 'answer', cardMode: 'feedback' as const, status: 'delivered' as const,
    };
    const a = store.recordTurnDelivery({ ...base, platformMessageId: 'om_a' });
    expect(() => store.recordTurnDelivery({ ...base, platformMessageId: 'om_b' })).toThrow('turn_delivery_correlation_rebind');
    expect(() => store.recordTurnDelivery({ ...base, turnId: 'other', platformMessageId: 'om_a' })).toThrow('turn_delivery_platform_message_rebind');
    expect(store.findDeliveryByPlatformMessage('lark', 'app_a', 'om_a')?.deliveryId).toBe(a.deliveryId);
    store.close();
  });
});
