/**
 * Where replies go: the delivery recipient of a task, callback vs proactive replies,
 * and the logical route (session key) of an inbound message.
 *
 * Functions here are WecomBridge methods: they run with `this` bound to the bridge
 * (the class in ../bridge.ts forwards to them), so they share its state and lane.
 */
import { wecomRouteForMessage, isSharedWecomRoute } from '../../config/session-mode.js';
import type { WecomInboundMessage } from '../../protocol/types.js';
import type { Task } from './types.js';
import type { WecomBridge } from '../bridge.js';

/**
 * A task's replies go back to the conversation it came from: the group for a
 * group message, the requester for a private one. A task an earlier version
 * admitted for private delivery (`deliveryPrivate`) is answered the same way.
 */
export function recipient(this: WecomBridge, task: Task): string {
  return task.message.conversationId;
}

export async function replyTask(
  this: WecomBridge,
  task: Task,
  text: string,
  options?: { streamId?: string; finish?: boolean },
): Promise<void> {
  await this.options.transport.reply(task.message, text, options);
}

export function routeForMessage(this: WecomBridge, message: WecomInboundMessage): string {
  const route = wecomRouteForMessage(message, this.policy());
  // A setting change cannot create a second conversation while its old
  // logical route still owns a turn. Wait for that admitted turn to settle.
  const activeTasks = Object.values(this.state.tasks).filter(task => !task.delivered
    && task.message.chatType === message.chatType
    && task.message.conversationId === message.conversationId);
  const active = activeTasks.find(task => task.message.userId === message.userId)
    ?? activeTasks.find(task => isSharedWecomRoute(route) || isSharedWecomRoute(task.route));
  return active?.route ?? route;
}
