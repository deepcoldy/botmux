import { defaultSummaryRangePrefs, summaryRangeFromLegacyContentTriggers } from '../services/summary-range-store.js';
import { selectionKeyForBot } from '../setup/cli-selection.js';

export interface DashboardBotDescriptor {
  larkAppId: string;
  botName?: string | null;
  botAvatarUrl?: string;
  cliId?: string;
  wrapperCli?: string;
  model?: string;
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
    ...(bot.wrapperCli ? { wrapperCli: bot.wrapperCli } : {}),
    ...(bot.model ? { model: bot.model } : {}),
    // 「修改 CLI」下拉的当前选中项（cliId+wrapperCli → 选择键），wrapper 网关形态
    // （aiden×claude / ttadk×codex 等）据此才能高亮回对应选项，否则前端回落到裸
    // cliId、丢失 wrapper 语义（重载后下拉复位、再保存会把 wrapper 剥掉）。
    ...(bot.cliId ? { agentSelectionKey: selectionKeyForBot(bot.cliId, bot.wrapperCli) } : {}),
    online: true,
  };
  if (error) return { ...base, error };
  return {
    ...base,
    // 展示名编辑框：displayName = 自定义备注名（null = 跟随飞书名称）；
    // larkBotName = 飞书探测到的应用名（placeholder / 恢复默认提示）。
    displayName: typeof j?.displayName === 'string' ? j.displayName : null,
    larkBotName: typeof j?.larkBotName === 'string' ? j.larkBotName : null,
    defaultOncall: j?.defaultOncall,
    defaultWorkingDir: typeof j?.defaultWorkingDir === 'string' ? j.defaultWorkingDir : null,
    defaultWorkingDirAutoWorktree: j?.defaultWorkingDirAutoWorktree === true,
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
    skillInjection: (j?.skillInjection === 'global' || j?.skillInjection === 'prompt' || j?.skillInjection === 'off') ? j.skillInjection : null,
    skillInjectionDefault: (j?.skillInjectionDefault === 'global' || j?.skillInjectionDefault === 'off') ? j.skillInjectionDefault : 'prompt',
    skillInjectionSupport: (j?.skillInjectionSupport === 'dynamic' || j?.skillInjectionSupport === 'global') ? j.skillInjectionSupport : 'none',
    maxLiveWorkers: typeof j?.maxLiveWorkers === 'number' ? j.maxLiveWorkers : null,
    startupCommands: typeof j?.startupCommands === 'string' ? j.startupCommands : '',
    env: typeof j?.env === 'string' ? j.env : '',
    skills: j?.skills && typeof j.skills === 'object' ? j.skills : null,
  };
}
