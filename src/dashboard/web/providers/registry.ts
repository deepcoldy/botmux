// provider 判别只写在这里：一行数据属于哪个平台、该用哪个 descriptor。
// 其它模块需要「是不是企业微信」「支不支持某操作」「身份键是什么」时都经这里问。
import { controlCsrfHeaders } from '../control-csrf.js';
import { LARK_COPY, larkProvider } from './lark.js';
import { wecomProvider } from './wecom.js';
import {
  PROVIDER_LABEL_SLOTS,
  SESSION_CAPABILITIES,
  type ProfileAccess,
  type ProviderCopy,
  type ProviderDescriptor,
  type ProviderId,
  type ProviderKind,
  type ProviderProfile,
  type ProviderRow,
  type SessionCapability,
  type SessionCapabilitySet,
} from './types.js';

/** 任意一行数据（会话行、Bot 配置行、总览卡片）；只读其中的 `provider` 等字段。 */
type ProviderInput = Record<string, any> | null | undefined;

const PROVIDERS: Readonly<Record<ProviderId, ProviderDescriptor>> = {
  lark: larkProvider,
  wecom: wecomProvider,
};

const NO_SESSION_CAPABILITIES: SessionCapabilitySet = Object.fromEntries(
  SESSION_CAPABILITIES.map(capability => [capability, false]),
) as SessionCapabilitySet;

const NO_PROFILE_ACCESS: ProfileAccess = {
  rename: false,
  console: false,
  avatar: false,
  description: false,
  agent: false,
  agentExtended: false,
  workingDirectory: false,
  workingDirectoryModes: false,
  worktree: false,
  autoStart: false,
  backendExtended: false,
  role: false,
  sessions: false,
  security: false,
  cards: false,
  backend: false,
  advancedOther: false,
  runtimeStatus: false,
  lifecycle: false,
  platformSections: false,
};

/**
 * 不认识的 `provider` 值：不授予任何可选能力（会话操作、部署入口、配置区块全关）。
 * 身份键与文案沿用飞书的旧形态，和改造前「不是企业微信就按飞书显示」一致。
 */
const unknownProvider: ProviderDescriptor = {
  id: 'unknown',
  botKey: larkProvider.botKey,
  botKeyPrefix: '',
  session: { defaults: NO_SESSION_CAPABILITIES, controlledWrites: false },
  deployment: { groupsNavigation: false, createSession: false },
  profile: {
    supportedSections: [],
    cardFields: [],
    cardButtons: [],
    quietPreset: null,
    ownerReminderStates: 'declared',
    modelPins: false,
    codexConfigInfo: false,
    feedbackChatOverrides: false,
    feedbackExtensions: false,
  },
  profileAccess: () => NO_PROFILE_ACCESS,
  copy: LARK_COPY,
};

/**
 * 一行数据（会话行、Bot 配置行、总览卡片）属于哪个平台。没有 `provider` 字段的旧数据、
 * `'lark'`、`'feishu'` 是飞书；`'wecom'` 是企业微信；其它值是显式的「未知」。
 */
export function providerOf(row: ProviderInput): ProviderKind {
  const provider = row?.provider;
  if (!provider || provider === 'lark' || provider === 'feishu') return 'lark';
  if (provider === 'wecom') return 'wecom';
  return 'unknown';
}

export function providerDescriptor(kind: ProviderKind): ProviderDescriptor {
  return kind === 'unknown' ? unknownProvider : PROVIDERS[kind];
}

function descriptorOf(row: ProviderInput): ProviderDescriptor {
  return providerDescriptor(providerOf(row));
}

/** 这一行是不是企业微信的：企业微信专属的界面分支（会话位置、终端入口、受控写操作）用它。 */
export function isWecomSource(row: ProviderInput): boolean {
  return providerOf(row) === 'wecom';
}

/** 机器人的身份键；只用平台自己的字段拼，绝不给企业微信行编造飞书 appId。 */
export function providerBotKey(row: ProviderRow): string {
  return descriptorOf(row).botKey(row);
}

/** 身份键是哪个平台签出的（会话页的机器人筛选值）；没有已登记前缀的键是飞书 appId。 */
export function providerOfBotKey(key: string): ProviderId {
  for (const descriptor of Object.values(PROVIDERS)) {
    if (descriptor.botKeyPrefix && key.startsWith(descriptor.botKeyPrefix)) return descriptor.id as ProviderId;
  }
  return 'lark';
}

/**
 * 会话行支不支持某项操作。服务端逐项下发的 `capabilities` 优先（只认布尔 true）；
 * 没下发的项按平台默认：飞书保持企业微信接入前的行为，新平台必须逐项声明。
 */
export function sessionSupports(row: Record<string, any> | null | undefined, capability: SessionCapability): boolean {
  const capabilities = row?.capabilities;
  if (capabilities && typeof capabilities === 'object' && Object.prototype.hasOwnProperty.call(capabilities, capability)) {
    return capabilities[capability] === true;
  }
  return descriptorOf(row).session.defaults[capability];
}

/** 会话写操作是否走本机受控通道（控制 CSRF 头 + `expectedGeneration`）。 */
export function sessionWritesControlled(row: ProviderInput): boolean {
  return descriptorOf(row).session.controlledWrites;
}

/** 受控平台的写请求体带上读到这一行时的 `controlGeneration`，服务端据此拒绝过期写入。 */
export function sessionMutationPayload(row: Record<string, any>, payload: Record<string, unknown> = {}): Record<string, unknown> {
  return sessionWritesControlled(row) ? { ...payload, expectedGeneration: row.controlGeneration } : payload;
}

/** 受控平台的写请求要带的控制 CSRF 头；其它平台是空对象（展开进 headers 无副作用）。 */
export function sessionWriteHeaders(row: ProviderInput): Record<string, string> {
  return sessionWritesControlled(row) ? controlCsrfHeaders() : {};
}

/** 共享组件里随平台切换的文案键。 */
export function providerCopy(row: ProviderInput): ProviderCopy {
  return descriptorOf(row).copy;
}

/**
 * 飞书标签键 → 该平台配置页上实际显示的标签键（只换 {@link PROVIDER_LABEL_SLOTS} 里的槽位，
 * 其余原样返回）。⌘K 深链按飞书键登记，落到企业微信配置页时用它找那一行。
 */
export function providerLabelKey(kind: ProviderKind, larkKey: string): string {
  const copy = providerDescriptor(kind).copy;
  const slot = PROVIDER_LABEL_SLOTS.find(candidate => LARK_COPY[candidate] === larkKey);
  return slot ? copy[slot] : larkKey;
}

/** 只由平台决定的 Bot 配置形态（共享区块按它切换预设、可选状态等）。 */
export function providerProfile(row: ProviderInput): ProviderProfile {
  return descriptorOf(row).profile;
}
