/**
 * Per-bot card-behaviour preferences. Mirrors the brand-store / oncall-store
 * pattern: cross-process file lock + atomic write of bots.json, plus an
 * in-memory registry sync so the daemon's own card builders pick up the change
 * without a restart.
 *
 * Three independent toggles:
 *   • disableStreamingCard      — suppress the live streaming session card
 *   • silentTurnReactions       — in card-off sessions, also drop the ✋→✅
 *                                  lightweight status reactions on the trigger
 *                                  message (only meaningful while the card is off)
 *   • writableTerminalLinkInCard — embed a directly-usable writable terminal
 *                                  link in the streaming card body
 *   • privateCard               — `/card` sends a private ephemeral snapshot
 *                                  (visible to the talk-grant audience) instead
 *                                  of the group-visible live card
 *   • regularGroupReplyMode     — per-bot DEFAULT session mode for regular
 *                                  groups: chat | chat-topic | new-topic | shared
 *                                  (see chat-reply-mode-store). Default 'chat'.
 */
import { rmwBotEntry } from './config-store.js';
import { getBot, type ChatReplyMode } from '../bot-registry.js';
import { logger } from '../utils/logger.js';

export interface BotCardPrefs {
  disableStreamingCard: boolean;
  silentTurnReactions: boolean;
  writableTerminalLinkInCard: boolean;
  privateCard: boolean;
  /** bot@bot 同目录拉起: when a bot is @-ed into a chat where a sibling bot is
   *  already working, inherit that sibling's workingDir & skip the repo card.
   *  Default TRUE (unlike the others) — only an explicit false is persisted. */
  botToBotSameDir: boolean;
  /** 主动开工 — 场景①: auto-start when added to a new chat (see auto-start.ts). */
  autoStartOnGroupJoin: boolean;
  /** 主动开工 — 场景① optional pre-configured first-turn prompt ('' = none). */
  autoStartOnGroupJoinPrompt: string;
  /** 主动开工 — 场景②: auto-start on every new topic in a topic group. */
  autoStartOnNewTopic: boolean;
  /** Per-bot DEFAULT regular-group session mode (chat | chat-topic | new-topic | shared). */
  regularGroupReplyMode: ChatReplyMode;
  /** Per-bot 4-tier @-requirement policy for regular groups (default 'always'). */
  regularGroupMentionMode: 'always' | 'topic' | 'never' | 'ambient';
  /** 文档订阅新订阅默认评论触发范围（default 'mention-only'）。 */
  docSubscribeDefaultMode: 'mention-only' | 'all';
}

/** Current card prefs for a bot (booleans default false, prompt defaults '' when unset). */
export function getBotCardPrefs(larkAppId: string): BotCardPrefs {
  try {
    const c = getBot(larkAppId).config;
    return {
      disableStreamingCard: c.disableStreamingCard === true,
      silentTurnReactions: c.silentTurnReactions === true,
      writableTerminalLinkInCard: c.writableTerminalLinkInCard === true,
      privateCard: c.privateCard === true,
      botToBotSameDir: c.botToBotSameDir !== false,
      autoStartOnGroupJoin: c.autoStartOnGroupJoin === true,
      autoStartOnGroupJoinPrompt: typeof c.autoStartOnGroupJoinPrompt === 'string' ? c.autoStartOnGroupJoinPrompt : '',
      autoStartOnNewTopic: c.autoStartOnNewTopic === true,
      regularGroupReplyMode: c.regularGroupReplyMode ?? 'chat',
      regularGroupMentionMode: c.regularGroupMentionMode === 'topic' || c.regularGroupMentionMode === 'never' || c.regularGroupMentionMode === 'ambient'
        ? c.regularGroupMentionMode : 'always',
      docSubscribeDefaultMode: c.docSubscribeDefaultMode === 'all' ? 'all' : 'mention-only',
    };
  } catch {
    return {
      disableStreamingCard: false,
      silentTurnReactions: false,
      writableTerminalLinkInCard: false,
      privateCard: false,
      botToBotSameDir: true,
      autoStartOnGroupJoin: false,
      autoStartOnGroupJoinPrompt: '',
      autoStartOnNewTopic: false,
      regularGroupReplyMode: 'chat',
      regularGroupMentionMode: 'always',
      docSubscribeDefaultMode: 'mention-only',
    };
  }
}

/**
 * Persist a partial card-prefs change. Only the keys present in `patch` are
 * touched; a `false` value removes the key (keeps bots.json tidy — absent means
 * the default). Returns the full resolved prefs after the write.
 */
export async function updateBotCardPrefs(
  larkAppId: string,
  patch: Partial<BotCardPrefs>,
): Promise<{ ok: true; prefs: BotCardPrefs } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const apply = (entry: any, key: keyof BotCardPrefs, val: boolean | undefined) => {
    if (val === undefined) return;
    if (val) entry[key] = true;
    else delete entry[key];
  };
  // Default-TRUE boolean: persist only an explicit `false`; `true` drops the key
  // (absent === on), keeping bots.json tidy and the default ON.
  const applyDefaultTrue = (entry: any, key: keyof BotCardPrefs, val: boolean | undefined) => {
    if (val === undefined) return;
    if (val) delete entry[key];
    else entry[key] = false;
  };
  // String prefs: store verbatim when non-blank, drop the key when blank/absent
  // so bots.json stays tidy (absent === "no prompt").
  const applyStr = (entry: any, key: keyof BotCardPrefs, val: string | undefined) => {
    if (val === undefined) return;
    if (val.trim()) entry[key] = val;
    else delete entry[key];
  };
  // Regular-group default mode: store only the non-default modes; 'chat' (the
  // default) drops the key so bots.json stays tidy (absent === 'chat').
  const applyMode = (entry: any, key: keyof BotCardPrefs, val: ChatReplyMode | undefined) => {
    if (val === undefined) return;
    if (val === 'new-topic' || val === 'shared' || val === 'chat-topic') entry[key] = val;
    else delete entry[key];
  };
  // 4-tier @ policy: store only the non-default tiers; 'always' (default) drops
  // the key so bots.json stays tidy (absent === 'always').
  const applyMention = (entry: any, key: keyof BotCardPrefs, val: 'always' | 'topic' | 'never' | 'ambient' | undefined) => {
    if (val === undefined) return;
    if (val === 'topic' || val === 'never' || val === 'ambient') entry[key] = val;
    else delete entry[key];
  };
  // 文档订阅默认触发范围：只存 'all'；'mention-only'（默认）删键保持 bots.json 干净。
  const applyDocMode = (entry: any, key: keyof BotCardPrefs, val: 'mention-only' | 'all' | undefined) => {
    if (val === undefined) return;
    if (val === 'all') entry[key] = 'all';
    else delete entry[key];
  };

  const r = await rmwBotEntry<BotCardPrefs>(larkAppId, (entry) => {
    apply(entry, 'disableStreamingCard', patch.disableStreamingCard);
    apply(entry, 'silentTurnReactions', patch.silentTurnReactions);
    apply(entry, 'writableTerminalLinkInCard', patch.writableTerminalLinkInCard);
    apply(entry, 'privateCard', patch.privateCard);
    applyDefaultTrue(entry, 'botToBotSameDir', patch.botToBotSameDir);
    apply(entry, 'autoStartOnGroupJoin', patch.autoStartOnGroupJoin);
    applyStr(entry, 'autoStartOnGroupJoinPrompt', patch.autoStartOnGroupJoinPrompt);
    apply(entry, 'autoStartOnNewTopic', patch.autoStartOnNewTopic);
    applyMode(entry, 'regularGroupReplyMode', patch.regularGroupReplyMode);
    applyMention(entry, 'regularGroupMentionMode', patch.regularGroupMentionMode);
    applyDocMode(entry, 'docSubscribeDefaultMode', patch.docSubscribeDefaultMode);
    return {
      write: true,
      result: {
        disableStreamingCard: entry.disableStreamingCard === true,
        silentTurnReactions: entry.silentTurnReactions === true,
        writableTerminalLinkInCard: entry.writableTerminalLinkInCard === true,
        privateCard: entry.privateCard === true,
        botToBotSameDir: entry.botToBotSameDir !== false,
        autoStartOnGroupJoin: entry.autoStartOnGroupJoin === true,
        autoStartOnGroupJoinPrompt: typeof entry.autoStartOnGroupJoinPrompt === 'string' ? entry.autoStartOnGroupJoinPrompt : '',
        autoStartOnNewTopic: entry.autoStartOnNewTopic === true,
        regularGroupReplyMode: (entry.regularGroupReplyMode === 'new-topic' || entry.regularGroupReplyMode === 'shared' || entry.regularGroupReplyMode === 'chat-topic')
          ? entry.regularGroupReplyMode
          : 'chat',
        regularGroupMentionMode: (entry.regularGroupMentionMode === 'topic' || entry.regularGroupMentionMode === 'never' || entry.regularGroupMentionMode === 'ambient')
          ? entry.regularGroupMentionMode
          : 'always',
        docSubscribeDefaultMode: entry.docSubscribeDefaultMode === 'all' ? 'all' : 'mention-only',
      },
    };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  // Sync in-memory config so live card builders / routing react without a restart.
  if (patch.disableStreamingCard !== undefined) {
    bot.config.disableStreamingCard = patch.disableStreamingCard || undefined;
  }
  if (patch.silentTurnReactions !== undefined) {
    bot.config.silentTurnReactions = patch.silentTurnReactions || undefined;
  }
  if (patch.writableTerminalLinkInCard !== undefined) {
    bot.config.writableTerminalLinkInCard = patch.writableTerminalLinkInCard || undefined;
  }
  if (patch.privateCard !== undefined) {
    bot.config.privateCard = patch.privateCard || undefined;
  }
  if (patch.botToBotSameDir !== undefined) {
    // Default true: store false explicitly, clear (→ default on) when true.
    bot.config.botToBotSameDir = patch.botToBotSameDir === false ? false : undefined;
  }
  if (patch.autoStartOnGroupJoin !== undefined) {
    bot.config.autoStartOnGroupJoin = patch.autoStartOnGroupJoin || undefined;
  }
  if (patch.autoStartOnGroupJoinPrompt !== undefined) {
    bot.config.autoStartOnGroupJoinPrompt = patch.autoStartOnGroupJoinPrompt.trim() ? patch.autoStartOnGroupJoinPrompt : undefined;
  }
  if (patch.autoStartOnNewTopic !== undefined) {
    bot.config.autoStartOnNewTopic = patch.autoStartOnNewTopic || undefined;
  }
  if (patch.regularGroupReplyMode !== undefined) {
    bot.config.regularGroupReplyMode = (patch.regularGroupReplyMode === 'new-topic' || patch.regularGroupReplyMode === 'shared' || patch.regularGroupReplyMode === 'chat-topic')
      ? patch.regularGroupReplyMode
      : undefined;
  }
  if (patch.regularGroupMentionMode !== undefined) {
    bot.config.regularGroupMentionMode = (patch.regularGroupMentionMode === 'topic' || patch.regularGroupMentionMode === 'never' || patch.regularGroupMentionMode === 'ambient')
      ? patch.regularGroupMentionMode
      : undefined;
  }
  if (patch.docSubscribeDefaultMode !== undefined) {
    bot.config.docSubscribeDefaultMode = patch.docSubscribeDefaultMode === 'all' ? 'all' : undefined;
  }
  logger.info(
    `[card-prefs:${larkAppId}] disableStreamingCard=${r.result.disableStreamingCard} ` +
    `silentTurnReactions=${r.result.silentTurnReactions} ` +
    `writableTerminalLinkInCard=${r.result.writableTerminalLinkInCard} privateCard=${r.result.privateCard} ` +
    `autoStartOnGroupJoin=${r.result.autoStartOnGroupJoin} autoStartOnNewTopic=${r.result.autoStartOnNewTopic} ` +
    `regularGroupReplyMode=${r.result.regularGroupReplyMode} regularGroupMentionMode=${r.result.regularGroupMentionMode} ` +
    `botToBotSameDir=${r.result.botToBotSameDir} docSubscribeDefaultMode=${r.result.docSubscribeDefaultMode} ` +
    `autoStartOnGroupJoinPrompt.len=${r.result.autoStartOnGroupJoinPrompt.length}`,
  );
  return { ok: true, prefs: r.result };
}
