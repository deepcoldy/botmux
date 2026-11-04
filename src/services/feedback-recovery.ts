import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock, FileLockTimeoutError } from '../utils/file-lock.js';
import { readDurableProcessIdentity } from '../utils/process-identity.js';
import { getFeedbackStorage } from './feedback-storage.js';
import { readFeedbackStorageConfig } from './feedback-storage-config.js';

export interface RecoveryDecision {
  confirmed: true;
  actor: string;
  reason: string;
  evidence: string;
}
export interface RecoveryItem {
  kind: 'webhook' | 'send';
  id: string;
  fingerprint: string;
  status: string;
  live: boolean;
  acknowledged: boolean;
  eventId?: string;
  destinationId?: string;
  marker?: string;
  processId?: number;
}
export function validateRecoveryDecision(input: RecoveryDecision): void {
  if (input?.confirmed !== true) throw new Error('feedback_recovery_confirmation_required');
  for (const key of ['actor', 'reason', 'evidence'] as const) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 2000) throw new Error('feedback_recovery_evidence_required');
  }
}
export async function withFeedbackRecoveryLock<Result>(dataDir: string, operation: () => Promise<Result>): Promise<Result> {
  const directory = join(dataDir, 'feedback-migrations');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { return await withFileLock(join(directory, 'runner'), operation, { maxWaitMs: 1000 }); }
  catch (error) {
    if (error instanceof FileLockTimeoutError) throw new Error('feedback_migration_busy_retry');
    throw error;
  }
}
export function recoveryFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function recoveryAcknowledged(dataDir: string, fingerprint: string): boolean {
  const path = join(dataDir, 'feedback-recovery-audit', `${fingerprint}.json`);
  if (!existsSync(path)) return false;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    validateRecoveryDecision(record.decision);
    return record.fingerprint === fingerprint && record.action === 'acknowledge';
  } catch { throw new Error('feedback_recovery_audit_invalid'); }
}
export function webhookRecoveryFingerprint(instanceId: string, active: unknown, row: {
  outbox_id: string; event_id: string; destination_id: string; last_error: string;
  status: string; attempts: number;
}): string {
  return recoveryFingerprint(['webhook', instanceId, active, row.outbox_id, row.event_id, row.destination_id, row.last_error, row.status, row.attempts]);
}
export function inspectSendRecovery(dataDir: string): RecoveryItem[] {
  const directory = join(dataDir, 'feedback-send-leases');
  return (existsSync(directory) ? readdirSync(directory) : []).flatMap(name => {
    // atomicWriteFileSync's open→rename window (or a SIGKILL inside it) leaves
    // `*.json.<pid>.<hex>.tmp` siblings. They are not leases: ignore them
    // instead of failing the whole inspection (which would be unlistable and
    // unacknowledgeable, requiring manual cleanup).
    if (name.endsWith('.tmp')) return [];
    if (!/^\d+-[0-9a-f-]+\.json$/.test(name)) throw new Error('feedback_send_lease_invalid');
    let lease: { processId: number; processStartId: string };
    try { lease = JSON.parse(readFileSync(join(directory, name), 'utf8')); }
    catch { throw new Error('feedback_send_lease_invalid'); }
    if (!Number.isInteger(lease.processId) || lease.processId < 2 || !lease.processStartId) throw new Error('feedback_send_lease_invalid');
    const identity = readDurableProcessIdentity(lease.processId);
    let live = identity === lease.processStartId;
    if (!identity) {
      try { process.kill(lease.processId, 0); live = true; }
      catch (error) { live = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    }
    const fingerprint = recoveryFingerprint(['send', name, lease.processId, lease.processStartId]);
    return { kind: 'send', id: name, fingerprint, processId: lease.processId, status: live ? 'live' : 'unknown', live, acknowledged: recoveryAcknowledged(dataDir, fingerprint) };
  });
}
export async function inspectFeedbackRecovery(dataDir: string): Promise<RecoveryItem[]> {
  const config = await readFeedbackStorageConfig(dataDir);
  const items = inspectSendRecovery(dataDir);
  const { store } = await getFeedbackStorage(dataDir);
  for (const row of await store.listFeedbackOutbox()) {
    // List both rows carrying an unknown-outcome marker and claims still marked
    // inflight. An inflight row cannot be acknowledged (it is reported live —
    // the claim must first be reset, e.g. by cancelling and reopening the
    // window so the dispatcher's stale-claim sweep converts it to an unknown
    // marker), but it must be VISIBLE: freeze refuses on it and an operator
    // otherwise only sees a bare `feedback_outbox_unsettled` with zero items.
    // List both rows carrying an unknown-outcome marker and claims still marked
    // inflight. An inflight row cannot be acknowledged (it is reported live —
    // the claim must first be reset, e.g. by cancelling and reopening the
    // window so the dispatcher's stale-claim sweep converts it to an unknown
    // marker), but it must be VISIBLE: freeze refuses on it and an operator
    // otherwise only sees a bare `feedback_outbox_unsettled` with zero items.
    if (row.status !== 'inflight' && !row.lastError?.startsWith('webhook_outcome_unknown:')) continue;
    const fingerprint = webhookRecoveryFingerprint(config.instanceId, config.active, {
      outbox_id: row.outboxId, event_id: row.eventId, destination_id: row.destinationId,
      last_error: row.lastError, status: row.status, attempts: row.attempts,
    });
    items.push({ kind: 'webhook', id: row.outboxId, fingerprint, eventId: row.eventId, destinationId: row.destinationId,
      marker: row.lastError, status: row.status, live: row.status === 'inflight', acknowledged: recoveryAcknowledged(dataDir, fingerprint) });
  }
  return items;
}
export async function acknowledgeFeedbackRecovery(dataDir: string, input: RecoveryDecision & {
  kind: RecoveryItem['kind']; id: string; fingerprint: string;
}): Promise<void> {
  validateRecoveryDecision(input);
  await withFeedbackRecoveryLock(dataDir, async () => {
    const items = input.kind === 'send' ? inspectSendRecovery(dataDir) : await inspectFeedbackRecovery(dataDir);
    const current = items.find(item => item.kind === input.kind && item.id === input.id);
    if (!current || current.fingerprint !== input.fingerprint) throw new Error('feedback_recovery_stale');
    if (current.live) throw new Error('feedback_recovery_operation_live');
    if (current.acknowledged) return;
    const directory = join(dataDir, 'feedback-recovery-audit');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(join(directory, `${current.fingerprint}.json`), JSON.stringify({
      action: 'acknowledge', fingerprint: current.fingerprint, item: current, at: new Date().toISOString(),
      decision: { confirmed: true, actor: input.actor, reason: input.reason, evidence: input.evidence },
    }), { mode: 0o600, durable: true, followTargetSymlink: false });
  });
}
