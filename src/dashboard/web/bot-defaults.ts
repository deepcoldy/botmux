import { store } from './store.js';
import type { CliRuntimeConfig as SharedCliRuntimeConfig } from '../../adapters/cli/runtime.js';
import type { FeedbackPolicyLayer } from '../../services/feedback-policy-resolver.js';
import type { ReplyStyleConfig } from '../../im/lark/reply-card-style.js';
import type { AskOptionLayout } from '../../im/lark/ask-option-layout.js';
import type { CodexReasoningEffort } from '../../services/codex-reasoning-effort.js';
import type { CodexServiceTier } from '../../services/codex-service-tier.js';
import type { StreamingCardButtonId } from '../../im/lark/streaming-card-buttons.js';
import type { TraexAutoModelConfig } from '../../services/traex-auto-model.js';
import type { ScratchCapability } from '../../adapters/backend/scratch-capability.js';

/** Bot 配置页的分类 tab。放在这个轻量模块里：⌘K 索引（入口包）要按它生成条目，页面本身很重。 */
export type BotDefaultsTab = 'common' | 'sessions' | 'security' | 'cards' | 'advanced';

export const BOT_DEFAULTS_TABS: readonly BotDefaultsTab[] = [
  'common',
  'sessions',
  'security',
  'cards',
  'advanced',
];

export const BOT_DEFAULTS_TAB_LABEL_KEYS: Readonly<Record<BotDefaultsTab, string>> = {
  common: 'botDefaults.tabCommon',
  sessions: 'botDefaults.tabSessions',
  security: 'botDefaults.tabSecurity',
  cards: 'botDefaults.tabCards',
  advanced: 'botDefaults.tabAdvanced',
};

export function parseBotDefaultsTab(value: string | null | undefined): BotDefaultsTab | null {
  return value && (BOT_DEFAULTS_TABS as readonly string[]).includes(value) ? value as BotDefaultsTab : null;
}

/**
 * Bot 配置页各分类网格里的区块，⌘K 按它生成「区块」与「配置项」条目。页面上每个格子挂
 * `id={botDefaultsSectionDomId(id)}`；覆盖测试要求格子与这张表一一对应、页面里每个区块
 * 标题都在表里——新加区块忘了登记会直接红。
 */
export interface BotDefaultsSection {
  id: string;
  tab: BotDefaultsTab;
  titleKey: string;
  /** 和别的区块合放在同一个格子里时，那个格子的 id（落地时先找格子，再按标题找区块）。 */
  tile?: string;
  /** 区块里的配置项标题：⌘K 直达，落地时在区块里按文字定位到那一行。 */
  fieldKeys?: readonly string[];
}

export const BOT_DEFAULTS_SECTIONS: readonly BotDefaultsSection[] = [
  {
    id: 'agent',
    tab: 'common',
    titleKey: 'botDefaults.sectionAgent',
    fieldKeys: [
      'botDefaults.agentModel', 'botDefaults.agentReasoningEffort', 'botDefaults.agentServiceTier',
      'botDefaults.agentModelBackendVariant', 'botDefaults.agentTurnTimeout', 'botDefaults.minimaxTurnBudget',
      'botDefaults.cliConfigDir',
      'botDefaults.skillInjection', 'botDefaults.nativeSubagentTitle', 'botDefaults.runtimeTitle',
      'botDefaults.runtimeId', 'botDefaults.runtimeExecutable', 'botDefaults.runtimePackageName',
      'botDefaults.dshProfileTitle', 'botDefaults.dshRuntimeTitle', 'botDefaults.sectionRiff',
      'botDefaults.riffModel', 'botDefaults.riffReasoningEffort',
      'botDefaults.riffSandboxCluster', 'botDefaults.riffJwtEnv',
      'botDefaults.autoModelTitle', 'botDefaults.autoModelReselectPerTurn',
      'botDefaults.agentCli', 'botDefaults.runtimeDisplayName', 'botDefaults.runtimeLegacyPath',
      'botDefaults.runtimeUpdateProvider', 'botDefaults.nativeSubagentModel', 'botDefaults.nativeSubagentCustomModel',
      'botDefaults.nativeSubagentReasoningEffort', 'botDefaults.nativeSubagentCustomReasoningEffort',
      'botDefaults.riffBaseUrl', 'botDefaults.riffSystemPrompt', 'botDefaults.riffSetupCommands',
      'botDefaults.autoModelTimeout', 'botDefaults.autoModelCooldown', 'botDefaults.autoModelContext',
    ],
  },
  {
    id: 'working-dir',
    tab: 'common',
    titleKey: 'botDefaults.sectionWorkingDir',
    fieldKeys: [
      'botDefaults.groupWorkingDir', 'botDefaults.autoWorktree', 'botDefaults.autoStartJoin',
      'botDefaults.autoStartJoinSeed', 'botDefaults.autoStartTopic', 'botDefaults.autoInviteOwnerOnGroupAdd',
      'botDefaults.groupJoinCommand', 'botDefaults.groupJoinCommandField',
      'botDefaults.workingDirField', 'botDefaults.autoStartJoinPrompt',
    ],
  },
  { id: 'role', tab: 'common', titleKey: 'botDefaults.sectionRole', fieldKeys: ['botDefaults.profileRoles', 'roles.injectModeLabel'] },
  {
    id: 'session-mode',
    tab: 'sessions',
    titleKey: 'botDefaults.sectionSessionMode',
    fieldKeys: [
      'botDefaults.groupP2p', 'botDefaults.groupRegular', 'botDefaults.groupMention', 'botDefaults.sgTag',
      'botDefaults.docSubscribeMode', 'botDefaults.chatManagerTitle', 'botDefaults.sgTagAuthPasteLabel',
      'botDefaults.sgTagName', 'botDefaults.sgClosedTagName',
    ],
  },
  // 管家：和「群负责人」同属「谁来接待 / 跟进」一类开关，紧挨着会话模式那一格放。
  {
    id: 'steward',
    tab: 'sessions',
    titleKey: 'botDefaults.sectionSteward',
    fieldKeys: ['botDefaults.stewardEnabled', 'botDefaults.stewardChat', 'botDefaults.stewardAutoJoin', 'botDefaults.stewardAutoJoinSolo', 'botDefaults.stewardGuide'],
  },
  {
    id: 'substitute',
    tab: 'sessions',
    titleKey: 'botDefaults.sectionSubstitute',
    fieldKeys: [
      'botDefaults.substituteEnabled', 'botDefaults.substituteTargets', 'botDefaults.substituteChats',
      'botDefaults.substituteExcludedChats', 'botDefaults.substituteReplyMode', 'botDefaults.substituteDisclosure',
      'botDefaults.substituteControlCard', 'botDefaults.substituteTopicGroups', 'botDefaults.substituteTopicActive',
    ],
  },
  {
    id: 'command-trigger',
    tab: 'sessions',
    titleKey: 'botDefaults.sectionCommandTrigger',
    fieldKeys: [
      'botDefaults.commandTriggerEnabled', 'botDefaults.commandTriggerCommands', 'botDefaults.commandTriggerScope',
      'botDefaults.commandTriggerChats', 'botDefaults.commandTriggerExcludedChats',
    ],
  },
  { id: 'cross-bot', tab: 'sessions', titleKey: 'botDefaults.sectionCrossBot', fieldKeys: ['botDefaults.botToBotSameDir'] },
  { id: 'session-cap', tab: 'sessions', titleKey: 'botDefaults.sectionSessionCap', fieldKeys: ['botDefaults.maxLiveWorkers', 'botDefaults.idleSuspendMinutes'] },
  { id: 'prompt-cache', tab: 'sessions', titleKey: 'botDefaults.sectionPromptCache', fieldKeys: [
      'promptCache.ttl', 'promptCache.keepalive', 'promptCache.idleMinutes', 'promptCache.maxPings',
      'promptCache.activeHours', 'promptCache.minContextTokens',
    ] },
  { id: 'startup-commands', tab: 'sessions', titleKey: 'botDefaults.sectionStartupCommands' },
  { id: 'summary-trigger', tab: 'sessions', titleKey: 'botDefaults.sectionSummaryTrigger', fieldKeys: [
      'botDefaults.summaryMemory', 'botDefaults.summaryLimit', 'botDefaults.summarySinceHours', 'botDefaults.summaryMemoryPath',
    ] },
  { id: 'sandbox', tab: 'security', titleKey: 'botDefaults.sectionSandbox' },
  { id: 'network-policy', tab: 'security', titleKey: 'botDefaults.networkPolicy', tile: 'sandbox' },
  { id: 'codex-auth', tab: 'security', titleKey: 'botDefaults.sectionCodexAuth', fieldKeys: ['botDefaults.codexAuthSyncLabel'] },
  { id: 'sandbox-paths', tab: 'security', titleKey: 'botDefaults.sectionSandboxPaths' },
  { id: 'trigger-user-auth', tab: 'security', titleKey: 'botDefaults.sectionTriggerUserAuth', fieldKeys: ['botDefaults.triggerUserAuthToggle', 'botDefaults.triggerUserAuthDelegateOnMention'] },
  { id: 'lark-tool-binding', tab: 'security', titleKey: 'botDefaults.sectionLarkToolBinding', fieldKeys: ['botDefaults.larkToolBindingToggle'] },
  {
    id: 'grant',
    tab: 'security',
    titleKey: 'botDefaults.sectionGrant',
    fieldKeys: [
      'botDefaults.p2pOpen', 'botDefaults.restrictGrant', 'botDefaults.autoGrantCard',
      'botDefaults.grantRequestToOwnerDm', 'botDefaults.trustSameOwnerBots', 'botDefaults.grantDelegateBots',
      'botDefaults.grantDurationDefault', 'botDefaults.quotaDefault',
    ],
  },
  { id: 'blocked-users', tab: 'security', titleKey: 'blocked.sectionTitle' },
  {
    id: 'slash-commands',
    tab: 'security',
    titleKey: 'botDefaults.sectionSlashCommands',
    fieldKeys: ['botDefaults.nativeSlashTitle', 'botDefaults.canTalkDaemon', 'botDefaults.customPassthrough'],
  },
  {
    id: 'card-behavior',
    tab: 'cards',
    titleKey: 'botDefaults.sectionCard',
    fieldKeys: [
      'botDefaults.replyCardMode', 'botDefaults.autoStreaming', 'botDefaults.pinStreamingCard',
      'botDefaults.privateCard', 'botDefaults.writableLink', 'botDefaults.footerTiming',
      'botDefaults.usageDisplay', 'botDefaults.silentTurnReactions', 'botDefaults.replyCardActions',
      'botDefaults.cotEnabled', 'botDefaults.replyCardTools', 'botDefaults.replyCardShowTools',
      'botDefaults.replyFooterEnabled', 'botDefaults.replyFooterBrand', 'botDefaults.replyFooterModel',
      'botDefaults.replyFooterUsage', 'botDefaults.replyFooterRecipients', 'botDefaults.replyFooterVoice',
      'botDefaults.streamingButton.output', 'botDefaults.streamingButton.terminal',
      'botDefaults.streamingButton.writeLink', 'botDefaults.streamingButton.compact',
      'botDefaults.streamingButton.stop', 'botDefaults.streamingButton.close',
      'quietPreset.title', 'quietPreset.switch',
    ],
  },
  { id: 'feedback', tab: 'cards', titleKey: 'botDefaults.sectionFeedback' },
  {
    id: 'reply-style',
    tab: 'cards',
    titleKey: 'botDefaults.sectionReplyStyle',
    fieldKeys: [
      'botDefaults.replyStyleTheme', 'botDefaults.replyStyleLayouts', 'botDefaults.replyStyleLayoutShell',
      'botDefaults.replyStyleRecipes', 'botDefaults.replyStyleRecipePrompt',
      'botDefaults.replyStyleColor', 'botDefaults.replyStyleTag', 'botDefaults.replyStyleCustomTag',
    ],
  },
  { id: 'ask-option-layout', tab: 'cards', titleKey: 'botDefaults.sectionAskOptionLayout' },
  { id: 'brand', tab: 'cards', titleKey: 'botDefaults.sectionBrand', fieldKeys: ['botDefaults.brandLabel'] },
  { id: 'backend', tab: 'advanced', titleKey: 'botDefaults.sectionBackend', fieldKeys: ['botDefaults.backendLabel'] },
  {
    id: 'herdr',
    tab: 'advanced',
    titleKey: 'botDefaults.sectionHerdr',
    fieldKeys: [
      'botDefaults.herdrWorkspace', 'botDefaults.herdrTab', 'botDefaults.herdrSessionName',
      'botDefaults.herdrPlacement', 'botDefaults.herdrSplitDirection', 'botDefaults.herdrChatTypes',
      'botDefaults.herdrChatTypeGroup', 'botDefaults.herdrChatTypeP2p',
    ],
  },
  {
    id: 'codex-app-display',
    tab: 'advanced',
    titleKey: 'botDefaults.sectionCodexAppDisplay',
    fieldKeys: ['botDefaults.codexAppCleanInput', 'botDefaults.codexBrowser', 'botDefaults.noProgressNotify', 'botDefaults.noProgressNotifyTimeoutLabel'],
  },
  {
    id: 'codex-runtime',
    tab: 'advanced',
    titleKey: 'botDefaults.sectionCodexRuntime',
    tile: 'codex-app-display',
    fieldKeys: ['botDefaults.cliProgressNotify'],
  },
  { id: 'envelope-injection', tab: 'advanced', titleKey: 'botDefaults.envelopeInjection', fieldKeys: ['botDefaults.envelopeInjectionAuto'] },
  { id: 'prompt-injection', tab: 'advanced', titleKey: 'botDefaults.promptInjection', fieldKeys: ['botDefaults.promptInjectionToggle'] },
  { id: 'reply-delivery', tab: 'advanced', titleKey: 'botDefaults.replyDelivery', tile: 'prompt-injection', fieldKeys: ['botDefaults.replyDeliveryTranscript'] },
  { id: 'sender-tag', tab: 'advanced', titleKey: 'botDefaults.senderTag', fieldKeys: ['botDefaults.senderTagInject', 'botDefaults.senderTagHideEmail'] },
  {
    id: 'quota-fallback',
    tab: 'advanced',
    titleKey: 'botDefaults.quotaFallbackTitle',
    fieldKeys: [
      'botDefaults.quotaFallbackEnabled', 'botDefaults.quotaFallbackTarget', 'botDefaults.quotaFallbackMessage',
      'botDefaults.quotaFallbackKindUsage', 'botDefaults.quotaFallbackKindRate',
    ],
  },
  {
    id: 'runtime-env',
    tab: 'advanced',
    titleKey: 'botDefaults.sectionRuntimeEnv',
    fieldKeys: ['botDefaults.sectionLaunchShell', 'sessionEnv.sectionTitle', 'sessionEnv.inheritLabel', 'sessionEnv.tmuxTitle'],
  },
  { id: 'owner-reminder', tab: 'advanced', titleKey: 'botDefaults.ownerReminderTitle', fieldKeys: ['botDefaults.ownerReminderEnabled', 'botDefaults.ownerReminderText', 'botDefaults.ownerReminderInterval'] },
];

export function botDefaultsSectionDomId(id: string): string {
  return `bd-section-${id}`;
}

export function findBotDefaultsSection(id: string | null | undefined): BotDefaultsSection | null {
  return (id && BOT_DEFAULTS_SECTIONS.find(section => section.id === id)) || null;
}

/**
 * `#/bot-defaults?bot=<appId>&tab=<分类>&section=<区块>&field=<配置项>` 深链；都不给就是 Bot 配置页本身。
 * 给了区块就不必再给分类，页面按区块所在的分类切过去。
 */
export function botDefaultsHref(target: { bot?: string; tab?: BotDefaultsTab; section?: string; field?: string } = {}): string {
  const params = new URLSearchParams();
  if (target.bot) params.set('bot', target.bot);
  if (target.tab) params.set('tab', target.tab);
  if (target.section) params.set('section', target.section);
  if (target.field) params.set('field', target.field);
  const query = params.toString();
  return `#/bot-defaults${query ? `?${query}` : ''}`;
}

export type CliOption = {
  id: string;
  label: string;
  gateway?: 'ttadk';
  acceptsModel?: boolean;
  available?: boolean;
  availabilityStatus?: import('../../setup/cli-availability.js').CliAvailabilityStatus;
  command?: string;
  availabilityReason?: string;
  cliLaunchMode?: 'forge-traex';
  /** 静态模型候选（后端精选列表；不支持模型的 CLI 为 []）。live 探测结果走 /api/cli-options/models。 */
  modelChoices?: readonly string[];
};

export type CliOptionsState = {
  options: CliOption[];
  ttadkModelDefault: string;
  ttadkModelSuggestions: string[];
};

export type ModelCapabilities = {
  slug: string;
  serviceTiers: string[];
  reasoningEfforts?: string[];
  contextWindow?: number;
  contextVariants?: Array<{ id: 'standard' | 'max'; contextWindow: number; reasoningEfforts?: string[] }>;
};

/** Keep the browser payload contract tied to the daemon's canonical schema. */
export type CliRuntimeConfig = SharedCliRuntimeConfig;
export type CliRuntimeUpdateProvider = NonNullable<SharedCliRuntimeConfig['update']>['provider'];

/** Browser contract: configured dimensions are custom; absence means pass-through. */
export type NativeSubagentRuntimePolicy = {
  model?: { mode: 'custom'; value: string };
  reasoningEffort?: { mode: 'custom'; value: CodexReasoningEffort };
};

export type BotSubstituteTarget = {
  openId?: string;
  userId?: string;
  unionId?: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
};

export type BotSubstituteMode = {
  enabled: boolean;
  targets: BotSubstituteTarget[];
  disclosure: 'prefix' | 'none';
  chats?: string[];
  excludedChats?: string[];
  replyMode?: 'thread' | 'quote';
  disableControlCard?: boolean;
  /** 话题群支持（缺省 true；显式 false 关）。 */
  topicGroups?: boolean;
  /** 话题里已有本 bot 活跃会话时是否仍触发替身（缺省 true）。 */
  topicActiveSessionTrigger?: boolean;
};

export type BotDefaultsRow = {
  envRevision?: string;
  larkAppId: string;
  botName?: string;
  cliId?: string;
  /** 租户品牌，决定飞书后台深链的 host（feishu.cn vs larksuite.com）。
   *  缺省（旧 payload / 未注册）→ larkConsoleUrl 内 normalizeBrand 兜底 feishu。 */
  brand?: string;
  /** Absent/null is the built-in runtime. Older dashboard payloads omit it. */
  cliRuntime?: CliRuntimeConfig | null;
  /** Legacy path-only executable override, returned only by private Bot Defaults APIs. */
  cliPathOverride?: string | null;
  wrapperCli?: string | null;
  cliLaunchMode?: 'forge-traex' | null;
  model?: string;
  traexAutoModel?: TraexAutoModelConfig;
  codexRpcInput?: boolean | null;
  codexRpcInputDefault?: boolean;
  codexRpcInputEffective?: boolean;
  traexAutoModelBlockedReason?: 'rpc_input' | null;
  modelBackendVariant?: 'standard' | 'max' | null;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  codexProfile?: string | null;
  serviceTier?: CodexServiceTier;
  nativeSubagentRuntime?: NativeSubagentRuntimePolicy;
  /** dsh runner turn timeout (ms); rendered as a dsh-only field. */
  turnTimeoutMs?: number;
  /** dsh runtime variant: 'official' (JSON-RPC runner) or 'tui' (dsh-tui PTY). */
  dshRuntime?: 'official' | 'tui' | null;
  /** dsh profile name; rendered as a dsh-only field. */
  dshProfile?: string | null;
  agentSelectionKey?: string;
  /** CLI config profile dir (claude-code: CLAUDE_CONFIG_DIR); null/absent = CLI default. */
  cliConfigDir?: string | null;
  defaultOncall?: { enabled?: boolean; workingDir?: string; since?: number };
  defaultWorkingDir?: string | null;
  /** 「仓库选择卡片」形态的工作目录，与 defaultWorkingDir 互斥。 */
  workingDir?: string | null;
  defaultWorkingDirAutoWorktree?: boolean;
  /** 自动绑定机会已用过的群数（含已解绑 / 切模式释放的），不是当前绑定数。 */
  autoboundChatCount?: number;
  /** 当前 oncall 绑定数；null = daemon 太旧没报。 */
  oncallChatCount?: number | null;
  brandLabel?: string | null;
  /** Sparse per-bot reply-card style override; null means all built-in defaults. */
  replyStyle?: ReplyStyleConfig | null;
  /** Per-bot ask option layout; null means the built-in compact default. */
  askOptionLayout?: AskOptionLayout | null;
  sandbox?: boolean;
  /** Tri-state sandbox selection ('off' absent historically → derive from sandbox). */
  sandboxMode?: 'off' | 'oncall' | 'scratch' | null;
  scratchStorage?: 'tmpfs' | 'disk' | null;
  /** Whether the tmpfs/disk storage segmented control applies (Linux only;
   *  macOS scratch is always APFS-clonefile backed). */
  scratchStorageSelectable?: boolean;
  scratchTmpfsSizeMb?: number | null;
  scratchDenyPaths?: string[] | null;
  /** Whether the scratch mode is available on this platform (Linux only). */
  scratchSupported?: boolean;
  /** Daemon-side read-only probe of what scratch can use on this machine
   *  (null: older daemon). Advice only; never blocks saving. */
  scratchCapability?: ScratchCapability | null;
  codexAuthSync?: 'shared' | 'isolated';
  /** Trigger-user CLI auth: null / absent = off (the historical behavior, where
   *  CLI calls use whatever identity is logged in on the machine).
   *  gitHost / gitTokenExchangeUrl have no editor in the UI — they round-trip
   *  through the daemon's merge on PUT, so the page neither shows nor sends them. */
  triggerUserAuth?: {
    enabled: boolean;
    tools: Array<'lark-cli' | 'bytedcli'>;
    fallback: 'bot-identity' | 'none';
    /** Where the sender's credentials come from: central platform first
     *  (`auto`, default), platform only, or this machine only. */
    credentialSource?: 'auto' | 'platform' | 'local';
    /** `--mention` handoffs to bots on this machine carry this turn's sender.
     *  Absent = on (the default); only `false` is stored. */
    delegateOnMention?: boolean;
    gitHost?: string;
    gitTokenExchangeUrl?: string;
  } | null;
  /** lark-cli 应用绑定开关（默认开启）。默认开启以当前 Bot 应用凭证调用并支持 --profile 透传；设为 false 显式关闭。 */
  larkToolBinding?: boolean;
  /** Opt-in policy, configured for future sessions; absence retains legacy behavior. */
  sandboxNetworkPolicy?: import('../../core/sandbox-network-policy.js').SandboxNetworkPolicy | null;
  sandboxNetworkPolicyPlatform?: string | null;
  /** Host nameservers usable as dnsServers (Linux), for the editor's starting template. */
  sandboxNetworkHostDns?: string[];
  /** Proxy variable names set for this bot's workers (daemon env + bot env). */
  sandboxNetworkProxyEnv?: string[];
  /** Three-tier sandbox path whitelist (highest-precedence FsPolicy layer). */
  sandboxPaths?: { readWrite: string[]; readOnly: string[]; deny: string[] } | null;
  /** Stored readWrite entries that are `/`, HOME, the botmux data root or an
   *  ancestor of them: no longer accepted on save, run as readOnly. */
  sandboxPathsForbiddenReadWrite?: string[];
  /** Stored readOnly entries naming `/`: refused on save, ignored at spawn. */
  sandboxPathsReadOnlyRoot?: string[];
  /** Whether the unified file sandbox ALSO applies cross-bot read isolation for
   *  this bot's sessions — true when the CLI (claude/codex) + platform (macOS/Linux)
   *  + no wrapper can enforce it. Drives the capability label under the toggle. */
  readIsolation?: boolean;
  readIsolationSupported?: boolean;
  backendType?: string | null;
  /** daemon 的默认后端：`backendType` 没有覆盖时会话实际用它（见 effectiveBackendType）。 */
  defaultBackendType?: string | null;
  usageDisplay?: 'streaming' | 'footer' | 'off';
  replyFooterEnabled?: boolean;
  replyFooterBrand?: boolean;
  replyFooterModel?: boolean;
  replyFooterUsage?: boolean;
  replyFooterRecipients?: boolean;
  replyFooterVoice?: boolean;
  showReplyTiming?: boolean;

  usageSupported?: boolean;
  disableStreamingCard?: boolean;
  replyCardMode?: 'legacy' | 'unified';
  hiddenStreamingCardButtons?: StreamingCardButtonId[];
  pinStreamingCard?: boolean;
  silentTurnReactions?: boolean;
  codexAppCleanInput?: boolean;
  codexBrowser?: boolean;
  writableTerminalLinkInCard?: boolean;
  privateCard?: boolean;
  replyCardActions?: boolean;
  /** Bot-level master switch for the native CoT (thinking process) message.
   *  Default ON — only an explicit false means disabled. */
  cotEnabled?: boolean;
  /** Show tool calls/commands/results in unified reply cards. Default ON;
   *  only meaningful for replyCardMode 'unified'. */
  replyCardShowTools?: boolean;
  /** Whether each turn carries the `<sender>` speaker tag. Default ON — only an
   *  explicit false means the tag is suppressed. */
  senderTag?: boolean;
  senderTagHideEmail?: boolean;
  overloadAlert?: boolean;
  botToBotSameDir?: boolean;
  quotaFallbackBot?: {
    enabled: true;
    targetAppId: string;
    kinds: Array<'usage' | 'rate'>;
    message: string;
  } | null;
  online?: boolean;
  startupBlocked?: {
    reason: 'quota_fallback_cycle';
    cycle: string[];
  };
  summaryRange?: { limit?: number; sinceHours?: number };
  summaryMemory?: boolean;
  summaryMemoryPath?: string;
  p2pMode?: string;
  /** #794: per-turn 上下文注入方式。'auto' = 支持的 CLI 走 hook 注入；缺省/'off' = 内联。 */
  envelopeInjection?: 'auto' | 'off' | null;
  /** 最终回复投递方式的**生效值**（显式配置，否则按 CLI 缺省）。'transcript' = daemon
   *  从 CLI 转写自动取最终回复，模型不再被要求 botmux send；'send' = 模型自己 botmux send。 */
  topicUnavailablePolicy?: 'legacy' | 'stop';
  replyDelivery?: 'send' | 'transcript' | null;
  promptInjection?: 'default' | 'none';
  /** 当前 cliId 的缺省投递方式；目前统一为 'send'。 */
  replyDeliveryDefault?: 'send' | 'transcript';
  /** 当前 cliId 是否有转写采集通道（claude-code / 结构化转写白名单）；false 时开关禁用。 */
  replyDeliverySupported?: boolean;
  regularGroupReplyMode?: string;
  regularGroupMentionMode?: string;
  substituteMode?: BotSubstituteMode | null;
  feedback?: FeedbackPolicyLayer | null;
  oncallGroup?: import('../../services/oncall-group-policy.js').OncallGroupPolicy | null;
  /** 管家（决策看板）配置；null / 缺省 = 未开启。 */
  steward?: import('../../core/decision-board/model.js').StewardConfig | null;
  /** Codex App 无进展提醒（#1162）。null = 默认（开启，90s）。 */
  noProgressNotify?: import('../../services/no-progress-notify-policy.js').NoProgressNotifyPolicy | null;
  /** Per-bot prompt-cache override; null/absent = inherit the global default. */
  promptCache?: import('../../services/prompt-cache-policy.js').PromptCacheConfig | null;
  docSubscribeDefaultMode?: string;
  maxLiveWorkers?: number | null;
  idleSuspendMinutes?: number | null;
  logicalSessionCount?: number;
  residentSessionCount?: number;
  dormantSessionCount?: number;
  sessionOwnerReminder?: {
    enabled: boolean;
    intervalMinutes: number;
    text: string;
    states: Array<'idle' | 'dormant' | 'pending_repo' | 'tui_prompt' | 'agent_attention' | 'limited'>;
  } | null;
  startupCommands?: string;
  customPassthroughCommands?: string;
  canTalkDaemonCommands?: string;
  launchShell?: string;
  env?: string;
  envKeys?: string[];
  envPolicy?: { mode: 'inherit' | 'strict'; inherit?: string[] };
  riff?: Record<string, unknown> | null;
  /** herdr 后端放置配置；null = 未配置（默认 botmux 宿主 + workspace 放置）。 */
  herdr?: import('../../adapters/backend/types.js').HerdrBackendConfig | null;
  /** 被动入群时自动把 owner 拉进群。缺省 ON —— 只有显式 false 表示关闭。 */
  autoInviteOwnerOnGroupAdd?: boolean;
  autoStartOnGroupJoin?: boolean;
  autoStartOnGroupJoinPrompt?: string;
  autoStartOnGroupJoinSeed?: string;
  /** 内置默认 seed 文案（按 bot locale），供留空时 placeholder 展示。 */
  autoStartOnGroupJoinSeedDefault?: string;
  groupJoinCommandEnabled?: boolean;
  groupJoinCommand?: string;
  autoStartOnNewTopic?: boolean;
  chatManagerEnabled?: boolean;
  autoStartExcludedChats?: string[];
  autoGrantRequestCards?: boolean;
  restrictGrantCommands?: boolean;
  p2pOpen?: boolean;
  grantRequestToOwnerDm?: boolean;
  trustSameOwnerBots?: boolean;
  grantDelegateBots?: string[];
  grantDefaultDurationMs?: number | null;
  messageQuotaDefaultLimit?: number | null;
  skillInjectionSupport?: 'dynamic' | 'global' | 'none' | string;
  skillInjection?: 'global' | 'prompt' | 'off' | null | string;
  skillInjectionDefault?: 'global' | 'prompt' | 'off' | string;
  displayName?: string | null;
  larkBotName?: string | null;
  teamRole?: string;
  teamRoleLoading?: boolean;
  error?: string;
};

export type LoadBotsResult = {
  bots: BotDefaultsRow[];
  error: string | null;
};

export const fallbackCliOptions: CliOption[] = [
  { id: 'claude-code', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'traex', label: 'TRAE CLI 2.0' },
];

export const fallbackCliOptionsState: CliOptionsState = {
  options: fallbackCliOptions,
  ttadkModelDefault: 'glm-5.1',
  ttadkModelSuggestions: [],
};

export function displayCliId(bot: Pick<BotDefaultsRow, 'cliId'> | null | undefined, sessionFallback: string): string {
  return typeof bot?.cliId === 'string' && bot.cliId ? bot.cliId : sessionFallback;
}

/** Fallback for old /api/bots payloads: infer from the bot's recent sessions. */
export function cliIdOf(appId: string): string {
  let best: any = null;
  for (const s of store.sessions.values()) {
    if (s.larkAppId !== appId || !s.cliId) continue;
    if (!best || Number(s.lastMessageAt ?? 0) > Number(best.lastMessageAt ?? 0)) best = s;
  }
  return best?.cliId ?? '';
}

export function agentSelectionKey(bot: BotDefaultsRow, sessionFallback: string): string {
  const explicit = typeof bot.agentSelectionKey === 'string' && bot.agentSelectionKey ? bot.agentSelectionKey : '';
  if (explicit) return explicit;
  const cli = displayCliId(bot, sessionFallback);
  return cli || 'claude-code';
}

export function selectedCliOption(options: CliOption[], key: string): CliOption | undefined {
  return options.find(o => o.id === key);
}

export function modelSuggestionsForOption(opt: CliOption | undefined, cliState: CliOptionsState): string[] {
  if (opt?.gateway === 'ttadk' && opt.acceptsModel !== false) return cliState.ttadkModelSuggestions;
  return [...(opt?.modelChoices ?? [])];
}

/**
 * live 探测非空时以 runtime 目录为准；缺失或空时回退 static。纯函数，供单测。
 */
export function mergeModelCandidates(
  staticChoices: readonly string[],
  detected: readonly string[] | null | undefined,
): string[] {
  const primary = detected && detected.length > 0 ? detected : staticChoices;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of primary) {
    if (typeof item !== 'string' || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 按需探测某个 CLI 当前可用的模型列表（live 成功时权威，失败时回退静态）。
 * fail-soft：任何错误（网络/404/400/形状异常）都返回 null，调用方回退静态候选。
 */
export async function fetchDetectedModels(
  key: string,
  appId?: string,
): Promise<{
  models: string[];
  source: 'live' | 'static';
  modelCapabilities?: ModelCapabilities[];
  reasoningEffortsByModel?: Record<string, string[]>;
} | null> {
  try {
    const query = new URLSearchParams({ key });
    if (appId) query.set('bot', appId);
    const r = await fetch(`/api/cli-options/models?${query.toString()}`);
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body || !Array.isArray(body.models)) return null;
    const models = body.models.filter((m: unknown): m is string => typeof m === 'string');
    const source: 'live' | 'static' = body.source === 'live' ? 'live' : 'static';
    const modelCapabilities = Array.isArray(body.modelCapabilities)
      ? body.modelCapabilities.flatMap((item: unknown) => {
          if (typeof item !== 'object' || item === null) return [];
          const { slug, serviceTiers, reasoningEfforts, contextWindow, contextVariants } = item as Record<string, unknown>;
          if (typeof slug !== 'string' || !Array.isArray(serviceTiers)) return [];
          const tiers = serviceTiers.filter((tier): tier is string => typeof tier === 'string');
          const variants = Array.isArray(contextVariants) ? contextVariants.flatMap(variant => {
            if (!variant || typeof variant !== 'object') return [];
            const { id, contextWindow: capacity, reasoningEfforts: efforts } = variant;
            if ((id !== 'standard' && id !== 'max') || !Number.isSafeInteger(capacity) || capacity <= 0) return [];
            return [{ id: id as 'standard' | 'max', contextWindow: capacity as number,
              ...(Array.isArray(efforts) ? { reasoningEfforts: efforts.filter((effort): effort is string => typeof effort === 'string') } : {}),
            }];
          }) : undefined;
          return [{ slug, serviceTiers: tiers,
            ...(Array.isArray(reasoningEfforts) ? { reasoningEfforts: reasoningEfforts.filter((effort): effort is string => typeof effort === 'string') } : {}),
            ...(Number.isSafeInteger(contextWindow) && (contextWindow as number) > 0 ? { contextWindow: contextWindow as number } : {}),
            ...(variants?.length ? { contextVariants: variants } : {}),
          }];
        })
      : undefined;
    const reasoningEffortsByModel = body.reasoningEffortsByModel
      && typeof body.reasoningEffortsByModel === 'object'
      ? Object.fromEntries(Object.entries(body.reasoningEffortsByModel)
        .filter(([, levels]) => Array.isArray(levels))
        .map(([model, levels]) => [model, (levels as unknown[])
          .filter((level): level is string => typeof level === 'string')]))
      : undefined;
    return {
      models,
      source,
      ...(modelCapabilities ? { modelCapabilities } : {}),
      ...(reasoningEffortsByModel ? { reasoningEffortsByModel } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch the list of available DSH profiles from the daemon.
 * Returns an empty array on any error.
 */
export async function fetchDshProfiles(): Promise<string[]> {
  try {
    const r = await fetch('/api/dsh/profiles');
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(body.profiles)) return [];
    return body.profiles.filter((p: unknown): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}

/**
 * Create a new DSH profile with the botmux default base plugins.
 * Returns the created profile name, or null on error.
 */
export async function createDshProfile(name: string): Promise<string | null> {
  try {
    const r = await fetch('/api/dsh/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || typeof body.name !== 'string') return null;
    return body.name;
  } catch {
    return null;
  }
}

/**
 * Latest-wins guard for overlapping async refreshes. The Bot 配置 page fires an
 * initial refresh on mount and another on every `bots.changed` SSE event; these
 * can overlap, and a slow earlier `/api/bots` response arriving *after* a newer
 * one ("后发先回") would otherwise clobber the fresher roster and re-hide a
 * just-added bot. Each call bumps a monotonic counter and hands back a `commit`
 * predicate that is only true while this call is still the newest — the caller
 * gates BOTH its state write and its `loading=false` on it. Kept as a tiny
 * pure factory so the race is unit-testable without a DOM.
 */
export function createRefreshGate(): { begin(): { commit(): boolean } } {
  let latest = 0;
  return {
    begin() {
      const seq = ++latest;
      return { commit: () => seq === latest };
    },
  };
}

/**
 * 「每个 key 只放行一次」闸门，给延迟加载的重型请求用。
 *
 * 场景：反馈设置区块需要 `memberBots`（只有 12.7MB 的完整矩阵有），而各 tab 是
 * 用 `hidden` 隐藏而非条件卸载 —— 组件在任何 tab 下都 mount。把「是否激活」
 * 加进 effect 依赖能避免未打开就拉，但副作用是**每次切回该 tab 都重跑**
 * （cards → 别的 tab → 隔几秒回 cards，groups-api 的 3s 缓存已过期 ⟹ 又下载
 * 12.7MB）。原语义是「每次 mount / 每个 botId 一次」，延迟加载不该把它放宽成
 * 「每次回 tab 都拉」。
 *
 * `claim(key)` 只在该 key 尚未被认领时返回 true；`release(key)` 撤销认领，供
 * 失败路径调用 —— 否则一次网络抖动会让该 bot 的列表永久空着。
 *
 * 注：当前调用点（`BotDefaultsCard` 带 `key={larkAppId:...}`）在切换 bot 时会
 * 整体 remount，闸门随之新建，所以实际吃到的只有「同一 bot 二次激活」这一条；
 * 按 key 而非布尔来记，是为了让「换 bot 必须重拉」在**不依赖父级 remount**时
 * 也成立 —— 这条不变量不该悄悄挂在别处的 `key` 拼法上。
 *
 * 与 {@link createRefreshGate} 一样保持为纯工厂，好让「二次激活不重拉」不必起
 * DOM 就能单测（仓库无 React 组件测试设施）。
 */
export function createOncePerKeyGate(): {
  claim(key: string): boolean;
  release(key: string): void;
  claimed(key: string): boolean;
} {
  let current: string | null = null;
  return {
    claim(key) {
      if (current === key) return false;
      current = key;
      return true;
    },
    release(key) {
      if (current === key) current = null;
    },
    claimed: key => current === key,
  };
}

export async function fetchBotDefaults(): Promise<LoadBotsResult> {
  try {
    const r = await fetch('/api/bots');
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const error = body?.error
        ? `HTTP ${r.status}: ${body.error}${body.path ? ` (${body.path})` : ''}`
        : `HTTP ${r.status}`;
      return { bots: [], error };
    }
    if (!body || !Array.isArray(body.bots)) {
      return { bots: [], error: 'unexpected response shape (no `bots` array)' };
    }
    return { bots: body.bots as BotDefaultsRow[], error: null };
  } catch (e: any) {
    return { bots: [], error: e?.message ?? String(e) };
  }
}

export type SubstituteTargetResolution = {
  input?: string;
  ok?: boolean;
  openId?: string;
  name?: string;
  avatarUrl?: string;
  reason?: 'cross_app_open_id' | 'not_visible' | 'resolve_failed' | 'unresolvable';
};

export async function resolveSubstituteTarget(
  larkAppId: string,
  target: BotSubstituteTarget,
): Promise<{ ok: false; error: string } | { ok: true; resolution: SubstituteTargetResolution }> {
  try {
    const r = await fetch(`/api/bots/${encodeURIComponent(larkAppId)}/substitute-targets/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: body?.error ? `HTTP ${r.status}: ${body.error}` : `HTTP ${r.status}` };
    }
    return { ok: true, resolution: body?.resolution ?? {} };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Machine-wide prompt-cache default from GET /api/settings; null when unset
 *  or unreadable (the bot section then resolves against built-in defaults). */
export async function fetchGlobalPromptCache(): Promise<import('../../services/prompt-cache-policy.js').PromptCacheConfig | null> {
  try {
    const r = await fetch('/api/settings');
    if (!r.ok) return null;
    const body = await r.json().catch(() => ({}));
    const { readPromptCacheConfig } = await import('../../services/prompt-cache-policy.js');
    return readPromptCacheConfig(body?.settings?.promptCache) ?? null;
  } catch {
    return null;
  }
}

/** Machine-wide reply-card footer brand switch from GET /api/settings.
 *  Fail-OPEN: any fetch/shape error returns true (per-bot editing stays usable)
 *  rather than wrongly greying the field — the server is the enforcement point
 *  anyway, this flag only drives the disabled UI state. */
export async function fetchCardBrandLabelEnabled(): Promise<boolean> {
  try {
    const r = await fetch('/api/settings');
    if (!r.ok) return true;
    const body = await r.json().catch(() => ({}));
    // Present even for tokenless public-readOnly visitors (not redacted).
    return body?.settings?.cardBrandLabel !== false;
  } catch {
    return true;
  }
}

export async function fetchCliOptions(): Promise<CliOptionsState> {
  try {
    // `?probe=none` 显式跳过开放平台登录态探测（一趟 1-4s 的实时飞书往返）。
    // 本页的 CliOptionsState 不含 webSession 字段，付了钱也拿不到手。
    //
    // 之所以是「本页 opt-out」而不是「服务端默认不探测」：路由 chunk 带
    // immutable 长缓存，dashboard 重启后已加载的旧 chunk 仍会请求裸端点；裸端点
    // 一旦默认不探测，旧 chunk 会把「字段缺席」判成未登录、把用户推去扫码。
    // 详见 dashboard.ts 里 /api/cli-options 的注释。
    const r = await fetch('/api/cli-options?probe=none');
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(body?.options)) return fallbackCliOptionsState;
    const options: CliOption[] = body.options
      .filter((o: any) => o && typeof o.id === 'string' && typeof o.label === 'string')
      .map((o: any) => ({
        ...o,
        // 容错：缺失/非数组 → []，候选合并走 mergeModelCandidates。
        modelChoices: Array.isArray(o.modelChoices)
          ? o.modelChoices.filter((m: unknown): m is string => typeof m === 'string')
          : [],
      }));
    const ttadkModelDefault = typeof body.ttadkModelDefault === 'string' && body.ttadkModelDefault.trim()
      ? body.ttadkModelDefault.trim()
      : fallbackCliOptionsState.ttadkModelDefault;
    const ttadkModelSuggestions = Array.isArray(body.ttadkModelSuggestions)
      ? body.ttadkModelSuggestions.filter((s: unknown): s is string => typeof s === 'string')
      : [];
    return {
      options: options.length ? options : fallbackCliOptions,
      ttadkModelDefault,
      ttadkModelSuggestions,
    };
  } catch {
    return fallbackCliOptionsState;
  }
}

export function fmtSince(since: number): string {
  if (!since) return '—';
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}
