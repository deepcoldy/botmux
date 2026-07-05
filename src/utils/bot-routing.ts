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
  crossRef: Record<string, string>,
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
 * When the reply explicitly targets a known bot (a handoff), this default
 * owner-courtesy ping is redundant noise, so it is suppressed entirely
 * (`sendTo: undefined`). To also loop a human in on a handoff, the caller opts
 * in explicitly via --mention-back / --mention <owner>, which land in
 * `mentions[]` and render regardless of this function — i.e. owner-addressing
 * is opt-IN for handoffs, not opt-out. Without an explicit bot target the
 * default addressing (owner / oncall last-caller) is unchanged.
 */
export function buildFooterAddressing(
  s: { ownerOpenId?: string; lastCallerOpenId?: string },
  opts: {
    isOncall: boolean;
    hasExplicitBotMention?: boolean;
    knownBotOpenIds?: Set<string>;
  },
): { sendTo: string | undefined; cc: string[] } {
  const owner = s.ownerOpenId;
  const botIds = opts.knownBotOpenIds ?? new Set<string>();
  const ownerHuman = owner && !botIds.has(owner) ? owner : undefined;

  // Explicit bot handoff → drop the default owner/caller courtesy ping. The
  // message is addressed to another bot; a human who should see it is added
  // explicitly (--mention-back) and rides in mentions[], not here.
  if (opts.hasExplicitBotMention) return { sendTo: undefined, cc: [] };

  if (!opts.isOncall) return { sendTo: ownerHuman, cc: [] };

  const caller = s.lastCallerOpenId ?? owner;
  const callerIsBot = !!caller && botIds.has(caller);

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
