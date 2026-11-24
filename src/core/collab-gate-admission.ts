/**
 * collab per-chat gate 准入（PR-3b-1，design §8.1/§8.3）。
 *
 * 方案 A：调用点前独立函数，不污染 enforceMessageQuotaForCliInput 公共闸。函数内部先做
 * talk 判定（复用 evaluateTalk / evaluateBotTalk），判定通过后才查 gate。返回 discriminated
 * union 供两处准入调用点（handleNewTopic / thread-reply）在扣费、worker 创建前拦截。
 *
 * 命令豁免白名单：只放行 classifySlash 判定为「不建会话、不注入 CLI」的管理命令——
 *   special（前置特判不进 handleCommand）
 *   daemon(sessionless)（无会话的 botmux 命令）
 *   forward(bot_gated)（被门掉的 bot 发送方，连命令都不判）
 * 其余 passthrough / delegated_turn / daemon(precreate|existing|existing_only) /
 * forward(no_slash|discussion|unknown_slash) 不豁免。
 */
import { readCollabGate } from '../services/collab-gate-store.js';
import { enqueueCollabChatItem } from '../services/collab-chat-queue-store.js';
import type { TalkEvaluation } from '../im/lark/event-dispatcher.js';
import type { SlashRouteDecision } from './command-router.js';
import type { CollabGateFile, SessionGroupCollaborationConfig } from '../services/collab-group-config.js';

export type CollabGateAdmissionResult =
  | { kind: 'not-collab' }                    // 无 gate 或本 bot 非 participant
  | { kind: 'open' }                          // acceptingUserTasks 或命令豁免
  | { kind: 'queue'; position: number }       // gatePolicy=queue，已入队
  | { kind: 'reject'; reason: string }        // gatePolicy=reject 或未授权
  | { kind: 'awaiting-input'; reason: string }
  | { kind: 'cancelled' };

/** 命令豁免白名单：不建会话、不注入 CLI 的管理命令。 */
export function collabCommandExempt(decision: SlashRouteDecision | undefined): boolean {
  if (!decision) return false;
  if (decision.kind === 'special') return true;
  if (decision.kind === 'forward' && decision.reason === 'bot_gated') return true;
  if (decision.kind === 'daemon' && decision.sessionPolicy === 'sessionless') return true;
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
  enqueueImpl?: (dataDir: string, chatId: string, item: { sourceMessageId: string; targetAppId: string; routingEvent: unknown; deliveryStatus: 'pending'; enqueuedAt: number }) => boolean;
  sourceMessageId?: string;
}

export function checkCollabGateAdmission(opts: CollabGateAdmissionOpts): CollabGateAdmissionResult {
  const gate = opts.gate ?? readCollabGate(opts.dataDir, opts.chatId);
  if (!gate) return { kind: 'not-collab' };
  const participant = gate.participants[opts.botAppId];
  if (!participant) return { kind: 'not-collab' };

  // 命令豁免白名单：不建会话、不注入 CLI 的管理命令放行。
  if (collabCommandExempt(opts.slashDecision)) return { kind: 'open' };

  // talk 判定：未授权 → reject(not_allowed)。
  if (!opts.talk.allowed) return { kind: 'reject', reason: 'not_allowed' };

  // acceptingUserTasks → open（gate 已对该目标开放）。
  if (participant.acceptingUserTasks) return { kind: 'open' };

  // 五态分支。
  switch (gate.phase) {
    case 'done':
      // done 不再兼任 gate 唯一开关；按 acceptingUserTasks（上面已判 false）。
      return { kind: 'reject', reason: 'gate_done_not_accepting' };
    case 'awaiting-input':
      return { kind: 'awaiting-input', reason: 'gate_awaiting_input' };
    case 'failed':
      return { kind: 'awaiting-input', reason: 'gate_failed' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'initializing':
    case 'active':
    default: {
      const policy = opts.config?.gatePolicy ?? 'queue';
      if (policy === 'reject') return { kind: 'reject', reason: 'gate_not_open' };
      // queue：入队（同 sourceMessageId 去重）+ 回显排队位置。
      const now = (opts.now ?? Date.now)();
      const enqueue = opts.enqueueImpl ?? ((d, c, item) => enqueueCollabChatItem(d, c, item));
      const sourceMessageId = opts.sourceMessageId ?? '';
      if (sourceMessageId) {
        enqueue(opts.dataDir, opts.chatId, {
          sourceMessageId,
          targetAppId: opts.botAppId,
          routingEvent: undefined,
          deliveryStatus: 'pending',
          enqueuedAt: now,
        });
      }
      return { kind: 'queue', position: 1 };
    }
  }
}

/** 命令豁免白名单是否放行某 classifySlash 决策（供测试与调用方复用）。 */
export function gateCommandExempt(decision: SlashRouteDecision | undefined): boolean {
  return collabCommandExempt(decision);
}
