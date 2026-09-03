/**
 * 会议角色预设 → per-bot 有效配置的绑定层。
 *
 * 背景：角色预设过去存在每个 bot 自己的
 * `vcMeetingAgent.meetingConsumer.consumerProfiles` 下，并把执行方 `agentAppId`
 * 写死进每条预设。这带来两个用户可见的坏行为：
 *
 *   1. 没配过预设的 bot 被拉进会议时一个角色都选不到；
 *   2. 预设里写死的 `agentAppId` 可能指向**另一个** bot（bootstrap 在当前 bot
 *      结构上不合格时会静默兜底换人），于是「拉 A 进会 → B 被拉进监听群」。
 *
 * 现在的不变量：**没有自己预设的 bot 继承 fleet 共享目录**
 * （`~/.botmux/config.json` 的 `vcMeetingAgent.consumerCatalog`），且共享目录里的
 * 条目从类型上就**没有** `agentAppId`——执行方在这一层绑定为「收到这场会议事件
 * 的那个 bot 自己」，于是「拉错 bot」在共享目录里不可表达。共享目录也没配过时用
 * 内置默认目录，所以任何 bot 被拉进会都直接有角色可跑，不需要先去 Dashboard 配。
 *
 * 操作者显式配置永远优先，共享目录只在该 bot 什么都没配时生效：
 *
 *   - per-bot `consumerProfiles`（显式空数组 = 「这个 bot 不要任何角色」）：原样
 *     沿用，**包括**里面的 `agentAppId`——操作者可以有意把不同角色分给不同 bot
 *     做多 agent 分工，读路径不能替他改主意；
 *   - 老模型的执行方策略（`agentCandidates` 等），那些 bot 继续走候选名单卡。
 *
 * 唯一的例外是**机器播种残留**（v2 带 `defaultProfileBootstrap` 出处标记，v1 按
 * 逐字段精确形状识别）：它不是操作者意图，读路径上直接忽略，让这些 bot 也回到
 * 共享目录——上面第 2 条坏行为正是这么来的（播种把另一个 bot 的 appId 焊进了
 * 预设），忽略掉它就等于在读路径上修好，磁盘残留原样留着，零迁移写盘。
 */
import {
  globalVcMeetingSharedConsumerCatalog,
  type VcMeetingSharedConsumerCatalog,
} from '../global-config.js';
import type { VcMeetingAgentConfig } from '../bot-registry.js';
import type { VcMeetingConsumerProfileConfig } from '../types.js';
import { logger } from '../utils/logger.js';
import {
  hasLegacyVcMeetingConsumerAgentPolicy,
  isLegacyVcMeetingDefaultConsumerSeedCandidate,
  isVcMeetingSeededConsumerProfileBlock,
} from './vc-meeting-consumer-profile-bootstrap.js';
import {
  BUILTIN_VC_MEETING_SHARED_CONSUMER_CATALOG,
  normalizeVcMeetingConsumerProfilesForgiving,
} from './vc-meeting-shared-consumer-catalog-store.js';

let warnedCatalogError: string | undefined;

/**
 * 校验一份「已绑定到某 bot」的预设数组。共享目录是全局的，一份坏目录不能让整个
 * fleet 的会议能力一起挂——坏条目逐条丢弃（与 Dashboard 读到的目录保持一致，
 * 否则页面上列着的角色 daemon 侧一个都不跑），并告警。每种错误只告警一次，
 * 避免每个会议事件刷屏。
 */
function validateBoundProfiles(
  profiles: VcMeetingConsumerProfileConfig[],
): VcMeetingConsumerProfileConfig[] {
  const result = normalizeVcMeetingConsumerProfilesForgiving(profiles);
  if (result.errors.length > 0) {
    const message = result.errors.join('; ');
    if (warnedCatalogError !== message) {
      warnedCatalogError = message;
      logger.warn(
        `[vc-agent] shared consumer catalog has invalid entries, they were ignored: ${message}. `
        + 'Fix vcMeetingAgent.consumerCatalog in ~/.botmux/config.json.',
      );
    }
  }
  return result.profiles;
}

/** 测试用：清掉「同一条错误只告警一次」的去重状态。 */
export function __resetSharedConsumerCatalogWarnState(): void {
  warnedCatalogError = undefined;
}

export interface BindVcMeetingConsumerCatalogDeps {
  /**
   * 便于测试注入；默认读全局配置。
   *
   * `undefined` = 「从没配置过」，会落到内置默认目录（与 Dashboard 读到的是同一
   * 个常量）。要表达「所有 bot 都不要角色」请返回 `{ profiles: [], ... }`。
   */
  readCatalog?: () => VcMeetingSharedConsumerCatalog | undefined;
}

/**
 * 这份 per-bot 预设是不是**机器播种**出来的（两代播种物都算）。
 *
 * v2 播种写了 `defaultProfileBootstrap` 出处标记；v1 没有标记，只能按逐字段精确
 * 形状识别（7 个字段逐字匹配，差一点就当操作者内容保留）。两代都会把执行方
 * `agentAppId` 焊进预设，也都可能焊的是另一个 bot——「拉 A 进会却把 B 拉进群」
 * 就是这么来的，所以两代都要让路给共享目录。
 */
function isSeededConsumerProfileBlock(meetingConsumer: VcMeetingAgentConfig['meetingConsumer']): boolean {
  return isVcMeetingSeededConsumerProfileBlock(meetingConsumer)
    || isLegacyVcMeetingDefaultConsumerSeedCandidate(meetingConsumer);
}

/** 把预设的执行方钉死为 `botAppId` 本人。 */
function bindToBot(
  profile: Omit<VcMeetingConsumerProfileConfig, 'agentAppId'> & { agentAppId?: string },
  botAppId: string,
): VcMeetingConsumerProfileConfig {
  return { ...profile, agentAppId: botAppId } as VcMeetingConsumerProfileConfig;
}

/**
 * 把会议角色预设绑定到某个 bot 的有效 VC 配置上。
 *
 * - bot 有操作者写的 `consumerProfiles` / 老模型执行方策略 → 原样返回
 * - bot 只有机器播种残留，或什么都没配 → 继承共享目录，`agentAppId` = `botAppId`
 * - 共享目录显式清空 / 校验不过 → 原样返回（没配过则用内置默认目录）
 *
 * 纯函数，不改入参。
 */
export function bindVcMeetingConsumerCatalogToBot(
  botAppId: string,
  cfg: VcMeetingAgentConfig,
  deps: BindVcMeetingConsumerCatalogDeps = {},
): VcMeetingAgentConfig {
  if (!botAppId) return cfg;

  // 操作者按老模型手写过执行方策略（agentCandidates / defaultAgentAppId ...）：
  // 那是显式的「就用我点名的这些 bot」，共享目录不去覆盖，会中仍走候选名单卡。
  if (hasLegacyVcMeetingConsumerAgentPolicy(cfg.meetingConsumer)) return cfg;

  // 操作者自己写的 per-bot 预设原样沿用（显式空数组 = 「这个 bot 不要任何角色」），
  // 里面的 agentAppId 也不动：把不同角色分给不同 bot 是操作者可以有意做的分工。
  //
  // 例外是历史播种残留：它不是操作者意图，既会永久遮蔽共享目录，里面的 agentAppId
  // 还可能指向另一个 bot。读路径直接当作「没有 per-bot 预设」走共享目录，磁盘残留
  // 原样留着，零迁移写盘。两代播种物都要认：v2 带 `defaultProfileBootstrap` 出处
  // 标记，v1（更早的版本升上来的）没有标记，只能按逐字段精确形状识别。
  const seeded = isSeededConsumerProfileBlock(cfg.meetingConsumer);
  if (!seeded && cfg.meetingConsumer?.consumerProfiles !== undefined) return cfg;

  // 共享目录不可用时的退回值。**关键**:如果 cfg 带的是机器播种残留(seeded),它里面
  // 焊死的 agentAppId 可能指向**另一个** bot——正是本 PR 要消灭的「拉 A 拉 B」。所以
  // seeded 情形绝不能原样 `return cfg`(那等于让 foreign appId 从 fallback 复活),必须
  // 把这些播种预设剥掉、退回「仅监听」。非 seeded(操作者内容/无 per-bot 预设)原样返回。
  const fallbackCfg: VcMeetingAgentConfig = seeded
    ? {
        ...cfg,
        meetingConsumer: {
          ...cfg.meetingConsumer,
          consumerProfiles: [],
          defaultMode: 'listenOnly' as const,
          defaultConsumerIds: [],
        },
      }
    : cfg;

  // 没配过共享目录 → 内置默认目录（一个「会议纪要」角色）。否则「装好就能用」不
  // 成立：43/47 个 bot 从来没有过 vcMeetingAgent 配置，被拉进会只能干听。
  // 显式清空（profiles: []）是持久的「都不要」，不会被内置默认顶掉。
  const catalog = (deps.readCatalog ?? globalVcMeetingSharedConsumerCatalog)()
    ?? BUILTIN_VC_MEETING_SHARED_CONSUMER_CATALOG;
  if (catalog.profiles.length === 0) return fallbackCfg;

  const bound = validateBoundProfiles(
    catalog.profiles.map(profile => bindToBot(profile, botAppId)),
  );
  // 整份目录都是坏条目时退回 fallbackCfg（seeded 已被中和成仅监听），而不是把这个
  // bot 的会议消费面配成空数组（空数组是「这个 bot 不要任何角色」的显式语义,坏数据
  // 不该表达它;seeded 焊死的 foreign appId 更不能从这里复活）。
  if (bound.length === 0) return fallbackCfg;

  const profileIds = new Set(bound.map(profile => profile.id));
  // per-bot 默认预设覆盖:这个 bot 若自己挑了 meetingConsumer.catalogDefaultConsumerId
  // (从共享目录的角色里挑一个),就用它作为默认角色——这是显式的「这个 bot 就跑这个
  // 角色」意图,即便共享目录全局默认是仅监听也照跑。没挑(或挑了目录里不存在的 id)则
  // 回落共享目录的全局默认(defaultMode + defaultConsumerIds 都跟随全局)。
  const perBotDefaultId = cfg.meetingConsumer?.catalogDefaultConsumerId;
  const hasPerBotOverride = typeof perBotDefaultId === 'string' && profileIds.has(perBotDefaultId);
  // 一个 bot 同时只跑一个角色：bot-registry 的 resolver 拒绝两条被选中的预设
  // 共用同一个 agentAppId，而绑定后所有预设的 agentAppId 都是这个 bot。取第一个
  // 命中的默认角色，其余留在目录里供会中卡片切换。
  const globalSelected = catalog.defaultMode === 'agents'
    ? catalog.defaultConsumerIds.filter(id => profileIds.has(id)).slice(0, 1)
    : [];
  const selected = hasPerBotOverride ? [perBotDefaultId] : globalSelected;
  return {
    ...cfg,
    meetingConsumer: {
      ...cfg.meetingConsumer,
      // 有共享目录就意味着操作者已经配置过会议消费面；不再要求每个 bot 各自
      // 打开 meetingConsumer.enabled，否则「共享」名不副实。
      enabled: cfg.meetingConsumer?.enabled ?? true,
      consumerProfiles: bound,
      // per-bot override 选中角色 → agents;否则跟随全局 defaultMode。
      // listenOnly 分支必须**显式清空 defaultConsumerIds**:cfg 若是 v2 播种残留,
      // 它自带 defaultConsumerIds:['minutes'] 会经上面的 `...cfg.meetingConsumer`
      // spread 存活;共享目录配成 listenOnly(保留 minutes 供会中切换)时,初始默认
      // 选择 resolveVcMeetingConsumerProfiles(cfg, undefined) 会拿这个残留把 minutes
      // 选成默认角色→被播种过的 bot 无视操作者的 listenOnly 自动激活(pi 复现坐实)。
      ...(selected.length > 0
        ? { defaultMode: 'agents' as const, defaultConsumerIds: selected }
        : { defaultMode: 'listenOnly' as const, defaultConsumerIds: [] }),
    },
  };
}
