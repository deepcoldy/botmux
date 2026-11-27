/**
 * The periodic tick: dispatch, running card, result polling, asks, progress, quota
 * fallback handoff, reminders and final delivery for every task, then owner
 * reminders, the feedback outbox and, when due, a prune of the state (prune.ts).
 * A running turn's part is running-turn.ts, the delivery of an answer
 * answer-delivery.ts.
 *
 * `tick` is a WecomBridge method: it runs with `this` bound to the bridge (the
 * class in ../bridge.ts forwards to it), on its lane; the functions it calls
 * take the bridge as their first argument.
 */
import { dirname } from 'node:path';
import { WecomPeerAuthorityChangedError } from './peer.js';
import { enqueueWecomFeedbackEvent, dispatchWecomFeedbackOutbox } from '../native-feedback.js';
import type { TriggerResponse } from '../../../../services/trigger-types.js';
import { buildWecomTaskCard } from '../presentation.js';
import { CoreRejectedError, isTurnSessionGone } from '../core-client.js';
import { turnRepository, wecomTurnRequest } from './turn-request.js';
import { hasUserVisibleText } from '../../../../services/bridge-fallback-gate.js';
import { pruneWhenDue } from './prune.js';
import { recordThenSend } from './outbox.js';
import { interruptTurn, whileRunning, type AskDispatches } from './running-turn.js';
import { confirmedAdmissionNotice, deliverAnswer } from './answer-delivery.js';
import type { WecomBridge } from '../bridge.js';
import type { Task } from './types.js';

export { WECOM_SILENT_TURN_CLOSE } from './answer-delivery.js';

/** Put on the task's open stream card when its conversation moves to a new session. */
const WECOM_SESSION_RENEWED = '原会话已结束，正在新会话中处理（之前的对话上下文不延续）…';

const TURN_REJECTED = '任务请求被拒绝，请检查 core 配置后使用 /restart 重试。';

/**
 * The task was admitted for a session the core no longer has (closed when the
 * agent was switched, by a core restart, or for any other reason): its
 * conversation moves to a new session, as if the user had sent `/restart`.
 * The stale route is dropped, and the frozen request becomes the one admission
 * builds for a new session (turn-request.ts) — the user's text kept, the quota
 * it took at admission kept, the same task key now as the new session's
 * idempotency key — and is saved before it is sent. A new-session request has
 * no sessionId, so a task moves at most once. False when the task ended
 * instead: the route's repository selection no longer holds.
 */
async function renewSession(bridge: WecomBridge, task: Task): Promise<boolean> {
  const policy = bridge.policy();
  if (bridge.state.routes[task.route] === task.request.target.sessionId) {
    delete bridge.state.routes[task.route];
  }
  const repository = await turnRepository.call(bridge, {
    route: task.route,
    message: task.message,
    key: task.streamId,
    policy,
  });
  if ('refusal' in repository) {
    task.result = repository.refusal;
    bridge.save();
    return false;
  }
  const turn = wecomTurnRequest.call(bridge, {
    message: task.message,
    key: task.streamId,
    envelope: task.request.envelope,
    policy,
    selected: repository.selected,
  });
  task.request = turn.request;
  task.workingDirectory = turn.workingDirectory;
  task.model = turn.model;
  bridge.save();
  // The context of the earlier conversation does not carry over: say so on the
  // card the requester is looking at. Once, best effort.
  if (confirmedAdmissionNotice(task) === 'stream') {
    try {
      await bridge.replyTask(task, WECOM_SESSION_RENEWED, { streamId: task.streamId, finish: false });
    } catch { /* not retried */ }
  }
  return true;
}

/** Send the task's turn; undefined when the core refused it and the task ended. */
async function dispatchTurn(bridge: WecomBridge, task: Task): Promise<TriggerResponse | undefined> {
  for (;;) {
    try {
      return await bridge.options.core.trigger(task.request);
    } catch (error) {
      if (!(error instanceof CoreRejectedError)) {
        throw error;
      }
      if (task.request.target.sessionId && isTurnSessionGone(error)) {
        if (await renewSession(bridge, task)) {
          continue;
        }
        return undefined;
      }
      task.result = TURN_REJECTED;
      bridge.save();
      return undefined;
    }
  }
}

/**
 * The result of a task handed over to a peer, or of its own turn. A hand-over
 * whose authority changed (peer trust no longer holds, or a record of an
 * earlier version) ends here: the task is revoked like any task whose access
 * changed, so its conversation is free again; nothing more is asked of the peer.
 */
async function pollResult(bridge: WecomBridge, task: Task): Promise<TriggerResponse | undefined> {
  if (!task.peer) {
    return bridge.options.core.result(task.sessionId!, task.triggerId!);
  }
  try {
    return await bridge.peerCall(task, 'result');
  } catch (error) {
    if (error instanceof WecomPeerAuthorityChangedError) {
      bridge.revoke(task);
      return undefined;
    }
    throw error;
  }
}

/**
 * What is left of one task's tick after a step: go on with the task, go on
 * with the next task, or end the whole tick (the bridge was halted).
 */
export type TaskStep = 'proceed' | 'nextTask' | 'endTick';

export function tick(this: WecomBridge): Promise<void> {
  return this.enqueue(async () => {
    // A failed ask dispatch is logged once; a tick whose every dispatch
    // succeeded ends that run of failures, so the next failure is logged again.
    const asks: AskDispatches = { dispatched: false, failed: false };
    for (const task of Object.values(this.state.tasks)) {
      if (this.halted) {
        return;
      }
      if (task.delivered) {
        await this.auxiliaryCards(task);
        continue;
      }
      if (!this.taskAllowed(task)) {
        this.revoke(task);
        if (task.sessionId && task.triggerId) {
          await interruptTurn(this, task);
        }
        continue;
      }
      try {
        if (await advanceTask(this, task, asks) === 'endTick') {
          return;
        }
      } catch (error) {
        if (this.poisoned) {
          throw error;
        }
        // One unavailable session or conversation must not starve other users.
      }
    }
    if (asks.dispatched && !asks.failed) {
      this.asksFailureLogged = false;
    }
    if (!this.halted) {
      await this.reminders.owners();
      await dispatchWecomFeedbackOutbox({
        state: this.state,
        save: () => this.save(),
        secretDir: dirname(this.options.stateFile),
        allow: () => !this.halted,
      });
      // Last, on the lane: no task of this tick is still being worked on.
      pruneWhenDue.call(this);
    }
  });
}

/** A task that may run and is not delivered yet: dispatch its turn, follow it, deliver its answer. */
async function advanceTask(bridge: WecomBridge, task: Task, asks: AskDispatches): Promise<Exclude<TaskStep, 'proceed'>> {
  if (task.result === undefined && (!task.sessionId || !task.triggerId)) {
    if (await dispatchTask(bridge, task) === 'nextTask') {
      return 'nextTask';
    }
  }
  if (bridge.halted) {
    return 'endTick';
  }
  if (task.result === undefined && !task.runningCardAttempted && bridge.options.transport.sendCard) {
    await sendRunningCard(bridge, task);
  }
  if (task.result === undefined && await followTurn(bridge, task, asks) === 'nextTask') {
    return 'nextTask';
  }
  if (bridge.halted) {
    return 'endTick';
  }
  if (task.revoked || task.delivered) {
    return 'nextTask';
  }
  if (!bridge.taskAllowed(task)) {
    bridge.revoke(task);
    return 'nextTask';
  }
  return deliverAnswer(bridge, task);
}

/**
 * Send the turn of a task that has none yet, the attempt saved first (a replay
 * sends the same request under the same idempotency key), and take its
 * session and trigger ids.
 */
async function dispatchTask(bridge: WecomBridge, task: Task): Promise<Exclude<TaskStep, 'endTick'>> {
  task.dispatchAttempted = true;
  bridge.save();
  const response = await dispatchTurn(bridge, task);
  if (!response) {
    return 'nextTask';
  }
  if (!response.ok || !response.target?.sessionId || !response.triggerId) {
    if (!response.ok) {
      task.result = TURN_REJECTED;
      bridge.save();
      return 'nextTask';
    }
    throw new Error('企微任务派发响应缺少任务标识');
  }
  if (task.revoked || task.delivered) {
    return 'nextTask';
  }
  task.sessionId = response.target.sessionId;
  task.triggerId = response.triggerId;
  if (!bridge.taskAllowed(task)) {
    bridge.revoke(task);
    await interruptTurn(bridge, task);
    return 'nextTask';
  }
  bridge.reminders.rememberOwner(task, !task.request.target.sessionId);
  bridge.state.routes[task.route] = task.sessionId;
  bridge.save();
  return 'proceed';
}

/**
 * The 任务处理中 card of a dispatched task, attempted once (outbox.ts). A failed
 * send is not ignored: it ends this task's tick.
 */
async function sendRunningCard(bridge: WecomBridge, task: Task): Promise<void> {
  const card = buildWecomTaskCard({ taskId: `${task.streamId}-run`, running: true, policy: bridge.policy() });
  if (card) {
    await recordThenSend(bridge, {
      record: () => {
        task.runningCardAttempted = true;
      },
      send: () => bridge.sendCard(bridge.recipient(task), card),
      onFailure: 'throw',
    });
  }
}

/**
 * Poll the turn of a dispatched task. A turn still running gets its asks,
 * progress, hand-over and reminders, and the task waits for the next tick; a
 * settled one is recorded and the task goes on to delivery.
 */
async function followTurn(bridge: WecomBridge, task: Task, asks: AskDispatches): Promise<Exclude<TaskStep, 'endTick'>> {
  if (task.stopRequested) {
    await interruptTurn(bridge, task);
  }
  const response = await pollResult(bridge, task);
  if (!response || task.revoked || task.delivered) {
    return 'nextTask';
  }
  if (!bridge.taskAllowed(task)) {
    bridge.revoke(task);
    await interruptTurn(bridge, task);
    return 'nextTask';
  }
  // A stop may arrive during result polling, after the pre-poll check.
  if (task.stopRequested) {
    await interruptTurn(bridge, task);
  }
  if (!response.ok || !response.state) {
    throw new Error('企微任务结果查询失败');
  }
  if (response.state === 'running') {
    await whileRunning(bridge, task, asks);
    return 'nextTask';
  }
  recordSettled(bridge, task, response);
  return 'proceed';
}

/** A settled turn: its result, usage and turn.completed feedback event, in one save. */
function recordSettled(bridge: WecomBridge, task: Task, response: TriggerResponse): void {
  // A completed turn with no visible text: the core settles a turn the
  // model ended with BOTMUX_NOTHING_TO_SEND as empty output, and a
  // non-deliberate empty never arrives as completed (it stays running,
  // fails, or carries the worker's empty-final notice). Post nothing for it.
  const content = response.output?.content ?? '';
  const visible = hasUserVisibleText(content);
  const silent = response.state === 'completed' && !visible;
  task.result = response.state === 'completed'
    ? (visible ? bridge.sanitize(content) : '')
    : response.state === 'interrupted' ? '任务已停止。' : '任务失败或会话已失效，请使用 /restart 后重试。';
  if (silent) {
    task.silent = true;
  }
  bridge.reminders.clearLongTask(task);
  task.completedAt = Date.now();
  task.usage = response.usage;
  enqueueWecomFeedbackEvent(bridge.state, bridge.policy(), {
    type: 'turn.completed',
    botId: bridge.options.botId,
    taskId: task.streamId,
    sessionId: task.sessionId!,
    triggerId: task.triggerId!,
    conversationId: task.message.conversationId,
  });
  bridge.save();
}
