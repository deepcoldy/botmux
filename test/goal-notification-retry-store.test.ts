import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import {
  listDueGoalNotificationRetries,
  listGoalNotificationRetries,
  goalNotificationProviderUuid,
  markGoalNotificationRetryDead,
  markGoalNotificationRetryAttempt,
  markGoalNotificationRetrySent,
  removeGoalNotificationRetry,
  retryGoalNotification,
  upsertGoalNotificationRetry,
} from '../src/services/goal-notification-retry-store.js';

let oldDataDir: string | undefined;
let dir: string;

function record(id: string, ownerLarkAppId = 'cli_a') {
  return {
    id,
    ownerLarkAppId,
    kind: 'human-attention' as const,
    candidates: ['cli_panel', ownerLarkAppId],
    parentChatId: 'oc_parent',
    goalChatId: 'oc_goal',
    summary: 'needs decision',
    attentionKind: 'decision',
    attentionReason: 'pick A or B',
    attempts: 0,
    nextAttemptAt: 100,
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  oldDataDir = process.env.SESSION_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), 'goal-notification-retry-'));
  config.session.dataDir = dir;
});

afterEach(() => {
  if (oldDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = oldDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('goal notification retry store', () => {
  it('derives stable, bounded provider UUIDs from the durable record id', () => {
    const first = goalNotificationProviderUuid('human:oc_goal:task-a:decision', 'oc_parent');
    expect(first).toBe(goalNotificationProviderUuid('human:oc_goal:task-a:decision', 'oc_parent'));
    expect(first).not.toBe(goalNotificationProviderUuid('human:oc_goal:task-b:decision', 'oc_parent'));
    expect(first).not.toBe(goalNotificationProviderUuid('human:oc_goal:task-a:decision', 'oc_other_parent'));
    expect(first).toMatch(/^gnt_[0-9a-f]{40}$/);
    expect(first.length).toBeLessThanOrEqual(50);
  });

  it('serializes mutations through the shared store lock and reclaims a dead holder', () => {
    const lockPath = join(dir, 'goal-notification-retries.json.lock');
    writeFileSync(lockPath, '99999999');
    const staleAt = new Date(Date.now() - 10_000);
    utimesSync(lockPath, staleAt, staleAt);

    upsertGoalNotificationRetry(record('after-stale-lock'));

    expect(listGoalNotificationRetries().map((entry) => entry.id)).toEqual(['after-stale-lock']);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('lists only due records for the owning daemon', () => {
    upsertGoalNotificationRetry(record('due-a', 'cli_a'));
    upsertGoalNotificationRetry({ ...record('future-a', 'cli_a'), nextAttemptAt: 1_000 });
    upsertGoalNotificationRetry(record('due-b', 'cli_b'));

    expect(listDueGoalNotificationRetries('cli_a', 100).map((r) => r.id)).toEqual(['due-a']);
    expect(listDueGoalNotificationRetries('cli_b', 100).map((r) => r.id)).toEqual(['due-b']);
    expect(listDueGoalNotificationRetries('cli_a', 1_000).map((r) => r.id)).toEqual(['due-a', 'future-a']);
  });

  it('marks attempts and removes delivered records', () => {
    upsertGoalNotificationRetry(record('r1'));
    markGoalNotificationRetryAttempt('r1', { attempts: 2, nextAttemptAt: 5_000, lastError: 'network' });

    const pending = listDueGoalNotificationRetries('cli_a', 5_000);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: 'r1', attempts: 2, lastError: 'network' });

    removeGoalNotificationRetry('r1');
    expect(listDueGoalNotificationRetries('cli_a', 10_000)).toEqual([]);
  });

  it('dead-letters records and allows manual retry', () => {
    upsertGoalNotificationRetry(record('r-dead'));
    const dead = markGoalNotificationRetryDead('r-dead', { reason: 'ttl_24h', lastError: 'bot_removed', now: 1_000 });

    expect(dead).toMatchObject({ id: 'r-dead', status: 'dead', deadReason: 'ttl_24h', lastError: 'bot_removed' });
    expect(listDueGoalNotificationRetries('cli_a', 10_000)).toEqual([]);
    expect(listGoalNotificationRetries()[0]).toMatchObject({ id: 'r-dead', status: 'dead' });

    const retried = retryGoalNotification('r-dead', 20_000);
    expect(retried).toMatchObject({ id: 'r-dead', status: 'pending', attempts: 0, nextAttemptAt: 20_000 });
    expect(retried?.deadAt).toBeUndefined();
    expect(listDueGoalNotificationRetries('cli_a', 20_000).map((r) => r.id)).toEqual(['r-dead']);
  });

  it('retains sent tombstones without scheduling them again', () => {
    upsertGoalNotificationRetry({ ...record('r-sent'), retainOnSuccess: true });
    expect(markGoalNotificationRetrySent('r-sent', 2_000)).toMatchObject({
      id: 'r-sent', status: 'sent', sentAt: 2_000, retainOnSuccess: true,
    });
    expect(listDueGoalNotificationRetries('cli_a', 10_000)).toEqual([]);
    expect(listGoalNotificationRetries()[0]).toMatchObject({ id: 'r-sent', status: 'sent' });
    expect(upsertGoalNotificationRetry({ ...record('r-sent'), retainOnSuccess: true })).toMatchObject({
      id: 'r-sent', status: 'sent', sentAt: 2_000,
    });
    // A sender that listed the record before another process delivered it may
    // finish late with a stale pending snapshot. It must not resurrect retries.
    expect(upsertGoalNotificationRetry({
      ...record('r-sent'), status: 'pending', retainOnSuccess: true,
      attempts: 0, createdAt: 9_999,
    })).toMatchObject({
      id: 'r-sent', status: 'sent', sentAt: 2_000, createdAt: 1,
    });
    markGoalNotificationRetryAttempt('r-sent', { attempts: 10, nextAttemptAt: 99_999, lastError: 'late failure' });
    expect(listGoalNotificationRetries()[0]).toMatchObject({
      id: 'r-sent', status: 'sent', sentAt: 2_000,
    });
  });
});
