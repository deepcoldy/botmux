import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { TURN_REPLY_CARD_MAX_BYTES, turnReplyCardRequestBytes } from '../im/lark/turn-reply-card-size.js';
import { withFileLock } from '../utils/file-lock.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export type ReportDeliveryResponse = { status: number; body: Record<string, unknown> };
type Journal = {
  version: 1;
  key: string;
  receivedAt: string;
  publication: 'pending' | 'published';
  messageId?: string;
  response?: ReportDeliveryResponse;
};

/** Only an explicit provider rejection proves no message was created. Network
 * failures, HTTP 408/5xx and unrecognized business errors remain ambiguous. */
export function isDefiniteReportPublicationRejection(error: unknown): boolean {
  const e = error as { name?: string; code?: unknown; response?: { status?: number; data?: { code?: unknown } } } | undefined;
  if (e?.name === 'MessageWithdrawnError') return true;
  if (e?.name === 'ReportReplySourceChangedError') return true;
  // The opt-in topic policy converts a withdrawn root into TopicSendError with
  // TOPIC_SEND_BLOCKED — the same deterministic "no message created" outcome.
  // TOPIC_SEND_CHECK_FAILED (lookup could not run) stays ambiguous on purpose.
  if (e?.name === 'TopicSendError' && e?.code === 'TOPIC_SEND_BLOCKED') return true;
  const status = e?.response?.status;
  if (typeof status === 'number') return status >= 400 && status < 500 && status !== 408;
  const code = e?.response?.data?.code ?? e?.code;
  // Documented invalid input / membership / withdrawn / sensitive-content errors.
  return typeof code === 'number' && [230001, 230002, 230011, 230022].includes(code);
}

/** Persist each sink separately. A crash or lost provider response while posting
 * is ambiguous: retain that state and require reconciliation instead of reposting. */
export async function deliverPublishedReport(input: {
  dataDir: string;
  key: string;
  cardJson: string;
  chatId: string;
  delivery: 'publish' | 'publish-and-relay';
  validate(): void;
  /** 仅在首次发送前检查任务是否仍允许直投；已有回执不重新触发发送。 */
  beforeFirstPublication?(): void;
  publish(uuid: string): Promise<string>;
  relay(meta: { requestId: string; receivedAt: string; turnIdempotencyKey: string; publishedMessageId: string }): Promise<ReportDeliveryResponse>;
  syncProject(messageId: string): Promise<{ projectSynced: boolean; projectSyncError?: string }>;
}): Promise<ReportDeliveryResponse> {
  if (!/^[a-f0-9]{64}$/.test(input.key)) throw new Error('invalid_report_delivery_key');
  const requestBytes = turnReplyCardRequestBytes(input.cardJson, input.chatId);
  if (requestBytes > TURN_REPLY_CARD_MAX_BYTES) {
    return { status: 413, body: { ok: false, error: 'report_publication_too_large',
      requestBytes, maxBytes: TURN_REPLY_CARD_MAX_BYTES, deliveryKey: input.key } };
  }
  const dir = join(input.dataDir, 'report-deliveries');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${input.key}.json`);
  return withFileLock(path, async () => {
    let saved: Journal | undefined;
    try {
      saved = JSON.parse(readFileSync(path, 'utf8'));
      if (!saved || saved.version !== 1 || saved.key !== input.key
        || !['pending', 'published'].includes(saved.publication)
        || typeof saved.receivedAt !== 'string'
        || (saved.publication === 'published' && !saved.messageId)) throw new Error('invalid_report_delivery_journal');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // A settled receipt replays as-is and a pending outcome stays unknown.
    // Neither branch writes to the provider or starts another turn, so they must
    // not depend on live session state: running validate() here would turn a
    // retry after the source session drifted into a false "proven unsent"
    // signal, letting callers repost or switch sinks despite a message that may
    // already exist. The turn-validity gate below covers only real writes.
    if (saved?.response) return saved.response;
    if (saved?.publication === 'pending') {
      return { status: 409, body: { ok: false, error: 'report_publication_unknown', deliveryKey: input.key } };
    }
    input.validate();
    if (!saved) {
      input.beforeFirstPublication?.();
      saved = { version: 1, key: input.key, receivedAt: new Date().toISOString(), publication: 'pending' };
      atomicWriteFileSync(path, JSON.stringify(saved), { mode: 0o600, durable: true, followTargetSymlink: false });
      let messageId: string;
      try {
        messageId = await input.publish(input.key.slice(0, 32));
        if (!messageId) throw new Error('report_publication_not_delivered');
      } catch (error) {
        if (isDefiniteReportPublicationRejection(error)) {
          unlinkSync(path);
          if (error instanceof Error && error.name === 'ReportReplySourceChangedError') {
            return { status: 409, body: { ok: false, error: 'report_reply_source_changed', deliveryKey: input.key } };
          }
          return { status: 422, body: { ok: false, error: 'report_publication_rejected', deliveryKey: input.key } };
        }
        return { status: 502, body: { ok: false, error: 'report_publication_unknown', deliveryKey: input.key } };
      }
      saved = { ...saved, publication: 'published', messageId };
      // Persistence failures after provider success must never reopen publication.
      try {
        atomicWriteFileSync(path, JSON.stringify(saved), { mode: 0o600, durable: true, followTargetSymlink: false });
      } catch {
        return { status: 502, body: { ok: false, error: 'report_publication_unknown',
          publishedMessageId: messageId, deliveryKey: input.key } };
      }
    }
    let response: ReportDeliveryResponse;
    try {
      input.validate();
      response = input.delivery === 'publish'
        ? { status: 200, body: { ok: true, ...await input.syncProject(saved.messageId!) } }
        : await input.relay({
          requestId: `report:${input.key}`, receivedAt: saved.receivedAt,
          turnIdempotencyKey: `report:${input.key}`, publishedMessageId: saved.messageId!,
        });
    } catch {
      response = { status: 502, body: { ok: false, error: 'report_relay_failed', projectSynced: false } };
    }
    response.body = { ...response.body, delivery: input.delivery, publishedMessageId: saved.messageId, deliveryKey: input.key };
    if (response.status >= 200 && response.status < 300 && response.body.ok === true) {
      atomicWriteFileSync(path, JSON.stringify({ ...saved, response }), { mode: 0o600, durable: true, followTargetSymlink: false });
    }
    return response;
  });
}
