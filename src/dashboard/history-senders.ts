import {
  botsInfoObjectEntries,
  isBotsInfoNameEntry,
  type BotsInfoObjectEntry,
} from '../services/bots-info-shape.js';

export interface HistoryMessage {
  messageId: string;
  senderId: string;
  senderType: string;
  /** Server-provided display name (`with_sender_name=true` read APIs). Used as
   *  the fallback when local rosters / contact profiles can't name the sender. */
  senderName?: string;
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
  larkAppId?: string;
  botOpenId?: string | null;
  botName?: string | null;
  botAvatarUrl?: string | null;
}

/**
 * App-id index tier for history enrichment. Deliberately NOT the shared
 * isBotsInfoRouteEntry: it also accepts a MISSING botName key (undefined),
 * which the IPC caller self-builds and hand-written files contain, while still
 * rejecting truthy non-string names. Kept local so this contract cannot shift
 * when the routing guard's own decisions change.
 */
type HistoryAppIndexEntry = BotsInfoObjectEntry & { larkAppId: string };

function isHistoryAppIndexEntry(entry: BotsInfoObjectEntry): entry is HistoryAppIndexEntry {
  return typeof entry.larkAppId === 'string' && entry.larkAppId.trim().length > 0
    && (entry.botName == null || typeof entry.botName === 'string');
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
  botInfos: unknown,
): Array<HistoryMessage & { senderName?: string; senderAvatar?: string; senderBotAppId?: string }> {
  const objectRows = botsInfoObjectEntries(botInfos);
  const normalizeHistoryInfo = (info: BotsInfoObjectEntry): HistoryBotInfo => ({
    ...(typeof info.larkAppId === 'string' && info.larkAppId.trim()
      ? { larkAppId: info.larkAppId }
      : {}),
    ...(typeof info.botName === 'string' ? { botName: info.botName } : {}),
    ...(typeof info.botOpenId === 'string' ? { botOpenId: info.botOpenId } : {}),
    ...(typeof info.botAvatarUrl === 'string' ? { botAvatarUrl: info.botAvatarUrl } : {}),
  });
  const rowsForAppIndex = objectRows.filter(isHistoryAppIndexEntry);
  const rowsForNameIndex = objectRows.filter(isBotsInfoNameEntry);
  const infoByAppId = new Map<string, HistoryBotInfo>();
  for (const info of rowsForAppIndex) {
    infoByAppId.set(info.larkAppId, normalizeHistoryInfo(info));
  }
  const infoByName = new Map<string, HistoryBotInfo>();
  const duplicateNames = new Set<string>();
  for (const info of rowsForNameIndex) {
    const normalized = normalizeHistoryInfo(info);
    const name = typeof normalized.botName === 'string' ? normalized.botName.trim() : '';
    if (!name) continue;
    if (infoByName.has(name)) duplicateNames.add(name);
    else infoByName.set(name, normalized);
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
      const name = typeof directInfo.botName === 'string' ? directInfo.botName.trim() : '';
      return {
        ...message,
        ...(name ? { senderName: name } : {}),
        ...(directInfo.botAvatarUrl ? { senderAvatar: directInfo.botAvatarUrl } : {}),
        ...(directInfo.larkAppId ? { senderBotAppId: directInfo.larkAppId } : {}),
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
