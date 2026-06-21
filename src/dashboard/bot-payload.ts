export interface DashboardBotDescriptor {
  larkAppId: string;
  botName?: string | null;
  botAvatarUrl?: string;
  cliId?: string;
}

export function botSummaryPayload(bot: DashboardBotDescriptor) {
  return {
    larkAppId: bot.larkAppId,
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
    autoboundChatCount: j?.autoboundChatCount ?? 0,
    brandLabel: j?.brandLabel ?? null,
    sandbox: j?.sandbox === true,
    disableStreamingCard: j?.disableStreamingCard === true,
    writableTerminalLinkInCard: j?.writableTerminalLinkInCard === true,
    privateCard: j?.privateCard === true,
    autoStartOnGroupJoin: j?.autoStartOnGroupJoin === true,
    autoStartOnGroupJoinPrompt: typeof j?.autoStartOnGroupJoinPrompt === 'string' ? j.autoStartOnGroupJoinPrompt : '',
    autoStartOnNewTopic: j?.autoStartOnNewTopic === true,
    regularGroupReplyMode: (j?.regularGroupReplyMode === 'new-topic' || j?.regularGroupReplyMode === 'shared')
      ? j.regularGroupReplyMode
      : 'chat',
    regularGroupMentionMode: (j?.regularGroupMentionMode === 'topic' || j?.regularGroupMentionMode === 'never')
      ? j.regularGroupMentionMode
      : 'always',
    restrictGrantCommands: j?.restrictGrantCommands === true,
    messageQuotaDefaultLimit: typeof j?.messageQuotaDefaultLimit === 'number' ? j.messageQuotaDefaultLimit : null,
    p2pMode: j?.p2pMode === 'chat' ? 'chat' : 'thread',
    maxLiveWorkers: typeof j?.maxLiveWorkers === 'number' ? j.maxLiveWorkers : null,
    startupCommands: typeof j?.startupCommands === 'string' ? j.startupCommands : '',
    env: typeof j?.env === 'string' ? j.env : '',
    skills: j?.skills && typeof j.skills === 'object' ? j.skills : null,
  };
}
