import { defaultSummaryRangePrefs, summaryRangeFromLegacyContentTriggers } from '../services/summary-range-store.js';
import { selectionKeyForBot } from '../setup/cli-selection.js';
import { normalizeUsageDisplay } from '../bot-registry.js';
import { normalizeHiddenStreamingCardButtons } from '../im/lark/streaming-card-buttons.js';
import type { CliRuntimeConfig } from '../adapters/cli/runtime.js';
import { GRANT_DURATION_OPTIONS } from '../services/grant-policy.js';
import { normalizeSparseReplyStyleConfig } from './reply-style.js';
import { parseTriggerUserAuthConfig, type TriggerUserAuthConfig } from '../services/trigger-user-auth.js';
import type { NativeSubagentRuntimePolicy } from '../services/native-subagent-runtime-policy.js';
import { normalizeQuotaFallbackBotConfig } from '../services/quota-fallback.js';

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
  modelBackendVariant?: 'standard' | 'max';
  reasoningEffort?: string;
  nativeSubagentRuntime?: NativeSubagentRuntimePolicy;
  /** dsh runner turn timeout (ms); dashboard exposes it for the dsh CLI only. */
  turnTimeoutMs?: number;
  /** dsh runtime variant ('official' | 'tui'); dashboard exposes it for the dsh CLI only. */
  dshRuntime?: 'official' | 'tui' | null;
  /** dsh profile name; dashboard exposes it for the dsh CLI only. */
  dshProfile?: string | null;
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

/**
 * Trigger-user CLI auth policy for the private Bot Defaults payload.
 *
 * A daemon that predates the field simply omits it, and an unregistered bot
 * reports null — both mean "off", which is what the dashboard toggle renders as
 * unchecked. A malformed value (hand-edited bots.json reaching an older daemon
 * that echoed it verbatim) degrades to off rather than throwing: this aggregate
 * builds every bot row, so one bad policy must not take the whole page down.
 */
function normalizeTriggerUserAuthForClient(raw: unknown): TriggerUserAuthConfig | null {
  try { return parseTriggerUserAuthConfig(raw); } catch { return null; }
}

/**
 * `/api/bots` 的**协管者投影**:只保留「选 agent」这一个用途需要的字段。
 *
 * 为什么必须白名单而不是删几个字段:{@link botDefaultsPayload} 是 owner 的
 * Bot Defaults 编辑器数据源,逐字透传 daemon 的 `env`(明文,可能含各类密钥)、
 * `launchShell` / `startupCommands` / `customPassthroughCommands` /
 * `canTalkDaemonCommands` / `defaultWorkingDir`。它的 daemon 侧注释写明前提是
 * 「dashboard is owner-authenticated」—— 平台协管者进入这条路由后该前提不再成立。
 *
 * 白名单而非黑名单,是因为这个 payload 还在长:owner 那边新加一个字段,黑名单
 * 会默默把它漏给协管者,白名单只会让新字段拿不到(可发现、可修)。
 *
 * 字段取自调用方(riff 这类外部平台)实际读的那几个:bot 身份、绑定的 CLI、
 * 模型、在线与否。与 {@link botSummaryPayload} 的区别是多了 `displayName` /
 * `model` / `online` / `error` —— 那张表服务的是 dashboard 自己的 summary。
 */
export function botCoManagerPayload(row: Record<string, unknown>) {
  const pick = <T>(key: string, guard: (v: unknown) => v is T): T | undefined => {
    const v = row[key];
    return guard(v) ? v : undefined;
  };
  const isStr = (v: unknown): v is string => typeof v === 'string';
  return {
    larkAppId: String(row.larkAppId ?? ''),
    ...(isStr(row.botName) || row.botName === null ? { botName: row.botName as string | null } : {}),
    ...(isStr(row.displayName) || row.displayName === null
      ? { displayName: row.displayName as string | null }
      : {}),
    ...(pick('cliId', isStr) ? { cliId: row.cliId as string } : {}),
    ...(pick('wrapperCli', isStr) ? { wrapperCli: row.wrapperCli as string } : {}),
    ...(pick('model', isStr) ? { model: row.model as string } : {}),
    ...(pick('brand', isStr) ? { brand: row.brand as string } : {}),
    online: row.online !== false,
    ...(pick('error', isStr) ? { error: row.error as string } : {}),
  };
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
    ...(bot.modelBackendVariant ? { modelBackendVariant: bot.modelBackendVariant } : {}),
    ...(bot.reasoningEffort ? { reasoningEffort: bot.reasoningEffort } : {}),
    ...(bot.nativeSubagentRuntime ? { nativeSubagentRuntime: bot.nativeSubagentRuntime } : {}),
    ...(typeof bot.turnTimeoutMs === 'number' ? { turnTimeoutMs: bot.turnTimeoutMs } : {}),
    ...(bot.dshRuntime ? { dshRuntime: bot.dshRuntime } : {}),
    ...(bot.dshProfile ? { dshProfile: bot.dshProfile } : {}),
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
    scheduleWorkingDir: typeof j?.scheduleWorkingDir === 'string' && j.scheduleWorkingDir.trim()
      ? j.scheduleWorkingDir
      : null,
    schedulePreconditionFileRoot: typeof j?.schedulePreconditionFileRoot === 'string'
      && j.schedulePreconditionFileRoot.trim()
      ? j.schedulePreconditionFileRoot
      : null,
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
    hiddenStreamingCardButtons: normalizeHiddenStreamingCardButtons(j?.hiddenStreamingCardButtons) ?? [],
    pinStreamingCard: j?.pinStreamingCard === true,
    silentTurnReactions: j?.silentTurnReactions === true,
    codexAppCleanInput: j?.codexAppCleanInput === true,
    writableTerminalLinkInCard: j?.writableTerminalLinkInCard === true,
    privateCard: j?.privateCard === true,
    thinkingCard: j?.thinkingCard !== false,
    thinkingCardToolResult: j?.thinkingCardToolResult !== false,
    senderTag: j?.senderTag !== false,
    overloadAlert: j?.overloadAlert === true,
    botToBotSameDir: j?.botToBotSameDir !== false,
    quotaFallbackBot: normalizeQuotaFallbackBotConfig(j?.quotaFallbackBot, bot.larkAppId).config ?? null,
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
    // Trigger-user CLI auth policy. No secrets in it — just which tools it
    // covers and what to do when the sender has not authorized. Run through the
    // SHARED parser so this door cannot drift from bots.json / /botconfig: a
    // malformed hand edit degrades to null (feature off) instead of reaching
    // form state as a half-shaped policy the toggle would misrender.
    triggerUserAuth: normalizeTriggerUserAuthForClient(j?.triggerUserAuth),
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
