/**
 * 全 fleet 共享会议角色预设目录的读写层（`~/.botmux/config.json` 的
 * `vcMeetingAgent.consumerCatalog`）。
 *
 * 沿用退役的 per-bot store 那套契约（乐观并发 revision + 字段级错误路径），
 * 差别只有两点：
 *
 *   - 存的是**一份**目录，不再有 `listenerBotAppId` 维度；
 *   - 预设条目**没有** `agentAppId`：执行方是「被拉进这场会议的那个 bot」，
 *     在读路径合并时才绑定（见 vc-meeting-shared-consumer-catalog.ts）。
 *
 * 校验借用 bot-registry 的权威 normalizer/resolver：把目录绑到一个占位 appId 上
 * 走一遍真实校验，这样 Dashboard 能接受的东西 daemon 一定也能解析。
 */
import { createHash } from 'node:crypto';
import {
  normalizeVcMeetingConsumerProfiles,
  resolveVcMeetingConsumerProfiles,
} from '../bot-registry.js';
import {
  globalConfigPath,
  rawGlobalVcMeetingSharedConsumerCatalog,
  writeGlobalVcMeetingSharedConsumerCatalog,
  type VcMeetingSharedConsumerCatalog,
  type VcMeetingSharedConsumerProfile,
} from '../global-config.js';
import type { VcMeetingConsumerProfileConfig } from '../types.js';
import { canonicalJson } from '../utils/canonical-input-hash.js';

export type VcMeetingSharedConsumerCatalogFieldError = {
  path: string;
  message: string;
};

export interface VcMeetingSharedConsumerCatalogSnapshot {
  revision: string;
  /** 区分「从没配置过」「显式清空」「有预设」三态，供 UI 决定空态文案。 */
  catalogState: 'uninitialized' | 'explicit_empty' | 'profiles';
  defaultMode: 'listenOnly' | 'agents';
  defaultConsumerIds: string[];
  profiles: VcMeetingSharedConsumerProfile[];
}

export interface UpdateVcMeetingSharedConsumerCatalogInput {
  expectedRevision: string;
  defaultMode: 'listenOnly' | 'agents';
  defaultConsumerIds: string[];
  profiles: VcMeetingSharedConsumerProfile[];
}

export type UpdateVcMeetingSharedConsumerCatalogResult =
  | { ok: true; snapshot: VcMeetingSharedConsumerCatalogSnapshot }
  | {
      ok: false;
      reason: 'config_conflict' | 'validation_failed' | 'config_unavailable';
      fieldErrors?: VcMeetingSharedConsumerCatalogFieldError[];
      error?: string;
    };

/**
 * 校验时用的占位执行方。目录本身不带 `agentAppId`，但 bot-registry 的校验需要一个
 * ——用同一个占位值绑定所有条目，正好复现运行时「所有预设都属于同一个 bot」的
 * 事实，于是「同时选中两个角色」在这里就会被 resolver 拦下。
 */
const CATALOG_PROBE_AGENT_APP_ID = 'cli_shared_catalog_probe';

/**
 * 从没配置过共享目录时用的内置默认角色。
 *
 * 之所以做在**读路径**而不是在 daemon 启动时写一份进配置：`mergeGlobalConfig`
 * 没有跨进程锁，fleet 里几十个 daemon 同时启动各写一次，丢的可能是别的顶层
 * 配置项。读路径内置则零写盘、幂等，且 Dashboard 与 daemon 读的是同一个常量，
 * 页面上看到的就是每个 bot 进会后真正会跑的角色。
 *
 * 注意与「显式清空」的区别：保存过 `profiles: []` 是持久的「所有 bot 都不要
 * 角色」，不会被这份内置默认顶掉（见 catalogStateFromRaw 的三态）。
 */
export const BUILTIN_VC_MEETING_SHARED_CONSUMER_CATALOG: VcMeetingSharedConsumerCatalog = Object.freeze({
  profiles: [Object.freeze({
    id: 'minutes',
    label: '会议纪要',
    role: 'minutes',
    instructions: '持续整理会议纪要，重点记录已确认的决策、待办事项（含负责人和截止时间）以及未解决风险；字幕修订时更新已有条目，不重复记录同一事项。仅在出现新的关键决策、明确待办或风险，或被用户点名时，才在监听群输出简洁增量；无实质增量时保持静默，不发送确认或心跳。需要向会议内发送文字或语音时，必须通过 botmux 受管 request-output/action gate 提交，不得绕过权限、所有权与审核策略。',
    responseMode: 'listener_thread',
    capabilities: Object.freeze(['listener.output.request', 'meeting.output.request', 'meeting.read']),
    ownedSinks: Object.freeze(['meeting_text', 'meeting_voice']),
  })],
  defaultMode: 'agents',
  defaultConsumerIds: Object.freeze(['minutes']),
}) as VcMeetingSharedConsumerCatalog;

function canonicalRevision(rawCatalog: unknown): string {
  return `sha256:${createHash('sha256')
    // 哈希的是**原始**对象而不是归一化结果：手改配置即使被 forgiving 读路径
    // 归一化掉，也必须让 revision 变化，否则会绕过乐观并发。
    .update(canonicalJson(rawCatalog ?? null), 'utf8')
    .digest('hex')}`;
}

function catalogStateFromRaw(rawCatalog: unknown): VcMeetingSharedConsumerCatalogSnapshot['catalogState'] {
  if (!rawCatalog || typeof rawCatalog !== 'object' || Array.isArray(rawCatalog)) return 'uninitialized';
  const profiles = (rawCatalog as Record<string, unknown>).profiles;
  if (!Array.isArray(profiles)) return 'uninitialized';
  return profiles.length === 0 ? 'explicit_empty' : 'profiles';
}

/** 把 bot-registry 的错误路径映射成 DTO 路径（与 per-bot store 保持一致）。 */
function validationError(err: unknown): VcMeetingSharedConsumerCatalogFieldError {
  const message = err instanceof Error ? err.message : String(err);
  const pathMatch = message.match(
    /(?:vcMeetingAgent\.meetingConsumer\.)?(consumerProfiles(?:\[\d+\])?(?:\.[A-Za-z0-9_]+)*(?:\[\d+\])?|defaultConsumerIds(?:\[\d+\])?|defaultMode)/u,
  );
  let path = pathMatch?.[1]?.replace(/^consumerProfiles/u, 'profiles');
  if (path) {
    path = path
      .replace(/\.filter\.activityTypes/u, '.activityTypes')
      .replace(/\.(?:capabilities|ownedSinks)(?:\[\d+\])?$/u, '.permissionPreset');
  } else if (/defaultConsumerIds|defaultMode=agents|selected profiles|selectedConsumerIds/u.test(message)) {
    path = 'defaultConsumerIds';
  } else {
    path = 'profiles';
  }
  return { path, message };
}

function bindToProbe(profile: VcMeetingSharedConsumerProfile): VcMeetingConsumerProfileConfig {
  return { ...profile, agentAppId: CATALOG_PROBE_AGENT_APP_ID };
}

/**
 * 逐条归一化：坏条目只丢自己，不连累整份目录。
 *
 * `normalizeVcMeetingConsumerProfiles` 见到第一条坏数据就抛，整个数组一起没。
 * 对**全局共享**目录来说这个失败面太大：手改配置时一个字段写错，全 fleet 的
 * bot 会一起变成干听。逐条走一遍，坏的那条消失、好的照常生效——保存路径仍走
 * 严格校验（{@link validateVcMeetingSharedConsumerCatalog}），所以坏数据只会
 * 从磁盘里来，且一保存就会被拦下并给出字段级错误。
 *
 * 跨条目的检查（重复 id 等）在 resolver 而不在 normalizer 里，所以逐条归一化
 * 不会漏掉任何单条校验。
 */
export function normalizeVcMeetingConsumerProfilesForgiving(
  rawProfiles: readonly unknown[],
): { profiles: VcMeetingConsumerProfileConfig[]; errors: string[] } {
  const profiles: VcMeetingConsumerProfileConfig[] = [];
  const errors: string[] = [];
  rawProfiles.forEach((raw, index) => {
    try {
      profiles.push(...normalizeVcMeetingConsumerProfiles([raw]));
    } catch (err) {
      // 单条归一化时索引恒为 0，这里补回它在目录里的真实位置。
      errors.push(`profiles[${index}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return { profiles, errors };
}

function stripAgentAppId(profile: VcMeetingConsumerProfileConfig): VcMeetingSharedConsumerProfile {
  const { agentAppId: _agentAppId, ...rest } = profile;
  return rest;
}

/** 目录条目的持久化形状。刻意不写 `agentAppId`。 */
function rawProfile(profile: VcMeetingSharedConsumerProfile): VcMeetingSharedConsumerProfile {
  return {
    id: profile.id,
    ...(profile.label ? { label: profile.label } : {}),
    role: profile.role,
    ...(profile.instructions ? { instructions: profile.instructions } : {}),
    ...(profile.filter ? { filter: profile.filter } : {}),
    responseMode: profile.responseMode,
    ...(profile.listenerDelivery ? { listenerDelivery: profile.listenerDelivery } : {}),
    capabilities: [...profile.capabilities],
    ...(profile.ownedSinks?.length ? { ownedSinks: [...profile.ownedSinks] } : {}),
  };
}

/**
 * 用 bot-registry 的权威校验跑一遍目录。返回归一化后的条目，或字段级错误。
 */
export function validateVcMeetingSharedConsumerCatalog(
  input: Pick<UpdateVcMeetingSharedConsumerCatalogInput, 'defaultMode' | 'defaultConsumerIds' | 'profiles'>,
): { ok: true; profiles: VcMeetingSharedConsumerProfile[] }
  | { ok: false; fieldErrors: VcMeetingSharedConsumerCatalogFieldError[] } {
  // 一个 bot 同时只能跑一个角色（所有预设的执行方都是它自己，resolver 拒绝两条
  // 被选中的预设共用 agentAppId）。先在这里给出人话，不然用户看到的是
  // "selected profiles X and Y share agentAppId ..." 这种内部措辞。
  if (input.defaultConsumerIds.length > 1) {
    return {
      ok: false,
      fieldErrors: [{
        path: 'defaultConsumerIds',
        message: '同一时间只能有一个默认角色：每个 bot 进会后只跑一个角色，请只勾选一个。',
      }],
    };
  }
  let normalized: VcMeetingConsumerProfileConfig[];
  try {
    normalized = normalizeVcMeetingConsumerProfiles(input.profiles.map(bindToProbe));
  } catch (err) {
    return { ok: false, fieldErrors: [validationError(err)] };
  }
  const resolution = resolveVcMeetingConsumerProfiles({
    consumerProfiles: normalized,
    defaultConsumerIds: input.defaultConsumerIds,
    defaultMode: input.defaultMode,
  });
  if (!resolution.ok) {
    return { ok: false, fieldErrors: resolution.errors.map(error => validationError(new Error(error))) };
  }
  return { ok: true, profiles: normalized.map(stripAgentAppId) };
}

function snapshotFromRaw(rawCatalog: unknown): VcMeetingSharedConsumerCatalogSnapshot {
  const state = catalogStateFromRaw(rawCatalog);
  // 没配置过就落到内置默认目录（daemon 侧绑定层用同一个常量），显式清空则保持空。
  const entry = (state === 'uninitialized'
    ? BUILTIN_VC_MEETING_SHARED_CONSUMER_CATALOG
    : rawCatalog) as Record<string, unknown>;
  const rawProfiles = Array.isArray(entry?.profiles) ? entry!.profiles : [];
  // 读路径 forgiving：坏条目在 UI 里表现为「这条不见了」而不是整页打不开，
  // 保存时才会被上面的权威校验拦住。
  const profiles = normalizeVcMeetingConsumerProfilesForgiving(
    rawProfiles.map(profile => ({
      ...(profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {}),
      agentAppId: CATALOG_PROBE_AGENT_APP_ID,
    })),
  ).profiles.map(stripAgentAppId);
  const profileIds = new Set(profiles.map(profile => profile.id));
  const defaultConsumerIds = (Array.isArray(entry?.defaultConsumerIds) ? entry!.defaultConsumerIds : [])
    .filter((id): id is string => typeof id === 'string' && profileIds.has(id));
  return {
    revision: canonicalRevision(rawCatalog),
    catalogState: state,
    defaultMode: entry?.defaultMode === 'agents' && defaultConsumerIds.length > 0 ? 'agents' : 'listenOnly',
    defaultConsumerIds,
    profiles,
  };
}

export function readVcMeetingSharedConsumerCatalogSnapshot(): VcMeetingSharedConsumerCatalogSnapshot {
  return snapshotFromRaw(rawGlobalVcMeetingSharedConsumerCatalog());
}

/**
 * 乐观并发替换共享目录。
 *
 * revision 校验与写入之间没有 `await`，所以同进程内不存在竞态；跨进程用的是
 * `mergeGlobalConfig` 的 tmp+rename 原子写（与其它全局设置一致）。
 */
export function updateVcMeetingSharedConsumerCatalog(
  input: UpdateVcMeetingSharedConsumerCatalogInput,
): UpdateVcMeetingSharedConsumerCatalogResult {
  let current: VcMeetingSharedConsumerCatalogSnapshot;
  try {
    current = readVcMeetingSharedConsumerCatalogSnapshot();
  } catch (err) {
    return { ok: false, reason: 'config_unavailable', error: err instanceof Error ? err.message : String(err) };
  }
  if (current.revision !== input.expectedRevision) return { ok: false, reason: 'config_conflict' };

  const validated = validateVcMeetingSharedConsumerCatalog(input);
  if (!validated.ok) return { ok: false, reason: 'validation_failed', fieldErrors: validated.fieldErrors };

  const catalog: VcMeetingSharedConsumerCatalog = {
    profiles: validated.profiles.map(rawProfile),
    defaultMode: input.defaultConsumerIds.length > 0 ? input.defaultMode : 'listenOnly',
    defaultConsumerIds: [...input.defaultConsumerIds],
  };
  try {
    // mergeGlobalConfig 写完会清掉 readCache 与 vcMeetingAgentLiveCache，所以
    // 下面的回读一定看到新目录，本进程无需另行失效缓存。
    writeGlobalVcMeetingSharedConsumerCatalog(catalog);
  } catch (err) {
    return { ok: false, reason: 'config_unavailable', error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, snapshot: readVcMeetingSharedConsumerCatalogSnapshot() };
}

/** 便于测试/诊断：当前生效的配置文件路径。 */
export function vcMeetingSharedConsumerCatalogConfigPath(): string {
  return globalConfigPath();
}
