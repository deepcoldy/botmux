/**
 * Persistent last-known-good `raw reviewer entry → ou_` cache for feedback
 * cards' `reviewers` audience.
 *
 * Feedback reviewers are resolved to this bot's app-scoped open_id at SEND
 * time (see materializeFeedbackReviewers). A transient contact-API failure
 * (rate limit / 5xx / timeout) must not silently converge the allowlist to an
 * empty snapshot that renders a button every real reviewer gets rejected by.
 * This sidecar keeps the last healthy `raw → ou_` mapping so the next send can
 * recover per entry — the same invariant owner allowedUsers follows
 * (allowed-users-cache.ts).
 *
 * Keyed by the RAW config entry (an email; literal ou_/on_ never need a
 * lookup), so recovery is per-entry: an entry dropped from the feedback
 * reviewers config, or one the API reported as definitively gone, is never
 * revived — callers only look up entries present in the current config and
 * only reuse a cached id when that entry transient-failed THIS pass.
 *
 * The cache is app-scoped, not chat-scoped: email → app open_id is an
 * app-wide identity, and the materializer iterates each delivery's own
 * reviewer list, so mappings can never leak across chats with different sets.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from './atomic-write.js';
import { logger } from './logger.js';

export function feedbackReviewersCachePath(dataDir: string, larkAppId: string): string {
  return join(dataDir, `feedback-reviewers-cache-${larkAppId}.json`);
}

/** Read the persisted `raw → ou_` cache (ou_ values only). `{}` on any error. */
export function readFeedbackReviewersCache(dataDir: string, larkAppId: string): Record<string, string> {
  try {
    const fp = feedbackReviewersCachePath(dataDir, larkAppId);
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

export interface WriteFeedbackReviewersCacheOpts {
  /** Fresh `raw → ou_` pairs to upsert (only ou_ values are kept). */
  map: Map<string, string> | Record<string, string>;
  /**
   * Entries to delete regardless of `map` — entries this pass proved
   * definitively gone (no such user / not visible), so a later transient blip
   * cannot recover a reviewer that has actually been removed.
   */
  deleteEntries?: Iterable<string>;
  /**
   * When provided, prune the cache to ONLY these raw keys (plus the `map`
   * upserts). Pass the current reviewer emails so entries removed from config
   * never linger. Omit on degraded passes so unrelated healthy entries survive.
   */
  retainKeys?: Iterable<string>;
}

/**
 * Persist the feedback reviewers cache. Merges `map` over the existing cache,
 * deletes `deleteEntries`, and — when `retainKeys` is given — drops every key
 * not in that set. Best-effort; never throws (a failed write only costs the
 * next send its fallback).
 */
export function writeFeedbackReviewersCache(
  dataDir: string,
  larkAppId: string,
  opts: WriteFeedbackReviewersCacheOpts,
): void {
  try {
    let merged = readFeedbackReviewersCache(dataDir, larkAppId);

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
      feedbackReviewersCachePath(dataDir, larkAppId),
      JSON.stringify({ map: merged, updatedAt: Date.now() }),
      { mode: 0o600 },
    );
  } catch (err: any) {
    logger.debug(`[${larkAppId}] failed to persist feedback reviewers cache: ${err?.message ?? err}`);
  }
}
