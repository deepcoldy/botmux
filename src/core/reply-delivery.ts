/**
 * 最终回复投递方式（per-bot `replyDelivery`）与 solo 会话判定。
 *
 * 纯函数层：不 import im/lark，不碰 daemon 状态，daemon / session-manager /
 * worker-pool 都从这里取同一套判定，避免三处各写一份白名单。
 *
 * - `send`：模型必须自己 `botmux send`，系统提示与每轮 reminder 都这么要求。
 * - `transcript`：daemon 从 CLI 转写自动取本轮最后的 assistant 文本发最终回复卡
 *   （bridge fallback 升为主通道）；系统提示只把 `botmux send` 留给最终回复带不了
 *   的事（@ 别的 bot 协作/回报、附件或卡片、发到别的群或话题），不注入每轮
 *   reminder；solo 会话去掉 `<user_message>` 壳与 `<sender/>`。
 *
 * 缺省按 CLI 能力区分（`defaultReplyDeliveryFor`）：有转写采集通道的 CLI 缺省
 * `transcript`，其余缺省 `send`；bots.json 显式写 `transcript` / `send` 都覆盖缺省。
 * 所有判定 fail-closed：拿不准就回到 `send` / 非 solo。
 */
import { getBot, getOwnerOpenId, resolveReplyDelivery } from '../bot-registry.js';
import { resolveSandboxMode } from '../adapters/cli/sandbox-mode.js';
import { logger } from '../utils/logger.js';
import { zeroPromptInjectionForBot, type PromptInjection } from './prompt-injection.js';
import { supportsTranscriptReplyDelivery } from '../services/structured-bridge-clis.js';
import { supportsTranscriptReplyDeliveryForBot, type ZeroPromptSandboxValue } from './zero-prompt-support.js';

export type ReplyDelivery = 'send' | 'transcript';

/** 能力判据在 zero-prompt-support（无 bot-registry 依赖的叶子模块）实现，这里原样
 *  转出：daemon / worker-pool / dashboard / 测试的既有导入路径不变，且 config 写盘
 *  不变量可以直接用叶子模块而不必经本文件绕回 bot-registry 形成 import 环。 */
export { supportsTranscriptReplyDelivery } from '../services/structured-bridge-clis.js';
export { supportsTranscriptReplyDeliveryForBot } from './zero-prompt-support.js';
export type { TranscriptDeliveryCapabilityOpts } from './zero-prompt-support.js';

/**
 * 未显式配置时的缺省投递方式：CLI 有转写采集通道（`supportsTranscriptReplyDelivery`：
 * claude-code 与 structured bridge ALWAYS 集合）就缺省 `transcript`，否则 `send`。
 *
 * 为什么缺省 transcript：send 模式要求模型每轮自己 `botmux send`，部分模型（典型是
 * GPT 系）会把进度、阶段结论、最终答复都 send 一遍，群里被频繁打扰；transcript 下
 * 最终答复由 daemon 从转写取、只发一张卡，`botmux send` 退回到协作与附件这类最终
 * 回复带不了的场景。
 *
 * 只按 CLI 判，不看沙盒：cursor / doubao 在 scratch 沙盒下采集不到，这一层仍返回
 * `transcript`，由 `effectiveReplyDelivery` 在运行时按沙盒回落 `send`（缺省值回落
 * 不告警，只有显式配置的 transcript 回落才告警）。Dashboard 的「当前 CLI 缺省」
 * 展示也取这里，与沙盒无关。
 *
 * 显式写 `send` 的 bot 保持 send：`effectiveReplyDelivery` 先取显式配置，缺省只在
 * 未配置时补位。Doubao 历来缺省 transcript（账号级常驻 service 进程使 `botmux
 * send` 归属不可靠，#2828），现在只是与其它可采集 CLI 同一条规则。
 */
export function defaultReplyDeliveryFor(cliId: string | undefined): ReplyDelivery {
  return supportsTranscriptReplyDelivery(cliId) ? 'transcript' : 'send';
}

const warnedUnsupported = new Set<string>();

/** 运行时生效值：显式配置（send / transcript）优先，未配置按 CLI 缺省；结果为
 *  transcript 但当前 CLI / 沙盒组合不支持时回落 send（显式配置的才 warn，每个
 *  bot+cli 组合只 warn 一次，避免每轮刷日志）。无 larkAppId / registry 异常 → send
 *  （fail-closed）。
 *
 * opts.sessionSandbox：为**已存活会话的续轮**传该会话 spawn 时冻结的沙箱
 * （session.sandbox）。信封判定必须按「这个会话的 worker 实际有没有采集」来，
 * 而不是 live bot config——sandbox 改动 next-session-only：会话以 scratch 起、
 * 运维随后关掉 sandbox 再开 transcript 时，live 解析会放 transcript（改口不
 * send），但该会话的 worker 仍在 COW overlay 里采集关闭 = 静默轮。新会话/首轮
 * 不传，走 live config + BOTMUX_SANDBOX env 的实时解析。 */
export function effectiveReplyDelivery(
  larkAppId: string | undefined,
  cliId: string | undefined,
  promptInjection?: PromptInjection,
  opts?: { sessionSandbox?: ZeroPromptSandboxValue },
): ReplyDelivery {
  if (!larkAppId) return 'send';
  if (zeroPromptInjectionForBot(larkAppId, cliId, promptInjection)) return 'transcript';
  let configured: ReplyDelivery | undefined;
  let sandbox: ZeroPromptSandboxValue | undefined;
  try {
    configured = resolveReplyDelivery(larkAppId);
    if (opts?.sessionSandbox !== undefined) {
      // 冻结值是该会话 spawn 时的 config 侧决策，但 worker 实际跑的沙盒还要
      // 并上进程级 BOTMUX_SANDBOX：freezeSessionSandboxDecision 只看 cfg 不看
      // env，所以全局 =scratch 时 session.sandbox 会冻成 false、而 worker 经
      // resolveLocalSandboxMode 实际跑在 scratch（采集关闭）。只信冻结值会在
      // 续轮把 transcript 错放回去（改口不 send + 采集关 = 静默）。任一源为
      // scratch 即按 scratch 降级；env=0 不追溯翻案已冻成 scratch 的会话
      // （spawn 时它确实在 scratch 里）。oncall 不收窄（authPaths bind 宿主
      // 目录，桥可读）。env 非法值由 envSandboxMode throw，落到外层 catch
      // fail-closed → send。
      const frozen = opts.sessionSandbox;
      const envResolved = resolveSandboxMode({ configSandbox: undefined, envValue: process.env.BOTMUX_SANDBOX });
      sandbox = frozen === 'scratch' || envResolved === 'scratch' ? 'scratch' : frozen;
    } else {
      const cfg = getBot(larkAppId).config;
      // 机器级 BOTMUX_SANDBOX 开关不会 materialise 进 cfg（与零注入同一约定，见
      // zero-prompt-support.ts 的 resolveLocalSandboxMode 说明）：只看 cfg.sandbox
      // 会在 BOTMUX_SANDBOX=scratch 时把 transcript 下发给一个采集已关的 cursor，
      // 系统提示改口「不用 send」而转写桥在 merged overlay 外读不到 = 整轮静默。
      // 用与 spawnCli 同一个 resolveSandboxMode 把 env / readIsolation 一并解析，
      // 让 init 冻结值在 daemon 这一处就判死（worker spawnCli 另有 resolved-mode
      // 权威复核兜底）。
      sandbox = resolveSandboxMode({
        configSandbox: cfg.sandbox,
        readIsolation: cfg.readIsolation === true,
        envValue: process.env.BOTMUX_SANDBOX,
      });
    }
  } catch { return 'send'; }
  const wanted: ReplyDelivery = configured ?? defaultReplyDeliveryFor(cliId);
  if (wanted !== 'transcript') return 'send';
  if (supportsTranscriptReplyDeliveryForBot(cliId, { sandbox })) return 'transcript';
  // 缺省值回落是预期内的（如 scratch 沙盒下的 cursor / doubao），不告警；只有使用者
  // 显式写了 transcript 却用不上时才提示一次。
  if (configured !== 'transcript') return 'send';
  const key = `${larkAppId}:${cliId ?? ''}`;
  if (!warnedUnsupported.has(key)) {
    warnedUnsupported.add(key);
    logger.warn(`[reply-delivery] bot ${larkAppId} 配置 replyDelivery=transcript，但 cliId=${cliId ?? '(none)'} 在当前沙盒配置下没有转写采集，回落 send`);
  }
  return 'send';
}

export interface SoloSessionInput {
  chatType: 'group' | 'p2p' | undefined;
  /** `getChatMode` 结果：'group' 普通群 / 'topic' 话题群；undefined = 未知。 */
  chatMode: 'group' | 'topic' | undefined;
  /** `getGroupStats` 结果；API 失败时上游返回 {999,999}，天然非 solo。 */
  stats: { userCount: number; botCount: number } | undefined;
  senderType: 'user' | 'bot' | undefined;
  senderOpenId: string | undefined;
  ownerOpenId: string | undefined;
}

/**
 * solo = 只有 owner 和本 bot 两个参与者的会话：
 *  - p2p 私聊恒为 solo；
 *  - 普通群（非话题群）且 user_count ≤ 1 且 bot_count ≤ 1，且本轮发言者是 owner；
 *  - 其余（话题群、未知群模式、成员数未知、非 owner、bot 发言）一律非 solo。
 * 这是判定「可以去掉 sender/壳」的门，宁可漏判也不误判。
 */
export function computeSoloSession(input: SoloSessionInput): boolean {
  if (input.chatType === 'p2p') return true;
  if (input.chatType !== 'group') return false;
  if (input.chatMode !== 'group') return false;
  if (!input.stats || input.stats.userCount > 1 || input.stats.botCount > 1) return false;
  if (input.senderType !== 'user') return false;
  if (!input.senderOpenId || !input.ownerOpenId) return false;
  return input.senderOpenId === input.ownerOpenId;
}

/** 便捷封装：owner 从 registry 取。 */
export function computeSoloSessionForBot(
  larkAppId: string,
  input: Omit<SoloSessionInput, 'ownerOpenId'>,
): boolean {
  let ownerOpenId: string | undefined;
  try { ownerOpenId = getOwnerOpenId(larkAppId); } catch { ownerOpenId = undefined; }
  return computeSoloSession({ ...input, ownerOpenId });
}
