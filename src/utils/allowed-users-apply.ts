/**
 * Decide how to apply a startup / refresh resolve of allowedUsers.
 *
 * Runtime permission (canTalk/canOperate) only matches app-scoped open_ids
 * (`ou_…`). Config may store stable `on_…` / emails that must be resolved each
 * boot. A transient contact API failure used to overwrite the runtime list with
 * `[]`, which fail-closed locks out even the real owner with almost no signal.
 *
 * This module merges the fresh resolve with a last-known-good `raw → ou_` cache,
 * but ONLY per-entry and ONLY when that entry both (a) transient-failed this
 * pass and (b) is still present in the current raw config. That guards against
 * two revival hazards a bare `ou_[]` fallback list would create:
 *   - config swaps owner `on_old → on_new`, contact API blips → `ou_old` would
 *     be resurrected from cache even though the operator removed it;
 *   - an owner is definitively removed from the tenant (errored=false,
 *     resolved=[]) → they would be revived indefinitely.
 * The cache is keyed by raw entry, so an entry no longer in config, or one that
 * resolved definitively-gone, is never reused.
 */

import type { EntryResolveStatus } from '../im/lark/client.js';
import { entryNeedsContactResolve } from '../setup/bot-config-editor.js';

export interface AllowedUsersResolveResultLike {
  resolved: string[];
  map: Map<string, string>;
  /** True when contact API hit a transient failure (network / 5xx / rate limit). */
  errored?: boolean;
  /**
   * Per-raw-entry outcome. Entries absent from the map are treated as
   * `definitive` (safest: never revived from cache).
   */
  entryStatus?: Map<string, EntryResolveStatus>;
  /**
   * Raw entries this pass definitively could not resolve. Unused by the pure
   * merge (definitive drops are simply not revived — see `entryStatus`); present
   * so callers can pass the resolver result through unchanged and surface the
   * misses as warnings / notices. Optional: older callers and partial mocks may
   * omit it without affecting the merge.
   */
  definitiveMisses?: string[];
}

export interface ApplyAllowedUsersResolveInput {
  /** Raw bots.json entries (ou_ / on_ / email). */
  rawEntries: string[];
  /**
   * Last known-good `raw entry → ou_` mapping (persisted sidecar from a prior
   * healthy resolve). Used only as a per-entry fallback for still-configured,
   * transient-failed entries. A plain `raw → ou_` object (JSON-friendly).
   */
  previousResolvedMap: Record<string, string>;
  resolveResult: AllowedUsersResolveResultLike;
}

export interface ApplyAllowedUsersResolveOutput {
  /** Runtime allowlist: `ou_` only, deduped, config order preserved. */
  resolved: string[];
  /**
   * `raw → ou_` map consistent with `resolved` (includes both freshly resolved
   * and cache-recovered entries). Callers persist/assign this as the source of
   * truth so `/revoke` reverse-lookup and the sidecar stay coherent.
   */
  map: Map<string, string>;
  /** True when any runtime entry came from the cache, not this resolve. */
  usedFallback: boolean;
  /**
   * True when config has entries but we could not produce a clean successful
   * resolve (some entry transient-failed and/or the runtime list is degraded).
   * Callers must surface a notice + schedule a retry.
   */
  failed: boolean;
  /** Human-readable notice for logs / owner DM; null when nothing to report. */
  notice: string | null;
}

/** Config entries that require a contact resolve (email / union / literal ou_ / mobile). */
function needsContactResolve(rawEntries: string[]): boolean {
  return rawEntries.some(entryNeedsContactResolve);
}

function entryStatusOf(
  status: Map<string, EntryResolveStatus> | undefined,
  entry: string,
): EntryResolveStatus {
  // Absent → definitive: never revive an entry the resolver did not explicitly
  // flag as transient. Safer to drop than to resurrect a stale grant.
  return status?.get(entry) ?? 'definitive';
}

/**
 * Pure merge of a fresh resolve result + a last-known-good `raw → ou_` cache.
 *
 * Walk raw config in order. For each entry:
 *   - fresh `ou_` from this resolve → use it (authoritative);
 *   - else if this entry transient-failed AND has a cached `ou_` → reuse cache
 *     (marks usedFallback + failed);
 *   - else (definitive miss / no cache / non-resolvable literal) → drop it.
 * Never leaves bare `on_` / emails in the runtime list — those cannot match
 * message senders and would still lock the owner out. Output `map` mirrors the
 * chosen `resolved` set so downstream `/revoke` + sidecar stay consistent.
 */
export function applyAllowedUsersResolve(
  input: ApplyAllowedUsersResolveInput,
): ApplyAllowedUsersResolveOutput {
  const rawEntries = input.rawEntries.filter(u => typeof u === 'string' && u.trim().length > 0);
  const prevMap = input.previousResolvedMap ?? {};
  const { map: freshMap, errored, entryStatus } = input.resolveResult;

  if (rawEntries.length === 0) {
    return { resolved: [], map: new Map(), usedFallback: false, failed: false, notice: null };
  }

  const outMap = new Map<string, string>();
  const resolved: string[] = [];
  const seen = new Set<string>();
  let usedFallback = false;
  let transientMissWithoutCache = false;
  const recoveredEntries: string[] = [];

  const push = (rawEntry: string, oid: string) => {
    if (!oid.startsWith('ou_')) return;
    outMap.set(rawEntry, oid);
    if (!seen.has(oid)) {
      seen.add(oid);
      resolved.push(oid);
    }
  };

  for (const entry of rawEntries) {
    const fresh = freshMap.get(entry);
    if (fresh && fresh.startsWith('ou_')) {
      push(entry, fresh);
      continue;
    }
    // No fresh ou_. Only reuse cache if this entry TRANSIENT-failed this pass —
    // a definitive miss (removed / invalid / swapped out) must not be revived.
    if (entryStatusOf(entryStatus, entry) === 'transient') {
      const cached = prevMap[entry];
      if (typeof cached === 'string' && cached.startsWith('ou_')) {
        push(entry, cached);
        usedFallback = true;
        recoveredEntries.push(entry);
      } else {
        transientMissWithoutCache = true;
      }
    }
    // definitive / resolved-without-ou_ / non-resolvable literal → drop entry.
  }

  // A resolve is "healthy" only when nothing transient-failed. Definitive
  // drops (removed owners) are expected and do NOT mark failed — the config
  // is simply reflecting reality; there is nothing to retry.
  const anyTransient = rawEntries.some(e => entryStatusOf(entryStatus, e) === 'transient');
  const failed = !!errored || anyTransient;

  if (!failed) {
    // Clean pass. resolved may still be empty here if config holds only
    // definitively-gone / non-resolvable entries — that is a legitimate empty
    // allowlist, not a fallback situation. Non-resolvable-only configs (no
    // contact entries) also land here with no notice.
    return { resolved, map: outMap, usedFallback: false, failed: false, notice: null };
  }

  // Degraded pass (something transient-failed). Build an operator-facing notice.
  let notice: string;
  if (resolved.length > 0 && usedFallback) {
    notice =
      `allowedUsers resolve degraded: contact API transiently failed for ` +
      `${recoveredEntries.length} entr${recoveredEntries.length === 1 ? 'y' : 'ies'} ` +
      `(${recoveredEntries.join(', ')}); reused last-known ou_ from cache so owner talk keeps working. ` +
      `Retrying automatically; restart after Feishu contact recovers if needed.`;
  } else if (resolved.length > 0) {
    notice =
      `allowedUsers resolve degraded: some entries transiently failed but ` +
      `${resolved.length} open_id(s) resolved/recovered. Raw entries: ${rawEntries.join(', ')}. Retrying.`;
  } else if (transientMissWithoutCache || needsContactResolve(rawEntries)) {
    notice =
      `allowedUsers resolve failed: contact API unavailable and no last-known ou_ cache for the ` +
      `affected entr${recoveredEntries.length === 1 ? 'y' : 'ies'}; runtime allowlist is empty so ` +
      `everyone (including the real owner) is denied. Raw entries: ${rawEntries.join(', ')}. ` +
      `Check Feishu contact API / bot scopes; retrying automatically.`;
  } else {
    notice =
      `allowedUsers resolve degraded; runtime allowlist is empty. Raw entries: ${rawEntries.join(', ')}.`;
  }

  return { resolved, map: outMap, usedFallback, failed: true, notice };
}
