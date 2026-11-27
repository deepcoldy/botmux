/**
 * Host session control (interrupt / close / archive / delete / restart / resume /
 * suspend) with durable control intents and session locks.
 *
 * Functions here are WecomBridge methods: they run with `this` bound to the bridge
 * (the class in ../bridge.ts forwards to them), so they share its state and lane.
 */
import type { WecomSessionOperation, WecomSessionActionResult, WecomControlResult, ControlIntent } from './types.js';
import type { WecomBridge } from '../bridge.js';

/** The answer for a recorded intent: the same for its first run and every replay of its request id. */
function controlResult(intent: ControlIntent): WecomControlResult {
  return intent.status === 'rejected'
    ? { ok: false, status: 'rejected', error: 'session_not_active' }
    : { ok: intent.status === 'completed', status: intent.status };
}

/**
 * Host control never impersonates an IM sender. Only durable bridge-owned sessions qualify.
 *
 * Outcomes of a restart / resume / suspend:
 *  - completed: the lock is lifted (or becomes `suspended`);
 *  - rejected:  the action reported `sessionGone` — the core definitely refused
 *               because the session is no longer active, so nothing happened.
 *               No lock is kept and the routes to the session are dropped, so
 *               the conversation's next message starts a new session (like a
 *               passthrough slash command meeting the same refusal);
 *  - uncertain: any other failure (`ok: false`, a throw, a failed authorize).
 *               The outcome is unknown, so the session stays locked: fail closed.
 */
export function controlSession(
  this: WecomBridge,
  input: {
    sessionId: string;
    operation: WecomSessionOperation;
    requestId: string;
    expectedGeneration?: string;
    authorize?: () => boolean;
  },
  action: (sessionId: string, operation: WecomSessionOperation) => Promise<WecomSessionActionResult>,
): Promise<WecomControlResult> {
  if (this.halted || this.poisoned) {
    return Promise.reject(new Error('gateway_unavailable'));
  }
  const controls = this.state.controls ??= {};
  const prior = controls[input.requestId];
  if (prior) {
    if (prior.sessionId !== input.sessionId || prior.operation !== input.operation) {
      return Promise.reject(new Error('request_conflict'));
    }
    return Promise.resolve(controlResult(prior));
  }
  const tasks = Object.values(this.state.tasks).filter(task => task.sessionId === input.sessionId
    || task.request.target.sessionId === input.sessionId);
  if (!tasks.length) {
    return Promise.reject(new Error('session_not_owned'));
  }
  const generation = tasks.filter(task => task.triggerId).at(-1)?.triggerId;
  if (input.expectedGeneration && input.expectedGeneration !== generation) {
    return Promise.reject(new Error('stale_generation'));
  }
  const detaches = ['close', 'archive', 'delete'].includes(input.operation);
  if (!detaches && input.operation !== 'interrupt' && tasks.some(task => !task.delivered)) {
    return Promise.reject(new Error('session_busy'));
  }
  if (!detaches && input.operation !== 'interrupt' && this.state.sessionLocks?.[input.sessionId] === 'uncertain') {
    return Promise.reject(new Error('session_control_uncertain'));
  }
  // Commit before waiting for the queue: a tick can currently be awaiting core/transport.
  // A crash after this intent is fail-closed; unsafe core actions are never replayed.
  const intent: ControlIntent = {
    sessionId: input.sessionId,
    operation: input.operation,
    status: 'pending',
    at: Date.now(),
  };
  controls[input.requestId] = intent;
  for (const task of tasks) {
    if (input.operation === 'interrupt' || detaches) {
      task.stopRequested = true;
    }
    if (detaches) {
      task.revoked = true;
      task.delivered = true;
    }
  }
  if (input.operation !== 'interrupt') {
    (this.state.sessionLocks ??= {})[input.sessionId] = 'pending';
  }
  if (detaches) {
    for (const [route, sid] of Object.entries(this.state.routes)) {
      if (sid === input.sessionId) {
        delete this.state.routes[route];
      }
    }
  }
  this.save();
  return this.enqueue(async () => {
    if (this.halted) {
      return { ok: false, status: 'pending' };
    }
    if (input.authorize && !input.authorize()) {
      intent.status = 'uncertain';
      this.save();
      return { ok: false, status: 'uncertain' };
    }
    try {
      let sessionGone = false;
      if (input.operation === 'interrupt') {
        const active = tasks.filter(task => task.triggerId && task.result === undefined);
        for (const task of active) {
          if (task.peer) {
            await this.peerCall(task, 'interrupt');
          } else {
            await this.options.core.interrupt(input.sessionId, task.triggerId!);
          }
        }
      } else {
        const result = await action(input.sessionId, input.operation);
        if (!result.ok) {
          // Only restart / resume / suspend take the definite refusal; a detach keeps its own handling.
          if (result.sessionGone !== true || detaches) {
            throw new Error('core_control_failed');
          }
          sessionGone = true;
        }
      }
      if (sessionGone) {
        intent.status = 'rejected';
        delete this.state.sessionLocks![input.sessionId];
        for (const [route, sid] of Object.entries(this.state.routes)) {
          if (sid === input.sessionId) {
            delete this.state.routes[route];
          }
        }
      } else {
        intent.status = 'completed';
        if (input.operation !== 'interrupt') {
          if (input.operation === 'suspend') {
            this.state.sessionLocks![input.sessionId] = 'suspended';
          } else {
            delete this.state.sessionLocks![input.sessionId];
          }
        }
      }
    } catch {
      intent.status = 'uncertain';
      if (input.operation !== 'interrupt') {
        this.state.sessionLocks![input.sessionId] = 'uncertain';
      }
    }
    this.save();
    return controlResult(intent);
  });
}
