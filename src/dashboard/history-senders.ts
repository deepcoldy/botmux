export interface HistoryMessage {
  messageId: string;
  senderId: string;
  senderType: string;
  msgType: string;
  content: string;
  createTime?: number;
}

export interface HistoryHumanProfile {
  name: string;
  avatarUrl?: string;
}

export interface HistoryBotMember {
  openId: string;
  displayName?: string;
  name?: string;
  larkAppId?: string;
}

export interface HistoryBotInfo {
  larkAppId: string;
  botOpenId?: string | null;
  botName?: string | null;
  botAvatarUrl?: string | null;
}

/**
 * Attach sender presentation data without changing the Lark message order or
 * content. Lark history may identify an app sender either by its stable
 * `cli_*` app id or an observer-scoped `ou_*` open_id. Match the stable id
 * directly when present; otherwise use the chat-member projection, then enrich
 * it with bots-info avatar metadata.
 */
export function enrichHistorySenders(
  messages: HistoryMessage[],
  humans: ReadonlyMap<string, HistoryHumanProfile | null>,
  botMembers: readonly HistoryBotMember[],
  botInfos: readonly HistoryBotInfo[],
): Array<HistoryMessage & { senderName?: string; senderAvatar?: string; senderBotAppId?: string }> {
  const infoByAppId = new Map(botInfos.filter(info => info.larkAppId).map(info => [info.larkAppId, info]));
  const infoByName = new Map<string, HistoryBotInfo>();
  const duplicateNames = new Set<string>();
  for (const info of botInfos) {
    const name = String(info.botName ?? '').trim();
    if (!name) continue;
    if (infoByName.has(name)) duplicateNames.add(name);
    else infoByName.set(name, info);
  }
  for (const name of duplicateNames) infoByName.delete(name);

  const botByOpenId = new Map<string, HistoryBotMember>();
  for (const member of botMembers) {
    if (member.openId) botByOpenId.set(member.openId, member);
  }

  return messages.map(message => {
    if (message.senderType === 'user') {
      const profile = humans.get(message.senderId);
      return profile
        ? { ...message, senderName: profile.name, senderAvatar: profile.avatarUrl }
        : message;
    }
    if (message.senderType !== 'app' && message.senderType !== 'bot') return message;

    const member = botByOpenId.get(message.senderId);
    const directInfo = infoByAppId.get(message.senderId);
    if (!member && directInfo) {
      const name = String(directInfo.botName ?? '').trim();
      return {
        ...message,
        ...(name ? { senderName: name } : {}),
        ...(directInfo.botAvatarUrl ? { senderAvatar: directInfo.botAvatarUrl } : {}),
        senderBotAppId: directInfo.larkAppId,
      };
    }
    if (!member) return message;
    const name = String(member.displayName || member.name || '').trim();
    const info = (member.larkAppId && infoByAppId.get(member.larkAppId)) || (name && infoByName.get(name)) || undefined;
    return {
      ...message,
      ...(name ? { senderName: name } : {}),
      ...(info?.botAvatarUrl ? { senderAvatar: info.botAvatarUrl } : {}),
      ...(member.larkAppId || info?.larkAppId ? { senderBotAppId: member.larkAppId || info?.larkAppId } : {}),
    };
  });
}
