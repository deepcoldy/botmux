/**
 * Template-card button events: ask answers, grant approval, terminal links,
 * output / compact, stop / close and feedback.
 *
 * Functions here are WecomBridge methods: they run with `this` bound to the bridge
 * (the class in ../bridge.ts forwards to them), so they share its state and lane.
 */
import { createHash } from 'node:crypto';
import { createTerminalMintClient, requestTerminalMint } from './terminal-mint.js';
import { wecomAskCardEvent, type NativeAskCore } from '../native-ask.js';
import { enqueueWecomFeedbackEvent } from '../native-feedback.js';
import { wecomFeedbackPolicy } from '../native-platform.js';
import { nativeApproveRequest } from '../native-core.js';
import { cliSupportsCompactAction } from '../../../../core/passthrough-commands.js';
import type { FeedbackPolicy } from '../../../../services/feedback-policy.js';
import type { WecomCardEvent, WecomTemplateCard } from '../../protocol/types.js';
import type { NativeTerminalRequest } from '../../contract/dashboard-routes.js';
import type { WecomBridge } from '../bridge.js';
import type { Task, WecomBridgePolicy } from './types.js';

/** How long after its creation a task's card buttons are honoured. */
export const WECOM_CARD_ACTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a button on this task's cards is refused for the task's age: it has
 * no `createdAt` (an earlier version's task), or was created longer than
 * WECOM_CARD_ACTION_WINDOW_MS ago. A card whose buttons would be refused is
 * not sent either (results.ts).
 */
export function taskCardActionsExpired(task: Pick<Task, 'createdAt'>, now = Date.now()): boolean {
  return !task.createdAt || now - task.createdAt > WECOM_CARD_ACTION_WINDOW_MS;
}

/** A task whose card buttons may be honoured: it has its turn's session and trigger. */
type CardTask = Task & { sessionId: string; triggerId: string };

/** Native events bypass the network queue only for a synchronous checked
 * state transition + callback ACK, so the platform's five-second deadline
 * cannot be consumed by a long core poll. Core actions still use the lane. */
export async function receiveCardEvent(this: WecomBridge, event: WecomCardEvent): Promise<void> {
  if (this.halted || this.poisoned || event.botId !== this.options.botId || Date.now() - event.receivedAt >= 4500) {
    return;
  }
  if (clickerDenied.call(this, event)) {
    return;
  }
  if (event.taskId.startsWith('ask_')
    && this.options.core.asks
    && this.options.core.answerAsk
    && await answerAskCard.call(this, event)) {
    return;
  }
  // A button on a card of the retired local business features (`biz_…` task
  // ids) matches nothing below and is ignored: nothing recorded or answered.
  if (event.eventKey.startsWith('grant:')) {
    await approveGrantRequest.call(this, event);
    return;
  }
  const task = Object.values(this.state.tasks).find(item => `${item.streamId}-final` === event.taskId
    || `${item.streamId}-controls` === event.taskId
    || `${item.streamId}-run` === event.taskId);
  if (!honoursCardEvent(this, event, task)) {
    return;
  }
  const policy = this.policy();
  if (event.eventKey === 'action:terminal' || event.eventKey === 'action:writeLink') {
    await receiveTerminalLinkEvent.call(this, event, task, { sessionId: task.sessionId, triggerId: task.triggerId });
    return;
  }
  if (event.eventKey === 'action:output') {
    await showOutput.call(this, event, task, policy);
    return;
  }
  if (event.eventKey === 'action:compact') {
    await compactSession.call(this, event, task, policy);
    return;
  }
  // Any other action — such as `action:substitute` from a card an earlier
  // version sent — is ignored here: nothing is recorded or answered.
  if (event.eventKey.startsWith('action:')) {
    await controlSessionFromCard.call(this, event, task, policy);
    return;
  }
  await recordFeedback.call(this, event, task, policy);
}

/** Whether the clicker may not act in the chat of the card (or of the task the card belongs to). */
function clickerDenied(this: WecomBridge, event: WecomCardEvent): boolean {
  const askOrigin = this.state.nativeAsks?.[event.taskId]?.snapshot.origin;
  const eventSource = Object.values(this.state.tasks).find(t => `${t.streamId}-final` === event.taskId
    || `${t.streamId}-controls` === event.taskId
    || `${t.streamId}-run` === event.taskId
    || (askOrigin && t.sessionId === askOrigin.sessionId && t.triggerId === askOrigin.turnId));
  return this.capability(
    eventSource
      ? { ...eventSource.message, userId: event.userId }
      : { userId: event.userId, chatType: event.chatType, conversationId: event.conversationId },
    false,
  ) === 'denied';
}

/** A button on a CLI ask card (native-ask.ts); false when the event is not one. */
function answerAskCard(this: WecomBridge, event: WecomCardEvent): Promise<boolean> {
  return wecomAskCardEvent({
    state: this.state,
    core: this.options.core as NativeAskCore,
    event,
    save: () => this.save(),
    allowed: user => this.capability(
      { userId: user, chatType: event.chatType, conversationId: event.conversationId },
      false,
    ) !== 'denied',
    current: origin => Object.values(this.state.tasks).some(t => t.sessionId === origin.sessionId
      && t.triggerId === origin.turnId
      && !t.revoked
      && !t.stopRequested
      && this.taskAllowed(t)),
    update: async (card) => {
      await this.updateCard(event, card);
    },
  });
}

/** 批准对话 on a talk-permission request card (inbound.ts). */
async function approveGrantRequest(this: WecomBridge, event: WecomCardEvent): Promise<void> {
  const id = event.eventKey.slice(6);
  if (event.taskId !== `grant-${id}`
    || !nativeApproveRequest(this.state.native!, this.policy(), id, event.userId, Date.now())) {
    return;
  }
  this.save();
  await this.updateCard(event, {
    card_type: 'text_notice',
    task_id: event.taskId,
    main_title: { title: '已批准对话权限' },
  }).catch(() => {});
}

/**
 * Whether `task` (the task whose card the button is on) still honours the
 * button: its turn was dispatched, it was not revoked or too old, the event
 * comes from the task's chat, and this callback was not acted on before.
 */
function honoursCardEvent(bridge: WecomBridge, event: WecomCardEvent, task: Task | undefined): task is CardTask {
  return !!task
    && !task.revoked
    && !!task.sessionId
    && !!task.triggerId
    && !taskCardActionsExpired(task)
    && bridge.recipient(task) === event.conversationId
    && task.message.chatType === event.chatType
    && !task.cardEvents?.[event.messageId];
}

/** 查看输出: the card becomes a summary of the delivered answer. */
async function showOutput(this: WecomBridge, event: WecomCardEvent, task: CardTask, policy: WecomBridgePolicy): Promise<void> {
  if (!task.delivered
    || ![`${task.streamId}-final`, `${task.streamId}-controls`].includes(event.taskId)
    || !policy.replyCardActions
    || this.state.routes[task.route] !== task.sessionId
    || policy.hiddenStreamingCardButtons?.includes('output')) {
    return;
  }
  (task.cardEvents ??= {})[event.messageId] = true;
  this.save();
  await this.updateCard(event, {
    card_type: 'text_notice',
    task_id: event.taskId,
    main_title: { title: '输出摘要（当前会话可见）' },
    sub_title_text: this.sanitize((task.result ?? '').slice(0, 1800)),
  }).catch(() => {});
}

/**
 * 压缩上下文 on the latest task of the session: `/compact` is sent at most once
 * per card, on the lane; the card then says whether it was submitted.
 */
async function compactSession(this: WecomBridge, event: WecomCardEvent, task: CardTask, policy: WecomBridgePolicy): Promise<void> {
  if (!task.delivered
    || ![`${task.streamId}-final`, `${task.streamId}-controls`].includes(event.taskId)
    || this.capability({ ...task.message, userId: event.userId }, false) !== 'operate'
    || this.state.routes[task.route] !== task.sessionId
    || Object.values(this.state.tasks).filter(t => t.sessionId === task.sessionId).at(-1) !== task
    || this.state.sessionLocks?.[task.sessionId]
    || !policy.replyCardActions
    || policy.hiddenStreamingCardButtons?.includes('compact')
    || !cliSupportsCompactAction(policy.cli as any)
    || !this.options.core.slash) {
    return;
  }
  const key = `compact:${event.taskId}`;
  if (this.state.native!.actions[key]) {
    return;
  }
  this.state.native!.actions[key] = 'pending';
  (task.cardEvents ??= {})[event.messageId] = true;
  this.save();
  await this.enqueue(async () => {
    try {
      if (this.capability({ ...task.message, userId: event.userId }, false) !== 'operate') {
        throw new Error();
      }
      await this.options.core.slash!(task.sessionId!, '/compact');
      this.state.native!.actions[key] = 'completed';
    } catch {
      this.state.native!.actions[key] = 'uncertain';
    }
    this.save();
  });
  await this.updateCard(event, {
    card_type: 'text_notice',
    task_id: event.taskId,
    main_title: { title: String(this.state.native!.actions[key]) === 'completed' ? '已提交压缩' : '压缩结果未确认，不会自动重试' },
  }).catch(() => {});
}

/** 停止任务 (run card) / 关闭会话 (final or controls card), by the requester, as host session control. */
async function controlSessionFromCard(this: WecomBridge, event: WecomCardEvent, task: CardTask, policy: WecomBridgePolicy): Promise<void> {
  const operation = event.eventKey === 'action:stop'
    ? 'interrupt'
    : event.eventKey === 'action:close' ? 'close' : undefined;
  if (!operation
    || this.state.routes[task.route] !== task.sessionId
    || Object.values(this.state.tasks).filter(item => item.sessionId === task.sessionId).at(-1) !== task
    || event.userId !== task.message.userId
    || !policy.replyCardActions
    || policy.hiddenStreamingCardButtons?.includes(operation === 'interrupt' ? 'stop' : 'close')
    || (operation === 'interrupt'
      ? task.delivered || event.taskId !== `${task.streamId}-run`
      : !task.delivered
        || ![`${task.streamId}-final`, `${task.streamId}-controls`].includes(event.taskId)
        || !this.options.core.close)) {
    return;
  }
  (task.cardEvents ??= {})[event.messageId] = true;
  this.save();
  // Durable control intent is committed synchronously before the first await.
  const control = this.controlSession(
    {
      sessionId: task.sessionId,
      operation,
      requestId: `card_${createHash('sha256').update(event.messageId).digest('hex')}`,
      expectedGeneration: task.triggerId,
      authorize: () => this.allowed(event.userId),
    },
    sid => this.options.core.close!(sid),
  );
  const ack = this.updateCard(event, {
    card_type: 'text_notice',
    task_id: event.taskId,
    main_title: { title: operation === 'interrupt' ? '已请求停止' : '已请求关闭' },
  }).catch(() => {});
  await Promise.all([control, ack]);
}

/**
 * A feedback button (`feedback:` / `reason:`) on the final card, judged under
 * both the policy frozen when the card was sent and the current one; the
 * revision is recorded with its outbox event before the card is updated.
 */
async function recordFeedback(this: WecomBridge, event: WecomCardEvent, task: CardTask, policy: WecomBridgePolicy): Promise<void> {
  const frozen = task.feedbackPolicy;
  const current = wecomFeedbackPolicy(policy, task.message.conversationId);
  if (!task.delivered || event.taskId !== `${task.streamId}-final` || !frozen || !current?.enabled) {
    return;
  }
  const accepts = (feedback: FeedbackPolicy) => feedback.audience === 'everyone'
    || (feedback.audience === 'requester'
      ? event.userId === task.message.userId
      : feedback.reviewers.includes(event.userId));
  if (!accepts(frozen) || !accepts(current)) {
    return;
  }
  const feedback = task.feedback ??= {};
  const prior = feedback[event.userId];
  if (event.eventKey.startsWith('feedback:')) {
    const key = event.eventKey.slice(9);
    const button = frozen.buttons.find(button => button.key === key);
    if (!button
      || !current.buttons.some(candidate => candidate.key === key && candidate.semantic === button.semantic)
      || (prior && (!frozen.allowReselect || !current.allowReselect))) {
      return;
    }
    feedback[event.userId] = {
      key,
      semantic: button.semantic,
      at: Date.now(),
      revision: (prior?.revision ?? 0) + 1,
      pending: button.semantic === 'negative'
        && (frozen.negativeFollowup.reasons.length > 0 || frozen.negativeFollowup.comment.required),
    };
  } else if (event.eventKey.startsWith('reason:')) {
    const key = event.eventKey.slice(7);
    if (!prior
      || prior.semantic !== 'negative'
      || (!frozen.negativeFollowup.reasons.some(reason => reason.key === key)
        || !current.negativeFollowup.reasons.some(reason => reason.key === key))) {
      return;
    }
    prior.reason = key;
    prior.revision++;
    prior.pending = frozen.negativeFollowup.comment.required && !prior.comment;
  } else {
    return;
  }
  (task.cardEvents ??= {})[event.messageId] = true;
  enqueueWecomFeedbackEvent(this.state, policy, {
    type: 'feedback.revised',
    botId: this.options.botId,
    taskId: task.streamId,
    sessionId: task.sessionId,
    triggerId: task.triggerId,
    conversationId: task.message.conversationId,
    actor: event.userId,
    revision: feedback[event.userId].revision,
    feedback: feedback[event.userId],
  });
  this.save();
  const selected = feedback[event.userId];
  const reasonButtons = selected.semantic === 'negative' && !selected.reason
    ? frozen.negativeFollowup.reasons.map(reason => ({ text: reason.label, key: `reason:${reason.key}` }))
    : [];
  const reselectButtons = frozen.allowReselect && current.allowReselect
    ? frozen.buttons
      .filter(button => current.buttons.some(candidate => candidate.key === button.key))
      .map(button => ({ text: button.label, key: `feedback:${button.key}` }))
    : [];
  const buttons = reasonButtons.length ? reasonButtons : reselectButtons;
  const card: WecomTemplateCard = {
    card_type: buttons.length ? 'button_interaction' : 'text_notice',
    task_id: event.taskId,
    main_title: { title: selected.pending ? '请补充反馈' : '反馈已记录' },
    ...(buttons.length ? { button_list: buttons } : {}),
    ...(selected.semantic === 'negative' && frozen.negativeFollowup.comment.enabled
      ? {
        sub_title_text: `${frozen.negativeFollowup.comment.placeholder}（最多 ${frozen.negativeFollowup.comment.maxLength} 字）\n/feedback ${event.taskId} 评论内容`,
      }
      : {}),
  };
  await this.updateCard(event, card).catch(() => {});
}

/**
 * A terminal / write-link button: ask the Dashboard for a one-time link and send
 * it to the clicker in a private chat.
 *
 * `task.cardEvents[messageId]` — the callback's own id; a click is one callback,
 * and the platform may deliver a callback more than once — is recorded before
 * the request, so a copy arriving while it is in flight, or after the link was
 * sent, mints nothing. What happens after the request (bridge/terminal-mint.ts):
 *  - minted:    the link is sent; the record stays;
 *  - rejected:  nothing was minted. The record is removed, so this callback can
 *               be tried again, and the clicker is told once that it did not
 *               work. Both are saved in one write before the message goes out;
 *               `terminalMintRejections` keeps a redelivered copy that fails
 *               again from telling them a second time;
 *  - uncertain: no link is sent and the record stays: a link may exist that
 *               nobody received, and this callback delivered again must not
 *               ask for a second one. The clicker is told the outcome is not
 *               known and to click again — a new click is a new callback. A
 *               redelivered copy never gets this far (the record stops it), so
 *               they are told once.
 * A failed write throws like every other save here (the bridge is poisoned);
 * on disk the record from before the request then still stands.
 */
async function receiveTerminalLinkEvent(
  this: WecomBridge,
  event: WecomCardEvent,
  task: Task,
  target: { sessionId: string; triggerId: string },
): Promise<void> {
  const permission = event.eventKey === 'action:terminal' ? 'read' : 'write';
  const request: NativeTerminalRequest = {
    identity: {
      provider: 'wecom',
      connectionId: this.options.connectionId ?? this.options.botId,
      botId: this.options.botId,
      userId: event.userId,
    },
    sessionId: target.sessionId,
    triggerId: target.triggerId,
    permission,
  };
  if (!this.terminalAuthorization(request).allowed) {
    return;
  }
  (task.cardEvents ??= {})[event.messageId] = true;
  this.save();
  const injected = this.options.terminalMintClient;
  // The Dashboard builds the link on its own address; the request names none.
  const outcome = await requestTerminalMint(injected ? () => injected : createTerminalMintClient, request);
  const entry = permission === 'write' ? '操作' : '只读';
  if (outcome.kind === 'minted') {
    try {
      await this.options.transport.send(
        event.userId,
        `当前会话${entry}入口（60秒内仅可兑换一次，兑换后有效5分钟；转发将移交该短期权限，请勿转发）：${outcome.url}`,
      );
    } catch { /* the link may have arrived: never mint a second one for this click */ }
    return;
  }
  if (outcome.kind === 'uncertain') {
    try {
      await this.options.transport.send(event.userId, `当前会话${entry}入口这次没能确认是否生成，请再点一次按钮。`);
    } catch { /* a new click works either way */ }
    return;
  }
  delete task.cardEvents?.[event.messageId];
  const toldBefore = task.terminalMintRejections?.[event.messageId] === true;
  (task.terminalMintRejections ??= {})[event.messageId] = true;
  this.save();
  if (toldBefore) {
    return;
  }
  try {
    await this.options.transport.send(event.userId, `当前会话${entry}入口这次没有生成，请稍后再点一次按钮重试。`);
  } catch { /* the button already works again */ }
}
