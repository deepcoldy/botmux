/**
 * Persistent last-known-good `raw entry → ou_` cache for allowedUsers.
 *
 * This is DELIBERATELY NOT the dashboard descriptor: that descriptor is
 * (a) overwritten unconditionally early in daemon boot with the still-unresolved
 * raw config (so its `resolvedAllowedUsers` is `[]` for an on_/email-only owner),
 * and (b) deleted on every clean shutdown. Reading it as a fallback source is
 * dead-on-arrival for the transient-failure-on-restart scenario this cache
 * exists to survive. This sidecar lives in the persistent data dir, is written
 * whenever a healthy/partial resolve or a hot config/grant mutation produces a
 * fresh `raw → ou_` mapping, and is never deleted on shutdown.
 *
 * Keyed by raw config entry so recovery is per-entry: an entry removed from
 * config (owner swap / revoke) or definitively gone is never revived. Both the
 * daemon startup/retry path and the runtime set/revoke paths write through here
 * so the cache never diverges from the live allowlist.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from './atomic-write.js';
import { logger } from './logger.js';

export function allowedUsersCachePath(dataDir: string, larkAppId: string): string {
  return join(dataDir, `allowed-users-cache-${larkAppId}.json`);
}

/** Read the persisted `raw → ou_` cache (ou_ values only). `{}` on any error. */
export function readAllowedUsersResolveCache(dataDir: string, larkAppId: string): Record<string, string> {
  try {
    const fp = allowedUsersCachePath(dataDir, larkAppId);
    if (!existsSync(fp)) return {};
    const raw = JSON.parse(readFileSync(fp, 'utf8')) as { map?: unknown };
    const m = raw?.map;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string' && v.startsWith('ou_')) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export interface WriteAllowedUsersCacheOpts {
  /**
   * Fresh `raw → ou_` pairs to upsert (only ou_ values are kept). Callers pass
   * the resolve/mutation result map.
   */
  map: Map<string, string> | Record<string, string>;
  /**
   * Entries to delete from the cache regardless of `map` — e.g. definitively-gone
   * ids (removed from tenant) or a raw entry just revoked. Pruned so a later
   * restart during an API blip can't mark them transient and revive a stale owner.
   */
  deleteEntries?: Iterable<string>;
  /**
   * When provided, the cache is pruned to ONLY these raw keys (plus whatever
   * `map` upserts). Pass the current raw allowedUsers config so keys no longer
   * configured (owner swap) never linger. Omit to merge without pruning.
   */
  retainKeys?: Iterable<string>;
}

/**
 * Persist the `raw → ou_` cache. Merges `map` over the existing cache, deletes
 * `deleteEntries`, and — when `retainKeys` is given — drops every key not in
 * that set. Best-effort; never throws.
 */
export function writeAllowedUsersResolveCache(
  dataDir: string,
  larkAppId: string,
  opts: WriteAllowedUsersCacheOpts,
): void {
  try {
    let merged = readAllowedUsersResolveCache(dataDir, larkAppId);

    if (opts.retainKeys) {
      const keep = new Set<string>();
      for (const k of opts.retainKeys) if (typeof k === 'string') keep.add(k);
      const pruned: Record<string, string> = {};
      for (const [k, v] of Object.entries(merged)) if (keep.has(k)) pruned[k] = v;
      merged = pruned;
    }

    for (const e of opts.deleteEntries ?? []) {
      if (typeof e === 'string') delete merged[e];
    }

    const entries: Iterable<[string, string]> = opts.map instanceof Map
      ? opts.map.entries()
      : Object.entries(opts.map);
    for (const [k, v] of entries) {
      if (typeof k === 'string' && typeof v === 'string' && v.startsWith('ou_')) merged[k] = v;
    }

    atomicWriteFileSync(
      allowedUsersCachePath(dataDir, larkAppId),
      JSON.stringify({ map: merged, updatedAt: Date.now() }),
      { mode: 0o600 },
    );
  } catch (err: any) {
    logger.debug(`[${larkAppId}] failed to persist allowedUsers cache: ${err?.message ?? err}`);
  }
}
