import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDatabaseSyncNow } from './sqlite-compat.js';
import type { SessionUsageSnapshot, SessionTokenUsage } from '../core/cost-calculator.js';
import { minimaxUserTurnIds } from './minimax-acp-continuation.js';

const cache = new Map<string, { at: number; snapshot: SessionUsageSnapshot | null }>();
const empty = (): SessionUsageSnapshot => ({ context: null, tokens: null, turnTokens: null });
const copy = (snapshot: SessionUsageSnapshot | null): SessionUsageSnapshot | null => snapshot ? structuredClone(snapshot) : null;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const label = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, 512) : undefined;

function json(value: unknown): Record<string, any> | undefined {
  if (typeof value !== 'string' || value.length > 4 * 1024 * 1024) return undefined;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined; }
  catch { return undefined; }
}

/** Native SQLite is the authoritative source: the exported messages.jsonl
 * omits context_usage. Open read-only, query this exact native Session ID, and
 * never substitute the latest session or estimate context from cumulative usage.
 * Cache live reads briefly; turn boundaries and tests can request a fresh read. */
export function readMinimaxUsage(databasePath: string, sessionId: string, fresh = false): SessionUsageSnapshot | null {
  const key = `${databasePath}\0${sessionId}`;
  const previous = cache.get(key);
  if (!fresh && previous && Date.now() - previous.at < 1000) return copy(previous.snapshot);
  const db = openDatabaseSyncNow(databasePath, { readOnly: true });
  if (!db) return null;
  let snapshot: SessionUsageSnapshot | null = null;
  try {
    // Keep latest-turn, cumulative and context queries on the same SQLite
    // snapshot while the native CLI commits new WAL records concurrently.
    db.exec('BEGIN');
    const session = db.prepare('SELECT history_relative_dir FROM local_runtime_sessions WHERE session_id = ?').get(sessionId) as { history_relative_dir?: string } | undefined;
    if (!session) return null;
    snapshot = empty();
    // A bounded, validated relative path from the native record, not a scan
    // of other sessions. Do not read config.yaml, OAuth or provider credentials.
    const segments = session.history_relative_dir?.split('/');
    if (segments?.length === 4 && segments.every(part => !!part && part !== '.' && part !== '..' && !/[\\:\0]/.test(part))) {
      const sessionDir = join(dirname(dirname(databasePath)), 'sessions', ...segments);
      const requestPath = join(sessionDir, 'llm-call.json');
      try {
        const manifestPath = join(sessionDir, 'manifest.json');
        if (statSync(manifestPath).size <= 4 * 1024 * 1024
          && json(readFileSync(manifestPath, 'utf8'))?.sessionId === sessionId
          && statSync(requestPath).size <= 4 * 1024 * 1024) {
          const request = json(readFileSync(requestPath, 'utf8'));
          snapshot.model = label(request?.model);
          const effort = request?.thinkingLevel;
          if (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) snapshot.reasoningEffort = effort;
        }
      } catch { /* request metadata is written lazily */ }
    }
    const latest = db.prepare('SELECT model, turn_id FROM local_runtime_token_usage WHERE session_id = ? ORDER BY ts DESC, id DESC LIMIT 1').get(sessionId) as { model?: string; turn_id?: string } | undefined;
    snapshot.model ??= label(latest?.model);
    const totals = db.prepare(`SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output,
      SUM(cache_read_tokens) AS cacheRead, SUM(cache_write_tokens) AS cacheWrite,
      COUNT(DISTINCT turn_id) AS turns,
      SUM(CASE WHEN input_tokens < 0 OR output_tokens < 0 OR cache_read_tokens < 0 OR cache_write_tokens < 0
        OR typeof(input_tokens) != 'integer' OR typeof(output_tokens) != 'integer'
        OR typeof(cache_read_tokens) != 'integer' OR typeof(cache_write_tokens) != 'integer' THEN 1 ELSE 0 END) AS invalid
      FROM local_runtime_token_usage WHERE session_id = ?`).get(sessionId) as Record<string, unknown>;
    if (totals.invalid === 0 && [totals.input, totals.output, totals.cacheRead, totals.cacheWrite, totals.turns].every(integer)) {
      const tokens: SessionTokenUsage = {
        inputTokens: totals.input as number, outputTokens: totals.output as number,
        cacheReadTokens: totals.cacheRead as number, cacheCreateTokens: totals.cacheWrite as number,
        in: (totals.input as number) + (totals.cacheRead as number) + (totals.cacheWrite as number),
        out: totals.output as number, model: snapshot.model ?? '', turns: totals.turns as number,
      };
      if (integer(tokens.in)) snapshot.tokens = tokens;
    }
    if (latest?.turn_id && totals.invalid === 0) {
      const turnIds = minimaxUserTurnIds(db, sessionId, latest.turn_id);
      if (turnIds) {
        const turn = db.prepare(`SELECT SUM(input_tokens + cache_read_tokens + cache_write_tokens) AS input,
          SUM(output_tokens) AS output FROM local_runtime_token_usage WHERE session_id = ? AND turn_id IN (${turnIds.map(() => '?').join(',')})`)
          .get(sessionId, ...turnIds) as Record<string, unknown>;
        if (integer(turn.input) && integer(turn.output)) snapshot.turnTokens = { in: turn.input, out: turn.output };
      }
    }
    const messages = db.prepare(`SELECT data_json FROM local_runtime_message_rows WHERE session_id = ? AND role = 'assistant'
      ORDER BY created_at_ms DESC, id DESC LIMIT 32`).all(sessionId) as Array<{ data_json?: string }>;
    for (const row of messages) {
      const message = json(row.data_json);
      const usage = message?.context_usage ?? message?.contextUsage;
      if (!integer(usage?.usedTokens) || !integer(usage?.contextWindowTokens) || usage.contextWindowTokens <= 0) continue;
      snapshot.context = { usedTokens: usage.usedTokens, windowTokens: usage.contextWindowTokens,
        percentUsed: Math.round(usage.usedTokens / usage.contextWindowTokens * 100) };
      break;
    }
    return snapshot;
  } catch {
    // Unsupported schema, a busy/corrupt database, or a partial native write
    // must never break card delivery or replace missing metrics with zeroes.
    return snapshot;
  } finally {
    try { db.exec('ROLLBACK'); } catch { /* no transaction if BEGIN failed */ }
    db.close();
    if (cache.size >= 128 && !cache.has(key)) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), snapshot: copy(snapshot) });
  }
}

export function resetMinimaxUsageCacheForTest(): void { cache.clear(); }
