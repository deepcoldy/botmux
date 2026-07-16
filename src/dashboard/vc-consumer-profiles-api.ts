/**
 * Dashboard 私有 API：「会议角色预设」（VC meeting consumer profiles）。
 *
 * 职责边界：本层只做 用户 DTO ↔ canonical 配置 的映射与 HTTP 语义包装；
 * 配置 RMW / revision 乐观并发 / 字段校验的权威在
 * `services/vc-meeting-consumer-profile-store.ts`（锁内复核），运行时冲突
 * 裁决的权威在 bot-registry resolver——Dashboard 校验只是提前反馈。
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
} from '../types.js';
import type { VcMeetingActivityType } from '../vc-agent/types.js';
import type {
  UpdateVcMeetingConsumerProfilesResult,
  VcMeetingConsumerProfileFieldError,
  VcMeetingConsumerProfilesSnapshot,
} from '../services/vc-meeting-consumer-profile-store.js';

export type VcMeetingPermissionPreset =
  | 'observe_only'
  | 'meeting_text'
  | 'meeting_voice'
  | 'meeting_text_voice'
  | 'custom';

export interface VcMeetingConsumerProfileDto {
  id: string;
  label?: string;
  agentAppId: string;
  instructions?: string;
  activityTypes?: string[];
  responseMode: VcMeetingConsumerResponseMode;
  permissionPreset: VcMeetingPermissionPreset;
}

export interface VcMeetingAgentOptionDto {
  appId: string;
  label: string;
  cliId?: string;
  online: boolean;
  workingDirReady: boolean;
  reliableTurnTerminal: boolean;
  managedSideEffectIsolation: boolean;
}

export interface VcMeetingConsumerProfilesGetBody {
  ok: true;
  listenerBotAppId: string;
  revision: string;
  catalogState: VcMeetingConsumerProfilesSnapshot['catalogState'];
  defaultMode: 'listenOnly' | 'agents';
  defaultConsumerIds: string[];
  profiles: VcMeetingConsumerProfileDto[];
  agentOptions: VcMeetingAgentOptionDto[];
  migrationOffer?: VcMeetingConsumerProfilesSnapshot['migrationOffer'];
}

export interface VcMeetingConsumerProfilesPutRequest {
  listenerBotAppId: string;
  expectedRevision: string;
  defaultMode: 'listenOnly' | 'agents';
  defaultConsumerIds: string[];
  profiles: VcMeetingConsumerProfileDto[];
}

export type VcMeetingConsumerProfilesApiResult =
  | { status: 200; body: VcMeetingConsumerProfilesGetBody }
  | { status: 400 | 404 | 409 | 422 | 503; body: {
      ok: false;
      error: string;
      fieldErrors?: VcMeetingConsumerProfileFieldError[];
    } };

export interface VcMeetingConsumerProfilesApiDeps {
  readSnapshot(listenerBotAppId: string): Promise<VcMeetingConsumerProfilesSnapshot | undefined>;
  updateSnapshot(
    listenerBotAppId: string,
    input: {
      expectedRevision: string;
      defaultMode: 'listenOnly' | 'agents';
      defaultConsumerIds: string[];
      profiles: VcMeetingConsumerProfileConfig[];
    },
  ): Promise<UpdateVcMeetingConsumerProfilesResult>;
  loadBotConfigs(): BotConfig[];
  effectiveDefaultWorkingDir(cfg: BotConfig): string | undefined;
  /** Online DaemonInfo botName lookup; undefined when the daemon is offline. */
  onlineBotName(appId: string): string | undefined;
  isOnline(appId: string): boolean;
  adapterReliableTurnTerminal(cliId: string | undefined, cliPathOverride?: string): boolean;
  managedSideEffectIsolation(bot: BotConfig): boolean;
  /** Called after a successful PUT so the live daemon reloads the new catalog. */
  reloadDaemons(appIds: string[]): Promise<void>;
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
  profile: VcMeetingConsumerProfileConfig,
): VcMeetingConsumerProfileDto {
  return {
    id: profile.id,
    ...(profile.label ? { label: profile.label } : {}),
    agentAppId: profile.agentAppId,
    ...(profile.instructions ? { instructions: profile.instructions } : {}),
    ...(profile.filter?.activityTypes?.length
      ? { activityTypes: [...profile.filter.activityTypes] }
      : {}),
    responseMode: profile.responseMode,
    permissionPreset: deriveVcMeetingPermissionPreset(profile),
  };
}

type DtoValidation =
  | { ok: true; profiles: VcMeetingConsumerProfileConfig[] }
  | { ok: false; fieldErrors: VcMeetingConsumerProfileFieldError[] };

/**
 * DTO → canonical。`role` 不在用户 DTO 里：同 id 沿用既有 canonical role
 * （role 参与 profileHash，改写会造成不必要的 epoch 变更），新 id 用 id 作
 * role。custom 档只复用同 id 既有 capabilities/ownedSinks，新 id 无可复用
 * policy → fieldError。
 */
export function vcMeetingConsumerProfilesFromDtos(
  dtos: readonly VcMeetingConsumerProfileDto[],
  existing: readonly VcMeetingConsumerProfileConfig[],
): DtoValidation {
  const fieldErrors: VcMeetingConsumerProfileFieldError[] = [];
  const existingById = new Map(existing.map(profile => [profile.id, profile] as const));
  const profiles: VcMeetingConsumerProfileConfig[] = [];
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
    if (typeof dto.agentAppId !== 'string' || !dto.agentAppId.trim()) {
      fieldErrors.push({ path: path('agentAppId'), message: '必须选择一个 Agent' });
      return;
    }
    if (dto.responseMode !== 'silent' && dto.responseMode !== 'listener_thread') {
      fieldErrors.push({ path: path('responseMode'), message: '输出方式必须是 silent 或 listener_thread' });
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
      agentAppId: dto.agentAppId.trim(),
      ...(label ? { label } : {}),
      role: prior?.role ?? dto.id.trim(),
      ...(instructions ? { instructions } : {}),
      ...(activityTypes
        ? { filter: { activityTypes: activityTypes as VcMeetingActivityType[] } }
        : {}),
      responseMode: dto.responseMode,
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
    | 'adapterReliableTurnTerminal' | 'managedSideEffectIsolation'
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
    return {
      appId: bot.larkAppId,
      label: bot.displayName || deps.onlineBotName(bot.larkAppId) || bot.name || bot.larkAppId,
      ...(bot.cliId ? { cliId: bot.cliId } : {}),
      online: deps.isOnline(bot.larkAppId),
      workingDirReady,
      reliableTurnTerminal: deps.adapterReliableTurnTerminal(bot.cliId, bot.cliPathOverride),
      managedSideEffectIsolation: deps.managedSideEffectIsolation(bot),
    };
  }).sort((a, b) => (a.appId === b.appId ? 0 : a.appId < b.appId ? -1 : 1));
}

function snapshotBody(
  snapshot: VcMeetingConsumerProfilesSnapshot,
  agentOptions: VcMeetingAgentOptionDto[],
): VcMeetingConsumerProfilesGetBody {
  return {
    ok: true,
    listenerBotAppId: snapshot.listenerBotAppId,
    revision: snapshot.revision,
    catalogState: snapshot.catalogState,
    defaultMode: snapshot.defaultMode,
    defaultConsumerIds: [...snapshot.defaultConsumerIds],
    profiles: snapshot.profiles.map(vcMeetingConsumerProfileToDto),
    agentOptions,
    ...(snapshot.migrationOffer ? { migrationOffer: snapshot.migrationOffer } : {}),
  };
}

export async function handleVcMeetingConsumerProfilesGet(
  listenerBotAppId: string,
  deps: VcMeetingConsumerProfilesApiDeps,
): Promise<VcMeetingConsumerProfilesApiResult> {
  if (!listenerBotAppId.trim()) {
    return { status: 400, body: { ok: false, error: 'listenerBotAppId_required' } };
  }
  let snapshot: VcMeetingConsumerProfilesSnapshot | undefined;
  try {
    snapshot = await deps.readSnapshot(listenerBotAppId.trim());
  } catch {
    return { status: 503, body: { ok: false, error: 'config_unavailable' } };
  }
  if (!snapshot) return { status: 404, body: { ok: false, error: 'bot_not_in_config' } };
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
  const listenerBotAppId = typeof request.listenerBotAppId === 'string' ? request.listenerBotAppId.trim() : '';
  if (!listenerBotAppId) {
    return { status: 400, body: { ok: false, error: 'listenerBotAppId_required' } };
  }
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

  let current: VcMeetingConsumerProfilesSnapshot | undefined;
  try {
    current = await deps.readSnapshot(listenerBotAppId);
  } catch {
    return { status: 503, body: { ok: false, error: 'config_unavailable' } };
  }
  if (!current) return { status: 404, body: { ok: false, error: 'bot_not_in_config' } };

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

  // defaultConsumerIds 原样提交：未知/重复/agents-空组合由 store 严格拒绝，
  // 本层不做静默过滤（与 store 的 fail-loud 语义保持一致）。
  const updated = await deps.updateSnapshot(listenerBotAppId, {
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
    if (updated.reason === 'bot_not_in_config') {
      return { status: 404, body: { ok: false, error: 'bot_not_in_config' } };
    }
    return { status: 503, body: { ok: false, error: 'config_unavailable' } };
  }

  try {
    await deps.reloadDaemons([listenerBotAppId]);
  } catch {
    // 配置已落盘；reload 失败只影响热加载时效，下次 daemon 重启/重载自然收敛。
  }
  return { status: 200, body: snapshotBody(updated.snapshot, buildVcMeetingAgentOptions(deps)) };
}
