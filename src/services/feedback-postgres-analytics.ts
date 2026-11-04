import type { Pool } from 'pg';
import type { FeedbackAnalytics, PostgresTarget } from './feedback-storage-types.js';
import type { FeedbackAnalyticsFilters, FeedbackDeliveryAnalyticsItem } from './feedback-analytics.js';
import { feedbackPostgresPool } from './feedback-postgres-schema.js';
import type { PostgresCredential } from './feedback-doas-token.js';

const latest = `SELECT DISTINCT ON(delivery_id,operator_subject_id) * FROM feedback_revisions ORDER BY delivery_id,operator_subject_id,revision DESC`;
function where(filters: FeedbackAnalyticsFilters, feedback = false) {
  const from = Date.parse(filters.from), to = Date.parse(filters.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('feedback_analytics_invalid_range');
  if (to - from > 366 * 86400000) throw new Error('feedback_analytics_range_too_large');
  const values: unknown[] = [filters.from, filters.to];
  const clauses = ['d.created_at >= $1', 'd.created_at < $2'];
  const fields: Array<[keyof FeedbackAnalyticsFilters, string]> = [
    ['botAppId', 'd.bot_app_id'], ['chatId', 'd.chat_id'], ['topicRootId', 'd.topic_root_id'],
    ['model', 'd.model'], ['cliId', 'd.cli_id'], ['cliVersion', 'd.cli_version'], ['skillName', 'd.skill_name'],
    ['skillVersion', 'd.skill_version'], ['workflowId', 'd.workflow_id'], ['taskId', 'd.task_id'],
    ['status', 'd.status'], ['teamId', "(d.context_json::jsonb->>'teamId')"],
  ];
  if (feedback) fields.push(['semantic', 'lf.semantic'], ['verdictKey', 'lf.result'], ['reasonKey', 'lf.reason_key']);
  for (const [key, column] of fields) {
    if (filters[key]) { values.push(filters[key]); clauses.push(`${column}=$${values.length}`); }
  }
  return { clause: clauses.join(' AND '), values };
}

class PostgresFeedbackAnalytics implements FeedbackAnalytics {
  constructor(private readonly pool: Pool) {}
  async close(): Promise<void> { await this.pool.end(); }
  async summary(filters: FeedbackAnalyticsFilters) {
    const delivery = where(filters), feedback = where(filters, true);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const deliveries = (await client.query(`SELECT COUNT(*) delivered,COUNT(*) FILTER(WHERE status='failed') failures FROM deliveries d WHERE ${delivery.clause}`, delivery.values)).rows[0];
      const votes = (await client.query(`SELECT COUNT(*) ratings,COUNT(DISTINCT d.delivery_id) rated,COUNT(*) FILTER(WHERE lf.semantic='positive') positive,COUNT(*) FILTER(WHERE lf.semantic='negative') negative,COUNT(*) FILTER(WHERE lf.semantic='progress') progress FROM deliveries d JOIN (${latest}) lf ON lf.delivery_id=d.delivery_id WHERE ${feedback.clause}`, feedback.values)).rows[0];
      const outbox = (await client.query(`SELECT COUNT(*) failures FROM feedback_outbox o JOIN feedback_events e ON e.event_id=o.event_id LEFT JOIN feedback_revisions f ON e.event_type='feedback.revised' AND f.feedback_id=e.aggregate_id JOIN deliveries d ON d.delivery_id=CASE WHEN e.event_type='turn.completed' THEN e.aggregate_id ELSE f.delivery_id END WHERE o.status='failed' AND ${delivery.clause}`, delivery.values)).rows[0];
      await client.query('COMMIT');
      const delivered = Number(deliveries.delivered), ratings = Number(votes.ratings), ratedDeliveries = Number(votes.rated), positive = Number(votes.positive);
      return { delivered, ratings, ratedDeliveries, positive, negative: Number(votes.negative), progress: Number(votes.progress), ratingCoverage: delivered ? ratedDeliveries / delivered : 0, positiveRate: ratings ? positive / ratings : 0, deliveryFailures: Number(deliveries.failures), outboxFailures: Number(outbox.failures) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  async trend(filters: FeedbackAnalyticsFilters) {
    const query = where(filters, true);
    return (await this.pool.query(`SELECT substr(d.created_at,1,10) bucket,COUNT(*) FILTER(WHERE lf.semantic='positive') positive,COUNT(*) FILTER(WHERE lf.semantic='negative') negative,COUNT(*) FILTER(WHERE lf.semantic='progress') progress,COUNT(*) ratings FROM deliveries d JOIN (${latest}) lf ON lf.delivery_id=d.delivery_id WHERE ${query.clause} GROUP BY bucket ORDER BY bucket`, query.values)).rows.map(row => ({ bucket: String(row.bucket), positive: Number(row.positive), negative: Number(row.negative), progress: Number(row.progress), ratings: Number(row.ratings) }));
  }
  async reasons(filters: FeedbackAnalyticsFilters) {
    const query = where(filters, true);
    return (await this.pool.query(`SELECT lf.reason_key,COUNT(*) count FROM deliveries d JOIN (${latest}) lf ON lf.delivery_id=d.delivery_id WHERE ${query.clause} AND lf.reason_key IS NOT NULL GROUP BY lf.reason_key ORDER BY count DESC,lf.reason_key`, query.values)).rows.map(row => ({ reasonKey: String(row.reason_key), count: Number(row.count) }));
  }
  async deliveries(filters: FeedbackAnalyticsFilters, page: { limit?: number; cursor?: string } = {}) {
    const query = where(filters, true);
    const limit = Math.max(1, Math.min(page.limit ?? 50, 100));
    if (!Number.isInteger(limit)) throw new Error('feedback_analytics_invalid_limit');
    if (page.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(page.cursor, 'base64url').toString());
        if (typeof cursor.createdAt !== 'string' || typeof cursor.deliveryId !== 'string') throw new Error();
        query.values.push(cursor.createdAt, cursor.deliveryId);
        query.clause += ` AND (d.created_at,d.delivery_id)<($${query.values.length - 1},$${query.values.length})`;
      } catch { throw new Error('feedback_analytics_invalid_cursor'); }
    }
    query.values.push(limit + 1);
    const rows = (await this.pool.query(`SELECT d.*,r.content_hash,r.content_ref,lf.semantic,lf.result,lf.reason_key FROM deliveries d JOIN responses r ON r.response_id=d.response_id LEFT JOIN (${latest}) lf ON lf.delivery_id=d.delivery_id WHERE ${query.clause} ORDER BY d.created_at DESC,d.delivery_id DESC LIMIT $${query.values.length}`, query.values)).rows;
    const selected = rows.slice(0, limit);
    const items = selected.map(row => {
      const item: Record<string, unknown> = {};
      for (const column of ['delivery_id', 'created_at', 'completed_at', 'status', 'content_hash', 'content_ref', 'platform', 'platform_message_id', 'platform_app_id', 'bot_app_id', 'session_id', 'turn_id', 'chat_id', 'topic_root_id', 'workflow_id', 'task_id', 'cli_id', 'cli_version', 'model', 'skill_name', 'skill_version', 'semantic', 'reason_key']) {
        if (row[column]) item[column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = row[column];
      }
      if (row.result) item.verdictKey = row.result;
      return item as unknown as FeedbackDeliveryAnalyticsItem;
    });
    const last = selected.at(-1);
    const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({ createdAt: last.created_at, deliveryId: last.delivery_id })).toString('base64url') : undefined;
    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }
}
export async function openPostgresFeedbackAnalytics(target: PostgresTarget, password: PostgresCredential, ca?: string): Promise<FeedbackAnalytics> {
  const pool = feedbackPostgresPool(target, password, ca);
  try { await pool.query('SELECT 1'); } catch (error) { await pool.end(); throw error; }
  return new PostgresFeedbackAnalytics(pool);
}
