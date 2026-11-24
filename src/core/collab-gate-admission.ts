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
import type { TalkEvaluation } from '../im/lark/event-dispatcher.js';
import type { SlashRouteDecision } from './command-router.js';
import type { CollabGateFile, SessionGroupCollaborationConfig } from '../services/collab-group-config.js';

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
  routingEvent?: unknown;
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
      const policy = opts.config?.gatePolicy ?? 'queue';
      if (policy === 'reject') return { kind: 'reject', reason: 'gate_not_open' };
      // F3：queue 要求有效 sourceMessageId，否则不宣称 queue。
      const sourceMessageId = opts.sourceMessageId ?? '';
      if (!sourceMessageId) return { kind: 'reject', reason: 'gate_not_open_no_source' };
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
  const q = readCollabChatQueue(dataDir, chatId);
  const idx = q.items.findIndex(i => i.targetAppId === targetAppId && i.sourceMessageId === sourceMessageId);
  return idx < 0 ? 0 : idx + 1;
}

/** 命令豁免白名单是否放行某 classifySlash 决策（供测试与调用方复用）。 */
export function gateCommandExempt(decision: SlashRouteDecision | undefined): boolean {
  return collabCommandExempt(decision);
}
