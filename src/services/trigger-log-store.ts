import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import type { TriggerAction, TriggerErrorCode } from './trigger-types.js';

export interface TriggerLogEntry {
  triggerId: string;
  connectorId?: string;
  action: TriggerAction | 'failed';
  status: 'ok' | 'error';
  error?: string;
  errorCode?: TriggerErrorCode;
  createdAt: string;
}

export interface TriggerLogListOptions {
  limit?: number;
  connectorId?: string;
  status?: TriggerLogEntry['status'];
  errorCode?: TriggerErrorCode;
  since?: string | Date;
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

function logPath(dataDir: string = config.session.dataDir): string {
  return join(dataDir, 'trigger-logs.jsonl');
}

function normalizeLimit(limit: unknown, fallback = 100, max = 1000): number {
  const n = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.floor(n), max));
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
  const minMs = sinceMs(opts.since);
  if (minMs !== undefined) {
    const createdMs = Date.parse(entry.createdAt);
    if (!Number.isFinite(createdMs) || createdMs < minMs) return false;
  }
  return true;
}

export function appendTriggerLog(
  entry: Omit<TriggerLogEntry, 'createdAt'> & { createdAt?: string },
  dataDir: string = config.session.dataDir,
): TriggerLogEntry {
  const full: TriggerLogEntry = { ...entry, createdAt: entry.createdAt ?? new Date().toISOString() };
  const fp = logPath(dataDir);
  mkdirSync(dirname(fp), { recursive: true });
  appendFileSync(fp, JSON.stringify(full) + '\n', 'utf-8');
  return full;
}

export function listTriggerLogs(
  opts: TriggerLogListOptions = {},
  dataDir: string = config.session.dataDir,
): TriggerLogEntry[] {
  const limit = normalizeLimit(opts.limit);
  const out: TriggerLogEntry[] = [];
  const entries = readTriggerLogEntries(dataDir);
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    if (matchesFilter(entries[i], opts)) out.push(entries[i]);
  }
  return out;
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
