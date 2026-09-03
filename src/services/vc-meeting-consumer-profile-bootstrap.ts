/**
 * 历史遗留的「默认会议角色预设」识别。
 *
 * 这个模块过去负责**生成**默认预设：daemon 启动时给本 bot 播种一条 `minutes`
 * 预设，并把执行方 `agentAppId` 焊进去。整套播种已于 2026-08 退役——角色预设
 * 改成全 fleet 共享目录 + 读路径内置默认（`vc-meeting-shared-consumer-catalog.ts`），
 * 执行方永远是收到这场会议事件的 bot 自己。退役的两个理由：
 *
 *   1. 播种出来的 per-bot `consumerProfiles` 会永久遮蔽共享目录，操作者改共享
 *      预设时被播种过的 bot 完全不跟随；
 *   2. 播种时那条「本 bot 结构上不合格就换一个合格 bot」的兜底，会把**另一个**
 *      bot 的 appId 写进预设，会中 `addBotToChat` 再照着它把无关 bot 拉进监听群
 *      ——「拉 A 进会却把 B 拉进群」就是这么来的。
 *
 * 留下来的只有**识别**能力，三种：
 *
 *   - {@link hasLegacyVcMeetingConsumerAgentPolicy}：操作者按老模型手写过执行方
 *     策略（`agentCandidates` 等）。绑定层据此不拿共享目录去覆盖它；
 *   - {@link isVcMeetingSeededConsumerProfileBlock}：带 `defaultProfileBootstrap`
 *     出处标记的 v2 播种残留。绑定层用它把这类配置当作「没有 per-bot 预设」，
 *     于是这些 bot 回到共享目录（否则机器播种物会永久遮蔽操作者的共享预设）；
 *   - {@link isLegacyVcMeetingDefaultConsumerSeedCandidate}：更早的 v1 播种物没有
 *     出处标记，只能按逐字段形状识别。绑定层同样让它回到共享目录——v1 播种物一样
 *     把执行方焊进了预设，一样可能焊的是另一个 bot。
 *
 * 识别刻意严格：近似形状可能是操作者自己写的，不能被当成机器生成物丢弃或迁移。
 */
import type { VcMeetingConsumerConfig } from '../types.js';

const DEFAULT_CONSUMER_PROFILE_ID = 'minutes';
const DEFAULT_CONSUMER_PROFILE_LABEL = '会议纪要';
const LEGACY_DEFAULT_CONSUMER_PROFILE_INSTRUCTIONS = '持续整理会议纪要，重点记录已确认的决策、待办事项（含负责人和截止时间）以及未解决风险；字幕修订时更新已有条目，不重复记录同一事项。';

/** 早于「预设目录」模型的按-bot 执行方字段，出现即说明是操作者手工配置过的老配置。 */
const LEGACY_VC_CONSUMER_AGENT_FIELDS = [
  'defaultAgentAppId',
  'defaultAgent',
  'agentCandidates',
  'agents',
] as const;

const LEGACY_DEFAULT_CONSUMER_PROFILE_KEYS = [
  'agentAppId',
  'capabilities',
  'id',
  'instructions',
  'label',
  'responseMode',
  'role',
] as const;

function isLegacyGeneratedMinutesProfile(profile: unknown): profile is Record<string, unknown> & { agentAppId: string } {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false;
  const entry = profile as Record<string, unknown>;
  const keys = Object.keys(entry).sort();
  if (keys.length !== LEGACY_DEFAULT_CONSUMER_PROFILE_KEYS.length
    || keys.some((key, index) => key !== LEGACY_DEFAULT_CONSUMER_PROFILE_KEYS[index])) return false;
  return entry.id === DEFAULT_CONSUMER_PROFILE_ID
    && typeof entry.agentAppId === 'string'
    && entry.agentAppId.trim().length > 0
    && entry.label === DEFAULT_CONSUMER_PROFILE_LABEL
    && entry.role === 'minutes'
    && entry.instructions === LEGACY_DEFAULT_CONSUMER_PROFILE_INSTRUCTIONS
    && entry.responseMode === 'silent'
    && Array.isArray(entry.capabilities)
    && entry.capabilities.length === 1
    && entry.capabilities[0] === 'meeting.read';
}

/**
 * 这个 bot 的会议消费面是不是**操作者按老模型手工配过执行方策略**。
 *
 * 老模型（预设目录之前）用 `agentCandidates` / `defaultAgentAppId` 这类字段直接
 * 点名「哪些 bot 可以当会议 agent」。这些字段一旦出现就是操作者显式意图，共享
 * 目录不去覆盖它——那些 bot 继续按自己配的候选名单跑会中选择卡。
 *
 * 注意这与「拉 A 进会却把 B 拉进群」不是一回事：那条 bug 来自机器播种时焊进
 * 预设的 `agentAppId`（操作者从没写过），而候选名单是操作者亲手列的。
 */
export function hasLegacyVcMeetingConsumerAgentPolicy(
  meetingConsumer: unknown,
): boolean {
  if (!meetingConsumer || typeof meetingConsumer !== 'object' || Array.isArray(meetingConsumer)) return false;
  return LEGACY_VC_CONSUMER_AGENT_FIELDS.some(
    field => Object.prototype.hasOwnProperty.call(meetingConsumer, field),
  );
}

/**
 * 这份 per-bot 预设是不是**机器播种**出来的（而非操作者写的）。
 *
 * 判据是播种时写下的出处标记 `defaultProfileBootstrap` 正好覆盖当前这组预设：
 * 只有一条预设、且 id 与出处记录的 `profileId` 一致。操作者后来改过（加了第二条
 * 预设、换了 id）就不再匹配——那时它是操作者内容，必须原样保留。
 *
 * 绑定层据此让这些 bot 回到共享目录：机器播种物既会遮蔽操作者的共享预设，
 * 里面的 `agentAppId` 还可能指向另一个 bot。判定只发生在读路径，不改磁盘。
 */
export function isVcMeetingSeededConsumerProfileBlock(
  meetingConsumer: Pick<VcMeetingConsumerConfig, 'consumerProfiles' | 'defaultProfileBootstrap'> | undefined,
): boolean {
  const provenance = meetingConsumer?.defaultProfileBootstrap;
  if (!provenance) return false;
  const profiles = meetingConsumer?.consumerProfiles;
  return Array.isArray(profiles)
    && profiles.length === 1
    && profiles[0]?.id === provenance.profileId;
}

/**
 * Match only the exact raw profile emitted by the pre-provenance generator.
 * This intentionally does not normalize aliases or tolerate extra profile
 * fields: a near miss may be operator-owned and must not be offered an
 * automatic migration.
 */
export function isLegacyVcMeetingDefaultConsumerSeedCandidate(
  meetingConsumer: unknown,
): boolean {
  if (!meetingConsumer || typeof meetingConsumer !== 'object' || Array.isArray(meetingConsumer)) return false;
  const consumer = meetingConsumer as Record<string, unknown>;
  if (consumer.defaultMode !== 'listenOnly'
    || Object.prototype.hasOwnProperty.call(consumer, 'defaultConsumerIds')
    || Object.prototype.hasOwnProperty.call(consumer, 'defaultProfileBootstrap')
    || LEGACY_VC_CONSUMER_AGENT_FIELDS.some(field => Object.prototype.hasOwnProperty.call(consumer, field))
    || !Array.isArray(consumer.consumerProfiles)
    || consumer.consumerProfiles.length !== 1) return false;
  return isLegacyGeneratedMinutesProfile(consumer.consumerProfiles[0]);
}
