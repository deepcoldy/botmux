import { defaultSummaryRangePrefs, summaryRangeFromLegacyContentTriggers } from '../services/summary-range-store.js';
import { selectionKeyForBot } from '../setup/cli-selection.js';
import { normalizeUsageDisplay } from '../bot-registry.js';
import type { CliRuntimeConfig } from '../adapters/cli/runtime.js';
import { GRANT_DURATION_OPTIONS } from '../services/grant-policy.js';
import { normalizeSparseReplyStyleConfig } from './reply-style.js';

export interface DashboardBotDescriptor {
  larkAppId: string;
  botName?: string | null;
  botAvatarUrl?: string;
  cliId?: string;
  /** 租户品牌（bots.json 的 BotConfig.brand）。决定飞书后台深链 host。
   *  缺省 → 前端 normalizeBrand 兜底 feishu，向后兼容旧 payload。 */
  brand?: string;
  cliRuntime?: CliRuntimeConfig;
  /** Legacy executable override. Private Bot Defaults payload only. */
  cliPathOverride?: string;
  wrapperCli?: string;
  model?: string;
  reasoningEffort?: string;
  /** dsh runner turn timeout (ms); dashboard exposes it for the dsh CLI only. */
  turnTimeoutMs?: number;
  /** dsh runtime variant ('official' | 'tui'); dashboard exposes it for the dsh CLI only. */
  dshRuntime?: 'official' | 'tui' | null;
}

/**
 * per-bot brand（feishu / lark）按 larkAppId 的映射,供 dashboard 前端派生飞书
 * 后台深链 host。brand 只在 bots.json 里(DaemonRegistry 的心跳态不带它),而
 * 配置加载在 BOTS_CONFIG 缺失 / bots.json 尚未创建 / 临时不可读时会抛——这里
 * 用 try/catch 兜底返回空 Map（与 dashboard 的 configuredCliIds /
 * configuredBotAgentFields 同款失败语义）,保证冷缓存 /api/groups 与 /api/bots
 * 仍能基于 DaemonRegistry 走降级 roster（前端拿不到 brand → normalizeBrand
 * 兜底 feishu),不因缺配置而 500。`load` 注入配置源便于单测。
 */
export function brandMapByAppId(
  load: () => ReadonlyArray<{ larkAppId: string; brand?: string }>,
): Map<string, string | undefined> {
  try {
    return new Map(load().map(b => [b.larkAppId, b.brand]));
  } catch {
    return new Map();
  }
}

export function botSummaryPayload(bot: DashboardBotDescriptor) {
  return {
    larkAppId: bot.larkAppId,
    botName: bot.botName,
    ...(bot.botAvatarUrl ? { botAvatarUrl: bot.botAvatarUrl } : {}),
    ...(bot.cliId ? { cliId: bot.cliId } : {}),
    ...(bot.brand ? { brand: bot.brand } : {}),
  };
}

export function botDefaultsPayload(bot: DashboardBotDescriptor, j?: any, error?: string) {
  const base = {
    larkAppId: bot.larkAppId,
    botName: bot.botName,
    ...(bot.cliId ? { cliId: bot.cliId } : {}),
    ...(bot.brand ? { brand: bot.brand } : {}),
    ...(bot.cliRuntime ? { cliRuntime: bot.cliRuntime } : {}),
    ...(bot.cliPathOverride ? { cliPathOverride: bot.cliPathOverride } : {}),
    ...(bot.wrapperCli ? { wrapperCli: bot.wrapperCli } : {}),
    ...(bot.model ? { model: bot.model } : {}),
    ...(bot.reasoningEffort ? { reasoningEffort: bot.reasoningEffort } : {}),
    ...(typeof bot.turnTimeoutMs === 'number' ? { turnTimeoutMs: bot.turnTimeoutMs } : {}),
    ...(bot.dshRuntime ? { dshRuntime: bot.dshRuntime } : {}),
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
    // 「仓库选择卡片」形态的工作目录。与 defaultWorkingDir 互斥（见 BotConfig）。
    // 克隆弹窗要用它判断源 Bot 是哪种目录形态，才能预填出与克隆结果一致的表单。
    workingDir: typeof j?.workingDir === 'string' ? j.workingDir : null,
    defaultWorkingDirAutoWorktree: j?.defaultWorkingDirAutoWorktree === true,
    autoboundChatCount: j?.autoboundChatCount ?? 0,
    brandLabel: j?.brandLabel ?? null,
    // Private Bot Defaults payload only. Keep the persisted shape sparse and
    // drop malformed hand edits field-by-field before they reach form state.
    replyStyle: normalizeSparseReplyStyleConfig(j?.replyStyle).config ?? null,
    sandbox: j?.sandbox === true,
    sandboxPaths: (j?.sandboxPaths && typeof j.sandboxPaths === 'object' && !Array.isArray(j.sandboxPaths))
      ? {
          readWrite: Array.isArray(j.sandboxPaths.readWrite) ? j.sandboxPaths.readWrite.filter((x: unknown) => typeof x === 'string') : [],
          readOnly: Array.isArray(j.sandboxPaths.readOnly) ? j.sandboxPaths.readOnly.filter((x: unknown) => typeof x === 'string') : [],
          deny: Array.isArray(j.sandboxPaths.deny) ? j.sandboxPaths.deny.filter((x: unknown) => typeof x === 'string') : [],
        }
      : null,
    readIsolationSupported: j?.readIsolationSupported === true,
    backendType: typeof j?.backendType === 'string' ? j.backendType : null,
    usageDisplay: normalizeUsageDisplay(j ?? {}),
    usageSupported: j?.usageSupported === true,
    disableStreamingCard: j?.disableStreamingCard === true,
    pinStreamingCard: j?.pinStreamingCard === true,
    silentTurnReactions: j?.silentTurnReactions === true,
    codexAppCleanInput: j?.codexAppCleanInput === true,
    writableTerminalLinkInCard: j?.writableTerminalLinkInCard === true,
    privateCard: j?.privateCard === true,
    thinkingCard: j?.thinkingCard !== false,
    senderTag: j?.senderTag !== false,
    overloadAlert: j?.overloadAlert === true,
    botToBotSameDir: j?.botToBotSameDir !== false,
    autoStartOnGroupJoin: j?.autoStartOnGroupJoin === true,
    autoStartOnGroupJoinPrompt: typeof j?.autoStartOnGroupJoinPrompt === 'string' ? j.autoStartOnGroupJoinPrompt : '',
    autoStartOnGroupJoinSeed: typeof j?.autoStartOnGroupJoinSeed === 'string' ? j.autoStartOnGroupJoinSeed : '',
    autoStartOnGroupJoinSeedDefault: typeof j?.autoStartOnGroupJoinSeedDefault === 'string' ? j.autoStartOnGroupJoinSeedDefault : '',
    autoStartOnNewTopic: j?.autoStartOnNewTopic === true,
    summaryRange: j?.summaryRange
      ?? summaryRangeFromLegacyContentTriggers(j?.contentTriggers)
      ?? defaultSummaryRangePrefs(),
    summaryMemory: j?.summaryMemory === true,
    summaryMemoryPath: typeof j?.summaryMemoryPath === 'string' && j.summaryMemoryPath.trim() ? j.summaryMemoryPath.trim() : 'summary.md',
    regularGroupReplyMode: (j?.regularGroupReplyMode === 'chat' || j?.regularGroupReplyMode === 'new-topic' || j?.regularGroupReplyMode === 'shared')
      ? j.regularGroupReplyMode
      : 'chat-topic',
    regularGroupMentionMode: (j?.regularGroupMentionMode === 'topic' || j?.regularGroupMentionMode === 'never' || j?.regularGroupMentionMode === 'ambient')
      ? j.regularGroupMentionMode
      : 'always',
    docSubscribeDefaultMode: j?.docSubscribeDefaultMode === 'all' ? 'all' : 'mention-only',
    substituteMode: j?.substituteMode && typeof j.substituteMode === 'object' ? j.substituteMode : null,
    feedback: j?.feedback && typeof j.feedback === 'object' ? j.feedback : null,
    restrictGrantCommands: j?.restrictGrantCommands === true,
    autoGrantRequestCards: j?.autoGrantRequestCards !== false,
    p2pOpen: j?.p2pOpen === true,
    grantDefaultDurationMs: typeof j?.grantDefaultDurationMs === 'number'
      && GRANT_DURATION_OPTIONS.includes(j.grantDefaultDurationMs as (typeof GRANT_DURATION_OPTIONS)[number])
      ? j.grantDefaultDurationMs
      : null,
    messageQuotaDefaultLimit: typeof j?.messageQuotaDefaultLimit === 'number' ? j.messageQuotaDefaultLimit : null,
    p2pMode: j?.p2pMode === 'thread' ? 'thread' : j?.p2pMode === 'group' ? 'group' : 'chat',
    envelopeInjection: j?.envelopeInjection === 'auto' ? 'auto' : 'off',
    codexAuthSync: j?.codexAuthSync === 'isolated' ? 'isolated' : 'shared',
    skillInjection: (j?.skillInjection === 'global' || j?.skillInjection === 'prompt' || j?.skillInjection === 'off') ? j.skillInjection : null,
    skillInjectionDefault: (j?.skillInjectionDefault === 'global' || j?.skillInjectionDefault === 'off') ? j.skillInjectionDefault : 'prompt',
    skillInjectionSupport: (j?.skillInjectionSupport === 'dynamic' || j?.skillInjectionSupport === 'global') ? j.skillInjectionSupport : 'none',
    maxLiveWorkers: typeof j?.maxLiveWorkers === 'number' ? j.maxLiveWorkers : null,
    logicalSessionCount: typeof j?.logicalSessionCount === 'number' ? j.logicalSessionCount : 0,
    residentSessionCount: typeof j?.residentSessionCount === 'number' ? j.residentSessionCount : 0,
    dormantSessionCount: typeof j?.dormantSessionCount === 'number' ? j.dormantSessionCount : 0,
    sessionOwnerReminder: j?.sessionOwnerReminder && typeof j.sessionOwnerReminder === 'object'
      ? j.sessionOwnerReminder
      : null,
    startupCommands: typeof j?.startupCommands === 'string' ? j.startupCommands : '',
    customPassthroughCommands: typeof j?.customPassthroughCommands === 'string' ? j.customPassthroughCommands : '',
    canTalkDaemonCommands: typeof j?.canTalkDaemonCommands === 'string' ? j.canTalkDaemonCommands : '',
    launchShell: typeof j?.launchShell === 'string' ? j.launchShell : '',
    env: typeof j?.env === 'string' ? j.env : '',
    riff: j?.riff && typeof j.riff === 'object' ? j.riff : null,
    skills: j?.skills && typeof j.skills === 'object' ? j.skills : null,
  };
}
