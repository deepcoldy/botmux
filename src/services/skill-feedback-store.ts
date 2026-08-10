import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

export type SkillFeedbackLevel = 'L0' | 'L1' | 'L2';

export interface SkillFeedbackContext {
  runtime?: string;
  agent?: string;
  model?: string;
  platform?: string;
  session?: string;
  turn?: string;
  [key: string]: string | undefined;
}

interface ResponseRow {
  response_id: string;
  interaction_id: string;
  skill_run_id: string | null;
  content_hash: string;
  content_ref: string | null;
  created_at: string;
}

interface DeliveryRow {
  delivery_id: string;
  response_id: string;
  platform: string;
  platform_message_id: string;
  platform_app_id: string;
  level: SkillFeedbackLevel;
  context_json: string | null;
  created_at: string;
}

interface FeedbackRow {
  feedback_id: string;
  delivery_id: string;
  operator_subject_id: string;
  revision: number;
  result: string;
  reason_key: string | null;
  callback_key: string;
  supersedes_feedback_id: string | null;
  created_at: string;
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function contentHash(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

const SCHEMA_VERSION = 1;

export class SkillFeedbackStore {
  readonly path: string;
  private readonly db: DatabaseSyncType;

  private constructor(dataDir: string, db: DatabaseSyncType) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, 'botmux-feedback.sqlite');
    this.db = db;
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = Number((this.db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      throw new Error(`skill_feedback_schema_newer:${version}`);
    }
    if (version === 0) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS interactions (
        interaction_id TEXT PRIMARY KEY,
        context_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_runs (
        skill_run_id TEXT PRIMARY KEY,
        interaction_id TEXT NOT NULL REFERENCES interactions(interaction_id),
        skill_ref TEXT NOT NULL,
        context_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS responses (
        response_id TEXT PRIMARY KEY,
        interaction_id TEXT NOT NULL REFERENCES interactions(interaction_id),
        skill_run_id TEXT REFERENCES skill_runs(skill_run_id),
        content_hash TEXT NOT NULL,
        content_ref TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS responses_identity
        ON responses(interaction_id, content_hash);
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id TEXT PRIMARY KEY,
        response_id TEXT NOT NULL REFERENCES responses(response_id),
        platform TEXT NOT NULL,
        platform_message_id TEXT NOT NULL,
        platform_app_id TEXT NOT NULL,
        level TEXT NOT NULL CHECK(level IN ('L0','L1','L2')),
        context_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(platform, platform_app_id, platform_message_id)
      );
      CREATE TABLE IF NOT EXISTS feedback_revisions (
        feedback_id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES deliveries(delivery_id),
        operator_subject_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        result TEXT NOT NULL,
        reason_key TEXT,
        callback_key TEXT NOT NULL UNIQUE,
        supersedes_feedback_id TEXT REFERENCES feedback_revisions(feedback_id),
        created_at TEXT NOT NULL,
        UNIQUE(delivery_id, operator_subject_id, revision)
      );
      PRAGMA user_version=1;
      COMMIT;
    `);
    this.validateSchemaV1();
  }

  static async open(dataDir: string): Promise<SkillFeedbackStore> {
    const { DatabaseSync } = await import('node:sqlite');
    const path = join(dataDir, 'botmux-feedback.sqlite');
    mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(path);
    try {
      return new SkillFeedbackStore(dataDir, db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  private validateSchemaV1(): void {
    const required = ['interactions', 'skill_runs', 'responses', 'deliveries', 'feedback_revisions'];
    for (const table of required) {
      const row = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table) as any;
      if (!row) throw new Error(`skill_feedback_schema_invalid:missing_${table}`);
    }
  }

  pragmas(): { journalMode: string; foreignKeys: number; busyTimeout: number } {
    return {
      journalMode: String((this.db.prepare('PRAGMA journal_mode').get() as any)?.journal_mode ?? '').toLowerCase(),
      foreignKeys: Number((this.db.prepare('PRAGMA foreign_keys').get() as any)?.foreign_keys ?? 0),
      busyTimeout: Number((this.db.prepare('PRAGMA busy_timeout').get() as any)?.timeout ?? 0),
    };
  }

  debugCounts(): { responses: number; deliveries: number } {
    return {
      responses: Number((this.db.prepare('SELECT COUNT(*) AS count FROM responses').get() as any).count),
      deliveries: Number((this.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as any).count),
    };
  }

  schemaVersion(): number {
    return Number((this.db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
  }

  createResponse(input: {
    interactionId: string;
    skillRunId?: string;
    content: string;
    contentRef?: string;
    context?: SkillFeedbackContext;
  }): { responseId: string; interactionId: string; contentHash: string; contentRef?: string } {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO interactions(interaction_id, context_json, created_at) VALUES (?, ?, ?)`)
      .run(input.interactionId, input.context ? JSON.stringify(input.context) : null, now);
    const hash = contentHash(input.content);
    const responseId = stableId('resp', input.interactionId, hash);
    this.db.prepare(`INSERT INTO responses(response_id, interaction_id, skill_run_id, content_hash, content_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(interaction_id, content_hash) DO NOTHING`)
      .run(responseId, input.interactionId, input.skillRunId ?? null, hash, input.contentRef ?? null, now);
    const row = this.db.prepare('SELECT * FROM responses WHERE interaction_id=? AND content_hash=?')
      .get(input.interactionId, hash) as unknown as ResponseRow;
    return this.mapResponse(row);
  }

  getResponse(responseId: string): ReturnType<SkillFeedbackStore['mapResponse']> | undefined {
    const row = this.db.prepare('SELECT * FROM responses WHERE response_id=?').get(responseId) as unknown as ResponseRow | undefined;
    return row ? this.mapResponse(row) : undefined;
  }

  createDelivery(input: {
    responseId: string;
    platform: string;
    platformAppId: string;
    platformMessageId: string;
    level?: SkillFeedbackLevel;
    context?: SkillFeedbackContext;
  }): ReturnType<SkillFeedbackStore['mapDelivery']> {
    const row: DeliveryRow = {
      delivery_id: stableId('del', input.platform, input.platformAppId, input.platformMessageId), response_id: input.responseId, platform: input.platform,
      platform_message_id: input.platformMessageId, platform_app_id: input.platformAppId, level: input.level ?? 'L1',
      context_json: input.context ? JSON.stringify(input.context) : null, created_at: new Date().toISOString(),
    };
    const winner = this.db.prepare(`INSERT INTO deliveries(delivery_id,response_id,platform,platform_message_id,platform_app_id,level,context_json,created_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(platform,platform_app_id,platform_message_id) DO UPDATE SET platform_message_id=excluded.platform_message_id
      RETURNING *`)
      .get(row.delivery_id, row.response_id, row.platform, row.platform_message_id, row.platform_app_id, row.level, row.context_json, row.created_at) as unknown as DeliveryRow;
    if (winner.response_id !== input.responseId) {
      this.db.prepare(`DELETE FROM responses WHERE response_id=? AND NOT EXISTS (
        SELECT 1 FROM deliveries WHERE response_id=responses.response_id
      )`).run(input.responseId);
    }
    return this.mapDelivery(winner);
  }

  findDeliveryByPlatformMessage(platform: string, platformAppId: string, platformMessageId: string): ReturnType<SkillFeedbackStore['mapDelivery']> | undefined {
    const row = this.db.prepare('SELECT * FROM deliveries WHERE platform=? AND platform_app_id=? AND platform_message_id=?')
      .get(platform, platformAppId, platformMessageId) as unknown as DeliveryRow | undefined;
    return row ? this.mapDelivery(row) : undefined;
  }

  recordFeedback(input: {
    platform: string;
    platformAppId: string;
    platformMessageId: string;
    operatorSubjectId: string;
    result: string;
    reasonKey?: string;
    callbackKey: string;
  }): { status: 'accepted' | 'duplicate' | 'revised'; feedback: ReturnType<SkillFeedbackStore['mapFeedback']>; feedbackId?: string } {
    const delivery = this.findDeliveryByPlatformMessage(input.platform, input.platformAppId, input.platformMessageId);
    if (!delivery) throw new Error('feedback_delivery_not_found');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const duplicate = this.db.prepare('SELECT * FROM feedback_revisions WHERE callback_key=?').get(input.callbackKey) as unknown as FeedbackRow | undefined;
      if (duplicate) {
        if (duplicate.delivery_id !== delivery.deliveryId || duplicate.operator_subject_id !== input.operatorSubjectId) {
          throw new Error('feedback_callback_key_conflict');
        }
        this.db.exec('COMMIT');
        const feedback = this.mapFeedback(duplicate);
        return { status: 'duplicate', feedback, feedbackId: feedback.feedbackId };
      }
      const previous = this.db.prepare(`SELECT * FROM feedback_revisions WHERE delivery_id=? AND operator_subject_id=? ORDER BY revision DESC LIMIT 1`)
        .get(delivery.deliveryId, input.operatorSubjectId) as unknown as FeedbackRow | undefined;
      if (previous && previous.result === input.result && (previous.reason_key ?? undefined) === input.reasonKey) {
        this.db.exec('COMMIT');
        return { status: 'duplicate', feedback: this.mapFeedback(previous), feedbackId: previous.feedback_id };
      }
      const row: FeedbackRow = {
        feedback_id: id('fb'), delivery_id: delivery.deliveryId, operator_subject_id: input.operatorSubjectId,
        revision: (previous?.revision ?? 0) + 1, result: input.result, reason_key: input.reasonKey ?? null,
        callback_key: input.callbackKey, supersedes_feedback_id: previous?.feedback_id ?? null, created_at: new Date().toISOString(),
      };
      this.db.prepare(`INSERT INTO feedback_revisions(feedback_id,delivery_id,operator_subject_id,revision,result,reason_key,callback_key,supersedes_feedback_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(row.feedback_id, row.delivery_id, row.operator_subject_id, row.revision, row.result, row.reason_key, row.callback_key, row.supersedes_feedback_id, row.created_at);
      this.db.exec('COMMIT');
      return { status: previous ? 'revised' : 'accepted', feedback: this.mapFeedback(row) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      const duplicate = this.db.prepare('SELECT * FROM feedback_revisions WHERE callback_key=?').get(input.callbackKey) as unknown as FeedbackRow | undefined;
      if (duplicate) {
        if (duplicate.delivery_id !== delivery.deliveryId || duplicate.operator_subject_id !== input.operatorSubjectId) {
          throw new Error('feedback_callback_key_conflict');
        }
        const feedback = this.mapFeedback(duplicate);
        return { status: 'duplicate', feedback, feedbackId: feedback.feedbackId };
      }
      throw error;
    }
  }

  listFeedbackRevisions(deliveryId: string, operatorSubjectId: string): Array<ReturnType<SkillFeedbackStore['mapFeedback']>> {
    return (this.db.prepare(`SELECT * FROM feedback_revisions WHERE delivery_id=? AND operator_subject_id=? ORDER BY revision`).all(deliveryId, operatorSubjectId) as unknown as FeedbackRow[])
      .map(row => this.mapFeedback(row));
  }

  private mapResponse(row: ResponseRow) {
    return { responseId: row.response_id, interactionId: row.interaction_id, skillRunId: row.skill_run_id ?? undefined, contentHash: row.content_hash, contentRef: row.content_ref ?? undefined, createdAt: row.created_at };
  }

  private mapDelivery(row: DeliveryRow) {
    return { deliveryId: row.delivery_id, responseId: row.response_id, platform: row.platform, platformAppId: row.platform_app_id, platformMessageId: row.platform_message_id, level: row.level, context: row.context_json ? JSON.parse(row.context_json) : undefined, createdAt: row.created_at };
  }

  private mapFeedback(row: FeedbackRow) {
    return { feedbackId: row.feedback_id, deliveryId: row.delivery_id, operatorSubjectId: row.operator_subject_id, revision: row.revision, result: row.result, reasonKey: row.reason_key ?? undefined, callbackKey: row.callback_key, supersedesFeedbackId: row.supersedes_feedback_id ?? undefined, createdAt: row.created_at };
  }
}

const stores = new Map<string, Promise<SkillFeedbackStore>>();

export function getSkillFeedbackStore(dataDir: string): Promise<SkillFeedbackStore> {
  let store = stores.get(dataDir);
  if (!store) {
    store = SkillFeedbackStore.open(dataDir);
    stores.set(dataDir, store);
  }
  return store;
}
