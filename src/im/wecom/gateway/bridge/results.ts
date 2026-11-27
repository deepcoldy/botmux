/**
 * Final result rendering and the auxiliary cards (feedback, controls) sent after
 * the answer itself has been committed as delivered, while their buttons would
 * still be honoured.
 *
 * Functions here are WecomBridge methods: they run with `this` bound to the bridge
 * (the class in ../bridge.ts forwards to them), so they share its state and lane.
 */
import { wecomFeedbackPolicy } from '../native-platform.js';
import { renderWecomFinal, buildWecomTaskCard } from '../presentation.js';
import { taskCardActionsExpired } from './card-events.js';
import { recordThenSend } from './outbox.js';
import type { FeedbackPolicy } from '../../../../services/feedback-policy.js';
import type { WecomBridgePolicy, Task } from './types.js';
import type { WecomBridge } from '../bridge.js';

/**
 * What a cached rendering depends on that may hide content. The first slot held
 * the retired final-thinking switch and is always false now, so a rendering an
 * earlier version cached without it stays valid.
 */
export function resultPrivacyKey(this: WecomBridge, policy: WecomBridgePolicy): string {
  return JSON.stringify([false, policy.hideLocalAddresses === true]);
}

export function renderTaskResult(this: WecomBridge, task: Task, policy: WecomBridgePolicy): string {
  const key = this.resultPrivacyKey(policy);
  if (task.renderedPrivacyKey !== key) {
    delete task.renderedResult;
    task.renderedPrivacyKey = key;
  }
  task.renderedResult ??= renderWecomFinal(
    task.result ?? '',
    policy,
    {
      usage: task.usage,
      elapsedMs: task.createdAt && task.completedAt ? task.completedAt - task.createdAt : undefined,
      model: task.model,
      recipient: task.message.userId,
    },
  );
  return this.sanitize(task.renderedResult, policy);
}

export async function auxiliaryCards(this: WecomBridge, task: Task): Promise<void> {
  if (this.halted
    || task.revoked
    || task.stopRequested
    || !task.delivered
    // A silent turn posted no answer: no feedback or controls card for it.
    || task.silent
    // Its buttons would be refused (card-events.ts): no card, and nothing recorded.
    || taskCardActionsExpired(task)
    || !this.options.transport.sendCard
    || !this.taskAllowed(task)) {
    return;
  }
  const policy = this.policy();
  const authorized = () => !this.halted && !task.revoked && !task.stopRequested && this.taskAllowed(task);
  if (!task.finalCardAttempted && authorized()) {
    const feedbackPolicy = wecomFeedbackPolicy(policy, task.message.conversationId);
    const card = buildWecomTaskCard({
      taskId: `${task.streamId}-final`,
      running: false,
      policy: { ...policy, replyCardActions: false, feedback: feedbackPolicy as FeedbackPolicy | undefined },
      feedback: true,
    });
    if (card) {
      // The attempt is retained on an unknown ACK.
      await recordThenSend(this, {
        record: () => {
          task.finalCardAttempted = true;
          if (feedbackPolicy?.enabled) {
            task.feedbackPolicy = structuredClone(feedbackPolicy);
          }
        },
        send: () => this.sendCard(this.recipient(task), card),
        onFailure: 'ignore',
      });
    }
  }
  if (!task.controlsCardAttempted && authorized()) {
    const controls = buildWecomTaskCard({
      taskId: `${task.streamId}-controls`,
      running: false,
      policy: { ...policy, feedback: undefined },
    });
    if (controls) {
      // Attempted controls are not repeated; other unattempted cards may resume.
      await recordThenSend(this, {
        record: () => {
          task.controlsCardAttempted = true;
        },
        send: () => this.sendCard(this.recipient(task), controls),
        onFailure: 'ignore',
      });
    }
  }
}
