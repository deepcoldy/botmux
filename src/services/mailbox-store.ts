import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import { computeInputHash } from '../utils/canonical-input-hash.js';
import type { TriggerResponse } from './trigger-types.js';

export const MAILBOX_ID_RE = /^mb_[0-9a-f]{64}$/;
export interface MailboxResult {
  ok: boolean;
  deliveryId: string;
  state: 'injected' | 'failed' | 'unknown';
  targetSessionId?: string;
  error?: string;
}
interface Receipt {
  version: 1;
  sourceBotAppId: string;
  sourceSessionId: string;
  requestHash: string;
  result: MailboxResult;
}
function pathFor(app: string, id: string): string {
  if (!MAILBOX_ID_RE.test(id)) throw new Error('bad_delivery_id');
  return join(config.session.dataDir, 'mailbox-receipts', createHash('sha256').update(app).digest('hex'), `${id}.json`);
}
function readReceipt(app: string, id: string): Receipt | undefined {
  let raw: string;
  try { raw = readFileSync(pathFor(app, id), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const r = JSON.parse(raw) as Receipt;
  if (r?.version !== 1 || r.sourceBotAppId !== app || typeof r.sourceSessionId !== 'string'
    || typeof r.requestHash !== 'string' || r.result?.deliveryId !== id
    || !['injected', 'failed', 'unknown'].includes(r.result.state)
    || r.result.ok !== (r.result.state === 'injected')) throw new Error('invalid_mailbox_receipt');
  return r;
}
/** A receipt is visible only to its proven source session. No host bypass. */
export function mailboxStatus(app: string, sourceSessionId: string, id: string): MailboxResult | undefined {
  const r = readReceipt(app, id);
  return r?.sourceSessionId === sourceSessionId ? r.result : undefined;
}

/** Same durable fence as Lark turn receipts: write unknown before IPC/fork and
 * acceptance after it. An interrupted send never replays. A source/key fixes
 * the destination and bytes; failures are also first results and stay fixed. */
export async function withMailboxReceipt(input: {
  sourceBotAppId: string; sourceSessionId: string; key: string;
  target: object; content: string;
}, dispatch: (id: string, fence: (targetSessionId: string) => void) => Promise<TriggerResponse>): Promise<MailboxResult> {
  const deliveryId = `mb_${computeInputHash([input.sourceBotAppId, input.sourceSessionId, input.key]).slice(7)}`;
  const requestHash = computeInputHash({ target: input.target, content: input.content });
  const path = pathFor(input.sourceBotAppId, deliveryId);
  const failure = (error: string): MailboxResult => ({ ok: false, deliveryId, state: 'failed', error });
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    return await withFileLock(path, async () => {
      const old = readReceipt(input.sourceBotAppId, deliveryId);
      if (old) return old.requestHash === requestHash ? old.result : failure('idempotency_conflict');
      const receipt: Receipt = {
        version: 1, sourceBotAppId: input.sourceBotAppId, sourceSessionId: input.sourceSessionId,
        requestHash, result: { ok: false, deliveryId, state: 'unknown', error: 'delivery_outcome_unknown' },
      };
      let fenced = false;
      const persist = () => atomicWriteFileSync(path, JSON.stringify(receipt), { durable: true, followTargetSymlink: false });
      try {
        const response = await dispatch(deliveryId, targetSessionId => {
          if (fenced) throw new Error('mailbox_already_dispatched');
          receipt.result.targetSessionId = targetSessionId;
          persist();
          fenced = true;
        });
        if (response.ok && !fenced) throw new Error('mailbox_accepted_without_fence');
        receipt.result = response.ok ? {
          ok: true, deliveryId, state: 'injected', targetSessionId: response.target?.sessionId ?? receipt.result.targetSessionId,
        } : { ...failure(response.error ?? response.errorCode ?? 'delivery_failed'),
          ...(receipt.result.targetSessionId ? { targetSessionId: receipt.result.targetSessionId } : {}) };
        persist();
        return receipt.result;
      } catch (error) {
        // After a side effect, only a durable receipt can resolve uncertainty.
        if (fenced) return readReceipt(input.sourceBotAppId, deliveryId)!.result;
        receipt.result = failure(String(error));
        persist();
        return receipt.result;
      }
    });
  } catch (error) {
    // Storage failures may have followed the side effect. Do not claim failure.
    return { ok: false, deliveryId, state: 'unknown', error: `receipt_unavailable: ${String(error)}` };
  }
}
