/**
 * collab per-chat gate 准入（PR-3b-1，design §8.1/§8.3）。
 *
 * 方案 A：调用点前独立函数，不污染 enforceMessageQuotaForCliInput 公共闸。
 *
 * 授权顺序（F4）：先拒绝未授权 talk，再判管理豁免 / gate 策略——未授权永不触碰队列/策略。
 * 阶段优先级（F2）：cancelled/failed/awaiting-input 优先于 acceptingUserTasks 的普通任务
 * open 判断；管理豁免可单独放行。
 *
 * 命令豁免白名单（F1）：只放行「不建会话、不恢复/重附 CLI、不注入 CLI」的管理命令——
 *   special（前置特判处理器 sessions/vc-auth/card/cot/term，均无 CLI 副作用）
 *   daemon(sessionless) 且不在副作用 deny-list（/resume 会重附 CLI、/group /g 可 autoStart、
 *     /watch-comment 可建会话——一律受 gate）
 * 所有 forward（含 bot_gated）不豁免；passthrough/delegated_turn/daemon(precreate|existing|
 * existing_only) 不豁免。
 */
import { readCollabGate } from '../services/collab-gate-store.js';
import { enqueueCollabChatItem, readCollabChatQueue } from '../services/collab-chat-queue-store.js';
import { readCollabInitEntry } from '../services/collab-init-store.js';
import type { TalkEvaluation } from '../im/lark/event-dispatcher.js';
import type { MentionIdentity } from '../im/lark/message-parser.js';
import type { SlashRouteDecision } from './command-router.js';
import type { CollabGateFile, SessionGroupCollaborationConfig } from '../services/collab-group-config.js';

/**
 * 有类型、可序列化的规范化重放事件（F2 残留）：重放时恢复原准入所需的完整身份与路由上下文。
 * 四个构造点复用同一结构，恢复时用原 source facts 重新授权/分类，不序列化过期能力。
 */
export interface NormalizedCollabRoutingEvent {
  chatId: string;
  messageId: string;
  /** 原发送者 type（'user' | 'app' | 'bot' | …）。缺 type 不假定是真人。 */
  senderType?: string;
  senderOpenId?: string;
  senderUnionId?: string;
  /** 源应用身份（evaluateBotTalk 判定用）。 */
  teamTrustAppId?: string;
  teamTrustUnionId?: string;
  /** bot 归属（两个旗标独立保存，不合并）。 */
  isBotSenderType?: boolean;
  isForeignBotSender?: boolean;
  chatType?: string;
  scope?: string;
  anchor?: string;
  replyRootId?: string;
  threadId?: string;
  parentId?: string;
  content: string;
  mentions?: MentionIdentity[];
  resources: Array<{ type: string; key?: string; name: string; messageId?: string; fallbackMessageIds?: string[] }>;
}

/**
 * shared typed builder：四个 daemon 构造点统一调用，确保 routingEvent 完整、类型被兜住。
 * 返回 NormalizedCollabRoutingEvent（不再退化 unknown）。
 */
export function buildCollabRoutingEvent(input: {
  chatId: string;
  messageId: string;
  senderType?: string;
  senderOpenId?: string;
  senderUnionId?: string;
  teamTrustAppId?: string;
  teamTrustUnionId?: string;
  isBotSenderType?: boolean;
  isForeignBotSender?: boolean;
  chatType?: string;
  scope?: string;
  anchor?: string;
  replyRootId?: string;
  threadId?: string;
  parentId?: string;
  content: string;
  mentions?: MentionIdentity[];
  resources: Array<{ type: string; key?: string; name: string; messageId?: string; fallbackMessageIds?: string[] }>;
}): NormalizedCollabRoutingEvent {
  return {
    chatId: input.chatId,
    messageId: input.messageId,
    ...(input.senderType !== undefined ? { senderType: input.senderType } : {}),
    ...(input.senderOpenId !== undefined ? { senderOpenId: input.senderOpenId } : {}),
    ...(input.senderUnionId !== undefined ? { senderUnionId: input.senderUnionId } : {}),
    ...(input.teamTrustAppId !== undefined ? { teamTrustAppId: input.teamTrustAppId } : {}),
    ...(input.teamTrustUnionId !== undefined ? { teamTrustUnionId: input.teamTrustUnionId } : {}),
    ...(input.isBotSenderType !== undefined ? { isBotSenderType: input.isBotSenderType } : {}),
    ...(input.isForeignBotSender !== undefined ? { isForeignBotSender: input.isForeignBotSender } : {}),
    ...(input.chatType !== undefined ? { chatType: input.chatType } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.anchor !== undefined ? { anchor: input.anchor } : {}),
    ...(input.replyRootId !== undefined ? { replyRootId: input.replyRootId } : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
    content: input.content,
    ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
    resources: input.resources,
  };
}

export type CollabGateAdmissionResult =
  | { kind: 'not-collab' }
  | { kind: 'open' }
  | { kind: 'queue'; position: number }
  | { kind: 'reject'; reason: string }
  | { kind: 'awaiting-input'; reason: string }
  | { kind: 'cancelled' };

/** sessionless 中仍会建会话/重附 CLI/注入 CLI 的命令（副作用 deny-list，F1）。 */
const SESSIONLESS_SIDE_EFFECT_COMMANDS = new Set(['/resume', '/group', '/g', '/watch-comment']);

/**
 * 命令豁免白名单：不建会话、不恢复/重附 CLI、不注入 CLI 的管理命令。
 * F1：所有 forward（含 bot_gated）不豁免；sessionless 排除副作用 deny-list。
 */
export function collabCommandExempt(decision: SlashRouteDecision | undefined): boolean {
  if (!decision) return false;
  if (decision.kind === 'special') return true;
  if (decision.kind === 'daemon' && decision.sessionPolicy === 'sessionless') {
    return !SESSIONLESS_SIDE_EFFECT_COMMANDS.has(decision.cmd);
  }
  return false;
}

export interface CollabGateAdmissionOpts {
  dataDir: string;
  chatId: string;
  /** 本 bot（target daemon 自己）的 larkAppId。 */
  botAppId: string;
  /** 调用方已算好的 talk 判定（evaluateTalk / evaluateBotTalk）。 */
  talk: TalkEvaluation;
  /** 调用方已算好的命令判定（classifySlash）；无命令正文可省略。 */
  slashDecision?: SlashRouteDecision;
  /** 注入 gate（缺省 readCollabGate）。 */
  gate?: CollabGateFile | undefined;
  /** 注入 config 拿 gatePolicy（gate 文件不存 gatePolicy，配置里才有）。 */
  config?: SessionGroupCollaborationConfig | undefined;
  now?: () => number;
  /** 规范化路由事件（持久化进队列，供重放）。 */
  routingEvent?: NormalizedCollabRoutingEvent;
  /** 本轮消息 id（同 (targetAppId, sourceMessageId) 去重）。 */
  sourceMessageId?: string;
  enqueueImpl?: (dataDir: string, chatId: string, item: { sourceMessageId: string; targetAppId: string; routingEvent: unknown; deliveryStatus: 'pending'; enqueuedAt: number }) => boolean;
  /** 查询队列项位置（缺省按 readCollabChatQueue 算）。 */
  queuePositionImpl?: (dataDir: string, chatId: string, targetAppId: string, sourceMessageId: string) => number;
}

export function checkCollabGateAdmission(opts: CollabGateAdmissionOpts): CollabGateAdmissionResult {
  const gate = opts.gate ?? readCollabGate(opts.dataDir, opts.chatId);
  if (!gate) return { kind: 'not-collab' };
  const participant = gate.participants[opts.botAppId];
  if (!participant) return { kind: 'not-collab' };
  // F1：gatePolicy 从该群**已冻结的 configSnapshot** 读（creator 的 collab-group-init entry），
  // 不读目标 daemon 自己的 p2p 创建默认配置。opts.config 显式注入优先（测试），否则从
  // gate.creatorAppId + gate.initId 解析冻结快照。
  const frozenConfig = opts.config
    ?? readCollabInitEntry(opts.dataDir, gate.creatorAppId, gate.initId)?.configSnapshot;

  // F4：先拒绝未授权 talk，再判豁免/gate——未授权不触碰队列/策略。
  if (!opts.talk.allowed) return { kind: 'reject', reason: 'not_allowed' };

  // 管理豁免：不建会话/不注入 CLI 的管理命令放行。
  if (collabCommandExempt(opts.slashDecision)) return { kind: 'open' };

  // F2：禁止阶段优先于 acceptingUserTasks 的普通任务 open。
  switch (gate.phase) {
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'failed':
      return { kind: 'awaiting-input', reason: 'gate_failed' };
    case 'awaiting-input':
      return { kind: 'awaiting-input', reason: 'gate_awaiting_input' };
    default:
      break;
  }

  // acceptingUserTasks → open（仅在允许用户任务的阶段）。
  if (participant.acceptingUserTasks) return { kind: 'open' };

  switch (gate.phase) {
    case 'done':
      return { kind: 'reject', reason: 'gate_done_not_accepting' };
    case 'initializing':
    case 'active':
    default: {
      const policy = frozenConfig?.gatePolicy ?? 'queue';
      if (policy === 'reject') return { kind: 'reject', reason: 'gate_not_open' };
      // F3：queue 要求有效 sourceMessageId，否则不宣称 queue。
      const sourceMessageId = opts.sourceMessageId ?? '';
      if (!sourceMessageId) return { kind: 'reject', reason: 'gate_not_open_no_source' };
      // R1：queue 新增项必须有可序列化的规范化 routingEvent，缺失 → reject（不返回 queue）。
      if (opts.routingEvent === undefined || opts.routingEvent === null) {
        return { kind: 'reject', reason: 'gate_queue_missing_event' };
      }
      const now = (opts.now ?? Date.now)();
      const enqueue = opts.enqueueImpl ?? ((d, c, item) => enqueueCollabChatItem(d, c, item));
      const positionImpl = opts.queuePositionImpl ?? ((d, c, targetAppId, smid) =>
        readQueuePosition(d, c, targetAppId, smid));
      // 先查已有位置（重复投递返回原位置），否则入队。
      const existingPos = positionImpl(opts.dataDir, opts.chatId, opts.botAppId, sourceMessageId);
      if (existingPos > 0) return { kind: 'queue', position: existingPos };
      const added = enqueue(opts.dataDir, opts.chatId, {
        sourceMessageId,
        targetAppId: opts.botAppId,
        routingEvent: opts.routingEvent,
        deliveryStatus: 'pending',
        enqueuedAt: now,
      });
      // F3：enqueue 失败不宣称成功。
      if (!added) return { kind: 'reject', reason: 'gate_queue_failed' };
      const pos = positionImpl(opts.dataDir, opts.chatId, opts.botAppId, sourceMessageId);
      return { kind: 'queue', position: pos > 0 ? pos : 1 };
    }
  }
}

function readQueuePosition(dataDir: string, chatId: string, targetAppId: string, sourceMessageId: string): number {
  const q = readCollabChatQueue(dataDir, chatId, targetAppId);
  const idx = q.items.findIndex(i => i.sourceMessageId === sourceMessageId);
  return idx < 0 ? 0 : idx + 1;
}

/** 命令豁免白名单是否放行某 classifySlash 决策（供测试与调用方复用）。 */
export function gateCommandExempt(decision: SlashRouteDecision | undefined): boolean {
  return collabCommandExempt(decision);
}

/**
 * daemon 接入辅助：返回一个「是否阻塞」决策 + 供回执用的消息。
 *
 * 返回 discriminated union：
 *   - `{ block: false }` → open / not-collab，继续 enforceMessageQuotaForCliInput；
 *   - `{ block: true; reason; position? }` → queue/reject/awaiting-input/cancelled，调用方回执后 return。
 *
 * 不在本函数里做飞书回执（回执锚点/通道因入口而异），只返回决策，调用方负责 reply。
 */
export function collabGateAdmissionDecision(opts: CollabGateAdmissionOpts):
  | { block: false }
  | { block: true; reason: string; position?: number } {
  const r = checkCollabGateAdmission(opts);
  switch (r.kind) {
    case 'open':
    case 'not-collab':
      return { block: false };
    case 'queue':
      return { block: true, reason: 'queued', position: r.position };
    case 'reject':
      return { block: true, reason: r.reason };
    case 'awaiting-input':
      return { block: true, reason: r.reason };
    case 'cancelled':
      return { block: true, reason: 'cancelled' };
  }
}
