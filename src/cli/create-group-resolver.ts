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

export interface BotInfoForKickoff {
  larkAppId: string;
  botOpenId: string | null;
}

export type ResolvedKickoff =
  | { ok: true; targetLarkAppId?: string; prompt?: string }
  | { ok: false; error: string };

export interface ResolvedBots {
  /** Resolved larkAppIds in input order, deduped. First element is creator. */
  larkAppIds: string[];
  /** Refs that couldn't be matched to any bot. */
  invalid: string[];
  /** Warnings about ambiguous name → first match picked. */
  ambiguousWarnings: string[];
}

export interface CreateGroupCompletionStatus {
  success: boolean;
  chatCreated: true;
  chatId: string;
  collaborationReady: boolean;
  kickoffAccepted: boolean;
  kickoffRequested: boolean;
  kickoffMessageId: string | null;
  kickoffError: string | null;
}

/** Build the machine-readable terminal status for create-group. A created chat
 * is not a successful group initialization until collaboration is ready and an
 * explicitly requested kickoff was accepted. */
export function createGroupCompletionStatus(input: {
  chatId: string;
  collaborationReady: boolean;
  kickoffRequested: boolean;
  kickoffMessageId: string | null;
  kickoffError: string | null;
}): CreateGroupCompletionStatus {
  const kickoffAccepted = !input.kickoffRequested
    || (!!input.kickoffMessageId && !input.kickoffError);
  return {
    success: input.collaborationReady && kickoffAccepted,
    chatCreated: true,
    chatId: input.chatId,
    collaborationReady: input.collaborationReady,
    kickoffAccepted,
    kickoffRequested: input.kickoffRequested,
    kickoffMessageId: input.kickoffMessageId,
    kickoffError: input.kickoffError,
  };
}

/** Preserve the long-standing stdout contract: create-group emits only the
 * chatId by default, including partial/non-zero outcomes. Callers that can
 * consume a second structured line must opt in explicitly. */
export function shouldWriteCreateGroupCompletionStatus(
  _status: CreateGroupCompletionStatus,
  explicitJsonStatus: boolean,
): boolean {
  return explicitJsonStatus;
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

/**
 * Validate the optional kickoff pair and resolve the user-facing bot open_id
 * back to a selected larkAppId. The service later obtains the target bot's
 * observer-scoped open_id from the creator app before sending the @mention;
 * a bot's self-reported open_id is not valid across Lark apps.
 */
export function resolveKickoff(
  botOpenIdRaw: string | undefined,
  promptRaw: string | undefined,
  selectedLarkAppIds: string[],
  botInfo: BotInfoForKickoff[],
): ResolvedKickoff {
  const botOpenId = botOpenIdRaw?.trim() || undefined;
  const prompt = promptRaw?.trim() || undefined;

  if (!botOpenId && !prompt) return { ok: true };
  if (!botOpenId || !prompt) {
    return { ok: false, error: '--kickoff-bot 与 --kickoff-prompt 必须同时提供且不能为空。' };
  }

  const matches = botInfo.filter(info => info.botOpenId?.trim() === botOpenId);
  if (matches.length === 0) {
    return { ok: false, error: `--kickoff-bot 未匹配到本机 bot: ${botOpenId}` };
  }
  if (matches.length > 1) {
    return { ok: false, error: `--kickoff-bot 匹配到多个本机 bot，请检查 bots-info.json: ${botOpenId}` };
  }

  const targetLarkAppId = matches[0].larkAppId;
  if (!selectedLarkAppIds.includes(targetLarkAppId)) {
    return { ok: false, error: '--kickoff-bot 必须属于本次 --bot 列表。' };
  }
  if (targetLarkAppId === selectedLarkAppIds[0]) {
    return { ok: false, error: '--kickoff-bot 不能是 creator（第一个 --bot）。' };
  }

  return { ok: true, targetLarkAppId, prompt };
}
