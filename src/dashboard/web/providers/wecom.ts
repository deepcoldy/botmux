// 企业微信：本机网关接入的原生平台，`provider: 'wecom'` 的行归它。
// 会话操作一律要服务端逐项声明；Bot 配置页只出现网关真正能落盘的区块与配置项。
import {
  SESSION_CAPABILITIES,
  type CardBehaviorField,
  type ProfileContext,
  type ProviderCopy,
  type ProviderDescriptor,
  type SessionCapabilitySet,
} from './types.js';
import type { StreamingCardButtonId } from '../../../im/lark/streaming-card-buttons.js';

const WECOM_BOT_KEY_PREFIX = 'wecom:';

/** 新平台不继承飞书的默认能力：服务端没声明的操作一律不支持。 */
const WECOM_SESSION_DEFAULTS: SessionCapabilitySet = Object.fromEntries(
  SESSION_CAPABILITIES.map(capability => [capability, false]),
) as SessionCapabilitySet;

/**
 * 企业微信 Bot 配置页出现的区块。`network-policy`、`codex-runtime` 是挂在别的格子里的区块
 * （`BOT_DEFAULTS_SECTIONS` 里登记了 `tile`：分别在沙盒格子、Codex 显示格子里），深链按宿主格子落点。
 * `wecom-*` 是企业微信专属格子（登记表里标了 `provider: 'wecom'`，id 的拼法见 wecomNativeSectionId）：
 * 会话页「/summary 总结范围」、安全页「授权与额度」、卡片页的可操作终端开关、高级页「额度耗尽交接」；
 * `wecom-talk-commands`（对话权限用户可用的命令）是合放在共用「Slash 命令」格里的企业微信专属区块。
 */
const WECOM_PROFILE_SECTIONS = [
  'agent', 'working-dir', 'role', 'session-mode', 'command-trigger',
  'session-cap', 'codex-archive', 'prompt-cache', 'startup-commands',
  'sandbox', 'sandbox-paths', 'codex-auth', 'blocked-users', 'backend',
  'prompt-injection', 'runtime-env', 'codex-app-display',
  'codex-runtime', 'network-policy', 'herdr', 'card-behavior', 'feedback',
  'brand', 'slash-commands', 'local-address', 'sender-tag',
  'long-task-reminder', 'owner-reminder',
  'wecom-platform-sessions', 'wecom-core-security', 'wecom-core-cards', 'wecom-core-advanced',
  'wecom-talk-commands',
] as const;

/** 企业微信回复卡片支持的卡片偏好；没有表情回应、原生思考气泡、置顶、私密卡片和可写链接。 */
const WECOM_CARD_FIELDS: readonly CardBehaviorField[] = [
  'goalStatusCard', 'disableStreamingCard', 'replyCardMode', 'showReplyTiming', 'usageDisplay',
  'replyFooterEnabled', 'replyFooterBrand', 'replyFooterModel', 'replyFooterUsage',
  'replyFooterRecipients', 'replyCardActions', 'cotEnabled', 'replyCardShowTools',
];

/** 逐个列出而不是「全部」：飞书以后新增的按钮不会自动出现在企业微信页上。企业微信卡片没有代答按钮。 */
const WECOM_CARD_BUTTONS: readonly StreamingCardButtonId[] = [
  'stop', 'close', 'output', 'terminal', 'writeLink', 'compact',
];

const WECOM_COPY: ProviderCopy = {
  replyCardModeHelp: 'botDefaults.wecom.replyCardModeHelp',
  replyUnifiedDescription: 'botDefaults.wecom.replyUnifiedDescription',
  replySplitDescription: 'botDefaults.wecom.replySplitDescription',
  autoStreamingTitle: 'botDefaults.wecom.autoStreaming',
  autoStreamingDescription: 'botDefaults.wecom.autoStreamingDescription',
  autoStreamingHelp: 'botDefaults.wecom.autoStreamingHelp',
  goalStatusDescription: 'botDefaults.wecom.goalStatusDescription',
  goalStatusHelp: 'botDefaults.wecom.goalStatusHelp',
  processDescriptionLegacy: 'botDefaults.wecom.processDescription',
  processDescriptionUnified: 'botDefaults.wecom.processDescription',
  processHelpLegacy: 'botDefaults.wecom.processHelp',
  processHelpUnified: 'botDefaults.wecom.processHelp',
  toolsDescription: 'botDefaults.wecom.toolsDescription',
  toolsHelpLegacy: 'botDefaults.wecom.toolsHelp',
  toolsHelpUnified: 'botDefaults.wecom.toolsHelp',
  cardControlsHelp: 'botDefaults.wecom.cardControlsHelp',
  footerHelp: 'botDefaults.wecom.footerHelp',
  footerRecipientsTitle: 'botDefaults.wecom.footerRecipients',
  footerModelTitle: 'botDefaults.wecom.footerModel',
  cardActionsDescription: 'botDefaults.wecom.cardActionsDescription',
  cardActionsHelp: 'botDefaults.wecom.cardActionsHelp',
  quietPresetDescription: 'quietPreset.wecomDescription',
  quietPresetSecondEffect: 'quietPreset.wecomToolsOff',
  longTaskReminderHelp: 'botDefaults.wecom.longTaskReminderHelp',
  ownerReminderHelp: 'botDefaults.wecom.ownerReminderHelp',
  ownerReminderEnabledHelp: 'botDefaults.wecom.ownerReminderEnabledHelp',
  ownerReminderPendingRepoState: 'botDefaults.wecom.pendingRepoState',
  noProgressHelp: 'botDefaults.wecom.noProgressHelp',
  cliProgressHelp: 'botDefaults.wecom.noProgressHelp',
  noProgressResetCodexApp: 'botDefaults.wecom.noProgressResetOn',
  noProgressResetCli: 'botDefaults.wecom.noProgressResetOff',
  noProgressTimeoutHelpCodexApp: 'botDefaults.wecom.noProgressTimeoutHelp',
  noProgressTimeoutHelpCli: 'botDefaults.wecom.noProgressTimeoutHelp',
  senderTagNote: 'botDefaults.wecom.senderTagNote',
  commandTriggerTitle: 'botDefaults.wecom.commandTriggerTitle',
  commandTriggerEnabled: 'botDefaults.wecom.commandTriggerEnabled',
  commandTriggerEnabledHelp: 'botDefaults.wecom.commandTriggerEnabledHelp',
  commandTriggerPromptHelp: 'botDefaults.wecom.commandTriggerPromptHelp',
  commandTriggerChatsPlaceholder: 'botDefaults.wecom.commandTriggerChatsPlaceholder',
  commandTriggerSave: 'botDefaults.wecom.commandTriggerSave',
  envMaskedNote: 'sessionEnv.wecomMaskedNote',
  accessTitle: 'botDefaults.wecom.accessTitle',
  regularGroupModeTitle: 'botDefaults.wecom.groupModeLabel',
  roleHelp: 'botDefaults.wecom.roleHelp',
  roleInjectModeHint: 'botDefaults.wecom.roleInjectModeHint',
};

export const wecomProvider: ProviderDescriptor = {
  id: 'wecom',
  nameKey: 'provider.wecom',
  botKey: row => `${WECOM_BOT_KEY_PREFIX}${String(row.providerBotId ?? '')}`,
  botKeyPrefix: WECOM_BOT_KEY_PREFIX,
  session: { defaults: WECOM_SESSION_DEFAULTS, controlledWrites: true },
  // 群组页与「创建会话」都是飞书专属流程。
  deployment: { groupsNavigation: false, createSession: false },
  profile: {
    supportedSections: WECOM_PROFILE_SECTIONS,
    fieldRules: {
      // 企业微信的会话模式是一张单独的表单：私聊那一组沿用飞书的组标题；普通群是一个下拉框，标题按文案表的
      // regularGroupModeTitle 换成企业微信的「群会话方式」。
      'session-mode': { only: ['botDefaults.groupP2p', 'botDefaults.groupRegular'] },
      'slash-commands': { only: ['botDefaults.customPassthrough'] },
      'sender-tag': { hidden: ['botDefaults.senderTagHideEmail'] },
      role: { hidden: ['botDefaults.profileRoles'] },
    },
    ownFormSections: ['session-mode'],
    cardFields: WECOM_CARD_FIELDS,
    cardButtons: WECOM_CARD_BUTTONS,
    quietPreset: 'tools',
    ownerReminderStates: 'declared',
    modelPins: false,
    codexConfigInfo: false,
    feedbackChatOverrides: false,
    feedbackExtensions: false,
  },
  // 配置只读（外部 core）时整页只剩运行状态（专属格子也不出现）；启停只在交给 fleet 运行（或尚无人运行）的连接上出现。
  profileAccess: ({ editable, lifecycle }: ProfileContext) => ({
    rename: editable,
    // 页头的管理后台链接：企业微信是固定的通用入口（见 wecom-bot-defaults-card）。
    console: true,
    avatar: false,
    description: false,
    agent: editable,
    agentExtended: editable,
    workingDirectory: editable,
    workingDirectoryModes: false,
    worktree: editable,
    autoStart: false,
    backendExtended: editable,
    role: editable,
    sessions: editable,
    security: editable,
    cards: editable,
    backend: editable,
    advancedOther: editable,
    runtimeStatus: true,
    lifecycle,
    platformSections: editable,
  }),
  copy: WECOM_COPY,
};
