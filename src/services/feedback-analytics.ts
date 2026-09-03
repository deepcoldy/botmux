import { join } from 'node:path';
import { openDatabaseSyncNow, type DatabaseSyncLike } from './sqlite-compat.js';

export interface FeedbackAnalyticsFilters {
  from: string;
  to: string;
  teamId?: string;
  botAppId?: string;
  chatId?: string;
  topicRootId?: string;
  semantic?: string;
  verdictKey?: string;
  reasonKey?: string;
  model?: string;
  cliId?: string;
  cliVersion?: string;
  skillName?: string;
  skillVersion?: string;
  workflowId?: string;
  taskId?: string;
  status?: string;
}

export interface FeedbackAnalyticsSummary {
  delivered: number;
  ratedDeliveries: number;
  ratings: number;
  positive: number;
  negative: number;
  progress: number;
  ratingCoverage: number;
  positiveRate: number;
  deliveryFailures: number;
  outboxFailures: number;
}

export interface FeedbackDeliveryAnalyticsItem {
  deliveryId: string; createdAt: string; completedAt?: string; status?: string; contentHash: string; contentRef?: string;
  platform: string; platformMessageId: string; platformAppId: string; botAppId?: string; sessionId?: string; turnId?: string;
  chatId?: string; topicRootId?: string; workflowId?: string; taskId?: string; cliId?: string; cliVersion?: string;
  model?: string; skillName?: string; skillVersion?: string; semantic?: string; verdictKey?: string; reasonKey?: string;
}

type SqlParts = { where: string; params: Array<string | number> };

function bounded(filters: FeedbackAnalyticsFilters): void {
  const from = Date.parse(filters.from); const to = Date.parse(filters.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('feedback_analytics_invalid_range');
  if (to - from > 366 * 24 * 60 * 60 * 1000) throw new Error('feedback_analytics_range_too_large');
}

function deliveryWhere(filters: FeedbackAnalyticsFilters): SqlParts {
  bounded(filters);
  const clauses = ['d.created_at>=?', 'd.created_at<?']; const params: Array<string | number> = [filters.from, filters.to];
  const columns: Array<[keyof FeedbackAnalyticsFilters, string]> = [
    ['botAppId', 'd.bot_app_id'], ['chatId', 'd.chat_id'], ['topicRootId', 'd.topic_root_id'], ['model', 'd.model'],
    ['cliId', 'd.cli_id'], ['cliVersion', 'd.cli_version'], ['skillName', 'd.skill_name'], ['skillVersion', 'd.skill_version'],
    ['workflowId', 'd.workflow_id'], ['taskId', 'd.task_id'], ['status', 'd.status'],
  ];
  for (const [key, column] of columns) if (filters[key]) { clauses.push(`${column}=?`); params.push(filters[key] as string); }
  if (filters.teamId) { clauses.push("json_extract(d.context_json,'$.teamId')=?"); params.push(filters.teamId); }
  return { where: clauses.join(' AND '), params };
}

function feedbackWhere(filters: FeedbackAnalyticsFilters): SqlParts {
  const base = deliveryWhere(filters); const clauses = [base.where]; const params = [...base.params];
  const fields: Array<[keyof FeedbackAnalyticsFilters, string]> = [['semantic', 'lf.semantic'], ['verdictKey', 'lf.result'], ['reasonKey', 'lf.reason_key']];
  for (const [key, column] of fields) if (filters[key]) { clauses.push(`${column}=?`); params.push(filters[key] as string); }
  return { where: clauses.join(' AND '), params };
}

const LATEST = `SELECT f.* FROM feedback_revisions f JOIN (SELECT delivery_id,operator_subject_id,MAX(revision) revision FROM feedback_revisions GROUP BY delivery_id,operator_subject_id) x ON x.delivery_id=f.delivery_id AND x.operator_subject_id=f.operator_subject_id AND x.revision=f.revision`;

export class FeedbackAnalyticsService {
  private readonly db: DatabaseSyncLike;
  constructor(dataDir: string) {
    // Runtime-agnostic read-only open: node:sqlite on Node, bun:sqlite on the
    // compiled binary. Throws (like the previous `new DatabaseSync`) if neither
    // engine loads or the DB can't be opened — callers already handle that.
    const db = openDatabaseSyncNow(join(dataDir, 'botmux-feedback.sqlite'), { readOnly: true });
    if (!db) throw new Error('feedback analytics: no SQLite engine available (node:sqlite / bun:sqlite)');
    this.db = db;
  }
  close(): void { this.db.close(); }
  summary(filters: FeedbackAnalyticsFilters): FeedbackAnalyticsSummary {
    const delivery = deliveryWhere(filters); const feedback = feedbackWhere(filters);
    const d = this.db.prepare(`SELECT COUNT(*) delivered, SUM(CASE WHEN d.status='failed' THEN 1 ELSE 0 END) delivery_failures FROM deliveries d WHERE ${delivery.where}`).get(...delivery.params) as any;
    const f = this.db.prepare(`SELECT COUNT(*) ratings, COUNT(DISTINCT d.delivery_id) rated_deliveries, SUM(CASE WHEN lf.semantic='positive' THEN 1 ELSE 0 END) positive, SUM(CASE WHEN lf.semantic='negative' THEN 1 ELSE 0 END) negative, SUM(CASE WHEN lf.semantic='progress' THEN 1 ELSE 0 END) progress FROM deliveries d JOIN (${LATEST}) lf ON lf.delivery_id=d.delivery_id WHERE ${feedback.where}`).get(...feedback.params) as any;
    const outbox = this.db.prepare(`SELECT COUNT(*) failures FROM feedback_outbox WHERE status='failed' AND created_at>=? AND created_at<?`).get(filters.from, filters.to) as any;
    const delivered = Number(d.delivered ?? 0); const ratings = Number(f.ratings ?? 0); const ratedDeliveries = Number(f.rated_deliveries ?? 0); const positive = Number(f.positive ?? 0);
    return { delivered, ratedDeliveries, ratings, positive, negative: Number(f.negative ?? 0), progress: Number(f.progress ?? 0), ratingCoverage: delivered ? ratedDeliveries / delivered : 0, positiveRate: ratings ? positive / ratings : 0, deliveryFailures: Number(d.delivery_failures ?? 0), outboxFailures: Number(outbox.failures ?? 0) };
  }
  trend(filters: FeedbackAnalyticsFilters): Array<{ bucket: string; positive: number; negative: number; progress: number; ratings: number }> {
    const sql = feedbackWhere(filters);
    return (this.db.prepare(`SELECT substr(d.created_at,1,10) bucket, SUM(lf.semantic='positive') positive, SUM(lf.semantic='negative') negative, SUM(lf.semantic='progress') progress, COUNT(*) ratings FROM deliveries d JOIN (${LATEST}) lf ON lf.delivery_id=d.delivery_id WHERE ${sql.where} GROUP BY bucket ORDER BY bucket`).all(...sql.params) as any[])
      .map(row => ({ bucket: row.bucket, positive: Number(row.positive), negative: Number(row.negative), progress: Number(row.progress), ratings: Number(row.ratings) }));
  }
  reasons(filters: FeedbackAnalyticsFilters): Array<{ reasonKey: string; count: number }> {
    const sql = feedbackWhere(filters);
    return (this.db.prepare(`SELECT lf.reason_key reason_key,COUNT(*) count FROM deliveries d JOIN (${LATEST}) lf ON lf.delivery_id=d.delivery_id WHERE ${sql.where} AND lf.reason_key IS NOT NULL GROUP BY lf.reason_key ORDER BY count DESC,reason_key`).all(...sql.params) as any[])
      .map(row => ({ reasonKey: row.reason_key, count: Number(row.count) }));
  }
  deliveries(filters: FeedbackAnalyticsFilters, page: { limit?: number; cursor?: string } = {}): { items: FeedbackDeliveryAnalyticsItem[]; nextCursor?: string } {
    const sql = feedbackWhere(filters); const limit = Math.max(1, Math.min(page.limit ?? 50, 100));
    if (page.cursor) {
      let cursor: { createdAt: string; deliveryId: string };
      try { cursor = JSON.parse(Buffer.from(page.cursor, 'base64url').toString('utf8')); } catch { throw new Error('feedback_analytics_invalid_cursor'); }
      sql.where += ' AND (d.created_at<? OR (d.created_at=? AND d.delivery_id<?))'; sql.params.push(cursor.createdAt, cursor.createdAt, cursor.deliveryId);
    }
    const rows = this.db.prepare(`SELECT d.delivery_id,d.created_at,d.completed_at,d.status,r.content_hash,r.content_ref,d.platform,d.platform_message_id,d.platform_app_id,d.bot_app_id,d.session_id,d.turn_id,d.chat_id,d.topic_root_id,d.workflow_id,d.task_id,d.cli_id,d.cli_version,d.model,d.skill_name,d.skill_version,lf.semantic,lf.result,lf.reason_key FROM deliveries d JOIN responses r ON r.response_id=d.response_id LEFT JOIN (${LATEST}) lf ON lf.delivery_id=d.delivery_id WHERE ${sql.where} ORDER BY d.created_at DESC,d.delivery_id DESC LIMIT ?`).all(...sql.params, limit + 1) as any[];
    const hasMore = rows.length > limit; const selected = rows.slice(0, limit);
    const items = selected.map(row => ({ deliveryId: row.delivery_id, createdAt: row.created_at, ...(row.completed_at ? { completedAt: row.completed_at } : {}), ...(row.status ? { status: row.status } : {}), contentHash: row.content_hash, ...(row.content_ref ? { contentRef: row.content_ref } : {}), platform: row.platform, platformMessageId: row.platform_message_id, platformAppId: row.platform_app_id, ...(row.bot_app_id ? { botAppId: row.bot_app_id } : {}), ...(row.session_id ? { sessionId: row.session_id } : {}), ...(row.turn_id ? { turnId: row.turn_id } : {}), ...(row.chat_id ? { chatId: row.chat_id } : {}), ...(row.topic_root_id ? { topicRootId: row.topic_root_id } : {}), ...(row.workflow_id ? { workflowId: row.workflow_id } : {}), ...(row.task_id ? { taskId: row.task_id } : {}), ...(row.cli_id ? { cliId: row.cli_id } : {}), ...(row.cli_version ? { cliVersion: row.cli_version } : {}), ...(row.model ? { model: row.model } : {}), ...(row.skill_name ? { skillName: row.skill_name } : {}), ...(row.skill_version ? { skillVersion: row.skill_version } : {}), ...(row.semantic ? { semantic: row.semantic } : {}), ...(row.result ? { verdictKey: row.result } : {}), ...(row.reason_key ? { reasonKey: row.reason_key } : {}) }));
    const last = selected.at(-1); const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ createdAt: last.created_at, deliveryId: last.delivery_id })).toString('base64url') : undefined;
    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }
}
