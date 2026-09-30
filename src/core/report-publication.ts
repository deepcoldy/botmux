import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** Persist each sink separately. A crash or lost provider response while posting
 * is ambiguous: retain that state and require reconciliation instead of reposting. */
export async function deliverPublishedReport(input: {
  dataDir: string;
  key: string;
  delivery: 'publish' | 'publish-and-relay';
  validate(): void;
  publish(uuid: string): Promise<string>;
  relay(meta: { requestId: string; receivedAt: string; turnIdempotencyKey: string; publishedMessageId: string }): Promise<ReportDeliveryResponse>;
  syncProject(): Promise<{ projectSynced: boolean; projectSyncError?: string }>;
}): Promise<ReportDeliveryResponse> {
  if (!/^[a-f0-9]{64}$/.test(input.key)) throw new Error('invalid_report_delivery_key');
  const dir = join(input.dataDir, 'report-deliveries');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${input.key}.json`);
  return withFileLock(path, async () => {
    input.validate();
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
    if (saved?.response) return saved.response;
    if (saved?.publication === 'pending') {
      return { status: 409, body: { ok: false, error: 'report_publication_unknown', deliveryKey: input.key } };
    }
    if (!saved) {
      saved = { version: 1, key: input.key, receivedAt: new Date().toISOString(), publication: 'pending' };
      atomicWriteFileSync(path, JSON.stringify(saved), { mode: 0o600, durable: true, followTargetSymlink: false });
      try {
        const messageId = await input.publish(input.key.slice(0, 32));
        if (!messageId) throw new Error('report_publication_not_delivered');
        saved = { ...saved, publication: 'published', messageId };
        atomicWriteFileSync(path, JSON.stringify(saved), { mode: 0o600, durable: true, followTargetSymlink: false });
      } catch {
        return { status: 502, body: { ok: false, error: 'report_publication_unknown', deliveryKey: input.key } };
      }
    }
    let response: ReportDeliveryResponse;
    try {
      input.validate();
      response = input.delivery === 'publish'
        ? { status: 200, body: { ok: true, ...await input.syncProject() } }
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
