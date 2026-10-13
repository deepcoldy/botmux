import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabaseSyncNow, type DatabaseSyncLike } from '../src/services/sqlite-compat.js';
import * as sqlite from '../src/services/sqlite-compat.js';
import { readMinimaxUsage, resetMinimaxUsageCacheForTest } from '../src/services/minimax-usage.js';
import { getSessionUsageSnapshot, getSessionTokenUsage } from '../src/core/cost-calculator.js';
import { cliSupportsNativeUsage, resolveSessionTranscriptPath } from '../src/services/transcript-resolver.js';
import { buildStreamingCard } from '../src/im/lark/card-builder.js';

const botEnvs = vi.hoisted(() => new Map<string, Record<string, string>>());
vi.mock('../src/bot-registry.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return { ...actual, getBot: (appId: string) => botEnvs.has(appId)
    ? { config: { cliId: 'minimax', env: botEnvs.get(appId) } }
    : actual.getBot(appId) };
});

const sid = 'mvs_usage_test';
const history = '2026/10/12/12-00-00-000-session_usage_test';
let root: string;
let path: string;
let db: DatabaseSyncLike;
const query = () => ({ cliId: 'minimax' as const, sessionId: 'botmux-session', cliSessionId: sid, fresh: true });

function artifacts(model = 'MiniMax-M3', thinkingLevel = 'xhigh') {
  const dir = join(root, 'v2', 'sessions', history);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ sessionId: sid }));
  writeFileSync(join(dir, 'llm-call.json'), JSON.stringify({ model, thinkingLevel }));
}
function usage(turn: string, input: number, output: number, cacheRead = 0, cacheWrite = 0, nativeId = sid) {
  db.prepare(`INSERT INTO local_runtime_token_usage (session_id,turn_id,model,ts,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
    VALUES (?,?,?,?,?,?,?,?)`).run(nativeId, turn, 'MiniMax-M3', Date.now(), input, output, cacheRead, cacheWrite);
}
function context(usedTokens: number, windowTokens = 512000, nativeId = sid) {
  db.prepare(`INSERT INTO local_runtime_message_rows (session_id,role,created_at_ms,data_json) VALUES (?,?,?,?)`)
    .run(nativeId, 'assistant', Date.now(), JSON.stringify({ context_usage: { usedTokens, contextWindowTokens: windowTokens } }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botmux-minimax-usage-'));
  vi.stubEnv('MINIMAX_DATA_DIR', root);
  mkdirSync(join(root, 'v2', 'sqlite'), { recursive: true });
  path = join(root, 'v2', 'sqlite', 'runtime-state.sqlite');
  db = openDatabaseSyncNow(path)!;
  db.exec(`CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY,history_relative_dir TEXT);
    CREATE TABLE local_runtime_token_usage (id INTEGER PRIMARY KEY,session_id TEXT,turn_id TEXT,model TEXT,ts INTEGER,
      input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER);
    CREATE TABLE local_runtime_message_rows (id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,created_at_ms INTEGER,data_json TEXT);`);
  db.prepare('INSERT INTO local_runtime_sessions VALUES (?,?)').run(sid, history);
  artifacts();
  resetMinimaxUsageCacheForTest();
  botEnvs.clear();
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  resetMinimaxUsageCacheForTest();
});

describe('MiniMax native usage and card runtime', () => {
  it.each(['manifest.json', 'llm-call.json'])('enforces the 4MiB file byte limit on valid %s metadata', file => {
    const limit = 4 * 1024 * 1024;
    const value = file === 'manifest.json' ? { sessionId: sid } : { model: 'bounded-model', thinkingLevel: 'high' };
    const base = JSON.stringify({ ...value, padding: '' });
    for (const bytes of [limit, limit + 1]) {
      const encoded = JSON.stringify({ ...value, padding: '界'.repeat(Math.floor((bytes - Buffer.byteLength(base)) / 3)) });
      const content = encoded + ' '.repeat(bytes - Buffer.byteLength(encoded));
      expect(Buffer.byteLength(content)).toBe(bytes);
      // Keep character length below the separate JSON parser limit, so only
      // the file-size guard can reject this otherwise valid metadata.
      expect(content.length).toBeLessThan(limit);
      writeFileSync(join(root, 'v2', 'sessions', history, file), content);
      const snapshot = readMinimaxUsage(path, sid, true)!;
      if (bytes === limit) {
        expect(snapshot.model).toBe(file === 'manifest.json' ? 'MiniMax-M3' : 'bounded-model');
        expect(snapshot.reasoningEffort).toBe(file === 'manifest.json' ? 'xhigh' : 'high');
      } else {
        expect(snapshot.model).toBeUndefined(); expect(snapshot.reasoningEffort).toBeUndefined();
        expect(snapshot.tokens).toBeNull(); expect(snapshot.context).toBeNull();
      }
    }
  });

  it('enforces the 4MiB character limit on valid database context JSON independently of metadata files', () => {
    const limit = 4 * 1024 * 1024;
    const base = JSON.stringify({ context_usage: { usedTokens: 900, contextWindowTokens: 512000 } });
    for (const size of [limit, limit + 1]) {
      const encoded = base + ' '.repeat(size - base.length);
      db.exec('DELETE FROM local_runtime_message_rows');
      db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,created_at_ms,data_json) VALUES (?,?,?,?)')
        .run(sid, 'assistant', Date.now(), encoded);
      const snapshot = readMinimaxUsage(path, sid, true)!;
      expect(snapshot.context).toEqual(size === limit ? { usedTokens: 900, windowTokens: 512000, percentUsed: 0 } : null);
      expect(snapshot.model).toBe('MiniMax-M3'); expect(snapshot.reasoningEffort).toBe('xhigh');
    }
  });
  it('counts the requesting turn and questionnaire continuation together as one user-turn usage', () => {
    db.exec(`ALTER TABLE local_runtime_message_rows ADD COLUMN turn_id TEXT;
      ALTER TABLE local_runtime_message_rows ADD COLUMN source TEXT;
      ALTER TABLE local_runtime_message_rows ADD COLUMN source_context_json TEXT;
      CREATE TABLE questionnaire_requests (session_id TEXT, request_id TEXT, request_json TEXT);`);
    usage('previous', 1000, 100); usage('user-turn', 100, 10, 200); usage('continued', 50, 5, 500);
    db.prepare('INSERT INTO questionnaire_requests VALUES (?,?,?)').run(sid, 'ask-native', JSON.stringify({ requester: { sessionId: sid, runId: 'user-turn' } }));
    db.prepare('INSERT INTO local_runtime_message_rows (session_id,role,turn_id,source,source_context_json) VALUES (?,?,?,?,?)')
      .run(sid, 'user', 'continued', 'questionnaire', JSON.stringify({ origin: { kind: 'questionnaire-response', requestId: 'ask-native' } }));
    expect(readMinimaxUsage(path, sid, true)?.turnTokens).toEqual({ in: 850, out: 15 });
    usage('next-user-turn', 30, 3, 300);
    expect(readMinimaxUsage(path, sid, true)?.turnTokens).toEqual({ in: 330, out: 3 });
  });
  it('keeps cumulative cache-inclusive tokens distinct from latest native context after compaction', async () => {
    usage('first', 1000, 100, 400, 100); usage('first', 500, 20, 200, 50); usage('second', 50, 10, 1000);
    usage('unrelated', 999999, 9999, 0, 0, 'mvs_other');
    context(300000); context(9200); context(499000, 512000, 'mvs_other');
    const snapshot = getSessionUsageSnapshot(query());
    expect(cliSupportsNativeUsage('minimax')).toBe(true);
    expect(snapshot.context).toEqual({ usedTokens: 9200, windowTokens: 512000, percentUsed: 2 });
    expect(snapshot.tokens).toMatchObject({ in: 3300, out: 130, inputTokens: 1550, cacheReadTokens: 1600, cacheCreateTokens: 150, turns: 2 });
    expect(snapshot.turnTokens).toEqual({ in: 1050, out: 10 });
    expect(snapshot.model).toBe('MiniMax-M3'); expect(snapshot.reasoningEffort).toBe('xhigh');
    expect(getSessionTokenUsage(query())).toEqual(snapshot.tokens);
    botEnvs.set('fixture', {});
    const { getDaemonStreamingCardUsageSnapshot } = await import('../src/core/worker-pool.js');
    const ds = { larkAppId: 'fixture', session: { sessionId: 'botmux-session', cliId: 'minimax', cliSessionId: sid,
      model: 'stale-launch-model', reasoningEffort: 'low' } } as any;
    const cardUsage = getDaemonStreamingCardUsageSnapshot(ds, 'minimax', { fresh: true });
    expect(cardUsage.model).toBe('MiniMax-M3'); expect(cardUsage.reasoningEffort).toBe('xhigh');
    const card = JSON.parse(buildStreamingCard('botmux-session', 'root', 'https://example.com', 'Native usage', '',
      'idle', 'minimax', 'hidden', undefined, undefined, false, false, 'zh', undefined, undefined, false, cardUsage));
    const line = card.elements.find((e: any) => e.tag === 'markdown' && e.content.includes('512K'));
    expect(line.content).toContain('9.2K/512K (2%)');
    expect(line.content).toContain('↑3.3K'); expect(line.content).toContain('**MiniMax-M3**'); expect(line.content).toContain('xhigh');
  });

  it('requires the exact native id and never substitutes another session', () => {
    usage('first', 100, 10); context(900);
    expect(readMinimaxUsage(path, 'missing', true)).toBeNull();
    expect(getSessionUsageSnapshot({ ...query(), cliSessionId: undefined })).toEqual({ context: null, tokens: null, turnTokens: null });
  });

  it('honours a bot-specific account directory without falling back to global usage', () => {
    usage('first', 100, 10); context(900);
    botEnvs.set('different-account', { MINIMAX_DATA_DIR: join(root, 'different-account') });
    expect(resolveSessionTranscriptPath({ ...query(), larkAppId: 'different-account' })).toBeNull();
    expect(getSessionUsageSnapshot({ ...query(), larkAppId: 'different-account' }).tokens).toBeNull();
    botEnvs.set('same-account', { MINIMAX_DATA_DIR: root });
    expect(getSessionUsageSnapshot({ ...query(), larkAppId: 'same-account' }).tokens?.in).toBe(100);
  });

  it('reads live request model/effort even before usage, without fabricated counters', () => {
    const snapshot = readMinimaxUsage(path, sid, true)!;
    expect(snapshot).toMatchObject({ context: null, tokens: null, turnTokens: null, model: 'MiniMax-M3', reasoningEffort: 'xhigh' });
    artifacts('custom-model', 'medium');
    expect(readMinimaxUsage(path, sid, true)).toMatchObject({ model: 'custom-model', reasoningEffort: 'medium' });
  });

  it('does not infer context from cumulative tokens when context records are absent', () => {
    usage('first', 99999, 100, 5000);
    const snapshot = readMinimaxUsage(path, sid, true)!;
    expect(snapshot.context).toBeNull(); expect(snapshot.tokens?.in).toBe(104999);
  });

  it('ignores malformed context and rejects negative or fractional accounting', () => {
    usage('first', -1, 10); usage('first', 100, 10);
    context(-5); context(900, 0);
    const snapshot = readMinimaxUsage(path, sid, true)!;
    expect(snapshot.context).toBeNull(); expect(snapshot.tokens).toBeNull(); expect(snapshot.turnTokens).toBeNull();
    db.exec('DELETE FROM local_runtime_token_usage'); usage('first', 1.5, 10);
    expect(readMinimaxUsage(path, sid, true)?.tokens).toBeNull();
  });

  it('does not read model metadata from a different session or an unsafe path', () => {
    const manifest = join(root, 'v2', 'sessions', history, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ sessionId: 'other-session' }));
    expect(readMinimaxUsage(path, sid, true)?.model).toBeUndefined();
    db.prepare('UPDATE local_runtime_sessions SET history_relative_dir = ? WHERE session_id = ?').run('../../outside/path', sid);
    expect(readMinimaxUsage(path, sid, true)?.model).toBeUndefined();
  });

  it('rejects a four-segment metadata path containing a parent traversal even when matching artifacts exist', () => {
    const unsafe = '2026/10/../outside';
    const dir = join(root, 'v2', 'sessions', unsafe);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ sessionId: sid }));
    writeFileSync(join(dir, 'llm-call.json'), JSON.stringify({ model: 'unsafe-model', thinkingLevel: 'high' }));
    db.prepare('UPDATE local_runtime_sessions SET history_relative_dir = ? WHERE session_id = ?').run(unsafe, sid);
    expect(readMinimaxUsage(path, sid, true)?.model).toBeUndefined();
    expect(readMinimaxUsage(path, sid, true)?.reasoningEffort).toBeUndefined();
  });

  it('falls back to native usage model when request metadata is absent or malformed', () => {
    usage('first', 100, 10);
    writeFileSync(join(root, 'v2', 'sessions', history, 'llm-call.json'), 'broken-json');
    expect(readMinimaxUsage(path, sid, true)).toMatchObject({ model: 'MiniMax-M3' });
    expect(readMinimaxUsage(path, sid, true)?.reasoningEffort).toBeUndefined();
  });

  it('returns safely for missing/corrupt databases and does not create files', () => {
    const missing = join(root, 'missing.sqlite');
    expect(readMinimaxUsage(missing, sid, true)).toBeNull(); expect(existsSync(missing)).toBe(false);
    writeFileSync(missing, 'not a sqlite database');
    expect(readMinimaxUsage(missing, sid, true)).toBeNull();
  });

  it('opens read-only, retains byte-for-byte native state and isolates cached results', () => {
    usage('first', 100, 10); context(900);
    const before = readFileSync(path);
    const snapshot = readMinimaxUsage(path, sid, true)!;
    snapshot.tokens!.in = 99999;
    expect(readMinimaxUsage(path, sid)?.tokens?.in).toBe(100);
    expect(readFileSync(path)).toEqual(before);
    usage('second', 200, 20);
    expect(readMinimaxUsage(path, sid)?.tokens?.in).toBe(100);
    expect(readMinimaxUsage(path, sid, true)?.tokens?.in).toBe(300);
  });

  it('keeps context, latest turn and totals in one snapshot during a concurrent native write', () => {
    db.exec('PRAGMA journal_mode = WAL');
    usage('first', 100, 10); context(900);
    const open = sqlite.openDatabaseSyncNow;
    let wrote = false;
    const spy = vi.spyOn(sqlite, 'openDatabaseSyncNow').mockImplementation((file, options) => {
      const reader = open(file, options)!;
      return {
        exec: sql => reader.exec(sql), close: () => reader.close(),
        prepare: sql => {
          const statement = reader.prepare(sql);
          return {
            get: (...params) => {
              const row = statement.get(...params);
              if (!wrote && sql.startsWith('SELECT model, turn_id')) {
                wrote = true;
                // A distinct WAL connection commits the next turn between
                // the reader's queries, just as the native CLI can do.
                usage('second', 200, 20); context(1900);
              }
              return row;
            },
            all: (...params) => statement.all(...params),
            run: (...params) => statement.run(...params),
          };
        },
      };
    });
    try {
      const snapshot = readMinimaxUsage(path, sid, true)!;
      expect(wrote).toBe(true);
      expect(snapshot.turnTokens).toEqual({ in: 100, out: 10 });
      expect(snapshot.tokens).toMatchObject({ in: 100, out: 10, turns: 1 });
      expect(snapshot.context?.usedTokens).toBe(900);
    } finally { spy.mockRestore(); }
    expect(readMinimaxUsage(path, sid, true)).toMatchObject({
      tokens: { in: 300, out: 30, turns: 2 }, turnTokens: { in: 200, out: 20 }, context: { usedTokens: 1900 },
    });
  });
});
