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
    }));
}
