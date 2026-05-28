import type { ChatBotMember } from '../im/lark/client.js';

export type BotInfoEntryForList = {
  larkAppId: string;
  botOpenId: string | null;
  botName: string | null;
  cliId: string;
};

export type BotListOutputEntry = {
  /** Lark display name in the current chat. Good for humans, not stable for workflows. */
  name: string;
  openId: string;
  isSelf: boolean;
  source: 'configured' | 'introduce';
  /** Stable bot id to use in workflow `subagent.bot` fields. Empty for external observed bots. */
  larkAppId: string;
  /** Alias for workflow authors. Equal to larkAppId when locally configured. */
  workflowBot: string | null;
  /** Short capability label (team-level), for picking who to hand off to. */
  capability: string | null;
  /** Whether this bot has a team-level role registered. */
  hasTeamRole: boolean;
  /** Whether YOU (the listing bot) can reliably @-mention it from here. */
  mentionable: boolean;
  /** How the @-mention handle was resolved. */
  mentionSource: 'cross-ref' | 'self' | 'observed' | 'fallback';
};

export function formatChatBotsForCli(
  chatBots: ChatBotMember[],
  currentLarkAppId: string,
): BotListOutputEntry[] {
  return chatBots.map((cb) => ({
    name: cb.displayName,
    openId: cb.openId,
    isSelf: cb.larkAppId === currentLarkAppId,
    source: cb.source,
    larkAppId: cb.larkAppId,
    workflowBot: cb.larkAppId || null,
    capability: cb.capability ?? null,
    hasTeamRole: cb.hasTeamRole,
    mentionable: cb.mentionable,
    mentionSource: cb.mentionSource,
  }));
}

export function formatBotInfoEntriesForCli(
  botEntries: BotInfoEntryForList[],
  currentLarkAppId: string,
): BotListOutputEntry[] {
  return botEntries
    .filter((b) => b.botOpenId)
    .map((b) => ({
      name: b.botName ?? b.cliId,
      openId: b.botOpenId!,
      isSelf: b.larkAppId === currentLarkAppId,
      source: 'configured' as const,
      larkAppId: b.larkAppId,
      workflowBot: b.larkAppId,
      // Local fallback path (no live chat query): we only know self reliably.
      capability: null,
      hasTeamRole: false,
      mentionable: b.larkAppId === currentLarkAppId,
      mentionSource: (b.larkAppId === currentLarkAppId ? 'self' : 'fallback') as 'self' | 'fallback',
    }));
}
