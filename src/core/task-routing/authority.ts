/**
 * 任务分配权限判定（纯函数，复用 `botmux dispatch` 现有的回合调用方身份判定，不另造一套）。
 *
 * 规则：
 * - 只读动作（status / recommend / history）：允许普通活跃会话（仍拒绝 receiver / 个人助理会话）。
 * - 派发动作（run）：高权限，会触发目标 Bot 建群、开会话，只允许：
 *   1. owner / 管理员本人直接发起的回合（复用 dispatch 的 isDirectHumanTurnCaller +
 *      dispatchCallerFromReply + adminOpenIds / canOperate）；
 *   2. 管家会话（stewardReady 且当前就在管家群，且本轮不是非 owner 真人或未授权外部 bot 触发）；
 *   3. 本机终端直接调用（无会话上下文，在 CLI 层额外通过祖先进程校验防清除环境变量伪造）。
 *   普通群里非 owner 触发的 Agent、静默监听会话、失败恢复合成回合、会议接收会话一律拒绝。
 */

import type { Session, TrustedCaller } from '../../types.js';
import type { StewardConfig } from '../decision-board/model.js';
import { stewardReady } from '../decision-board/model.js';
import { dispatchCallerFromReply } from '../dispatch-user-delegation.js';
import { isSilentMessageListenerSession } from '../message-listener-silence.js';
import { pickTurnReplyTarget, registryTurnMayAuthenticateHuman } from '../reply-target.js';
import { isDirectHumanTurnCaller } from '../../services/project-workstream-authority.js';
import type { TaskRoutingCallerKind } from './model.js';

export type TaskRoutingSessionAction =
  | 'status'
  | 'recommend'
  | 'history'
  | 'run'
  | 'preflight-topic-candidate'
  | 'record-topic-attempt';

export type TaskRoutingAuthoritySession = Partial<
  Pick<
    Session,
    | 'vcMeetingReceiver'
    | 'assistantOwnerOpenId'
    | 'failedTurnRecovery'
    | 'replyTargets'
    | 'turnReplyContexts'
    | 'messageListenerRun'
    | 'rootMessageId'
    | 'currentReplyTarget'
  >
>;

export interface TaskRoutingSessionAuthorityInput {
  action: TaskRoutingSessionAction;
  larkAppId: string;
  chatId: string;
  chatType?: 'group' | 'p2p';
  scope?: 'thread' | 'chat';
  session: TaskRoutingAuthoritySession;
  steward?: StewardConfig;
  transportDisabled: boolean;
  /** Live turn identity from `ds.managedTurnOrigin`. */
  turnId?: string;
  liveTrustedCaller?: TrustedCaller;
  activeInteractiveTurn?: { turnId: string; caller: TrustedCaller };
  /** Bot's resolved admin open_ids (`getDashboardAdminOpenIds(larkAppId)`). */
  adminOpenIds: readonly string[];
  /** Existing operate gate (`canOperate`). */
  canOperate: (openId: string, unionId?: string) => boolean;
}

export type TaskRoutingSessionAuthorityResult =
  | { ok: true; callerKind: Exclude<TaskRoutingCallerKind, 'host_cli'>; turnId?: string }
  | { ok: false; status: 403; error: string; detail: string };

/**
 * Resolve the authoritative caller for the live turn using the exact same precedence
 * as `DISPATCH_USER_DELIVERY_ROUTE` (`daemon.ts`) and `project-workstream` (`dashboard-ipc-server.ts`).
 */
export function resolveSessionTurnCaller(
  input: Pick<
    TaskRoutingSessionAuthorityInput,
    'larkAppId' | 'turnId' | 'liveTrustedCaller' | 'activeInteractiveTurn' | 'session'
  >,
): TrustedCaller | undefined {
  const { turnId } = input;
  if (input.liveTrustedCaller) return input.liveTrustedCaller;
  if (turnId && input.activeInteractiveTurn?.turnId === turnId) {
    return input.activeInteractiveTurn.caller;
  }
  if (turnId && registryTurnMayAuthenticateHuman(input.session as unknown as Session, turnId)) {
    return dispatchCallerFromReply(input.larkAppId, pickTurnReplyTarget(input.session as unknown as Session, turnId));
  }
  return undefined;
}

function isOwnerHumanCaller(
  caller: TrustedCaller | undefined,
  larkAppId: string,
  adminOpenIds: readonly string[],
  canOperate: (openId: string, unionId?: string) => boolean,
): boolean {
  if (!isDirectHumanTurnCaller(caller)) return false;
  if (caller.requestLarkAppId !== larkAppId) return false;
  const openId = caller.requestUserOpenId;
  if (!openId) return false;
  // Require explicit owner/admin membership AND canOperate (never fail-open on open bots).
  return adminOpenIds.includes(openId) && canOperate(openId, caller.requestUserUnionId);
}

/**
 * Authorize a session-scoped `botmux assign` IPC request.
 */
export function authorizeTaskRoutingSessionAction(
  input: TaskRoutingSessionAuthorityInput,
): TaskRoutingSessionAuthorityResult {
  if (input.session.vcMeetingReceiver) {
    return {
      ok: false,
      status: 403,
      error: 'assign_forbidden_receiver',
      detail: '会议接收会话不允许调用任务分配接口。',
    };
  }
  if (input.session.assistantOwnerOpenId) {
    return {
      ok: false,
      status: 403,
      error: 'assign_forbidden_assistant',
      detail: '个人助理模式会话不允许调用任务分配接口。',
    };
  }

  const isStewardChat = stewardReady(input.steward) && input.chatId === input.steward.chatId;

  // Read-only actions are allowed for any authenticated non-receiver, non-assistant session.
  if (input.action === 'status' || input.action === 'recommend' || input.action === 'history') {
    return {
      ok: true,
      callerKind: isStewardChat ? 'steward_session' : 'owner_turn',
      ...(input.turnId ? { turnId: input.turnId } : {}),
    };
  }

  // Mutating actions (`run`, `record-topic-attempt`) require Feishu transport and strict caller proof.
  if (input.transportDisabled) {
    return {
      ok: false,
      status: 403,
      error: 'assign_forbidden_no_transport',
      detail: '当前会话没有飞书通道，不允许发起任务分配。',
    };
  }
  if (isSilentMessageListenerSession({
    messageListenerRun: input.session.messageListenerRun,
    rootMessageId: input.session.rootMessageId ?? '',
  })) {
    return {
      ok: false,
      status: 403,
      error: 'assign_forbidden_silent_listener',
      detail: '消息监听静默会话不允许自动派发任务。',
    };
  }
  if (input.turnId && input.session.failedTurnRecovery?.turnId === input.turnId) {
    return {
      ok: false,
      status: 403,
      error: 'assign_forbidden_recovery_turn',
      detail: '失败回合自动恢复期间不允许发起新的任务派发。',
    };
  }

  const caller = resolveSessionTurnCaller(input);

  // Path 1: Owner-initiated direct human turn (same identity proof as `botmux dispatch`).
  if (isOwnerHumanCaller(caller, input.larkAppId, input.adminOpenIds, input.canOperate)) {
    return {
      ok: true,
      callerKind: isStewardChat ? 'steward_session' : 'owner_turn',
      ...(input.turnId ? { turnId: input.turnId } : {}),
    };
  }

  // Path 2: Steward session in its configured steward chat.
  // Allows owner decision-board batches (board:...) and owner-created steward patrol
  // schedules, while blocking non-owner humans, non-owner schedules, or peer bots.
  if (isStewardChat) {
    if (caller?.senderType === 'bot') {
      return {
        ok: false,
        status: 403,
        error: 'assign_run_bot_caller_forbidden',
        detail: '其他机器人触发的回合不能直接执行 assign run。',
      };
    }
    const isBoardBatchTurn = typeof input.turnId === 'string'
      && input.turnId.startsWith(`board:${input.larkAppId}:`)
      && (!caller || isOwnerHumanCaller(caller, input.larkAppId, input.adminOpenIds, input.canOperate));
    const isOwnerScheduleCaller = caller?.source === 'schedule_creator'
      && caller.requestLarkAppId === input.larkAppId
      && !!caller.requestUserOpenId
      && input.adminOpenIds.includes(caller.requestUserOpenId)
      && input.canOperate(caller.requestUserOpenId, caller.requestUserUnionId);
    const isLegacyStewardScheduleTurn = !caller && typeof input.turnId === 'string' && input.turnId.startsWith('sched:');
    if (isBoardBatchTurn || isOwnerScheduleCaller || isLegacyStewardScheduleTurn) {
      return {
        ok: true,
        callerKind: 'steward_session',
        ...(input.turnId ? { turnId: input.turnId } : {}),
      };
    }
    if (caller?.senderType === 'user') {
      return {
        ok: false,
        status: 403,
        error: 'assign_run_owner_required',
        detail: '当前回合的发起人不是本 Bot 的 owner，拒绝执行 assign run。',
      };
    }
  }

  return {
    ok: false,
    status: 403,
    error: 'assign_run_forbidden',
    detail: 'assign run 仅允许 owner 本人发起的回合、管家会话或本机 CLI 直接调用；普通群里他人或外部触发的会话不可用。',
  };
}
