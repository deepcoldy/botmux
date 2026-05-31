import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activateWebhookLifecycleGroup,
  beginWebhookLifecycleFiring,
  failWebhookLifecycleGroup,
  listWebhookLifecycleRecords,
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
});
