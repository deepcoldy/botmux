import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import type { TriggerAction, TriggerErrorCode } from './trigger-types.js';

export interface TriggerLogEntry {
  triggerId: string;
  connectorId?: string;
  requestId?: string;
  action: TriggerAction | 'failed';
  status: 'ok' | 'error';
  error?: string;
  errorCode?: TriggerErrorCode;
  request?: TriggerLogRequest;
  target?: TriggerLogTarget;
  response?: TriggerLogResponse;
  createdAt: string;
}

export interface TriggerLogRequest {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers?: Record<string, string | string[]>;
  remoteAddress?: string;
  bodyBytes?: number;
  payload?: unknown;
  payloadStored?: boolean;
  payloadOmittedReason?: 'disabled' | 'too_large' | 'not_available';
}

export interface TriggerLogTarget {
  kind?: 'turn' | 'workflow';
  mode?: 'dynamic' | 'fixed' | 'new-group';
  botId?: string;
  chatId?: string;
  sessionId?: string;
  rootMessageId?: string;
  workflowId?: string;
}

export interface TriggerLogResponse {
  httpStatus: number;
  durationMs: number;
  sessionId?: string;
  workflowRunId?: string;
  chatId?: string;
}

export interface TriggerLogListOptions {
  limit?: number;
  offset?: number;
  connectorId?: string;
  status?: TriggerLogEntry['status'];
  errorCode?: TriggerErrorCode;
  method?: string;
  action?: TriggerLogEntry['action'];
  query?: string;
  since?: string | Date;
}

export interface TriggerLogPage {
  logs: TriggerLogEntry[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface TriggerLogOverview {
  total: number;
  ok: number;
  error: number;
  successRate: number;
  avgDurationMs?: number;
  p95DurationMs?: number;
  lastTriggeredAt?: string;
}

export interface TriggerLogStats {
  connectorId?: string;
  total: number;
  ok: number;
  error: number;
  actions: Partial<Record<TriggerLogEntry['action'], number>>;
  errorCodes: Partial<Record<TriggerErrorCode, number>>;
  lastTriggeredAt?: string;
  lastOkAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  lastErrorCode?: TriggerErrorCode;
}

export interface TriggerLogPruneResult {
  before: number;
  after: number;
  deleted: number;
}

export type TriggerLogRetentionPolicy = Record<string, number>;

function logPath(dataDir: string = config.session.dataDir): string {
  return join(dataDir, 'trigger-logs.jsonl');
}

function normalizeLimit(limit: unknown, fallback = 100, max = 1000): number {
  const n = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.floor(n), max));
}

function normalizeOffset(offset: unknown): number {
  const n = typeof offset === 'number' ? offset : Number(offset);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function sinceMs(since: string | Date | undefined): number | undefined {
  if (!since) return undefined;
  const ms = since instanceof Date ? since.getTime() : Date.parse(since);
  return Number.isFinite(ms) ? ms : undefined;
}

function readTriggerLogEntries(dataDir: string = config.session.dataDir): TriggerLogEntry[] {
  const fp = logPath(dataDir);
  if (!existsSync(fp)) return [];
  const out: TriggerLogEntry[] = [];
  const lines = readFileSync(fp, 'utf-8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as TriggerLogEntry);
    } catch { /* ignore corrupt line */ }
  }
  return out;
}

function matchesFilter(entry: TriggerLogEntry, opts: TriggerLogListOptions): boolean {
  if (opts.connectorId && entry.connectorId !== opts.connectorId) return false;
  if (opts.status && entry.status !== opts.status) return false;
  if (opts.errorCode && entry.errorCode !== opts.errorCode) return false;
  if (opts.method && entry.request?.method.toUpperCase() !== opts.method.toUpperCase()) return false;
  if (opts.action && entry.action !== opts.action) return false;
  const minMs = sinceMs(opts.since);
  if (minMs !== undefined) {
    const createdMs = Date.parse(entry.createdAt);
    if (!Number.isFinite(createdMs) || createdMs < minMs) return false;
  }
  const query = opts.query?.trim().toLowerCase();
  if (query && !JSON.stringify(entry).toLowerCase().includes(query)) return false;
  return true;
}

export function appendTriggerLog(
  entry: Omit<TriggerLogEntry, 'createdAt'> & { createdAt?: string },
  dataDir: string = config.session.dataDir,
): TriggerLogEntry {
  const full: TriggerLogEntry = { ...entry, createdAt: entry.createdAt ?? new Date().toISOString() };
  const fp = logPath(dataDir);
  mkdirSync(dirname(fp), { recursive: true });
  appendFileSync(fp, JSON.stringify(full) + '\n', { encoding: 'utf-8', mode: 0o600 });
  chmodSync(fp, 0o600);
  return full;
}

export function queryTriggerLogs(
  opts: TriggerLogListOptions = {},
  dataDir: string = config.session.dataDir,
): TriggerLogPage {
  const limit = normalizeLimit(opts.limit);
  const offset = normalizeOffset(opts.offset);
  const matches = readTriggerLogEntries(dataDir).filter(entry => matchesFilter(entry, opts)).reverse();
  return {
    logs: matches.slice(offset, offset + limit),
    total: matches.length,
    limit,
    offset,
    hasMore: offset + limit < matches.length,
  };
}

export function listTriggerLogs(
  opts: TriggerLogListOptions = {},
  dataDir: string = config.session.dataDir,
): TriggerLogEntry[] {
  return queryTriggerLogs(opts, dataDir).logs;
}

export function summarizeTriggerLogOverview(
  opts: TriggerLogListOptions = {},
  dataDir: string = config.session.dataDir,
): TriggerLogOverview {
  const entries = readTriggerLogEntries(dataDir).filter(entry => matchesFilter(entry, opts));
  const durations = entries
    .map(entry => entry.response?.durationMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const ok = entries.filter(entry => entry.status === 'ok').length;
  const error = entries.length - ok;
  const percentileIndex = durations.length ? Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1) : -1;
  return {
    total: entries.length,
    ok,
    error,
    successRate: entries.length ? Math.round((ok / entries.length) * 10_000) / 100 : 0,
    ...(durations.length ? {
      avgDurationMs: Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
      p95DurationMs: Math.round(durations[percentileIndex]),
    } : {}),
    ...(entries.length ? { lastTriggeredAt: entries[entries.length - 1].createdAt } : {}),
  };
}

export function summarizeTriggerLogs(
  opts: Pick<TriggerLogListOptions, 'connectorId' | 'since'> = {},
  dataDir: string = config.session.dataDir,
): TriggerLogStats[] {
  const groups = new Map<string, TriggerLogStats>();
  for (const entry of readTriggerLogEntries(dataDir)) {
    if (!matchesFilter(entry, opts)) continue;
    const key = entry.connectorId ?? '';
    let stat = groups.get(key);
    if (!stat) {
      stat = {
        ...(entry.connectorId ? { connectorId: entry.connectorId } : {}),
        total: 0,
        ok: 0,
        error: 0,
        actions: {},
        errorCodes: {},
      };
      groups.set(key, stat);
    }
    stat.total += 1;
    stat[entry.status] += 1;
    stat.actions[entry.action] = (stat.actions[entry.action] ?? 0) + 1;
    stat.lastTriggeredAt = entry.createdAt;
    if (entry.status === 'ok') stat.lastOkAt = entry.createdAt;
    if (entry.status === 'error') {
      stat.lastErrorAt = entry.createdAt;
      stat.lastError = entry.error;
      if (entry.errorCode) {
        stat.lastErrorCode = entry.errorCode;
        stat.errorCodes[entry.errorCode] = (stat.errorCodes[entry.errorCode] ?? 0) + 1;
      }
    }
  }
  return [...groups.values()];
}

export function pruneTriggerLogs(
  opts: { retentionDays?: number; maxEntries?: number; now?: Date | string | number } = {},
  dataDir: string = config.session.dataDir,
): TriggerLogPruneResult {
  const entries = readTriggerLogEntries(dataDir);
  const before = entries.length;
  const retentionDays = opts.retentionDays === undefined ? undefined : normalizeLimit(opts.retentionDays, 1, 3650);
  const maxEntries = opts.maxEntries === undefined ? undefined : normalizeLimit(opts.maxEntries, before || 1, 1_000_000);
  const nowMs = opts.now instanceof Date ? opts.now.getTime()
    : typeof opts.now === 'string' ? Date.parse(opts.now)
    : typeof opts.now === 'number' ? opts.now
    : Date.now();
  const cutoffMs = retentionDays === undefined || !Number.isFinite(nowMs)
    ? undefined
    : nowMs - retentionDays * 24 * 60 * 60 * 1000;

  let kept = cutoffMs === undefined
    ? entries
    : entries.filter(entry => {
      const createdMs = Date.parse(entry.createdAt);
      return !Number.isFinite(createdMs) || createdMs >= cutoffMs;
    });
  if (maxEntries !== undefined && kept.length > maxEntries) {
    kept = kept.slice(kept.length - maxEntries);
  }

  const fp = logPath(dataDir);
  mkdirSync(dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, kept.map(entry => JSON.stringify(entry)).join('\n') + (kept.length ? '\n' : ''), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  renameSync(tmp, fp);

  return { before, after: kept.length, deleted: before - kept.length };
}

export function pruneTriggerLogsByConnectorRetention(
  retentionDaysByConnector: TriggerLogRetentionPolicy,
  opts: { defaultRetentionDays?: number; maxEntries?: number; now?: Date | string | number } = {},
  dataDir: string = config.session.dataDir,
): TriggerLogPruneResult {
  const entries = readTriggerLogEntries(dataDir);
  const before = entries.length;
  const nowMs = opts.now instanceof Date ? opts.now.getTime()
    : typeof opts.now === 'string' ? Date.parse(opts.now)
    : typeof opts.now === 'number' ? opts.now
    : Date.now();
  const defaultDays = normalizeLimit(opts.defaultRetentionDays ?? 14, 14, 3650);
  let kept = entries.filter(entry => {
    const createdMs = Date.parse(entry.createdAt);
    if (!Number.isFinite(nowMs) || !Number.isFinite(createdMs)) return true;
    const configured = entry.connectorId ? retentionDaysByConnector[entry.connectorId] : undefined;
    const days = normalizeLimit(configured ?? defaultDays, defaultDays, 3650);
    return createdMs >= nowMs - days * 24 * 60 * 60 * 1000;
  });
  const maxEntries = normalizeLimit(opts.maxEntries ?? 100_000, 100_000, 1_000_000);
  if (kept.length > maxEntries) kept = kept.slice(kept.length - maxEntries);

  if (kept.length === before) return { before, after: before, deleted: 0 };
  const fp = logPath(dataDir);
  mkdirSync(dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, kept.map(entry => JSON.stringify(entry)).join('\n') + (kept.length ? '\n' : ''), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  renameSync(tmp, fp);
  return { before, after: kept.length, deleted: before - kept.length };
}
