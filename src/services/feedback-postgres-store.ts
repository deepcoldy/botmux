import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { feedbackPostgresPool, ensurePostgresFeedbackSchema } from './feedback-postgres-schema.js';
import type { PostgresCredential } from './feedback-doas-token.js';
import type { FeedbackStore, PostgresTarget } from './feedback-storage-types.js';
import type { RecordTurnDeliveryInput, RecordTurnTerminalInput, TurnCompletionEventPayload } from './skill-feedback-store.js';
import { normalizeFeedbackPolicy } from './feedback-policy.js';
import { effectiveWebhookDestinations, type FeedbackEventEnvelope, type FeedbackWebhookDestination } from './feedback-outbox.js';
import { validateFeedbackEventCursor, type FeedbackEventCursor, type SequencedFeedbackEvent } from './feedback-event-stream.js';

type Input<Method extends keyof FeedbackStore> = Parameters<FeedbackStore[Method]>[0];
type Output<Method extends keyof FeedbackStore> = Awaited<ReturnType<FeedbackStore[Method]>>;
type Row = QueryResultRow;
const stableId = (prefix: string, ...parts: string[]) => `${prefix}_${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
const hash = (content: string) => `sha256:${createHash('sha256').update(content).digest('hex')}`;
const json = (value: unknown) => value === undefined ? null : JSON.stringify(value);
const decode = (value: string | null | undefined) => value ? JSON.parse(value) : undefined;
const numeric = (value: string | number | null | undefined) => value == null ? undefined : Number(value);
const camel = (key: string) => key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());

function response(row: Row): Output<'getResponse'> {
  return {
    responseId: row.response_id, interactionId: row.interaction_id, skillRunId: row.skill_run_id ?? undefined,
    contentHash: row.content_hash, contentRef: row.content_ref ?? undefined, createdAt: row.created_at,
  };
}
function feedback(row: Row): Output<'getLatestFeedback'> {
  return {
    feedbackId: row.feedback_id, deliveryId: row.delivery_id, operatorSubjectId: row.operator_subject_id,
    revision: row.revision, result: row.result, semantic: row.semantic ?? undefined, reasonKey: row.reason_key ?? undefined,
    comment: row.comment_text ?? undefined, callbackKey: row.callback_key, supersedesFeedbackId: row.supersedes_feedback_id ?? undefined,
    createdAt: row.created_at,
  };
}
function cardTemplate(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const card = structuredClone(value) as { body?: { elements?: Array<{ element_id?: string }> } };
  const elements = card.body?.elements ?? [];
  const index = elements.findIndex(element => element.element_id === 'botmux_feedback');
  if (index < 0) return undefined;
  card.body!.elements = elements.slice(index);
  return card;
}

class PostgresFeedbackStore implements FeedbackStore {
  constructor(private readonly pool: Pool) {}
  async close(): Promise<void> { await this.pool.end(); }
  private async transaction<Result>(operation: (client: PoolClient) => Promise<Result>, ordered = true): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (ordered) await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':feedback-write-order',0))");
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  private async lock(client: PoolClient, identity: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [identity]);
  }
  private async insert(client: PoolClient, table: string, row: Row): Promise<void> {
    const columns = Object.keys(row);
    await client.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_column, index) => `$${index + 1}`).join(',')}) ON CONFLICT DO NOTHING`, Object.values(row));
  }
  private async delivery(client: PoolClient | Pool, row: Row): Promise<Output<'createDelivery'>> {
    const result = (await client.query('SELECT content_hash,content_ref FROM responses WHERE response_id=$1', [row.response_id])).rows[0];
    const values: Row = {};
    for (const key of [
      'delivery_id', 'response_id', 'bot_app_id', 'session_id', 'turn_id', 'native_session_id', 'platform',
      'platform_app_id', 'platform_message_id', 'dispatch_attempt', 'chat_id', 'topic_root_id', 'scope',
      'workflow_id', 'task_id', 'parent_task_id', 'cli_id', 'cli_version', 'model', 'reasoning_effort',
      'skill_name', 'skill_version', 'card_mode', 'status', 'completed_at', 'level', 'requester_subject_id', 'created_at',
    ]) values[camel(key)] = row[key] ?? undefined;
    return {
      ...values, contentHash: result?.content_hash, contentRef: result?.content_ref ?? undefined,
      durationMs: numeric(row.duration_ms), usage: decode(row.usage_json), context: decode(row.context_json),
      policy: row.policy_snapshot_json ? normalizeFeedbackPolicy(decode(row.policy_snapshot_json)) : undefined,
      baseCard: decode(row.base_card_json), webhookDestinations: decode(row.webhook_destinations_json),
      correlationDiscriminator: row.correlation_discriminator || undefined,
    } as Output<'createDelivery'>;
  }
  async createResponse(input: Input<'createResponse'>): Promise<Output<'createResponse'>> {
    return this.transaction(async client => {
      const createdAt = new Date().toISOString();
      await this.insert(client, 'interactions', { interaction_id: input.interactionId, context_json: json(input.context), created_at: createdAt });
      const contentHash = hash(input.content);
      await this.insert(client, 'responses', { response_id: stableId('resp', input.interactionId, contentHash), interaction_id: input.interactionId, skill_run_id: input.skillRunId ?? null, content_hash: contentHash, content_ref: input.contentRef ?? null, created_at: createdAt });
      return response((await client.query('SELECT * FROM responses WHERE interaction_id=$1 AND content_hash=$2', [input.interactionId, contentHash])).rows[0])!;
    });
  }
  async getResponse(responseId: string): Promise<Output<'getResponse'>> {
    const row = (await this.pool.query('SELECT * FROM responses WHERE response_id=$1', [responseId])).rows[0];
    return row ? response(row) : undefined;
  }
  async createDelivery(input: Input<'createDelivery'>): Promise<Output<'createDelivery'>> {
    return this.transaction(async client => {
      await this.lock(client, JSON.stringify(['message', input.platform, input.platformAppId, input.platformMessageId]));
      await this.insert(client, 'deliveries', {
        delivery_id: stableId('del', input.platform, input.platformAppId, input.platformMessageId),
        response_id: input.responseId, platform: input.platform, platform_app_id: input.platformAppId,
        platform_message_id: input.platformMessageId, level: input.level ?? 'L1', policy_snapshot_json: json(input.policy),
        base_card_json: json(cardTemplate(input.baseCard)), requester_subject_id: input.requesterSubjectId ?? null,
        context_json: json(input.context), created_at: new Date().toISOString(),
      });
      const winner = (await client.query('SELECT * FROM deliveries WHERE platform=$1 AND platform_app_id=$2 AND platform_message_id=$3', [input.platform, input.platformAppId, input.platformMessageId])).rows[0];
      if (winner.response_id !== input.responseId) await client.query('DELETE FROM responses WHERE response_id=$1 AND NOT EXISTS(SELECT 1 FROM deliveries WHERE response_id=$1)', [input.responseId]);
      return this.delivery(client, winner);
    });
  }
  async findDeliveryByPlatformMessage(platform: string, app: string, message: string): Promise<Output<'findDeliveryByPlatformMessage'>> {
    const row = (await this.pool.query('SELECT * FROM deliveries WHERE platform=$1 AND platform_app_id=$2 AND platform_message_id=$3', [platform, app, message])).rows[0];
    return row ? this.delivery(this.pool, row) : undefined;
  }
  async recordTurnDelivery(input: RecordTurnDeliveryInput): Promise<Output<'recordTurnDelivery'>> {
    return this.transaction(async client => {
      await this.lock(client, JSON.stringify(['turn', input.botAppId, input.sessionId, input.turnId, input.dispatchAttempt ?? 0]));
      await this.lock(client, JSON.stringify(['message', input.platform, input.platformAppId, input.platformMessageId]));
      const parts = [input.botAppId, input.sessionId, input.turnId, input.nativeSessionId ?? '', String(input.dispatchAttempt ?? 0)];
      if (input.correlationDiscriminator) parts.push(input.correlationDiscriminator);
      const deliveryId = stableId('del', ...parts);
      const owner = (await client.query('SELECT delivery_id FROM deliveries WHERE platform=$1 AND platform_app_id=$2 AND platform_message_id=$3', [input.platform, input.platformAppId, input.platformMessageId])).rows[0];
      if (owner && owner.delivery_id !== deliveryId) throw new Error('turn_delivery_platform_message_rebind');
      const correlation = (await client.query("SELECT platform_message_id FROM deliveries WHERE bot_app_id=$1 AND session_id=$2 AND turn_id=$3 AND COALESCE(native_session_id,'')=$4 AND COALESCE(dispatch_attempt,0)=$5 AND correlation_discriminator=$6", [...parts.slice(0, 4), input.dispatchAttempt ?? 0, input.correlationDiscriminator ?? ''])).rows[0];
      if (correlation && correlation.platform_message_id !== input.platformMessageId) throw new Error('turn_delivery_correlation_rebind');
      const interactionId = stableId('int', input.botAppId, input.sessionId, input.turnId);
      const contentHash = hash(input.content);
      const responseId = stableId('resp', interactionId, contentHash);
      const createdAt = input.createdAt ?? new Date().toISOString();
      await this.insert(client, 'interactions', { interaction_id: interactionId, context_json: null, created_at: createdAt });
      await this.insert(client, 'responses', { response_id: responseId, interaction_id: interactionId, content_hash: contentHash, content_ref: input.contentRef ?? null, created_at: createdAt });
      const row: Row = {
        delivery_id: deliveryId, response_id: responseId, platform: input.platform, platform_app_id: input.platformAppId,
        platform_message_id: input.platformMessageId, level: 'L1', created_at: createdAt,
        policy_snapshot_json: json(input.policy), base_card_json: json(cardTemplate(input.baseCard)),
        requester_subject_id: input.requesterSubjectId ?? null, context_json: json(input.context),
        usage_json: json(input.usage), webhook_destinations_json: json(input.webhookDestinations),
        correlation_discriminator: input.correlationDiscriminator ?? '',
      };
      for (const column of ['bot_app_id', 'session_id', 'turn_id', 'native_session_id', 'dispatch_attempt', 'chat_id', 'topic_root_id', 'scope', 'workflow_id', 'task_id', 'parent_task_id', 'cli_id', 'cli_version', 'model', 'reasoning_effort', 'skill_name', 'skill_version', 'card_mode', 'status', 'duration_ms', 'completed_at']) {
        row[column] = (input as unknown as Row)[camel(column)] ?? null;
      }
      await this.insert(client, 'deliveries', row);
      const winner = (await client.query('SELECT * FROM deliveries WHERE delivery_id=$1', [deliveryId])).rows[0];
      if (winner.response_id !== responseId) await client.query('DELETE FROM responses WHERE response_id=$1 AND NOT EXISTS(SELECT 1 FROM deliveries WHERE response_id=$1)', [responseId]);
      await this.reconcile(client, deliveryId);
      return this.delivery(client, (await client.query('SELECT * FROM deliveries WHERE delivery_id=$1', [deliveryId])).rows[0]);
    });
  }
  async recordTurnTerminal(input: RecordTurnTerminalInput): Promise<TurnCompletionEventPayload | undefined> {
    return this.transaction(async client => {
      const identity = [input.botAppId, input.sessionId, input.turnId, input.dispatchAttempt ?? 0];
      await this.lock(client, JSON.stringify(['turn', ...identity]));
      const previous = (await client.query('SELECT status FROM turn_terminals WHERE bot_app_id=$1 AND session_id=$2 AND turn_id=$3 AND dispatch_attempt=$4', identity)).rows[0];
      if (previous && previous.status !== input.status) throw new Error('turn_terminal_status_conflict');
      await this.insert(client, 'turn_terminals', { bot_app_id: input.botAppId, session_id: input.sessionId, turn_id: input.turnId, dispatch_attempt: input.dispatchAttempt ?? 0, status: input.status, completed_at: input.completedAt ?? new Date().toISOString(), completed_at_estimated: input.completedAt === undefined ? 1 : 0, duration_ms: input.durationMs ?? null, usage_json: json(input.usage) });
      const rows = (await client.query('SELECT delivery_id FROM deliveries WHERE bot_app_id=$1 AND session_id=$2 AND turn_id=$3 AND COALESCE(dispatch_attempt,0)=$4 ORDER BY created_at,delivery_id', identity)).rows;
      let payload: TurnCompletionEventPayload | undefined;
      for (const row of rows) payload = await this.reconcile(client, row.delivery_id) ?? payload;
      return payload;
    });
  }
  async tryRecordTurnTerminal(input: RecordTurnTerminalInput): Promise<Output<'tryRecordTurnTerminal'>> {
    return { done: true, payload: await this.recordTurnTerminal(input) };
  }
  private async event(client: PoolClient, event: FeedbackEventEnvelope | TurnCompletionEventPayload, aggregate: string, destinations: FeedbackWebhookDestination[]): Promise<void> {
    const envelope: FeedbackEventEnvelope = 'data' in event ? event : {
      eventId: event.eventId, type: event.type, version: 1, time: event.time,
      data: Object.fromEntries(Object.entries(event).filter(([key]) => !['eventId', 'type', 'version', 'time'].includes(key))),
    };
    await this.insert(client, 'feedback_events', { event_id: envelope.eventId, event_type: envelope.type, version: 1, aggregate_id: aggregate, payload_json: json(envelope), created_at: envelope.time });
    for (const destination of effectiveWebhookDestinations(envelope.type, [destinations])) {
      await this.insert(client, 'feedback_outbox', { outbox_id: stableId('out', envelope.eventId, destination.id), event_id: envelope.eventId, destination_id: destination.id, destination_json: json(destination), status: 'pending', attempts: 0, next_attempt_at: Date.parse(envelope.time) || Date.now(), created_at: envelope.time });
    }
  }
  private async reconcile(client: PoolClient, deliveryId: string): Promise<TurnCompletionEventPayload | undefined> {
    const row = (await client.query(`SELECT d.*,r.content_hash,r.content_ref,t.status terminal_status,t.completed_at terminal_completed_at,t.completed_at_estimated,t.duration_ms terminal_duration_ms,t.usage_json terminal_usage_json
      FROM deliveries d JOIN responses r ON r.response_id=d.response_id JOIN turn_terminals t ON t.bot_app_id=d.bot_app_id AND t.session_id=d.session_id AND t.turn_id=d.turn_id AND t.dispatch_attempt=COALESCE(d.dispatch_attempt,0) WHERE d.delivery_id=$1`, [deliveryId])).rows[0];
    if (!row) return undefined;
    const existing = (await client.query('SELECT payload_json FROM turn_completion_events WHERE delivery_id=$1', [deliveryId])).rows[0];
    if (existing) return decode(existing.payload_json);
    const payload: Row = { type: 'turn.completed', version: 1, eventId: stableId('evt', deliveryId, row.terminal_status), time: row.terminal_completed_at, status: row.terminal_status, deliveryId, contentHash: row.content_hash };
    for (const column of ['platform', 'platform_message_id', 'platform_app_id', 'bot_app_id', 'session_id', 'turn_id', 'content_ref', 'native_session_id', 'chat_id', 'topic_root_id', 'cli_id', 'cli_version', 'model', 'reasoning_effort', 'skill_name', 'skill_version', 'workflow_id', 'task_id', 'parent_task_id']) {
      if (row[column]) payload[camel(column)] = row[column];
    }
    if (row.dispatch_attempt != null) payload.dispatchAttempt = row.dispatch_attempt;
    if (row.completed_at_estimated) payload.completedAtEstimated = true;
    if (row.terminal_duration_ms != null || row.duration_ms != null) payload.durationMs = numeric(row.terminal_duration_ms ?? row.duration_ms);
    if (row.terminal_usage_json || row.usage_json) payload.usage = decode(row.terminal_usage_json ?? row.usage_json);
    await client.query('UPDATE deliveries SET status=$1,duration_ms=COALESCE($2,duration_ms),usage_json=COALESCE($3,usage_json),completed_at=$4 WHERE delivery_id=$5', [row.terminal_status, row.terminal_duration_ms, row.terminal_usage_json, row.terminal_completed_at, deliveryId]);
    await this.insert(client, 'turn_completion_events', { event_id: payload.eventId, delivery_id: deliveryId, event_type: 'turn.completed', version: 1, payload_json: json(payload), created_at: payload.time });
    await this.event(client, payload as TurnCompletionEventPayload, deliveryId, decode(row.webhook_destinations_json) ?? []);
    return payload as TurnCompletionEventPayload;
  }
  async recordFeedback(input: Input<'recordFeedback'>): Promise<Output<'recordFeedback'>> {
    return this.transaction(async client => {
      await this.lock(client, `callback:${input.callbackKey}`);
      const delivery = (await client.query('SELECT * FROM deliveries WHERE platform=$1 AND platform_app_id=$2 AND platform_message_id=$3 FOR UPDATE', [input.platform, input.platformAppId, input.platformMessageId])).rows[0];
      if (!delivery) throw new Error('feedback_delivery_not_found');
      const latest = (await client.query('SELECT * FROM feedback_revisions WHERE delivery_id=$1 ORDER BY feedback_order DESC LIMIT 1', [delivery.delivery_id])).rows[0];
      const duplicate = (await client.query('SELECT * FROM feedback_revisions WHERE callback_key=$1', [input.callbackKey])).rows[0];
      if (duplicate) {
        if (duplicate.delivery_id !== delivery.delivery_id || duplicate.operator_subject_id !== input.operatorSubjectId) throw new Error('feedback_callback_key_conflict');
        const current = feedback(latest ?? duplicate)!;
        return { status: 'duplicate', feedback: current, feedbackId: current.feedbackId };
      }
      if (input.expectedFeedbackId !== undefined && (latest?.feedback_id ?? null) !== input.expectedFeedbackId) {
        if (!latest) throw new Error('feedback_version_mismatch');
        return { status: 'stale', feedback: feedback(latest)!, feedbackId: latest.feedback_id };
      }
      const previous = (await client.query('SELECT * FROM feedback_revisions WHERE delivery_id=$1 AND operator_subject_id=$2 ORDER BY revision DESC LIMIT 1', [delivery.delivery_id, input.operatorSubjectId])).rows[0];
      if (previous && previous.result === input.result && (previous.reason_key ?? undefined) === input.reasonKey && (previous.comment_text ?? undefined) === input.comment) {
        return { status: 'duplicate', feedback: feedback(previous)!, feedbackId: previous.feedback_id };
      }
      const row = { feedback_id: `fb_${randomUUID().replaceAll('-', '')}`, delivery_id: delivery.delivery_id, operator_subject_id: input.operatorSubjectId, revision: (previous?.revision ?? 0) + 1, result: input.result, semantic: input.semantic ?? null, reason_key: input.reasonKey ?? null, comment_text: input.comment ?? null, callback_key: input.callbackKey, supersedes_feedback_id: previous?.feedback_id ?? null, created_at: new Date().toISOString() };
      await this.insert(client, 'feedback_revisions', row);
      const data: Row = { feedbackId: row.feedback_id, deliveryId: row.delivery_id, revision: row.revision, verdictKey: row.result, operatorSubjectId: row.operator_subject_id };
      if (row.supersedes_feedback_id) data.supersedesFeedbackId = row.supersedes_feedback_id;
      if (row.semantic) data.semantic = row.semantic;
      if (row.reason_key) data.reasonKey = row.reason_key;
      if (row.comment_text) data.comment = row.comment_text;
      await this.event(client, { eventId: stableId('evt', 'feedback.revised', row.feedback_id), type: 'feedback.revised', version: 1, time: row.created_at, data }, row.feedback_id, input.webhookDestinations ?? decode(delivery.webhook_destinations_json) ?? []);
      return { status: previous ? 'revised' : 'accepted', feedback: feedback(row)! };
    });
  }
  async listFeedbackRevisions(deliveryId: string, operator: string): Promise<Output<'listFeedbackRevisions'>> {
    return (await this.pool.query('SELECT * FROM feedback_revisions WHERE delivery_id=$1 AND operator_subject_id=$2 ORDER BY revision', [deliveryId, operator])).rows.map(row => feedback(row)!);
  }
  async getLatestFeedback(deliveryId: string, operator: string): Promise<Output<'getLatestFeedback'>> {
    const row = (await this.pool.query('SELECT * FROM feedback_revisions WHERE delivery_id=$1 AND operator_subject_id=$2 ORDER BY revision DESC LIMIT 1', [deliveryId, operator])).rows[0];
    return row ? feedback(row) : undefined;
  }
  async listTurnCompletionEvents(): Promise<Output<'listTurnCompletionEvents'>> {
    return (await this.pool.query('SELECT * FROM turn_completion_events ORDER BY created_at,event_id')).rows.map(row => ({ eventId: row.event_id, eventType: row.event_type, version: row.version, deliveryId: row.delivery_id, createdAt: row.created_at, payload: decode(row.payload_json) }));
  }
  async listFeedbackEvents(): Promise<FeedbackEventEnvelope[]> {
    return (await this.pool.query('SELECT payload_json FROM feedback_events ORDER BY created_at,event_id')).rows.map(row => decode(row.payload_json));
  }
  async findDeliveryById(deliveryId: string): Promise<Output<'findDeliveryById'>> {
    const row = (await this.pool.query('SELECT * FROM deliveries WHERE delivery_id=$1', [deliveryId])).rows[0];
    return row ? this.delivery(this.pool, row) : undefined;
  }
  async listSubjectDeliveries(appId: string, chatId: string, subjectId: string): Promise<Output<'listSubjectDeliveries'>> {
    const rows = (await this.pool.query(`SELECT * FROM deliveries WHERE bot_app_id=$1 AND chat_id=$2 AND topic_root_id=$3
      ORDER BY created_at,delivery_id`, [appId, chatId, subjectId])).rows;
    return Promise.all(rows.map(row => this.delivery(this.pool, row)));
  }
  async readFeedbackEventsAfter(input: FeedbackEventCursor): Promise<SequencedFeedbackEvent[]> {
    validateFeedbackEventCursor(input);
    await this.transaction(async client => {
      const ready = await client.query(`SELECT 1 FROM pg_trigger WHERE tgrelid='feedback_events'::regclass
        AND tgname='feedback_event_stream_insert' AND NOT tgisinternal`);
      if (ready.rowCount) return;
      await client.query('LOCK TABLE feedback_events IN ACCESS EXCLUSIVE MODE');
      const recheck = await client.query(`SELECT 1 FROM pg_trigger WHERE tgrelid='feedback_events'::regclass
        AND tgname='feedback_event_stream_insert' AND NOT tgisinternal`);
      if (recheck.rowCount) return;
      await client.query(`
        CREATE TABLE feedback_event_stream_counter(singleton INTEGER PRIMARY KEY CHECK(singleton=1), value BIGINT NOT NULL);
        INSERT INTO feedback_event_stream_counter VALUES(1,0);
        CREATE TABLE feedback_event_stream(sequence BIGINT PRIMARY KEY,event_id TEXT NOT NULL UNIQUE REFERENCES feedback_events(event_id));
        INSERT INTO feedback_event_stream SELECT ROW_NUMBER() OVER(ORDER BY created_at,event_id),event_id FROM feedback_events;
        UPDATE feedback_event_stream_counter SET value=(SELECT COALESCE(MAX(sequence),0) FROM feedback_event_stream);
        CREATE FUNCTION append_feedback_event_stream() RETURNS trigger LANGUAGE plpgsql AS $$
          DECLARE next_sequence BIGINT;
          BEGIN
            PERFORM pg_advisory_xact_lock(hashtextextended(current_schema() || ':feedback-write-order',0));
            UPDATE feedback_event_stream_counter SET value=value+1 WHERE singleton=1 RETURNING value INTO next_sequence;
            INSERT INTO feedback_event_stream(sequence,event_id) VALUES(next_sequence,NEW.event_id);
            RETURN NEW;
          END;
        $$;
        CREATE TRIGGER feedback_event_stream_insert AFTER INSERT ON feedback_events FOR EACH ROW EXECUTE FUNCTION append_feedback_event_stream();
      `);
    }, false);
    const rows = (await this.pool.query(`SELECT s.sequence,e.payload_json FROM feedback_event_stream s
      JOIN feedback_events e USING(event_id) WHERE s.sequence>$1 ORDER BY s.sequence LIMIT $2`, [input.after, input.limit])).rows;
    return rows.map(row => {
      const sequence = Number(row.sequence);
      if (!Number.isSafeInteger(sequence)) throw new Error('feedback_event_sequence_overflow');
      return { sequence, event: decode(row.payload_json) as FeedbackEventEnvelope };
    });
  }
  private outbox(row: Row): Row {
    return { outboxId: row.outbox_id, eventId: row.event_id, destinationId: row.destination_id, destination: decode(row.destination_json), status: row.status, attempts: row.attempts, nextAttemptAt: numeric(row.next_attempt_at), claimToken: row.claim_token ?? undefined, claimedAt: numeric(row.claimed_at), lastHttpStatus: row.last_http_status ?? undefined, lastError: row.last_error ?? undefined, event: decode(row.payload_json) };
  }
  async listFeedbackOutbox(): Promise<Output<'listFeedbackOutbox'>> {
    return (await this.pool.query('SELECT o.*,e.payload_json FROM feedback_outbox o JOIN feedback_events e USING(event_id) ORDER BY o.created_at,o.outbox_id')).rows.map(row => this.outbox(row));
  }
  async claimFeedbackOutbox(input: Input<'claimFeedbackOutbox'>): Promise<Output<'claimFeedbackOutbox'>> {
    return this.transaction(async client => {
      const result = await client.query(`WITH picked AS (SELECT outbox_id FROM feedback_outbox WHERE status='pending' AND next_attempt_at<=$1 ORDER BY next_attempt_at,outbox_id LIMIT $2 FOR UPDATE SKIP LOCKED), updated AS (UPDATE feedback_outbox SET status='inflight',attempts=attempts+1,claimed_at=$1,claim_token=$3 WHERE outbox_id IN(SELECT outbox_id FROM picked) RETURNING *) SELECT updated.*,e.payload_json FROM updated JOIN feedback_events e USING(event_id)`, [input.now, Math.max(1, Math.min(input.limit, 100)), input.claimToken]);
      return result.rows.map(row => this.outbox(row));
    });
  }
  async tryClaimFeedbackOutbox(input: Input<'claimFeedbackOutbox'>): Promise<Output<'tryClaimFeedbackOutbox'>> { return { done: true, rows: await this.claimFeedbackOutbox(input) }; }
  async settleFeedbackOutboxDelivered(outboxId: string, claimToken: string, status: number, time: string): Promise<boolean> {
    return (await this.pool.query("UPDATE feedback_outbox SET status='delivered',last_http_status=$1,delivered_at=$2,claim_token=NULL,claimed_at=NULL WHERE outbox_id=$3 AND status='inflight' AND claim_token=$4", [status, time, outboxId, claimToken])).rowCount === 1;
  }
  async trySettleFeedbackOutboxDelivered(...args: Parameters<FeedbackStore['settleFeedbackOutboxDelivered']>): Promise<Output<'trySettleFeedbackOutboxDelivered'>> { return { done: true, changed: await this.settleFeedbackOutboxDelivered(...args) }; }
  async rescheduleFeedbackOutbox(outboxId: string, claimToken: string, input: Parameters<FeedbackStore['rescheduleFeedbackOutbox']>[2]): Promise<boolean> {
    return (await this.pool.query("UPDATE feedback_outbox SET status=$1,next_attempt_at=$2,last_error=CASE WHEN last_error LIKE 'webhook_outcome_unknown:%' THEN last_error ELSE $3 END,last_http_status=$4,claim_token=NULL,claimed_at=NULL WHERE outbox_id=$5 AND status='inflight' AND claim_token=$6", [input.permanent ? 'failed' : 'pending', input.nextAttemptAt, input.error.slice(0, 500), input.httpStatus ?? null, outboxId, claimToken])).rowCount === 1;
  }
  async tryRescheduleFeedbackOutbox(...args: Parameters<FeedbackStore['rescheduleFeedbackOutbox']>): Promise<Output<'tryRescheduleFeedbackOutbox'>> { return { done: true, changed: await this.rescheduleFeedbackOutbox(...args) }; }
  async resetExpiredFeedbackOutboxClaims(now: number, staleAfterMs: number): Promise<number> {
    return (await this.pool.query("UPDATE feedback_outbox SET status='pending',last_error=CASE WHEN last_error LIKE 'webhook_outcome_unknown:%' THEN last_error ELSE 'webhook_outcome_unknown:' || COALESCE(claim_token,outbox_id) END,claim_token=NULL,claimed_at=NULL WHERE status='inflight' AND claimed_at<=$1", [now - staleAfterMs])).rowCount ?? 0;
  }
  async tryResetExpiredFeedbackOutboxClaims(now: number, staleAfterMs: number): Promise<Output<'tryResetExpiredFeedbackOutboxClaims'>> { return { done: true, changed: await this.resetExpiredFeedbackOutboxClaims(now, staleAfterMs) }; }
}

export async function openPostgresFeedbackStore(target: PostgresTarget, password: PostgresCredential, instanceId: string, ca?: string, provision = false): Promise<FeedbackStore> {
  const pool = feedbackPostgresPool(target, password, ca);
  try {
    const client = await pool.connect();
    try { await ensurePostgresFeedbackSchema(client, target.schema, instanceId, undefined, provision); } finally { client.release(); }
    return new PostgresFeedbackStore(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
}
