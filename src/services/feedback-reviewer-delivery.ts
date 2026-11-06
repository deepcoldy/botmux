import { logger } from '../utils/logger.js';
import {
  readFeedbackReviewersCache,
  writeFeedbackReviewersCache,
} from '../utils/feedback-reviewers-cache.js';
import {
  materializeFeedbackReviewers,
  type FeedbackPolicy,
  type FeedbackReviewerResolveOutcome,
} from './feedback-policy.js';

/**
 * Send-time materialization of a `reviewers` feedback policy, shared by the
 * worker/Riff `botmux send` path and the daemon fallback delivery path so the
 * two can never drift again.
 *
 * Contract:
 *  - healthy/definitive passes return the frozen policy. A definitive empty
 *    list is INTENTIONAL: the control stays visible and the callback rejects
 *    every operator;
 *  - transient contact-API failures reuse the per-app last-known-good
 *    raw → ou_ cache (only for entries still configured and transient THIS
 *    pass — removed/definitive reviewers are never revived);
 *  - when a transient pass leaves the allowlist empty WITH no recoverable
 *    cache, returns `undefined`: we do not ship an empty snapshot that would
 *    render a button every configured real reviewer gets rejected by. This is
 *    the only case that reverts to the pre-feature "no feedback control"
 *    shape, and only on the first-ever sends before any healthy resolve.
 */
export async function materializeFeedbackPolicyForDelivery(input: {
  policy: FeedbackPolicy;
  larkAppId: string;
  dataDir: string;
  resolveAllowedUsersWithMap: (
    larkAppId: string,
    entries: string[],
  ) => Promise<{
    map: Map<string, string>;
    errored?: boolean;
    entryStatus?: Map<string, 'resolved' | 'transient' | 'definitive'>;
  }>;
}): Promise<FeedbackPolicy | undefined> {
  const { policy, larkAppId, dataDir } = input;
  if (policy.audience !== 'reviewers') return policy;
  const pending = policy.reviewers.filter(entry => !entry.startsWith('ou_') && !entry.startsWith('on_'));
  if (pending.length === 0) return policy;
  const previousResolvedMap = readFeedbackReviewersCache(dataDir, larkAppId);
  let outcome: Awaited<ReturnType<typeof materializeFeedbackReviewers>>;
  try {
    outcome = await materializeFeedbackReviewers(
      policy,
      async (entries): Promise<FeedbackReviewerResolveOutcome> => {
        const result = await input.resolveAllowedUsersWithMap(larkAppId, entries);
        const map = new Map<string, string>();
        for (const entry of entries) {
          const id = result.map.get(entry);
          if (id && id.startsWith('ou_')) map.set(entry, id);
        }
        return { map, errored: result.errored, entryStatus: result.entryStatus };
      },
      { previousResolvedMap },
    );
  } catch (error) {
    // materializeFeedbackReviewers itself swallows resolver throws, so reaching
    // here means an unexpected local failure. Fail closed: no feedback control
    // on this card, never an open or an empty one.
    logger.warn(`[feedback-reviewers] ${larkAppId} materialization failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  if (outcome.transientFailure) {
    const transientCount = outcome.recoveredEntries.length + outcome.unrecoveredEntries.length;
    if (outcome.recoveredEntries.length > 0) {
      logger.warn(
        `[feedback-reviewers] ${larkAppId} contact API transiently failed for `
        + `${transientCount} reviewer entr${transientCount === 1 ? 'y' : 'ies'}; `
        + `reused ${outcome.recoveredEntries.length} last-known-good id${outcome.recoveredEntries.length === 1 ? '' : 's'} `
        + `so the feedback card keeps working${outcome.unrecoveredEntries.length > 0 ? `, ${outcome.unrecoveredEntries.length} still unverified` : ''}.`,
      );
    } else {
      logger.warn(
        `[feedback-reviewers] ${larkAppId} contact API transiently failed for `
        + `${transientCount} reviewer entr${transientCount === 1 ? 'y' : 'ies'} `
        + `with no last-known-good cache; not shipping an empty feedback allowlist this delivery.`,
      );
    }
    // Partial healthy resolutions are still worth caching, but a degraded pass
    // never PRUNES and never marks unknown entries definitive — for those the
    // API gave no verdict. A DEFINITIVE verdict, however, is still a verdict on
    // a degraded pass (a mixed batch: one email omitted from a code-0 response,
    // another entry's GET timed out): drop those cached ids now, otherwise a
    // later all-transient pass would revive a reviewer the API already
    // reported gone.
    if (outcome.freshMap.size > 0 || outcome.definitiveEntries.length > 0) {
      writeFeedbackReviewersCache(dataDir, larkAppId, {
        map: outcome.freshMap,
        deleteEntries: outcome.definitiveEntries,
      });
    }
  } else {
    // Clean pass: write healthy mappings through and drop entries proven
    // definitively gone, so a later blip cannot revive a removed reviewer.
    // Deliberately NO retainKeys: this cache is app-scoped while `pending` is
    // only THIS delivery's reviewer list, so pruning to it would evict the
    // last-known-good ids of every other chat/team on the same bot — their next
    // transient would then look like a cold cache and lose the control the
    // cache exists to protect. A key left over from an entry removed from
    // config is harmless: recovery only ever reads keys that are in the current
    // config and transient THIS pass.
    writeFeedbackReviewersCache(dataDir, larkAppId, {
      map: outcome.freshMap,
      deleteEntries: outcome.definitiveEntries,
    });
  }

  if (outcome.transientFailure && outcome.policy.reviewers.length === 0) return undefined;
  return outcome.policy;
}
