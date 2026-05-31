import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendTriggerLog,
  listTriggerLogs,
  pruneTriggerLogs,
  summarizeTriggerLogs,
} from '../src/services/trigger-log-store.js';

describe('trigger-log-store', () => {
  it('appends newest-first trigger log entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-trigger-log-'));
    appendTriggerLog({ triggerId: 'trg_1', connectorId: 'conn_a', action: 'queued', status: 'ok', createdAt: '2026-05-24T00:00:00.000Z' }, dir);
    appendTriggerLog({ triggerId: 'trg_2', connectorId: 'conn_b', action: 'failed', status: 'error', errorCode: 'rate_limited', createdAt: '2026-05-24T00:01:00.000Z' }, dir);
    expect(listTriggerLogs({ limit: 10 }, dir).map(x => x.triggerId)).toEqual(['trg_2', 'trg_1']);
    expect(listTriggerLogs({ connectorId: 'conn_a' }, dir).map(x => x.triggerId)).toEqual(['trg_1']);
  });

  it('filters by status, error code, and since timestamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-trigger-log-'));
    appendTriggerLog({ triggerId: 'trg_1', connectorId: 'conn_a', action: 'queued', status: 'ok', createdAt: '2026-05-24T00:00:00.000Z' }, dir);
    appendTriggerLog({ triggerId: 'trg_2', connectorId: 'conn_a', action: 'failed', status: 'error', errorCode: 'rate_limited', createdAt: '2026-05-24T00:01:00.000Z' }, dir);
    appendTriggerLog({ triggerId: 'trg_3', connectorId: 'conn_a', action: 'failed', status: 'error', errorCode: 'invalid_signature', createdAt: '2026-05-24T00:02:00.000Z' }, dir);

    expect(listTriggerLogs({ status: 'error' }, dir).map(x => x.triggerId)).toEqual(['trg_3', 'trg_2']);
    expect(listTriggerLogs({ errorCode: 'rate_limited' }, dir).map(x => x.triggerId)).toEqual(['trg_2']);
    expect(listTriggerLogs({ since: '2026-05-24T00:01:30.000Z' }, dir).map(x => x.triggerId)).toEqual(['trg_3']);
  });

  it('summarizes logs by connector', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-trigger-log-'));
    appendTriggerLog({ triggerId: 'trg_1', connectorId: 'conn_a', action: 'queued', status: 'ok', createdAt: '2026-05-24T00:00:00.000Z' }, dir);
    appendTriggerLog({ triggerId: 'trg_2', connectorId: 'conn_a', action: 'failed', status: 'error', errorCode: 'rate_limited', error: 'slow down', createdAt: '2026-05-24T00:01:00.000Z' }, dir);
    appendTriggerLog({ triggerId: 'trg_3', connectorId: 'conn_b', action: 'delivered', status: 'ok', createdAt: '2026-05-24T00:02:00.000Z' }, dir);

    const stats = summarizeTriggerLogs({}, dir);
    expect(stats.find(s => s.connectorId === 'conn_a')).toMatchObject({
      total: 2,
      ok: 1,
      error: 1,
      lastErrorCode: 'rate_limited',
      lastError: 'slow down',
      errorCodes: { rate_limited: 1 },
    });
    expect(stats.find(s => s.connectorId === 'conn_b')).toMatchObject({ total: 1, ok: 1, error: 0 });
  });

  it('prunes by retention window and max entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-trigger-log-'));
    appendTriggerLog({ triggerId: 'old', connectorId: 'conn_a', action: 'queued', status: 'ok', createdAt: '2026-05-20T00:00:00.000Z' }, dir);
    appendTriggerLog({ triggerId: 'middle', connectorId: 'conn_a', action: 'queued', status: 'ok', createdAt: '2026-05-23T00:00:00.000Z' }, dir);
    appendTriggerLog({ triggerId: 'new', connectorId: 'conn_a', action: 'queued', status: 'ok', createdAt: '2026-05-24T00:00:00.000Z' }, dir);

    expect(pruneTriggerLogs({ retentionDays: 2, maxEntries: 1, now: '2026-05-25T00:00:00.000Z' }, dir)).toEqual({
      before: 3,
      after: 1,
      deleted: 2,
    });
    expect(listTriggerLogs({ limit: 10 }, dir).map(x => x.triggerId)).toEqual(['new']);
  });
});
