/**
 * Process-local cache for the per-receiver Lark peer open_id cross-reference.
 *
 * Every lookup still stats the file. The metadata fingerprint makes atomic
 * replacements from sibling daemon processes visible while avoiding repeated
 * file-content reads and JSON.parse calls when the file is unchanged.
 */
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export type PeerCrossRef = Readonly<Record<string, string>>;

type CacheEntry = {
  version: string;
  value: PeerCrossRef;
};

const EMPTY_CROSS_REF: PeerCrossRef = Object.freeze({});
const cache = new Map<string, CacheEntry>();

function crossRefPath(dataDir: string, larkAppId: string): string {
  return join(dataDir, `bot-openids-${larkAppId}.json`);
}

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

function parseCrossRef(raw: string): PeerCrossRef {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_CROSS_REF;

  const entries = Object.entries(parsed)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0
    ? Object.freeze(Object.fromEntries(entries))
    : EMPTY_CROSS_REF;
}

/** Read a name-preserving peer cross-reference, failing soft to an empty map. */
export function readPeerCrossRef(dataDir: string, larkAppId: string): PeerCrossRef {
  const fp = crossRefPath(dataDir, larkAppId);

  // Retry a concurrently replaced file instead of associating bytes from one
  // inode with another inode's fingerprint. Atomic writers make this converge.
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = fileVersion(fp);
    const cached = cache.get(fp);
    if (cached?.version === before) return cached.value;

    if (before === 'missing' || before.startsWith('unavailable:')) {
      cache.set(fp, { version: before, value: EMPTY_CROSS_REF });
      return EMPTY_CROSS_REF;
    }

    let raw: string;
    try {
      raw = readFileSync(fp, 'utf-8');
    } catch {
      const after = fileVersion(fp);
      if (after !== before) continue;
      return EMPTY_CROSS_REF;
    }

    const after = fileVersion(fp);
    if (after !== before) continue;

    let value = EMPTY_CROSS_REF;
    try {
      value = parseCrossRef(raw);
    } catch {
      // A corrupt file is not an identity signal. Cache the fail-soft result
      // only for this exact fingerprint so a later repair is visible.
    }
    cache.set(fp, { version: after, value });
    return value;
  }

  return EMPTY_CROSS_REF;
}

/** Persist and immediately publish the new snapshot to readers in this process. */
export function writePeerCrossRef(
  dataDir: string,
  larkAppId: string,
  value: Readonly<Record<string, string>>,
): void {
  mkdirSync(dataDir, { recursive: true });
  const fp = crossRefPath(dataDir, larkAppId);
  const normalized = Object.freeze(Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  ));
  atomicWriteFileSync(fp, JSON.stringify(normalized, null, 2) + '\n');

  // Repopulate from a stable post-write snapshot before returning. Usually it
  // is exactly normalized; if another daemon wins a concurrent atomic rename,
  // cache that newer winner rather than pairing our bytes with its fingerprint.
  cache.delete(fp);
  readPeerCrossRef(dataDir, larkAppId);
}

/** Test-only: isolate process-local cache state between cases. */
export function __resetPeerCrossRefCacheForTest(): void {
  cache.clear();
}
