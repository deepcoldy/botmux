import type { ChatBotMember } from '../im/lark/client.js';
import {
  botsInfoObjectEntries,
  isBotsInfoRouteEntry,
  type BotsInfoRouteEntry,
} from '../services/bots-info-shape.js';

export interface SessionHistorySelfIdentity {
  botOpenId?: string;
  botName?: string;
  botAvatarUrl?: string;
}

export interface SessionHistoryIdentitySeed {
  botMembers: ChatBotMember[];
  botInfos: BotsInfoRouteEntry[];
}

/**
 * Sanitize the shared registry and add the configured bot as a startup-time
 * fallback. The registry and bot lookup fail independently, so this function
 * deliberately preserves healthy peer rows when the local bot was removed.
 */
export function seedSessionHistoryIdentity(
  appId: string,
  self: SessionHistorySelfIdentity | undefined,
  botMembersInput: readonly ChatBotMember[],
  botInfosRaw: unknown,
): SessionHistoryIdentitySeed {
  const botMembers = [...botMembersInput];
  const botInfos = botsInfoObjectEntries(botInfosRaw).filter(isBotsInfoRouteEntry);
  const resolvedSelf = self ?? {};

  if (resolvedSelf.botOpenId && !botMembers.some(member => member.openId === resolvedSelf.botOpenId)) {
    const selfName = resolvedSelf.botName || appId;
    botMembers.push({
      openId: resolvedSelf.botOpenId,
      displayName: selfName,
      name: selfName,
      larkAppId: appId,
      source: 'configured',
      mentionable: true,
      mentionSource: 'self',
      hasTeamRole: false,
    });
  }

  if (self && !botInfos.some(info => info.larkAppId === appId)) {
    botInfos.push({
      larkAppId: appId,
      botOpenId: self.botOpenId,
      botName: self.botName ?? null,
      botAvatarUrl: self.botAvatarUrl,
    });
  }

  return { botMembers, botInfos };
}
