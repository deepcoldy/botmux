import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as sessionStore from '../services/session-store.js';
import { listChatBotMembers } from '../im/lark/client.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export const schema = z.object({
  session_id: z.string().describe('Session ID — used to determine which group chat to query for bot members'),
});

export const description = 'List bots available in the current group chat. Returns bot names, open_ids, and CLI types for use with send_to_thread mentions.';

interface BotInfoEntry {
  larkAppId: string;
  botOpenId: string | null;
  botName: string | null;
  cliId: string;
}

/** Read bots-info.json written by the daemon. */
function readBotInfo(): BotInfoEntry[] {
  const filePath = join(config.session.dataDir, 'bots-info.json');
  if (!existsSync(filePath)) return [];
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

export async function execute(args: z.infer<typeof schema>) {
  const session = sessionStore.getSession(args.session_id);
  if (!session) {
    return { error: `Session ${args.session_id} not found` };
  }

  const appId = session.larkAppId || config.lark.appId;
  const botInfo = readBotInfo();

  // Build a map of cliId → bot info for lookup (open_id matching is unreliable
  // because Lark open_ids are per-app scoped)
  const botByCli = new Map<string, BotInfoEntry>();
  for (const b of botInfo) {
    botByCli.set(b.cliId, b);
  }

  try {
    // Query group chat members to find bots in this chat
    const chatBots = await listChatBotMembers(appId, session.chatId);

    const result = chatBots.map(cb => {
      const info = botByCli.get(cb.name);  // cb.name is cliId
      return {
        name: cb.displayName,
        openId: cb.openId,
        isSelf: info?.larkAppId === appId,
      };
    });

    return {
      sessionId: args.session_id,
      chatId: session.chatId,
      bots: result,
      total: result.length,
      hint: 'Use send_to_thread with mentions parameter to @mention a bot. Pass open_id and name from this list.',
    };
  } catch (err: any) {
    logger.warn(`listChatBotMembers failed, falling back to bots-info.json: ${err.message}`);

    // Fallback: return all known bots from the registry file
    const result = botInfo
      .filter(b => b.botOpenId)
      .map(b => ({
        name: b.botName ?? b.cliId,
        openId: b.botOpenId!,
        isSelf: b.larkAppId === appId,
      }));

    return {
      sessionId: args.session_id,
      bots: result,
      total: result.length,
      hint: 'Use send_to_thread with mentions parameter to @mention a bot. Note: chat member query failed, showing all registered bots.',
    };
  }
}
