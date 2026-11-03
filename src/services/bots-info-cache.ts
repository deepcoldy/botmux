/**
 * Process-local read cache for the shared `bots-info.json` (one entry per bot,
 * merged in by every bot daemon via writeBotInfoFile).
 *
 * Same fingerprint scheme as peer-cross-ref-store: every read still stats the
 * file, but its bytes are only re-read and re-parsed when the fingerprint
 * changes, so a sibling daemon's atomic replace is visible on the next call.
 * Meant for hot paths (every inbound @-mention, every turn's final output);
 * writers must keep reading the file directly for their read-modify-write.
 *
 * Semantics deliberately match a bare `existsSync` + `JSON.parse`:
 *  - missing / unstat-able file → undefined (like `existsSync` → false)
 *  - parseable → the parsed value (shared across calls — treat as read-only)
 *  - corrupt → throws the parse error (cached for that exact fingerprint), so
 *    callers' existing catch branches behave exactly as before
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

type CacheEntry =
  | { version: string; ok: true; value: unknown }
  | { version: string; ok: false; error: unknown };

const cache = new Map<string, CacheEntry>();

function fileVersion(fp: string): string {
  try {
    const stat = statSync(fp);
    // Writers publish through atomic rename. Include inode and both timestamps
    // so a same-size replacement is not hidden by coarse mtime resolution.
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 'missing';
    return `unavailable:${err?.code ?? 'unknown'}`;
  }
}

function settle(entry: CacheEntry): unknown {
  if (entry.ok) return entry.value;
  throw entry.error;
}

/** Parsed contents of `<dataDir>/bots-info.json`; see module doc for semantics. */
export function readBotsInfoJson(dataDir: string): unknown {
  const fp = join(dataDir, 'bots-info.json');

  // Retry a concurrently replaced file instead of associating bytes from one
  // inode with another inode's fingerprint. Atomic writers make this converge.
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = fileVersion(fp);
    const cached = cache.get(fp);
    if (cached?.version === before) return settle(cached);
    // existsSync() is false for any stat failure, not just ENOENT — match it.
    if (before === 'missing' || before.startsWith('unavailable:')) {
      cache.set(fp, { version: before, ok: true, value: undefined });
      return undefined;
    }

    let raw: string;
    try {
      raw = readFileSync(fp, 'utf-8');
    } catch (error) {
      if (fileVersion(fp) !== before) continue;
      throw error;
    }
    const after = fileVersion(fp);
    if (after !== before) continue;

    let entry: CacheEntry;
    try {
      entry = { version: after, ok: true, value: JSON.parse(raw) };
    } catch (error) {
      entry = { version: after, ok: false, error };
    }
    cache.set(fp, entry);
    return settle(entry);
  }

  // The file kept changing under us; fall back to one uncached read.
  return JSON.parse(readFileSync(fp, 'utf-8'));
}

/** Test-only: isolate process-local cache state between cases. */
export function __resetBotsInfoCacheForTest(): void {
  cache.clear();
}
