/**
 * Access decisions: per-message capability, whether an admitted task may still run,
 * user allow checks, task revocation, and the Dashboard terminal-link authorisation.
 *
 * Functions here are WecomBridge methods: they run with `this` bound to the bridge
 * (the class in ../bridge.ts forwards to them), so they share its state and lane.
 */
import { createHash } from 'node:crypto';
import { nativePolicyRevision, nativeCapability, nativeTaskAllowed } from '../native-core.js';
import type { WecomInboundMessage } from '../../protocol/types.js';
import type { WecomTerminalAuthorization } from '../../contract/gateway-control.js';
import type { Task } from './types.js';
import type { WecomBridge } from '../bridge.js';

export function terminalAuthorization(
  this: WecomBridge,
  input: {
    identity: { provider: string; connectionId: string; botId: string; userId: string };
    sessionId: string;
    triggerId: string;
    permission: 'read' | 'write';
  },
): WecomTerminalAuthorization {
  const actor = input.identity;
  const p = this.policy();
  const task = Object.values(this.state.tasks).filter(t => t.sessionId === input.sessionId).at(-1);
  const exact = actor.provider === 'wecom'
    && actor.connectionId === (this.options.connectionId ?? this.options.botId)
    && actor.botId === this.options.botId
    && !!task
    && task.triggerId === input.triggerId
    && !task.revoked
    && !task.stopRequested
    && this.state.routes[task.route] === input.sessionId
    && !this.state.sessionLocks?.[input.sessionId]
    && this.taskAllowed(task);
  const capability = task ? this.capability({ ...task.message, userId: actor.userId }, false) : 'denied';
  const allowed = exact
    && capability !== 'denied'
    && (input.permission === 'read'
      ? !p.hiddenStreamingCardButtons?.includes('terminal')
      : capability === 'operate'
        && p.writableTerminalLinkInCard === true
        && !p.hiddenStreamingCardButtons?.includes('writeLink'));
  return {
    allowed,
    epoch: createHash('sha256')
      .update(JSON.stringify([
        this.state.native!.epoch,
        nativePolicyRevision(p),
        task?.triggerId,
        task?.revoked,
        task?.stopRequested,
        p.writableTerminalLinkInCard,
        p.hiddenStreamingCardButtons,
      ]))
      .digest('hex'),
  };
}

export function capability(
  this: WecomBridge,
  message: Pick<WecomInboundMessage, 'userId' | 'chatType' | 'conversationId'>,
  quota = true,
) {
  try {
    return nativeCapability(this.state.native!, this.policy(), message, Date.now(), quota);
  } catch {
    return 'denied' as const;
  }
}

export function taskAllowed(this: WecomBridge, task: Task): boolean {
  try {
    return nativeTaskAllowed(this.state.native!, this.policy(), task.message, task.streamId, Date.now());
  } catch {
    return false;
  }
}

export function allowed(this: WecomBridge, userId: string): boolean {
  // A removed or unreadable policy fails closed even during an awaited poll.
  try {
    const policy = this.policy();
    return !policy.blockedUsers?.includes(userId)
      && (policy.allowedUsers.includes(userId)
        || Object.values(this.state.tasks).some(task => task.message.userId === userId
          && nativeTaskAllowed(this.state.native!, policy, task.message, task.streamId, Date.now())));
  } catch {
    return false;
  }
}

export function revoke(this: WecomBridge, task: Task): void {
  task.revoked = true;
  task.delivered = true;
  delete this.state.routes[task.route];
  this.save();
}
