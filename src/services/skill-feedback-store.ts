import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { normalizeFeedbackPolicy, type FeedbackPolicy } from './feedback-policy.js';
import { effectiveWebhookDestinations, type FeedbackEventEnvelope, type FeedbackEventType, type FeedbackWebhookDestination, type FrozenWebhookDestination } from './feedback-outbox.js';

/** True when a node:sqlite error is the recoverable write-lock contention that
 *  a burst of concurrent cold-start opens against a shared dataDir produces. */
function isSqliteBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === 'ERR_SQLITE_ERROR' || code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
    // ERR_SQLITE_ERROR is generic; fall through to the message check for it.
    if (code !== 'ERR_SQLITE_ERROR') return true;
  }
  const message = String((error as { message?: unknown })?.message ?? error).toLowerCase();
  return message.includes('database is locked') || message.includes('database table is locked')
    || message.includes('sqlite_busy') || message.includes('sqlite_locked');
}

/** Synchronous backoff sleep (the store constructor / migration path is sync).
 *  Uses Atomics.wait on a throwaway buffer so it yields the CPU instead of
 *  spinning. Backoff grows with the attempt, capped, with jitter to de-sync
 *  concurrent cold-start racers. */
function sleepShort(attempt: number): void {
  const base = Math.min(20 * attempt, 120);
  const jitter = Math.floor((Number(process.hrtime.bigint() % 17n))); // 0..16ms, no Math.random needed
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, base + jitter); }
  catch { /* Atomics.wait unavailable (should not happen in Node); fall through */ }
}

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

export type TurnDeliveryScope = 'thread' | 'chat' | 'direct' | 'unknown';
export type TurnDeliveryCardMode = 'feedback' | 'card' | 'text';
export type TurnDeliveryStatus = 'delivered' | 'completed' | 'failed' | 'cancelled' | 'ambiguous';

export interface TurnDeliveryCorrelation {
  botAppId: string;
  sessionId: string;
  turnId: string;
  nativeSessionId?: string;
  platform: string;
  platformMessageId: string;
  platformAppId: string;
  chatId?: string;
  topicRootId?: string;
  dispatchAttempt?: number;
  contentRef?: string;
  scope?: TurnDeliveryScope;
  workflowId?: string;
  taskId?: string;
  parentTaskId?: string;
  cliId?: string;
  cliVersion?: string;
  model?: string;
  reasoningEffort?: string;
  skillName?: string;
  skillVersion?: string;
  cardMode: TurnDeliveryCardMode;
  status: TurnDeliveryStatus;
  durationMs?: number;
  usage?: Record<string, unknown>;
  createdAt?: string;
  completedAt?: string;
}

export interface RecordTurnDeliveryInput extends TurnDeliveryCorrelation {
  content: string;
  policy?: FeedbackPolicy;
  baseCard?: Record<string, unknown>;
  requesterSubjectId?: string;
  webhookDestinations?: FeedbackWebhookDestination[];
  context?: Record<string, unknown>;
  /** Distinguishes multiple canonical deliveries of the same worker turn. */
  correlationDiscriminator?: string;
}

export interface RecordTurnTerminalInput {
  botAppId: string;
  sessionId: string;
  turnId: string;
  nativeSessionId?: string;
  dispatchAttempt?: number;
  status: Exclude<TurnDeliveryStatus, 'delivered'>;
  completedAt?: string;
  durationMs?: number;
  usage?: Record<string, unknown>;
}

export interface TurnCompletionEventPayload {
  type: 'turn.completed'; version: 1; eventId: string; time: string;
  status: Exclude<TurnDeliveryStatus, 'delivered'>; deliveryId: string;
  contentHash: string; contentRef?: string;
  platform: string; platformMessageId: string; platformAppId: string;
  botAppId: string; sessionId: string; turnId: string;
  nativeSessionId?: string; dispatchAttempt?: number; chatId?: string; topicRootId?: string;
  durationMs?: number; usage?: Record<string, unknown>;
  cliId?: string; cliVersion?: string; model?: string; reasoningEffort?: string;
  skillName?: string; skillVersion?: string; workflowId?: string; taskId?: string; parentTaskId?: string;
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
  policy_snapshot_json: string | null;
  base_card_json: string | null;
  requester_subject_id: string | null;
  context_json: string | null;
  created_at: string;
  bot_app_id: string | null;
  session_id: string | null;
  turn_id: string | null;
  native_session_id: string | null;
  dispatch_attempt: number | null;
  chat_id: string | null;
  topic_root_id: string | null;
  scope: string | null;
  workflow_id: string | null;
  task_id: string | null;
  parent_task_id: string | null;
  cli_id: string | null;
  cli_version: string | null;
  model: string | null;
  reasoning_effort: string | null;
  skill_name: string | null;
  skill_version: string | null;
  card_mode: string | null;
  status: string | null;
  duration_ms: number | null;
  usage_json: string | null;
  completed_at: string | null;
  webhook_destinations_json: string | null;
  correlation_discriminator: string | null;
}

interface FeedbackRow {
  feedback_id: string;
  delivery_id: string;
  operator_subject_id: string;
  revision: number;
  result: string;
  semantic: string | null;
  reason_key: string | null;
  comment_text: string | null;
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

/** Persist only the structural card tail needed to rebuild feedback state. */
function feedbackCardTemplate(baseCard: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!baseCard) return undefined;
  const card = structuredClone(baseCard) as any;
  const elements = Array.isArray(card.body?.elements) ? card.body.elements : [];
  const feedbackIndex = elements.findIndex((element: any) => element?.element_id === 'botmux_feedback');
  if (feedbackIndex < 0) return undefined;
  // The platform already owns the answer body. Keeping only feedback and the
  // stable footer prevents analytics storage from becoming an answer archive.
  card.body.elements = elements.slice(feedbackIndex);
  return card as Record<string, unknown>;
}

const SCHEMA_VERSION = 7;

const DELIVERY_V7_SCHEMA = `
  ALTER TABLE deliveries ADD COLUMN correlation_discriminator TEXT NOT NULL DEFAULT '';
  DROP INDEX deliveries_correlation_identity;
  CREATE UNIQUE INDEX deliveries_correlation_identity
    ON deliveries(bot_app_id, session_id, turn_id, IFNULL(native_session_id,''), IFNULL(dispatch_attempt,0), correlation_discriminator, response_id)
    WHERE bot_app_id IS NOT NULL AND session_id IS NOT NULL AND turn_id IS NOT NULL;
`;

const ANALYTICS_V6_SCHEMA = `
  CREATE INDEX IF NOT EXISTS deliveries_analytics_created ON deliveries(created_at, delivery_id);
  CREATE INDEX IF NOT EXISTS deliveries_analytics_bot_created ON deliveries(bot_app_id, created_at, delivery_id);
  CREATE INDEX IF NOT EXISTS deliveries_analytics_chat_created ON deliveries(chat_id, created_at, delivery_id);
  CREATE INDEX IF NOT EXISTS deliveries_analytics_topic_created ON deliveries(topic_root_id, created_at, delivery_id);
  CREATE INDEX IF NOT EXISTS deliveries_analytics_status_completed ON deliveries(status, completed_at, delivery_id);
  CREATE INDEX IF NOT EXISTS deliveries_analytics_model_created ON deliveries(model, created_at, delivery_id);
  CREATE INDEX IF NOT EXISTS deliveries_analytics_cli_created ON deliveries(cli_id, created_at, delivery_id);
  CREATE INDEX IF NOT EXISTS deliveries_analytics_skill_created ON deliveries(skill_name, skill_version, created_at, delivery_id);
  CREATE INDEX IF NOT EXISTS deliveries_analytics_workflow_task_created ON deliveries(workflow_id, task_id, created_at, delivery_id);
  CREATE INDEX IF NOT EXISTS feedback_revisions_analytics_latest ON feedback_revisions(delivery_id, operator_subject_id, revision DESC);
  CREATE INDEX IF NOT EXISTS feedback_revisions_analytics_semantic_created ON feedback_revisions(semantic, created_at, delivery_id);
  CREATE INDEX IF NOT EXISTS feedback_revisions_analytics_verdict_created ON feedback_revisions(result, created_at, delivery_id);
  CREATE INDEX IF NOT EXISTS feedback_revisions_analytics_reason_created ON feedback_revisions(reason_key, created_at, delivery_id);
  CREATE INDEX IF NOT EXISTS feedback_outbox_analytics_status_created ON feedback_outbox(status, created_at, outbox_id);
`;

const OUTBOX_V5_SCHEMA = `
  ALTER TABLE deliveries ADD COLUMN webhook_destinations_json TEXT;
  CREATE TABLE feedback_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL CHECK(event_type IN ('turn.completed','feedback.revised')),
    version INTEGER NOT NULL CHECK(version=1), aggregate_id TEXT NOT NULL,
    payload_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE feedback_outbox (
    outbox_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES feedback_events(event_id),
    destination_id TEXT NOT NULL, destination_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','inflight','delivered','failed')),
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
    claimed_at INTEGER, claim_token TEXT, last_http_status INTEGER, last_error TEXT,
    delivered_at TEXT, created_at TEXT NOT NULL,
    UNIQUE(event_id,destination_id)
  );
  CREATE INDEX feedback_outbox_due ON feedback_outbox(status,next_attempt_at);
`;

const COMPLETION_V4_SCHEMA = `
  CREATE TABLE turn_terminals (
    bot_app_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    dispatch_attempt INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('completed','failed','cancelled','ambiguous')),
    completed_at TEXT NOT NULL, duration_ms INTEGER, usage_json TEXT,
    PRIMARY KEY(bot_app_id,session_id,turn_id,dispatch_attempt)
  );
  CREATE TABLE turn_completion_events (
    event_id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL UNIQUE REFERENCES deliveries(delivery_id),
    event_type TEXT NOT NULL CHECK(event_type='turn.completed'),
    version INTEGER NOT NULL CHECK(version=1), payload_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
`;

const DELIVERY_V3_COLUMNS = `
  ALTER TABLE deliveries ADD COLUMN bot_app_id TEXT;
  ALTER TABLE deliveries ADD COLUMN session_id TEXT;
  ALTER TABLE deliveries ADD COLUMN turn_id TEXT;
  ALTER TABLE deliveries ADD COLUMN native_session_id TEXT;
  ALTER TABLE deliveries ADD COLUMN dispatch_attempt INTEGER;
  ALTER TABLE deliveries ADD COLUMN chat_id TEXT;
  ALTER TABLE deliveries ADD COLUMN topic_root_id TEXT;
  ALTER TABLE deliveries ADD COLUMN scope TEXT;
  ALTER TABLE deliveries ADD COLUMN workflow_id TEXT;
  ALTER TABLE deliveries ADD COLUMN task_id TEXT;
  ALTER TABLE deliveries ADD COLUMN parent_task_id TEXT;
  ALTER TABLE deliveries ADD COLUMN cli_id TEXT;
  ALTER TABLE deliveries ADD COLUMN cli_version TEXT;
  ALTER TABLE deliveries ADD COLUMN model TEXT;
  ALTER TABLE deliveries ADD COLUMN reasoning_effort TEXT;
  ALTER TABLE deliveries ADD COLUMN skill_name TEXT;
  ALTER TABLE deliveries ADD COLUMN skill_version TEXT;
  ALTER TABLE deliveries ADD COLUMN card_mode TEXT;
  ALTER TABLE deliveries ADD COLUMN status TEXT;
  ALTER TABLE deliveries ADD COLUMN duration_ms INTEGER;
  ALTER TABLE deliveries ADD COLUMN usage_json TEXT;
  ALTER TABLE deliveries ADD COLUMN completed_at TEXT;
  CREATE UNIQUE INDEX deliveries_correlation_identity
    ON deliveries(bot_app_id, session_id, turn_id, IFNULL(native_session_id,''), IFNULL(dispatch_attempt,0), response_id)
    WHERE bot_app_id IS NOT NULL AND session_id IS NOT NULL AND turn_id IS NOT NULL;
`;

/** Fresh-build DDL for a brand-new DB (version 0 → 7). No BEGIN/COMMIT/PRAGMA:
 *  migrateStep() owns the transaction and the user_version bump. Base tables use
 *  IF NOT EXISTS so a loser that somehow re-enters is a no-op on them; the later
 *  ${...} fragments (bare ALTER/CREATE) are guarded by migrateStep re-reading
 *  user_version under the write lock, so the loser never reaches this SQL. */
const FRESH_V7_SCHEMA = `
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
    level TEXT NOT NULL DEFAULT 'L1' CHECK(level IN ('L0','L1','L2')),
    policy_snapshot_json TEXT,
    base_card_json TEXT,
    requester_subject_id TEXT,
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
    semantic TEXT,
    reason_key TEXT,
    comment_text TEXT,
    callback_key TEXT NOT NULL UNIQUE,
    supersedes_feedback_id TEXT REFERENCES feedback_revisions(feedback_id),
    created_at TEXT NOT NULL,
    UNIQUE(delivery_id, operator_subject_id, revision)
  );
  ${DELIVERY_V3_COLUMNS}
  ${COMPLETION_V4_SCHEMA}
  ${OUTBOX_V5_SCHEMA}
  ${ANALYTICS_V6_SCHEMA}
  ${DELIVERY_V7_SCHEMA}
`;

/** Legacy v1→v2 columns (no BEGIN/COMMIT/PRAGMA — migrateStep owns those). */
const MIGRATE_V1_TO_V2 = `
  ALTER TABLE deliveries ADD COLUMN policy_snapshot_json TEXT;
  ALTER TABLE deliveries ADD COLUMN base_card_json TEXT;
  ALTER TABLE deliveries ADD COLUMN requester_subject_id TEXT;
  ALTER TABLE feedback_revisions ADD COLUMN comment_text TEXT;
`;

/** Legacy v4→v5: semantic column + outbox tables + backfill events. */
const MIGRATE_V4_TO_V5 = `
  ALTER TABLE feedback_revisions ADD COLUMN semantic TEXT;
  ${OUTBOX_V5_SCHEMA}
  INSERT OR IGNORE INTO feedback_events(event_id,event_type,version,aggregate_id,payload_json,created_at)
    SELECT event_id,event_type,version,delivery_id,payload_json,created_at FROM turn_completion_events;
`;

export class SkillFeedbackStore {
  readonly path: string;
  private readonly db: DatabaseSyncType;

  private constructor(dataDir: string, db: DatabaseSyncType) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, 'botmux-feedback.sqlite');
    this.db = db;
    // Connection init ordering matters under a shared dataDir: busy_timeout MUST
    // be set FIRST so every subsequent lock acquisition (including the WAL-mode
    // switch, which takes a write lock to rewrite the DB header on a fresh file)
    // is protected. journal_mode=WAL is issued separately and wrapped in a
    // bounded busy retry, because on a brand-new file many cold-start processes
    // race for that first write lock and would otherwise fail open with
    // `database is locked` before ever reaching the migration path.
    this.db.exec('PRAGMA busy_timeout=5000;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.enableWalWithRetry();
    const version = Number((this.db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      throw new Error(`skill_feedback_schema_newer:${version}`);
    }
    // Fast path: an already-current DB must NOT enter the migration loop — that
    // would take (and re-take) the write lock only to no-op, turning every plain
    // `botmux send` open into a writer and amplifying the very lock contention
    // we are fixing. Only a stale reader falls through to guarded migration.
    if (version < SCHEMA_VERSION) this.runMigrations();
    this.validateSchemaV1();
  }

  /**
   * Cross-process-safe migration. Multiple OS processes (each PM2 bot daemon
   * plus every `botmux send` subprocess) legitimately open the SAME
   * botmux-feedback.sqlite under a shared dataDir at cold start. The version is
   * therefore re-read INSIDE each step's BEGIN IMMEDIATE write lock: SQLite
   * serializes the writers, so a loser that raced in at version 0 sees the
   * winner's committed version and skips — instead of re-running bare
   * `ALTER TABLE ADD COLUMN` (no IF NOT EXISTS) and throwing `duplicate column`.
   * `BEGIN IMMEDIATE` acquisition is retried on `database is locked` beyond the
   * 5s busy_timeout so a burst of concurrent cold starts settles rather than
   * failing the open (which would poison the module-level store cache).
   */
  private runMigrations(): void {
    // Each step: [applicableFrom, applicableToInclusive, targetVersion, sql].
    // Guarded so it only runs when the version RE-READ under the write lock is
    // still within [from,to]; the fresh-build step (from 0) creates the full v7
    // schema, later steps are incremental ALTER/CREATE for legacy DBs.
    const steps: Array<{ from: number; to: number; target: number; sql: string }> = [
      { from: 0, to: 0, target: 7, sql: FRESH_V7_SCHEMA },
      { from: 1, to: 1, target: 2, sql: MIGRATE_V1_TO_V2 },
      { from: 1, to: 2, target: 3, sql: DELIVERY_V3_COLUMNS },
      { from: 1, to: 3, target: 4, sql: COMPLETION_V4_SCHEMA },
      { from: 1, to: 4, target: 5, sql: MIGRATE_V4_TO_V5 },
      { from: 1, to: 5, target: 6, sql: ANALYTICS_V6_SCHEMA },
      { from: 1, to: 6, target: 7, sql: DELIVERY_V7_SCHEMA },
    ];
    for (const step of steps) {
      // Stop as soon as the DB is fully migrated: a loser that lost every race
      // sees SCHEMA_VERSION on its first guarded step and exits, instead of
      // taking the write lock once per remaining step only to no-op each time.
      if (this.migrateStep(step.from, step.to, step.target, step.sql) >= SCHEMA_VERSION) break;
    }
  }

  /**
   * Apply one migration step atomically and idempotently across processes.
   * Re-reads user_version after acquiring the write lock and only mutates when
   * still in the step's applicable range, so a process that lost the race is a
   * no-op instead of replaying DDL the winner already committed. Returns the
   * version observed under the lock so the caller can stop once fully migrated.
   */
  private migrateStep(from: number, to: number, target: number, sql: string): number {
    let observed = 0;
    this.withImmediateWrite(() => {
      observed = Number((this.db.prepare('PRAGMA user_version').get() as any)?.user_version ?? 0);
      if (observed < from || observed > to) return; // another process already advanced past this step
      this.db.exec(sql);
      this.db.exec(`PRAGMA user_version=${target};`);
      observed = target;
    });
    return observed;
  }

  /**
   * Switch to WAL with bounded retry. `PRAGMA journal_mode=WAL` takes a write
   * lock to rewrite the DB header on a fresh file; under a cold-start stampede
   * it may either throw `database is locked` OR silently return the prior mode
   * (e.g. "delete") without switching. Both are retried — we verify the query
   * result actually reports "wal" rather than trusting a non-throwing call.
   */
  private enableWalWithRetry(): void {
    const maxAttempts = 10;
    for (let attempt = 1; ; attempt++) {
      try {
        const mode = String((this.db.prepare('PRAGMA journal_mode=WAL').get() as any)?.journal_mode ?? '').toLowerCase();
        if (mode === 'wal') return;
        if (attempt < maxAttempts) { sleepShort(attempt); continue; }
        throw new Error(`skill_feedback_wal_mode_not_set:${mode || 'unknown'}`);
      } catch (error) {
        if (isSqliteBusyError(error) && attempt < maxAttempts) { sleepShort(attempt); continue; }
        throw error;
      }
    }
  }

  /**
   * Run `fn` inside a BEGIN IMMEDIATE / COMMIT, retrying the transaction when
   * the write lock cannot be acquired (`database is locked` / `SQLITE_BUSY`)
   * even after busy_timeout — expected when many bot daemons cold-start against
   * a shared dataDir at once. Non-lock errors roll back and rethrow.
   */
  private withImmediateWrite(fn: () => void): void {
    const maxAttempts = 10;
    for (let attempt = 1; ; attempt++) {
      try {
        this.db.exec('BEGIN IMMEDIATE;');
      } catch (error) {
        if (isSqliteBusyError(error) && attempt < maxAttempts) { sleepShort(attempt); continue; }
        throw error;
      }
      try {
        fn();
        this.db.exec('COMMIT;');
        return;
      } catch (error) {
        try { this.db.exec('ROLLBACK;'); } catch { /* connection may already be unwound */ }
        if (isSqliteBusyError(error) && attempt < maxAttempts) { sleepShort(attempt); continue; }
        throw error;
      }
    }
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
    const required = ['interactions', 'skill_runs', 'responses', 'deliveries', 'feedback_revisions', 'turn_terminals', 'turn_completion_events', 'feedback_events', 'feedback_outbox'];
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

  integrityCheck(): { integrity: string; foreignKeys: unknown[] } {
    return {
      integrity: String((this.db.prepare('PRAGMA integrity_check').get() as any)?.integrity_check ?? ''),
      foreignKeys: this.db.prepare('PRAGMA foreign_key_check').all(),
    };
  }

  recordTurnDelivery(input: RecordTurnDeliveryInput): ReturnType<SkillFeedbackStore['mapDelivery']> {
    const hash = contentHash(input.content);
    const attempt = input.dispatchAttempt ?? 0;
    const discriminator = input.correlationDiscriminator ?? '';
    const deliveryId = discriminator
      ? stableId('del', input.botAppId, input.sessionId, input.turnId, input.nativeSessionId ?? '', String(attempt), discriminator)
      : stableId('del', input.botAppId, input.sessionId, input.turnId, input.nativeSessionId ?? '', String(attempt));
    const interactionId = stableId('int', input.botAppId, input.sessionId, input.turnId);
    const responseId = stableId('resp', interactionId, hash);
    const createdAt = input.createdAt ?? new Date().toISOString();
    const baseCard = feedbackCardTemplate(input.baseCard);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const messageOwner = this.db.prepare(
        'SELECT delivery_id FROM deliveries WHERE platform=? AND platform_app_id=? AND platform_message_id=?',
      ).get(input.platform, input.platformAppId, input.platformMessageId) as { delivery_id: string } | undefined;
      if (messageOwner && messageOwner.delivery_id !== deliveryId) throw new Error('turn_delivery_platform_message_rebind');
      const correlationOwner = this.db.prepare(`SELECT platform_message_id FROM deliveries
        WHERE bot_app_id=? AND session_id=? AND turn_id=? AND IFNULL(native_session_id,'')=?
          AND IFNULL(dispatch_attempt,0)=? AND correlation_discriminator=?`).get(
        input.botAppId, input.sessionId, input.turnId, input.nativeSessionId ?? '', attempt, discriminator,
      ) as { platform_message_id: string } | undefined;
      if (correlationOwner && correlationOwner.platform_message_id !== input.platformMessageId) {
        throw new Error('turn_delivery_correlation_rebind');
      }
      this.db.prepare('INSERT OR IGNORE INTO interactions(interaction_id,context_json,created_at) VALUES(?,?,?)')
        .run(interactionId, null, createdAt);
      this.db.prepare(`INSERT OR IGNORE INTO responses(response_id,interaction_id,skill_run_id,content_hash,content_ref,created_at)
        VALUES(?,?,?,?,?,?)`).run(responseId, interactionId, null, hash, input.contentRef ?? null, createdAt);
      this.db.prepare(`INSERT OR IGNORE INTO deliveries(
        delivery_id,response_id,platform,platform_message_id,platform_app_id,level,policy_snapshot_json,base_card_json,
        requester_subject_id,context_json,created_at,bot_app_id,session_id,turn_id,native_session_id,dispatch_attempt,
        chat_id,topic_root_id,scope,workflow_id,task_id,parent_task_id,cli_id,cli_version,model,reasoning_effort,
        skill_name,skill_version,card_mode,status,duration_ms,usage_json,completed_at,webhook_destinations_json,correlation_discriminator
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        deliveryId, responseId, input.platform, input.platformMessageId, input.platformAppId, 'L1',
        input.policy ? JSON.stringify(input.policy) : null, baseCard ? JSON.stringify(baseCard) : null,
        input.requesterSubjectId ?? null, input.context ? JSON.stringify(input.context) : null, createdAt, input.botAppId, input.sessionId, input.turnId,
        input.nativeSessionId ?? null, input.dispatchAttempt ?? null, input.chatId ?? null, input.topicRootId ?? null,
        input.scope ?? null, input.workflowId ?? null, input.taskId ?? null, input.parentTaskId ?? null,
        input.cliId ?? null, input.cliVersion ?? null, input.model ?? null, input.reasoningEffort ?? null,
        input.skillName ?? null, input.skillVersion ?? null, input.cardMode, input.status, input.durationMs ?? null,
        input.usage ? JSON.stringify(input.usage) : null, input.completedAt ?? null,
        input.webhookDestinations ? JSON.stringify(input.webhookDestinations) : null, discriminator,
      );
      const row = this.db.prepare('SELECT * FROM deliveries WHERE delivery_id=?').get(deliveryId) as unknown as DeliveryRow;
      if (row.response_id !== responseId) {
        this.db.prepare(`DELETE FROM responses WHERE response_id=? AND NOT EXISTS (
          SELECT 1 FROM deliveries WHERE response_id=responses.response_id
        )`).run(responseId);
      }
      this.reconcileTurnCompletion(deliveryId);
      const completedRow = this.db.prepare('SELECT * FROM deliveries WHERE delivery_id=?').get(deliveryId) as unknown as DeliveryRow;
      this.db.exec('COMMIT');
      return this.mapDelivery(completedRow);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordTurnTerminal(input: RecordTurnTerminalInput): TurnCompletionEventPayload | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const payload = this.applyTurnTerminal(input);
      this.db.exec('COMMIT');
      return payload;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Nonblocking variant for the daemon's per-turn hot path. Acquiring the write
   * lock with `DatabaseSync` + busy_timeout>0 SYNCHRONOUSLY blocks the whole
   * Node event loop until the lock frees (measured multi-second stalls when a
   * `botmux send` subprocess held the lock). Here we temporarily drop
   * busy_timeout to 0 so `BEGIN IMMEDIATE` fails FAST on contention, return a
   * discriminable {busy:true} instead of throwing, and restore the timeout in
   * finally. The set/try/restore never crosses an await, and no Store method
   * holds a transaction across an await, so no same-process caller can observe
   * the borrowed 0 timeout. The daemon retries busy turns on a timer (which
   * yields the loop between attempts) instead of blocking inline.
   */
  tryRecordTurnTerminal(input: RecordTurnTerminalInput): { done: true; payload: TurnCompletionEventPayload | undefined } | { done: false; busy: true } {
    this.db.exec('PRAGMA busy_timeout=0;');
    try {
      try {
        this.db.exec('BEGIN IMMEDIATE;');
      } catch (error) {
        if (isSqliteBusyError(error)) return { done: false, busy: true };
        throw error;
      }
      try {
        const payload = this.applyTurnTerminal(input);
        this.db.exec('COMMIT');
        return { done: true, payload };
      } catch (error) {
        try { this.db.exec('ROLLBACK;'); } catch { /* already unwound */ }
        if (isSqliteBusyError(error)) return { done: false, busy: true };
        throw error;
      }
    } finally {
      this.db.exec('PRAGMA busy_timeout=5000;');
    }
  }

  /** Shared turn-terminal transaction body (caller owns BEGIN/COMMIT/ROLLBACK). */
  private applyTurnTerminal(input: RecordTurnTerminalInput): TurnCompletionEventPayload | undefined {
    const attempt = input.dispatchAttempt ?? 0;
    const completedAt = input.completedAt ?? new Date().toISOString();
    const prior = this.db.prepare(`SELECT status FROM turn_terminals WHERE bot_app_id=? AND session_id=? AND turn_id=?
      AND dispatch_attempt=?`).get(
      input.botAppId, input.sessionId, input.turnId, attempt,
    ) as { status: string } | undefined;
    if (prior && prior.status !== input.status) throw new Error('turn_terminal_status_conflict');
    this.db.prepare(`INSERT OR IGNORE INTO turn_terminals(
      bot_app_id,session_id,turn_id,dispatch_attempt,status,completed_at,duration_ms,usage_json
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      input.botAppId, input.sessionId, input.turnId, attempt, input.status, completedAt,
      input.durationMs ?? null, input.usage ? JSON.stringify(input.usage) : null,
    );
    const deliveries = this.db.prepare(`SELECT delivery_id FROM deliveries WHERE bot_app_id=? AND session_id=? AND turn_id=?
      AND IFNULL(dispatch_attempt,0)=? ORDER BY created_at,delivery_id`).all(
      input.botAppId, input.sessionId, input.turnId, attempt,
    ) as Array<{ delivery_id: string }>;
    let payload: TurnCompletionEventPayload | undefined;
    for (const delivery of deliveries) payload = this.reconcileTurnCompletion(delivery.delivery_id) ?? payload;
    return payload;
  }

  listTurnCompletionEvents(): Array<{ eventId: string; eventType: 'turn.completed'; version: 1; deliveryId: string; createdAt: string; payload: TurnCompletionEventPayload }> {
    return (this.db.prepare('SELECT * FROM turn_completion_events ORDER BY created_at,event_id').all() as any[]).map(row => ({
      eventId: row.event_id, eventType: row.event_type, version: row.version, deliveryId: row.delivery_id,
      createdAt: row.created_at, payload: JSON.parse(row.payload_json) as TurnCompletionEventPayload,
    }));
  }

  private insertFeedbackEvent(event: FeedbackEventEnvelope | TurnCompletionEventPayload, aggregateId: string, destinations: FeedbackWebhookDestination[]): void {
    const envelope: FeedbackEventEnvelope = 'data' in event ? event : {
      eventId: event.eventId, type: event.type, version: 1, time: event.time,
      data: Object.fromEntries(Object.entries(event).filter(([key]) => !['eventId', 'type', 'version', 'time'].includes(key))),
    };
    this.db.prepare(`INSERT OR IGNORE INTO feedback_events(event_id,event_type,version,aggregate_id,payload_json,created_at) VALUES(?,?,?,?,?,?)`)
      .run(envelope.eventId, envelope.type, 1, aggregateId, JSON.stringify(envelope), envelope.time);
    for (const destination of effectiveWebhookDestinations(envelope.type, [destinations])) {
      this.db.prepare(`INSERT OR IGNORE INTO feedback_outbox(outbox_id,event_id,destination_id,destination_json,status,attempts,next_attempt_at,created_at) VALUES(?,?,?,?,'pending',0,?,?)`)
        .run(stableId('out', envelope.eventId, destination.id), envelope.eventId, destination.id, JSON.stringify(destination), Date.parse(envelope.time) || Date.now(), envelope.time);
    }
  }

  listFeedbackEvents(): Array<FeedbackEventEnvelope> {
    return (this.db.prepare('SELECT payload_json FROM feedback_events ORDER BY created_at,event_id').all() as Array<{ payload_json: string }>)
      .map(row => JSON.parse(row.payload_json) as FeedbackEventEnvelope);
  }

  listFeedbackOutbox(): Array<any> {
    return (this.db.prepare(`SELECT o.*,e.payload_json FROM feedback_outbox o JOIN feedback_events e ON e.event_id=o.event_id ORDER BY o.created_at,o.outbox_id`).all() as any[])
      .map(row => ({ outboxId: row.outbox_id, eventId: row.event_id, destinationId: row.destination_id, destination: JSON.parse(row.destination_json) as FrozenWebhookDestination, status: row.status, attempts: row.attempts, nextAttemptAt: row.next_attempt_at, claimToken: row.claim_token ?? undefined, claimedAt: row.claimed_at ?? undefined, lastHttpStatus: row.last_http_status ?? undefined, lastError: row.last_error ?? undefined, event: JSON.parse(row.payload_json) as FeedbackEventEnvelope }));
  }

  claimFeedbackOutbox(input: { now: number; limit: number; claimToken: string }): Array<any> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ids = (this.db.prepare(`SELECT outbox_id FROM feedback_outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY next_attempt_at,outbox_id LIMIT ?`).all(input.now, Math.max(1, Math.min(input.limit, 100))) as Array<{ outbox_id: string }>).map(row => row.outbox_id);
      for (const outboxId of ids) this.db.prepare(`UPDATE feedback_outbox SET status='inflight',attempts=attempts+1,claimed_at=?,claim_token=? WHERE outbox_id=? AND status='pending'`).run(input.now, input.claimToken, outboxId);
      this.db.exec('COMMIT');
      const wanted = new Set(ids);
      return this.listFeedbackOutbox().filter(row => wanted.has(row.outboxId) && row.claimToken === input.claimToken);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  settleFeedbackOutboxDelivered(outboxId: string, claimToken: string, httpStatus: number, deliveredAt: string): boolean {
    return this.db.prepare(`UPDATE feedback_outbox SET status='delivered',last_http_status=?,delivered_at=?,claim_token=NULL,claimed_at=NULL WHERE outbox_id=? AND status='inflight' AND claim_token=?`).run(httpStatus, deliveredAt, outboxId, claimToken).changes === 1;
  }

  rescheduleFeedbackOutbox(outboxId: string, claimToken: string, input: { now: number; nextAttemptAt: number; error: string; httpStatus?: number; permanent?: boolean }): boolean {
    return this.db.prepare(`UPDATE feedback_outbox SET status=?,next_attempt_at=?,last_error=?,last_http_status=?,claim_token=NULL,claimed_at=NULL WHERE outbox_id=? AND status='inflight' AND claim_token=?`).run(input.permanent ? 'failed' : 'pending', input.nextAttemptAt, input.error.slice(0, 500), input.httpStatus ?? null, outboxId, claimToken).changes === 1;
  }

  resetExpiredFeedbackOutboxClaims(now: number, staleAfterMs: number): number {
    return Number(this.db.prepare(`UPDATE feedback_outbox SET status='pending',claim_token=NULL,claimed_at=NULL WHERE status='inflight' AND claimed_at<=?`).run(now - staleAfterMs).changes);
  }

  private reconcileTurnCompletion(deliveryId: string): TurnCompletionEventPayload | undefined {
    const row = this.db.prepare(`SELECT d.*,r.content_hash,r.content_ref,t.status AS terminal_status,
      t.completed_at AS terminal_completed_at,t.duration_ms AS terminal_duration_ms,t.usage_json AS terminal_usage_json
      FROM deliveries d JOIN responses r ON r.response_id=d.response_id
      JOIN turn_terminals t ON t.bot_app_id=d.bot_app_id AND t.session_id=d.session_id AND t.turn_id=d.turn_id
       AND t.dispatch_attempt=IFNULL(d.dispatch_attempt,0)
      WHERE d.delivery_id=?`).get(deliveryId) as any;
    if (!row) return undefined;
    const existing = this.db.prepare('SELECT payload_json FROM turn_completion_events WHERE delivery_id=?').get(deliveryId) as { payload_json: string } | undefined;
    if (existing) return JSON.parse(existing.payload_json) as TurnCompletionEventPayload;
    const eventId = stableId('evt', deliveryId, row.terminal_status);
    const payload: TurnCompletionEventPayload = {
      type: 'turn.completed', version: 1, eventId, time: row.terminal_completed_at,
      status: row.terminal_status, deliveryId, contentHash: row.content_hash,
      platform: row.platform, platformMessageId: row.platform_message_id, platformAppId: row.platform_app_id,
      botAppId: row.bot_app_id, sessionId: row.session_id, turnId: row.turn_id,
      ...(row.content_ref ? { contentRef: row.content_ref } : {}),
      ...(row.native_session_id ? { nativeSessionId: row.native_session_id } : {}),
      ...(row.dispatch_attempt !== null ? { dispatchAttempt: row.dispatch_attempt } : {}),
      ...(row.chat_id ? { chatId: row.chat_id } : {}), ...(row.topic_root_id ? { topicRootId: row.topic_root_id } : {}),
      ...(row.terminal_duration_ms !== null || row.duration_ms !== null ? { durationMs: row.terminal_duration_ms ?? row.duration_ms } : {}),
      ...(row.terminal_usage_json || row.usage_json ? { usage: JSON.parse(row.terminal_usage_json ?? row.usage_json) } : {}),
      ...(row.cli_id ? { cliId: row.cli_id } : {}), ...(row.cli_version ? { cliVersion: row.cli_version } : {}),
      ...(row.model ? { model: row.model } : {}), ...(row.reasoning_effort ? { reasoningEffort: row.reasoning_effort } : {}),
      ...(row.skill_name ? { skillName: row.skill_name } : {}), ...(row.skill_version ? { skillVersion: row.skill_version } : {}),
      ...(row.workflow_id ? { workflowId: row.workflow_id } : {}), ...(row.task_id ? { taskId: row.task_id } : {}),
      ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
    };
    // COALESCE so a terminal that carries no usage/duration (the turn-terminal
    // path only records status) does not clobber the usage/duration_ms the
    // delivery captured at send time. status/completed_at are authoritative from
    // the terminal and intentionally overwrite.
    this.db.prepare('UPDATE deliveries SET status=?,duration_ms=COALESCE(?,duration_ms),usage_json=COALESCE(?,usage_json),completed_at=? WHERE delivery_id=?').run(
      row.terminal_status, row.terminal_duration_ms, row.terminal_usage_json, row.terminal_completed_at, deliveryId,
    );
    this.db.prepare(`INSERT INTO turn_completion_events(event_id,delivery_id,event_type,version,payload_json,created_at)
      VALUES(?,?, 'turn.completed',1,?,?)`).run(eventId, deliveryId, JSON.stringify(payload), row.terminal_completed_at);
    this.insertFeedbackEvent(payload, deliveryId, row.webhook_destinations_json ? JSON.parse(row.webhook_destinations_json) : []);
    return payload;
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
    policy?: FeedbackPolicy;
    baseCard?: Record<string, unknown>;
    requesterSubjectId?: string;
    context?: SkillFeedbackContext;
  }): ReturnType<SkillFeedbackStore['mapDelivery']> {
    const baseCard = feedbackCardTemplate(input.baseCard);
    const row: DeliveryRow = {
      delivery_id: stableId('del', input.platform, input.platformAppId, input.platformMessageId), response_id: input.responseId, platform: input.platform,
      platform_message_id: input.platformMessageId, platform_app_id: input.platformAppId, level: input.level ?? 'L1',
      policy_snapshot_json: input.policy ? JSON.stringify(input.policy) : null,
      base_card_json: baseCard ? JSON.stringify(baseCard) : null,
      requester_subject_id: input.requesterSubjectId ?? null,
      context_json: input.context ? JSON.stringify(input.context) : null, created_at: new Date().toISOString(),
      bot_app_id: null, session_id: null, turn_id: null, native_session_id: null, dispatch_attempt: null,
      chat_id: null, topic_root_id: null, scope: null, workflow_id: null, task_id: null, parent_task_id: null,
      cli_id: null, cli_version: null, model: null, reasoning_effort: null, skill_name: null, skill_version: null,
      card_mode: null, status: null, duration_ms: null, usage_json: null, completed_at: null,
      webhook_destinations_json: null, correlation_discriminator: '',
    };
    const winner = this.db.prepare(`INSERT INTO deliveries(delivery_id,response_id,platform,platform_message_id,platform_app_id,level,policy_snapshot_json,base_card_json,requester_subject_id,context_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(platform,platform_app_id,platform_message_id) DO UPDATE SET platform_message_id=excluded.platform_message_id
      RETURNING *`)
      .get(row.delivery_id, row.response_id, row.platform, row.platform_message_id, row.platform_app_id, row.level, row.policy_snapshot_json, row.base_card_json, row.requester_subject_id, row.context_json, row.created_at) as unknown as DeliveryRow;
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
    semantic?: 'positive' | 'progress' | 'negative';
    reasonKey?: string;
    comment?: string;
    callbackKey: string;
    webhookDestinations?: FeedbackWebhookDestination[];
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
      if (previous && previous.result === input.result && (previous.reason_key ?? undefined) === input.reasonKey && (previous.comment_text ?? undefined) === input.comment) {
        this.db.exec('COMMIT');
        return { status: 'duplicate', feedback: this.mapFeedback(previous), feedbackId: previous.feedback_id };
      }
      const row: FeedbackRow = {
        feedback_id: id('fb'), delivery_id: delivery.deliveryId, operator_subject_id: input.operatorSubjectId,
        revision: (previous?.revision ?? 0) + 1, result: input.result, semantic: input.semantic ?? null, reason_key: input.reasonKey ?? null,
        comment_text: input.comment ?? null,
        callback_key: input.callbackKey, supersedes_feedback_id: previous?.feedback_id ?? null, created_at: new Date().toISOString(),
      };
      this.db.prepare(`INSERT INTO feedback_revisions(feedback_id,delivery_id,operator_subject_id,revision,result,semantic,reason_key,comment_text,callback_key,supersedes_feedback_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(row.feedback_id, row.delivery_id, row.operator_subject_id, row.revision, row.result, row.semantic, row.reason_key, row.comment_text, row.callback_key, row.supersedes_feedback_id, row.created_at);
      const eventId = stableId('evt', 'feedback.revised', row.feedback_id);
      const event: FeedbackEventEnvelope = {
        eventId, type: 'feedback.revised', version: 1, time: row.created_at,
        data: {
          feedbackId: row.feedback_id, deliveryId: row.delivery_id, revision: row.revision,
          ...(row.supersedes_feedback_id ? { supersedesFeedbackId: row.supersedes_feedback_id } : {}),
          verdictKey: row.result, ...(row.semantic ? { semantic: row.semantic } : {}),
          ...(row.reason_key ? { reasonKey: row.reason_key } : {}),
          ...(row.comment_text ? { comment: row.comment_text } : {}),
          operatorSubjectId: row.operator_subject_id,
        },
      };
      this.insertFeedbackEvent(event, row.feedback_id, input.webhookDestinations ?? delivery.webhookDestinations ?? []);
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

  getLatestFeedback(deliveryId: string, operatorSubjectId: string): ReturnType<SkillFeedbackStore['mapFeedback']> | undefined {
    const row = this.db.prepare('SELECT * FROM feedback_revisions WHERE delivery_id=? AND operator_subject_id=? ORDER BY revision DESC LIMIT 1')
      .get(deliveryId, operatorSubjectId) as unknown as FeedbackRow | undefined;
    return row ? this.mapFeedback(row) : undefined;
  }

  private mapResponse(row: ResponseRow) {
    return { responseId: row.response_id, interactionId: row.interaction_id, skillRunId: row.skill_run_id ?? undefined, contentHash: row.content_hash, contentRef: row.content_ref ?? undefined, createdAt: row.created_at };
  }

  private mapDelivery(row: DeliveryRow) {
    const response = this.db.prepare('SELECT content_hash,content_ref FROM responses WHERE response_id=?')
      .get(row.response_id) as { content_hash: string; content_ref: string | null } | undefined;
    return {
      deliveryId: row.delivery_id, responseId: row.response_id,
      botAppId: row.bot_app_id ?? undefined, sessionId: row.session_id ?? undefined, turnId: row.turn_id ?? undefined,
      nativeSessionId: row.native_session_id ?? undefined, platform: row.platform, platformAppId: row.platform_app_id,
      platformMessageId: row.platform_message_id, dispatchAttempt: row.dispatch_attempt ?? undefined,
      contentHash: response?.content_hash, contentRef: response?.content_ref ?? undefined,
      chatId: row.chat_id ?? undefined, topicRootId: row.topic_root_id ?? undefined,
      scope: (row.scope ?? undefined) as TurnDeliveryScope | undefined,
      workflowId: row.workflow_id ?? undefined, taskId: row.task_id ?? undefined, parentTaskId: row.parent_task_id ?? undefined,
      cliId: row.cli_id ?? undefined, cliVersion: row.cli_version ?? undefined, model: row.model ?? undefined,
      reasoningEffort: row.reasoning_effort ?? undefined, skillName: row.skill_name ?? undefined,
      skillVersion: row.skill_version ?? undefined, cardMode: (row.card_mode ?? undefined) as TurnDeliveryCardMode | undefined,
      status: (row.status ?? undefined) as TurnDeliveryStatus | undefined, durationMs: row.duration_ms ?? undefined,
      usage: row.usage_json ? JSON.parse(row.usage_json) as Record<string, unknown> : undefined,
      completedAt: row.completed_at ?? undefined, level: row.level,
      policy: row.policy_snapshot_json ? normalizeFeedbackPolicy(JSON.parse(row.policy_snapshot_json)) : undefined,
      baseCard: row.base_card_json ? JSON.parse(row.base_card_json) as Record<string, unknown> : undefined,
      requesterSubjectId: row.requester_subject_id ?? undefined,
      webhookDestinations: row.webhook_destinations_json ? JSON.parse(row.webhook_destinations_json) as FeedbackWebhookDestination[] : undefined,
      correlationDiscriminator: row.correlation_discriminator || undefined,
      context: row.context_json ? JSON.parse(row.context_json) : undefined, createdAt: row.created_at,
    };
  }

  private mapFeedback(row: FeedbackRow) {
    return { feedbackId: row.feedback_id, deliveryId: row.delivery_id, operatorSubjectId: row.operator_subject_id, revision: row.revision, result: row.result, semantic: row.semantic ?? undefined, reasonKey: row.reason_key ?? undefined, comment: row.comment_text ?? undefined, callbackKey: row.callback_key, supersedesFeedbackId: row.supersedes_feedback_id ?? undefined, createdAt: row.created_at };
  }
}

const stores = new Map<string, Promise<SkillFeedbackStore>>();

export function getSkillFeedbackStore(dataDir: string): Promise<SkillFeedbackStore> {
  let store = stores.get(dataDir);
  if (!store) {
    // Evict on rejection so a transient first-open failure (disk full, a
    // concurrent cold-start lock that outlasted retries, corruption later
    // repaired) is retried on the next call instead of poisoning the cache and
    // silently disabling all feedback persistence for the rest of the process.
    store = SkillFeedbackStore.open(dataDir).catch(error => {
      if (stores.get(dataDir) === store) stores.delete(dataDir);
      throw error;
    });
    stores.set(dataDir, store);
  }
  return store;
}

export async function __testOnly_closeSkillFeedbackStores(): Promise<void> {
  const pending = [...stores.values()];
  stores.clear();
  for (const store of pending) {
    try { (await store).close(); } catch { /* test cleanup only */ }
  }
}
