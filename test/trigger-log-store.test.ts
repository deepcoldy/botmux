import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendTriggerLog,
  listTriggerLogs,
  pruneTriggerLogs,
  pruneTriggerLogsByConnectorRetention,
  queryTriggerLogs,
  summarizeTriggerLogOverview,
  summarizeTriggerLogs,
} from '../src/services/trigger-log-store.js';

describe('trigger-log-store', () => {
  it('appends newest-first trigger log entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-trigger-log-'));
    appendTriggerLog({ triggerId: 'trg_1', connectorId: 'conn_a', action: 'queued', status: 'ok', createdAt: '2026-05-24T00:00:00.000Z' }, dir);
    appendTriggerLog({ triggerId: 'trg_2', connectorId: 'conn_b', action: 'failed', status: 'error', errorCode: 'rate_limited', createdAt: '2026-05-24T00:01:00.000Z' }, dir);
    expect(statSync(join(dir, 'trigger-logs.jsonl')).mode & 0o777).toBe(0o600);
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

  it('pages and searches detailed invocation records with an aggregate latency summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-trigger-log-'));
    appendTriggerLog({
      triggerId: 'trg_1', connectorId: 'conn_a', action: 'delivered', status: 'ok', createdAt: '2026-05-24T00:00:00.000Z',
      request: { method: 'POST', path: '/webhook/conn_a/[REDACTED]', query: { chatId: 'oc_alpha' } },
      response: { httpStatus: 200, durationMs: 20 },
    }, dir);
    appendTriggerLog({
      triggerId: 'trg_2', connectorId: 'conn_a', action: 'failed', status: 'error', error: 'delivery failed', createdAt: '2026-05-24T00:01:00.000Z',
      request: { method: 'POST', path: '/webhook/conn_a/[REDACTED]', query: { chatId: 'oc_beta' } },
      response: { httpStatus: 502, durationMs: 80 },
    }, dir);
    appendTriggerLog({
      triggerId: 'trg_3', connectorId: 'conn_b', action: 'delivered', status: 'ok', createdAt: '2026-05-24T00:02:00.000Z',
      request: { method: 'GET', path: '/webhook/conn_b', query: {} },
      response: { httpStatus: 200, durationMs: 40 },
    }, dir);

    expect(queryTriggerLogs({ connectorId: 'conn_a', limit: 1, offset: 1 }, dir)).toMatchObject({
      total: 2, limit: 1, offset: 1, hasMore: false, logs: [{ triggerId: 'trg_1' }],
    });
    expect(queryTriggerLogs({ query: 'oc_beta' }, dir).logs.map(log => log.triggerId)).toEqual(['trg_2']);
    expect(queryTriggerLogs({ method: 'GET' }, dir).logs.map(log => log.triggerId)).toEqual(['trg_3']);
    expect(summarizeTriggerLogOverview({ connectorId: 'conn_a' }, dir)).toMatchObject({
      total: 2, ok: 1, error: 1, successRate: 50, avgDurationMs: 50, p95DurationMs: 80,
    });
  });

  it('applies per-connector retention without deleting newer records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-trigger-log-'));
    appendTriggerLog({ triggerId: 'a-old', connectorId: 'conn_a', action: 'queued', status: 'ok', createdAt: '2026-05-01T00:00:00.000Z' }, dir);
    appendTriggerLog({ triggerId: 'b-kept', connectorId: 'conn_b', action: 'queued', status: 'ok', createdAt: '2026-05-01T00:00:00.000Z' }, dir);
    appendTriggerLog({ triggerId: 'a-new', connectorId: 'conn_a', action: 'queued', status: 'ok', createdAt: '2026-05-29T00:00:00.000Z' }, dir);

    expect(pruneTriggerLogsByConnectorRetention(
      { conn_a: 14, conn_b: 60 },
      { now: '2026-05-30T00:00:00.000Z' },
      dir,
    )).toEqual({ before: 3, after: 2, deleted: 1 });
    expect(listTriggerLogs({ limit: 10 }, dir).map(log => log.triggerId)).toEqual(['a-new', 'b-kept']);
  });
});
