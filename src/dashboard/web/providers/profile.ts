// Bot 配置页「出现什么」的判定：页签、区块、区块内配置项、卡片字段与按钮。
// 配置页（飞书卡片、企业微信卡片）和 ⌘K 命令面板的配置索引调用同一组函数、读同一张
// descriptor 表，所以命令面板能搜到的区块，页面上就有落点。
import type { StreamingCardButtonId } from '../../../im/lark/streaming-card-buttons.js';
import { providerDescriptor } from './registry.js';
import type {
  BotProfileCapabilities,
  BotProfileTab,
  CardBehaviorField,
  ProfileContext,
  ProviderId,
  ProviderKind,
} from './types.js';

/** 命令面板按「能配的都列出」建索引：可编辑、可启停。 */
const FULL_ACCESS: ProfileContext = { editable: true, lifecycle: true };

export function botProfileCapabilities(kind: ProviderKind, context: ProfileContext = FULL_ACCESS): BotProfileCapabilities {
  const descriptor = providerDescriptor(kind);
  return { provider: descriptor.id, ...descriptor.profile, ...descriptor.profileAccess(context) };
}

export function botProfileTabs(caps: BotProfileCapabilities): BotProfileTab[] {
  return [
    ...(caps.agent || caps.workingDirectory || caps.role ? ['common' as const] : []),
    ...(caps.sessions ? ['sessions' as const] : []),
    ...(caps.security ? ['security' as const] : []),
    ...(caps.cards ? ['cards' as const] : []),
    ...(caps.backend || caps.advancedOther || caps.runtimeStatus ? ['advanced' as const] : []),
  ];
}

export function botProfileSectionSupported(
  caps: BotProfileCapabilities,
  section: { id: string; tab: string; provider?: ProviderId },
): boolean {
  if (caps.supportedSections && !caps.supportedSections.includes(section.id)) return false;
  // 平台专属区块只在登记的那个平台、且它的专属格子开放时出现，不走下面按分类的通用开关。
  if (section.provider) return section.provider === caps.provider && caps.platformSections;
  if (section.id === 'agent') return caps.agent;
  if (section.id === 'working-dir') return caps.workingDirectory;
  if (section.id === 'role') return caps.role;
  if (section.id === 'backend') return caps.backend;
  if (section.tab === 'sessions') return caps.sessions;
  if (section.tab === 'security') return caps.security;
  if (section.tab === 'cards') return caps.cards;
  if (section.tab === 'advanced') return caps.advancedOther;
  return false;
}

/**
 * 这个区块在这个平台的配置页上是不是平台自己的：标了这个平台的专属区块，或这个平台用自己的表单渲染的
 * 共用区块（ownFormSections，如企业微信的会话模式）。混合部署时 ⌘K 只为另一个平台另列这些。
 */
export function botProfileOwnSection(
  caps: BotProfileCapabilities,
  section: { id: string; provider?: ProviderId },
): boolean {
  if (section.provider) return section.provider === caps.provider;
  return caps.ownFormSections?.includes(section.id) ?? false;
}

/**
 * 卡片偏好字段 → 页面上显示它的配置项键（命令面板的 fieldKeys）。一个键对应多个字段时，
 * 任一字段可用即可：「过程」开关的标题随卡片形态在 cotEnabled / replyCardTools 之间切换，
 * 统一卡片下的原生思考气泡开关借用 cotEnabled 的标题。
 */
export const CARD_BEHAVIOR_FIELD_LABEL_KEYS: Readonly<Record<CardBehaviorField, readonly string[]>> = {
  replyCardMode: ['botDefaults.replyCardMode'],
  disableStreamingCard: ['botDefaults.autoStreaming'],
  silentTurnReactions: ['botDefaults.silentTurnReactions'],
  goalStatusCard: ['botDefaults.goalStatusCard'],
  cotEnabled: ['botDefaults.cotEnabled', 'botDefaults.replyCardTools'],
  replyCardShowTools: ['botDefaults.replyCardShowTools'],
  replyCardNativeCot: ['botDefaults.cotEnabled'],
  pinStreamingCard: ['botDefaults.pinStreamingCard'],
  replyFooterEnabled: ['botDefaults.replyFooterEnabled'],
  replyFooterBrand: ['botDefaults.replyFooterBrand'],
  replyFooterModel: ['botDefaults.replyFooterModel'],
  replyFooterUsage: ['botDefaults.replyFooterUsage'],
  replyFooterRecipients: ['botDefaults.replyFooterRecipients'],
  replyFooterVoice: ['botDefaults.replyFooterVoice'],
  showReplyTiming: ['botDefaults.footerTiming'],
  usageDisplay: ['botDefaults.usageDisplay'],
  writableTerminalLinkInCard: ['botDefaults.writableLink'],
  replyCardActions: ['botDefaults.replyCardActions'],
  privateCard: ['botDefaults.privateCard'],
};

const STREAMING_BUTTON_KEY_PREFIX = 'botDefaults.streamingButton.';
const QUIET_PRESET_KEY_PREFIX = 'quietPreset.';

export function cardFieldSupported(caps: Pick<BotProfileCapabilities, 'cardFields'>, field: CardBehaviorField): boolean {
  return !caps.cardFields || caps.cardFields.includes(field);
}

export function cardButtonSupported(caps: Pick<BotProfileCapabilities, 'cardButtons'>, button: StreamingCardButtonId): boolean {
  return !caps.cardButtons || caps.cardButtons.includes(button);
}

function cardBehaviorKeySupported(caps: BotProfileCapabilities, key: string): boolean {
  if (key.startsWith(QUIET_PRESET_KEY_PREFIX)) return caps.quietPreset !== null;
  if (key.startsWith(STREAMING_BUTTON_KEY_PREFIX)) {
    const button = key.slice(STREAMING_BUTTON_KEY_PREFIX.length) as StreamingCardButtonId;
    return cardButtonSupported(caps, button);
  }
  const fields = (Object.keys(CARD_BEHAVIOR_FIELD_LABEL_KEYS) as CardBehaviorField[])
    .filter(field => CARD_BEHAVIOR_FIELD_LABEL_KEYS[field].includes(key));
  // 没映射到任何卡片字段的键只在卡片字段不受限时出现。
  if (fields.length === 0) return !caps.cardFields;
  return fields.some(field => cardFieldSupported(caps, field));
}

/** 区块里的某个配置项（按 i18n 键）是否出现。 */
export function botProfileFieldSupported(
  caps: BotProfileCapabilities,
  section: string,
  key: string,
): boolean {
  const rule = caps.fieldRules?.[section];
  if (rule) {
    if ('only' in rule) return rule.only.includes(key);
    if (rule.hidden.includes(key)) return false;
  }
  if (section === 'card-behavior') return cardBehaviorKeySupported(caps, key);
  if (section === 'agent' && !caps.agentExtended) {
    return ['botDefaults.agentCli', 'botDefaults.agentModel'].includes(key);
  }
  if (section === 'working-dir' && !caps.workingDirectoryModes) {
    return [
      'botDefaults.groupWorkingDir', 'botDefaults.workingDirField',
      ...(caps.worktree ? ['botDefaults.autoWorktree'] : []),
    ].includes(key);
  }
  if (!caps.worktree && key === 'botDefaults.autoWorktree') return false;
  return true;
}

/**
 * 共享区块的能力 props（`supportsXxx` 等）只在这里由能力表推导；两张卡片原样展开，
 * 调用点不再各写字面量。能对上命令面板配置项的，直接问 {@link botProfileFieldSupported}。
 */
export function botProfileSectionProps(caps: BotProfileCapabilities) {
  return {
    agent: {
      commonOnly: !caps.agentExtended,
      supportsModelPins: caps.modelPins,
    },
    role: {
      supportsProfileRoles: botProfileFieldSupported(caps, 'role', 'botDefaults.profileRoles'),
    },
    codexAuth: {
      supportsConfigInfo: caps.codexConfigInfo,
    },
    slashCommands: {
      supportsNative: botProfileFieldSupported(caps, 'slash-commands', 'botDefaults.nativeSlashTitle'),
      supportsTalkOnly: botProfileFieldSupported(caps, 'slash-commands', 'botDefaults.canTalkDaemon'),
      supportsBareRename: botProfileFieldSupported(caps, 'slash-commands', 'botDefaults.bareRenamePassthrough'),
    },
    senderTag: {
      supportsHideEmail: botProfileFieldSupported(caps, 'sender-tag', 'botDefaults.senderTagHideEmail'),
    },
    feedback: {
      supportsChatOverrides: caps.feedbackChatOverrides,
      supportsExtensions: caps.feedbackExtensions,
    },
    cardBehavior: {
      supportedFields: caps.cardFields,
      supportedButtons: caps.cardButtons,
    },
    backend: {
      supportedValues: caps.backendExtended ? undefined : ['pty', 'tmux'] as const,
    },
  };
}
