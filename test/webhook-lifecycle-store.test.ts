import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activateWebhookLifecycleGroup,
  beginWebhookLifecycleFiring,
  beginWebhookLifecycleSetupRepair,
  completeWebhookLifecycleSetupRepair,
  failWebhookLifecycleGroup,
  listWebhookLifecycleRecords,
  markWebhookLifecycleIndeterminate,
  resolveWebhookLifecycleGroup,
} from '../src/services/webhook-lifecycle-store.js';

describe('webhook-lifecycle-store', () => {
  it('atomically claims one creator for the same connector and dedup key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-life-'));
    const [a, b] = await Promise.all([
      beginWebhookLifecycleFiring('conn_1', 'alert_1', dir),
      beginWebhookLifecycleFiring('conn_1', 'alert_1', dir),
    ]);
    expect([a.action, b.action].sort()).toEqual(['create', 'creating']);
    const create = a.action === 'create' ? a : b;
    const active = await activateWebhookLifecycleGroup('conn_1', 'alert_1', create.record.lifecycleId, 'oc_1', { creatorLarkAppId: 'app1' }, dir);
    expect(active.status).toBe('active');
    expect((await beginWebhookLifecycleFiring('conn_1', 'alert_1', dir)).action).toBe('reuse');
  });

  it('marks creating records as pending resolved and resolves after activation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-life-'));
    const create = await beginWebhookLifecycleFiring('conn_1', 'alert_2', dir);
    expect(create.action).toBe('create');
    const resolved = await resolveWebhookLifecycleGroup('conn_1', 'alert_2', dir);
    expect(resolved.action).toBe('pending');

    const activated = await activateWebhookLifecycleGroup('conn_1', 'alert_2', create.record.lifecycleId, 'oc_2', {}, dir);
    expect(activated.status).toBe('pending_resolved');
    expect(listWebhookLifecycleRecords({}, dir)[0]).toMatchObject({ status: 'resolved', chatId: 'oc_2' });
  });

  it('removes failed creating records so a later firing can retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-life-'));
    const create = await beginWebhookLifecycleFiring('conn_1', 'alert_3', dir);
    expect(create.action).toBe('create');
    await failWebhookLifecycleGroup('conn_1', 'alert_3', create.record.lifecycleId, dir);
    expect(listWebhookLifecycleRecords({}, dir)).toEqual([]);
    expect((await beginWebhookLifecycleFiring('conn_1', 'alert_3', dir)).action).toBe('create');
  });

  it('reclaims stale creating records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-life-'));
    const create = await beginWebhookLifecycleFiring('conn_1', 'alert_4', dir);
    expect(create.action).toBe('create');
    const fp = join(dir, 'webhook-lifecycle.json');
    const raw = JSON.parse(readFileSync(fp, 'utf-8'));
    raw.records[0].creatingExpiresAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(fp, JSON.stringify(raw, null, 2) + '\n');

    const retry = await beginWebhookLifecycleFiring('conn_1', 'alert_4', dir);
    expect(retry.action).toBe('create');
    expect(retry.record.lifecycleId).not.toBe(create.record.lifecycleId);
  });

  it('holds an expired guarded creation for reconciliation instead of risking a duplicate group', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-life-'));
    const create = await beginWebhookLifecycleFiring('pr-room', 'repo#expired', dir);
    expect(create.action).toBe('create');
    const fp = join(dir, 'webhook-lifecycle.json');
    const raw = JSON.parse(readFileSync(fp, 'utf-8'));
    raw.records[0].creatingExpiresAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(fp, JSON.stringify(raw, null, 2) + '\n');

    const blocked = await beginWebhookLifecycleFiring(
      'pr-room',
      'repo#expired',
      dir,
      { blockResolvedReopen: true, blockIndeterminateRetry: true },
    );
    expect(blocked.action).toBe('indeterminate');
    expect(blocked.record).toMatchObject({
      lifecycleId: create.record.lifecycleId,
      indeterminate: true,
      indeterminateReason: 'creating_claim_expired',
    });

    const adopted = await beginWebhookLifecycleFiring(
      'pr-room',
      'repo#expired',
      dir,
      { blockResolvedReopen: true, adoptIndeterminate: true },
    );
    expect(adopted.action).toBe('reconcile');
    expect(adopted.record.lifecycleId).toBe(create.record.lifecycleId);
  });

  it('atomically blocks resolved replacement unless reopen is explicit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-life-'));
    const create = await beginWebhookLifecycleFiring('pr-room', 'repo#1', dir);
    expect(create.action).toBe('create');
    await activateWebhookLifecycleGroup(
      'pr-room',
      'repo#1',
      create.record.lifecycleId,
      'oc_original',
      {},
      dir,
    );
    await resolveWebhookLifecycleGroup('pr-room', 'repo#1', dir);

    const blocked = await beginWebhookLifecycleFiring(
      'pr-room',
      'repo#1',
      dir,
      { blockResolvedReopen: true },
    );
    expect(blocked.action).toBe('resolved');
    expect(blocked.record.chatId).toBe('oc_original');

    const reopened = await beginWebhookLifecycleFiring(
      'pr-room',
      'repo#1',
      dir,
      { blockResolvedReopen: false },
    );
    expect(reopened.action).toBe('create');
    expect(reopened.record.lifecycleId).not.toBe(create.record.lifecycleId);
  });

  it('holds ambiguous group creation for explicit adoption instead of retrying', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-life-'));
    const create = await beginWebhookLifecycleFiring('pr-room', 'repo#2', dir);
    expect(create.action).toBe('create');
    await markWebhookLifecycleIndeterminate(
      'pr-room',
      'repo#2',
      create.record.lifecycleId,
      'delegation_timeout',
      dir,
    );

    const retry = await beginWebhookLifecycleFiring(
      'pr-room',
      'repo#2',
      dir,
      { blockResolvedReopen: true, blockIndeterminateRetry: true },
    );
    expect(retry.action).toBe('indeterminate');
    expect(retry.record.indeterminateReason).toBe('delegation_timeout');

    const adopt = await beginWebhookLifecycleFiring(
      'pr-room',
      'repo#2',
      dir,
      { blockResolvedReopen: true, adoptIndeterminate: true },
    );
    expect(adopt.action).toBe('reconcile');
    const active = await activateWebhookLifecycleGroup(
      'pr-room',
      'repo#2',
      adopt.record.lifecycleId,
      'oc_recovered',
      {},
      dir,
    );
    expect(active.status).toBe('active');
  });

  it('lets finish terminally clear an indeterminate no-group result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-life-'));
    const create = await beginWebhookLifecycleFiring('pr-room', 'repo#3', dir);
    expect(create.action).toBe('create');
    await markWebhookLifecycleIndeterminate(
      'pr-room',
      'repo#3',
      create.record.lifecycleId,
      'delegation_timeout',
      dir,
    );
    const finished = await resolveWebhookLifecycleGroup('pr-room', 'repo#3', dir);
    expect(finished.action).toBe('close');
    expect(finished.record).toMatchObject({ status: 'resolved', indeterminate: false });
  });

  it('persists setup intent and only one process can repair it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-life-'));
    const create = await beginWebhookLifecycleFiring('pr-room', 'repo#4', dir);
    expect(create.action).toBe('create');
    const active = await activateWebhookLifecycleGroup(
      'pr-room',
      'repo#4',
      create.record.lifecycleId,
      'oc_setup',
      {
        setup: {
          reviewerLarkAppIds: ['cli_owner'],
          workingDir: '/workspace/repo',
          ownerIssues: ['owner_not_in_group'],
        },
      },
      dir,
    );
    expect(active.record).toMatchObject({
      setupStatus: 'repairing',
      setupReviewerLarkAppIds: ['cli_owner'],
      setupReviewersReady: false,
      setupWorkingDir: '/workspace/repo',
      setupWorkingDirReady: false,
      setupOwnerIssues: ['owner_not_in_group'],
    });

    const busy = await beginWebhookLifecycleSetupRepair('pr-room', 'repo#4', {}, dir);
    expect(busy.action).toBe('busy');
    const initialRepairId = active.record?.setupRepairId;
    expect(initialRepairId).toBeTruthy();
    const degraded = await completeWebhookLifecycleSetupRepair(
      'pr-room',
      'repo#4',
      create.record.lifecycleId,
      initialRepairId!,
      {
        error: 'kickoff:timeout',
        workingDirReady: true,
        reviewersReady: false,
      },
      dir,
    );
    expect(degraded.status).toBe('active');
    expect(listWebhookLifecycleRecords({}, dir)[0]).toMatchObject({
      chatId: 'oc_setup',
      setupStatus: 'degraded',
      setupError: 'kickoff:timeout',
      setupWorkingDirReady: true,
      setupReviewersReady: false,
      setupOwnerIssues: ['owner_not_in_group'],
    });

    const claimed = await beginWebhookLifecycleSetupRepair('pr-room', 'repo#4', {}, dir);
    expect(claimed.action).toBe('repair');
    if (claimed.action !== 'repair') throw new Error('expected repair claim');
    const repaired = await completeWebhookLifecycleSetupRepair(
      'pr-room',
      'repo#4',
      create.record.lifecycleId,
      claimed.repairId,
      { reviewersReady: true },
      dir,
    );
    expect(repaired.record).toMatchObject({
      setupStatus: 'degraded',
      setupReviewersReady: true,
      setupWorkingDirReady: true,
      setupOwnerIssues: ['owner_not_in_group'],
    });
  });

  it('defers finish while setup is claimed, then resolves atomically on completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-life-'));
    const create = await beginWebhookLifecycleFiring('pr-room', 'repo#5', dir);
    expect(create.action).toBe('create');
    const active = await activateWebhookLifecycleGroup(
      'pr-room',
      'repo#5',
      create.record.lifecycleId,
      'oc_finish_race',
      { setup: { reviewerLarkAppIds: [], ownerIssues: [] } },
      dir,
    );
    const finish = await resolveWebhookLifecycleGroup('pr-room', 'repo#5', dir);
    expect(finish.action).toBe('pending');
    expect(finish.record).toMatchObject({ status: 'active', pendingResolved: true });

    const completed = await completeWebhookLifecycleSetupRepair(
      'pr-room',
      'repo#5',
      create.record.lifecycleId,
      active.record!.setupRepairId!,
      {},
      dir,
    );
    expect(completed.status).toBe('pending_resolved');
    expect(completed.record).toMatchObject({
      status: 'resolved',
      setupStatus: 'ready',
      pendingResolved: false,
    });
  });

  it('never issues a new setup claim after finish when the original claim expires', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-life-'));
    const create = await beginWebhookLifecycleFiring('pr-room', 'repo#finish-expired', dir);
    expect(create.action).toBe('create');
    await activateWebhookLifecycleGroup(
      'pr-room',
      'repo#finish-expired',
      create.record.lifecycleId,
      'oc_finish_expired',
      { setup: { reviewerLarkAppIds: ['cli_owner'], ownerIssues: [] } },
      dir,
    );
    const finish = await resolveWebhookLifecycleGroup('pr-room', 'repo#finish-expired', dir);
    expect(finish.action).toBe('pending');

    const fp = join(dir, 'webhook-lifecycle.json');
    const raw = JSON.parse(readFileSync(fp, 'utf-8'));
    raw.records[0].setupRepairExpiresAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(fp, JSON.stringify(raw, null, 2) + '\n');

    const retry = await beginWebhookLifecycleSetupRepair(
      'pr-room',
      'repo#finish-expired',
      {},
      dir,
    );
    expect(retry.action).toBe('inactive');
    expect(retry.record).toMatchObject({
      status: 'resolved',
      pendingResolved: false,
      setupStatus: 'degraded',
      setupError: 'setup_repair_expired_after_finish',
    });
    expect(retry.record?.setupRepairId).toBeUndefined();
  });

  it('clears an already-expired setup claim when finish closes the room directly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-life-'));
    const create = await beginWebhookLifecycleFiring('pr-room', 'repo#expired-finish', dir);
    expect(create.action).toBe('create');
    await activateWebhookLifecycleGroup(
      'pr-room',
      'repo#expired-finish',
      create.record.lifecycleId,
      'oc_expired_finish',
      { setup: { reviewerLarkAppIds: ['cli_owner'], ownerIssues: [] } },
      dir,
    );
    const fp = join(dir, 'webhook-lifecycle.json');
    const raw = JSON.parse(readFileSync(fp, 'utf-8'));
    raw.records[0].setupRepairExpiresAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(fp, JSON.stringify(raw, null, 2) + '\n');

    const finish = await resolveWebhookLifecycleGroup(
      'pr-room',
      'repo#expired-finish',
      dir,
    );
    expect(finish.action).toBe('close');
    expect(finish.record).toMatchObject({
      status: 'resolved',
      setupStatus: 'degraded',
      setupError: 'setup_repair_expired_after_finish',
    });
    expect(finish.record?.setupRepairId).toBeUndefined();
    expect(finish.record?.setupRepairExpiresAt).toBeUndefined();
  });

  it('does not promote a legacy pending record without structured setup intent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-life-'));
    const create = await beginWebhookLifecycleFiring('pr-room', 'repo#6', dir);
    expect(create.action).toBe('create');
    await activateWebhookLifecycleGroup(
      'pr-room',
      'repo#6',
      create.record.lifecycleId,
      'oc_legacy',
      { setupStatus: 'pending' },
      dir,
    );
    const claimed = await beginWebhookLifecycleSetupRepair('pr-room', 'repo#6', {}, dir);
    expect(claimed.action).toBe('repair');
    if (claimed.action !== 'repair') throw new Error('expected repair claim');
    const completed = await completeWebhookLifecycleSetupRepair(
      'pr-room',
      'repo#6',
      create.record.lifecycleId,
      claimed.repairId,
      { reviewersReady: true, workingDirReady: true },
      dir,
    );
    expect(completed.record).toMatchObject({ setupStatus: 'degraded' });
    expect(completed.record?.setupIntentVersion).toBeUndefined();
  });

  it('does not mark setup ready when an acknowledged-owner repair still errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-webhook-life-'));
    const create = await beginWebhookLifecycleFiring('pr-room', 'repo#7', dir);
    expect(create.action).toBe('create');
    const active = await activateWebhookLifecycleGroup(
      'pr-room',
      'repo#7',
      create.record.lifecycleId,
      'oc_ack_error',
      {
        setup: {
          reviewerLarkAppIds: [],
          ownerIssues: ['owner_not_in_group'],
        },
      },
      dir,
    );
    await completeWebhookLifecycleSetupRepair(
      'pr-room',
      'repo#7',
      create.record.lifecycleId,
      active.record!.setupRepairId!,
      { error: 'owner_not_in_group' },
      dir,
    );
    const claimed = await beginWebhookLifecycleSetupRepair(
      'pr-room',
      'repo#7',
      { acknowledgeOwnerIssues: true },
      dir,
    );
    expect(claimed.action).toBe('repair');
    if (claimed.action !== 'repair') throw new Error('expected repair claim');

    const failed = await completeWebhookLifecycleSetupRepair(
      'pr-room',
      'repo#7',
      create.record.lifecycleId,
      claimed.repairId,
      { error: 'repair:author_not_in_chat' },
      dir,
    );
    expect(failed.record).toMatchObject({
      setupStatus: 'degraded',
      setupError: 'repair:author_not_in_chat',
      setupReviewersReady: true,
      setupWorkingDirReady: true,
      setupOwnerIssues: [],
    });
  });
});
