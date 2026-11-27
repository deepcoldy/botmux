// Dashboard 前端的 provider（IM 平台）注册表类型。
//
// 「这一行 / 这个机器人属于哪个平台、支持什么」只在 providers/ 里回答一次：会话行能做哪些操作、
// Bot 配置页出现哪些页签 / 区块 / 配置项 / 按钮、按平台切换的文案键，都由各平台的
// descriptor 声明，页面与 ⌘K 命令面板读同一份。
import type { StreamingCardButtonId } from '../../../im/lark/streaming-card-buttons.js';

export type ProviderId = 'lark' | 'wecom';

/**
 * `providerOf()` 的结果：认得的平台，或显式的「未知」。未知平台不授予任何可选能力；
 * 身份键和文案沿用飞书的旧形态，与改造前对未知值的处理一致。
 */
export type ProviderKind = ProviderId | 'unknown';

/** 会话行上的一项操作。服务端下发 `capabilities` 时以它为准，缺失时用 descriptor 的默认值。 */
export const SESSION_CAPABILITIES = [
  'suspend', 'input', 'archive', 'delete', 'history', 'insight', 'terminal', 'takeover',
  'interrupt', 'restart', 'close', 'resume', 'rename', 'board', 'lock', 'locate',
  'spawnCommand', 'environment', 'start', 'monitorRoom', 'modelPin',
] as const;
export type SessionCapability = typeof SESSION_CAPABILITIES[number];
export type SessionCapabilitySet = Readonly<Record<SessionCapability, boolean>>;

/** Bot 配置页的页签（与 `BotDefaultsTab` 相同，这里不引 bot-defaults 以免把整页模块拖进注册表）。 */
export type BotProfileTab = 'common' | 'sessions' | 'security' | 'cards' | 'advanced';

/** 部署级入口：只看「部署里有哪些平台的机器人」，与具体某一行无关。 */
export interface ProviderDeploymentCapabilities {
  /** 导航里的「群组」页（飞书群）。 */
  groupsNavigation: boolean;
  /** 「创建会话」入口（侧栏、会话页、⌘K）。 */
  createSession: boolean;
}

/**
 * Bot 配置页「卡片」区块里的卡片偏好字段，名字与 card-prefs 的数据字段一致。
 * 页面按它决定显示哪些开关，命令面板经 {@link CARD_BEHAVIOR_FIELD_LABEL_KEYS} 换成配置项键。
 */
export type CardBehaviorField =
  | 'replyCardMode' | 'disableStreamingCard' | 'silentTurnReactions' | 'goalStatusCard'
  | 'cotEnabled' | 'replyCardShowTools' | 'replyCardNativeCot' | 'pinStreamingCard'
  | 'replyFooterEnabled' | 'replyFooterBrand' | 'replyFooterModel' | 'replyFooterUsage'
  | 'replyFooterRecipients' | 'replyFooterVoice' | 'showReplyTiming' | 'usageDisplay'
  | 'writableTerminalLinkInCard' | 'replyCardActions' | 'privateCard';

/** 区块内配置项（按 i18n 键）的收窄：`only` 只留这些，`hidden` 去掉这些。 */
export type ProfileFieldRule =
  | { readonly only: readonly string[] }
  | { readonly hidden: readonly string[] };

/**
 * 「静默模式」一键预设写哪几项：
 * - `reactions`：关卡内与原生思考过程、开静默表情回应、关流式卡（飞书）；
 * - `tools`：关思考过程与工具过程、关流式卡（企业微信没有表情回应和原生思考气泡）。
 */
export type QuietPresetKind = 'reactions' | 'tools';

/** 只由平台决定、与访问上下文无关的 Bot 配置页形态。 */
export interface ProviderProfile {
  /** 允许出现的区块 id（`BOT_DEFAULTS_SECTIONS` 的 id）；缺省表示不按 id 收窄。 */
  supportedSections?: readonly string[];
  /** 区块 id → 区块内配置项的收窄；没登记的区块不收窄。 */
  fieldRules?: Readonly<Record<string, ProfileFieldRule>>;
  /**
   * 共用区块里，这个平台的配置页用自己的表单渲染的那些（区块 id，如企业微信的会话模式）。混合部署时
   * ⌘K 把它们和平台专属区块一起按平台另列，落到这个平台的机器人上。
   */
  ownFormSections?: readonly string[];
  /** 卡片区块可出现的卡片偏好字段；缺省表示全部。 */
  cardFields?: readonly CardBehaviorField[];
  /** 卡片区块可出现的流式卡片按钮；缺省表示全部。 */
  cardButtons?: readonly StreamingCardButtonId[];
  /** 「静默模式」预设；null 表示不提供。 */
  quietPreset: QuietPresetKind | null;
  /** 会话负责人提醒可勾选的状态：all = 全部；declared = 只列配置里声明的。 */
  ownerReminderStates: 'all' | 'declared';
  /** Agent 区块里的模型固定摘要。 */
  modelPins: boolean;
  /** Codex 认证区块里的隔离配置说明。 */
  codexConfigInfo: boolean;
  /** 反馈区块里的按聊天覆盖。 */
  feedbackChatOverrides: boolean;
  /** 反馈区块里的扩展面板。 */
  feedbackExtensions: boolean;
}

/** 企业微信的 Bot 配置还取决于访问上下文：配置是否可编辑、能否在 Dashboard 启停。 */
export interface ProfileContext {
  editable: boolean;
  lifecycle: boolean;
}

/** 由访问上下文决定的页签 / 区块开关。 */
export interface ProfileAccess {
  rename: boolean;
  console: boolean;
  avatar: boolean;
  description: boolean;
  agent: boolean;
  agentExtended: boolean;
  workingDirectory: boolean;
  workingDirectoryModes: boolean;
  worktree: boolean;
  autoStart: boolean;
  backendExtended: boolean;
  role: boolean;
  sessions: boolean;
  security: boolean;
  cards: boolean;
  backend: boolean;
  advancedOther: boolean;
  runtimeStatus: boolean;
  lifecycle: boolean;
  /**
   * 这个平台的专属格子（`BOT_DEFAULTS_SECTIONS` 里标了 `provider` 的区块，如企业微信的本地核心策略）
   * 是否出现；只对标的正是这个平台的区块起作用。
   */
  platformSections: boolean;
}

export type BotProfileCapabilities = ProviderProfile & ProfileAccess & {
  /** 能力表属于哪个平台：标了专属平台的区块只对那个平台出现。 */
  readonly provider: ProviderKind;
};

/**
 * 共享组件里随平台切换的文案：槽位 → i18n 键。飞书的键就是企业微信接入前组件里写死的那个，
 * 所以飞书渲染结果逐字不变。名字带 Legacy / Unified、CodexApp / Cli 的槽位对应组件里
 * 原本按卡片形态或 CLI 再分的两支。
 */
export interface ProviderCopy {
  replyCardModeHelp: string;
  replyUnifiedDescription: string;
  replySplitDescription: string;
  autoStreamingTitle: string;
  autoStreamingDescription: string;
  autoStreamingHelp: string;
  goalStatusDescription: string;
  goalStatusHelp: string;
  processDescriptionLegacy: string;
  processDescriptionUnified: string;
  processHelpLegacy: string;
  processHelpUnified: string;
  toolsDescription: string;
  toolsHelpLegacy: string;
  toolsHelpUnified: string;
  cardControlsHelp: string;
  footerHelp: string;
  footerRecipientsTitle: string;
  footerModelTitle: string;
  cardActionsDescription: string;
  cardActionsHelp: string;
  quietPresetDescription: string;
  /** 预设详情列表的第二条（飞书：静默表情；企业微信：关工具过程）。 */
  quietPresetSecondEffect: string;
  longTaskReminderHelp: string;
  ownerReminderHelp: string;
  ownerReminderEnabledHelp: string;
  ownerReminderPendingRepoState: string;
  noProgressHelp: string;
  cliProgressHelp: string;
  noProgressResetCodexApp: string;
  noProgressResetCli: string;
  /** 带 `{seconds}` 参数调用；不含占位符的键忽略它。 */
  noProgressTimeoutHelpCodexApp: string;
  noProgressTimeoutHelpCli: string;
  senderTagNote: string;
  commandTriggerTitle: string;
  commandTriggerEnabled: string;
  commandTriggerEnabledHelp: string;
  commandTriggerPromptHelp: string;
  commandTriggerChatsPlaceholder: string;
  commandTriggerSave: string;
  /** 机器人环境变量编辑器里「看不到值」的说明。 */
  envMaskedNote: string;
  /** 「黑名单」格子的标题（企业微信的这个格子同时管允许名单）。 */
  accessTitle: string;
  /** 会话模式里普通群那一项的标题（企业微信是一个下拉框：群会话方式）。 */
  regularGroupModeTitle: string;
  /** 「默认角色」区块标题旁的说明（作用范围、按聊天覆盖）。 */
  roleHelp: string;
  /** 角色「注入方式」的说明（「仅一次」在什么时候注入）。 */
  roleInjectModeHint: string;
}

/**
 * 文案表里替换「可见标签」（区块标题、配置项标题）的槽位。⌘K 条目与深链都按飞书标签键登记；
 * 只有企业微信的部署里 ⌘K 标题、以及深链落到别的平台的配置页时找那一行，都按这些槽位把标签键
 * 换成那个平台页面上实际显示的键。
 */
export const PROVIDER_LABEL_SLOTS = [
  'autoStreamingTitle', 'footerRecipientsTitle', 'footerModelTitle',
  'commandTriggerTitle', 'commandTriggerEnabled', 'accessTitle', 'regularGroupModeTitle',
] as const satisfies ReadonlyArray<keyof ProviderCopy>;

export interface ProviderDescriptor {
  readonly id: ProviderKind;
  /** 平台名称的 i18n 键（界面上标注平台时用，如混合部署里 ⌘K 条目的「企业微信 · …」）；未知平台没有。 */
  readonly nameKey?: string;
  /** 机器人在前端的身份键：会话筛选、总览卡片、配置页的 `/api/bots/:key` 都用它。 */
  botKey(row: ProviderRow): string;
  /** 身份键的前缀；空串表示没有前缀（飞书直接用 appId）。 */
  readonly botKeyPrefix: string;
  readonly session: {
    /** 会话行没带服务端 `capabilities`（或没列某一项）时的默认值。 */
    readonly defaults: SessionCapabilitySet;
    /** 会话写操作走本机受控通道：带控制 CSRF 头和 `expectedGeneration`。 */
    readonly controlledWrites: boolean;
  };
  readonly deployment: ProviderDeploymentCapabilities;
  readonly profile: ProviderProfile;
  profileAccess(context: ProfileContext): ProfileAccess;
  readonly copy: ProviderCopy;
}

/** 注册表只读这几个字段；会话行、Bot 配置行、总览卡片都满足。 */
export type ProviderRow = {
  provider?: unknown;
  providerBotId?: unknown;
  larkAppId?: unknown;
} & Record<string, any>;
