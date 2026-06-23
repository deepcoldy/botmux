/**
 * Settings owner resolver — global owner check for `PUT /__daemon/settings-write`.
 *
 * v1.3 §6.1 pins the owner model: dashboard `settings` is the dashboard
 * process's global config, NOT per-bot, so per-bot `getOwnerOpenId` cannot
 * be used. Instead we accept a sender's `union_id` (Lark verified) and
 * check it against the union of all bots' `allowedUsers`, normalised to
 * `union_id` via `resolveOwnerCandidatesFromAllowedUsers`.
 *
 * Safety contract:
 *   - Only `union_id` (`on_`-prefixed) is honoured. We never fall back to
 *     `open_id` because `open_id` is app-scoped and not comparable across
 *     bots.
 *   - When the candidate resolver throws (Lark API blip, file IO error,
 *     etc.), we fail CLOSED — return `false` and let the route emit 403.
 *     Treating an exception as success would silently grant ownership.
 *   - Empty candidate set returns `false` (nothing to match against).
 */

import {
  resolveOwnerCandidatesFromAllowedUsers as defaultResolveOwnerCandidates,
  type OwnerCandidate,
} from './federation-spoke-api.js';

export interface SettingsOwnerCheck {
  /** Sender's verified `union_id` (e.g. from `LarkMessage.senderUnionId` on the command path,
   *  or `operator.union_id` / `resolveUserUnionId` on the card-callback path). */
  senderUnionId: string | undefined | null;
}

/** Deps the resolver needs — injectable so tests don't read bots.json or hit Lark. */
export interface SettingsOwnerResolverDeps {
  /** Override the candidate fetcher; production omits this and uses the real federation helper. */
  resolveOwnerCandidates?: () => Promise<OwnerCandidate[]>;
}

/** Check whether the given `senderUnionId` is allowed to mutate dashboard global settings. */
export async function isAuthorizedForGlobalSettings(
  check: SettingsOwnerCheck,
  deps: SettingsOwnerResolverDeps = {},
): Promise<boolean> {
  // Strict union_id gate — no open_id fallback under any condition.
  if (typeof check.senderUnionId !== 'string') return false;
  const trimmed = check.senderUnionId.trim();
  if (trimmed.length === 0) return false;
  if (!trimmed.startsWith('on_')) return false;

  const resolve = deps.resolveOwnerCandidates ?? (() => defaultResolveOwnerCandidates({ skipNames: true }));

  let candidates: OwnerCandidate[];
  try {
    candidates = await resolve();
  } catch {
    // Fail closed — cannot prove ownership when resolver errors.
    return false;
  }
  if (candidates.length === 0) return false;
  return candidates.some(c => c.unionId === trimmed);
}
