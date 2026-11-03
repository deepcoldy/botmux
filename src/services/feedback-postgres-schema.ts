import { Pool, type PoolClient } from 'pg';
import type { PostgresTarget } from './feedback-storage-types.js';

export function feedbackPostgresPool(target: PostgresTarget, password: string, ca?: string): Pool {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(target.schema)) throw new Error('feedback_storage_schema_invalid');
  if (target.tls.caRef && !ca) throw new Error('feedback_storage_ca_missing');
  const pool = new Pool({
    host: target.host, port: target.port, database: target.database, user: target.user, password,
    ssl: target.tls.mode === 'disable' ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    connectionTimeoutMillis: target.connectTimeoutMs, idleTimeoutMillis: 10000, max: 5,
    statement_timeout: 30000, options: `-c search_path=${target.schema},pg_catalog`,
  });
  pool.on('error', () => {
    process.stderr.write('[feedback] PostgreSQL idle connection lost; reconnecting on next operation\n');
  });
  return pool;
}

export const FEEDBACK_TABLES = [
  'interactions', 'skill_runs', 'responses', 'deliveries', 'feedback_revisions',
  'turn_terminals', 'turn_completion_events', 'feedback_events', 'feedback_outbox',
] as const;

export async function ensurePostgresFeedbackSchema(client: PoolClient, schema: string, instanceId: string, migrationId?: string, provision = false): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('feedback_storage_schema_invalid');
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`botmux-feedback-schema:${schema}`]);
    const exists = await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema]);
    if (exists.rowCount) {
      const meta = await client.query('SELECT to_regclass($1) name', [`${schema}.feedback_storage_meta`]);
      if (!meta.rows[0].name) throw new Error('feedback_storage_target_not_empty');
      const result = await client.query('SELECT version,instance_id,state,migration_id FROM feedback_storage_meta WHERE singleton=1');
      if (result.rows[0]?.instance_id !== instanceId || result.rows[0]?.version !== 1) throw new Error('feedback_storage_target_identity_conflict');
      if (migrationId ? result.rows[0]?.migration_id !== migrationId : result.rows[0]?.state !== 'active') throw new Error('feedback_storage_target_not_active');
      await client.query('COMMIT');
      return;
    }
    if (!migrationId && !provision) throw new Error('feedback_storage_schema_missing');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`
      CREATE TABLE feedback_storage_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,instance_id TEXT NOT NULL,state TEXT NOT NULL,migration_id TEXT,source_fingerprint TEXT,verified INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE interactions(interaction_id TEXT PRIMARY KEY,context_json TEXT,created_at TEXT NOT NULL);
      CREATE TABLE skill_runs(skill_run_id TEXT PRIMARY KEY,interaction_id TEXT NOT NULL REFERENCES interactions,skill_ref TEXT NOT NULL,context_json TEXT,created_at TEXT NOT NULL);
      CREATE TABLE responses(response_id TEXT PRIMARY KEY,interaction_id TEXT NOT NULL REFERENCES interactions,skill_run_id TEXT REFERENCES skill_runs,content_hash TEXT NOT NULL,content_ref TEXT,created_at TEXT NOT NULL,UNIQUE(interaction_id,content_hash));
      CREATE TABLE deliveries(
        delivery_id TEXT PRIMARY KEY,response_id TEXT NOT NULL REFERENCES responses,platform TEXT NOT NULL,
        platform_message_id TEXT NOT NULL,platform_app_id TEXT NOT NULL,level TEXT NOT NULL DEFAULT 'L1' CHECK(level IN ('L0','L1','L2')),
        policy_snapshot_json TEXT,base_card_json TEXT,requester_subject_id TEXT,context_json TEXT,created_at TEXT NOT NULL,
        bot_app_id TEXT,session_id TEXT,turn_id TEXT,native_session_id TEXT,dispatch_attempt INTEGER,chat_id TEXT,
        topic_root_id TEXT,scope TEXT,workflow_id TEXT,task_id TEXT,parent_task_id TEXT,cli_id TEXT,cli_version TEXT,
        model TEXT,reasoning_effort TEXT,skill_name TEXT,skill_version TEXT,card_mode TEXT,status TEXT,duration_ms BIGINT,
        usage_json TEXT,completed_at TEXT,webhook_destinations_json TEXT,correlation_discriminator TEXT NOT NULL DEFAULT '',
        UNIQUE(platform,platform_app_id,platform_message_id));
      CREATE UNIQUE INDEX deliveries_correlation_identity ON deliveries(bot_app_id,session_id,turn_id,COALESCE(native_session_id,''),COALESCE(dispatch_attempt,0),correlation_discriminator) WHERE bot_app_id IS NOT NULL AND session_id IS NOT NULL AND turn_id IS NOT NULL;
      CREATE INDEX deliveries_created ON deliveries(created_at,delivery_id);
      CREATE TABLE feedback_revisions(
        feedback_id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL REFERENCES deliveries,operator_subject_id TEXT NOT NULL,
        revision INTEGER NOT NULL,result TEXT NOT NULL,semantic TEXT,reason_key TEXT,comment_text TEXT,callback_key TEXT NOT NULL UNIQUE,
        supersedes_feedback_id TEXT REFERENCES feedback_revisions,created_at TEXT NOT NULL,feedback_order BIGINT GENERATED BY DEFAULT AS IDENTITY,
        UNIQUE(delivery_id,operator_subject_id,revision));
      CREATE INDEX feedback_latest ON feedback_revisions(delivery_id,operator_subject_id,revision DESC);
      CREATE TABLE turn_terminals(
        bot_app_id TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,dispatch_attempt INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN ('completed','failed','cancelled','ambiguous')),completed_at TEXT NOT NULL,
        duration_ms BIGINT,usage_json TEXT,completed_at_estimated INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(bot_app_id,session_id,turn_id,dispatch_attempt));
      CREATE TABLE turn_completion_events(event_id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL UNIQUE REFERENCES deliveries,event_type TEXT NOT NULL CHECK(event_type='turn.completed'),version INTEGER NOT NULL CHECK(version=1),payload_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE feedback_events(event_id TEXT PRIMARY KEY,event_type TEXT NOT NULL CHECK(event_type IN ('turn.completed','feedback.revised')),version INTEGER NOT NULL CHECK(version=1),aggregate_id TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE feedback_outbox(
        outbox_id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES feedback_events,destination_id TEXT NOT NULL,
        destination_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','inflight','delivered','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at BIGINT NOT NULL,claimed_at BIGINT,claim_token TEXT,
        last_http_status INTEGER,last_error TEXT,delivered_at TEXT,created_at TEXT NOT NULL,UNIQUE(event_id,destination_id));
      CREATE INDEX feedback_outbox_due ON feedback_outbox(status,next_attempt_at);
    `);
    await client.query('INSERT INTO feedback_storage_meta(singleton,version,instance_id,state,migration_id) VALUES(1,1,$1,$2,$3)', [instanceId, migrationId ? 'migrating' : 'active', migrationId ?? null]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
