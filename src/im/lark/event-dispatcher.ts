/**
 * Lark event dispatcher — handles WSClient setup, bot identity probing,
 * and message routing (group access checks, @mention detection).
 * Extracted from daemon.ts for modularity.
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { getBot, getAllBots } from '../../bot-registry.js';
import { getChatInfo, replyMessage } from './client.js';
import { logger } from '../../utils/logger.js';

// ─── Bot identity ─────────────────────────────────────────────────────────

export function getBotOpenId(larkAppId: string): string | undefined {
  return getBot(larkAppId).botOpenId;
}

export function setBotOpenId(larkAppId: string, id: string): void {
  getBot(larkAppId).botOpenId = id;
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
  if (openId) {
    bot.botOpenId = openId;
    logger.info(`Bot open_id: ${bot.botOpenId}`);
  } else {
    throw new Error('No open_id in bot info response');
  }
}

// ─── Group user count cache ───────────────────────────────────────────────

const chatUserCountCache = new Map<string, { count: number; fetchedAt: number }>();
export const CHAT_CACHE_TTL = 5 * 60_000; // 5 minutes

export async function getGroupUserCount(larkAppId: string, chatId: string): Promise<number> {
  const cacheKey = `${larkAppId}:${chatId}`;
  const cached = chatUserCountCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CHAT_CACHE_TTL) {
    return cached.count;
  }
  try {
    const info = await getChatInfo(larkAppId, chatId);
    chatUserCountCache.set(cacheKey, { count: info.userCount, fetchedAt: Date.now() });
    return info.userCount;
  } catch (err) {
    logger.debug(`Failed to get chat user count for ${chatId}: ${err}`);
    return cached?.count ?? 999; // fallback: assume multi-person
  }
}

// ─── @mention detection ──────────────────────────────────────────────────

/** Check if the bot was @mentioned in this message */
export function isBotMentioned(larkAppId: string, message: any, _senderOpenId: string | undefined): boolean {
  const mentions: any[] = message.mentions ?? [];
  if (mentions.length === 0) return false;

  const botOpenId = getBot(larkAppId).botOpenId;
  if (!botOpenId) {
    // Bot open_id unknown — cannot reliably detect @bot mentions.
    // Will be resolved once probeBotOpenId() completes or first bot message event arrives.
    logger.warn('Bot open_id unknown, cannot check @mentions');
    return false;
  }

  return mentions.some((m: any) => m.id?.open_id === botOpenId);
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
  const allowedUsers = getBot(larkAppId).resolvedAllowedUsers;
  const isAllowed = allowedUsers.length === 0 || (!!senderOpenId && allowedUsers.includes(senderOpenId));

  if (mentioned) {
    return isAllowed ? 'allowed' : 'not_allowed';
  }

  // No @mention — only allow if sender is the sole human in the group
  // AND there's only 1 bot registered. With multiple bots, require @mention
  // to disambiguate (Lark user_count excludes bots, so userCount=1 even in
  // a group with 1 user + N bots).
  if (isAllowed && getAllBots().length <= 1) {
    const userCount = await getGroupUserCount(larkAppId, chatId);
    if (userCount <= 1) {
      return 'allowed';
    }
  }

  return 'ignore';
}

// ─── Event callbacks ─────────────────────────────────────────────────────

export interface EventHandlers {
  handleCardAction: (data: any, larkAppId: string) => Promise<void>;
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
        await handlers.handleCardAction(data, larkAppId);
      } catch (err) {
        logger.error(`Error handling card action: ${err}`);
      }
      // Return undefined so WSClient sends no response body (avoids error 200672)
      return undefined;
    },
    'im.message.receive_v1': async (data: any) => {
      try {
        const message = data.message;
        const sender = data.sender;
        if (!message) return;

        // Learn bot's own open_id from its outgoing messages
        if (sender?.sender_type === 'app') {
          const botOpenId = getBotOpenId(larkAppId);
          if (!botOpenId && sender.sender_id?.open_id) {
            setBotOpenId(larkAppId, sender.sender_id.open_id);
            logger.info(`Learned bot open_id from message event: ${getBotOpenId(larkAppId)}`);
          }
          // Allow bot's own messages only if they are /close commands in threads
          const rootId = message.root_id;
          if (!rootId) return;
          try {
            const body = JSON.parse(message.content ?? '{}');
            if (body.text?.trim() !== '/close') return;
          } catch {
            return;
          }
          handlers.handleThreadReply(data, rootId, larkAppId).catch(err => logger.error(`Error handling message event: ${err}`));
          return;
        }

        const rootId = message.root_id;
        const chatId = message.chat_id;
        const chatType = message.chat_type;  // 'group' or 'p2p'
        const messageId = message.message_id;
        const senderOpenId = sender?.sender_id?.open_id as string | undefined;
        const allowedUsers = getBot(larkAppId).resolvedAllowedUsers;
        const isAllowed = allowedUsers.length === 0 || (!!senderOpenId && allowedUsers.includes(senderOpenId));

        // Group new topics (no rootId): check @mention + permissions
        if (chatType === 'group' && !rootId) {
          const access = await checkGroupMessageAccess(larkAppId, message, chatId, senderOpenId);
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
          // Group thread replies: allow if bot owns the session (no @mention needed),
          // otherwise require @mention to address a specific bot.
          const ownsSession = handlers.isSessionOwner?.(rootId, larkAppId) ?? false;
          if (ownsSession && isAllowed) {
            // Bot owns this thread + sender is in allowlist → process without @mention
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
