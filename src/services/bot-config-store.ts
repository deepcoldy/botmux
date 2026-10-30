import { parseGroupCreationDefaults } from './group-creation-options.js';
import { normalizeStewardConfig } from '../core/decision-board/model.js';
import { formatZcodeModelChoice, resolveZcodeModelReference, zcodeAmbiguousModelIds } from './zcode-models.js';
import { parseSandboxNetworkPolicy, networkPolicySupportError } from '../core/sandbox-network-policy.js';
/**
 * `/config` 远程编辑 bot 运营字段。与 oncall-store / grant-prefs-store / brand-store
 * 同款：跨进程文件锁 + bots.json 原子写（rmwBotEntry），外加内存 registry 同步——
 * 因此 **无需重启 daemon**：读取实时配置的字段立即生效，spawn 时才读取的字段
 * （model / cliId / disableCliBypass / defaultWorkingDir）下一个新会话生效。
 *
 * 刻意只覆盖「运营字段」。secret（larkAppSecret / voice 凭证）绝不经此路径修改——
 * 聊天通道会被 IM 侧记录，引导新 bot / 换密钥仍走本机 `botmux setup`。授权额度
 * （grants / quota）由既有 `/grant` 负责，不在此重复。
 */
import { normalizeMojoConfig } from '../adapters/backend/mojo-types.js';
import { normalizeHerdrBackendConfig, resolveHerdrBackendConfig } from '../adapters/backend/types.js';
import { normalizeRemoteRunnerConfig } from '../adapters/backend/remote-runner-config.js';
import { parseTriggerUserAuthConfig } from './trigger-user-auth.js';
import { sharedBotSandboxAdvice, type SharedBotSandboxAdvice } from '../core/shared-bot-sandbox-advice.js';
import { resolveLocalSandboxMode, localSandboxApplies } from '../adapters/backend/sandbox.js';
import { backendSandboxCompatibilityError } from '../adapters/backend/session-backend-selector.js';
import type { BackendType } from '../adapters/backend/types.js';
import { resolveSandboxMode } from '../adapters/cli/sandbox-mode.js';
import { isSessionGroup } from './session-groups-store.js';
import type { BotConfig } from '../bot-registry.js';
import { getBot, getOwnerOpenId, readBotSkillPolicy } from '../bot-registry.js';
import { republishResolvedAllowedUsersDescriptor, scheduleAllowedUsersResolveRetryFromMutation } from '../bot-registry.js';
import { config } from '../config.js';
import { resolvePairedBackendId } from '../core/remote-cli-ids.js';
import { readAllowedUsersResolveCache, writeAllowedUsersResolveCache } from '../utils/allowed-users-cache.js';
import { rmwBotEntry } from './config-store.js';
import { resolveAllowedUsersWithMap } from '../im/lark/client.js';
import { detectUnusableOwnerEntries } from '../setup/owner-identity.js';
import { CLI_SELECT_OPTIONS, resolveCliSelection, selectionKeyForBot } from '../setup/cli-selection.js';
import { dropConfiguredCliRuntime } from '../adapters/cli/runtime.js';
import { expandHomePath } from '../utils/working-dir.js';
import { resolveTeamRoleFile } from '../core/role-resolver.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { sendCredFilePath } from '../adapters/cli/read-isolation.js';
import { logger } from '../utils/logger.js';
import { parseCustomPassthroughInput, parseCanTalkDaemonCommandsInput } from '../core/passthrough-commands.js';
import { parseStartupCommandsInput } from '../core/startup-commands.js';
import { isReservedPerBotEnvKey, nextPerBotEnv, parsePerBotEnvText, sanitizePerBotEnv, sessionEnvLock } from '../core/per-bot-env.js';
import { applyEnvOps, botEnvLayer, envLayerWithinBudget, isSessionEnvName, parseEnvOps, type EnvLayer, type EnvOp, type EnvOpsError } from '../core/session-env.js';
import { sessionEnvLockContextForBot } from '../core/session-env-resolve.js';
import { normalizeEnvPolicy } from '../core/env-policy.js';
import { normalizeFeedbackPolicy } from './feedback-policy.js';
import { normalizeOncallGroupPolicy } from './oncall-group-policy.js';
import { normalizeNoProgressNotifyPolicy } from './no-progress-notify-policy.js';
import { normalizePromptCacheConfig } from './prompt-cache-policy.js';
import { normalizeFeedbackPolicyLayer, type FeedbackPolicyLayer } from './feedback-policy-resolver.js';
import {
  notifyPinStreamingCardChanged,
  serializePinStreamingCardConfigChange,
} from './pin-streaming-card-change.js';
import {
  cliModelSupportsReasoningEffort,
  isCodexReasoningEffort,
  isConfigurableReasoningCliId,
  reasoningEffortsForCliModel,
} from './codex-reasoning-effort.js';
import { isCodexServiceTier, isCodexServiceTierCliId } from './codex-service-tier.js';
import { validateCodexServiceTier } from './codex-service-tier-catalog.js';
import { botOneShotEnv } from '../core/session-env-resolve.js';
import { checkCliAvailability } from '../setup/cli-availability.js';
import {
  MAX_CARD_ACTION_ACK_TIMEOUT_MS,
  MIN_CARD_ACTION_ACK_TIMEOUT_MS,
} from '../core/card-action-ack.js';
import { parseHiddenStreamingCardButtonsInput } from '../im/lark/streaming-card-buttons.js';
import { validateCliLaunchModeConfig } from '../core/cli-launch-mode.js';
import { defaultReplyDeliveryFor, supportsTranscriptReplyDeliveryForBot } from '../core/reply-delivery.js';
import { supportsZeroPromptInjection } from '../core/prompt-injection.js';
import { normalizeBotActorOwnerBindings } from '../core/bot-actor-owner-binding.js';

/**
 * 生效时机：
 *   • immediate     — 运行时读取实时 `bot.config`，热更新后下一条消息/事件即生效。
 *   • next-session  — spawn CLI 时才读取，当前运行中的会话需 `/restart` 重启才换新值；
 *                     新会话直接用新值。
 */
export type ConfigEffect = 'immediate' | 'next-session';

export type ConfigFieldKind = 'string' | 'stringList' | 'boolean' | 'number' | 'enum' | 'cli' | 'dir' | 'allowedUsers' | 'json';

export interface ConfigFieldSpec {
  /** 用户面命令里用的字段名（大小写不敏感匹配，见 {@link findConfigField}）。 */
  key: string;
  /** bots.json / 内存 BotConfig 上的实际字段。 */
  configKey: keyof BotConfig;
  kind: ConfigFieldKind;
  effect: ConfigEffect;
  /** 是否支持 `/config unset <field>`（清回默认）。boolean 字段用 `set off` 即可，无需 unset。 */
  clearable: boolean;
  /** kind==='boolean' 且默认值为 ON 的字段：持久化取反（只写显式 false，true
   *  删 key），展示时缺省渲染为 on。缺省（undefined）保持默认 OFF 语义。 */
  defaultOn?: boolean;
  /** kind==='enum' 时的合法取值（已小写）。 */
  enumValues?: readonly string[];
  /** kind==='enum' 且缺省即某个取值的字段：未设置时 `/config get` 显示该值而非 ∅。
   *  缺省随 bot 其它配置变化（如按 cliId）时给函数，展示时按当前 config 求值。 */
  enumDefault?: string | ((cfg: BotConfig) => string);
  /** kind==='string' 的最大长度（trim 后计），超出 coerce 报 too_long。缺省不限。 */
  maxLen?: number;
  /** kind==='number' 的闭区间下界；缺省仍只要求正整数。 */
  min?: number;
  /** kind==='number' 的闭区间上界；缺省不设上限。 */
  max?: number;
  /** kind==='stringList' 的自定义解析器（自由文本 → 归一化数组）。缺省用
   *  customPassthroughCommands 的分隔解析（逗号/换行或“空格+/”分隔，名字内
   *  空格归一为连字符）；带参数的命令行字段（如 startupCommands）须指定按
   *  逗号/换行分隔、保留内部空格的解析器。 */
  parseList?: (raw: string) => string[];
  /** 一句话说明，进 `/config help` / `/config get`。 */
  hint: string;
}

/**
 * Phase 1 可编辑的运营字段。**不含** allowedUsers 之外的权限字段、secret、brand
 * （绑定租户、需重启重建 client）、name（pm2 进程名，启动期绑定）。allowedUsers
 * 在此登记但走 {@link setBotAllowedUsers} 的专用异步路径（重解析 + 防自锁）。
 */
export const CONFIG_FIELDS: readonly ConfigFieldSpec[] = [
  { key: 'displayName', configKey: 'displayName', kind: 'string', effect: 'immediate', clearable: true, maxLen: 64, hint: '自定义展示名（dashboard 名册/会话列表用，≤64 字符）；不改飞书群内应用名；unset 回飞书名称' },
  { key: 'model', configKey: 'model', kind: 'string', effect: 'next-session', clearable: true, hint: 'CLI 模型名（如 opus）；unset 回 CLI 默认' },
  { key: 'codexRpcInput', configKey: 'codexRpcInput', kind: 'boolean', effect: 'next-session', clearable: true, hint: 'Codex/TraeX RPC 输入 on|off；off 显式使用终端输入，unset 跟随全局；Auto 启用时自动使用终端输入' },
  { key: 'reasoningEffort', configKey: 'reasoningEffort', kind: 'enum', effect: 'next-session', clearable: true, enumValues: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], hint: '支持的 CLI 上新会话默认思考强度 low|medium|high|xhigh|max|ultra；unset 回 CLI 默认' },
  { key: 'serviceTier', configKey: 'serviceTier', kind: 'enum', effect: 'next-session', clearable: true, enumValues: ['default', 'priority', 'ultrafast'], hint: 'Codex 新会话速度档位 default|priority|ultrafast；default 显式覆盖原生加速配置；unset 回 Codex 原生配置' },
  { key: 'cli', configKey: 'cliId', kind: 'cli', effect: 'next-session', clearable: false, hint: 'CLI 适配器（序号 1-16 或 id，如 claude-code）' },
  { key: 'launchShell', configKey: 'launchShell', kind: 'string', effect: 'next-session', clearable: true, hint: '启动 CLI 用的 shell（zsh|bash|fish|sh 或绝对路径），覆盖 $SHELL；用于 .bashrc/.zshrc 里 exec 切到别的 shell 导致会话起不来的场景；fish 用户把 PATH/nvm 放进 ~/.config/fish/config.fish，无需回填 bash/zsh；unset 回 $SHELL' },
  { key: 'lang', configKey: 'lang', kind: 'enum', effect: 'immediate', clearable: true, enumValues: ['zh', 'en'], hint: '机器人 UI 语言 zh|en；unset 回全局默认' },
  { key: 'skillInjection', configKey: 'skillInjection', kind: 'enum', effect: 'next-session', clearable: true, enumValues: ['global', 'prompt', 'off'], hint: 'botmux skills 注入方式（仅影响 codex/gemini 等全局 skills 目录的 CLI）：prompt=注入会话不落全局盘(默认)｜global=装进 CLI 全局目录(会被独立 CLI 看到)｜off=只留提示+botmux --help；切到/离开 global 需重启 daemon 才完全生效；unset 回机器级默认' },
  { key: 'defaultWorkingDir', configKey: 'defaultWorkingDir', kind: 'dir', effect: 'next-session', clearable: true, hint: '新话题默认工作目录（跳过仓库选择卡片）' },
  { key: 'brandLabel', configKey: 'brandLabel', kind: 'string', effect: 'immediate', clearable: true, hint: '卡片页脚品牌文案；unset 回默认 botmux 链接' },
  { key: 'replyFooterEnabled', configKey: 'replyFooterEnabled', kind: 'boolean', effect: 'immediate', clearable: false, defaultOn: true, hint: '回复页脚总开关 on|off（默认 on）；总开关关闭时保留各信息块配置' },
  { key: 'replyFooterBrand', configKey: 'replyFooterBrand', kind: 'boolean', effect: 'immediate', clearable: false, defaultOn: true, hint: '回复页脚品牌签名 on|off（默认 on）；总开关关闭时保留各信息块配置' },
  { key: 'replyFooterModel', configKey: 'replyFooterModel', kind: 'boolean', effect: 'immediate', clearable: false, defaultOn: true, hint: '回复页脚模型信息 on|off（默认 on）；总开关关闭时保留各信息块配置' },
  { key: 'replyFooterUsage', configKey: 'replyFooterUsage', kind: 'boolean', effect: 'immediate', clearable: false, defaultOn: true, hint: '回复页脚用量信息 on|off（默认 on）；总开关关闭时保留各信息块配置' },
  { key: 'replyFooterRecipients', configKey: 'replyFooterRecipients', kind: 'boolean', effect: 'immediate', clearable: false, defaultOn: true, hint: '回复页脚收件人及其 @ 通知 on|off（默认 on）；总开关关闭时保留各信息块配置' },
  { key: 'replyFooterVoice', configKey: 'replyFooterVoice', kind: 'boolean', effect: 'immediate', clearable: false, defaultOn: true, hint: '回复页脚语音总结按钮 on|off（默认 on）；总开关关闭时保留各信息块配置' },
  { key: 'usageDisplay', configKey: 'usageDisplay', kind: 'enum', effect: 'immediate', clearable: true, enumValues: ['streaming', 'footer', 'off'], hint: '用量显示位置:streaming=流式卡正文(默认)｜footer=回复卡页脚｜off=不显示' },
  { key: 'showReplyTiming', configKey: 'showReplyTiming', kind: 'boolean', effect: 'immediate', clearable: false, hint: '最终回复页脚分别显示等待和执行耗时 on|off（默认 off）；普通发送显示执行至回复，结束后显示最终耗时；等待含排队/准备，缺失计时则不显示' },
  { key: 'autoStartPrompt', configKey: 'autoStartOnGroupJoinPrompt', kind: 'string', effect: 'immediate', clearable: true, hint: '被拉进新群主动开工的首轮 prompt（配合 autoStartOnGroupJoin）' },
  { key: 'allowedUsers', configKey: 'allowedUsers', kind: 'allowedUsers', effect: 'immediate', clearable: false, hint: '管理员名单（邮箱/on_/ou_，逗号或空格分隔）；改后需加 确认' },
  { key: 'botActorOwnerBindings', configKey: 'botActorOwnerBindings', kind: 'json', effect: 'immediate', clearable: true, hint: 'Bot 调用者双 ID 到 Owner union/email 的严格 JSON 绑定；只用于 developer_default 凭据选择' },
  { key: 'skills', configKey: 'skills', kind: 'json', effect: 'next-session', clearable: true, hint: 'bot 级 skill policy JSON；unset 回底层 CLI 默认行为' },
  { key: 'feedback', configKey: 'feedback', kind: 'json', effect: 'immediate', clearable: true, hint: '最终回答反馈 JSON；默认关闭，enabled=true 后按本 bot 启用；unset 关闭' },
  { key: 'groupCreation', configKey: 'groupCreation', kind: 'json', effect: 'immediate', clearable: true, hint: '/g 默认配置 JSON：agents 名称/app ID 数组、tag 个人消息分组名、avatar=logo(默认)|name|off；unset 恢复默认' },
  { key: 'oncallGroup', configKey: 'oncallGroup', kind: 'json', effect: 'immediate', clearable: true, hint: '拉起 Oncall 群按钮：enabled 开关及 chatIds 生效群，默认关闭' },
  { key: 'disableStreamingCard', configKey: 'disableStreamingCard', kind: 'boolean', effect: 'immediate', clearable: false, hint: '关闭实时流式卡片 on|off' },
  { key: 'replyCardMode', configKey: 'replyCardMode', kind: 'enum', effect: 'immediate', clearable: true, enumValues: ['legacy', 'unified'], hint: '回答展示方式（下一轮生效）：legacy=默认模式｜unified=动态单卡模式；动态单卡限 Claude Code/Codex/Grok 普通飞书对话' },
  { key: 'hiddenStreamingCardButtons', configKey: 'hiddenStreamingCardButtons', kind: 'stringList', effect: 'immediate', clearable: true, parseList: parseHiddenStreamingCardButtonsInput, hint: '隐藏实时卡片按钮，逗号/空格分隔：output terminal writeLink compact stop close；unset 恢复全部' },
  { key: 'pinStreamingCard', configKey: 'pinStreamingCard', kind: 'boolean', effect: 'immediate', clearable: false, hint: '置顶当前公开实时卡片 on|off（失败不影响会话）' },
  { key: 'cotEnabled', configKey: 'cotEnabled', kind: 'boolean', effect: 'immediate', clearable: false, defaultOn: true, hint: '思考过程消息 on|off（默认 on）：turn 进行中把模型思考过程以飞书原生 CoT 消息（message_cot）流式展示（客户端需 PC ≥7.70 / 移动端 ≥7.74；支持 claude-code / codex / traex / pi 等适配器）。这是 bot 级总开关，单个群可用 /cot off 关闭' },
  { key: 'thinkingCardToolResult', configKey: 'thinkingCardToolResult', kind: 'boolean', effect: 'immediate', clearable: false, defaultOn: true, hint: '思考气泡是否贴工具输出 on|off（默认 on）：off 时气泡只保留思考段落与工具节点标题（工具名 · 命令/路径），不再附带命令输出/文件内容代码块，与 Claude Code 自身界面一致' },
  { key: 'replyCardShowTools', configKey: 'replyCardShowTools', kind: 'boolean', effect: 'immediate', clearable: false, defaultOn: true, hint: '动态单卡是否显示工具调用 on|off（默认 on）：仅 replyCardMode=unified 时生效，legacy 模式无效（切换模式保留该值）；off 时卡片隐藏工具节点、命令、结果与工具次数，思考摘要和公开进度仍显示；不影响原生思考气泡，/cot show 也不会显示被隐藏的工具' },
  { key: 'silentTurnReactions', configKey: 'silentTurnReactions', kind: 'boolean', effect: 'immediate', clearable: false, hint: '关闭无卡片模式下的 GoGoGo/DONE reaction 和 Codex App 追加指令确认回执 on|off' },
  { key: 'writableTerminalLinkInCard', configKey: 'writableTerminalLinkInCard', kind: 'boolean', effect: 'immediate', clearable: false, hint: '卡片内嵌可写终端链接 on|off' },
  { key: 'privateCard', configKey: 'privateCard', kind: 'boolean', effect: 'immediate', clearable: false, hint: '/card 发 owner-only 私有快照 on|off' },
  { key: 'replyCardActions', configKey: 'replyCardActions', kind: 'boolean', effect: 'immediate', clearable: false, hint: '回复卡右下角操作菜单（打开终端/切换模型/关闭会话）on|off，默认关闭' },
  { key: 'summaryMemory', configKey: 'summaryMemory', kind: 'boolean', effect: 'immediate', clearable: false, hint: '/summary 写入当前项目 summary.md 的问题解决记录 on|off' },
  { key: 'summaryMemoryPath', configKey: 'summaryMemoryPath', kind: 'string', effect: 'immediate', clearable: true, hint: '/summary 记忆文件路径，支持相对当前项目根目录或绝对路径；unset 回 summary.md' },
  { key: 'autoStartOnGroupJoin', configKey: 'autoStartOnGroupJoin', kind: 'boolean', effect: 'immediate', clearable: false, hint: '被拉进新群即主动开工 on|off' },
  { key: 'autoInviteOwnerOnGroupAdd', configKey: 'autoInviteOwnerOnGroupAdd', kind: 'boolean', effect: 'immediate', clearable: false, defaultOn: true, hint: 'bot 被拉进新群时自动把 owner 拉进群 on|off（默认 on）；off 适用于告警/oncall 批量事件群' },
  { key: 'autoStartOnNewTopic', configKey: 'autoStartOnNewTopic', kind: 'boolean', effect: 'immediate', clearable: false, hint: '话题群每个新话题自动开工 on|off' },
  { key: 'steward', configKey: 'steward', kind: 'json', effect: 'immediate', clearable: true, hint: '管家（决策看板）JSON：{"enabled":true,"chatId":"oc_…","guideMode":"append|replace","guideText":"自定义规则","autoJoinNewGroups":false,"autoJoinSoloGroups":true}；默认关闭；autoJoinNewGroups=拉新群时带上管家，默认开，只在关掉时写 false；autoJoinSoloGroups=只有你和一个 bot 的新群也带，默认关；unset 关闭（看板数据保留）' },
  { key: 'chatManagerEnabled', configKey: 'chatManagerEnabled', kind: 'boolean', effect: 'immediate', clearable: false, hint: '允许本 bot 被设为普通群负责人（默认接待者）on|off（默认 off）：开启后才提供会话内群负责人工具并允许 set，关闭后不免 @ 接话；clear/status 不受影响' },
  { key: 'worktreeMultiPicker', configKey: 'worktreeMultiPicker', kind: 'boolean', effect: 'immediate', clearable: false, hint: 'repo 卡片 worktree 选择器默认多仓库模式 on|off（卡片「切换多仓库选择器」按钮同款）' },
  { key: 'disableCliBypass', configKey: 'disableCliBypass', kind: 'boolean', effect: 'next-session', clearable: false, hint: '不加 CLI 审批/sandbox 绕过参数 on|off' },
  { key: 'codexAppCleanInput', configKey: 'codexAppCleanInput', kind: 'boolean', effect: 'immediate', clearable: false, hint: '实验性：Codex App 用户气泡只保留真实输入，Botmux 元数据走隐藏上下文；默认 off，从下一次 turn 派发生效，不改已有历史' },
  { key: 'codexCapacityRecovery', configKey: 'codexCapacityRecovery', kind: 'boolean', effect: 'immediate', clearable: true, hint: 'Codex 模型容量不足时自动续跑 on|off（默认 off）：仅明确 server_overloaded；每个任务最多注入两条续跑输入，可能留在原生上下文；非普通限流重试' },
  { key: 'suppressDeliveredFinalFailureNotice', configKey: 'suppressDeliveredFinalFailureNotice', kind: 'boolean', effect: 'next-session', clearable: true, hint: '实验性：已送达 final 后不再补发失败通知 on|off（默认 off）：同一轮同一次尝试已带回执送达显式 final 后，结构化转写（Codex 等）收尾失败只记日志、不再发「模型连接失败」；信任该 final，不比对事后续写文本；执行状态仍为失败；下个 worker 启动生效' },
  { key: 'noProgressNotify', configKey: 'noProgressNotify', kind: 'json', effect: 'immediate', clearable: true, hint: '无进展提醒：Codex CLI 可用 {"cliEnabled":true} 显式开启（下一个 worker 生效，默认 5/15 分钟提醒，无自动重试）；Codex App（#1162）：{"enabled":false} 仅静默 Lark 推送（看板 stalled 状态与 requires_attention 保留，立即生效）；{"timeoutMs":300000} 调整阈值（整数 10000–3600000ms，默认 90000，下一个 worker 进程生效，不影响对账超时）；unset 回默认' },
  { key: 'promptCache', configKey: 'promptCache', kind: 'json', effect: 'immediate', clearable: true, hint: 'Claude Code 提示缓存：{"ttl":"1h","keepalive":{"enabled":true,"idleMinutes":54,"maxPings":2,"activeHours":"10:00-23:00","minContextTokens":50000}}；逐字段覆盖全局 promptCache，未设的字段继承全局；ttl 下个会话生效，保活立即生效；unset 回落全局' },
  { key: 'promptInjection', configKey: 'promptInjection', kind: 'enum', effect: 'next-session', clearable: true, enumValues: ['default', 'none'], enumDefault: 'default', hint: '零 botmux 注入：none=仅传任务与附件，自动回传最终回复；default=恢复原有提示/技能配置。支持可自动获取最终回复的本地 CLI；新会话完整生效，已有历史不清除' },
  { key: 'envelopeInjection', configKey: 'envelopeInjection', kind: 'enum', effect: 'immediate', clearable: true, enumValues: ['auto', 'off'], hint: '每轮上下文注入方式：auto=支持的 CLI（claude-code）把提醒/白板经 hook 注入为系统提醒，输入框只留消息本身，不支持的自动回退｜off=内联（默认）；unset 回 off' },
  { key: 'topicUnavailablePolicy', configKey: 'topicUnavailablePolicy', kind: 'enum', effect: 'immediate', clearable: true, enumValues: ['legacy', 'stop'], enumDefault: () => 'legacy', hint: '原话题不可用时：legacy=保持原有发送和兜底行为（默认）｜stop=停止发送，查询异常暂停且不改发；unset 回 legacy' },
  { key: 'replyDelivery', configKey: 'replyDelivery', kind: 'enum', effect: 'next-session', clearable: true, enumValues: ['send', 'transcript'], enumDefault: cfg => defaultReplyDeliveryFor(cfg.cliId), hint: '最终回复投递方式：send=模型必须自己 botmux send（**所有 CLI 的缺省**，与上游一致）｜transcript=从 CLI 转写自动取最终回复发卡，模型不再被要求 botmux send（opt-in，需显式开启）；仅 claude-code 与 codex/traex/coco/hermes/mtr/pi/oh-my-pi/ebsd/grok/cursor 支持 transcript；系统提示需 /restart 才换新值，逐轮信封立即生效；unset 回缺省 send' },
  { key: 'senderTagHideEmail', configKey: 'senderTagHideEmail', kind: 'boolean', effect: 'immediate', clearable: false, hint: '隐藏 <sender> 邮箱 on|off（默认 off）：开启后只省略 email，保留姓名和 ID；不影响鉴权与 --mention-back。下一次新构造的输入生效，不清理历史或用户正文中的邮箱' },
  { key: 'senderTag', configKey: 'senderTag', kind: 'boolean', effect: 'immediate', clearable: false, defaultOn: true, hint: '每轮注入 <sender> 发言人标签 on|off（默认 on）：标注本轮是谁在说话（open_id/姓名/邮箱）。关掉后模型看不到发言人身份，多人会话里无法区分谁说的；--mention-back 不受影响（走 daemon 侧独立记录）。代价：/adopt 少一条识别本 bot 自产会话的指纹，dashboard 洞察无法从标签判断发言人类型与 A2A 对方名字' },
  { key: 'restrictGrantCommands', configKey: 'restrictGrantCommands', kind: 'boolean', effect: 'immediate', clearable: false, hint: '被授权人仅能纯对话、拦截斜杠命令 on|off' },
  { key: 'grantRequestToOwnerDm', configKey: 'grantRequestToOwnerDm', kind: 'boolean', effect: 'immediate', clearable: false, hint: '授权申请卡转投 owner 私聊 on|off（默认 off）：会话里没有管理员（群里查不到管理员、或私聊被挡）时，申请卡发到主 owner 私聊，申请人只收到中性回执；适合 owner 不进群的用法' },
  { key: 'trustSameOwnerBots', configKey: 'trustSameOwnerBots', kind: 'boolean', effect: 'immediate', clearable: false, defaultOn: true, hint: '信任同一 owner 的同机 Bot on|off（默认 on）：本机 bots.json 里管理员都是本 bot 管理员的 bot 可执行管理命令、未认出时也免授权对话，@ 本 bot 时同条消息点名的人自动获本群对话授权（额度/有效期同授权卡）；多一个本 bot 不认的管理员就不受信任；off 则同机 bot 只能对话' },
  { key: 'grantDelegateBots', configKey: 'grantDelegateBots', kind: 'stringList', effect: 'immediate', clearable: true, parseList: parseGrantDelegateBotsInput, hint: '委托授权的外部 bot 名单（发送方在本 bot 视角的 ou_ open_id 或 cli_ app_id，逗号/空格分隔）：名单里的 bot @ 本 bot 时同条消息点名的人自动获本群对话授权（talk-only，额度/有效期同授权卡）；同机 Bot 信任之外的第二条委托来源；unset 清空（默认空，行为与现状一致）' },
  { key: 'p2pOpen', configKey: 'p2pOpen', kind: 'boolean', effect: 'immediate', clearable: false, hint: '私聊对话全开 on|off：任何能看到本 bot 的人都可私聊（只放行对话；管理操作默认仍只认 allowedUsers，被 canTalkDaemonCommands 显式降级的命令除外）；不影响群聊' },
  { key: 'p2pMode', configKey: 'p2pMode', kind: 'enum', effect: 'immediate', clearable: true, enumValues: ['thread', 'chat', 'group'], hint: '私聊单聊模式 thread|chat|group；默认 chat=扁平连续会话，thread=每条 DM 独立会话，group=每条 DM 自动建专属会话群（chat/unset 回默认）' },
  { key: 'cardActionAckTimeoutMs', configKey: 'cardActionAckTimeoutMs', kind: 'number', effect: 'immediate', clearable: true, min: MIN_CARD_ACTION_ACK_TIMEOUT_MS, max: MAX_CARD_ACTION_ACK_TIMEOUT_MS, hint: '本 bot 所有卡片动作的同步 ACK 等待时长（500–2500ms，默认 2500ms）；超时先提示后台处理，插件可继续执行；unset 回默认' },
  { key: 'maxLiveWorkers', configKey: 'maxLiveWorkers', kind: 'number', effect: 'immediate', clearable: true, hint: '最大常驻会话数；超过后最久未用的会话自动休眠（退出后台进程和 CLI、回收内存，下条消息冷恢复）；unset=默认 30' },
  { key: 'idleSuspendMinutes', configKey: 'idleSuspendMinutes', kind: 'number', effect: 'immediate', clearable: true, hint: '空闲会话自动休眠超时（分钟，正整数）；会话持续空闲超过该时长即自动休眠回收内存，与最大常驻会话数互不影响；unset=关闭（默认，空闲不超时，仅受数量上限约束）' },
  { key: 'customPassthroughCommands', configKey: 'customPassthroughCommands', kind: 'stringList', effect: 'immediate', clearable: true, hint: '额外放行透传给 CLI 的 slash 命令（逗号/换行分隔，或“空格+/”分隔，如 /goal /export；名字内空格归一为连字符，/Ultra Goal → /ultra-goal）；unset 回仅内置白名单' },
  { key: 'canTalkDaemonCommands', configKey: 'canTalkDaemonCommands', kind: 'stringList', effect: 'immediate', clearable: true, parseList: parseCanTalkDaemonCommandsInput, hint: '把列出的 daemon 命令权限从 canOperate（仅管理员）降到 canTalk（对话放行即可用），如 /status /help；仅认 daemon 命令，透传命令无效；unset 回全部仅管理员' },
  { key: 'startupCommands', configKey: 'startupCommands', kind: 'stringList', effect: 'next-session', clearable: true, parseList: parseStartupCommandsInput, hint: '开会话后、首条消息前自动发给 CLI 的命令（逗号/换行分隔，可带参数，如 /effort ultracode）；unset 回不发' },
  { key: 'envPolicy', configKey: 'envPolicy', kind: 'json', effect: 'next-session', clearable: true, hint: '进程环境继承策略 JSON：{"mode":"strict","inherit":["HTTPS_PROXY"]}；默认 inherit 兼容旧行为。仅变量名，不填值；下次 worker 冷启动生效，旧 pane 策略不匹配时拒绝复用；unset 恢复默认' },
  { key: 'sandboxNetworkPolicy', configKey: 'sandboxNetworkPolicy', kind: 'json', effect: 'next-session', clearable: true, hint: 'Linux 本地 PTY oncall 沙箱的公网/内网目标 IP 策略；version=1，public/private 各含 mode: allow|block|allowlist|denylist 和 rules[{cidr,protocol?,ports?}]；不支持域名或宿主 MCP/Unix IPC；下个新会话生效，unset 恢复 sandboxNetwork' },
  { key: 'env', configKey: 'env', kind: 'json', effect: 'next-session', clearable: true, hint: 'per-bot 环境变量，接受 JSON（如 {"ANTHROPIC_BASE_URL":"…","ANTHROPIC_AUTH_TOKEN":"…"}）、{"env":{…}} settings 片段、.env / export KEY=… 行或 exec env 启动脚本（让本 bot 走 GLM/第三方服务商，或设 HTTPS_PROXY；保留键如 CLAUDE_CONFIG_DIR 会被拒绝）；注入到本 bot 的 CLI 进程，下个会话生效；值不显示（脱敏）；unset 清除' },
  { key: 'envUnset', configKey: 'envUnset', kind: 'stringList', effect: 'next-session', clearable: true, parseList: parseEnvUnsetInput, hint: '在本 bot 的会话里去掉的继承环境变量名（逗号/空格/换行分隔，如 BYTECLOUD_AUTH_AS HTTPS_PROXY）；只对新会话生效，运行中的会话重启后生效；botmux 保留变量与 PATH/HOME 不能去掉；与 Dashboard「Bot 配置 → 运行环境 → 会话环境变量」同一份配置；unset 清除' },
  { key: 'codexAuthSync', configKey: 'codexAuthSync', kind: 'enum', effect: 'next-session', clearable: true, enumValues: ['shared', 'isolated'], hint: 'Codex 鉴权策略：shared=保持旧行为（非沙箱直接使用全局 ~/.codex；沙箱冷启动同步全局 auth 到 per-bot CODEX_HOME）｜isolated=无论是否启用沙箱都使用 per-bot CODEX_HOME，绝不复制全局凭证，需在该目录单独执行 codex login --with-api-key' },
  { key: 'credentialsSourceDir', configKey: 'credentialsSourceDir', kind: 'dir', effect: 'next-session', clearable: true, hint: 'CLI 凭证来源目录（如 ~/accounts/acct-b，内按 CLI 分子目录：claude/.credentials.json）：沙箱 bot 每次冷启动从这里复制凭证，而不是用本机共享登录；来源不可用即拒绝启动、绝不回退共享登录；目前仅支持 claude-code；完全未开沙箱的 bot 不生效（仍用全局登录），已开沙箱却无法重定向数据目录（wrapperCli / adapter 不支持 / 缺 SESSION_DATA_DIR）则拒绝启动；token 刷新由外部负责；unset 回共享登录' },
  { key: 'codexInstancePool', configKey: 'codexInstancePool', kind: 'json', effect: 'next-session', clearable: true, hint: '会话级 Codex 实例：显式 defaultInstanceId 与 instances[{id,codexHome,weight}]，weight默认1；scope=ordinary-feishu，strategy=random。仅新会话分配，已有会话保持绑定。使用 botmux codex-instances check 检查本机目录。' },
  { key: 'triggerUserAuth', configKey: 'triggerUserAuth', kind: 'json', effect: 'next-session', clearable: true, hint: '按触发人身份调用 CLI（默认关闭）：开启后本 bot 调 lark-cli / bytedcli 用「发这条消息的人」自己的授权，而不是本机登录态。JSON 形如 {"enabled":true,"tools":["lark-cli","bytedcli"]}；tools 省略=全部。未授权时 lark-cli / bytedcli 一律拒绝（拒绝消息里会附授权链接，点开后重试即可），不会用 bot 或任何人的身份代跑；fallback 字段仅为兼容旧配置保留，当前不再改变行为。注意 bytedcli 没有 bot 身份，对它 fallback 恒等于失败。可选 credentialSource：auto（默认）：本机未绑定中心化平台时等同 local；已绑定时先向平台取该人的短期凭据（平台保管与续期），取不到则用本机已有的授权，再没有就拒绝并给平台授权链接，已绑定的机器绝不再自动发起本机扫码。platform：只用平台，未绑定或不可达一律拒绝。local：只用本机扫码，不咨询平台。非法取值会被拒绝保存。可选 delegateOnMention（默认 true）：本 bot 在真人直接发起的一轮里用 botmux send --mention 交接给同机 bot 时，对方以这位发起人的身份调用工具；设为 false 关闭。可选 gitHost（如 code.example.com）让该代码平台的 git 推送也按当轮身份鉴权，并把 SSH 远端改写成 HTTPS；可选 gitTokenExchangeUrl（https）作为 bytedcli 取不到 JWT 时的兜底换取端点。下个会话生效；unset 清除（关闭）' },
  { key: 'larkToolBinding', configKey: 'larkToolBinding', kind: 'boolean', defaultOn: true, effect: 'next-session', clearable: true, hint: 'lark-cli 绑定当前机器人应用身份 on|off（默认 on）：会话内 lark-cli 默认使用当前 bot 凭证并允许 --profile 切换宿主 profile；设为 off 则完全不注入当前 bot 凭据；需 /restart 重启或新建会话生效' },
  { key: 'backendType', configKey: 'backendType', kind: 'enum', effect: 'next-session', clearable: true, enumValues: ['pty', 'tmux', 'herdr', 'zellij', 'zmx', 'riff', 'mojo', 'remote-runner'], hint: '会话后端类型：pty=本地 PTY 子进程（默认）｜tmux=tmux 会话｜herdr=herdr 终端复用｜zellij=zellij 多路复用｜zmx=ZMX >=0.7.0 纯文本持久会话（无 Web TUI）｜riff=远程 riff agent 服务｜mojo=远程 mojo agent（headless mojo CLI）｜remote-runner=外置 provider；选 riff 时需配置 riff 字段，mojo/remoteRunner 字段可选；unset 回 pty' },
  { key: 'riff', configKey: 'riff', kind: 'json', effect: 'next-session', clearable: true, hint: 'riff 后端配置 JSON（baseUrl/agent/model/jwt 等），仅 backendType=riff 时生效；多用户共享主机上，用 jwtHome 指向该 bot 归属用户的 home（绝对路径）以读到他自己的 ByteCloud 登录态；unset 清除' },
  { key: 'mojo', configKey: 'mojo', kind: 'json', effect: 'next-session', clearable: true, hint: 'mojo 后端配置 JSON，仅 backendType=mojo 时生效，全部可选：cloud/localDaemon/baseUrl/ppeEnv/workspaceId/agentId/idleTimeoutSec/stream/systemPrompt/jwt/jwtEnv/env；model 与二进制路径请用顶层 model / cliPathOverride（写在此处会被拒绝）；unset 清除' },
  { key: 'remoteRunner', configKey: 'remoteRunner', kind: 'json', effect: 'next-session', clearable: true, hint: '通用 Remote Runner 协议配置 JSON（expectedProvider/requiredCapabilities/handshakeTimeoutMs/operationTimeoutMs）；provider 可执行文件用 cliPathOverride 指定；不得写入凭据；unset 清除' },
  { key: 'herdr', configKey: 'herdr', kind: 'json', effect: 'next-session', clearable: true, hint: 'herdr 后端放置配置 JSON，仅 backendType=herdr 时生效，字段全部可选：sessionName（宿主 Herdr 会话名，默认 botmux，指向别的会话时该会话必须已在运行）/placement（workspace=每话题新工作区，默认｜tab=目标工作区新开 Tab｜split=目标 Tab 分屏）/workspace（目标工作区 id 或标签）/tab（目标 Tab id 或标签）/splitDirection（right，默认｜down）/chatTypes（group/p2p 数组，缺省对所有会话生效）；非法字段会被拒绝，空对象或 unset 清除' },
];

/** 大小写不敏感地按 key 找字段 spec。 */
export function findConfigField(key: string): ConfigFieldSpec | undefined {
  const requested = key.trim().toLowerCase();
  // [legacy-thinkingCard] 旧字段名仍可写；随 normalizeCotEnabled 一并移除（不早于 v3.33.0）。
  let k = requested === 'thinkingcard' ? 'cotenabled' : requested;
  if (k === 'bindlarkapp' || k === 'larkappbinding') k = 'larktoolbinding';
  return CONFIG_FIELDS.find(f => f.key.toLowerCase() === k);
}

/** 可设置字段名列表（用于报错提示 / help）。 */
export function settableFieldKeys(): string[] {
  return CONFIG_FIELDS.map(f => f.key);
}

/** 把 on/off 类输入解析成布尔，无法识别 → undefined。 */
export function parseBooleanValue(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (['on', 'true', '1', 'yes', 'y', 'enable', 'enabled', '开', '是'].includes(v)) return true;
  if (['off', 'false', '0', 'no', 'n', 'disable', 'disabled', '关', '否'].includes(v)) return false;
  return undefined;
}

/** 展示某字段当前值的人类可读文本。`cfg` 供 enumDefault 为函数的字段求缺省值。 */
function formatFieldValue(spec: ConfigFieldSpec, value: unknown, cfg: BotConfig): string {
  if (spec.configKey === 'codexRpcInput' && typeof value !== 'boolean') return 'inherit';
  if (spec.kind === 'boolean') return (spec.defaultOn ? value !== false : value === true) ? 'on' : 'off';
  if (spec.kind === 'allowedUsers' || spec.kind === 'stringList') {
    const arr = Array.isArray(value) ? value : [];
    return arr.length ? arr.join(', ') : '∅';
  }
  // env may hold secrets (e.g. ANTHROPIC_AUTH_TOKEN). NEVER render the values
  // anywhere chat-visible (/config get): show key names with masked values only.
  if (spec.configKey === 'env') {
    const obj = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>) : null;
    const keys = obj ? Object.keys(obj) : [];
    return keys.length ? keys.map(k => `${k}=••••`).join(', ') : '∅';
  }
  // riff / mojo 配置可含 secret（jwt / env 值）。聊天可见渲染（/config get、配置卡）
  // 与 applyConfigField 的变更日志都走本函数——结构可见、值打码。
  // ⚠️ 漏掉任一个都会让它落进下面的通用 json 分支被 JSON.stringify 原样输出，
  // 即把 jwt 明文发到聊天里。新增带 secret 的后端配置块时必须同步加进来。
  if (spec.configKey === 'riff' || spec.configKey === 'mojo') {
    const obj = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>) : null;
    if (!obj || Object.keys(obj).length === 0) return '∅';
    return Object.entries(obj).map(([k, v]) => {
      if (k === 'jwt') return 'jwt=••••';
      if (k === 'env') {
        const keys = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as object) : [];
        return `env={${keys.map(x => `${x}=••••`).join(', ')}}`;
      }
      return `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`;
    }).join(', ');
  }
  if (spec.kind === 'json') {
    if (spec.configKey === 'codexInstancePool' && value && typeof value === 'object') {
      const pool = value as NonNullable<BotConfig['codexInstancePool']>;
      return `enabled=${pool.enabled}, default=${pool.defaultInstanceId}, instances=${pool.instances?.map(i => `${i.id}:${i.weight ?? 1}`).join(', ') ?? '?'}`;
    }
    return value === undefined || value === null ? '∅' : JSON.stringify(value);
  }
  if (value === undefined || value === null || value === '') {
    const d = typeof spec.enumDefault === 'function' ? spec.enumDefault(cfg) : spec.enumDefault;
    return d ?? '∅';
  }
  return String(value);
}

export interface ConfigSnapshotRow {
  key: string;
  value: string;
  effect: ConfigEffect;
}

/** 当前可编辑字段的快照（供 `/config get`）。不含 secret。 */
export function getConfigSnapshot(larkAppId: string): {
  ok: true;
  rows: ConfigSnapshotRow[];
  info: { cliId: string; brand: string; resolvedAdmins: number; workingDirs: string[] };
} | { ok: false } {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false }; }
  const cfg = bot.config;
  const rows: ConfigSnapshotRow[] = CONFIG_FIELDS.map(spec => ({
    key: spec.key,
    value: spec.kind === 'cli'
      ? selectionKeyForBot(cfg.cliId, cfg.wrapperCli, cfg.cliLaunchMode)
      : formatFieldValue(spec, (cfg as any)[spec.configKey], cfg),
    effect: spec.effect,
  }));
  return {
    ok: true,
    rows,
    info: {
      cliId: cfg.cliId,
      brand: cfg.brand ?? 'feishu',
      resolvedAdmins: bot.resolvedAllowedUsers.length,
      workingDirs: cfg.workingDirs ?? (cfg.workingDir ? [cfg.workingDir] : []),
    },
  };
}

export type ApplyFieldResult =
  | { ok: true; oldText: string; newText: string; effect: ConfigEffect }
  | { ok: false; reason: 'bot_not_registered' | 'bot_not_in_config' | string };

// 展示名热更新钩子：daemon 启动时注册。displayName 落盘后立即刷新 dashboard
// descriptor + SessionRow.botName（否则要等重启才换名）。放在 store 层是为了
// 让 /config displayName（IM 路径）和 dashboard PUT 共享同一刷新点。
let displayNameRefresher: (() => void) | null = null;
export function setDisplayNameRefresher(fn: (() => void) | null): void {
  displayNameRefresher = fn;
}

/**
 * Dashboard env save. Unlike {@link applyConfigField}, the merged map is
 * computed INSIDE the bots.json file lock from the on-disk `env`, so two
 * concurrent merge/remove saves can't lose each other's keys (computing from
 * an in-memory snapshot first would let the later write resurrect a removed
 * key or drop a concurrently added one). `incoming` must already be
 * sanitized (coerceConfigValue). Returns the persisted key names.
 */
export async function applyPerBotEnvChange(
  larkAppId: string,
  change: { incoming: Record<string, string>; mode: 'replace' | 'merge'; remove?: readonly string[] },
): Promise<{ ok: true; envKeys: string[] } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const r = await rmwBotEntry<Record<string, string> | null | 'layer_too_large'>(larkAppId, (entry) => {
    const prevLayer = botEnvLayer(entry);
    const prev = sanitizePerBotEnv(entry.env);
    const next = nextPerBotEnv({ prev, ...change });
    // Same pane-argv budget as the session-env editor: the whole bot layer
    // (`env` set + `envUnset` removals) must fit a tmux pane start command.
    // Shrinking stays allowed, so an already-oversized layer stays fixable.
    if (!envLayerWithinBudget(prevLayer, botEnvLayer({ env: next ?? undefined, envUnset: entry.envUnset }))) {
      return { write: false, result: 'layer_too_large' };
    }
    if (next) entry.env = next;
    else delete entry.env;
    return { write: true, result: next };
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.result === 'layer_too_large') return { ok: false, reason: 'layer_too_large' };
  const spec = findConfigField('env')!;
  const oldText = formatFieldValue(spec, bot.config.env, bot.config);
  bot.config.env = r.result ?? undefined;
  logger.info(`[config:${larkAppId}] set env (${change.mode}): ${oldText} -> ${formatFieldValue(spec, bot.config.env, bot.config)}`);
  return { ok: true, envKeys: r.result ? Object.keys(r.result).sort() : [] };
}

/** `/botconfig envUnset` input: names only, invalid or non-removable ones dropped. */
function parseEnvUnsetInput(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).filter(k => isSessionEnvName(k) && sessionEnvLock(k) === null))].sort();
}

/** `/botconfig grantDelegateBots` input：逗号/空白分隔的 ou_ open_id / cli_ app_id，trim、去空白项、去重。 */
function parseGrantDelegateBotsInput(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean))];
}

/**
 * The Dashboard write path for the bot layer: validates raw ops against THIS
 * bot's lock context (identity-wrapper names are locked only while that
 * wrapper is on) before applying them.
 */
export async function applyBotSessionEnvRequest(
  larkAppId: string,
  rawOps: unknown,
): Promise<{ ok: true; layer: EnvLayer } | { ok: false; reason: EnvOpsError | string; key?: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const parsed = parseEnvOps(rawOps, sessionEnvLockContextForBot(bot.config));
  if (!parsed.ok) return { ok: false, reason: parsed.error, ...(parsed.key ? { key: parsed.key } : {}) };
  return applyBotSessionEnvOps(larkAppId, parsed.ops);
}

/**
 * Dashboard session-env save for the bot layer (`env` = set, `envUnset` =
 * unset). Like {@link applyPerBotEnvChange} the ops are applied INSIDE the
 * bots.json file lock against the on-disk entry, so concurrent edits of
 * different keys never lose each other. `ops` must already be validated
 * (parseEnvOps with this bot's lock context).
 */
export async function applyBotSessionEnvOps(
  larkAppId: string,
  ops: readonly EnvOp[],
): Promise<{ ok: true; layer: EnvLayer } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const r = await rmwBotEntry<EnvLayer | 'layer_too_large'>(larkAppId, (entry) => {
    const prev = botEnvLayer(entry);
    const next = applyEnvOps(prev, ops);
    if (!envLayerWithinBudget(prev, next)) return { write: false, result: 'layer_too_large' };
    if (Object.keys(next.set).length) entry.env = next.set;
    else delete entry.env;
    if (next.unset.length) entry.envUnset = next.unset;
    else delete entry.envUnset;
    return { write: true, result: next };
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.result === 'layer_too_large') return { ok: false, reason: 'layer_too_large' };
  bot.config.env = Object.keys(r.result.set).length ? r.result.set : undefined;
  bot.config.envUnset = r.result.unset.length ? r.result.unset : undefined;
  // Names only — values may be credentials.
  logger.info(`[config:${larkAppId}] session env: ${ops.map(op => `${op.op} ${op.key}`).join(', ')}`);
  return { ok: true, layer: r.result };
}

/**
 * 写入并热更新一个**已解析**的字段值（string / boolean / null=清除）。
 * 调用方负责按 kind 校验后再传值；本函数只负责落盘 + 同步内存。
 * 不处理 allowedUsers（异步，见 {@link setBotAllowedUsers}）。
 */
export async function applyConfigField(
  larkAppId: string,
  spec: ConfigFieldSpec,
  value: unknown,
): Promise<ApplyFieldResult> {
  if (spec.configKey === 'pinStreamingCard') {
    return serializePinStreamingCardConfigChange(
      larkAppId,
      () => applyConfigFieldInternal(larkAppId, spec, value),
    );
  }
  return applyConfigFieldInternal(larkAppId, spec, value);
}

async function applyConfigFieldInternal(
  larkAppId: string,
  spec: ConfigFieldSpec,
  value: unknown,
): Promise<ApplyFieldResult> {
  if (spec.kind === 'allowedUsers') return { ok: false, reason: 'use_setBotAllowedUsers' };
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  if (spec.configKey === 'envPolicy' && value !== null) {
    try { value = normalizeEnvPolicy(value); } catch { return { ok: false, reason: 'invalid_env_policy' }; }
  }
  if (spec.configKey === 'sandboxNetworkPolicy' && value !== null) {
    try {
      value = parseSandboxNetworkPolicy(value);
      // Judge the backend new sessions launch on: the override, else the
      // daemon default (tmux unless BACKEND_TYPE says otherwise), CLI-paired.
      const backendType = resolvePairedBackendId(bot.config.cliId, bot.config.backendType, config.daemon.backendType) ?? 'pty';
      const reason = networkPolicySupportError({ platform: process.platform, backendType, sandbox: bot.config.sandbox, policy: value });
      if (reason) return { ok: false, reason };
    } catch (error) { return { ok: false, reason: (error as Error).message }; }
  }
  const previousPinStreamingCard = spec.configKey === 'pinStreamingCard'
    ? bot.config.pinStreamingCard === true
    : undefined;
  const oldText = spec.kind === 'cli'
    ? selectionKeyForBot(bot.config.cliId, bot.config.wrapperCli, bot.config.cliLaunchMode)
    : formatFieldValue(spec, (bot.config as any)[spec.configKey], bot.config);

  // 空数组（stringList 全被过滤）等价清除，bots.json 保持干净。
  // replyDelivery 的 send / transcript 都显式落盘；缺省为 send，只有 unset 才删 key。
  const effective = spec.kind === 'stringList' && Array.isArray(value) && value.length === 0 ? null
    : value;
  const nextCliId = spec.kind === 'cli' && typeof effective === 'string'
    ? resolveCliSelection(effective).cliId
    : bot.config.cliId;
  const nextModel = spec.configKey === 'model'
    ? typeof effective === 'string' && effective.trim() ? effective.trim() : undefined
    : bot.config.model;
  const nextServiceTier = spec.configKey === 'serviceTier'
    ? isCodexServiceTier(effective) ? effective : undefined
    : bot.config.serviceTier;
  if (nextServiceTier && nextServiceTier !== 'default' && isCodexServiceTierCliId(nextCliId)) {
    const cliPath = bot.config.cliRuntime?.executable
      ?? (bot.config.cliRuntime ? undefined : bot.config.cliPathOverride);
    const availability = checkCliAvailability({ cliId: nextCliId, cliPathOverride: cliPath });
    const tierCheck = await validateCodexServiceTier({
      cliBin: availability.resolvedPath ?? availability.command ?? '',
      env: botOneShotEnv(process.env, bot.config),
      model: nextModel,
      serviceTier: nextServiceTier,
    });
    if (!tierCheck.ok) {
      return {
        ok: false,
        reason: `service_tier_${tierCheck.error}`,
      };
    }
  }

  const r = await rmwBotEntry<string | null>(larkAppId, (entry) => {
    // Snapshot for the pane-argv budget check on env / envUnset below (the
    // callback mutates `entry` in place before the generic write branch).
    const prevEnvLayer = spec.configKey === 'env' || spec.configKey === 'envUnset'
      ? botEnvLayer(entry)
      : undefined;
    if (entry.replyCardMode === 'final-only') {
      entry.replyCardMode = 'unified';
      entry.disableStreamingCard = true;
    }
    const cliSelection = spec.kind === 'cli' && effective !== null
      ? typeof effective === 'string'
        ? resolveCliSelection(effective)
        : effective && typeof effective === 'object' && !Array.isArray(effective)
          ? effective as ReturnType<typeof resolveCliSelection>
          : undefined
      : undefined;
    const currentCliId = typeof entry.cliId === 'string' && entry.cliId.trim()
      ? entry.cliId.trim()
      : bot.config.cliId;
    const nextCliId = cliSelection
      ? cliSelection.cliId
      : spec.configKey === 'cliId' && effective !== null && typeof effective === 'string'
        ? effective.trim()
      : currentCliId;
    const currentModel = typeof entry.model === 'string' && entry.model.trim()
      ? entry.model.trim()
      : undefined;
    const zeroPrompt = spec.configKey === 'promptInjection'
      ? effective === 'none'
      : entry.promptInjection === 'none';
    // 后端按新会话 spawn 时的**生效值**判断：覆盖值，否则 daemon 默认后端，再按 CLI 配对
    // （与 resolvePairedSpawnBackendType 同一规则）——spawnCli 按它强制校验，这里放过的
    // 组合新会话会全部起不来，拦下的组合则是 spawn 本来能跑的。
    const nextBackendOverride = spec.configKey === 'backendType' ? effective : entry.backendType;
    if (zeroPrompt && !supportsZeroPromptInjection(nextCliId, {
      backendType: resolvePairedBackendId(
        nextCliId,
        typeof nextBackendOverride === 'string' ? nextBackendOverride : undefined,
        config.daemon.backendType,
      ),
      codexRpcInput: spec.configKey === 'codexRpcInput' ? effective === true : entry.codexRpcInput === true,
      sandbox: spec.configKey === 'sandbox' ? effective as (boolean | 'off' | 'oncall' | 'scratch') : entry.sandbox,
    })) {
      return { write: false, result: 'zero_prompt_unsupported' };
    }
    const nextModel = spec.configKey === 'model'
      ? typeof effective === 'string' && effective.trim()
        ? effective.trim()
        : undefined
      : currentModel;
    const currentReasoningEffort = isCodexReasoningEffort(entry.reasoningEffort)
      ? entry.reasoningEffort
      : undefined;
    const nextReasoningEffort = spec.configKey === 'reasoningEffort'
      ? effective === null
        ? undefined
        : isCodexReasoningEffort(effective)
          ? effective
          : undefined
      : currentReasoningEffort;
    if (spec.configKey === 'reasoningEffort' && effective !== null
        && (!nextReasoningEffort || !isConfigurableReasoningCliId(nextCliId))) {
      return { write: false, result: 'reasoning_effort_not_supported' };
    }
    if (nextReasoningEffort && isConfigurableReasoningCliId(nextCliId)
        && !cliModelSupportsReasoningEffort(nextCliId, nextModel, nextReasoningEffort)) {
      return { write: false, result: 'reasoning_effort_not_supported_by_model' };
    }
    const currentServiceTier = isCodexServiceTier(entry.serviceTier)
      ? entry.serviceTier
      : undefined;
    const nextServiceTier = spec.configKey === 'serviceTier'
      ? effective !== null && isCodexServiceTier(effective)
        ? effective
        : undefined
      : currentServiceTier;
    if (spec.configKey === 'serviceTier' && effective !== null
        && (!nextServiceTier || !isCodexServiceTierCliId(nextCliId))) {
      return { write: false, result: 'service_tier_not_supported' };
    }
    // transcript 依赖 CLI 有转写采集通道；没有的 CLI（或当前沙箱下采集不可用）拒绝
    // 写入，而不是落盘后运行时静默回落 send（会让模型以为不用 send 却没人转发）。
    if (spec.configKey === 'replyDelivery' && effective === 'transcript'
        && !supportsTranscriptReplyDeliveryForBot(nextCliId, { sandbox: entry.sandbox })) {
      return { write: false, result: 'reply_delivery_unsupported' };
    }
    if (cliSelection) {
      const adapterChanged = currentCliId !== cliSelection.cliId;
      entry.cliId = cliSelection.cliId;
      if (cliSelection.wrapperCli) entry.wrapperCli = cliSelection.wrapperCli;
      else delete entry.wrapperCli;
      if (cliSelection.cliLaunchMode) entry.cliLaunchMode = cliSelection.cliLaunchMode;
      else delete entry.cliLaunchMode;
      // A structured runtime asserts one adapter contract. A /config-driven
      // adapter switch must not strand it: codex↔kimi would otherwise reload
      // legally and silently run one family's binary under the other's TUI
      // contract. Clear the descriptor and its equal downgrade shadow using
      // the same rule as setup/dashboard edits.
      dropConfiguredCliRuntime(entry, adapterChanged);
      try {
        validateCliLaunchModeConfig({
          cliId: entry.cliId,
          cliLaunchMode: entry.cliLaunchMode,
          wrapperCli: entry.wrapperCli,
          cliRuntime: entry.cliRuntime,
          cliPathOverride: entry.cliPathOverride,
          sandbox: entry.sandbox,
          readIsolation: entry.readIsolation,
        });
      } catch (e) {
        return { write: false, result: `invalid_cli_launch_mode: ${(e as Error).message}` };
      }
    } else if (effective === null) {
      // [legacy-thinkingCard] 写/清规范键时同步删旧名（懒迁移）；随 normalizeCotEnabled 移除。
      if (spec.configKey === 'cotEnabled') delete entry.thinkingCard;
      delete entry[spec.configKey];
    } else if (spec.kind === 'boolean') {
      if (spec.configKey === 'cotEnabled') delete entry.thinkingCard; // [legacy-thinkingCard] 懒迁移，同上
      // 只持久化「非默认」的一侧，bots.json 保持干净：默认 OFF 的字段 true 才写、
      // false 删 key；默认 ON（defaultOn）的字段 false 才写、true 删 key。
      if (spec.configKey === 'codexRpcInput') {
        entry.codexRpcInput = effective === true;
      } else if (spec.defaultOn) {
        if (effective === false) entry[spec.configKey] = false;
        else delete entry[spec.configKey];
      } else if (effective === true) entry[spec.configKey] = true;
      else delete entry[spec.configKey];
    } else if (spec.kind === 'json') {
      entry[spec.configKey] = effective as any;
    } else {
      entry[spec.configKey] = effective;
    }
    if (spec.configKey === 'cliId' && !isConfigurableReasoningCliId(nextCliId)) {
      delete entry.reasoningEffort;
    }
    if (spec.configKey === 'cliId' && !isCodexServiceTierCliId(nextCliId)) {
      delete entry.serviceTier;
    }
    // The pane-argv budget applies to the legacy /botconfig env / envUnset
    // writes too — an oversized layer makes every new tmux session of this bot
    // fail deterministically ("command too long"). Shrinking (including clear)
    // stays allowed so an already-oversized layer can always be cleaned up.
    if (prevEnvLayer && !envLayerWithinBudget(prevEnvLayer, botEnvLayer(entry))) {
      return { write: false, result: 'layer_too_large' };
    }
    return { write: true, result: null };
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.result) return { ok: false, reason: r.result };

  // 同步内存 config（与 oncall/grant-prefs store 一致，路由/spawn 不重启即生效）。
  const cliSelection = spec.kind === 'cli' && effective !== null
    ? typeof effective === 'string'
      ? resolveCliSelection(effective)
      : effective && typeof effective === 'object' && !Array.isArray(effective)
        ? effective as ReturnType<typeof resolveCliSelection>
        : undefined
    : undefined;
  if (cliSelection) {
    const adapterChanged = bot.config.cliId !== cliSelection.cliId;
    bot.config.cliId = cliSelection.cliId;
    bot.config.wrapperCli = cliSelection.wrapperCli;
    bot.config.cliLaunchMode = cliSelection.cliLaunchMode;
    // Keep the in-memory config identical to what was persisted above.
    dropConfiguredCliRuntime(bot.config, adapterChanged);
  } else if (effective === null) {
    (bot.config as any)[spec.configKey] = undefined;
  } else if (spec.kind === 'boolean') {
    (bot.config as any)[spec.configKey] = spec.configKey === 'codexRpcInput'
      ? effective === true : spec.defaultOn
      ? (effective === false ? false : undefined)
      : (effective || undefined);
  } else if (spec.kind === 'json') {
    (bot.config as any)[spec.configKey] = effective;
  } else {
    (bot.config as any)[spec.configKey] = effective;
  }
  if (spec.configKey === 'cliId' && !isConfigurableReasoningCliId(bot.config.cliId)) {
    bot.config.reasoningEffort = undefined;
  }
  if (spec.configKey === 'cliId' && !isCodexServiceTierCliId(bot.config.cliId)) {
    bot.config.serviceTier = undefined;
  }
  const newText = spec.kind === 'cli'
    ? selectionKeyForBot(bot.config.cliId, bot.config.wrapperCli, bot.config.cliLaunchMode)
    : formatFieldValue(spec, (bot.config as any)[spec.configKey], bot.config);
  if (spec.configKey === 'feedback') {
    try {
      const path = sendCredFilePath(config.session.dataDir, larkAppId);
      if (existsSync(path)) {
        const cred = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        if (effective === null || (effective as any)?.enabled !== true) delete cred.feedback;
        else cred.feedback = effective;
        atomicWriteFileSync(path, JSON.stringify(cred), { mode: 0o600 });
      }
    } catch (error) {
      logger.warn(`[config:${larkAppId}] failed to refresh sandbox feedback policy: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (spec.configKey === 'displayName') {
    try { displayNameRefresher?.(); } catch { /* best effort */ }
  }
  if (spec.configKey === 'pinStreamingCard' && previousPinStreamingCard !== undefined) {
    const nextPinStreamingCard = bot.config.pinStreamingCard === true;
    if (previousPinStreamingCard !== nextPinStreamingCard) {
      notifyPinStreamingCardChanged(larkAppId, nextPinStreamingCard);
    }
  }
  logger.info(`[config:${larkAppId}] set ${spec.key}: ${oldText} -> ${newText}`);
  return { ok: true, oldText, newText, effect: spec.effect };
}

export type SetFeedbackPolicyResult = { ok: true } | { ok: false; reason: string };

export async function setBotFeedbackPolicy(larkAppId: string, policy: FeedbackPolicyLayer | null): Promise<SetFeedbackPolicyResult> {
  let normalized: FeedbackPolicyLayer | undefined;
  try { normalized = policy === null ? undefined : normalizeFeedbackPolicyLayer(policy); }
  catch { return { ok: false, reason: 'invalid_policy' }; }
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const r = await rmwBotEntry<null>(larkAppId, entry => {
    if (normalized === undefined) delete entry.feedback;
    else entry.feedback = normalized;
    return { write: true, result: null };
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  bot.config.feedback = normalized;
  return { ok: true };
}

export async function setChatFeedbackPolicy(larkAppId: string, chatId: string, policy: FeedbackPolicyLayer | null): Promise<SetFeedbackPolicyResult> {
  let normalized: FeedbackPolicyLayer | undefined;
  try { normalized = policy === null ? undefined : normalizeFeedbackPolicyLayer(policy); }
  catch { return { ok: false, reason: 'invalid_policy' }; }
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const r = await rmwBotEntry<null>(larkAppId, entry => {
    const current: Record<string, FeedbackPolicyLayer> = entry.chatFeedbackPolicies && typeof entry.chatFeedbackPolicies === 'object' && !Array.isArray(entry.chatFeedbackPolicies)
      ? { ...entry.chatFeedbackPolicies } : {};
    if (normalized === undefined) delete current[chatId];
    else current[chatId] = normalized;
    if (Object.keys(current).length === 0) delete entry.chatFeedbackPolicies;
    else entry.chatFeedbackPolicies = current;
    return { write: true, result: null };
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  const current = { ...(bot.config.chatFeedbackPolicies ?? {}) };
  if (normalized === undefined) delete current[chatId];
  else current[chatId] = normalized;
  bot.config.chatFeedbackPolicies = Object.keys(current).length ? current : undefined;
  return { ok: true };
}

export type SetAllowedUsersResult =
  | {
    ok: true;
    raw: string[];
    resolved: string[];
    /**
     * resolver 本次逐条判为 definitive（41050 不可见 / 41012 / code-0 无 user 等）而
     * 丢弃的 on_ 条目：照常落盘（不会锁死谁），但需提示调用方。取自与热更新同一次
     * resolve 的 entryStatus，保证告警与实际生效名单一致。
     */
    unresolvedUnionIds?: string[];
    /**
     * resolver 本次判为 definitive 而丢弃的邮箱 / 手机号条目（账号不存在或对本
     * 应用不可见；非瞬态，不会自动重试）。同样照常落盘（可能只是临时不可见，
     * 且 self-lockout 防护已保证发起人仍在名单内），由调用方在 /botconfig 回复里
     * 提示，而不是让条目静默消失。on_ 走 {@link unresolvedUnionIds}，不重复列。
     */
    unresolvedEmailsAndMobiles?: string[];
  }
  | { ok: false; reason: 'unusable_owner_entries'; entries: string[] }
  | { ok: false; reason: 'bot_not_registered' | 'bot_not_in_config' | 'self_lockout' | 'empty_resolved' | string };

/**
 * 改 allowedUsers（管理员名单）。这是动信任根的敏感操作，与普通字段分开：
 *   0. **owner 身份边界**（见 CLAUDE.md「飞书 owner 身份边界」与 setup/owner-identity.ts）：
 *      ou_ 是 app-scoped，resolver 对它字面透传——另一个应用的 ou_（典型如 managed
 *      Agent 把 source app 的 BOTMUX_OWNER_OPEN_ID 抄过来）会被原样写进名单却永远
 *      匹配不上任何发送者。写入前用**本 bot 凭证**对 ou_ 条目过 detectUnusableOwnerEntries：
 *      - 被目标应用确定性判为不可用 → 拒绝写入（unusable_owner_entries + entries）；
 *      - 网络/scope/无 secret 等 inconclusive → 不拒绝，fail-closed 仍由 resolver 的
 *        瞬态路径（缓存兜底 + 后台重试）负责。
 *      on_ 不在这里硬拒：resolver 会丢弃解析不了的 on_，不会锁死谁（同租户但本应用
 *      通讯录不可见的合法协作者也走这里）；被 resolver 判 definitive 丢弃的 on_ 以
 *      unresolvedUnionIds 带回提示（见下方第 4 步之后）。
 *      发起人自己的 open_id 是本应用事件里观察到的，天然属于本应用，不再探测。
 *   1. 用 bot 凭证把邮箱/on_ 解析成 open_id（与启动期同一路径）。
 *   2. **防自锁**：解析后名单必须仍含发起人的 open_id，否则拒绝——避免把自己踢出管理员。
 *   3. 解析后非空才写。
 *   4. 落盘原始条目（邮箱/on_/ou_，与 setup 一致），并同步内存 resolvedAllowedUsers /
 *      rawAllowedUserResolution（与 daemon 启动期赋值同口径），无需重启。
 *
 * confirm 二次确认由调用方（command-handler）处理，本函数只做校验 + 落盘。
 */
export async function setBotAllowedUsers(
  larkAppId: string,
  rawEntries: string[],
  senderOpenId: string | undefined,
): Promise<SetAllowedUsersResult> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const openIdEntries = [...new Set(rawEntries.filter(e => e.startsWith('ou_') && e !== senderOpenId))];
  if (openIdEntries.length > 0) {
    const unusableOpenIds = await detectUnusableOwnerEntries(
      larkAppId, bot.config.larkAppSecret, bot.config.brand ?? 'feishu', openIdEntries,
    );
    if (unusableOpenIds.length > 0) {
      logger.warn(`[config:${larkAppId}] allowedUsers set rejected: open_id(s) unusable by this app: ${unusableOpenIds.join(', ')}`);
      return { ok: false, reason: 'unusable_owner_entries', entries: unusableOpenIds };
    }
  }

  const { resolved, map, entryStatus, definitiveMisses } = await resolveAllowedUsersWithMap(larkAppId, rawEntries);
  if (resolved.length === 0) return { ok: false, reason: 'empty_resolved' };
  if (senderOpenId && !resolved.includes(senderOpenId)) return { ok: false, reason: 'self_lockout' };

  const r = await rmwBotEntry<null>(larkAppId, (entry) => {
    entry.allowedUsers = rawEntries;
    return { write: true, result: null };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  bot.config.allowedUsers = rawEntries;
  bot.resolvedAllowedUsers = resolved;
  bot.rawAllowedUserResolution = map;
  // Keep the last-known-good sidecar + dashboard descriptor in lockstep with the
  // live allowlist. Without this, a hot `set allowedUsers` (e.g. owner switches
  // from email to on_ while contact API is healthy) leaves the new raw key out
  // of the cache; the next clean restart during an API blip would then resolve
  // empty and fail-closed lock the owner out — the exact bug this feature fixes.
  // retainKeys prunes stale keys (old email/union no longer configured);
  // deleteEntries drops entries that resolved DEFINITIVELY-gone in THIS set (e.g.
  // a removed co-owner) so a later transient restart can't revive them from cache.
  const definitiveEntries: string[] = [];
  let anyTransient = false;
  for (const [entry, status] of entryStatus.entries()) {
    if (status === 'definitive') definitiveEntries.push(entry);
    else if (status === 'transient') anyTransient = true;
  }
  const unresolvedUnionIds = definitiveEntries.filter(e => e.startsWith('on_'));
  // 邮箱/手机号的确定性 miss：resolver 已逐条打 WARN，这里只把条目带回给调用方
  // 在 /botconfig 回复里提示。优先用 resolver 返回的 definitiveMisses（与本次
  // 热更新同一次解析）；部分 mock / 旧调用方没返回时从 entryStatus 兜底推导。
  // on_ 已在 unresolvedUnionIds 里，ou_ 恒为 resolved，都不在此列。
  // 用户可见提示按条目去重（同一条邮箱/手机号在命令里写多次只提示一次），
  // 与走 Map 天然去重的 unresolvedUnionIds 口径一致。
  const misses = definitiveMisses ?? definitiveEntries;
  const unresolvedEmailsAndMobiles = [...new Set(misses.filter(e => !e.startsWith('on_') && !e.startsWith('ou_')))];
  writeAllowedUsersResolveCache(config.session.dataDir, larkAppId, {
    map,
    // sidecar 同时承载 blockedUsers 的缓存：retainKeys 取并集，不得剪掉黑名单条目。
    retainKeys: [...new Set([...rawEntries, ...(bot.config.blockedUsers ?? [])])],
    deleteEntries: definitiveEntries,
  });
  republishResolvedAllowedUsersDescriptor(larkAppId, resolved);
  // Partial-transient set: the owner (senderOpenId) resolved (self_lockout guard
  // above guarantees it), but some OTHER entry transient-failed. Schedule the
  // same background heal the startup path uses so that entry recovers when the
  // contact API does, instead of silently staying dropped until the next restart.
  if (anyTransient) scheduleAllowedUsersResolveRetryFromMutation(larkAppId);
  logger.info(`[config:${larkAppId}] allowedUsers updated: ${rawEntries.length} entries, ${resolved.length} resolved`);
  if (unresolvedEmailsAndMobiles.length > 0) {
    logger.warn(`[config:${larkAppId}] allowedUsers set: email/mobile entr${unresolvedEmailsAndMobiles.length === 1 ? 'y' : 'ies'} `
      + `definitively unresolved (kept, not effective, no retry): ${unresolvedEmailsAndMobiles.join(', ')}`);
  }
  if (unresolvedUnionIds.length > 0) {
    logger.warn(`[config:${larkAppId}] allowedUsers set: union_id(s) not resolvable by this app (kept, not effective): ${unresolvedUnionIds.join(', ')}`);
  }
  if (unresolvedUnionIds.length > 0 || unresolvedEmailsAndMobiles.length > 0) {
    return { ok: true, raw: rawEntries, resolved, unresolvedUnionIds: unresolvedUnionIds.length ? unresolvedUnionIds : undefined, unresolvedEmailsAndMobiles: unresolvedEmailsAndMobiles.length ? unresolvedEmailsAndMobiles : undefined };
  }
  return { ok: true, raw: rawEntries, resolved };
}

export type SetBlockedUsersResult =
  | { ok: true; raw: string[]; resolved: string[] }
  | { ok: false; reason: 'bot_not_registered' | 'empty_resolved' | 'cannot_block_admin' | string; conflicting?: string[] };

/**
 * 改 blockedUsers（黑名单，P1c）。与 {@link setBotAllowedUsers} 同构、语义相反，
 * 是 talk/operate 判定上一条**纯增量否决腿**（见 evaluateTalk）：
 *   1. 空数组 = 清除：删 bots.json 的 blockedUsers、内存 resolvedBlockedUsers=[],
 *      直接返回 ok（无需解析）。
 *   2. 非空：复用 allowedUsers 同一解析器 + 同一 sidecar 把邮箱/on_/ou_ 换成本
 *      app open_id；解析结果为空 → empty_resolved。
 *   3. 不可拉黑守卫（命中即拒绝且**绝不落盘**）：解析结果与当前
 *      resolvedAllowedUsers 有交集，或包含 getOwnerOpenId —— owner/管理员被误拉黑
 *      会被静默锁死，写入口必须挡住（运行时判定里 allowedUser 腿仍优先于否决腿，
 *      属于双保险）。
 *   4. rmwBotEntry 落盘原始条目，同步内存 config.blockedUsers /
 *      resolvedBlockedUsers；sidecar 的 retainKeys 取 allowedUsers ∪ blockedUsers
 *      原始条目并集——同一个缓存文件，任一侧写回都不得 prune 另一侧的条目。
 * 黑名单不进 dashboard descriptor，故不调 republishResolvedAllowedUsersDescriptor。
 */
export async function setBotBlockedUsers(
  larkAppId: string,
  rawEntries: string[],
): Promise<SetBlockedUsersResult> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  // 空数组 = 清除黑名单。
  if (rawEntries.length === 0) {
    const r = await rmwBotEntry<null>(larkAppId, (entry) => {
      delete entry.blockedUsers;
      return { write: true, result: null };
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    bot.config.blockedUsers = undefined;
    bot.resolvedBlockedUsers = [];
    logger.info(`[config:${larkAppId}] blockedUsers cleared`);
    return { ok: true, raw: [], resolved: [] };
  }

  const { resolved, map, entryStatus } = await resolveAllowedUsersWithMap(larkAppId, rawEntries);
  if (resolved.length === 0) return { ok: false, reason: 'empty_resolved' };

  // 守卫：当前管理员（resolvedAllowedUsers）与 owner 绝不可被拉黑。
  const conflicting = new Set<string>();
  for (const ou of resolved) {
    if (bot.resolvedAllowedUsers.includes(ou)) conflicting.add(ou);
  }
  const ownerOpenId = getOwnerOpenId(larkAppId);
  if (ownerOpenId && resolved.includes(ownerOpenId)) conflicting.add(ownerOpenId);
  if (conflicting.size > 0) {
    return { ok: false, reason: 'cannot_block_admin', conflicting: [...conflicting] };
  }

  const r = await rmwBotEntry<null>(larkAppId, (entry) => {
    entry.blockedUsers = rawEntries;
    return { write: true, result: null };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  bot.config.blockedUsers = rawEntries;
  bot.resolvedBlockedUsers = resolved;
  // 与 setBotAllowedUsers 同款写穿：两侧共用同一 sidecar，retainKeys 必须并集，
  // 黑名单写回不能把 allowed 条目（可能正靠缓存度过 contact API 降级）剪掉。
  const definitiveEntries: string[] = [];
  for (const [entry, status] of entryStatus.entries()) {
    if (status === 'definitive') definitiveEntries.push(entry);
  }
  writeAllowedUsersResolveCache(config.session.dataDir, larkAppId, {
    map,
    retainKeys: [...new Set([...(bot.config.allowedUsers ?? []), ...rawEntries])],
    deleteEntries: definitiveEntries,
  });
  logger.info(`[config:${larkAppId}] blockedUsers updated: ${rawEntries.length} entries, ${resolved.length} resolved`);
  return { ok: true, raw: rawEntries, resolved };
}

/**
 * 按 open_id 定向解除黑名单（成员面板单行「解除」专用）。调用方只持有点行
 * 的 ou_，而 raw 条目可能以邮箱 / on_ / 手机形态写入——只按 ou_ 直值过滤
 * 会把这些条目留下、接口却回报成功（评审指出的假成功）。
 *
 * 对剩余非 ou_ 条目复用同一解析器（降级时再查同一 sidecar 缓存）反查
 * raw→ou_ 映射：证据表明映射到目标 open_id 的 raw 条目一并剔除；解析不出
 * （definitive miss，或 transient 且缓存也没有）的条目**原样保留，绝不在证
 * 据不足时多删**。ou_ 直值直接出列。无命中为幂等 no-op。
 *
 * 落盘不回退到 {@link setBotBlockedUsers}：全量重解析会在列表里混有
 * 历史 definitive-miss 条目时返回 empty_resolved，而本次定向解除已有
 * 映射证据成立——不能让无关脏条目挡住本次解除。
 */
export async function removeBlockedUsers(
  larkAppId: string,
  openIds: string[],
): Promise<SetBlockedUsersResult> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const targets = new Set(openIds.filter(id => typeof id === 'string' && id.startsWith('ou_')));
  const raw = bot.config.blockedUsers ?? [];
  if (targets.size === 0 || raw.length === 0) {
    return { ok: true, raw, resolved: bot.resolvedBlockedUsers ?? [] };
  }
  // ou_ 直值直接出列；邮箱 / on_ / 手机条目等映射证据。
  const pending = raw.filter(entry => !targets.has(entry));
  const unresolved = pending.filter(entry => !entry.startsWith('ou_'));
  let mapping = new Map<string, string>();
  if (unresolved.length > 0) {
    const result = await resolveAllowedUsersWithMap(larkAppId, unresolved);
    mapping = result.map;
    if (result.errored) {
      // contact API 降级时复用写入路径一直维护的 sidecar，避免解除在故障期
      // 静默 no-op；缓存也没有的条目按证据不足保留。
      const cached = readAllowedUsersResolveCache(config.session.dataDir, larkAppId);
      for (const entry of unresolved) {
        if (!mapping.has(entry) && cached[entry]) mapping.set(entry, cached[entry]);
      }
    }
  }
  const kept = pending.filter(entry => {
    if (entry.startsWith('ou_')) return true;
    const resolvedId = mapping.get(entry);
    // 只有被证明解析到目标 open_id 的条目才剔除；其余一律保留。
    return resolvedId === undefined || !targets.has(resolvedId);
  });
  if (kept.length === raw.length) {
    return { ok: true, raw, resolved: bot.resolvedBlockedUsers ?? [] };
  }
  if (kept.length === 0) return setBotBlockedUsers(larkAppId, []);
  const w = await rmwBotEntry<null>(larkAppId, (entry) => {
    entry.blockedUsers = kept;
    return { write: true, result: null };
  });
  if (!w.ok) return { ok: false, reason: w.reason };
  bot.config.blockedUsers = kept;
  // 被剔除的 email/on_ 条目的 ou_ 必在 targets 内（映射命中才剔除），故从
  // resolved 减去 targets 恰好覆盖直值与别名两种形态。
  const nextResolved = (bot.resolvedBlockedUsers ?? []).filter(ou => !targets.has(ou));
  bot.resolvedBlockedUsers = nextResolved;
  logger.info(`[config:${larkAppId}] blockedUsers unblocked: ${raw.length - kept.length} entries`);
  return { ok: true, raw: kept, resolved: nextResolved };
}

export type CoerceResult =
  | { ok: true; value: unknown }
  // A few reasons carry detail (e.g. which keys were rejected), so this is a
  // union of literals plus those prefixed forms rather than a closed literal set.
  | { ok: false; reason: 'invalid_bool' | 'invalid_enum' | 'invalid_cli' | 'invalid_dir' | 'invalid_number' | 'invalid_json' | 'invalid_env' | 'reserved_env' | 'empty' | 'too_long' | `invalid_mojo_config: ${string}` | `invalid_herdr_config: ${string}` | `invalid_remote_runner_config: ${string}` | `invalid_trigger_user_auth: ${string}` | `invalid_no_progress_notify: ${string}` | `invalid_prompt_cache: ${string}` | `invalid_steward: ${string}` };

/** herdr 块全部可写字段；与 normalizeHerdrBackendConfig 接受的键必须一致（有 parity 测试）。 */
export const HERDR_FIELD_NAMES = ['sessionName', 'placement', 'workspace', 'tab', 'splitDirection', 'chatTypes'] as const;

/**
 * Dashboard / `/config` 写 herdr 块的严格门。落值复用与 bots.json 解析同一个
 * {@link normalizeHerdrBackendConfig}（trim、剔除空值、全空 → undefined），但非法
 * 输入显式报错而不是静默剔除（与 mojo 同形）：一个拼错的 placement 若被默默丢掉，
 * 用户会得到「保存成功但没生效」的配置。空对象 / 全空字段归一为 null（清除整份
 * 覆盖块，回落到默认 botmux 宿主与 workspace 放置）。
 */
export function coerceHerdrBackendConfigInput(parsed: unknown): CoerceResult {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid_herdr_config: herdr 配置必须是 JSON 对象' };
  }
  const r = parsed as Record<string, unknown>;
  const known = new Set<string>(HERDR_FIELD_NAMES);
  const errors: string[] = [];
  for (const key of Object.keys(r)) {
    if (!known.has(key)) errors.push(`herdr.${key} 不是可识别字段`);
  }
  for (const key of ['sessionName', 'workspace', 'tab'] as const) {
    const v = r[key];
    if (v !== undefined && typeof v !== 'string') errors.push(`herdr.${key} 必须是字符串`);
  }
  if (r.placement !== undefined && r.placement !== 'workspace' && r.placement !== 'tab' && r.placement !== 'split') {
    errors.push('herdr.placement 必须是 workspace、tab 或 split');
  }
  if (r.splitDirection !== undefined && r.splitDirection !== 'right' && r.splitDirection !== 'down') {
    errors.push('herdr.splitDirection 必须是 right 或 down');
  }
  if (r.chatTypes !== undefined) {
    // 元素必须合法；重复值与 bots.json/env 门一致，交由 normalizer 去重，不报错。
    if (!Array.isArray(r.chatTypes) || r.chatTypes.some(t => t !== 'group' && t !== 'p2p')) {
      errors.push('herdr.chatTypes 必须是仅含 group、p2p 的字符串数组');
    }
  }
  if (errors.length > 0) return { ok: false, reason: `invalid_herdr_config: ${errors.join('；')}` };
  return { ok: true, value: normalizeHerdrBackendConfig(parsed) ?? null };
}

/**
 * 激活门（两个写入门共用：Dashboard PUT 与 IM `/config set`）：形状合法之后，
 * 必须在与全局 BOTMUX_HERDR_* 叠加后仍含 sessionName 或 placement，worker 才会
 * 采纳这份配置；否则它会「保存成功但零效果」。env 已提供放置方式时，bot 块只
 * 覆盖 tab 等子字段是合法叠加，照常放行。bots.json 启动解析走
 * normalizeHerdrBackendConfig，不经此门（宽松语义保持不变）。
 */
export function assertHerdrConfigActivates(value: unknown): string | null {
  const effective = resolveHerdrBackendConfig(config.daemon.herdr,
    (value ?? undefined) as import('../adapters/backend/types.js').HerdrBackendConfig | undefined);
  return effective
    ? null
    : 'invalid_herdr_config: 需至少设置「宿主会话名」或「放置方式」，单独填写目标工作区 / 目标 Tab / 分屏方向 / 生效聊天类型不会生效（若已用 BOTMUX_HERDR_SESSION_NAME / BOTMUX_HERDR_PLACEMENT 全局设置，则可只覆盖其余字段）';
}

const isConfigNumberInRange = (spec: ConfigFieldSpec, value: number): boolean => (
  Number.isInteger(value)
    && value >= (spec.min ?? 1)
    && (spec.max === undefined || value <= spec.max)
);

/**
 * 把一个**原始**字段值（来自卡片下拉/输入或别处）按字段 kind 解析校验成可落盘的
 * string|boolean。dir 在此做存在性检查（无 locale，返回结构化 reason，调用方再本地化）。
 * allowedUsers 不走这里（异步，见 {@link setBotAllowedUsers}）。
 */
export function coerceConfigValue(spec: ConfigFieldSpec, raw: unknown): CoerceResult {
  if (spec.kind === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    const b = parseBooleanValue(String(raw ?? ''));
    return b === undefined ? { ok: false, reason: 'invalid_bool' } : { ok: true, value: b };
  }
  if (spec.kind === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
    return isConfigNumberInRange(spec, n) ? { ok: true, value: n } : { ok: false, reason: 'invalid_number' };
  }
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, reason: 'empty' };
  if (spec.configKey === 'env') {
    // JSON object, `{"env":{...}}` settings snippet, or dotenv/shell lines (see
    // parsePerBotEnvText); sanitize to valid env keys + primitive values.
    // Reserved keys (CODEX_HOME / GROK_HOME / BOTMUX_* / …) are rejected
    // visibly — silent drop would hide split-brain configs (CLI gets a
    // custom home via injectEnv while daemon paths stay on default).
    // Empty text is handled as "clear" by the caller before coerce.
    const parsed = parsePerBotEnvText(s);
    if (!parsed.ok) return { ok: false, reason: parsed.reason === 'invalid_env_line' ? 'invalid_env' : 'invalid_json' };
    if (Object.keys(parsed.env).some((k) => isReservedPerBotEnvKey(k))) return { ok: false, reason: 'reserved_env' };
    const sanitized = sanitizePerBotEnv(parsed.env);
    return Object.keys(sanitized).length ? { ok: true, value: sanitized } : { ok: false, reason: 'invalid_json' };
  }
  switch (spec.kind) {
    case 'stringList': {
      const arr = (spec.parseList ?? parseCustomPassthroughInput)(s);
      return arr.length ? { ok: true, value: arr } : { ok: false, reason: 'empty' };
    }
    case 'enum':
      return spec.enumValues?.includes(s.toLowerCase())
        ? { ok: true, value: s.toLowerCase() }
        : { ok: false, reason: 'invalid_enum' };
    case 'cli': {
      try {
        return { ok: true, value: resolveCliSelection(s) };
      } catch { return { ok: false, reason: 'invalid_cli' }; }
    }
    case 'dir': {
      try { if (statSync(expandHomePath(s)).isDirectory()) return { ok: true, value: s }; } catch { /* not a dir */ }
      return { ok: false, reason: 'invalid_dir' };
    }
    case 'json': {
      try {
        const parsed = JSON.parse(s);
        if (spec.configKey === 'sandboxNetworkPolicy') return { ok: true, value: parseSandboxNetworkPolicy(parsed) };
        if (spec.configKey === 'groupCreation') return { ok: true, value: parseGroupCreationDefaults(parsed) };
        if (spec.configKey === 'oncallGroup') return { ok: true, value: normalizeOncallGroupPolicy(parsed) };
        if (spec.configKey === 'steward') {
          const steward = normalizeStewardConfig(parsed);
          return steward.ok ? { ok: true, value: steward.value } : { ok: false, reason: `invalid_steward: ${steward.reason}` };
        }
        if (spec.configKey === 'botActorOwnerBindings') {
          try {
            const bindings = normalizeBotActorOwnerBindings(parsed);
            return bindings ? { ok: true, value: bindings } : { ok: false, reason: 'invalid_json' };
          } catch { return { ok: false, reason: 'invalid_json' }; }
        }
        if (spec.configKey === 'promptCache') {
          try {
            const policy = normalizePromptCacheConfig(parsed);
            return policy ? { ok: true, value: policy } : { ok: false, reason: 'empty' };
          } catch (error) { return { ok: false, reason: `invalid_prompt_cache: ${error instanceof Error ? error.message : String(error)}` }; }
        }
        if (spec.configKey === 'noProgressNotify') {
          try { return { ok: true, value: normalizeNoProgressNotifyPolicy(parsed) }; }
          catch (error) { return { ok: false, reason: `invalid_no_progress_notify: ${error instanceof Error ? error.message : String(error)}` }; }
        }
        if (spec.configKey === 'skills') {
          const policy = readBotSkillPolicy(parsed);
          return policy ? { ok: true, value: policy } : { ok: false, reason: 'invalid_json' };
        }
        if (spec.configKey === 'feedback') {
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'invalid_json' };
          if ((parsed as { enabled?: unknown }).enabled !== true) return { ok: true, value: { enabled: false } };
          try { return { ok: true, value: normalizeFeedbackPolicy(parsed) }; }
          catch { return { ok: false, reason: 'invalid_json' }; }
        }
        if (spec.configKey === 'envPolicy') return { ok: true, value: normalizeEnvPolicy(parsed) };
        if (spec.configKey === 'mojo') {
          // Same SHARED normalizer as the bots.json parser, so the two config
          // doors cannot drift: unknown keys, internal launch-identity keys and
          // wrong types are all rejected, and the reason is surfaced verbatim.
          const normalized = normalizeMojoConfig(parsed);
          if (!normalized.ok) {
            return { ok: false, reason: `invalid_mojo_config: ${normalized.errors.join('; ')}` };
          }
          return { ok: true, value: normalized.value };
        }
        if (spec.configKey === 'remoteRunner') {
          try {
            return { ok: true, value: normalizeRemoteRunnerConfig(parsed) };
          } catch (error) {
            return {
              ok: false,
              reason: `invalid_remote_runner_config: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }
        if (spec.configKey === 'herdr') {
          const result: CoerceResult = coerceHerdrBackendConfigInput(parsed);
          if (!result.ok) return result;
          if (result.value !== null) {
            const activationError = assertHerdrConfigActivates(result.value);
            if (activationError) return { ok: false, reason: activationError } as CoerceResult;
          }
          return result;
        }
        if (spec.configKey === 'triggerUserAuth') {
          // Same SHARED parser as the bots.json door, so the two cannot drift.
          // A rejected value is surfaced verbatim: an operator reaching for a
          // "use the machine login" fallback must be told it is refused on
          // purpose, and a typo'd tool name must not quietly leave the boundary
          // unenforced while the config looks accepted.
          try {
            const config = parseTriggerUserAuthConfig(parsed);
            return config
              ? { ok: true, value: config }
              : { ok: false, reason: 'invalid_json' };
          } catch (e) {
            return { ok: false, reason: `invalid_trigger_user_auth: ${(e as Error).message}` };
          }
        }
        return { ok: true, value: parsed };
      } catch {
        return { ok: false, reason: 'invalid_json' };
      }
    }
    default: // 'string'
      // 长度上限统一在这里生效（spec.maxLen），dashboard PUT 与 IM /config 两个
      // 入口共用，不再各自分叉校验。
      if (spec.maxLen && s.length > spec.maxLen) return { ok: false, reason: 'too_long' };
      return { ok: true, value: s };
  }
}

/**
 * 渲染交互配置卡片所需的纯数据视图。card-builder 只吃这个（不反向 import store），
 * 避免循环依赖。`modelChoices` 由调用方按 cliId 解析后传入（command-handler /
 * card-handler 已 import CLI 适配器），缺省空数组 → 不渲染 model 下拉。
 */
export interface ConfigCardData {
  larkAppId: string;
  botName: string;
  cliId: string;
  cliOptions: Array<{ id: string; label: string }>;
  model: string | null;
  modelChoices: string[];
  /** Reasoning levels offered when this bot's CLI supports the control. */
  reasoningEfforts?: string[];
  /** Currently configured reasoning effort (null = CLI/model default). */
  reasoningEffort?: string | null;
  modelChoiceLabels?: Record<string, string>;
  lang: string | null;
  /** 私聊单聊模式 p2pMode（'chat' | 'thread' | 'group'）；null = 未设（默认 chat）。 */
  p2pMode: string | null;
  brandLabel: string | null;
  defaultWorkingDir: string | null;
  /** 入群主动开工首轮 prompt（autoStartOnGroupJoinPrompt）。 */
  autoStartPrompt: string | null;
  /** 额外放行透传的 slash 命令（customPassthroughCommands），空格分隔；null = 未设。 */
  customPassthroughCommands: string | null;
  /** 开会话后自动发的命令（startupCommands），逗号分隔（命令自带空格参数，故不能空格分隔）；null = 未设。 */
  startupCommands: string | null;
  /** team 级默认角色文本（不在 bots.json，存独立角色文件）。 */
  teamRole: string | null;
  /** messageQuota.defaultLimit（被授权人默认消息额度）；null = 不限。 */
  quota: number | null;
  admins: number;
  booleans: Array<{ key: string; on: boolean }>;
  /** Other people use this bot while the allowlist sandbox is off (display only). */
  sandboxAdvice?: SharedBotSandboxAdvice & { cliId: string };
}

export function getConfigCardData(larkAppId: string, modelChoices: readonly string[] = []): ConfigCardData | null {
  let bot;
  try { bot = getBot(larkAppId); } catch { return null; }
  const cfg = bot.config;
  const q = cfg.messageQuota?.defaultLimit;
  let selectedModel = cfg.model ?? null;
  const zcodeEnv = { ...process.env, ...cfg.env };
  const modelChoiceLabels = cfg.cliId === 'zcode'
    // Same model name behind two gateways must stay distinguishable in the card.
    ? Object.fromEntries(modelChoices.map(m => [m, formatZcodeModelChoice(m, zcodeEnv, zcodeAmbiguousModelIds(zcodeEnv))])) : undefined;
  if (cfg.cliId === 'zcode' && selectedModel) {
    try { const ref = resolveZcodeModelReference(selectedModel, { ...process.env, ...cfg.env }); selectedModel = `${ref.providerId}/${ref.modelId}`; } catch { /* stale selections remain visible */ }
  }
  return {
    larkAppId,
    botName: cfg.displayName ?? bot.botName ?? cfg.cliId,
    cliId: selectionKeyForBot(cfg.cliId, cfg.wrapperCli, cfg.cliLaunchMode),
    cliOptions: CLI_SELECT_OPTIONS.map(o => ({ id: o.key, label: o.label })),
    model: selectedModel,
    ...(modelChoiceLabels ? { modelChoiceLabels } : {}),
    modelChoices: [...modelChoices],
    ...(isConfigurableReasoningCliId(cfg.cliId)
      ? {
        reasoningEfforts: [...reasoningEffortsForCliModel(cfg.cliId, cfg.model)],
        reasoningEffort: isCodexReasoningEffort(cfg.reasoningEffort) ? cfg.reasoningEffort : null,
      }
      : {}),
    lang: cfg.lang ?? null,
    p2pMode: cfg.p2pMode ?? null,
    brandLabel: cfg.brandLabel ?? null,
    defaultWorkingDir: cfg.defaultWorkingDir ?? null,
    autoStartPrompt: cfg.autoStartOnGroupJoinPrompt ?? null,
    customPassthroughCommands: cfg.customPassthroughCommands?.length ? cfg.customPassthroughCommands.join(' ') : null,
    // Join with ', ' (not space): each command carries space-delimited args.
    startupCommands: cfg.startupCommands?.length ? cfg.startupCommands.join(', ') : null,
    teamRole: resolveTeamRoleFile(larkAppId),
    quota: typeof q === 'number' && Number.isInteger(q) && q > 0 ? q : null,
    admins: bot.resolvedAllowedUsers.length,
    booleans: CONFIG_FIELDS.filter(f => f.kind === 'boolean').map(f => ({
      key: f.key, on: (cfg as any)[f.configKey] === true,
    })),
    ...(() => {
      // p2pMode='group' session groups carry an oncall binding that only pins
      // their workingDir: the talk gate treats them as owner-only, so they are
      // not a "whole group can talk" signal. allowedChatGroups is talk-open for
      // every member, except where the id is itself a session group.
      const sharedOncallChats = (cfg.oncallChats ?? []).filter(c => !isSessionGroup(c.chatId));
      const sharedAllowedChatGroups = (cfg.allowedChatGroups ?? []).filter(id => !isSessionGroup(id));
      // Mirror the WORKER's pairing, not an open-coded override chain: a remote
      // CLI id (riff / mojo / remote-runner) dictates its backend even when
      // backendType is not written (the common config), and a non-remote CLI
      // resolved onto a remote backend reconciles to the daemon default / pty.
      // Pass cfg.mojo so a provably-remote mojo session is exempt too.
      const backendType = resolvePairedBackendId(cfg.cliId, cfg.backendType, config.daemon.backendType) ?? 'pty';
      const localApplies = localSandboxApplies(backendType, cfg.mojo);
      // The worker's spawn gate, exactly: even a LOCAL backend may refuse a file
      // sandbox (herdr / zellij / zmx / orca; local mojo without a remote
      // proof). undefined = it would spawn; non-undefined = it would throw.
      const sandboxCapable = backendSandboxCompatibilityError({
        backendType: backendType as BackendType,
        cliId: cfg.cliId,
        fileSandboxRequested: true,
        effectiveReadIsolationRequested: false,
        ...(backendType === 'mojo' ? { mojoConfig: cfg.mojo } : {}),
      }) === undefined;
      // DISPLAY-only path: a typo'd BOTMUX_SANDBOX makes the resolver throw (the
      // worker fail-closes at spawn). Fall back to the config-only mode (still
      // honouring the legacy readIsolation flag, which implies oncall), so a bad
      // env value neither kills /botconfig nor re-advises an isolated bot.
      let effectiveSandboxMode: ReturnType<typeof resolveLocalSandboxMode>;
      try {
        effectiveSandboxMode = resolveLocalSandboxMode({
          backendType,
          mojoConfig: cfg.mojo,
          configSandbox: cfg.sandbox,
          readIsolation: cfg.readIsolation === true,
          envValue: process.env.BOTMUX_SANDBOX,
        });
      } catch {
        effectiveSandboxMode = resolveSandboxMode({
          configSandbox: cfg.sandbox,
          readIsolation: cfg.readIsolation === true,
        });
      }
      const advice = sharedBotSandboxAdvice({
        sandboxMode: effectiveSandboxMode,
        localSandboxApplies: localApplies,
        sandboxCapable,
        cliId: cfg.cliId,
        oncallChatCount: sharedOncallChats.length,
        allowedChatGroupsCount: sharedAllowedChatGroups.length,
        defaultOncallEnabled: cfg.defaultOncall?.enabled,
        // Resolved identities, same source as `admins` above: a stale
        // unresolvable entry must not make the bot look multi-user.
        allowedUsersCount: bot.resolvedAllowedUsers.length,
        triggerUserAuthEnabled: cfg.triggerUserAuth?.enabled,
        wrapperCli: cfg.wrapperCli,
        cliRuntimeConfigured: cfg.cliRuntime !== undefined,
      });
      return advice ? { sandboxAdvice: { ...advice, cliId: cfg.cliId } } : {};
    })(),
  };
}
