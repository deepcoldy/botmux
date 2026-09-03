/**
 * Dashboard 私有 API：「会议角色预设」（VC meeting consumer profiles）。
 *
 * 2026-08 起预设目录是**全 fleet 共享**的一份（`~/.botmux/config.json` 的
 * `vcMeetingAgent.consumerCatalog`），不再按 bot 分开配置：
 *
 *   - 用户不用再手选「会议事件接收 Bot」——每个开着 VC 的 bot 都处理自己收到的
 *     会议事件，被拉进会的是谁就由谁执行；
 *   - 预设条目**不带** `agentAppId`。执行方在读路径合并时才绑定为收到事件的那个
 *     bot（services/vc-meeting-shared-consumer-catalog.ts），所以「拉 A 进会却把
 *     B 拉进监听群」在数据模型层面就不可表达。
 *
 * 职责边界：本层只做 用户 DTO ↔ canonical 配置 的映射与 HTTP 语义包装；
 * revision 乐观并发 / 字段校验的权威在
 * `services/vc-meeting-shared-consumer-catalog-store.ts`，运行时冲突裁决的权威
 * 在 bot-registry resolver——Dashboard 校验只是提前反馈。
 *
 * permissionPreset 是纯 UI 概念，不持久化：保存时映射成 canonical
 * capabilities/ownedSinks 原语；`custom` 只允许复用同 id 既有 policy，
 * 浏览器不能构造 raw capability。
 */
import type { BotConfig } from '../bot-registry.js';
import type {
  VcMeetingConsumerManagedSink,
  VcMeetingConsumerProfileConfig,
  VcMeetingConsumerResponseMode,
  VcMeetingListenerOutputPlacement,
} from '../types.js';
import type { VcMeetingSharedConsumerProfile } from '../global-config.js';
import type { VcMeetingActivityType } from '../vc-agent/types.js';
import type {
  UpdateVcMeetingSharedConsumerCatalogResult,
  VcMeetingSharedConsumerCatalogFieldError,
  VcMeetingSharedConsumerCatalogSnapshot,
} from '../services/vc-meeting-shared-consumer-catalog-store.js';
import {
  VC_MEETING_CONSUMER_PROFILE_TEMPLATE_CATALOG,
  type VcMeetingConsumerProfileTemplateCatalog,
  type VcMeetingTemplatePermissionPreset,
} from '../services/vc-meeting-consumer-profile-templates.js';

export type VcMeetingPermissionPreset =
  | VcMeetingTemplatePermissionPreset
  | 'custom';

/** 字段级错误的形状与 per-bot 时代一致，路径前缀也保持 `profiles[i].*`。 */
export type VcMeetingConsumerProfileFieldError = VcMeetingSharedConsumerCatalogFieldError;

export interface VcMeetingConsumerProfileDto {
  id: string;
  label?: string;
  instructions?: string;
  activityTypes?: string[];
  responseMode: VcMeetingConsumerResponseMode;
  /** Omitted by pre-feature clients and normalized to `auto`. */
  listenerPlacement?: VcMeetingListenerOutputPlacement;
  permissionPreset: VcMeetingPermissionPreset;
}

export interface VcMeetingAgentOptionDto {
  appId: string;
  label: string;
  cliId?: string;
  online: boolean;
  workingDirReady: boolean;
  reliableTurnTerminal: boolean;
  /** May this bot be selected as a meeting consumer at all (plan B: true unless
   *  an explicit sandbox request is undeliverable on this platform/backend). */
  managedSideEffectEligible: boolean;
  /** Is the managed sandbox boundary actually in force? false ⇒ the bot's Lark
   *  credential is exposed to untrusted meeting input (informed opt-out). */
  sandboxIsolated: boolean;
  /** 这个 bot 是否接收会议事件（bots.json vcMeetingAgent.enabled）。缺省视为
   *  开启——VC 对每个连着飞书的 bot 默认可用，`enabled: false` 是显式退出。 */
  vcEnabled: boolean;
  /** apiOnly（无飞书连接）的 bot 结构上不可能收会议事件，UI 需要禁用它的开关。 */
  vcEligible: boolean;
  /** Configured per-bot in-meeting output policies (bots.json
   *  vcMeetingAgent.meetingConsumer.*). null = unset → daemon default. */
  textOutputPolicy: VcMeetingOutputPolicyValue | null;
  voiceOutputPolicy: VcMeetingOutputPolicyValue | null;
  /** vcMeetingAgent.realtimeVoice.enabled — hard gate for in-meeting voice. */
  realtimeVoiceEnabled: boolean;
  /** per-bot 从共享目录挑的默认角色 id（vcMeetingAgent.meetingConsumer.
   *  catalogDefaultConsumerId）。null = 未挑 → 跟随共享目录全局默认。 */
  catalogDefaultConsumerId: string | null;
  /** Effective values after daemon defaults (kept in sync with
   *  defaultVcMeetingTextOutputPolicy / defaultVcMeetingVoiceOutputPolicy). */
  effectiveTextOutputPolicy: VcMeetingOutputPolicyValue;
  effectiveVoiceOutputPolicy: VcMeetingOutputPolicyValue;
}

export type VcMeetingOutputPolicyValue = 'allow' | 'approval' | 'deny';

export interface VcMeetingBotOutputPolicyPatch {
  appId: string;
  /** 会议事件接收开关（vcMeetingAgent.enabled）。 */
  vcEnabled: boolean;
  /** null clears the override back to the daemon default. */
  textOutputPolicy: VcMeetingOutputPolicyValue | null;
  voiceOutputPolicy: VcMeetingOutputPolicyValue | null;
  realtimeVoiceEnabled: boolean;
  /** per-bot 从共享目录挑的默认角色 id。null（或空串）= 跟随全局默认。
   *  写到 vcMeetingAgent.meetingConsumer.catalogDefaultConsumerId。 */
  catalogDefaultConsumerId: string | null;
}

export interface VcMeetingConsumerProfilesGetBody {
  ok: true;
  revision: string;
  catalogState: VcMeetingSharedConsumerCatalogSnapshot['catalogState'];
  defaultMode: 'listenOnly' | 'agents';
  defaultConsumerIds: string[];
  profiles: VcMeetingConsumerProfileDto[];
  agentOptions: VcMeetingAgentOptionDto[];
  /** Versioned, read-only templates. Applying one creates a detached editable profile. */
  templateCatalog: VcMeetingConsumerProfileTemplateCatalog;
}

export interface VcMeetingConsumerProfilesPutRequest {
  expectedRevision: string;
  defaultMode: 'listenOnly' | 'agents';
  defaultConsumerIds: string[];
  profiles: VcMeetingConsumerProfileDto[];
  /** Optional per-bot patches applied to bots.json via the locked
   *  read-modify-write path after the shared catalog update succeeds. */
  botOutputPolicies?: VcMeetingBotOutputPolicyPatch[];
}

export type VcMeetingConsumerProfilesApiResult =
  | { status: 200; body: VcMeetingConsumerProfilesGetBody }
  | { status: 400 | 404 | 409 | 422 | 503; body: {
      ok: false;
      error: string;
      fieldErrors?: VcMeetingConsumerProfileFieldError[];
    } };

export interface VcMeetingConsumerProfilesApiDeps {
  /** 读全局共享目录。同步实现也可以——签名允许两者。 */
  readCatalog(): VcMeetingSharedConsumerCatalogSnapshot | Promise<VcMeetingSharedConsumerCatalogSnapshot>;
  updateCatalog(input: {
    expectedRevision: string;
    defaultMode: 'listenOnly' | 'agents';
    defaultConsumerIds: string[];
    profiles: VcMeetingSharedConsumerProfile[];
  }): UpdateVcMeetingSharedConsumerCatalogResult | Promise<UpdateVcMeetingSharedConsumerCatalogResult>;
  loadBotConfigs(): BotConfig[];
  effectiveDefaultWorkingDir(cfg: BotConfig): string | undefined;
  /** Online DaemonInfo botName lookup; undefined when the daemon is offline. */
  onlineBotName(appId: string): string | undefined;
  isOnline(appId: string): boolean;
  adapterReliableTurnTerminal(cliId: string | undefined, cliPathOverride?: string): boolean;
  managedSideEffectEligible(bot: BotConfig): boolean;
  sandboxIsolated(bot: BotConfig): boolean;
  /** Called after a successful PUT so the live daemon reloads changed bots.json. */
  reloadDaemons(appIds: string[]): Promise<void>;
  /** Locked read-modify-write of one bot's VC switches in bots.json
   *  (vcMeetingAgent.enabled + meetingConsumer.* + realtimeVoice.enabled). */
  applyBotOutputPolicy(patch: VcMeetingBotOutputPolicyPatch): Promise<{ ok: boolean; reason?: string }>;
}

const VC_MEETING_OUTPUT_CAPABILITY = 'meeting.output.request';
const VC_MEETING_LISTENER_OUTPUT_CAPABILITY = 'listener.output.request';
const VC_MEETING_READ_CAPABILITY = 'meeting.read';

/** UI 下拉与 DTO 预检共用；权威列表在 bot-registry 严格校验里。 */
export const VC_MEETING_PROFILE_ACTIVITY_TYPES = [
  'transcript_received',
  'chat_received',
  'participant_joined',
  'participant_left',
  'magic_share_started',
  'magic_share_ended',
] as const;

const PERMISSION_PRESETS: readonly VcMeetingPermissionPreset[] = [
  'observe_only',
  'meeting_text',
  'meeting_voice',
  'meeting_text_voice',
  'custom',
];

const PRESET_SINKS: Record<Exclude<VcMeetingPermissionPreset, 'custom'>, VcMeetingConsumerManagedSink[]> = {
  observe_only: [],
  meeting_text: ['meeting_text'],
  meeting_voice: ['meeting_voice'],
  meeting_text_voice: ['meeting_text', 'meeting_voice'],
};

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function presetCapabilities(
  preset: Exclude<VcMeetingPermissionPreset, 'custom'>,
  responseMode: VcMeetingConsumerResponseMode,
): string[] {
  const capabilities = [VC_MEETING_READ_CAPABILITY];
  if (PRESET_SINKS[preset].length > 0) capabilities.push(VC_MEETING_OUTPUT_CAPABILITY);
  if (responseMode === 'listener_thread') capabilities.push(VC_MEETING_LISTENER_OUTPUT_CAPABILITY);
  return sortedUnique(capabilities);
}

function listsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** canonical policy → 预设档位；对不上任何档位的既有 policy 显示为 custom。 */
export function deriveVcMeetingPermissionPreset(
  profile: Pick<VcMeetingConsumerProfileConfig, 'capabilities' | 'ownedSinks' | 'responseMode'>,
): VcMeetingPermissionPreset {
  const capabilities = sortedUnique(profile.capabilities);
  const sinks = sortedUnique(profile.ownedSinks ?? []);
  for (const preset of ['observe_only', 'meeting_text', 'meeting_voice', 'meeting_text_voice'] as const) {
    if (listsEqual(capabilities, presetCapabilities(preset, profile.responseMode))
      && listsEqual(sinks, sortedUnique(PRESET_SINKS[preset]))) {
      return preset;
    }
  }
  return 'custom';
}

export function vcMeetingConsumerProfileToDto(
  profile: VcMeetingSharedConsumerProfile,
): VcMeetingConsumerProfileDto {
  return {
    id: profile.id,
    ...(profile.label ? { label: profile.label } : {}),
    ...(profile.instructions ? { instructions: profile.instructions } : {}),
    ...(profile.filter?.activityTypes?.length
      ? { activityTypes: [...profile.filter.activityTypes] }
      : {}),
    responseMode: profile.responseMode,
    listenerPlacement: profile.listenerDelivery?.placement ?? 'auto',
    permissionPreset: deriveVcMeetingPermissionPreset(profile),
  };
}

type DtoValidation =
  | { ok: true; profiles: VcMeetingSharedConsumerProfile[] }
  | { ok: false; fieldErrors: VcMeetingConsumerProfileFieldError[] };

/**
 * DTO → canonical。`role` 不在用户 DTO 里：同 id 沿用既有 canonical role
 * （role 参与 profileHash，改写会造成不必要的 epoch 变更），新 id 用 id 作
 * role。custom 档只复用同 id 既有 capabilities/ownedSinks，新 id 无可复用
 * policy → fieldError。
 *
 * 输出**不含** `agentAppId`：共享目录不绑定执行方。
 */
export function vcMeetingConsumerProfilesFromDtos(
  dtos: readonly VcMeetingConsumerProfileDto[],
  existing: readonly VcMeetingSharedConsumerProfile[],
): DtoValidation {
  const fieldErrors: VcMeetingConsumerProfileFieldError[] = [];
  const existingById = new Map(existing.map(profile => [profile.id, profile] as const));
  const profiles: VcMeetingSharedConsumerProfile[] = [];
  dtos.forEach((dto, index) => {
    const path = (field: string): string => `profiles[${index}].${field}`;
    if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
      fieldErrors.push({ path: `profiles[${index}]`, message: '预设必须是对象' });
      return;
    }
    if (typeof dto.id !== 'string' || !dto.id.trim()) {
      fieldErrors.push({ path: path('id'), message: 'id 不能为空' });
      return;
    }
    if (dto.responseMode !== 'silent' && dto.responseMode !== 'listener_thread') {
      fieldErrors.push({ path: path('responseMode'), message: '输出方式必须是 silent 或 listener_thread' });
      return;
    }
    const listenerPlacement = dto.listenerPlacement ?? 'auto';
    if (listenerPlacement !== 'auto'
      && listenerPlacement !== 'chat'
      && listenerPlacement !== 'topic') {
      fieldErrors.push({ path: path('listenerPlacement'), message: '群内呈现必须是 auto、chat 或 topic' });
      return;
    }
    if (!PERMISSION_PRESETS.includes(dto.permissionPreset)) {
      fieldErrors.push({ path: path('permissionPreset'), message: '未知的权限模板' });
      return;
    }
    if (dto.activityTypes !== undefined) {
      if (!Array.isArray(dto.activityTypes)
        || dto.activityTypes.some(type => typeof type !== 'string'
          || !(VC_MEETING_PROFILE_ACTIVITY_TYPES as readonly string[]).includes(type))) {
        fieldErrors.push({ path: path('activityTypes'), message: '事件过滤包含不支持的类型' });
        return;
      }
    }
    if (dto.instructions !== undefined && typeof dto.instructions !== 'string') {
      fieldErrors.push({ path: path('instructions'), message: '职责说明必须是文本' });
      return;
    }
    if (dto.label !== undefined && typeof dto.label !== 'string') {
      fieldErrors.push({ path: path('label'), message: '名称必须是文本' });
      return;
    }
    const prior = existingById.get(dto.id.trim());
    let capabilities: string[];
    let ownedSinks: VcMeetingConsumerManagedSink[];
    if (dto.permissionPreset === 'custom') {
      if (!prior) {
        fieldErrors.push({
          path: path('permissionPreset'),
          message: '自定义权限只能沿用已保存的同 id 预设；新预设请先选择一个权限模板',
        });
        return;
      }
      // custom 沿用同 id 既有 policy；responseMode 独立可编辑。只有 mode 真
      // 变化时才增/删 listener.output.request（silent→listener_thread 补齐，
      // 反向剥离）；mode 未变则逐字复制——silent policy 合法携带该 capability
      // 的 no-op 往返不得丢字段。
      if (dto.responseMode === prior.responseMode) {
        capabilities = [...prior.capabilities];
      } else if (dto.responseMode === 'listener_thread') {
        capabilities = sortedUnique([...prior.capabilities, VC_MEETING_LISTENER_OUTPUT_CAPABILITY]);
      } else {
        capabilities = prior.capabilities
          .filter(capability => capability !== VC_MEETING_LISTENER_OUTPUT_CAPABILITY);
      }
      ownedSinks = [...(prior.ownedSinks ?? [])];
    } else {
      capabilities = presetCapabilities(dto.permissionPreset, dto.responseMode);
      ownedSinks = [...PRESET_SINKS[dto.permissionPreset]];
    }
    const activityTypes = dto.activityTypes?.length ? sortedUnique(dto.activityTypes) : undefined;
    const label = dto.label?.trim();
    const instructions = dto.instructions?.trim();
    profiles.push({
      id: dto.id.trim(),
      ...(label ? { label } : {}),
      role: prior?.role ?? dto.id.trim(),
      ...(instructions ? { instructions } : {}),
      ...(activityTypes
        ? { filter: { activityTypes: activityTypes as VcMeetingActivityType[] } }
        : {}),
      responseMode: dto.responseMode,
      ...(listenerPlacement !== 'auto'
        ? { listenerDelivery: { placement: listenerPlacement } }
        : {}),
      capabilities,
      ...(ownedSinks.length > 0 ? { ownedSinks } : {}),
    });
  });
  return fieldErrors.length > 0 ? { ok: false, fieldErrors } : { ok: true, profiles };
}

export function buildVcMeetingAgentOptions(
  deps: Pick<
    VcMeetingConsumerProfilesApiDeps,
    'loadBotConfigs' | 'effectiveDefaultWorkingDir' | 'onlineBotName' | 'isOnline'
    | 'adapterReliableTurnTerminal' | 'managedSideEffectEligible' | 'sandboxIsolated'
  >,
): VcMeetingAgentOptionDto[] {
  let configs: BotConfig[];
  try {
    configs = deps.loadBotConfigs();
  } catch {
    return [];
  }
  return configs.map((bot) => {
    let workingDirReady = false;
    try {
      workingDirReady = !!(deps.effectiveDefaultWorkingDir(bot) ?? bot.workingDir);
    } catch {
      workingDirReady = false;
    }
    const vc = bot.vcMeetingAgent;
    const textOutputPolicy = normalizeOutputPolicy(vc?.meetingConsumer?.textOutputPolicy);
    const voiceOutputPolicy = normalizeOutputPolicy(vc?.meetingConsumer?.voiceOutputPolicy);
    // 实时语音能力默认开启：未配 = 开，只有显式 false 才关（与 daemon 的
    // vcMeetingRealtimeVoiceEnabled 保持同一判定）。语音 WS 仍按需建连,能力开
    // 不等于入会即连。
    const realtimeVoiceEnabled = vc?.realtimeVoice?.enabled !== false;
    // apiOnly（core-only）bot 没有飞书连接，收不到会议事件——与 bot-registry 的
    // vcMeetingAgentConfigActive fail-close 保持同一判定。
    const vcEligible = bot.apiOnly !== true;
    return {
      appId: bot.larkAppId,
      label: bot.displayName || deps.onlineBotName(bot.larkAppId) || bot.name || bot.larkAppId,
      ...(bot.cliId ? { cliId: bot.cliId } : {}),
      online: deps.isOnline(bot.larkAppId),
      workingDirReady,
      reliableTurnTerminal: deps.adapterReliableTurnTerminal(bot.cliId, bot.cliPathOverride),
      managedSideEffectEligible: deps.managedSideEffectEligible(bot),
      sandboxIsolated: deps.sandboxIsolated(bot),
      // 缺省 = 开启：VC 对每个连着飞书的 bot 默认可用，enabled:false 才是退出。
      vcEnabled: vcEligible && vc?.enabled !== false,
      vcEligible,
      textOutputPolicy,
      voiceOutputPolicy,
      realtimeVoiceEnabled,
      catalogDefaultConsumerId: normalizeNonEmptyStringOrNull(vc?.meetingConsumer?.catalogDefaultConsumerId),
      // Mirrors daemon defaultVcMeetingTextOutputPolicy / defaultVcMeetingVoiceOutputPolicy.
      effectiveTextOutputPolicy: textOutputPolicy ?? 'allow',
      effectiveVoiceOutputPolicy: !realtimeVoiceEnabled ? 'deny' : (voiceOutputPolicy ?? 'allow'),
    };
  }).sort((a, b) => (a.appId === b.appId ? 0 : a.appId < b.appId ? -1 : 1));
}

function normalizeOutputPolicy(value: unknown): VcMeetingOutputPolicyValue | null {
  return value === 'allow' || value === 'approval' || value === 'deny' ? value : null;
}

function normalizeNonEmptyStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseBotOutputPolicyPatches(
  raw: unknown,
  knownAppIds: ReadonlySet<string>,
  knownProfileIds: ReadonlySet<string>,
): { ok: true; patches: VcMeetingBotOutputPolicyPatch[] } | { ok: false; fieldErrors: VcMeetingConsumerProfileFieldError[] } {
  if (raw === undefined) return { ok: true, patches: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, fieldErrors: [{ path: 'botOutputPolicies', message: 'botOutputPolicies 必须是数组' }] };
  }
  const fieldErrors: VcMeetingConsumerProfileFieldError[] = [];
  const patches: VcMeetingBotOutputPolicyPatch[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const path = (field: string): string => `botOutputPolicies[${index}].${field}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fieldErrors.push({ path: `botOutputPolicies[${index}]`, message: '必须是对象' });
      return;
    }
    const record = item as Record<string, unknown>;
    const appId = typeof record.appId === 'string' ? record.appId.trim() : '';
    if (!appId || !knownAppIds.has(appId)) {
      fieldErrors.push({ path: path('appId'), message: '未知的 bot appId' });
      return;
    }
    if (seen.has(appId)) {
      fieldErrors.push({ path: path('appId'), message: '同一 bot 重复出现' });
      return;
    }
    seen.add(appId);
    const parsePolicy = (field: 'textOutputPolicy' | 'voiceOutputPolicy'): VcMeetingOutputPolicyValue | null | undefined => {
      const value = record[field];
      if (value === null) return null;
      if (value === 'allow' || value === 'approval' || value === 'deny') return value;
      fieldErrors.push({ path: path(field), message: '必须是 allow/approval/deny 或 null' });
      return undefined;
    };
    const textOutputPolicy = parsePolicy('textOutputPolicy');
    const voiceOutputPolicy = parsePolicy('voiceOutputPolicy');
    if (typeof record.realtimeVoiceEnabled !== 'boolean') {
      fieldErrors.push({ path: path('realtimeVoiceEnabled'), message: '必须是布尔值' });
      return;
    }
    // 老客户端不发 vcEnabled：缺省保持「接收」，与 vcMeetingAgent.enabled 缺省
    // 语义一致，绝不能把没提交这个字段解释成「关闭接收」。
    if (record.vcEnabled !== undefined && typeof record.vcEnabled !== 'boolean') {
      fieldErrors.push({ path: path('vcEnabled'), message: '必须是布尔值' });
      return;
    }
    // per-bot 默认角色：null/缺省 = 跟随全局默认；给了字符串则必须命中本次提交的
    // 目录角色 id（不然存了个悬空默认，会静默回落全局，误导操作者）。
    let catalogDefaultConsumerId: string | null = null;
    const rawDefault = record.catalogDefaultConsumerId;
    if (rawDefault !== undefined && rawDefault !== null && rawDefault !== '') {
      if (typeof rawDefault !== 'string' || !knownProfileIds.has(rawDefault)) {
        fieldErrors.push({ path: path('catalogDefaultConsumerId'), message: '必须是本目录中存在的角色 id 或留空' });
        return;
      }
      catalogDefaultConsumerId = rawDefault;
    }
    if (textOutputPolicy === undefined || voiceOutputPolicy === undefined) return;
    patches.push({
      appId,
      vcEnabled: record.vcEnabled === undefined ? true : record.vcEnabled as boolean,
      textOutputPolicy,
      voiceOutputPolicy,
      realtimeVoiceEnabled: record.realtimeVoiceEnabled,
      catalogDefaultConsumerId,
    });
  });
  return fieldErrors.length > 0 ? { ok: false, fieldErrors } : { ok: true, patches };
}

function snapshotBody(
  snapshot: VcMeetingSharedConsumerCatalogSnapshot,
  agentOptions: VcMeetingAgentOptionDto[],
): VcMeetingConsumerProfilesGetBody {
  return {
    ok: true,
    revision: snapshot.revision,
    catalogState: snapshot.catalogState,
    defaultMode: snapshot.defaultMode,
    defaultConsumerIds: [...snapshot.defaultConsumerIds],
    profiles: snapshot.profiles.map(vcMeetingConsumerProfileToDto),
    agentOptions,
    templateCatalog: VC_MEETING_CONSUMER_PROFILE_TEMPLATE_CATALOG,
  };
}

export async function handleVcMeetingConsumerProfilesGet(
  deps: VcMeetingConsumerProfilesApiDeps,
): Promise<VcMeetingConsumerProfilesApiResult> {
  let snapshot: VcMeetingSharedConsumerCatalogSnapshot;
  try {
    snapshot = await deps.readCatalog();
  } catch {
    return { status: 503, body: { ok: false, error: 'config_unavailable' } };
  }
  return { status: 200, body: snapshotBody(snapshot, buildVcMeetingAgentOptions(deps)) };
}

export async function handleVcMeetingConsumerProfilesPut(
  payload: unknown,
  deps: VcMeetingConsumerProfilesApiDeps,
): Promise<VcMeetingConsumerProfilesApiResult> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 400, body: { ok: false, error: 'bad_json' } };
  }
  const request = payload as Partial<VcMeetingConsumerProfilesPutRequest>;
  if (typeof request.expectedRevision !== 'string' || !request.expectedRevision) {
    return { status: 400, body: { ok: false, error: 'expectedRevision_required' } };
  }
  if (request.defaultMode !== 'listenOnly' && request.defaultMode !== 'agents') {
    return {
      status: 422,
      body: {
        ok: false,
        error: 'validation_failed',
        fieldErrors: [{ path: 'defaultMode', message: 'defaultMode 必须是 listenOnly 或 agents' }],
      },
    };
  }
  if (!Array.isArray(request.defaultConsumerIds)
    || request.defaultConsumerIds.some(id => typeof id !== 'string')) {
    return {
      status: 422,
      body: {
        ok: false,
        error: 'validation_failed',
        fieldErrors: [{ path: 'defaultConsumerIds', message: 'defaultConsumerIds 必须是字符串数组' }],
      },
    };
  }
  if (!Array.isArray(request.profiles)) {
    return {
      status: 422,
      body: {
        ok: false,
        error: 'validation_failed',
        fieldErrors: [{ path: 'profiles', message: 'profiles 必须是数组' }],
      },
    };
  }

  let current: VcMeetingSharedConsumerCatalogSnapshot;
  try {
    current = await deps.readCatalog();
  } catch {
    return { status: 503, body: { ok: false, error: 'config_unavailable' } };
  }

  const mapped = vcMeetingConsumerProfilesFromDtos(
    request.profiles as VcMeetingConsumerProfileDto[],
    current.profiles,
  );
  if (!mapped.ok) {
    return {
      status: 422,
      body: { ok: false, error: 'validation_failed', fieldErrors: mapped.fieldErrors },
    };
  }

  let knownAppIds: ReadonlySet<string>;
  try {
    knownAppIds = new Set(deps.loadBotConfigs().map(bot => bot.larkAppId));
  } catch {
    knownAppIds = new Set();
  }
  const parsedPolicies = parseBotOutputPolicyPatches(
    request.botOutputPolicies,
    knownAppIds,
    new Set(mapped.profiles.map(profile => profile.id)),
  );
  if (!parsedPolicies.ok) {
    return {
      status: 422,
      body: { ok: false, error: 'validation_failed', fieldErrors: parsedPolicies.fieldErrors },
    };
  }

  // defaultConsumerIds 原样提交：未知/重复/agents-空组合以及「同时选中两个角色」
  // 由 store 严格拒绝，本层不做静默过滤（与 store 的 fail-loud 语义保持一致）。
  const updated = await deps.updateCatalog({
    expectedRevision: request.expectedRevision,
    defaultMode: request.defaultMode,
    defaultConsumerIds: [...request.defaultConsumerIds],
    profiles: mapped.profiles,
  });
  if (!updated.ok) {
    if (updated.reason === 'config_conflict') {
      return { status: 409, body: { ok: false, error: 'config_conflict' } };
    }
    if (updated.reason === 'validation_failed') {
      return {
        status: 422,
        body: {
          ok: false,
          error: 'validation_failed',
          ...(updated.fieldErrors ? { fieldErrors: updated.fieldErrors } : {}),
        },
      };
    }
    return { status: 503, body: { ok: false, error: 'config_unavailable' } };
  }

  // Per-bot switches go to bots.json through the locked RMW path. The shared
  // catalog is already committed at this point; a policy failure is surfaced
  // loudly (503) so the UI re-GETs and shows what actually landed.
  const policyFailures: VcMeetingConsumerProfileFieldError[] = [];
  for (const patch of parsedPolicies.patches) {
    try {
      const applied = await deps.applyBotOutputPolicy(patch);
      if (!applied.ok) {
        policyFailures.push({
          path: `botOutputPolicies[${patch.appId}]`,
          message: applied.reason ?? 'write_failed',
        });
      }
    } catch (err) {
      policyFailures.push({
        path: `botOutputPolicies[${patch.appId}]`,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    // 共享目录不需要 reload：它在 daemon 侧走 mtime 缓存的 live 读，下一个会议
    // 事件自然生效。只有落进 bots.json 的 per-bot 开关需要通知对应 daemon。
    await deps.reloadDaemons(parsedPolicies.patches.map(patch => patch.appId));
  } catch {
    // 配置已落盘；reload 失败只影响热加载时效，下次 daemon 重启/重载自然收敛。
  }
  if (policyFailures.length > 0) {
    return {
      status: 503,
      body: { ok: false, error: 'bot_policy_write_failed', fieldErrors: policyFailures },
    };
  }
  return { status: 200, body: snapshotBody(updated.snapshot, buildVcMeetingAgentOptions(deps)) };
}
