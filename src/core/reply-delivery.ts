/**
 * 最终回复投递方式（per-bot `replyDelivery`）与 solo 会话判定。
 *
 * 纯函数层：不 import im/lark，不碰 daemon 状态，daemon / session-manager /
 * worker-pool 都从这里取同一套判定，避免三处各写一份白名单。
 *
 * - `send`：模型必须自己 `botmux send`，系统提示与每轮 reminder 都这么要求。
 * - `transcript`：daemon 从 CLI 转写自动取本轮最后的 assistant 文本发最终回复卡
 *   （bridge fallback 升为主通道）；系统提示不再提及 `botmux send`、不注入每轮
 *   reminder；solo 会话去掉 `<user_message>` 壳与 `<sender/>`。
 *
 * 缺省值统一是 `send`（`defaultReplyDeliveryFor`），与上游一致；bots.json 显式写
 * `transcript` 才切换，写 `send` 亦持久化。所有判定 fail-closed：
 * 拿不准就回到 `send` / 非 solo。
 */
import { getBot, getOwnerOpenId, resolveReplyDelivery } from '../bot-registry.js';
import { resolveSandboxMode } from '../adapters/cli/sandbox-mode.js';
import { supportsTranscriptReplyDelivery } from '../services/structured-bridge-clis.js';
import { logger } from '../utils/logger.js';
import { zeroPromptInjectionForBot, type PromptInjection } from './prompt-injection.js';
import { isScratchSandbox, type ZeroPromptSandboxValue } from './zero-prompt-support.js';

export type ReplyDelivery = 'send' | 'transcript';

/** claude-code 走 `claudeDataDir` 转写桥（worker.ts bridge fallback），其余按
 *  结构化转写白名单（codex/traex/coco/hermes/mtr/pi/oh-my-pi/ebsd/grok/cursor）。
 *  antigravity 只有零注入转写，不算；codex-app 天然是转写模式，不需要本开关。 */
export { supportsTranscriptReplyDelivery };

/**
 * 未显式配置时的缺省投递方式：**一律 `send`**，与上游行为逐字节一致——模型仍被
 * 教「botmux send」，最终回复由它自己发。
 *
 * `transcript` 是 opt-in：它改的不只是投递路径，还会改写系统提示、去掉逐轮
 * `<botmux_reminder>`、并让 solo 会话的信封去壳，且 `/adopt` 不再把这类会话识别
 * 为本 bot 自产。这些都是对既有会话可感知的变化，不该由升级顺带发生，所以交给
 * 使用者在 bots.json 或 dashboard 上显式打开。
 *
 * 保留 `cliId` 形参而不直接写死常量：缺省策略的唯一出口就在这里，将来若要为某个
 * CLI 单独换缺省，只改这一个函数即可，不必回头翻所有调用点。
 */
export function defaultReplyDeliveryFor(_cliId: string | undefined): ReplyDelivery {
  return 'send';
}

/** Per-bot options that can make transcript delivery unusable even when the
 *  CLI itself harvests transcripts. */
export interface TranscriptDeliveryCapabilityOpts {
  sandbox?: ZeroPromptSandboxValue;
}

/** Whether `replyDelivery: transcript` works for this bot's CLI under its
 *  sandbox configuration. The plain `supportsTranscriptReplyDelivery` predicate
 *  is CLI-only; callers that know the bot config (config write validation,
 *  dashboard switch gating, the runtime envelope decision) must go through
 *  this so an unusable combination is rejected at write time rather than
 *  accepted and silently degraded at runtime.
 *
 *  Full-root COW scratch: cursor's agent-transcript mirror lives in the merged
 *  overlay, which the host-side bridge cannot read. Enabling the transcript
 *  envelope there would strip the `botmux send` instructions from the prompt
 *  while harvest produced nothing — a fully silent turn, the exact shape the
 *  fallback exists to prevent. Reject it (same scratch boundary zero-injection
 *  already enforces). */
export function supportsTranscriptReplyDeliveryForBot(
  cliId: string | undefined,
  opts?: TranscriptDeliveryCapabilityOpts,
): boolean {
  if (!supportsTranscriptReplyDelivery(cliId)) return false;
  if (cliId === 'cursor' && isScratchSandbox(opts)) return false;
  return true;
}

const warnedUnsupported = new Set<string>();

/** 运行时生效值：显式配置（send / transcript）优先，未配置按 CLI 缺省；结果为
 *  transcript 但当前 CLI 不支持时回落 send（每个 bot+cli 组合只 warn 一次，避免
 *  每轮刷日志）。无 larkAppId / registry 异常 → send（fail-closed）。
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
