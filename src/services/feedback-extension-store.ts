import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabaseSync, openDatabaseSyncOrThrow, type DatabaseSyncLike } from './sqlite-compat.js';
import { normalizeFeedbackBinding, normalizeFeedbackContext, type FeedbackContext, type FeedbackSubjectBinding } from './feedback-context.js';

function isSqliteBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if ((code === 'ERR_SQLITE_ERROR' || code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') && code !== 'ERR_SQLITE_ERROR') {
    return true;
  }
  const message = String((error as { message?: unknown })?.message ?? error).toLowerCase();
  return message.includes('database is locked') || message.includes('database table is locked')
    || message.includes('sqlite_busy') || message.includes('sqlite_locked');
}
function sleepShort(attempt: number): void {
  const base = Math.min(20 * attempt, 120);
  const jitter = Math.floor(Number(process.hrtime.bigint() % 17n));
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, base + jitter); } catch {}
}
const EXTENSION_DATABASE = 'feedback-extensions.sqlite';

/**
 * Delivery context plus the host-verified binding of that turn, frozen when the
 * answer delivery is first recorded (null = no binding).
 *
 * The bind route always creates the extension database before writing a
 * binding, so a missing file means this turn has no binding. Do not create the
 * file here: the extension host treats its existence as "extensions were used"
 * and every bot's two feedback ticks then open it every 2 seconds. Open per
 * call instead of holding a handle, because the long-lived main store may have
 * been opened before any binding existed. A read failure records null and never
 * blocks the main delivery.
 */
export function feedbackDeliveryContext(dataDir: string | undefined, input: {
  botAppId: string; sessionId: string; turnId: string; context?: Record<string, unknown>;
}): Record<string, unknown> {
  let binding: FeedbackSubjectBinding | null = null;
  const path = dataDir ? join(dataDir, EXTENSION_DATABASE) : undefined;
  if (path && existsSync(path)) {
    try {
      const database = openDatabaseSyncOrThrow(path);
      try {
        database.exec('PRAGMA busy_timeout=5000;');
        const row = database.prepare('SELECT binding FROM subject_bindings WHERE app_id=? AND session_id=? AND turn_id=?')
          .get(input.botAppId, input.sessionId, input.turnId) as { binding: string } | undefined;
        binding = row ? JSON.parse(row.binding) as FeedbackSubjectBinding : null;
      } finally { database.close(); }
    } catch { binding = null; }
  }
  return { ...input.context, feedbackSubjectBinding: binding };
}

const EXTENSION_SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS cursors(source TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS received(source TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(source,event_id));
  CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,
    token TEXT,deadline INTEGER,result TEXT);
  CREATE TABLE IF NOT EXISTS action_requests(request_id TEXT PRIMARY KEY,actor TEXT NOT NULL,job_id TEXT NOT NULL REFERENCES jobs(id));
  CREATE TABLE IF NOT EXISTS answers(app_id TEXT NOT NULL,chat_id TEXT NOT NULL,subject_id TEXT NOT NULL,
    answer_id TEXT NOT NULL,delivery_id TEXT NOT NULL,round INTEGER NOT NULL,PRIMARY KEY(app_id,answer_id));
  CREATE TABLE IF NOT EXISTS surfaces(app_id TEXT NOT NULL,message_id TEXT NOT NULL,binding TEXT NOT NULL,PRIMARY KEY(app_id,message_id));
  CREATE TABLE IF NOT EXISTS activation(app_id TEXT PRIMARY KEY,started_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS dirty_surfaces(app_id TEXT NOT NULL,message_id TEXT NOT NULL,state TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(app_id,message_id));
  CREATE TABLE IF NOT EXISTS reconciliations(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,
    actor TEXT NOT NULL,evidence TEXT NOT NULL,outcome TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS subject_bindings(app_id TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,
    binding TEXT NOT NULL,PRIMARY KEY(app_id,session_id,turn_id));
  CREATE TABLE IF NOT EXISTS inline_cleanup(app_id TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(app_id,message_id));
  CREATE TABLE IF NOT EXISTS refresh_state(app_id TEXT NOT NULL,message_id TEXT NOT NULL,kind TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,next_run INTEGER NOT NULL DEFAULT 0,terminal INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(app_id,message_id,kind));
`;

export interface ExtensionJobInput { id: string; kind: 'hook' | 'surface'; payload: Record<string, unknown> }
export interface ExtensionJob extends ExtensionJobInput {
  status: 'pending' | 'running' | 'succeeded' | 'blocked' | 'failed_before_effect' | 'unknown';
  token?: string;
  result?: Record<string, unknown>;
}

export class FeedbackExtensionStore {
  private constructor(private readonly database: DatabaseSyncLike) {
    try {
      database.exec('PRAGMA busy_timeout=5000;');
      database.exec('PRAGMA foreign_keys=ON;');
      this.enableWalWithRetry();
      const version = Number((database.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0);
      if (version > 1) throw new Error('feedback_extension_schema_newer');
      if (version === 0) {
        this.withImmediateWrite(() => {
          const observed = Number((database.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0);
          if (observed > 1) throw new Error('feedback_extension_schema_newer');
          if (observed > 0) return;
          database.exec(EXTENSION_SCHEMA_V1);
          database.exec('PRAGMA user_version=1;');
        });
      }
    } catch (error) {
      database.close();
      throw error;
    }
  }
  private enableWalWithRetry(): void {
    const maxAttempts = 10;
    for (let attempt = 1; ; attempt++) {
      try {
        const mode = String((this.database.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode?: string } | undefined)?.journal_mode ?? '').toLowerCase();
        if (mode === 'wal') return;
        if (attempt < maxAttempts) { sleepShort(attempt); continue; }
        throw new Error(`feedback_extension_wal_mode_not_set:${mode || 'unknown'}`);
      } catch (error) {
        if (isSqliteBusyError(error) && attempt < maxAttempts) { sleepShort(attempt); continue; }
        throw error;
      }
    }
  }
  private withImmediateWrite(fn: () => void): void {
    const maxAttempts = 10;
    for (let attempt = 1; ; attempt++) {
      try { this.database.exec('BEGIN IMMEDIATE;'); } catch (error) {
        if (isSqliteBusyError(error) && attempt < maxAttempts) { sleepShort(attempt); continue; }
        throw error;
      }
      try { fn(); this.database.exec('COMMIT;'); return; } catch (error) {
        try { this.database.exec('ROLLBACK;'); } catch {}
        if (isSqliteBusyError(error) && attempt < maxAttempts) { sleepShort(attempt); continue; }
        throw error;
      }
    }
  }
  static async open(dataDir: string): Promise<FeedbackExtensionStore> {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    return new FeedbackExtensionStore(await openDatabaseSync(join(dataDir, EXTENSION_DATABASE)));
  }
  close(): void { this.database.close(); }
  bindSubject(appId: string, sessionId: string, turnId: string, input: FeedbackSubjectBinding): void {
    const binding = normalizeFeedbackBinding(input);
    this.transaction(() => {
      const previous = this.subject(appId, sessionId, turnId);
      if (previous && JSON.stringify(normalizeFeedbackBinding(previous)) !== JSON.stringify(binding)) throw new Error('feedback_subject_binding_conflict');
      this.database.prepare('INSERT OR IGNORE INTO subject_bindings VALUES(?,?,?,?)').run(appId, sessionId, turnId, JSON.stringify(binding));
    });
  }
  subject(appId: string, sessionId: string, turnId: string): FeedbackSubjectBinding | undefined {
    const row = this.database.prepare('SELECT binding FROM subject_bindings WHERE app_id=? AND session_id=? AND turn_id=?')
      .get(appId, sessionId, turnId) as { binding: string } | undefined;
    return row ? JSON.parse(row.binding) : undefined;
  }
  activate(appId: string, startedAt: string): string {
    this.database.prepare('INSERT OR IGNORE INTO activation VALUES(?,?)').run(appId, startedAt);
    return (this.database.prepare('SELECT started_at FROM activation WHERE app_id=?').get(appId) as { started_at: string }).started_at;
  }
  unsettledHookIds(): string[] {
    const rows = this.database.prepare("SELECT DISTINCT json_extract(payload,'$.hookId') AS id FROM jobs WHERE kind='hook' AND status IN ('pending','running','unknown')").all() as Array<{ id: string }>;
    return rows.map(row => row.id).filter(Boolean);
  }
  jobsForApp(appId: string, limit = 50): ExtensionJob[] {
    return (this.database.prepare("SELECT id FROM jobs WHERE json_extract(payload,'$.appId')=? ORDER BY rowid DESC LIMIT ?")
      .all(appId, Math.max(1, Math.min(limit, 100))) as Array<{ id: string }>).map(row => this.job(row.id)!);
  }
  reconcileUnknown(id: string, outcome: 'succeeded' | 'failed_before_effect', actor: string, evidence: string): boolean {
    if (!actor.trim() || !evidence.trim() || evidence.length > 2000) throw new Error('feedback_reconciliation_evidence_required');
    return this.transaction(() => {
      const job = this.job(id);
      if (job?.status !== 'unknown' || job.kind !== 'hook') return false;
      const result = { reconciled: true, actor, evidence, publicMessage: '操作结果已经人工核对',
        ...(outcome === 'failed_before_effect' ? { retryToken: randomUUID() } : {}) };
      this.database.prepare('INSERT INTO reconciliations(job_id,actor,evidence,outcome,created_at) VALUES(?,?,?,?,?)')
        .run(id, actor, evidence, outcome, new Date().toISOString());
      this.database.prepare("UPDATE jobs SET status=?,result=? WHERE id=? AND status='unknown'").run(outcome, JSON.stringify(result), id);
      this.markActionState(job, outcome, result);
      return true;
    });
  }
  reconcileSurfaceReceipt(id: string, messageId: string, actor: string, evidence: string): boolean {
    if (!messageId || !actor.trim() || !evidence.trim() || evidence.length > 2000) throw new Error('feedback_reconciliation_evidence_required');
    return this.transaction(() => {
      const job = this.job(id);
      if (job?.kind !== 'surface' || job.status !== 'unknown') return false;
      const payload = job.payload;
      const appId = String(payload.appId);
      if (this.surface(appId, messageId)) throw new Error('feedback_surface_binding_conflict');
      this.database.prepare('INSERT INTO surfaces VALUES(?,?,?)').run(appId, messageId, JSON.stringify(payload));
      this.database.prepare("UPDATE jobs SET status='succeeded',result=? WHERE id=? AND status='unknown'")
        .run(JSON.stringify({ messageId, reconciled: true }), id);
      this.database.prepare('INSERT INTO reconciliations(job_id,actor,evidence,outcome,created_at) VALUES(?,?,?,?,?)')
        .run(id, actor, evidence, 'succeeded', new Date().toISOString());
      if (payload.mode === 'separate') this.database.prepare('INSERT OR IGNORE INTO inline_cleanup VALUES(?,?)').run(appId, payload.answerMessageId);
      return true;
    });
  }
  recordAnswer(input: { appId: string; chatId: string; subjectId: string; answerId: string; deliveryId: string }): number {
    return this.transaction(() => {
      const previous = this.database.prepare('SELECT * FROM answers WHERE app_id=? AND answer_id=?').get(input.appId, input.answerId) as {
        chat_id: string; subject_id: string; delivery_id: string; round: number;
      } | undefined;
      if (previous) {
        if (previous.chat_id !== input.chatId || previous.subject_id !== input.subjectId || previous.delivery_id !== input.deliveryId) throw new Error('feedback_answer_binding_conflict');
        return previous.round;
      }
      const next = Number((this.database.prepare('SELECT COALESCE(MAX(round),0)+1 AS next FROM answers WHERE app_id=? AND chat_id=? AND subject_id=?')
        .get(input.appId, input.chatId, input.subjectId) as { next: number }).next);
      this.database.prepare('INSERT INTO answers VALUES(?,?,?,?,?,?)').run(input.appId, input.chatId, input.subjectId, input.answerId, input.deliveryId, next);
      return next;
    });
  }
  bindSurface(appId: string, messageId: string, binding: Record<string, unknown>): void {
    const serialized = JSON.stringify(binding);
    this.transaction(() => {
      const previous = this.surface(appId, messageId);
      if (previous && JSON.stringify(previous) !== serialized) throw new Error('feedback_surface_binding_conflict');
      this.database.prepare('INSERT OR IGNORE INTO surfaces VALUES(?,?,?)').run(appId, messageId, serialized);
    });
  }
  surface(appId: string, messageId: string): Record<string, unknown> | undefined {
    const row = this.database.prepare('SELECT binding FROM surfaces WHERE app_id=? AND message_id=?').get(appId, messageId) as { binding: string } | undefined;
    return row ? JSON.parse(row.binding) : undefined;
  }
  completeSurface(id: string, token: string, messageId: string, now: number): boolean {
    return this.transaction(() => {
      const row = this.database.prepare("SELECT payload FROM jobs WHERE id=? AND kind='surface' AND status='running' AND token=? AND deadline>=?")
        .get(id, token, now) as { payload: string } | undefined;
      if (!row) return false;
      const payload = JSON.parse(row.payload);
      const existing = this.surface(payload.appId, messageId);
      if (existing && JSON.stringify(existing) !== row.payload) throw new Error('feedback_surface_binding_conflict');
      this.database.prepare('INSERT OR IGNORE INTO surfaces VALUES(?,?,?)').run(payload.appId, messageId, row.payload);
      this.database.prepare("UPDATE jobs SET status='succeeded',result=?,token=NULL WHERE id=?")
        .run(JSON.stringify({ messageId }), id);
      if (payload.mode === 'separate') {
        this.database.prepare('INSERT OR IGNORE INTO inline_cleanup VALUES(?,?)').run(payload.appId, payload.answerMessageId);
      }
      return true;
    });
  }
  inlineCleanups(appId: string): string[] {
    return (this.database.prepare('SELECT message_id FROM inline_cleanup WHERE app_id=?').all(appId) as Array<{ message_id: string }>).map(row => row.message_id);
  }
  clearInlineCleanup(appId: string, messageId: string): void {
    this.database.prepare('DELETE FROM inline_cleanup WHERE app_id=? AND message_id=?').run(appId, messageId);
    this.database.prepare("DELETE FROM refresh_state WHERE app_id=? AND message_id=? AND kind='cleanup' AND terminal=0").run(appId, messageId);
  }
  refreshDue(appId: string, messageId: string, kind: 'dirty' | 'cleanup', now: number): boolean {
    const row = this.database.prepare('SELECT terminal,next_run FROM refresh_state WHERE app_id=? AND message_id=? AND kind=?')
      .get(appId, messageId, kind) as { terminal: number; next_run: number } | undefined;
    return !row || (!row.terminal && row.next_run <= now);
  }
  failRefresh(appId: string, messageId: string, kind: 'dirty' | 'cleanup', permanent: boolean, reason: string,
    now: number, revision?: number): 'retry' | 'abandoned' | 'stale' {
    return this.transaction(() => {
      if (kind === 'dirty') {
        const current = this.database.prepare('SELECT revision FROM dirty_surfaces WHERE app_id=? AND message_id=?')
          .get(appId, messageId) as { revision: number } | undefined;
        if (!current || current.revision !== revision) return 'stale';
      } else if (!this.database.prepare('SELECT message_id FROM inline_cleanup WHERE app_id=? AND message_id=?').get(appId, messageId)) return 'stale';
      const row = this.database.prepare('SELECT attempts FROM refresh_state WHERE app_id=? AND message_id=? AND kind=?')
        .get(appId, messageId, kind) as { attempts: number } | undefined;
      const attempts = (row?.attempts ?? 0) + 1;
      const terminal = permanent || attempts >= 5;
      this.database.prepare(`INSERT INTO refresh_state VALUES(?,?,?,?,?,?)
        ON CONFLICT(app_id,message_id,kind) DO UPDATE SET attempts=excluded.attempts,next_run=excluded.next_run,terminal=excluded.terminal`)
        .run(appId, messageId, kind, attempts, now + Math.min(300000, 5000 * 2 ** (attempts - 1)), terminal ? 1 : 0);
      if (terminal) {
        const table = kind === 'dirty' ? 'dirty_surfaces' : 'inline_cleanup';
        this.database.prepare(`DELETE FROM ${table} WHERE app_id=? AND message_id=?`).run(appId, messageId);
        this.audit(`refresh:${appId}:${messageId}:${kind}`, `abandoned:${reason}`, now);
      }
      return terminal ? 'abandoned' : 'retry';
    });
  }
  audit(identity: string, outcome: string, now = Date.now()): void {
    this.database.prepare('INSERT INTO reconciliations(job_id,actor,evidence,outcome,created_at) VALUES(?,?,?,?,?)')
      .run(identity, 'feedback-runtime', outcome, outcome, new Date(now).toISOString());
  }
  surfacesForDelivery(appId: string, deliveryId: string): Array<{ messageId: string; binding: Record<string, unknown> }> {
    const rows = this.database.prepare("SELECT message_id,binding FROM surfaces WHERE app_id=? AND json_extract(binding,'$.deliveryId')=?")
      .all(appId, deliveryId) as Array<{ message_id: string; binding: string }>;
    return rows.map(row => ({ messageId: row.message_id, binding: JSON.parse(row.binding) }));
  }
  surfaceContextForDelivery(appId: string, deliveryId: string): FeedbackContext | null | undefined {
    const surface = this.surfacesForDelivery(appId, deliveryId)[0]?.binding;
    const queued = surface ? undefined : this.database.prepare(
      "SELECT payload FROM jobs WHERE kind='surface' AND json_extract(payload,'$.appId')=? AND json_extract(payload,'$.deliveryId')=? ORDER BY rowid LIMIT 1",
    ).get(appId, deliveryId) as { payload: string } | undefined;
    const binding = surface ?? (queued ? JSON.parse(queued.payload) as Record<string, unknown> : undefined);
    return binding ? normalizeFeedbackContext(binding.context ?? undefined) ?? null : undefined;
  }
  dirtySurface(appId: string, messageId: string, state: Record<string, unknown>): void {
    this.transaction(() => this.writeDirtySurface(appId, messageId, state));
  }
  private writeDirtySurface(appId: string, messageId: string, state: Record<string, unknown>): void {
    const binding = this.surface(appId, messageId);
    if (binding) this.database.prepare('UPDATE surfaces SET binding=? WHERE app_id=? AND message_id=?')
      .run(JSON.stringify({ ...binding, feedbackState: state }), appId, messageId);
    if (this.database.prepare("SELECT 1 FROM refresh_state WHERE app_id=? AND message_id=? AND kind='dirty' AND terminal=1").get(appId, messageId)) return;
    this.database.prepare(`INSERT INTO dirty_surfaces(app_id,message_id,state) VALUES(?,?,?)
      ON CONFLICT(app_id,message_id) DO UPDATE SET state=excluded.state,revision=dirty_surfaces.revision+1`)
      .run(appId, messageId, JSON.stringify(state));
  }
  private markActionState(job: ExtensionJob, status: string, result?: Record<string, unknown>): void {
    const event = job.payload.event as { scope?: { subjectId?: string }; surface?: { messageId?: string } } | undefined;
    const appId = job.payload.appId;
    if (typeof appId !== 'string' || !event?.surface?.messageId) return;
    const binding = this.surface(appId, event.surface.messageId);
    if (!binding) return;
    const labels: Record<string, string> = { pending: '请求已记录', running: '操作处理中', succeeded: '操作已完成',
      blocked: '操作被阻止', failed_before_effect: '操作未执行，可确认后重试', unknown: '操作结果未知，等待核对' };
    const actionStatus = typeof result?.publicMessage === 'string' ? result.publicMessage : labels[status] ?? status;
    this.database.prepare('UPDATE surfaces SET binding=? WHERE app_id=? AND message_id=?')
      .run(JSON.stringify({ ...binding, actionStatus }), appId, event.surface.messageId);
    this.writeDirtySurface(appId, event.surface.messageId, (binding.feedbackState ?? {}) as Record<string, unknown>);
  }
  dirtySurfaces(appId: string): Array<{ messageId: string; state: Record<string, unknown>; revision: number }> {
    const rows = this.database.prepare('SELECT message_id,state,revision FROM dirty_surfaces WHERE app_id=?').all(appId) as Array<{ message_id: string; state: string; revision: number }>;
    return rows.map(row => ({ messageId: row.message_id, state: JSON.parse(row.state), revision: row.revision }));
  }
  clearDirtySurface(appId: string, messageId: string, revision: number): void {
    const removed = this.database.prepare('DELETE FROM dirty_surfaces WHERE app_id=? AND message_id=? AND revision=?').run(appId, messageId, revision);
    if (Number(removed.changes)) this.database.prepare("DELETE FROM refresh_state WHERE app_id=? AND message_id=? AND kind='dirty' AND terminal=0").run(appId, messageId);
  }
  private transaction<Result>(operation: () => Result): Result {
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  cursor(source: string): number {
    return Number((this.database.prepare('SELECT sequence FROM cursors WHERE source=?').get(source) as { sequence: number } | undefined)?.sequence ?? 0);
  }
  private insertJob(job: ExtensionJobInput): void {
    this.database.prepare("INSERT OR IGNORE INTO jobs(id,kind,payload,status) VALUES(?,?,?,'pending')")
      .run(job.id, job.kind, JSON.stringify(job.payload));
  }
  ingest(source: string, expected: number, entries: Array<{ sequence: number; eventId: string; jobs: ExtensionJobInput[] }>): void {
    this.transaction(() => {
      if (this.cursor(source) !== expected) throw new Error('feedback_extension_cursor_conflict');
      let sequence = expected;
      for (const entry of entries) {
        if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= sequence) throw new Error('feedback_extension_sequence_invalid');
        sequence = entry.sequence;
        const inserted = this.database.prepare('INSERT OR IGNORE INTO received VALUES(?,?)').run(source, entry.eventId);
        if (Number(inserted.changes)) for (const job of entry.jobs) this.insertJob(job);
      }
      this.database.prepare('INSERT INTO cursors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET sequence=excluded.sequence').run(source, sequence);
    });
  }
  requestAction(input: { requestId: string; actor: string; job: ExtensionJobInput; paused?: boolean }): void {
    this.transaction(() => {
      this.insertJob(input.job);
      const paused = this.job(input.job.id);
      const sameDefinition = paused?.payload.hookDefinition && input.job.payload.hookDefinition
        && JSON.stringify(paused.payload.hookDefinition) === JSON.stringify(input.job.payload.hookDefinition);
      const canResume = paused?.status === 'blocked' && paused.result?.recoverable === true
        && (!paused.payload.hookDefinition || sameDefinition);
      if ((canResume || paused?.status === 'pending' && sameDefinition)
        && paused.payload.appId === input.job.payload.appId && paused.payload.hookId === input.job.payload.hookId) {
        this.database.prepare("UPDATE jobs SET status='pending',payload=?,result=NULL,token=NULL,deadline=NULL WHERE id=? AND status IN ('blocked','pending')")
          .run(JSON.stringify({
            ...paused.payload,
            hookVersion: input.job.payload.hookVersion,
            hookDefinition: input.job.payload.hookDefinition,
          }), input.job.id);
        this.audit(input.job.id, 'resubmitted_after_pause');
      }
      const previous = this.database.prepare('SELECT actor,job_id FROM action_requests WHERE request_id=?').get(input.requestId) as { actor: string; job_id: string } | undefined;
      if (previous && (previous.actor !== input.actor || previous.job_id !== input.job.id)) throw new Error('feedback_action_request_conflict');
      this.database.prepare('INSERT OR IGNORE INTO action_requests VALUES(?,?,?)').run(input.requestId, input.actor, input.job.id);
      if (input.paused) {
        this.database.prepare("UPDATE jobs SET status='blocked',result=?,token=NULL,deadline=NULL WHERE id=? AND kind='hook' AND status='pending'")
          .run(JSON.stringify({ reason: 'hook_paused', recoverable: true }), input.job.id);
      }
      const job = this.job(input.job.id);
      if (job) this.markActionState(job, job.status, job.result);
    });
  }
  retryBeforeEffect(id: string, expectedToken: string, requestId: string, actor: string): boolean {
    return this.transaction(() => {
      if (this.database.prepare('SELECT request_id FROM action_requests WHERE request_id=?').get(requestId)) return false;
      const row = this.database.prepare("SELECT result FROM jobs WHERE id=? AND status='failed_before_effect'").get(id) as { result: string } | undefined;
      if (!row || JSON.parse(row.result ?? '{}').retryToken !== expectedToken) return false;
      this.database.prepare('INSERT INTO action_requests VALUES(?,?,?)').run(requestId, actor, id);
      this.database.prepare("UPDATE jobs SET status='pending',result=NULL,token=NULL,deadline=NULL WHERE id=? AND status='failed_before_effect'").run(id);
      return true;
    });
  }
  actionRequests(jobId: string): Array<{ requestId: string; actor: string }> {
    return this.database.prepare('SELECT request_id AS requestId,actor FROM action_requests WHERE job_id=? ORDER BY rowid').all(jobId) as Array<{ requestId: string; actor: string }>;
  }
  job(id: string): ExtensionJob | undefined {
    const row = this.database.prepare('SELECT * FROM jobs WHERE id=?').get(id) as {
      id: string; kind: ExtensionJob['kind']; payload: string; status: ExtensionJob['status']; token: string | null; result: string | null;
    } | undefined;
    return row ? { id: row.id, kind: row.kind, status: row.status, payload: JSON.parse(row.payload),
      ...(row.token ? { token: row.token } : {}), ...(row.result ? { result: JSON.parse(row.result) } : {}) } : undefined;
  }
  claim(kind: ExtensionJob['kind'], now: number, timeoutMs: number, appId?: string, limits?: Record<string, number>): ExtensionJob | undefined {
    return this.transaction(() => {
      const candidates = (appId
        ? this.database.prepare("SELECT id,payload FROM jobs WHERE kind=? AND status='pending' AND json_extract(payload,'$.appId')=? ORDER BY rowid").all(kind, appId)
        : this.database.prepare("SELECT id,payload FROM jobs WHERE kind=? AND status='pending' ORDER BY rowid").all(kind)) as Array<{ id: string; payload: string }>;
      const row = candidates.find(candidate => {
        if (kind !== 'hook') return true;
        const hookId = JSON.parse(candidate.payload).hookId;
        const running = this.database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE kind='hook' AND status='running' AND json_extract(payload,'$.hookId') IS ?")
          .get(hookId ?? null) as { count: number };
        return running.count < (limits?.[hookId] ?? 1);
      });
      if (!row) return undefined;
      this.database.prepare("UPDATE jobs SET status='running',token=?,deadline=? WHERE id=? AND status='pending'")
        .run(randomUUID(), now + timeoutMs, row.id);
      const job = this.job(row.id)!;
      this.markActionState(job, 'running');
      return job;
    });
  }
  settle(id: string, token: string, status: Exclude<ExtensionJob['status'], 'pending' | 'running'>, result: Record<string, unknown>, now = Date.now()): boolean {
    if (status === 'failed_before_effect') result = { ...result, retryToken: randomUUID() };
    return this.transaction(() => {
      const changed = Number(this.database.prepare("UPDATE jobs SET status=?,result=?,token=NULL WHERE id=? AND status='running' AND token=? AND deadline>=?")
        .run(status, JSON.stringify(result), id, token, now).changes) === 1;
      const job = changed ? this.job(id) : undefined;
      if (job) this.markActionState(job, status, result);
      return changed;
    });
  }
  expire(now: number): void {
    this.transaction(() => {
      const expired = this.database.prepare("SELECT id FROM jobs WHERE status='running' AND deadline<?").all(now) as Array<{ id: string }>;
      this.database.prepare("UPDATE jobs SET status='unknown',token=NULL WHERE status='running' AND deadline<?").run(now);
      for (const row of expired) this.markActionState(this.job(row.id)!, 'unknown');
    });
  }
}
