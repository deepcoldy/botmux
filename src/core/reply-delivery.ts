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
 * 缺省值按 CLI 走（`defaultReplyDeliveryFor`）：claude-code 缺省 `transcript`，其余
 * 缺省 `send`；bots.json 显式写 `send` / `transcript` 才覆盖。所有判定 fail-closed：
 * 拿不准就回到 `send` / 非 solo。
 */
import { getOwnerOpenId, resolveReplyDelivery } from '../bot-registry.js';
import { isStructuredBridgeFallbackActive } from '../services/structured-bridge-clis.js';
import { logger } from '../utils/logger.js';

export type ReplyDelivery = 'send' | 'transcript';

/** claude-code 走 `claudeDataDir` 转写桥（worker.ts bridge fallback），其余按
 *  结构化转写白名单（codex/traex/coco/hermes/mtr/pi/oh-my-pi/ebsd/grok）。
 *  cursor 只在 adopt 下有转写，不算；codex-app 天然是转写模式，不需要本开关。 */
export function supportsTranscriptReplyDelivery(cliId: string | undefined): boolean {
  if (!cliId) return false;
  if (cliId === 'claude-code') return true;
  return isStructuredBridgeFallbackActive(cliId, false);
}

/** 未显式配置时的缺省投递方式：claude-code 的最终回复由 daemon 从转写自动转发
 *  （transcript），模型不再被教「botmux send」；其它 CLI 保持 send。 */
export function defaultReplyDeliveryFor(cliId: string | undefined): ReplyDelivery {
  return cliId === 'claude-code' ? 'transcript' : 'send';
}

const warnedUnsupported = new Set<string>();

/** 运行时生效值：显式配置（send / transcript）优先，未配置按 CLI 缺省；结果为
 *  transcript 但当前 CLI 不支持时回落 send（每个 bot+cli 组合只 warn 一次，避免
 *  每轮刷日志）。无 larkAppId / registry 异常 → send（fail-closed）。 */
export function effectiveReplyDelivery(larkAppId: string | undefined, cliId: string | undefined): ReplyDelivery {
  if (!larkAppId) return 'send';
  let configured: ReplyDelivery | undefined;
  try { configured = resolveReplyDelivery(larkAppId); } catch { return 'send'; }
  const wanted: ReplyDelivery = configured ?? defaultReplyDeliveryFor(cliId);
  if (wanted !== 'transcript') return 'send';
  if (supportsTranscriptReplyDelivery(cliId)) return 'transcript';
  const key = `${larkAppId}:${cliId ?? ''}`;
  if (!warnedUnsupported.has(key)) {
    warnedUnsupported.add(key);
    logger.warn(`[reply-delivery] bot ${larkAppId} 配置 replyDelivery=transcript，但 cliId=${cliId ?? '(none)'} 没有转写采集，回落 send`);
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
