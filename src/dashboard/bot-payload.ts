import { defaultSummaryRangePrefs, summaryRangeFromLegacyContentTriggers } from '../services/summary-range-store.js';

export interface DashboardBotDescriptor {
  larkAppId: string;
  botOpenId?: string | null;
  botName?: string | null;
  botAvatarUrl?: string;
  cliId?: string;
}

export function botSummaryPayload(bot: DashboardBotDescriptor) {
  return {
    larkAppId: bot.larkAppId,
    ...(bot.botOpenId ? { botOpenId: bot.botOpenId } : {}),
    botName: bot.botName,
    ...(bot.botAvatarUrl ? { botAvatarUrl: bot.botAvatarUrl } : {}),
    ...(bot.cliId ? { cliId: bot.cliId } : {}),
  };
}

export function botDefaultsPayload(bot: DashboardBotDescriptor, j?: any, error?: string) {
  const base = {
    larkAppId: bot.larkAppId,
    botName: bot.botName,
    ...(bot.cliId ? { cliId: bot.cliId } : {}),
    online: true,
  };
  if (error) return { ...base, error };
  return {
    ...base,
    defaultOncall: j?.defaultOncall,
    defaultWorkingDir: typeof j?.defaultWorkingDir === 'string' ? j.defaultWorkingDir : null,
    autoboundChatCount: j?.autoboundChatCount ?? 0,
    brandLabel: j?.brandLabel ?? null,
    sandbox: j?.sandbox === true,
    disableStreamingCard: j?.disableStreamingCard === true,
    silentTurnReactions: j?.silentTurnReactions === true,
    writableTerminalLinkInCard: j?.writableTerminalLinkInCard === true,
    privateCard: j?.privateCard === true,
    botToBotSameDir: j?.botToBotSameDir !== false,
    autoStartOnGroupJoin: j?.autoStartOnGroupJoin === true,
    autoStartOnGroupJoinPrompt: typeof j?.autoStartOnGroupJoinPrompt === 'string' ? j.autoStartOnGroupJoinPrompt : '',
    autoStartOnNewTopic: j?.autoStartOnNewTopic === true,
    summaryRange: j?.summaryRange
      ?? summaryRangeFromLegacyContentTriggers(j?.contentTriggers)
      ?? defaultSummaryRangePrefs(),
    regularGroupReplyMode: (j?.regularGroupReplyMode === 'new-topic' || j?.regularGroupReplyMode === 'shared' || j?.regularGroupReplyMode === 'chat-topic')
      ? j.regularGroupReplyMode
      : 'chat',
    regularGroupMentionMode: (j?.regularGroupMentionMode === 'topic' || j?.regularGroupMentionMode === 'never' || j?.regularGroupMentionMode === 'ambient')
      ? j.regularGroupMentionMode
      : 'always',
    restrictGrantCommands: j?.restrictGrantCommands === true,
    autoGrantRequestCards: j?.autoGrantRequestCards !== false,
    messageQuotaDefaultLimit: typeof j?.messageQuotaDefaultLimit === 'number' ? j.messageQuotaDefaultLimit : null,
    p2pMode: j?.p2pMode === 'chat' ? 'chat' : 'thread',
    maxLiveWorkers: typeof j?.maxLiveWorkers === 'number' ? j.maxLiveWorkers : null,
    startupCommands: typeof j?.startupCommands === 'string' ? j.startupCommands : '',
    env: typeof j?.env === 'string' ? j.env : '',
    skills: j?.skills && typeof j.skills === 'object' ? j.skills : null,
  };
}
