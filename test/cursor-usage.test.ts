import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { openDatabaseSyncNow, type DatabaseSyncLike } from '../src/services/sqlite-compat.js';
import { readCursorContext, readCursorUsage, resetCursorUsageCacheForTest } from '../src/services/cursor-usage.js';
import { appendCursorUsage, cursorUsageJournalPath, installCursorUsageHook, parseCursorUsageHook, prepareCursorUsageJournal, runCursorUsageHook } from '../src/services/cursor-usage-hook.js';
import { getSessionTokenUsage, getSessionUsageSnapshot } from '../src/core/cost-calculator.js';
import { cursorConfigDirForBot } from '../src/services/cursor-paths.js';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

const botEnvs = vi.hoisted(() => new Map<string, Record<string, string>>());
vi.mock('../src/bot-registry.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return { ...actual, getBot: (id: string) => botEnvs.has(id) ? { config: { env: botEnvs.get(id) } } : actual.getBot(id) };
});

const chat = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const generation = '33333333-3333-4333-8333-333333333333';
const sid = 'botmux-session';
let root: string, configDir: string, dataDir: string, dbPath: string, journal: string;
let db: DatabaseSyncLike;

function varint(n: number | bigint): Buffer {
  let value = BigInt(n); const bytes: number[] = [];
  do { bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0)); value >>= 7n; } while (value);
  return Buffer.from(bytes);
}
function field(id: number, value: Buffer | number | bigint): Buffer {
  return Buffer.isBuffer(value) ? Buffer.concat([varint(id * 8 + 2), varint(value.length), value])
    : Buffer.concat([varint(id * 8), varint(value)]);
}
function storeRoot(blob: Buffer, agentId = chat): void {
  const id = 'a'.repeat(64);
  db.prepare('INSERT OR REPLACE INTO blobs VALUES (?, ?)').run(id, blob);
  db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('0', Buffer.from(JSON.stringify({
    agentId, latestRootBlobId: id, blobEncryptionKey: 'must-never-be-exported', lastUsedModel: 'base-model',
  })).toString('hex'));
}
function context(used = 183611, max = 300000): void {
  storeRoot(Buffer.concat([field(1, Buffer.from('unknown field')), field(5, Buffer.concat([field(1, used), field(2, max)]))]));
}
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { hook_event_name: 'stop', status: 'completed', conversation_id: chat, generation_id: generation,
    model: 'claude-opus-5-5-high', input_tokens: 14144, output_tokens: 4, cache_read_tokens: 9000, cache_write_tokens: 5140, ...overrides };
}
function snapshot(fresh = true) { return readCursorUsage(configDir, dataDir, sid, chat, fresh); }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botmux-cursor-usage-'));
  configDir = join(root, 'cursor'); dataDir = join(root, 'botmux');
  const dir = join(configDir, 'chats', 'project-hash', chat);
  mkdirSync(dir, { recursive: true }); dbPath = join(dir, 'store.db');
  db = openDatabaseSyncNow(dbPath)!;
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);');
  journal = cursorUsageJournalPath(dataDir, sid)!;
  vi.stubEnv('CURSOR_CONFIG_DIR', configDir); vi.stubEnv('SESSION_DATA_DIR', dataDir);
  resetCursorUsageCacheForTest(); botEnvs.clear();
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); resetCursorUsageCacheForTest(); rmSync(root, { recursive: true, force: true }); });

describe('Cursor native context', () => {
  it('reads the exact chat snapshot from WAL, independently of transcript/usage and theoretical model limits', () => {
    context();
    expect(snapshot()).toEqual({ context: { usedTokens: 183611, windowTokens: 300000, percentUsed: 61 }, tokens: null, turnTokens: null });
    context(9200); // compacted state replaces, never sums, prior context
    expect(snapshot().context?.usedTokens).toBe(9200);
    expect(JSON.stringify(snapshot())).not.toContain('must-never-be-exported');
    expect(readCursorContext(dbPath, other)).toBeNull();
    expect(readCursorUsage(configDir, dataDir, sid, other).context).toBeNull();
  });

  it('does not create a missing database or choose the most recent chat', () => {
    expect(readCursorContext(join(root, 'missing.db'), chat)).toBeNull();
    expect(existsSync(join(root, 'missing.db'))).toBe(false);
    context();
    expect(readCursorUsage(configDir, dataDir, sid, '../../escape')).toEqual({ context: null, tokens: null, turnTokens: null });
  });

  it.each([
    Buffer.from([0x2a, 0x80]), // truncated length
    Buffer.from([0x2a, 9, 8, 1]), // length exceeds remaining bytes
    Buffer.from([0x2a, 3, 8, 0x80, 0x80]), // truncated scalar
    Buffer.from([0x00]), // illegal tag
    field(5, Buffer.concat([field(1, 1), field(1, 2), field(2, 300000)])),
    field(5, Buffer.concat([field(1, BigInt(Number.MAX_SAFE_INTEGER) + 1n), field(2, 300000)])),
    field(5, field(1, 100)), // no capacity
    field(5, Buffer.concat([field(1, 1), field(2, 0)])),
    Buffer.concat([field(5, field(2, 300000)), Buffer.from([0x09, 0x01])]), // truncated skipped fixed64
  ])('fails closed for unsupported or corrupt protobuf %s', blob => {
    storeRoot(blob); expect(snapshot().context).toBeNull();
  });

  it('accepts protobuf default zero only when a real capacity exists', () => {
    storeRoot(field(5, field(2, 300000)));
    expect(snapshot().context).toEqual({ usedTokens: 0, windowTokens: 300000, percentUsed: 0 });
  });

  it('rejects corrupt/oversized metadata and ambiguous store copies', () => {
    context(); db.prepare('UPDATE meta SET value = ?').run('not-hex');
    expect(snapshot().context).toBeNull();
    db.prepare('UPDATE meta SET value = ?').run('aa'.repeat(65537));
    expect(snapshot().context).toBeNull();
    context(); const duplicate = join(configDir, 'chats', 'copy', chat);
    mkdirSync(duplicate, { recursive: true }); writeFileSync(join(duplicate, 'store.db'), '');
    expect(snapshot().context).toBeNull();
  });

  it('honours config roots (not DATA_DIR) and bot-specific profiles without global fallback', () => {
    context(); vi.stubEnv('CURSOR_DATA_DIR', join(root, 'transcripts-only'));
    const query = { cliId: 'cursor' as const, sessionId: sid, cliSessionId: chat, fresh: true };
    expect(getSessionUsageSnapshot(query).context?.usedTokens).toBe(183611);
    botEnvs.set('other-account', { CURSOR_CONFIG_DIR: join(root, 'absent') });
    expect(getSessionUsageSnapshot({ ...query, larkAppId: 'other-account' }).context).toBeNull();
    vi.stubEnv('CURSOR_CONFIG_DIR', ''); vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg'));
    expect(cursorConfigDirForBot()).toBe(join(root, 'xdg', 'cursor'));
  });
});

describe('Cursor observed usage', () => {
  it('deduplicates generations, includes cache exactly once and resumes persisted totals', () => {
    context(); appendCursorUsage(dataDir, sid, payload());
    appendCursorUsage(dataDir, sid, payload({ generation_id: other, input_tokens: 102, cache_read_tokens: 100, cache_write_tokens: 0, output_tokens: 10 }));
    appendCursorUsage(dataDir, sid, payload()); // late duplicate must not replace latest turn
    appendCursorUsage(dataDir, sid, payload({ conversation_id: other, input_tokens: 999999 }));
    resetCursorUsageCacheForTest(); prepareCursorUsageJournal(dataDir, sid);
    const result = snapshot();
    expect(result.tokens).toEqual({ inputTokens: 6, outputTokens: 14, cacheReadTokens: 9100, cacheCreateTokens: 5140,
      in: 14246, out: 14, turns: 2, model: 'claude-opus-5-5-high' });
    expect(result.turnTokens).toEqual({ in: 102, out: 10 });
    expect(result.context?.usedTokens).toBe(183611);
    expect(getSessionTokenUsage({ cliId: 'cursor', sessionId: sid, cliSessionId: chat, fresh: true })).toEqual(result.tokens);
    expect(readCursorUsage(configDir, dataDir, 'sibling', chat).tokens).toBeNull();
  });

  it('feeds the existing streaming card with native context and cumulative usage', async () => {
    context(); appendCursorUsage(dataDir, sid, payload());
    botEnvs.set('cursor-bot', {});
    const { getDaemonStreamingCardUsageSnapshot } = await import('../src/core/worker-pool.js');
    const { buildStreamingCard } = await import('../src/im/lark/card-builder.js');
    const ds = { larkAppId: 'cursor-bot', session: { sessionId: sid, cliId: 'cursor', cliSessionId: chat,
      model: 'claude-opus-5-5-high' } } as any;
    const usage = getDaemonStreamingCardUsageSnapshot(ds, 'cursor', { fresh: true });
    expect(usage.tokens?.in).toBe(14144); expect(usage.context?.windowTokens).toBe(300000);
    const card = JSON.parse(buildStreamingCard(sid, 'root', 'https://example.com', 'Cursor usage', '',
      'idle', 'cursor', 'hidden', undefined, undefined, false, false, 'zh', undefined, undefined, false, usage));
    const line = card.elements.find((e: any) => e.tag === 'markdown' && e.content.includes('300K'));
    expect(line.content).toContain('183.6K/300K (61%)');
    expect(line.content).toContain('↑14.1K');
  });

  it('prices each observed generation using its own model and exclusive cache counts', () => {
    appendCursorUsage(dataDir, sid, payload({ model: 'model-a' }));
    appendCursorUsage(dataDir, sid, payload({ generation_id: other, model: 'model-b', input_tokens: 2, output_tokens: 3, cache_read_tokens: 0, cache_write_tokens: 0 }));
    const pricing = { usdCny: 1, overrides: { models: {
      'model-a': { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 },
      'model-b': { input: 100, output: 200 },
    } } };
    const result = getSessionUsageSnapshot({ cliId: 'cursor', sessionId: sid, cliSessionId: chat, fresh: true, pricing });
    expect(result.costCny).toBeCloseTo((4 * 10 + 4 * 20 + 9000 + 5140 * 2 + 2 * 100 + 3 * 200) / 1e6);
    expect(snapshot().costCny).toBeUndefined();
  });

  it.each([{ input_tokens: -1 }, { output_tokens: 1.5 }, { cache_read_tokens: null }, { cache_write_tokens: undefined },
    { input_tokens: 1 }, { input_tokens: Number.MAX_SAFE_INTEGER + 1 }, { generation_id: '' },
    { hook_event_name: 'afterAgentResponse' }, { status: 'unknown' }])('rejects incomplete or invalid counters %j', change => {
    expect(parseCursorUsageHook(payload(change))).toBeNull();
    appendCursorUsage(dataDir, sid, payload(change)); expect(existsSync(journal)).toBe(false);
  });

  it('keeps valid counters when the runtime does not provide a model label', () => {
    appendCursorUsage(dataDir, sid, payload({ model: undefined }));
    expect(snapshot().tokens?.inputTokens).toBe(4); expect(snapshot().model).toBeUndefined();
  });

  it.each(['aborted', 'error'])('accepts real counters on %s but never invents missing usage', status => {
    expect(parseCursorUsageHook(payload({ status }))?.inputTokens).toBe(4);
    expect(parseCursorUsageHook(payload({ status, input_tokens: undefined }))).toBeNull();
  });

  it('bounds journal reads while preserving independently readable context', () => {
    context(); prepareCursorUsageJournal(dataDir, sid);
    writeFileSync(journal, 'x'.repeat(16 * 1024 * 1024 + 1));
    expect(snapshot().tokens).toBeNull(); expect(snapshot().context?.usedTokens).toBe(183611);
  });

  it('keeps missing history unknown and fails closed on conflicting events or damaged journal', () => {
    prepareCursorUsageJournal(dataDir, sid); expect(snapshot().tokens).toBeNull();
    appendCursorUsage(dataDir, sid, payload()); appendFileSync(journal, '{partial');
    expect(snapshot().tokens?.turns).toBe(1);
    appendFileSync(journal, '\n'); expect(snapshot().tokens).toBeNull();
    writeFileSync(journal, ''); appendCursorUsage(dataDir, sid, payload());
    appendCursorUsage(dataDir, sid, payload({ output_tokens: 99 }));
    expect(snapshot().tokens).toBeNull();
  });

  it('bypasses the live cache for exact reads and isolates caller mutations', () => {
    context(); const first = snapshot(false); context(9000); first.context!.usedTokens = 42;
    expect(snapshot(false).context?.usedTokens).toBe(183611);
    appendCursorUsage(dataDir, sid, payload());
    expect(snapshot(false).tokens).toBeNull();
    expect(snapshot(true).tokens?.in).toBe(14144);
    expect(snapshot(false).context?.usedTokens).toBe(9000);
  });

  it('stores only numeric/identity fields and rejects path traversal and symlink targets', async () => {
    await runCursorUsageHook(Readable.from([JSON.stringify(payload({ text: 'private prompt', user_email: 'private@example.com' }))]),
      { SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sid });
    const saved = readFileSync(journal, 'utf8');
    expect(saved).not.toContain('private'); expect(saved).not.toContain('hook_event_name');
    expect(cursorUsageJournalPath(dataDir, '../escape')).toBeNull();
    expect(cursorUsageJournalPath('relative', sid)).toBeNull();
    const target = join(root, 'do-not-change'); writeFileSync(target, 'original');
    rmSync(journal); symlinkSync(target, journal);
    await runCursorUsageHook(Readable.from([JSON.stringify(payload())]), { SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sid });
    expect(readFileSync(target, 'utf8')).toBe('original');
  });

  it('is quiet and bounded on missing env, invalid JSON and oversized stdin', async () => {
    for (const text of ['bad json', 'x'.repeat(1024 * 1024 + 1)]) {
      await runCursorUsageHook(Readable.from([text]), { SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sid });
    }
    await runCursorUsageHook(Readable.from([JSON.stringify(payload())]), {});
    expect(existsSync(journal)).toBe(false);
  });

  it.each(['0', '1'])('dispatches the real hidden CLI command for managed sessions (workflow=%s)', workflow => {
    const options = { cwd: resolve('.'), env: { ...process.env, SESSION_DATA_DIR: dataDir, BOTMUX_SESSION_ID: sid, BOTMUX_WORKFLOW: workflow },
      input: JSON.stringify(payload()), encoding: 'utf8' as const, timeout: 30000 };
    const result = spawnSyncTsScript('src/cli.ts', ['__cursor-usage-v1'], options);
    expect(result.status, String(result.stderr)).toBe(0); expect(result.stdout).toBe('');
    expect(snapshot().tokens?.in).toBe(14144);
    rmSync(journal);
    const unmanaged = spawnSyncTsScript('src/cli.ts', ['__cursor-usage-v1'], { ...options, env: { ...options.env, BOTMUX_SESSION_ID: '' } });
    expect(unmanaged.status, String(unmanaged.stderr)).toBe(0); expect(unmanaged.stdout).toBe('');
    expect(existsSync(journal)).toBe(false);
  }, 65000);
});

describe('Cursor hook installation', () => {
  it('preserves user hooks and settings, upgrades its own command and remains idempotent', () => {
    const path = join(root, 'hooks.json');
    const user = { command: 'my-user-hook', timeout: 9 };
    writeFileSync(path, JSON.stringify({ version: 1, custom: 'keep', hooks: { stop: [user], beforeSubmitPrompt: [user] } }));
    installCursorUsageHook(path, 'old __cursor-usage-v1');
    installCursorUsageHook(path, 'new __cursor-usage-v1');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    expect(saved.custom).toBe('keep'); expect(saved.hooks.beforeSubmitPrompt).toEqual([user]);
    expect(saved.hooks.stop).toEqual([user, { command: 'new __cursor-usage-v1', timeout: 5, loop_limit: null }]);
    const mtime = statSync(path).mtimeMs;
    installCursorUsageHook(path, 'new __cursor-usage-v1'); expect(statSync(path).mtimeMs).toBe(mtime);
  });

  it.each(['bad json', '[]', '{"version":2}', '{"hooks":[]}', '{"hooks":{"stop":{}}}'])('preserves unsupported user configuration %s', content => {
    const path = join(root, 'hooks.json'); writeFileSync(path, content);
    expect(() => installCursorUsageHook(path, 'cmd __cursor-usage-v1')).toThrow();
    expect(readFileSync(path, 'utf8')).toBe(content);
  });
});
