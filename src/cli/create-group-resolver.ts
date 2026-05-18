/**
 * Bot ref resolver for `botmux create-group`. Pure function, no I/O — testable
 * in isolation by passing in mock bot configs + bot-info entries.
 *
 * Resolution order for each ref:
 *   1. Exact `larkAppId` match
 *   2. `botName` from bots-info.json (case-insensitive)
 *   3. `cliId` from bots.json (case-insensitive) — fallback when botName is
 *      unknown (bots-info.json gets populated by daemon at startup)
 *
 * Multiple matches by name → take the first in `botConfigs` order (= bots.json
 * traversal order, the user's deployment intent). Same ref repeated → dedup,
 * keeping first occurrence. Unresolvable ref → reported in `invalid` list.
 */

export interface BotConfigForResolve {
  larkAppId: string;
  cliId: string;
}

export interface BotInfoForResolve {
  larkAppId: string;
  botName: string | null;
}

export interface ResolvedBots {
  /** Resolved larkAppIds in input order, deduped. First element is creator. */
  larkAppIds: string[];
  /** Refs that couldn't be matched to any bot. */
  invalid: string[];
  /** Warnings about ambiguous name → first match picked. */
  ambiguousWarnings: string[];
}

export function resolveBotRefs(
  refs: string[],
  botConfigs: BotConfigForResolve[],
  botInfo: BotInfoForResolve[],
): ResolvedBots {
  const out: string[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];
  const ambiguousWarnings: string[] = [];

  for (const ref of refs) {
    const trimmed = ref.trim();
    if (!trimmed) continue;

    let matchedAppId: string | undefined;
    let ambiguousLabel: string | undefined;

    // 1. Exact larkAppId
    const byAppId = botConfigs.find(c => c.larkAppId === trimmed);
    if (byAppId) {
      matchedAppId = byAppId.larkAppId;
    } else {
      // 2. botName (case-insensitive). bots-info.json is merge-written by
      //    multiple daemons and its order is NOT guaranteed to match bots.json.
      //    Spec says "重名取 bots.json 中第一个", so we walk botConfigs in
      //    deployment order and pick the first whose appId appears in the
      //    set of name-matched entries.
      const lower = trimmed.toLowerCase();
      const nameMatchSet = new Set(
        botInfo.filter(b => b.botName?.toLowerCase() === lower).map(b => b.larkAppId),
      );
      const byNameAll = botConfigs.filter(c => nameMatchSet.has(c.larkAppId));
      if (byNameAll.length > 0) {
        matchedAppId = byNameAll[0].larkAppId;
        if (byNameAll.length > 1) ambiguousLabel = `botName "${trimmed}"`;
      } else {
        // 3. cliId fallback — relies on botConfigs order which IS bots.json
        //    order (loadBotConfigs preserves file traversal order).
        const byCliIdAll = botConfigs.filter(c => c.cliId.toLowerCase() === lower);
        if (byCliIdAll.length > 0) {
          matchedAppId = byCliIdAll[0].larkAppId;
          if (byCliIdAll.length > 1) ambiguousLabel = `cliId "${trimmed}"`;
        }
      }
    }

    if (!matchedAppId) {
      invalid.push(trimmed);
      continue;
    }

    if (seen.has(matchedAppId)) continue;
    seen.add(matchedAppId);
    out.push(matchedAppId);

    if (ambiguousLabel) {
      ambiguousWarnings.push(
        `${ambiguousLabel} matches multiple bots in bots.json — picked first (${matchedAppId}).`,
      );
    }
  }

  return { larkAppIds: out, invalid, ambiguousWarnings };
}
