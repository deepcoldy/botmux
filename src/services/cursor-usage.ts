import { closeSync, constants, existsSync, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { estimateCostCny, type ResolvedModelPricing } from './model-pricing.js';
import type { SessionContextUsage, SessionUsageSnapshot } from '../core/cost-calculator.js';
import { openDatabaseSyncNow } from './sqlite-compat.js';
import { cursorUsageJournalPath, isCursorChatId, parseCursorTurnUsage, type CursorTurnUsage } from './cursor-usage-hook.js';

const MAX_BYTES = 16 * 1024 * 1024;
const cache = new Map<string, { at: number; snapshot: SessionUsageSnapshot }>();
const empty = (): SessionUsageSnapshot => ({ context: null, tokens: null, turnTokens: null });

/** Minimal protobuf wire reader. Validate the ENTIRE message, including skipped
 * fields, so truncated lengths/varints cannot become plausible token counts. */
function protoField(bytes: Uint8Array, field: number, wire: 0 | 2): bigint | Uint8Array | undefined {
  let offset = 0;
  let result: bigint | Uint8Array | undefined;
  function varint(): bigint {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= bytes.length) throw new Error('Truncated varint');
      const b = bytes[offset++];
      if (shift === 63n && b > 1) throw new Error('Overflow');
      value |= BigInt(b & 127) << shift;
      if (!(b & 128)) return value;
    }
    throw new Error('Overflow');
  }
  while (offset < bytes.length) {
    const tag = varint();
    const id = Number(tag >> 3n), kind = Number(tag & 7n);
    if (id === 0 || id > 0x1fffffff) throw new Error('Invalid tag');
    let value: bigint | Uint8Array | undefined;
    if (kind === 0) value = varint();
    else if (kind === 2) {
      const length = varint();
      if (length > BigInt(bytes.length - offset)) throw new Error('Truncated field');
      value = bytes.subarray(offset, offset + Number(length));
      offset += Number(length);
    } else if (kind === 1 || kind === 5) {
      offset += kind === 1 ? 8 : 4;
      if (offset > bytes.length) throw new Error('Truncated fixed field');
    } else throw new Error('Unsupported wire type');
    if (id === field) {
      if (kind !== wire || result !== undefined) throw new Error('Ambiguous field');
      result = value;
    }
  }
  return result;
}

/** Verified on Cursor Agent 2026.10.14: ConversationStateStructure.token_details
 * is field 5; ConversationTokenDetails.used_tokens/max_tokens are fields 1/2.
 * This is current context, NEVER cumulative billable input. Unknown schemas and
 * unavailable/locked stores fail closed without altering Cursor's database. */
export function readCursorContext(databasePath: string, chatId: string): SessionContextUsage | null {
  if (!isCursorChatId(chatId)) return null;
  const db = openDatabaseSyncNow(databasePath, { readOnly: true });
  if (!db) return null;
  try {
    db.exec('BEGIN');
    const meta = db.prepare("SELECT value FROM meta WHERE key = '0' AND length(value) <= 131072").get() as { value?: unknown } | undefined;
    if (typeof meta?.value !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(meta.value)) return null;
    const metadata = JSON.parse(Buffer.from(meta.value, 'hex').toString('utf8'));
    if (metadata?.agentId !== chatId || typeof metadata.latestRootBlobId !== 'string'
      || !/^[0-9a-f]{64}$/i.test(metadata.latestRootBlobId)) return null;
    const row = db.prepare('SELECT data FROM blobs WHERE id = ? AND length(data) <= ?')
      .get(metadata.latestRootBlobId, MAX_BYTES) as { data?: unknown } | undefined;
    if (!(row?.data instanceof Uint8Array)) return null;
    const details = protoField(row.data, 5, 2);
    if (!(details instanceof Uint8Array)) return null;
    // Protobuf zero scalars are omitted. A real positive max is still required.
    const used = protoField(details, 1, 0) ?? 0n;
    const max = protoField(details, 2, 0);
    if (typeof used !== 'bigint' || typeof max !== 'bigint' || max <= 0n
      || used > BigInt(Number.MAX_SAFE_INTEGER) || max > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const usedTokens = Number(used), windowTokens = Number(max);
    return { usedTokens, windowTokens, percentUsed: Math.round(usedTokens / windowTokens * 100) };
  } catch { return null; }
  finally {
    try { db.exec('ROLLBACK'); } catch { /* BEGIN may fail */ }
    db.close();
  }
}

function findStore(configDir: string, chatId: string): string | null {
  if (!isCursorChatId(chatId)) return null;
  try {
    // Exact native UUID, never most-recent chat or cwd-only matching. Stop on
    // ambiguity rather than mix a copied database with an active conversation.
    const roots = readdirSync(join(configDir, 'chats'), { withFileTypes: true });
    let found: string | null = null;
    for (const root of roots) {
      if (!root.isDirectory()) continue;
      const path = join(configDir, 'chats', root.name, chatId, 'store.db');
      if (!existsSync(path)) continue;
      if (found) return null;
      found = path;
    }
    return found;
  } catch { return null; }
}

function readJournal(path: string | null, chatId: string, pricing?: ResolvedModelPricing): SessionUsageSnapshot {
  const snapshot = empty();
  if (!path) return snapshot;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return snapshot;
    // Read only the statted prefix: a concurrent append cannot grow this read
    // beyond the bound or force an unbounded allocation.
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const text = buffer.subarray(0, offset).toString('utf8');
    const turns = new Map<string, CursorTurnUsage>();
    let latest: CursorTurnUsage | undefined;
    // Ignore an incomplete last append; retry it on the next read.
    const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n');
    for (const line of lines) {
      if (!line) continue;
      const value = parseCursorTurnUsage(JSON.parse(line));
      if (!value) return snapshot; // corrupt history must not become partial totals
      if (value.conversationId !== chatId) continue;
      const previous = turns.get(value.generationId);
      if (previous) {
        // Replayed stop is idempotent. Conflicting counters have no documented
        // merge semantics; do not guess whether they are deltas or replacements.
        if (JSON.stringify(previous) !== JSON.stringify(value)) return snapshot;
        continue;
      }
      turns.set(value.generationId, value);
      latest = value;
    }
    if (!latest) return snapshot;
    const tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
      in: 0, out: 0, turns: turns.size, model: latest.model };
    let costCny: number | null = 0;
    for (const value of turns.values()) {
      const cost = estimateCostCny(value, pricing);
      costCny = costCny !== null && cost !== null ? costCny + cost : null;
      tokens.inputTokens += value.inputTokens; tokens.outputTokens += value.outputTokens;
      tokens.cacheReadTokens += value.cacheReadTokens; tokens.cacheCreateTokens += value.cacheCreateTokens;
    }
    tokens.in = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheCreateTokens;
    tokens.out = tokens.outputTokens;
    if (![tokens.inputTokens, tokens.outputTokens, tokens.cacheReadTokens, tokens.cacheCreateTokens, tokens.in].every(Number.isSafeInteger)) return snapshot;
    snapshot.tokens = tokens;
    snapshot.turnTokens = { in: latest.inputTokens + latest.cacheReadTokens + latest.cacheCreateTokens, out: latest.outputTokens };
    if (latest.model) snapshot.model = latest.model;
    if (costCny !== null && Number.isFinite(costCny)) snapshot.costCny = costCny;
    return snapshot;
  } catch { return snapshot; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** The journal contains observed stop events only (no historical backfill).
 * Separate sources let adopted/older sessions show native context even before
 * a Botmux-managed Cursor process has emitted its first usage callback. */
export function readCursorUsage(configDir: string, dataDir: string, sessionId: string, chatId: string, fresh = false, pricing?: ResolvedModelPricing): SessionUsageSnapshot {
  if (!isCursorChatId(chatId)) return empty();
  const key = JSON.stringify([configDir, dataDir, sessionId, chatId, pricing]);
  const previous = cache.get(key);
  if (!fresh && previous && Date.now() - previous.at < 1000) return structuredClone(previous.snapshot);
  const snapshot = readJournal(cursorUsageJournalPath(dataDir, sessionId), chatId, pricing);
  const path = findStore(configDir, chatId);
  snapshot.context = path ? readCursorContext(path, chatId) : null;
  if (cache.size >= 128 && !cache.has(key)) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), snapshot: structuredClone(snapshot) });
  return snapshot;
}

export function resetCursorUsageCacheForTest(): void { cache.clear(); }
