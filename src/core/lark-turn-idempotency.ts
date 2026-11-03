import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { computeInputHash } from '../utils/canonical-input-hash.js';
import { withFileLock } from '../utils/file-lock.js';

interface Receipt {
  version: 1;
  requestHash: string;
  triggerId: string;
  response?: TriggerResponse;
}

/** Loud follow-ups need a dispatch receipt, not an HTTP result subscription.
 * Persist a fence immediately before IPC/fork, then the acceptance response.
 * A crash between them is commit-unknown and must never replay the task. */
export async function withLarkTurnIdempotency(
  req: TriggerRequest,
  larkAppId: string,
  dispatch: (triggerId: string, beforeDispatch: () => void) => Promise<TriggerResponse>,
): Promise<TriggerResponse> {
  const key = req.options!.turnIdempotencyKey!.trim();
  const identity = JSON.stringify([larkAppId, req.target.sessionId, key]);
  const path = join(config.session.dataDir, 'lark-turn-receipts', createHash('sha256').update(identity).digest('hex') + '.json');
  // receivedAt is transport metadata; re-emitting the same report after a
  // restart must retain its identity even if the HTTP timestamp changes.
  const { receivedAt: _receivedAt, ...source } = req.source;
  const requestHash = computeInputHash({ ...req, source });
  try {
    mkdirSync(dirname(path), { recursive: true });
    return await withFileLock(path, async () => {
      let existing: Receipt | undefined;
      try { existing = JSON.parse(readFileSync(path, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (existing !== undefined) {
        if (!existing || existing.version !== 1 || typeof existing.requestHash !== 'string'
            || typeof existing.triggerId !== 'string'
            || (existing.response !== undefined && typeof existing.response?.ok !== 'boolean')) {
          throw new Error('invalid Lark turn receipt');
        }
        if (existing.requestHash !== requestHash) {
          return { ok: false, errorCode: 'idempotency_conflict', error: 'turnIdempotencyKey already used with a different request payload', turnIdempotencyKey: key };
        }
        return {
          ...(existing.response ?? {
            ok: false, errorCode: 'no_output',
            error: 'previous dispatch has unknown outcome; not re-run (at-most-once)',
          }),
          triggerId: existing.triggerId, turnIdempotencyKey: key, idempotent: true,
        };
      }
      const receipt: Receipt = { version: 1, requestHash, triggerId: `trg_${randomUUID()}` };
      let fenced = false;
      const persist = () => atomicWriteFileSync(path, JSON.stringify(receipt), { durable: true, followTargetSymlink: false });
      const result = await dispatch(receipt.triggerId, () => {
        if (fenced) throw new Error('Lark turn already dispatched');
        persist();
        fenced = true;
      });
      if (result.ok && !fenced) throw new Error('Lark turn accepted without a dispatch fence');
      // Rejections before the dispatch boundary remain retryable. After that
      // boundary, even a synchronous refusal is terminal for this key.
      if (fenced) {
        receipt.response = result;
        persist();
      }
      return { ...result, turnIdempotencyKey: key };
    });
  } catch (error) {
    return { ok: false, errorCode: 'trigger_failed', error: `Lark turn dispatch failed: ${String(error)}`, turnIdempotencyKey: key };
  }
}
