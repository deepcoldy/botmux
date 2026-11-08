import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import { readFeedbackStorageConfig, saveFeedbackStorageCandidate } from '../src/services/feedback-storage-config.js';
import { prepareFeedbackMigration, cancelFeedbackMigration, resumeFeedbackMigration } from '../src/services/feedback-migration.js';
import { beginFeedbackMaintenance, assertFeedbackAdmission, currentFeedbackMaintenance, freezeFeedbackSource, inspectFeedbackMaintenance, retireFeedbackSource, acquireFeedbackSendLease } from '../src/services/feedback-maintenance.js';
import { inspectFeedbackRecovery, acknowledgeFeedbackRecovery } from '../src/services/feedback-recovery.js';
import { closeAllFeedbackStorage } from '../src/services/feedback-storage.js';
import { withFeedbackRecoveryLock } from '../src/services/feedback-recovery.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import { once } from 'node:events';

const directories: string[] = [];
const stores: SkillFeedbackStore[] = [];
afterEach(async () => {
  await closeAllFeedbackStorage();
  stores.splice(0).forEach(store => store.close());
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const decision = { confirmed: true as const, reason: 'Reviewed original operation', evidence: 'ticket:verified-original-receipt', actor: 'local-operator' };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'feedback-recovery-'));
  directories.push(directory);
  const store = await SkillFeedbackStore.open(directory);
  stores.push(store);
  const config = await readFeedbackStorageConfig(directory);
  const candidate = { backend: 'postgresql' as const, postgres: {
    host: '127.0.0.1', port: 1, user: 'invalid', database: 'invalid', schema: 'isolated',
    passwordRef: 'env:UNSET_TEST_PASSWORD', tls: { mode: 'disable' as const }, connectTimeoutMs: 100,
  } };
  const saved = await saveFeedbackStorageCandidate(directory, config.generation, candidate);
  const job = await prepareFeedbackMigration(directory, { requestId: 'old-request', expectedGeneration: saved.generation, maintenanceConfirmed: true });
  return { directory, store, candidate, saved, job };
}
describe('manual feedback recovery', () => {
  it('cancels a prepared migration before maintenance begins without a control file or PG access', async () => {
    const { directory, job } = await fixture();
    const cancelled = await cancelFeedbackMigration(directory, job.migrationId, decision);
    expect(cancelled.phase).toBe('cancelled');
    // No maintenance control was ever created, so admission was never gated.
    expect(currentFeedbackMaintenance(directory)).toBeUndefined();
    expect(() => assertFeedbackAdmission(directory)).not.toThrow();
    expect((await resumeFeedbackMigration(directory, job.migrationId)).phase).toBe('cancelled');
  });
  it('refuses overlapping cancellation and reports an actionable busy error', async () => {
    const { directory, job } = await fixture();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const holding = withFeedbackRecoveryLock(directory, async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
    });
    await entered;
    try {
      await expect(cancelFeedbackMigration(directory, job.migrationId, decision)).rejects.toThrow('feedback_migration_busy_retry');
    } finally { release(); await holding; }
  });
  it('acknowledges an exact SIGKILL lease without deleting it or acknowledging another lease', async () => {
    const { directory, job } = await fixture();
    const child = spawnTsScript('test/helpers/feedback-send-lease-child.ts', [directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    await once(child, 'message');
    child.kill('SIGKILL');
    await once(child, 'exit');
    await beginFeedbackMaintenance(directory, job.migrationId);
    const item = (await inspectFeedbackRecovery(directory)).find(item => item.kind === 'send')!;
    expect(item.live).toBe(false);
    await expect(freezeFeedbackSource(directory, job.migrationId)).rejects.toThrow('send_outcome_unknown');
    await acknowledgeFeedbackRecovery(directory, { ...decision, ...item });
    expect(await readFile(join(directory, 'feedback-send-leases', item.id), 'utf8')).toContain('processStartId');
    await freezeFeedbackSource(directory, job.migrationId);
  });
  it('resumes cancellation after its durable intent is recorded but before source restoration', async () => {
    const { directory, job, store } = await fixture();
    await beginFeedbackMaintenance(directory, job.migrationId);
    await freezeFeedbackSource(directory, job.migrationId);
    await writeFile(join(directory, 'feedback-migrations', `${job.migrationId}.json`), JSON.stringify({
      ...job, phase: 'cancelling', cancellation: { ...decision, at: new Date().toISOString() },
    }));
    expect((await resumeFeedbackMigration(directory, job.migrationId)).phase).toBe('cancelled');
    expect(() => assertFeedbackAdmission(directory)).not.toThrow();
    expect(store.createResponse({ interactionId: 'restored-after-crash', content: 'x' })).toHaveProperty('responseId');
  });
  it('finishes cancelling again after restoration already committed', async () => {
    const { directory, job } = await fixture();
    await beginFeedbackMaintenance(directory, job.migrationId);
    await freezeFeedbackSource(directory, job.migrationId);
    const first = await cancelFeedbackMigration(directory, job.migrationId, decision);
    await writeFile(join(directory, 'feedback-migrations', `${job.migrationId}.json`), JSON.stringify({ ...first, phase: 'cancelling' }));
    expect((await resumeFeedbackMigration(directory, job.migrationId)).phase).toBe('cancelled');
    expect(() => assertFeedbackAdmission(directory)).not.toThrow();
  });
  it('does not report cancellation successful when a frozen source lost its maintenance identity', async () => {
    const { directory, job } = await fixture();
    await beginFeedbackMaintenance(directory, job.migrationId);
    await freezeFeedbackSource(directory, job.migrationId);
    await rm(join(directory, 'feedback-maintenance.json'));
    await expect(cancelFeedbackMigration(directory, job.migrationId, decision)).rejects.toThrow('feedback_maintenance_state_missing');
  });
  it('cancels pre-freeze maintenance after candidate edits without requiring the PG endpoint', async () => {
    const { directory, candidate, saved, job } = await fixture();
    await beginFeedbackMaintenance(directory, job.migrationId);
    await saveFeedbackStorageCandidate(directory, saved.generation, { ...candidate, postgres: { ...candidate.postgres, host: 'other.invalid' } });
    expect(() => assertFeedbackAdmission(directory)).toThrow();
    const cancelled = await cancelFeedbackMigration(directory, job.migrationId, decision);
    expect(cancelled.phase).toBe('cancelled');
    expect(() => assertFeedbackAdmission(directory)).not.toThrow();
    expect((await resumeFeedbackMigration(directory, job.migrationId)).phase).toBe('cancelled');
    const config = await readFeedbackStorageConfig(directory);
    const replacement = await prepareFeedbackMigration(directory, { requestId: 'new-request', expectedGeneration: config.generation, maintenanceConfirmed: true });
    expect(replacement.migrationId).not.toBe(job.migrationId);
    expect(JSON.parse(await readFile(join(directory, 'feedback-migrations', `${job.migrationId}.json`), 'utf8')).cancellation.actor).toBe('local-operator');
  });
  it('restores a frozen source but refuses cancellation after source retirement', async () => {
    const { directory, store, job } = await fixture();
    await beginFeedbackMaintenance(directory, job.migrationId);
    await freezeFeedbackSource(directory, job.migrationId);
    expect(() => store.createResponse({ interactionId: 'frozen', content: 'x' })).toThrow();
    await cancelFeedbackMigration(directory, job.migrationId, decision);
    expect(store.createResponse({ interactionId: 'restored', content: 'x' })).toHaveProperty('responseId');
    const config = await readFeedbackStorageConfig(directory);
    const replacement = await prepareFeedbackMigration(directory, { requestId: 'replacement', expectedGeneration: config.generation, maintenanceConfirmed: true });
    await beginFeedbackMaintenance(directory, replacement.migrationId);
    await freezeFeedbackSource(directory, replacement.migrationId);
    await retireFeedbackSource(directory, replacement.migrationId);
    await expect(cancelFeedbackMigration(directory, replacement.migrationId, decision)).rejects.toThrow('feedback_source_retired');
    expect(() => assertFeedbackAdmission(directory)).toThrow();
  });
  it('keeps unknown webhook marker but permits freezing after exact audited acknowledgement', async () => {
    const { directory, store, job } = await fixture();
    store.recordTurnTerminal({ botAppId: 'app', sessionId: 's', turnId: 't', status: 'completed' });
    store.recordTurnDelivery({ botAppId: 'app', sessionId: 's', turnId: 't', platform: 'lark', platformAppId: 'app', platformMessageId: 'message', content: 'x', cardMode: 'card', status: 'delivered',
      webhookDestinations: [{ id: 'd', enabled: true, url: 'https://example.com', secretRef: 'secret', eventTypes: ['turn.completed'] }] });
    const claimed = store.claimFeedbackOutbox({ now: Date.now() + 100, limit: 1, claimToken: 'unknown-attempt' })[0];
    store.rescheduleFeedbackOutbox(claimed.outboxId, 'unknown-attempt', { now: Date.now(), nextAttemptAt: 0, error: 'webhook_outcome_unknown:unknown-attempt' });
    store.claimFeedbackOutbox({ now: Date.now(), limit: 1, claimToken: 'success' });
    store.settleFeedbackOutboxDelivered(claimed.outboxId, 'success', 200, new Date().toISOString());
    await beginFeedbackMaintenance(directory, job.migrationId);
    await expect(freezeFeedbackSource(directory, job.migrationId)).rejects.toThrow('feedback_outbox_unsettled');
    const item = (await inspectFeedbackRecovery(directory)).find(item => item.kind === 'webhook')!;
    expect(item).toMatchObject({ id: claimed.outboxId, status: 'delivered' });
    await acknowledgeFeedbackRecovery(directory, { ...decision, kind: item.kind, id: item.id, fingerprint: item.fingerprint });
    await acknowledgeFeedbackRecovery(directory, { ...decision, kind: item.kind, id: item.id, fingerprint: item.fingerprint });
    expect(store.listFeedbackOutbox()[0].lastError).toBe('webhook_outcome_unknown:unknown-attempt');
    const database = await (await import('../src/services/sqlite-compat.js')).openDatabaseSync(join(directory, 'botmux-feedback.sqlite'));
    database.prepare("UPDATE feedback_outbox SET status='pending',attempts=attempts+1 WHERE outbox_id=?").run(claimed.outboxId);
    database.close();
    await expect(freezeFeedbackSource(directory, job.migrationId)).rejects.toThrow('feedback_outbox_unsettled');
    await expect(acknowledgeFeedbackRecovery(directory, { ...decision, kind: item.kind, id: item.id, fingerprint: item.fingerprint })).rejects.toThrow('feedback_recovery_stale');
    const newer = (await inspectFeedbackRecovery(directory)).find(value => value.kind === 'webhook')!;
    await acknowledgeFeedbackRecovery(directory, { ...decision, kind: newer.kind, id: newer.id, fingerprint: newer.fingerprint });
    await freezeFeedbackSource(directory, job.migrationId);
  });
  it('lists an orphaned inflight outbox claim so freeze blockers are visible, but refuses to acknowledge it while claimed', async () => {
    const { directory, store, job } = await fixture();
    store.recordTurnTerminal({ botAppId: 'app', sessionId: 's', turnId: 't', status: 'completed' });
    store.recordTurnDelivery({ botAppId: 'app', sessionId: 's', turnId: 't', platform: 'lark', platformAppId: 'app', platformMessageId: 'message', content: 'x', cardMode: 'card', status: 'delivered',
      webhookDestinations: [{ id: 'd', enabled: true, url: 'https://example.com', secretRef: 'secret', eventTypes: ['turn.completed'] }] });
    const claimed = store.claimFeedbackOutbox({ now: Date.now(), limit: 1, claimToken: 'dead-claimer' })[0];
    // Row stays inflight with NO unknown marker (claimer died before reset).
    const items = await inspectFeedbackRecovery(directory);
    const item = items.find(value => value.kind === 'webhook' && value.id === claimed.outboxId)!;
    expect(item).toMatchObject({ status: 'inflight', live: true });
    await beginFeedbackMaintenance(directory, job.migrationId);
    await expect(acknowledgeFeedbackRecovery(directory, { ...decision, ...item })).rejects.toThrow('feedback_recovery_operation_live');
  });
  it('ignores atomic-write .tmp siblings in lease and participant directories', async () => {
    const { directory, job } = await fixture();
    await beginFeedbackMaintenance(directory, job.migrationId);
    await mkdir(join(directory, 'feedback-send-leases'), { recursive: true });
    await writeFile(join(directory, 'feedback-send-leases', '1234-uuid.json.99.deadbeef.tmp'), 'partial', { mode: 0o600 });
    await mkdir(join(directory, 'feedback-participants'), { recursive: true });
    await writeFile(join(directory, 'feedback-participants', '5678.json.99.cafef00d.tmp'), '{partial', { mode: 0o600 });
    expect((await inspectFeedbackRecovery(directory)).filter(item => item.kind === 'send')).toEqual([]);
    expect((await inspectFeedbackMaintenance(directory, job.migrationId)).blockers).not.toContainEqual(expect.stringContaining('feedback_send_lease_invalid'));
  });
  it('rejects stale acknowledgement and any acknowledgement for a live send lease', async () => {
    const { directory } = await fixture();
    const release = acquireFeedbackSendLease(directory);
    try {
      const item = (await inspectFeedbackRecovery(directory)).find(item => item.kind === 'send')!;
      await expect(acknowledgeFeedbackRecovery(directory, { ...decision, kind: item.kind, id: item.id, fingerprint: 'stale' })).rejects.toThrow();
      await expect(acknowledgeFeedbackRecovery(directory, { ...decision, kind: item.kind, id: item.id, fingerprint: item.fingerprint })).rejects.toThrow('feedback_recovery_operation_live');
    } finally { release(); }
  });
});
