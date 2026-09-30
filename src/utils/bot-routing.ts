/**
 * Same-name bot disambiguation for `botmux send` cross-ref reverse lookup.
 *
 * bots-info.json can hold multiple entries with the same `botName` when a
 * deployment runs two apps under the same display name. Cross-ref files key
 * on botName (`{ <name>: <sender-scoped open_id> }`), so the reverse path
 * — botName → larkAppId — is ambiguous: `Array.find` silently routes to
 * whichever entry sorts first, often the wrong one. Prefer the entry whose
 * `oncallChats` includes the outbound chat — that's the deployment intent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BOTS_JSON = join(homedir(), '.botmux', 'bots.json');

export function loadOncallChatsByApp(botsJsonPath?: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const path = botsJsonPath
    ?? (process.env.BOTS_CONFIG ? resolve(process.env.BOTS_CONFIG) : DEFAULT_BOTS_JSON);
  try {
    if (!existsSync(path)) return map;
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(parsed)) return map;
    for (const cfg of parsed) {
      if (!cfg?.larkAppId || !Array.isArray(cfg.oncallChats)) continue;
      const chats = new Set<string>();
      for (const c of cfg.oncallChats) {
        if (typeof c?.chatId === 'string') chats.add(c.chatId);
      }
      if (chats.size > 0) map.set(cfg.larkAppId, chats);
    }
  } catch { /* */ }
  return map;
}

export function pickBotEntryByName<T extends { larkAppId: string; botName: string | null }>(
  botEntries: T[],
  name: string,
  targetChatId: string | undefined,
  oncallChatsByApp: Map<string, Set<string>>,
): T | undefined {
  const lower = name.toLowerCase();
  const candidates = botEntries.filter(e => e.botName?.toLowerCase() === lower);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1 || !targetChatId) return candidates[0];
  return candidates.find(e => oncallChatsByApp.get(e.larkAppId)?.has(targetChatId)) ?? candidates[0];
}

export type BotMentionEntry = {
  larkAppId: string;
  botOpenId?: string | null;
  botName: string | null;
  cliId?: string | null;
};

export type OutgoingMention = {
  open_id: string;
  name?: string;
};

export function loadBotMentionIdentityMap(
  dataDir: string,
  appId: string,
): { botEntries: BotMentionEntry[]; crossRef: Record<string, string> } {
  let botEntries: BotMentionEntry[] = [];
  let crossRef: Record<string, string> = {};
  try {
    const botInfoPath = join(dataDir, 'bots-info.json');
    const parsedBotEntries = existsSync(botInfoPath)
      ? JSON.parse(readFileSync(botInfoPath, 'utf-8'))
      : [];
    botEntries = Array.isArray(parsedBotEntries)
      ? parsedBotEntries.filter((entry): entry is BotMentionEntry =>
          !!entry
          && typeof entry === 'object'
          && typeof entry.larkAppId === 'string'
          && (entry.botName === null || typeof entry.botName === 'string'))
      : [];
    const crossRefPath = join(dataDir, `bot-openids-${appId}.json`);
    const parsedCrossRef = existsSync(crossRefPath)
      ? JSON.parse(readFileSync(crossRefPath, 'utf-8'))
      : {};
    crossRef = parsedCrossRef && typeof parsedCrossRef === 'object' && !Array.isArray(parsedCrossRef)
      ? parsedCrossRef
      : {};
  } catch { /* best-effort identity map */ }
  return { botEntries, crossRef };
}

function knownBotNames(entries: BotMentionEntry[], selfAppId?: string): Set<string> {
  const names = new Set<string>();
  for (const entry of entries) {
    if (selfAppId && entry.larkAppId === selfAppId) continue;
    for (const name of [entry.botName, entry.cliId]) {
      if (name) names.add(name.toLowerCase());
    }
  }
  return names;
}

export function knownBotOpenIdsFromCrossRef(
  crossRef: Readonly<Record<string, string>>,
  entries: BotMentionEntry[] = [],
  selfAppId?: string,
): Set<string> {
  const out = new Set(Object.values(crossRef).filter(Boolean));
  for (const entry of entries) {
    if (selfAppId && entry.larkAppId === selfAppId) continue;
    if (entry.botOpenId) out.add(entry.botOpenId);
  }
  return out;
}

export function hasKnownBotMention(
  _text: string,
  mentions: OutgoingMention[],
  entries: BotMentionEntry[],
  crossRef: Record<string, string>,
  selfAppId?: string,
): boolean {
  const names = knownBotNames(entries, selfAppId);
  const openIds = knownBotOpenIdsFromCrossRef(crossRef, entries, selfAppId);

  for (const mention of mentions) {
    if (openIds.has(mention.open_id)) return true;
    if (mention.name && names.has(mention.name.toLowerCase())) return true;
  }

  return false;
}

/**
 * Blank out Markdown code spans/blocks so a bot name written *inside code* — an
 * example command in backticks, a fenced snippet, a quoted `@Bot` in an
 * explanation — is NOT mistaken for a real `@Bot` handoff by the prose
 * auto-injection scanner (which would otherwise wake that bot). Only presence
 * detection needs to be code-aware; positions are irrelevant, so each matched
 * region collapses to a single space.
 *
 * Fenced blocks (a run of ≥3 backticks or ≥3 tildes, closed by an equal-length
 * run) are removed first so their fences aren't misread as inline runs; then
 * balanced inline backtick runs (`…`, ``…``) go. `~~strike~~` (double tilde) is
 * NOT a fence and is deliberately left intact — an @Bot inside strikethrough is
 * still a real prose mention. Unbalanced stray backticks are harmless literals.
 */
export function stripCodeSpans(text: string): string {
  return text
    .replace(/(`{3,}|~{3,})[\s\S]*?\1/g, ' ')
    .replace(/(`+)[\s\S]*?\1/g, ' ');
}

/**
 * Decide who a botmux-generated reply should @ in the footer.
 *
 * The footer's `发送给：@owner` is an implicit convenience for human readers —
 * it is NOT the message's explicit @ targets (those come from --mention /
 * --mention-back / prose @Name and are rendered separately). It must not wake a
 * bot: bot-to-bot routing should be explicit in the message body/--mention.
 *
 * When the reply has any explicit recipient, this default owner/caller ping is
 * redundant noise, so it is suppressed entirely (`sendTo: undefined`). The
 * chosen --mention / --mention-back recipients land in `mentions[]` and render
 * regardless of this function. Without an explicit recipient the default
 * addressing (owner / oncall last-caller) is unchanged.
 */
export function buildFooterAddressing(
  s: { ownerOpenId?: string; lastCallerOpenId?: string; lastCallerIsBot?: boolean },
  opts: {
    isOncall: boolean;
    isSubstitute?: boolean;
    hasExplicitMention?: boolean;
    hasExplicitBotMention?: boolean;
    knownBotOpenIds?: Set<string>;
  },
): { sendTo: string | undefined; cc: string[] } {
  const owner = s.ownerOpenId;
  const botIds = opts.knownBotOpenIds ?? new Set<string>();
  const ownerHuman = owner && !botIds.has(owner) ? owner : undefined;

  // Any explicit recipient selection owns the entire addressing decision. Do
  // not silently append the turn's caller merely because this send is a reply.
  // The selected recipients render through mentions[] below; --mention-back
  // explicitly includes the caller there when that is actually intended.
  if (opts.hasExplicitMention || opts.hasExplicitBotMention) {
    return { sendTo: undefined, cc: [] };
  }

  if (!opts.isOncall && !opts.isSubstitute) return { sendTo: ownerHuman, cc: [] };

  const caller = s.lastCallerOpenId ?? owner;
  const callerIsBot = !!caller && (s.lastCallerIsBot === true || botIds.has(caller));

  // Oncall + last caller is a bot (but this reply itself has no explicit bot
  // target) → fall back to the human owner rather than pinging the bot caller.
  if (callerIsBot) {
    return { sendTo: ownerHuman, cc: [] };
  }

  return { sendTo: caller, cc: [] };
}

/**
 * Ordered, de-duplicated @ recipients for the footer `发送给：` line.
 *
 * All real mentions (the human addressee + explicit mention targets + cc) are
 * consolidated onto one footer line instead of dangling a trailing @ block at
 * the bottom of the card body. The human addressee (`sendTo`) goes first, then
 * explicit mention targets (which may include sibling bots for a handoff), then
 * cc. Ids already rendered inline inside the body prose (`inlinedIds`) are
 * skipped so the same person isn't @-ed twice.
 *
 * Placement only — these were already real Lark mentions wherever they sat, so
 * notification / cross-bot wake behaviour is unchanged.
 */
export function orderedFooterRecipients(opts: {
  sendTo?: string;
  mentionIds?: string[];
  cc?: string[];
  inlinedIds?: Iterable<string>;
}): string[] {
  const seen = new Set<string>(opts.inlinedIds ?? []);
  const out: string[] = [];
  const push = (id?: string) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  push(opts.sendTo);
  for (const id of opts.mentionIds ?? []) push(id);
  for (const id of opts.cc ?? []) push(id);
  return out;
}
