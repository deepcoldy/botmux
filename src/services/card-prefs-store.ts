/**
 * Per-bot card-behaviour preferences. Mirrors the brand-store / oncall-store
 * pattern: cross-process file lock + atomic write of bots.json, plus an
 * in-memory registry sync so the daemon's own card builders pick up the change
 * without a restart.
 *
 * Three independent toggles:
 *   • disableStreamingCard      — suppress the live streaming session card
 *   • writableTerminalLinkInCard — embed a directly-usable writable terminal
 *                                  link in the streaming card body
 *   • privateCard               — `/card` sends a private ephemeral snapshot
 *                                  (visible to the talk-grant audience) instead
 *                                  of the group-visible live card
 */
import { rmwBotEntry } from './config-store.js';
import { getBot } from '../bot-registry.js';
import { logger } from '../utils/logger.js';

export interface BotCardPrefs {
  disableStreamingCard: boolean;
  writableTerminalLinkInCard: boolean;
  privateCard: boolean;
  /** 主动开工 — 场景①: auto-start when added to a new chat (see auto-start.ts). */
  autoStartOnGroupJoin: boolean;
  /** 主动开工 — 场景① optional pre-configured first-turn prompt ('' = none). */
  autoStartOnGroupJoinPrompt: string;
  /** 主动开工 — 场景②: auto-start on every new topic in a topic group. */
  autoStartOnNewTopic: boolean;
  /** 主动开工 — 场景②: also listen to new-topic seeds sent by other bots. */
  autoStartOnNewTopicFromBots: boolean;
}

/** Current card prefs for a bot (booleans default false, prompt defaults '' when unset). */
export function getBotCardPrefs(larkAppId: string): BotCardPrefs {
  try {
    const c = getBot(larkAppId).config;
    return {
      disableStreamingCard: c.disableStreamingCard === true,
      writableTerminalLinkInCard: c.writableTerminalLinkInCard === true,
      privateCard: c.privateCard === true,
      autoStartOnGroupJoin: c.autoStartOnGroupJoin === true,
      autoStartOnGroupJoinPrompt: typeof c.autoStartOnGroupJoinPrompt === 'string' ? c.autoStartOnGroupJoinPrompt : '',
      autoStartOnNewTopic: c.autoStartOnNewTopic === true,
      autoStartOnNewTopicFromBots: c.autoStartOnNewTopicFromBots === true,
    };
  } catch {
    return {
      disableStreamingCard: false,
      writableTerminalLinkInCard: false,
      privateCard: false,
      autoStartOnGroupJoin: false,
      autoStartOnGroupJoinPrompt: '',
      autoStartOnNewTopic: false,
      autoStartOnNewTopicFromBots: false,
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
  // String prefs: store verbatim when non-blank, drop the key when blank/absent
  // so bots.json stays tidy (absent === "no prompt").
  const applyStr = (entry: any, key: keyof BotCardPrefs, val: string | undefined) => {
    if (val === undefined) return;
    if (val.trim()) entry[key] = val;
    else delete entry[key];
  };

  const r = await rmwBotEntry<BotCardPrefs>(larkAppId, (entry) => {
    apply(entry, 'disableStreamingCard', patch.disableStreamingCard);
    apply(entry, 'writableTerminalLinkInCard', patch.writableTerminalLinkInCard);
    apply(entry, 'privateCard', patch.privateCard);
    apply(entry, 'autoStartOnGroupJoin', patch.autoStartOnGroupJoin);
    applyStr(entry, 'autoStartOnGroupJoinPrompt', patch.autoStartOnGroupJoinPrompt);
    apply(entry, 'autoStartOnNewTopic', patch.autoStartOnNewTopic);
    apply(entry, 'autoStartOnNewTopicFromBots', patch.autoStartOnNewTopicFromBots);
    return {
      write: true,
      result: {
        disableStreamingCard: entry.disableStreamingCard === true,
        writableTerminalLinkInCard: entry.writableTerminalLinkInCard === true,
        privateCard: entry.privateCard === true,
        autoStartOnGroupJoin: entry.autoStartOnGroupJoin === true,
        autoStartOnGroupJoinPrompt: typeof entry.autoStartOnGroupJoinPrompt === 'string' ? entry.autoStartOnGroupJoinPrompt : '',
        autoStartOnNewTopic: entry.autoStartOnNewTopic === true,
        autoStartOnNewTopicFromBots: entry.autoStartOnNewTopicFromBots === true,
      },
    };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  // Sync in-memory config so live card builders / routing react without a restart.
  if (patch.disableStreamingCard !== undefined) {
    bot.config.disableStreamingCard = patch.disableStreamingCard || undefined;
  }
  if (patch.writableTerminalLinkInCard !== undefined) {
    bot.config.writableTerminalLinkInCard = patch.writableTerminalLinkInCard || undefined;
  }
  if (patch.privateCard !== undefined) {
    bot.config.privateCard = patch.privateCard || undefined;
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
  if (patch.autoStartOnNewTopicFromBots !== undefined) {
    bot.config.autoStartOnNewTopicFromBots = patch.autoStartOnNewTopicFromBots || undefined;
  }
  logger.info(
    `[card-prefs:${larkAppId}] disableStreamingCard=${r.result.disableStreamingCard} ` +
    `writableTerminalLinkInCard=${r.result.writableTerminalLinkInCard} privateCard=${r.result.privateCard} ` +
    `autoStartOnGroupJoin=${r.result.autoStartOnGroupJoin} autoStartOnNewTopic=${r.result.autoStartOnNewTopic} ` +
    `autoStartOnNewTopicFromBots=${r.result.autoStartOnNewTopicFromBots} ` +
    `autoStartOnGroupJoinPrompt.len=${r.result.autoStartOnGroupJoinPrompt.length}`,
  );
  return { ok: true, prefs: r.result };
}
