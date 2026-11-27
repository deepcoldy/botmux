/**
 * A running turn's part of a tick (tick.ts): its CLI asks, its progress, the
 * quota-limit hand-over to a peer, and the long-task and no-progress reminders.
 *
 * Functions here take the bridge as their first argument and run on its lane,
 * inside the tick.
 */
import { createHash } from 'node:crypto';
import { dispatchWecomAsks, type NativeAskCore } from '../native-ask.js';
import type { TriggerResponse } from '../../../../services/trigger-types.js';
import { type WecomProgress, renderWecomProgress } from '../presentation.js';
import { wecomProgressEnabled } from '../../config/message-config.js';
import { splitWecomText, clipWecomStream } from '../text-chunks.js';
import { deliverLatchedNotice } from './outbox.js';
import type { WecomBridge } from '../bridge.js';
import type { Task, WecomBridgePolicy } from './types.js';

/** Ask dispatches of one tick: whether one succeeded, whether one failed. */
export interface AskDispatches {
  dispatched: boolean;
  failed: boolean;
}

/**
 * Interrupt the task's turn, through its peer once handed over. A failure is
 * ignored: a revoked task never resumes either way, and a turn that completed
 * meanwhile can reject the interrupt (its result is kept).
 */
export async function interruptTurn(bridge: WecomBridge, task: Task): Promise<void> {
  try {
    if (task.peer) {
      await bridge.peerCall(task, 'interrupt');
    } else {
      await bridge.options.core.interrupt(task.sessionId!, task.triggerId!);
    }
  } catch { /* see above */ }
}

/** A turn still running: its asks, its progress, the quota hand-over, the reminders. */
export async function whileRunning(bridge: WecomBridge, task: Task, asks: AskDispatches): Promise<void> {
  if (!task.peer
    && bridge.options.core.asks
    && bridge.options.core.answerAsk
    && bridge.options.transport.sendCard) {
    await dispatchAsks(bridge, task, asks);
  }
  let progress: WecomProgress | undefined;
  try {
    if (!task.peer) {
      progress = await bridge.options.core.progress?.(task.sessionId!, task.triggerId!);
    }
  } catch { /* external cores can lack this optional authenticated endpoint */ }
  if (task.revoked || task.delivered || !bridge.taskAllowed(task)) {
    if (!task.revoked) {
      bridge.revoke(task);
    }
    await interruptTurn(bridge, task);
    return;
  }
  const policy = bridge.policy();
  const fallback = policy.quotaFallbackBot;
  // A target that does not accept this connection (peer trust), or whose
  // gateway is not running, is not asked: the turn is not interrupted,
  // and its limit result reaches the user as usual.
  if (!task.peer
    && !task.stopRequested
    && progress?.limit
    && fallback?.enabled
    && fallback.peerId
    && fallback.kinds.includes(progress.limit.kind)
    && !task.fallbackIntent
    && bridge.peerAccepted(fallback.peerId, 'fallback')
    && bridge.peerOnline(fallback.peerId)) {
    await handOverToPeer(bridge, task, fallback, progress.limit.key);
    return;
  }
  if (progress
    && progress.turnId === task.triggerId
    && (!task.progressGeneration || progress.workerGeneration >= task.progressGeneration)) {
    await recordProgress(bridge, task, progress, policy);
  }
  if (progress) {
    await bridge.reminders.longTask(task, progress);
  } else {
    bridge.reminders.clearLongTask(task);
  }
  if (noProgressNoticeDue(bridge, task)) {
    await sendNoProgressNotice(bridge, task);
  }
  bridge.save();
}

/** The CLI asks of a running turn, as ask cards (native-ask.ts). */
async function dispatchAsks(bridge: WecomBridge, task: Task, asks: AskDispatches): Promise<void> {
  // A failure here skips this tick's asks only: progress, the quota
  // fallback and the reminders still run (an external core may reject
  // the asks endpoints on every tick).
  try {
    await dispatchWecomAsks({
      state: bridge.state,
      core: bridge.options.core as NativeAskCore,
      sessionId: task.sessionId!,
      triggerId: task.triggerId!,
      message: task.message,
      save: () => bridge.save(),
      allowed: () => !bridge.halted && !task.revoked && !task.stopRequested && bridge.taskAllowed(task),
      sendCard: (recipient, card) => bridge.sendCard(recipient, card),
    });
    asks.dispatched = true;
  } catch (error) {
    if (bridge.poisoned) {
      throw error;
    }
    asks.failed = true;
    if (!bridge.asksFailureLogged) {
      bridge.asksFailureLogged = true;
      const reason = error instanceof Error && !/secret|token|https?:/i.test(error.message)
        ? `：${error.message.slice(0, 200)}`
        : '';
      (bridge.options.log ?? (line => console.error(line)))(
        `[wecom] CLI 提问暂不可读取或回报，跳过提问卡片，进度与提醒照常${reason}`,
      );
    }
  }
}

/**
 * Hand a turn that hit a quota limit over to the configured peer, at most once:
 * the intent is saved, the turn interrupted, the peer asked, and only then the
 * user told. Any failure leaves the intent uncertain; nothing is retried.
 */
async function handOverToPeer(
  bridge: WecomBridge,
  task: Task,
  fallback: NonNullable<WecomBridgePolicy['quotaFallbackBot']>,
  limitKey: string,
): Promise<void> {
  const id = `handoff_${task.streamId.slice(0, 48)}`;
  task.fallbackIntent = { id, peerId: fallback.peerId!, status: 'pending', limitKey };
  bridge.save();
  try {
    await bridge.options.core.interrupt(task.sessionId!, task.triggerId!);
    if (task.stopRequested || task.revoked || !bridge.taskAllowed(task)) {
      task.fallbackIntent.status = 'cancelled';
      bridge.save();
      return;
    }
    const accepted = await bridge.sendPeer(fallback.peerId!, {
      ...bridge.peerBody(fallback.peerId!, task.message, 'fallback', id),
      request: task.request,
    }) as unknown as TriggerResponse;
    if (!accepted.ok || !accepted.target?.sessionId || !accepted.triggerId) {
      throw new Error();
    }
    task.peer = {
      id: fallback.peerId!,
      requestId: id,
      sessionId: accepted.target.sessionId,
      triggerId: accepted.triggerId,
    };
    task.fallbackIntent.status = 'accepted';
    bridge.save();
    if (task.stopRequested || task.revoked || !bridge.taskAllowed(task)) {
      await bridge.peerCall(task, 'interrupt');
      return;
    }
    await bridge.options.transport.send(
      bridge.recipient(task),
      fallback.message || '当前任务已由已授权的本机备用 Bot 接纳；结果仍由本 Bot 返回。',
    );
  } catch {
    task.fallbackIntent.status = 'uncertain';
    bridge.save();
  }
}

/**
 * A progress report of the task's own turn: recorded, and shown on the
 * task's stream (or, in legacy mode, as messages) when its text changed and
 * progress streaming is on.
 */
async function recordProgress(
  bridge: WecomBridge,
  task: Task,
  progress: WecomProgress,
  policy: WecomBridgePolicy,
): Promise<void> {
  task.progressGeneration = progress.workerGeneration;
  if (progress.model) {
    task.model = progress.model;
  }
  const text = bridge.sanitize(renderWecomProgress(progress, policy), policy);
  const signature = createHash('sha256')
    .update(JSON.stringify([
      progress.workerGeneration,
      progress.dispatchAttempt,
      progress.entries,
      progress.goal && { objective: progress.goal.objective, status: progress.goal.status },
    ]))
    .digest('hex');
  task.lastProgressAtMs = progress.lastProgressAtMs
    ?? (signature !== task.observedProgressSignature ? Date.now() : task.lastProgressAtMs);
  task.observedProgressSignature = signature;
  if (text !== task.progressText && (text || task.progressText) && wecomProgressEnabled(policy)) {
    if (policy.replyCardMode === 'legacy') {
      for (const part of splitWecomText(clipWecomStream(text || '正在处理…'))) {
        if (task.revoked || !bridge.taskAllowed(task)) {
          break;
        }
        await bridge.options.transport.send(bridge.recipient(task), bridge.sanitize(part));
      }
    } else {
      await bridge.replyTask(task, clipWecomStream(text || '正在处理…'), {
        streamId: task.streamId,
        finish: false,
      });
      // An acknowledged frame on the task's stream: the card exists
      // and the end of the turn must close it (confirmedAdmissionNotice).
      if (!task.streamFrameAcknowledged) {
        task.streamFrameAcknowledged = true;
        bridge.save();
      }
    }
  }
  if (wecomProgressEnabled(policy)) {
    task.progressText = text;
  }
}

/** Whether a running task is due the no-progress notice (Codex CLIs; the policy is read again here). */
function noProgressNoticeDue(bridge: WecomBridge, task: Task): boolean {
  const noticePolicy = bridge.policy();
  const notice = noticePolicy.noProgressNotify;
  const enabled = noticePolicy.cli === 'codex'
    ? notice?.cliEnabled === true
    : noticePolicy.cli === 'codex-app' && notice?.enabled !== false;
  return !!(enabled
    && notice
    && !task.noProgressNotified
    && Date.now() >= (task.noProgressRetryAt ?? 0)
    && Date.now() - (task.lastProgressAtMs ?? task.createdAt ?? Date.now())
      >= (notice.timeoutMs ?? (noticePolicy.cli === 'codex' ? 300000 : 90000)));
}

/** The no-progress notice: a latched notice (outbox.ts) whose latch is `noProgressNotified`. */
function sendNoProgressNotice(bridge: WecomBridge, task: Task): Promise<void> {
  return deliverLatchedNotice({
    intend: () => {
      task.noProgressNotified = true;
    },
    stillWanted: () => bridge.allowed(task.message.userId) && !task.revoked,
    send: () => bridge.options.transport.send(bridge.recipient(task), '任务仍在运行，暂未观察到新进展；可使用 /status 查看或 /stop 停止。'),
    failed: retryAt => {
      task.noProgressNotified = false;
      task.noProgressRetryAt = retryAt;
    },
  }, { save: () => bridge.save(), now: () => Date.now() });
}
