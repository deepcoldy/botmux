import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import {
  listDueGoalNotificationRetries,
  listGoalNotificationRetries,
  markGoalNotificationRetryDead,
  markGoalNotificationRetryAttempt,
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
});
