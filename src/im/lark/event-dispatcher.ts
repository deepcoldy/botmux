/**
 * Lark event dispatcher — handles WSClient setup, bot identity probing,
 * and message routing (group access checks, @mention detection).
 * Extracted from daemon.ts for modularity.
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getBot, getAllBots, findOncallChat } from '../../bot-registry.js';
import { config } from '../../config.js';
import { getChatInfo, listChatBotMembers, replyMessage } from './client.js';
import { logger } from '../../utils/logger.js';

// ─── Bot identity ─────────────────────────────────────────────────────────

/** Set the bot's open_id. Callers should also call writeBotInfoFile() to persist. */
export function setBotOpenId(larkAppId: string, id: string): void {
  getBot(larkAppId).botOpenId = id;
}

/** Persist bot registry info to disk for agent-facing CLI subcommands to read.
 *  Merges current process's bot(s) into the existing file so that
 *  multiple daemon processes (one per bot) don't overwrite each other. */
export function writeBotInfoFile(dataDir: string): void {
  const filePath = join(dataDir, 'bots-info.json');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  // Read existing entries from other daemon processes
  type BotInfoEntry = { larkAppId: string; botOpenId: string | null; botName: string | null; cliId: string };
  let existing: BotInfoEntry[] = [];
  try {
    if (existsSync(filePath)) {
      existing = JSON.parse(readFileSync(filePath, 'utf-8'));
    }
  } catch { /* ignore corrupt file */ }

  // Build a map keyed by larkAppId, start with existing entries
  const map = new Map<string, BotInfoEntry>();
  for (const entry of existing) {
    if (entry.larkAppId) map.set(entry.larkAppId, entry);
  }

  // Upsert current process's bot(s)
  for (const b of getAllBots()) {
    map.set(b.config.larkAppId, {
      larkAppId: b.config.larkAppId,
      botOpenId: b.botOpenId ?? null,
      botName: b.botName ?? null,
      cliId: b.config.cliId,
    });
  }

  writeFileSync(filePath, JSON.stringify([...map.values()], null, 2) + '\n');
}

/**
 * Probe the bot's own open_id at startup via the Lark bot info API.
 */
export async function probeBotOpenId(larkAppId: string): Promise<void> {
  const bot = getBot(larkAppId);
  if (bot.botOpenId) return; // already known

  // Call /bot/v3/info to get the bot's open_id using tenant_access_token
  const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: bot.config.larkAppId, app_secret: bot.config.larkAppSecret }),
  });
  const tokenData = await tokenRes.json() as any;
  if (tokenData.code !== 0) {
    throw new Error(`Failed to get tenant_access_token: ${tokenData.msg}`);
  }

  const botRes = await fetch('https://open.feishu.cn/open-apis/bot/v3/info/', {
    headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
  });
  const botData = await botRes.json() as any;
  if (botData.code !== 0) {
    throw new Error(`Failed to get bot info: ${botData.msg}`);
  }

  const openId = botData.bot?.open_id;
  const appName = botData.bot?.app_name;
  if (openId) {
    bot.botOpenId = openId;
    if (appName) bot.botName = appName;
    logger.info(`Bot open_id: ${bot.botOpenId}`);
  } else {
    throw new Error('No open_id in bot info response');
  }
}

// ─── Group chat stats cache ───────────────────────────────────────────────
//
// chat.get returns both user_count (real users only) and bot_count (bots).
// One API call, one cache — used to gate auto-replies in multi-bot/multi-user
// groups (oncall chats often have 3rd-party oncall/form/AI-search bots).

export const CHAT_CACHE_TTL = 5 * 60_000; // 5 minutes
const chatStatsCache = new Map<string, { userCount: number; botCount: number; fetchedAt: number }>();

export async function getGroupStats(larkAppId: string, chatId: string): Promise<{ userCount: number; botCount: number }> {
  const cacheKey = `${larkAppId}:${chatId}`;
  const cached = chatStatsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CHAT_CACHE_TTL) {
    return { userCount: cached.userCount, botCount: cached.botCount };
  }
  try {
    const info = await getChatInfo(larkAppId, chatId);
    chatStatsCache.set(cacheKey, { userCount: info.userCount, botCount: info.botCount, fetchedAt: Date.now() });
    return info;
  } catch (err) {
    logger.warn(`Failed to get chat stats for ${chatId}: ${err}`);
    if (cached) return { userCount: cached.userCount, botCount: cached.botCount };
    // Fallback: assume multi-person, multi-bot → require @mention to be safe.
    return { userCount: 999, botCount: 999 };
  }
}

// ─── Cross-bot open_id mapping ──────────────────────────────────────────
//
// Lark open_id is per-app scoped: Bot A sees a different open_id for Bot B
// than Bot B sees for itself. The self-reported botOpenId (from /bot/v3/info)
// is useless for other bots to @mention.
//
// We build a per-bot cross-reference from event data: when Bot A's event
// handler receives a message that @mentions Bot B, the mention includes
// Bot B's open_id as seen by Bot A's app. We persist this mapping so that
// listChatBotMembers can return correct open_ids.

/** Read the per-bot cross-reference: botName(lowercase) → openId as seen by larkAppId's app */
export function readBotOpenIdCrossRef(dataDir: string, larkAppId: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const fp = join(dataDir, `bot-openids-${larkAppId}.json`);
    if (existsSync(fp)) {
      const data: Record<string, string> = JSON.parse(readFileSync(fp, 'utf-8'));
      for (const [name, openId] of Object.entries(data)) {
        map.set(name.toLowerCase(), openId);
      }
    }
  } catch { /* ignore */ }
  return map;
}

/** Update the per-bot cross-reference from @mention data in an event.
 *  mentionsList comes from Lark event message.mentions array. */
export function updateBotOpenIdCrossRef(
  dataDir: string,
  larkAppId: string,
  mentionsList: Array<{ name?: string; id?: { open_id?: string } }>,
): void {
  if (!mentionsList || mentionsList.length === 0) return;

  // Read known bot names from bots-info.json
  const knownBotNames = new Set<string>();
  try {
    const infoPath = join(dataDir, 'bots-info.json');
    if (existsSync(infoPath)) {
      const entries: Array<{ botName: string | null }> = JSON.parse(readFileSync(infoPath, 'utf-8'));
      for (const e of entries) {
        if (e.botName) knownBotNames.add(e.botName.toLowerCase());
      }
    }
  } catch { /* ignore */ }
  if (knownBotNames.size === 0) return;

  // Read existing cross-reference
  const fp = join(dataDir, `bot-openids-${larkAppId}.json`);
  let existing: Record<string, string> = {};
  try {
    if (existsSync(fp)) existing = JSON.parse(readFileSync(fp, 'utf-8'));
  } catch { /* ignore */ }

  // Update with new mentions that match known bot names
  let changed = false;
  for (const m of mentionsList) {
    const name = m.name;
    const openId = m.id?.open_id;
    if (!name || !openId) continue;
    if (!knownBotNames.has(name.toLowerCase())) continue;
    if (existing[name] === openId) continue;
    existing[name] = openId;
    changed = true;
  }

  if (changed) {
    try {
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
      writeFileSync(fp, JSON.stringify(existing, null, 2) + '\n');
      logger.debug(`Updated bot open_id cross-ref for ${larkAppId}: ${JSON.stringify(existing)}`);
    } catch (err) {
      logger.debug(`Failed to write bot open_id cross-ref: ${err}`);
    }
  }
}

// ─── @mention detection ──────────────────────────────────────────────────

/** Check if the bot was @mentioned in this message */
export function isBotMentioned(larkAppId: string, message: any, _senderOpenId: string | undefined): boolean {
  const botOpenId = getBot(larkAppId).botOpenId;
  if (!botOpenId) {
    logger.warn('Bot open_id unknown, cannot check @mentions');
    return false;
  }

  // 1. Check message.mentions array (populated for user-sent text messages)
  const mentions: any[] = message.mentions ?? [];
  if (mentions.some((m: any) => m.id?.open_id === botOpenId)) {
    return true;
  }

  // 2. Check post content for inline at tags (bot-sent post messages may not
  //    populate message.mentions — the @mention is embedded in the content structure)
  try {
    const content = JSON.parse(message.content ?? '{}');
    const inner = content.zh_cn ?? content.en_us ?? content;
    if (Array.isArray(inner?.content)) {
      for (const paragraph of inner.content) {
        if (!Array.isArray(paragraph)) continue;
        for (const node of paragraph) {
          if (node.tag === 'at' && node.user_id === botOpenId) return true;
        }
      }
    }
  } catch { /* ignore parse errors */ }

  return false;
}

// ─── Permission gates ────────────────────────────────────────────────────
//
// Two separate gates for oncall support:
//   canTalk    — may address the bot in this chat (prompts, thread replies)
//   canOperate — may trigger state-changing actions (card buttons, daemon
//                slash commands like /cd /restart /close /oncall)
//
// Non-oncall chats: both fall back to the bot's allowedUsers. Oncall-bound
// chats: talking is open to everyone; operating is restricted to the entry's
// `owners` list (initial binder + anyone they later add).

export function canTalk(larkAppId: string, chatId: string | undefined, senderOpenId: string | undefined): boolean {
  const oncall = chatId ? findOncallChat(larkAppId, chatId) : undefined;
  if (oncall) return true;
  const allowedUsers = getBot(larkAppId).resolvedAllowedUsers;
  if (allowedUsers.length === 0) return true;
  return !!senderOpenId && allowedUsers.includes(senderOpenId);
}

export function canOperate(larkAppId: string, chatId: string | undefined, senderOpenId: string | undefined): boolean {
  const oncall = chatId ? findOncallChat(larkAppId, chatId) : undefined;
  if (oncall) return !!senderOpenId && oncall.owners.includes(senderOpenId);
  const allowedUsers = getBot(larkAppId).resolvedAllowedUsers;
  if (allowedUsers.length === 0) return true;
  return !!senderOpenId && allowedUsers.includes(senderOpenId);
}

// ─── Group message access check ──────────────────────────────────────────

/**
 * Check group message addressing:
 * - 'allowed'     -> sender is allowed, bot was @mentioned or solo group
 * - 'not_allowed' -> bot was @mentioned but sender is not in allowlist
 * - 'ignore'      -> not addressed to bot at all
 */
export async function checkGroupMessageAccess(
  larkAppId: string, message: any, chatId: string, senderOpenId: string | undefined,
): Promise<'allowed' | 'not_allowed' | 'ignore'> {
  const mentioned = isBotMentioned(larkAppId, message, senderOpenId);
  const isAllowed = canTalk(larkAppId, chatId, senderOpenId);

  logger.debug(`Check group message access: mentioned=${mentioned}, isAllowed=${isAllowed}`);
  if (mentioned) {
    return isAllowed ? 'allowed' : 'not_allowed';
  }

  // No @mention — only allow if sender is the sole human in the group
  // AND this is the only bot in the chat. With multiple bots, require @mention
  // to disambiguate.
  if (isAllowed) {
    const { userCount, botCount } = await getGroupStats(larkAppId, chatId);
    logger.debug(`Group user count: ${userCount}, bot count: ${botCount}`);
    if (userCount <= 1 && botCount <= 1) {
      return 'allowed';
    }
  }

  return 'ignore';
}

// ─── Event callbacks ─────────────────────────────────────────────────────

export interface EventHandlers {
  handleCardAction: (data: any, larkAppId: string) => Promise<any>;
  handleNewTopic: (data: any, chatId: string, messageId: string, chatType: 'group' | 'p2p', larkAppId: string) => Promise<void>;
  handleThreadReply: (data: any, rootId: string, larkAppId: string) => Promise<void>;
  /** Check if this bot owns an active session for the given rootId. */
  isSessionOwner?: (rootId: string, larkAppId: string) => boolean;
}

/**
 * Create and start the Lark WSClient with event dispatching.
 * Returns the WSClient instance for lifecycle management.
 */
export function startLarkEventDispatcher(larkAppId: string, larkAppSecret: string, handlers: EventHandlers): Lark.WSClient {
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'card.action.trigger': async (data: any) => {
      try {
        const cardBody = await handlers.handleCardAction(data, larkAppId);
        // If the handler returns a card body (e.g. toggle_stream), return it
        // so Lark renders the update immediately without waiting for an API PATCH.
        if (cardBody) return { card: { type: 'raw', data: cardBody } };
      } catch (err) {
        logger.error(`Error handling card action: ${err}`);
      }
      return undefined;
    },
    'im.message.receive_v1': async (data: any) => {
      try {
        const message = data.message;
        const sender = data.sender;
        if (!message) return;

        // Learn other bots' open_ids from @mentions in this event.
        // Lark open_id is per-app: these IDs are correct for our app context.
        if (message.mentions?.length > 0) {
          updateBotOpenIdCrossRef(config.session.dataDir, larkAppId, message.mentions);
        }

        // Bot-originated messages
        if (sender?.sender_type === 'app') {
          const senderOpenId = sender.sender_id?.open_id;
          const rootId = message.root_id;
          if (!rootId) return; // ignore bot messages outside threads

          const isSelfMessage = senderOpenId === getBot(larkAppId).botOpenId;

          if (isSelfMessage) {
            // Own messages: only process /close commands
            try {
              const body = JSON.parse(message.content ?? '{}');
              if (body.text?.trim() !== '/close') return;
            } catch {
              return;
            }
            handlers.handleThreadReply(data, rootId, larkAppId).catch(err => logger.error(`Error handling message event: ${err}`));
            return;
          }

          // Message from another bot: check if it @mentions this bot
          if (isBotMentioned(larkAppId, message, undefined)) {
            logger.info(`Bot-to-bot @mention detected: routing to handleThreadReply`);
            handlers.handleThreadReply(data, rootId, larkAppId).catch(err => logger.error(`Error handling bot @mention: ${err}`));
          }
          return;
        }

        const rootId = message.root_id;
        const chatId = message.chat_id;
        const chatType = message.chat_type;  // 'group' or 'p2p'
        const messageId = message.message_id;
        const senderOpenId = sender?.sender_id?.open_id as string | undefined;
        const isAllowed = canTalk(larkAppId, chatId, senderOpenId);

        logger.debug('Received message:', message);
        // Group new topics (no rootId): check @mention + permissions
        if (chatType === 'group' && !rootId) {
          const access = await checkGroupMessageAccess(larkAppId, message, chatId, senderOpenId);
          logger.debug('Group message access check:', access);
          if (access === 'not_allowed') {
            replyMessage(larkAppId, messageId, JSON.stringify({ text: '⚠️ 无操作权限' }))
              .catch(err => logger.debug(`Failed to send permission denied: ${err}`));
            return;
          }
          if (access === 'ignore') {
            logger.debug(`Ignoring group message not addressed to bot: ${messageId}`);
            return;
          }
        } else if (chatType === 'group' && rootId) {
          // Group thread replies:
          // - 1v1-style chat (sole real user + sole bot) + owns session → respond without @mention
          // - Multi-user OR multi-bot group → always require @mention, even for session owners
          // - Non-owner bots → require @mention to join/take over
          const ownsSession = handlers.isSessionOwner?.(rootId, larkAppId) ?? false;
          const stats = ownsSession ? await getGroupStats(larkAppId, chatId) : null;
          if (ownsSession && isAllowed && stats && stats.userCount <= 1 && stats.botCount <= 1) {
            // 1v1-style group + owns session → process without @mention
          } else {
            const access = await checkGroupMessageAccess(larkAppId, message, chatId, senderOpenId);
            if (access === 'not_allowed') {
              logger.debug(`Ignoring thread reply from non-allowed user: ${senderOpenId}`);
              return;
            }
            if (access === 'ignore') {
              logger.debug(`Ignoring group thread reply not addressed to bot: ${messageId}`);
              return;
            }
          }
        } else if (!isAllowed) {
          // P2P thread replies and DMs: still check allowlist
          logger.debug(`Ignoring message from non-allowed user: ${senderOpenId}`);
          return;
        }

        // p2p messages without rootId -> create session directly in the DM chat
        // group messages -> normal flow
        const promise = !rootId
          ? handlers.handleNewTopic(data, chatId, messageId, chatType as 'group' | 'p2p', larkAppId)
          : handlers.handleThreadReply(data, rootId, larkAppId);
        promise.catch(err => logger.error(`Error handling message event: ${err}`));
      } catch (err) {
        logger.error(`Error handling message event: ${err}`);
      }
    },
  });

  // Start WSClient
  const wsClient = new Lark.WSClient({
    appId: larkAppId,
    appSecret: larkAppSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  wsClient.start({ eventDispatcher });
  logger.info('Daemon WSClient started');

  return wsClient;
}
