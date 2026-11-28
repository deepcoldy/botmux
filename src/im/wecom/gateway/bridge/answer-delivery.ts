/**
 * The delivery of a settled task's answer (tick.ts): the /summary memory, the
 * close of a silent turn's stream card, the answer on the task's stream or,
 * when that fails, in proactive parts, then the auxiliary cards.
 *
 * Functions here take the bridge as their first argument and run on its lane,
 * inside the tick.
 */
import { rememberWecomSummary, writeWecomSummaryMemory } from '../native-platform.js';
import { splitWecomText } from '../text-chunks.js';
import { recordThenSend } from './outbox.js';
import type { TaskStep } from './tick.js';
import type { WecomBridge } from '../bridge.js';
import type { Task, WecomBridgePolicy } from './types.js';

/** Closes a stream card that carries no answer (a silent turn). The platform
 *  offers no withdraw for a stream reply and an empty finish frame is not
 *  verified to be accepted, so the card ends on one neutral line. */
export const WECOM_SILENT_TURN_CLOSE = '已处理，无需回复。';

/**
 * What is in front of the requester that the end of a turn without an answer
 * must close — decided from what the platform acknowledged, never from the
 * policy at completion (an admin may switch the streaming setting mid-turn):
 *
 * - `stream`: a stream card on the task's stream, confirmed by an acknowledged
 *   admission notice or by an acknowledged progress frame
 *   (`streamFrameAcknowledged`; progress may open the card when admission did
 *   not). A failed or unacknowledged frame confirms nothing.
 * - `private`: written by earlier versions only (a private "正在处理…" from a
 *   group); nothing is posted to close it.
 * - `none`: nothing confirmed; nothing new may be posted.
 *
 * Tasks admitted by an earlier build carry no admission record. For them a
 * stream card is assumed only when progress was recorded: `progressText` is
 * set only while progress streaming is explicitly enabled
 * (`disableStreamingCard: false`, not final-only), and admission opens the card
 * under that policy. In the default configuration (`disableStreamingCard`
 * unset) progress is never recorded, so an earlier-build task there that ends
 * silently keeps its "正在处理…" card — a one-time effect for tasks in flight
 * across the upgrade.
 */
export function confirmedAdmissionNotice(task: Task): 'stream' | 'private' | 'none' {
  if (task.streamFrameAcknowledged === true) {
    return 'stream';
  }
  if (task.admissionNotice !== undefined) {
    return task.admissionNoticeSent === true ? task.admissionNotice : 'none';
  }
  return task.progressText ? 'stream' : 'none';
}

/**
 * Finish the stream card admission opened, without an answer in it.
 *
 * At most two attempts across restarts: the attempt is recorded before the
 * frame is sent, a frame repeated after a crash only updates the same card,
 * and a failed or unacknowledged frame is never retried (an expired callback
 * cannot be revived; the platform ends the card).
 */
async function closeOpenStreamCard(bridge: WecomBridge, task: Task, text: string): Promise<void> {
  if (confirmedAdmissionNotice(task) !== 'stream' || (task.streamCloseAttempts ?? 0) >= 2) {
    return;
  }
  await recordThenSend(bridge, {
    record: () => {
      task.streamCloseAttempts = (task.streamCloseAttempts ?? 0) + 1;
    },
    send: () => bridge.options.transport.reply(task.message, text, { streamId: task.streamId, finish: true }),
    // Not retried; see above.
    onFailure: 'ignore',
  });
}

/** Deliver a settled task's answer (or close its silent turn), then its auxiliary cards. */
export async function deliverAnswer(bridge: WecomBridge, task: Task): Promise<Exclude<TaskStep, 'proceed'>> {
  const policy = bridge.policy();
  rememberSummary(bridge, task, policy);
  if (task.silent) {
    // No reply, no proactive fallback, no auxiliary card. Only what
    // admission put in front of the requester is closed.
    await closeOpenStreamCard(bridge, task, WECOM_SILENT_TURN_CLOSE);
    task.delivered = true;
    bridge.save();
    return 'nextTask';
  }
  const result = await finishStream(bridge, task, policy);
  if (result === undefined) {
    return 'nextTask';
  }
  if (task.proactive && await sendProactiveParts(bridge, task, result) === 'endTick') {
    return 'endTick';
  }
  // Commit answer delivery before awaiting any auxiliary card. A lost
  // card ACK must never replay an already published final answer.
  task.delivered = true;
  bridge.save();
  await bridge.auxiliaryCards(task);
  task.delivered = true;
  bridge.save();
  return 'nextTask';
}

/** After a `/summary` turn: the answer becomes the route's summary memory, also written to the workspace. */
function rememberSummary(bridge: WecomBridge, task: Task, policy: WecomBridgePolicy): void {
  // A silent /summary turn has nothing new to remember: keep the memory as it was.
  if (task.message.text.trim() === '/summary' && policy.summaryMemory && task.workingDirectory && !task.silent) {
    const memory = rememberWecomSummary(bridge.state, task.route, task.result ?? '');
    bridge.save();
    try {
      writeWecomSummaryMemory(
        task.workingDirectory,
        policy.summaryMemoryPath ?? '.botmux/wecom-summary.md',
        memory,
      );
    } catch { /* local memory failure never blocks the admitted reply */ }
  }
}

/**
 * Finish the task's stream with the answer, unless delivery is proactive
 * already; a failed finish makes it proactive. Returns the rendered answer the
 * proactive parts are cut from; undefined when the task lost access on the
 * way (it is revoked).
 */
async function finishStream(bridge: WecomBridge, task: Task, policy: WecomBridgePolicy): Promise<string | undefined> {
  let result = bridge.renderTaskResult(task, policy);
  if (!task.proactive) {
    try {
      await bridge.replyTask(task, result, { streamId: task.streamId, finish: true });
    } catch {
      // Freeze fallback before sending: a partial multipart retry must not replay the full stream.
      task.proactive = true;
      bridge.save();
      if (!bridge.taskAllowed(task)) {
        bridge.revoke(task);
        return undefined;
      }
      result = bridge.renderTaskResult(task, bridge.policy());
      try {
        await bridge.replyTask(task, '结果将通过独立消息发送。', { streamId: task.streamId, finish: true });
      } catch { /* callback unavailable */ }
    }
  }
  return result;
}

/**
 * Proactive delivery of the answer in parts, from the first one not sent yet
 * (`nextPart`, saved after each send). It stops for a revoked, delivered or
 * refused task, and drops the rest once the privacy of the rendering changed.
 */
async function sendProactiveParts(bridge: WecomBridge, task: Task, result: string): Promise<Exclude<TaskStep, 'nextTask'>> {
  const parts = splitWecomText(result).map(part => task.message.chatType === 'group'
    ? `用户 ${task.message.userId.slice(0, 256)} 的任务结果：\n${part}`
    : part);
  for (let index = task.nextPart ?? 0; index < parts.length; index++) {
    if (bridge.halted) {
      return 'endTick';
    }
    if (task.revoked || task.delivered) {
      break;
    }
    if (!bridge.taskAllowed(task)) {
      bridge.revoke(task);
      break;
    }
    if (bridge.resultPrivacyKey(bridge.policy()) !== task.renderedPrivacyKey) {
      delete task.renderedResult;
      task.delivered = true;
      bridge.save();
      break;
    }
    await bridge.options.transport.send(bridge.recipient(task), parts[index]);
    task.nextPart = index + 1;
    bridge.save();
  }
  return 'proceed';
}
